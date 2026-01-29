/**
 * History Cache Module
 *
 * Parses and caches the ~/.claude/history.jsonl file which contains
 * user prompts across all sessions. This data can be used to:
 * - Supplement session titles with the last user prompt
 * - Provide user prompt history for a session
 *
 * Uses lazy loading with LRU eviction:
 * - Only caches sessions that have been accessed recently
 * - Uses streaming to find entries for a specific session
 * - Evicts least recently used sessions when cache is full
 */

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";
import readline from "readline";
import { createLogger } from "./logger.js";

const log = createLogger("history-cache");

// LRU cache configuration
const MAX_CACHED_SESSIONS = 20;

// Cache TTL - 60 seconds (reduces reload frequency during active use)
const HISTORY_CACHE_TTL = 60000;

// LRU cache for session data
// Map maintains insertion order, so we use it for LRU behavior
const sessionCache = new Map(); // sessionId -> { entries: [], timestamp: number }

// File modification time tracking (to invalidate cache when file changes)
let lastFileMtime = null;

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
 * Invalidate cache if file has changed
 */
async function checkFileChanged() {
  const filePath = getHistoryFilePath();
  const currentMtime = await getFileMtime(filePath);

  if (currentMtime !== lastFileMtime) {
    // File changed, clear all cached data
    sessionCache.clear();
    lastFileMtime = currentMtime;
    log.debug({ mtime: currentMtime }, "History file changed, cache cleared");
    return true;
  }
  return false;
}

/**
 * Move a session to the end of the LRU cache (most recently used)
 * @param {string} sessionId
 * @param {object} data
 */
function touchSession(sessionId, data) {
  // Delete and re-add to move to end (most recently used)
  sessionCache.delete(sessionId);
  sessionCache.set(sessionId, data);

  // Evict oldest entries if over limit
  while (sessionCache.size > MAX_CACHED_SESSIONS) {
    const oldestKey = sessionCache.keys().next().value;
    sessionCache.delete(oldestKey);
    log.debug({ sessionId: oldestKey }, "Evicted session from LRU cache");
  }
}

/**
 * Stream through history file and collect entries for a specific session
 * @param {string} sessionId - The session ID to find
 * @returns {Promise<Array>} Array of entries for the session
 */
async function streamEntriesForSession(sessionId) {
  const filePath = getHistoryFilePath();

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const entries = [];

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        const entry = parseHistoryEntry(line);
        if (entry && entry.sessionId === sessionId) {
          entries.push(entry);
        }
      }
    }

    // Sort by timestamp
    entries.sort((a, b) => a.timestamp - b.timestamp);

    log.debug(
      { sessionId, entryCount: entries.length },
      "Streamed session entries",
    );

    return entries;
  } catch (error) {
    log.error({ error: error.message, sessionId }, "Failed to stream session");
    return [];
  }
}

/**
 * Get all prompts for a specific session (with lazy loading and LRU caching)
 * @param {string} sessionId - The session ID
 * @returns {Promise<Array>} Array of prompt entries sorted by timestamp
 */
async function getSessionPrompts(sessionId) {
  // Check if file has changed (invalidates cache)
  await checkFileChanged();

  // Check if session is in cache and still valid
  const cached = sessionCache.get(sessionId);
  if (cached && Date.now() - cached.timestamp < HISTORY_CACHE_TTL) {
    // Move to end of LRU
    touchSession(sessionId, cached);
    log.debug({ sessionId }, "Using cached session prompts");
    return cached.entries;
  }

  // Not in cache or expired, stream from file
  const entries = await streamEntriesForSession(sessionId);

  // Cache the result
  touchSession(sessionId, {
    entries,
    timestamp: Date.now(),
  });

  return entries;
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
 * Streams through file without caching (less common operation)
 * @param {string} projectPath - The project path
 * @returns {Promise<Array>} Array of prompt entries sorted by timestamp
 */
async function getProjectPrompts(projectPath) {
  const filePath = getHistoryFilePath();

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const entries = [];

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        const entry = parseHistoryEntry(line);
        if (entry && entry.project === projectPath) {
          entries.push(entry);
        }
      }
    }

    // Sort by timestamp
    entries.sort((a, b) => a.timestamp - b.timestamp);

    return entries;
  } catch (error) {
    log.error(
      { error: error.message, projectPath },
      "Failed to get project prompts",
    );
    return [];
  }
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
 * Streams through file (not frequently used)
 * @returns {Promise<Array<string>>} Array of session IDs
 */
async function getAllSessionIds() {
  const filePath = getHistoryFilePath();

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const sessionIds = new Set();

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        const entry = parseHistoryEntry(line);
        if (entry) {
          sessionIds.add(entry.sessionId);
        }
      }
    }

    return Array.from(sessionIds);
  } catch (error) {
    log.error({ error: error.message }, "Failed to get all session IDs");
    return [];
  }
}

/**
 * Invalidate the history cache
 */
function invalidateCache() {
  sessionCache.clear();
  lastFileMtime = null;
  log.debug("History cache invalidated");
}

/**
 * Get cache statistics
 */
function getCacheStats() {
  return {
    cachedSessions: sessionCache.size,
    maxCachedSessions: MAX_CACHED_SESSIONS,
    lastFileMtime,
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
  MAX_CACHED_SESSIONS,
};
