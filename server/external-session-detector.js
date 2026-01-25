/**
 * External Claude Session Detector
 *
 * Detects Claude CLI sessions running outside of this application.
 * This helps prevent conflicts when users have both the UI and CLI
 * running simultaneously on the same project.
 *
 * Detection methods:
 * 1. Process detection via cached process scan (updated every minute)
 * 2. tmux session scanning (from cache)
 * 3. Session lock file detection (.claude/session.lock)
 *
 * Performance:
 * - Uses cached process data from process-cache.js for instant responses
 * - Only lock file checks are done on-demand (fast filesystem operation)
 */

import fs from "fs";
import path from "path";
import { createLogger } from "./logger.js";
import { getCachedProcessData, getCacheAge } from "./process-cache.js";

const log = createLogger("external-session-detector");

/**
 * Check if a process exists
 * @param {number} pid - Process ID
 * @returns {boolean}
 */
function processExists(pid) {
  try {
    // Sending signal 0 checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check for session lock files in a project directory
 * @param {string} projectPath - The project directory to check
 * @returns {{ exists: boolean, lockFile: string | null, content: object | null }}
 */
function checkSessionLockFile(projectPath) {
  const lockFile = path.join(projectPath, ".claude", "session.lock");

  try {
    if (fs.existsSync(lockFile)) {
      const content = fs.readFileSync(lockFile, "utf8");
      try {
        const lockData = JSON.parse(content);

        // Check if the lock is stale (process no longer exists)
        if (lockData.pid) {
          const isAlive = processExists(lockData.pid);
          if (!isAlive) {
            // Stale lock file, clean it up
            log.debug({ lockFile, pid: lockData.pid }, "Removing stale lock");
            try {
              fs.unlinkSync(lockFile);
            } catch {
              // Ignore cleanup errors
            }
            return { exists: false, lockFile: null, content: null };
          }
        }

        return { exists: true, lockFile, content: lockData };
      } catch {
        // Invalid JSON, treat as text lock
        return { exists: true, lockFile, content: { raw: content } };
      }
    }
  } catch {
    // Cannot read lock file
  }

  return { exists: false, lockFile: null, content: null };
}

/**
 * Main detection function - detect all external Claude sessions
 * Uses cached process data for instant response.
 *
 * @param {string} projectPath - The project directory to check
 * @returns {{ hasExternalSession: boolean, processes: Array, tmuxSessions: Array, lockFile: object, detectionAvailable: boolean, detectionError: string | null, cacheAge: number | null }}
 */
function detectExternalClaude(projectPath) {
  log.debug({ projectPath }, "Detection requested");

  // Get cached process data (instant - no process scanning)
  const cachedData = getCachedProcessData();
  const cacheAge = getCacheAge();

  const result = {
    hasExternalSession: false,
    processes: [...cachedData.processes],
    tmuxSessions: [...cachedData.tmuxSessions],
    lockFile: { exists: false, lockFile: null, content: null },
    detectionAvailable: cachedData.detectionAvailable,
    detectionError: cachedData.detectionError,
    cacheAge,
  };

  // Filter processes to project if path provided
  if (projectPath && result.processes.length > 0) {
    const beforeFilter = result.processes.length;
    result.processes = result.processes.filter(
      (p) => !p.cwd || p.cwd.startsWith(projectPath),
    );
    log.debug(
      { projectPath, before: beforeFilter, after: result.processes.length },
      "Filtered processes for project",
    );
  }

  // Check lock file (fast filesystem operation)
  if (projectPath) {
    result.lockFile = checkSessionLockFile(projectPath);
  }

  // Determine if there's an external session
  result.hasExternalSession =
    result.processes.length > 0 ||
    result.tmuxSessions.length > 0 ||
    result.lockFile.exists;

  log.debug(
    {
      hasExternalSession: result.hasExternalSession,
      processCount: result.processes.length,
      tmuxCount: result.tmuxSessions.length,
      hasLockFile: result.lockFile.exists,
      cacheAge,
    },
    "Detection complete",
  );

  return result;
}

/**
 * Create a session lock file for this application
 * @param {string} projectPath - The project directory
 * @param {string} sessionId - The session ID
 * @returns {boolean}
 */
function createSessionLock(projectPath, sessionId) {
  const claudeDir = path.join(projectPath, ".claude");
  const lockFile = path.join(claudeDir, "session.lock");

  try {
    // Ensure .claude directory exists
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    const lockData = {
      pid: process.pid,
      sessionId,
      createdAt: new Date().toISOString(),
      app: "claudecodeui",
    };

    fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2));
    log.debug({ lockFile, sessionId }, "Created session lock");
    return true;
  } catch (err) {
    log.error({ error: err.message, lockFile }, "Failed to create lock file");
    return false;
  }
}

/**
 * Remove a session lock file
 * @param {string} projectPath - The project directory
 * @returns {boolean}
 */
function removeSessionLock(projectPath) {
  const lockFile = path.join(projectPath, ".claude", "session.lock");

  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      log.debug({ lockFile }, "Removed session lock");
    }
    return true;
  } catch {
    return false;
  }
}

export {
  detectExternalClaude,
  checkSessionLockFile,
  createSessionLock,
  removeSessionLock,
};
