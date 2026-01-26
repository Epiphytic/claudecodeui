/**
 * MESSAGES CACHE MODULE
 * =====================
 *
 * Efficient caching for session messages with:
 * - Message list caching (IDs and numbers only)
 * - Individual message caching by number
 * - File watching for cache invalidation
 * - Memory-efficient storage
 * - Integration with history.jsonl for user prompts
 */

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";
import readline from "readline";
import { getSessionPrompts } from "./history-cache.js";
import { createLogger } from "./logger.js";

const log = createLogger("messages-cache");

// Cache storage
// Structure: Map<cacheKey, { list: [], messages: Map<number, message>, mtime: number, timestamp: number }>
const sessionCaches = new Map();

// Cache TTLs
const LIST_CACHE_TTL = 60000; // 60 seconds for list
const MESSAGE_CACHE_TTL = 1800000; // 30 minutes for individual messages

/**
 * Generate cache key for a session
 */
function getCacheKey(projectName, sessionId) {
  return `${projectName}:${sessionId}`;
}

/**
 * Get the jsonl file path for a session
 */
function getSessionFilePath(projectName, sessionId) {
  const projectDir = path.join(
    os.homedir(),
    ".claude",
    "projects",
    projectName,
  );
  return path.join(projectDir, `${sessionId}.jsonl`);
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
 * Load all messages from a session file
 */
async function loadSessionMessages(projectName, sessionId) {
  const projectDir = path.join(
    os.homedir(),
    ".claude",
    "projects",
    projectName,
  );

  try {
    const files = await fsPromises.readdir(projectDir);
    const jsonlFiles = files.filter(
      (file) => file.endsWith(".jsonl") && !file.startsWith("agent-"),
    );

    if (jsonlFiles.length === 0) {
      return [];
    }

    const messages = [];

    for (const file of jsonlFiles) {
      const jsonlFile = path.join(projectDir, file);
      const fileStream = fs.createReadStream(jsonlFile);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (line.trim()) {
          try {
            const entry = JSON.parse(line);
            if (entry.sessionId === sessionId) {
              messages.push(entry);
            }
          } catch {
            // Skip malformed lines
          }
        }
      }
    }

    // Sort by timestamp
    messages.sort(
      (a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0),
    );

    return messages;
  } catch (error) {
    log.error(
      { sessionId, error: error.message },
      "Error loading messages for session",
    );
    return [];
  }
}

/**
 * Get or create cache for a session
 */
async function getSessionCache(projectName, sessionId, forceRefresh = false) {
  const cacheKey = getCacheKey(projectName, sessionId);
  const filePath = getSessionFilePath(projectName, sessionId);
  const currentMtime = await getFileMtime(filePath);

  let cache = sessionCaches.get(cacheKey);

  // Check if cache needs refresh
  const needsRefresh =
    forceRefresh ||
    !cache ||
    (currentMtime && cache.mtime !== currentMtime) ||
    Date.now() - cache.timestamp > LIST_CACHE_TTL;

  if (needsRefresh) {
    const messages = await loadSessionMessages(projectName, sessionId);

    // Build list with numbers (1-indexed)
    const list = messages.map((msg, index) => ({
      number: index + 1,
      id: msg.uuid || msg.id || `msg_${index + 1}`,
      timestamp: msg.timestamp,
      type: msg.type,
    }));

    // Build message map by number
    const messageMap = new Map();
    messages.forEach((msg, index) => {
      messageMap.set(index + 1, msg);
    });

    cache = {
      list,
      messages: messageMap,
      mtime: currentMtime,
      timestamp: Date.now(),
    };

    sessionCaches.set(cacheKey, cache);
  }

  return cache;
}

/**
 * Get message list (IDs and numbers only)
 * Also includes user prompts from history.jsonl that may not be in the session file
 * Returns: { messages: [{ number, id, timestamp, type }], total: number }
 */
async function getMessageList(projectName, sessionId) {
  const cache = await getSessionCache(projectName, sessionId);

  // Get history prompts for this session
  let historyPrompts = [];
  try {
    historyPrompts = await getSessionPrompts(sessionId);
  } catch (e) {
    log.debug({ error: e.message }, "Failed to get history prompts");
  }

  // If we have history prompts and they provide additional context,
  // include the last prompt info in the response
  let lastUserPrompt = null;
  if (historyPrompts.length > 0) {
    const lastPrompt = historyPrompts[historyPrompts.length - 1];
    lastUserPrompt = {
      prompt: lastPrompt.prompt,
      timestamp: lastPrompt.timestamp,
    };
  }

  return {
    messages: cache.list,
    total: cache.list.length,
    cachedAt: cache.timestamp,
    lastUserPrompt,
  };
}

/**
 * Get a single message by number (1-indexed)
 * Returns the full message object or null if not found
 */
async function getMessageByNumber(projectName, sessionId, messageNumber) {
  const cache = await getSessionCache(projectName, sessionId);
  return cache.messages.get(messageNumber) || null;
}

/**
 * Get multiple messages by number range
 * Returns array of messages
 */
async function getMessagesByRange(
  projectName,
  sessionId,
  startNumber,
  endNumber,
) {
  const cache = await getSessionCache(projectName, sessionId);
  const messages = [];

  for (let i = startNumber; i <= endNumber; i++) {
    const msg = cache.messages.get(i);
    if (msg) {
      messages.push({ number: i, ...msg });
    }
  }

  return messages;
}

/**
 * Check if a message number exists
 */
async function messageExists(projectName, sessionId, messageNumber) {
  const cache = await getSessionCache(projectName, sessionId);
  return cache.messages.has(messageNumber);
}

/**
 * Get the total message count for a session
 */
async function getMessageCount(projectName, sessionId) {
  const cache = await getSessionCache(projectName, sessionId);
  return cache.list.length;
}

/**
 * Invalidate cache for a session
 */
function invalidateCache(projectName, sessionId) {
  const cacheKey = getCacheKey(projectName, sessionId);
  sessionCaches.delete(cacheKey);
}

/**
 * Clear all caches
 */
function clearAllCaches() {
  sessionCaches.clear();
}

/**
 * Get cache statistics
 */
function getCacheStats() {
  let totalMessages = 0;
  const sessions = [];

  for (const [key, cache] of sessionCaches.entries()) {
    totalMessages += cache.list.length;
    sessions.push({
      key,
      messageCount: cache.list.length,
      age: Date.now() - cache.timestamp,
    });
  }

  return {
    sessionCount: sessionCaches.size,
    totalMessages,
    sessions,
  };
}

export {
  getMessageList,
  getMessageByNumber,
  getMessagesByRange,
  messageExists,
  getMessageCount,
  invalidateCache,
  clearAllCaches,
  getCacheStats,
  LIST_CACHE_TTL,
  MESSAGE_CACHE_TTL,
};
