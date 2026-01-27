/**
 * MESSAGES CACHE MODULE
 * =====================
 *
 * Memory-efficient caching for session messages with:
 * - Message list caching (IDs and numbers only - lightweight)
 * - Byte-offset index for on-demand message loading
 * - LRU cache for recently accessed messages with size limits
 * - File watching for cache invalidation
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

// Cache storage - only stores lightweight list data and byte offsets
// Structure: Map<cacheKey, { list: [], offsets: [], filePath: string, mtime: number, timestamp: number }>
const sessionListCaches = new Map();

// LRU cache for recently accessed full messages
// Structure: Map<cacheKey:number, { message: object, accessTime: number }>
const messageBodyCache = new Map();

// Cache limits
const MAX_CACHED_SESSIONS = 20; // Maximum number of session lists to cache
const MAX_CACHED_MESSAGES = 100; // Maximum number of full message bodies to cache
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
 * Evict oldest entries from message body cache if over limit
 */
function evictMessageCache() {
  if (messageBodyCache.size <= MAX_CACHED_MESSAGES) return;

  // Sort by access time and remove oldest
  const entries = Array.from(messageBodyCache.entries());
  entries.sort((a, b) => a[1].accessTime - b[1].accessTime);

  const toRemove = entries.slice(0, entries.length - MAX_CACHED_MESSAGES);
  for (const [key] of toRemove) {
    messageBodyCache.delete(key);
  }
}

/**
 * Evict oldest session list caches if over limit
 */
function evictSessionListCache() {
  if (sessionListCaches.size <= MAX_CACHED_SESSIONS) return;

  const entries = Array.from(sessionListCaches.entries());
  entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

  const toRemove = entries.slice(0, entries.length - MAX_CACHED_SESSIONS);
  for (const [key] of toRemove) {
    sessionListCaches.delete(key);
  }
}

/**
 * Build message list and byte-offset index from session file
 * Only reads metadata, not full message bodies
 */
async function buildMessageIndex(projectName, sessionId) {
  const filePath = getSessionFilePath(projectName, sessionId);

  try {
    await fsPromises.access(filePath);
  } catch {
    // File doesn't exist
    return { list: [], offsets: [], filePath: null };
  }

  const list = [];
  const offsets = [];
  const entries = [];

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let byteOffset = 0;
    let lineNumber = 0;

    for await (const line of rl) {
      const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for newline

      if (line.trim()) {
        try {
          const entry = JSON.parse(line);
          if (entry.sessionId === sessionId) {
            entries.push({
              entry,
              offset: byteOffset,
              lineNumber,
            });
          }
        } catch {
          // Skip malformed lines
        }
      }

      byteOffset += lineBytes;
      lineNumber++;
    }

    // Sort by timestamp
    entries.sort(
      (a, b) =>
        new Date(a.entry.timestamp || 0) - new Date(b.entry.timestamp || 0),
    );

    // Build list and offsets arrays (1-indexed)
    for (let i = 0; i < entries.length; i++) {
      const { entry, offset } = entries[i];
      list.push({
        number: i + 1,
        id: entry.uuid || entry.id || `msg_${i + 1}`,
        timestamp: entry.timestamp,
        type: entry.type,
      });
      offsets.push(offset);
    }

    return { list, offsets, filePath };
  } catch (error) {
    log.error(
      { sessionId, error: error.message },
      "Error building message index",
    );
    return { list: [], offsets: [], filePath: null };
  }
}

/**
 * Get or create list cache for a session (lightweight, no message bodies)
 */
async function getSessionListCache(
  projectName,
  sessionId,
  forceRefresh = false,
) {
  const cacheKey = getCacheKey(projectName, sessionId);
  const filePath = getSessionFilePath(projectName, sessionId);
  const currentMtime = await getFileMtime(filePath);

  let cache = sessionListCaches.get(cacheKey);

  // Check if cache needs refresh
  const needsRefresh =
    forceRefresh ||
    !cache ||
    (currentMtime && cache.mtime !== currentMtime) ||
    Date.now() - cache.timestamp > LIST_CACHE_TTL;

  if (needsRefresh) {
    const {
      list,
      offsets,
      filePath: indexedFilePath,
    } = await buildMessageIndex(projectName, sessionId);

    cache = {
      list,
      offsets,
      filePath: indexedFilePath,
      mtime: currentMtime,
      timestamp: Date.now(),
    };

    sessionListCaches.set(cacheKey, cache);
    evictSessionListCache();

    // Invalidate any cached message bodies for this session when list changes
    for (const key of messageBodyCache.keys()) {
      if (key.startsWith(cacheKey + ":")) {
        messageBodyCache.delete(key);
      }
    }
  }

  return cache;
}

/**
 * Read a specific line from a file by byte offset
 */
async function readLineAtOffset(filePath, offset) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, {
      start: offset,
      encoding: "utf8",
    });

    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    rl.once("line", (line) => {
      rl.close();
      stream.destroy();
      resolve(line);
    });

    rl.once("error", (err) => {
      stream.destroy();
      reject(err);
    });

    rl.once("close", () => {
      // If we got here without a line, the offset was invalid
    });

    stream.once("error", (err) => {
      rl.close();
      reject(err);
    });
  });
}

/**
 * Get message list (IDs and numbers only)
 * Also includes user prompts from history.jsonl that may not be in the session file
 * Returns: { messages: [{ number, id, timestamp, type }], total: number }
 */
async function getMessageList(projectName, sessionId) {
  const cache = await getSessionListCache(projectName, sessionId);

  // Get history prompts for this session (optional enhancement)
  let lastUserPrompt = null;
  try {
    const historyPrompts = await getSessionPrompts(sessionId);
    if (historyPrompts.length > 0) {
      const lastPrompt = historyPrompts[historyPrompts.length - 1];
      lastUserPrompt = {
        prompt: lastPrompt.prompt,
        timestamp: lastPrompt.timestamp,
      };
    }
  } catch (e) {
    log.debug({ error: e.message }, "Failed to get history prompts");
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
  const cacheKey = getCacheKey(projectName, sessionId);
  const bodyCacheKey = `${cacheKey}:${messageNumber}`;

  // Check body cache first
  const cached = messageBodyCache.get(bodyCacheKey);
  if (cached && Date.now() - cached.accessTime < MESSAGE_CACHE_TTL) {
    cached.accessTime = Date.now();
    return cached.message;
  }

  // Get list cache to find the byte offset
  const listCache = await getSessionListCache(projectName, sessionId);

  if (messageNumber < 1 || messageNumber > listCache.list.length) {
    return null;
  }

  if (!listCache.filePath) {
    return null;
  }

  const offset = listCache.offsets[messageNumber - 1];

  try {
    const line = await readLineAtOffset(listCache.filePath, offset);
    const message = JSON.parse(line);

    // Cache the message body
    messageBodyCache.set(bodyCacheKey, {
      message,
      accessTime: Date.now(),
    });
    evictMessageCache();

    return message;
  } catch (error) {
    log.error(
      { sessionId, messageNumber, error: error.message },
      "Error reading message",
    );
    return null;
  }
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
  const cacheKey = getCacheKey(projectName, sessionId);
  const listCache = await getSessionListCache(projectName, sessionId);

  if (!listCache.filePath) {
    return [];
  }

  const messages = [];
  const uncachedNumbers = [];

  // Check which messages are already cached
  for (let i = startNumber; i <= endNumber; i++) {
    if (i < 1 || i > listCache.list.length) continue;

    const bodyCacheKey = `${cacheKey}:${i}`;
    const cached = messageBodyCache.get(bodyCacheKey);

    if (cached && Date.now() - cached.accessTime < MESSAGE_CACHE_TTL) {
      cached.accessTime = Date.now();
      messages.push({ number: i, ...cached.message });
    } else {
      uncachedNumbers.push(i);
    }
  }

  // Load uncached messages
  for (const num of uncachedNumbers) {
    const offset = listCache.offsets[num - 1];
    try {
      const line = await readLineAtOffset(listCache.filePath, offset);
      const message = JSON.parse(line);

      // Cache the message body
      const bodyCacheKey = `${cacheKey}:${num}`;
      messageBodyCache.set(bodyCacheKey, {
        message,
        accessTime: Date.now(),
      });

      messages.push({ number: num, ...message });
    } catch (error) {
      log.debug(
        { sessionId, messageNumber: num, error: error.message },
        "Error reading message in range",
      );
    }
  }

  evictMessageCache();

  // Sort by number to maintain order
  messages.sort((a, b) => a.number - b.number);

  return messages;
}

/**
 * Check if a message number exists
 */
async function messageExists(projectName, sessionId, messageNumber) {
  const cache = await getSessionListCache(projectName, sessionId);
  return messageNumber >= 1 && messageNumber <= cache.list.length;
}

/**
 * Get the total message count for a session
 */
async function getMessageCount(projectName, sessionId) {
  const cache = await getSessionListCache(projectName, sessionId);
  return cache.list.length;
}

/**
 * Invalidate cache for a session
 */
function invalidateCache(projectName, sessionId) {
  const cacheKey = getCacheKey(projectName, sessionId);
  sessionListCaches.delete(cacheKey);

  // Also remove cached message bodies
  for (const key of messageBodyCache.keys()) {
    if (key.startsWith(cacheKey + ":")) {
      messageBodyCache.delete(key);
    }
  }
}

/**
 * Clear all caches
 */
function clearAllCaches() {
  sessionListCaches.clear();
  messageBodyCache.clear();
}

/**
 * Get cache statistics
 */
function getCacheStats() {
  let totalListItems = 0;
  const sessions = [];

  for (const [key, cache] of sessionListCaches.entries()) {
    totalListItems += cache.list.length;
    sessions.push({
      key,
      messageCount: cache.list.length,
      age: Date.now() - cache.timestamp,
    });
  }

  return {
    sessionCount: sessionListCaches.size,
    totalListItems,
    cachedMessageBodies: messageBodyCache.size,
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
