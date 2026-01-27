/**
 * History Cache Module
 *
 * Parses and caches the ~/.claude/history.jsonl file which contains
 * user prompts across all sessions. This data can be used to:
 * - Supplement session titles with the last user prompt
 * - Provide user prompt history for a session
 *
 * The file is small (typically < 1000 lines) so it's parsed on-demand
 * with a short TTL cache.
 */

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";
import readline from "readline";
import { createLogger } from "./logger.js";

const log = createLogger("history-cache");

// Cache storage
let historyCache = {
  entries: [], // All entries sorted by timestamp
  bySession: new Map(), // sessionId -> entries[]
  byProject: new Map(), // projectPath -> entries[]
  mtime: null,
  timestamp: null,
};

// Cache TTL - 60 seconds (reduces reload frequency during active use)
const HISTORY_CACHE_TTL = 60000;

/**
 * Get the history.jsonl file path
 */
function getHistoryFilePath() {
  return path.join(os.homedir(), ".claude", "history.jsonl");
}

/**
 * Get the file modification time
 */
async function getFileMtime(filePath) {
  try {
    const stats = await fsPromises.stat(filePath);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Parse a single history entry
 * @param {string} line - JSON line from history.jsonl
 * @returns {object|null} Parsed entry or null if invalid
 */
function parseHistoryEntry(line) {
  try {
    const entry = JSON.parse(line);

    // Validate required fields
    if (!entry.display || !entry.timestamp || !entry.sessionId) {
      return null;
    }

    return {
      prompt: entry.display,
      timestamp: entry.timestamp,
      sessionId: entry.sessionId,
      project: entry.project || null,
      pastedContents: entry.pastedContents || {},
    };
  } catch {
    return null;
  }
}

/**
 * Load and parse the history.jsonl file
 */
async function loadHistory() {
  const filePath = getHistoryFilePath();
  const currentMtime = await getFileMtime(filePath);

  // Check if cache is valid
  if (
    historyCache.timestamp &&
    historyCache.mtime === currentMtime &&
    Date.now() - historyCache.timestamp < HISTORY_CACHE_TTL
  ) {
    log.debug("Using cached history");
    return historyCache;
  }

  log.debug("Loading history from file");

  try {
    const entries = [];
    const bySession = new Map();
    const byProject = new Map();

    if (!fs.existsSync(filePath)) {
      log.debug("History file does not exist");
      historyCache = {
        entries: [],
        bySession: new Map(),
        byProject: new Map(),
        mtime: null,
        timestamp: Date.now(),
      };
      return historyCache;
    }

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        const entry = parseHistoryEntry(line);
        if (entry) {
          entries.push(entry);

          // Index by session
          if (!bySession.has(entry.sessionId)) {
            bySession.set(entry.sessionId, []);
          }
          bySession.get(entry.sessionId).push(entry);

          // Index by project
          if (entry.project) {
            if (!byProject.has(entry.project)) {
              byProject.set(entry.project, []);
            }
            byProject.get(entry.project).push(entry);
          }
        }
      }
    }

    // Sort all entries by timestamp
    entries.sort((a, b) => a.timestamp - b.timestamp);

    // Sort entries within each session by timestamp
    for (const [, sessionEntries] of bySession) {
      sessionEntries.sort((a, b) => a.timestamp - b.timestamp);
    }

    // Sort entries within each project by timestamp
    for (const [, projectEntries] of byProject) {
      projectEntries.sort((a, b) => a.timestamp - b.timestamp);
    }

    historyCache = {
      entries,
      bySession,
      byProject,
      mtime: currentMtime,
      timestamp: Date.now(),
    };

    log.debug(
      {
        totalEntries: entries.length,
        sessionCount: bySession.size,
        projectCount: byProject.size,
      },
      "History loaded",
    );

    return historyCache;
  } catch (error) {
    log.error({ error: error.message }, "Failed to load history");
    return historyCache;
  }
}

/**
 * Get all prompts for a specific session
 * @param {string} sessionId - The session ID
 * @returns {Promise<Array>} Array of prompt entries sorted by timestamp
 */
async function getSessionPrompts(sessionId) {
  const cache = await loadHistory();
  return cache.bySession.get(sessionId) || [];
}

/**
 * Get the last prompt for a specific session
 * @param {string} sessionId - The session ID
 * @returns {Promise<object|null>} The last prompt entry or null
 */
async function getLastSessionPrompt(sessionId) {
  const prompts = await getSessionPrompts(sessionId);
  if (prompts.length === 0) return null;
  return prompts[prompts.length - 1];
}

/**
 * Get all prompts for a specific project path
 * @param {string} projectPath - The project path
 * @returns {Promise<Array>} Array of prompt entries sorted by timestamp
 */
async function getProjectPrompts(projectPath) {
  const cache = await loadHistory();
  return cache.byProject.get(projectPath) || [];
}

/**
 * Get session title from history (last user prompt, truncated)
 * @param {string} sessionId - The session ID
 * @param {number} maxLength - Maximum title length (default 100)
 * @returns {Promise<string|null>} The title or null if no prompts found
 */
async function getSessionTitleFromHistory(sessionId, maxLength = 100) {
  const lastPrompt = await getLastSessionPrompt(sessionId);
  if (!lastPrompt) return null;

  let title = lastPrompt.prompt.trim();

  // Remove common prefixes that aren't useful as titles
  if (title.startsWith("/")) {
    // Skip slash commands like /compact, /model, etc.
    // Unless it's followed by actual content
    const spaceIndex = title.indexOf(" ");
    if (spaceIndex > 0 && spaceIndex < 20) {
      const afterCommand = title.slice(spaceIndex + 1).trim();
      if (afterCommand.length > 10) {
        title = afterCommand;
      } else {
        return null; // Pure slash command, not useful as title
      }
    } else {
      return null; // Pure slash command
    }
  }

  // Truncate if needed
  if (title.length > maxLength) {
    title = title.slice(0, maxLength - 3) + "...";
  }

  // Clean up newlines and extra whitespace
  title = title.replace(/\s+/g, " ").trim();

  return title || null;
}

/**
 * Get all session IDs that have history entries
 * @returns {Promise<Array<string>>} Array of session IDs
 */
async function getAllSessionIds() {
  const cache = await loadHistory();
  return Array.from(cache.bySession.keys());
}

/**
 * Invalidate the history cache
 */
function invalidateCache() {
  historyCache = {
    entries: [],
    bySession: new Map(),
    byProject: new Map(),
    mtime: null,
    timestamp: null,
  };
  log.debug("History cache invalidated");
}

/**
 * Get cache statistics
 */
function getCacheStats() {
  return {
    totalEntries: historyCache.entries.length,
    sessionCount: historyCache.bySession.size,
    projectCount: historyCache.byProject.size,
    cacheAge: historyCache.timestamp
      ? Date.now() - historyCache.timestamp
      : null,
    mtime: historyCache.mtime,
  };
}

export {
  getSessionPrompts,
  getLastSessionPrompt,
  getProjectPrompts,
  getSessionTitleFromHistory,
  getAllSessionIds,
  invalidateCache,
  getCacheStats,
  HISTORY_CACHE_TTL,
};
