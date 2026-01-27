/**
 * Process Cache Module
 *
 * Keeps Claude process information in memory with periodic updates.
 * This avoids expensive process scans on every API request.
 *
 * Features:
 * - Background refresh every 60 seconds
 * - Immediate availability of cached data
 * - Detection of Claude CLI processes
 * - Detection of Claude tmux sessions
 */

import { spawnSync } from "child_process";
import os from "os";
import { createLogger } from "./logger.js";

const log = createLogger("process-cache");

// Adaptive cache update intervals
const IDLE_CACHE_UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes when idle
const ACTIVE_CACHE_UPDATE_INTERVAL = 60 * 1000; // 1 minute when active

// Legacy export for compatibility
const CACHE_UPDATE_INTERVAL = IDLE_CACHE_UPDATE_INTERVAL;

// Active mode flag (active when WebSocket clients are connected)
let isActiveMode = false;

// Cached data structure
const processCache = {
  processes: [],
  tmuxSessions: [],
  detectionAvailable: true,
  detectionError: null,
  lastUpdated: null,
  isUpdating: false,
};

// Current process ID for exclusion
const currentPid = process.pid;

// Update interval reference
let updateInterval = null;

/**
 * Check if a command is an external Claude process (not spawned by us)
 * @param {string} command - The process command line
 * @returns {boolean}
 */
function isExternalClaudeProcess(command) {
  // Skip node processes (SDK internals)
  if (command.startsWith("node ")) {
    log.debug({ command: command.slice(0, 60) }, "Rejected: starts with node");
    return false;
  }

  // Skip our own server
  if (command.includes("claudecodeui/server")) {
    log.debug(
      { command: command.slice(0, 60) },
      "Rejected: contains claudecodeui/server",
    );
    return false;
  }

  // Look for actual claude CLI invocations
  const isExternal =
    command.includes("claude ") ||
    command.includes("claude-code") ||
    command.match(/\/claude\s/) ||
    command.endsWith("/claude");

  log.debug({ command: command.slice(0, 60), isExternal }, "Process check");
  return isExternal;
}

/**
 * Detect Claude processes on the system
 * @returns {{ processes: Array, detectionAvailable: boolean, error: string | null }}
 */
function scanClaudeProcesses() {
  const processes = [];
  let detectionAvailable = true;
  let error = null;

  log.debug({ platform: os.platform(), currentPid }, "Scanning for processes");

  if (os.platform() === "win32") {
    // Windows: use wmic or tasklist
    try {
      const result = spawnSync(
        "wmic",
        [
          "process",
          "where",
          "name like '%claude%'",
          "get",
          "processid,commandline",
        ],
        { encoding: "utf8", stdio: "pipe" },
      );

      if (result.status === 0) {
        const lines = result.stdout.trim().split("\n").slice(1);
        for (const line of lines) {
          const match = line.match(/(\d+)\s*$/);
          if (match) {
            const pid = parseInt(match[1], 10);
            if (pid !== currentPid) {
              processes.push({ pid, command: line.trim(), cwd: null });
            }
          }
        }
      } else if (result.error) {
        detectionAvailable = false;
        error = `wmic not available: ${result.error.message}`;
      }
    } catch (e) {
      detectionAvailable = false;
      error = `Windows process detection failed: ${e.message}`;
    }
  } else {
    // Unix: use pgrep and ps
    try {
      const pgrepCheck = spawnSync("which", ["pgrep"], {
        encoding: "utf8",
        stdio: "pipe",
      });

      if (pgrepCheck.status !== 0) {
        // pgrep not available, try ps aux as fallback
        log.debug("Using ps aux fallback");
        try {
          const psResult = spawnSync("ps", ["aux"], {
            encoding: "utf8",
            stdio: "pipe",
          });

          if (psResult.status === 0) {
            const lines = psResult.stdout.split("\n");
            const claudeLines = lines.filter(
              (line) =>
                line.toLowerCase().includes("claude") &&
                !line.includes(String(currentPid)),
            );
            log.debug({ count: claudeLines.length }, "Found claude lines");

            for (const line of claudeLines) {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 2) {
                const pid = parseInt(parts[1], 10);
                if (!isNaN(pid) && pid !== currentPid) {
                  const command = parts.slice(10).join(" ");
                  if (isExternalClaudeProcess(command)) {
                    processes.push({ pid, command, cwd: null });
                  }
                }
              }
            }
          } else {
            detectionAvailable = false;
            error = "Neither pgrep nor ps aux available";
          }
        } catch (e) {
          detectionAvailable = false;
          error = `Process detection failed: ${e.message}`;
        }
      } else {
        // pgrep is available
        const pgrepResult = spawnSync("pgrep", ["-f", "claude"], {
          encoding: "utf8",
          stdio: "pipe",
        });

        if (pgrepResult.status === 0) {
          const pids = pgrepResult.stdout.trim().split("\n").filter(Boolean);
          log.debug({ pids }, "pgrep found PIDs");

          for (const pidStr of pids) {
            const pid = parseInt(pidStr, 10);

            if (pid === currentPid) {
              log.debug({ pid }, "Skipping own PID");
              continue;
            }

            // Get command details
            const psResult = spawnSync(
              "ps",
              ["-p", String(pid), "-o", "args="],
              {
                encoding: "utf8",
                stdio: "pipe",
              },
            );

            if (psResult.status === 0) {
              const command = psResult.stdout.trim();

              if (isExternalClaudeProcess(command)) {
                // Try to get working directory via lsof
                let cwd = null;
                try {
                  const lsofResult = spawnSync(
                    "lsof",
                    ["-p", String(pid), "-Fn"],
                    {
                      encoding: "utf8",
                      stdio: "pipe",
                    },
                  );
                  if (lsofResult.status === 0) {
                    const cwdMatch = lsofResult.stdout.match(/n(\/[^\n]+)/);
                    if (cwdMatch) {
                      cwd = cwdMatch[1];
                    }
                  }
                } catch {
                  // lsof may not be available
                }

                processes.push({ pid, command, cwd });
              }
            }
          }
        } else {
          log.debug({ status: pgrepResult.status }, "pgrep found no processes");
        }
      }
    } catch (e) {
      detectionAvailable = false;
      error = `Unix process detection failed: ${e.message}`;
    }
  }

  return { processes, detectionAvailable, error };
}

/**
 * Heuristic check if a tmux session might be running Claude
 * @param {string} sessionName - The session name
 * @returns {boolean}
 */
function mightBeClaudeSession(sessionName) {
  const claudePatterns = ["claude", "ai", "chat", "code"];
  const lowerName = sessionName.toLowerCase();

  for (const pattern of claudePatterns) {
    if (lowerName.includes(pattern)) return true;
  }

  // Try to peek at the session's current command
  try {
    const result = spawnSync(
      "tmux",
      ["display-message", "-t", sessionName, "-p", "#{pane_current_command}"],
      { encoding: "utf8", stdio: "pipe" },
    );

    if (result.status === 0) {
      const currentCommand = result.stdout.trim().toLowerCase();
      if (currentCommand.includes("claude")) return true;
    }
  } catch {
    // Ignore
  }

  return false;
}

/**
 * Detect tmux sessions that might be running Claude
 * @returns {Array<{ sessionName: string, windows: number, attached: boolean }>}
 */
function scanClaudeTmuxSessions() {
  const sessions = [];

  try {
    const result = spawnSync(
      "tmux",
      [
        "list-sessions",
        "-F",
        "#{session_name}:#{session_windows}:#{session_attached}",
      ],
      { encoding: "utf8", stdio: "pipe" },
    );

    if (result.status === 0) {
      const lines = result.stdout.trim().split("\n").filter(Boolean);

      for (const line of lines) {
        const [sessionName, windows, attached] = line.split(":");

        // Skip our own sessions
        if (sessionName.startsWith("claudeui-")) continue;

        if (mightBeClaudeSession(sessionName)) {
          sessions.push({
            sessionName,
            windows: parseInt(windows, 10),
            attached: attached === "1",
          });
        }
      }
    }
  } catch {
    // tmux not available or no server running
  }

  return sessions;
}

/**
 * Update the process cache with fresh data
 */
async function updateCache() {
  if (processCache.isUpdating) {
    log.debug("Cache update already in progress, skipping");
    return;
  }

  processCache.isUpdating = true;
  const startTime = Date.now();

  try {
    log.debug("Starting cache update");

    // Scan for processes
    const processResult = scanClaudeProcesses();
    processCache.processes = processResult.processes;
    processCache.detectionAvailable = processResult.detectionAvailable;
    processCache.detectionError = processResult.error;

    // Scan for tmux sessions
    processCache.tmuxSessions = scanClaudeTmuxSessions();

    processCache.lastUpdated = Date.now();

    const duration = Date.now() - startTime;
    log.info(
      {
        processCount: processCache.processes.length,
        tmuxCount: processCache.tmuxSessions.length,
        durationMs: duration,
      },
      "Process cache updated",
    );
  } catch (e) {
    log.error({ error: e.message }, "Failed to update process cache");
    processCache.detectionError = e.message;
  } finally {
    processCache.isUpdating = false;
  }
}

/**
 * Get the current update interval based on active mode
 */
function getCurrentInterval() {
  return isActiveMode
    ? ACTIVE_CACHE_UPDATE_INTERVAL
    : IDLE_CACHE_UPDATE_INTERVAL;
}

/**
 * Start the background cache update loop
 */
function startCacheUpdater() {
  // Perform initial update immediately
  updateCache();

  // Schedule periodic updates (start in idle mode)
  updateInterval = setInterval(updateCache, getCurrentInterval());

  log.info(
    { intervalMs: getCurrentInterval(), isActiveMode },
    "Process cache updater started",
  );
}

/**
 * Set the process cache active mode
 * When active (WebSocket clients connected), updates more frequently
 * @param {boolean} active - Whether the cache should be in active mode
 */
function setProcessCacheActive(active) {
  if (isActiveMode === active) return;

  isActiveMode = active;

  // Restart the interval with the new timing
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = setInterval(updateCache, getCurrentInterval());

    log.info(
      { isActiveMode, intervalMs: getCurrentInterval() },
      "Process cache interval updated",
    );

    // If becoming active, do an immediate update
    if (active) {
      updateCache();
    }
  }
}

/**
 * Stop the background cache update loop
 */
function stopCacheUpdater() {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
    log.info("Process cache updater stopped");
  }
}

/**
 * Get cached process data
 * @returns {{ processes: Array, tmuxSessions: Array, detectionAvailable: boolean, detectionError: string | null, lastUpdated: number | null }}
 */
function getCachedProcessData() {
  return {
    processes: processCache.processes,
    tmuxSessions: processCache.tmuxSessions,
    detectionAvailable: processCache.detectionAvailable,
    detectionError: processCache.detectionError,
    lastUpdated: processCache.lastUpdated,
  };
}

/**
 * Force an immediate cache update
 */
async function forceUpdate() {
  await updateCache();
}

/**
 * Get cache age in milliseconds
 * @returns {number | null}
 */
function getCacheAge() {
  if (!processCache.lastUpdated) return null;
  return Date.now() - processCache.lastUpdated;
}

export {
  startCacheUpdater,
  stopCacheUpdater,
  getCachedProcessData,
  forceUpdate,
  getCacheAge,
  setProcessCacheActive,
  CACHE_UPDATE_INTERVAL,
  IDLE_CACHE_UPDATE_INTERVAL,
  ACTIVE_CACHE_UPDATE_INTERVAL,
};
