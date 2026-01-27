# Resource Optimization Plan

## Overview

This plan addresses high CPU and memory usage when the application is at rest (no active requests).

**Critical Finding:** Memory grows from 300MB to 8GB because `getProjects()` loads ALL 659MB of session files into memory as JavaScript objects.

## Priority Order

0. **getProjects/parseJsonlSessions Memory Leak (CRITICAL - Memory)**
1. Chokidar File Watcher (HIGH - CPU)
2. Message Body Cache Size (HIGH - Memory)
3. Process Cache Updater (MEDIUM - CPU)
4. History Cache (MEDIUM - Memory)
5. Background Intervals (LOW-MEDIUM - CPU)

---

## 0. CRITICAL: getProjects Memory Leak

**Files:** `server/projects.js` (lines 620-680, 737-880)

**Root Cause Analysis:**

- Total session files: **659 files** totaling **659MB**
- Largest single file: **148MB** (30,504 messages)
- `getProjectSessions()` loads ALL entries from ALL files into `allEntries` array
- `parseJsonlSessions()` stores full message content when only metadata is needed
- JavaScript object overhead: 659MB JSONL → **2-4GB+ in memory**

**Current Code (problematic):**

```javascript
// In getProjectSessions (line 621, 635)
const allEntries = [];
for (const { file } of filesWithStats) {
  const result = await parseJsonlSessions(jsonlFile);
  allEntries.push(...result.entries); // Stores ALL entries from ALL files
}

// In parseJsonlSessions (line 753)
entries.push(entry); // Stores FULL entry including message content
```

**Fix - Only extract what's needed:**

```javascript
// parseJsonlSessions should only extract metadata, not full content
async function parseJsonlSessions(filePath) {
  const sessions = new Map();
  const uuidIndex = []; // Only store what's needed for timeline detection

  for await (const line of rl) {
    const entry = JSON.parse(line);

    // Only store lightweight index data for timeline detection
    if (entry.uuid && entry.sessionId) {
      uuidIndex.push({
        uuid: entry.uuid,
        sessionId: entry.sessionId,
        type: entry.type,
        parentUuid: entry.parentUuid || null,
      });
    }

    // Update session metadata (already done correctly)
    if (entry.sessionId) {
      // ... existing session tracking code ...
    }
  }

  return { sessions: Array.from(sessions.values()), uuidIndex };
}
```

**Alternative Fix - Stream processing without storage:**

```javascript
async function getProjectSessions(projectDir, options = {}) {
  const allSessions = new Map();
  const uuidToSessionMap = new Map();
  const sessionToFirstUserMsgId = new Map();
  const sessionGroups = new Map();

  // Process each file in streaming fashion
  for (const { file } of filesWithStats) {
    const jsonlFile = path.join(projectDir, file);

    // Stream process - don't store entries
    await streamProcessSessionFile(jsonlFile, {
      onSession: (session) => {
        if (!allSessions.has(session.id)) {
          allSessions.set(session.id, session);
        }
      },
      onEntry: (entry) => {
        // Build indexes incrementally without storing full entries
        if (entry.uuid && entry.sessionId) {
          uuidToSessionMap.set(entry.uuid, entry.sessionId);
        }
        if (entry.type === "user" && entry.parentUuid === null && entry.uuid) {
          // Timeline detection logic
        }
      },
    });
  }
}
```

**Expected Impact:**

- Reduce memory from **8GB → 500MB** (95% reduction)
- Faster startup (less GC pressure)

**Implementation Steps:**

1. [ ] Modify `parseJsonlSessions` to not store full entries
2. [ ] Change return value to only include `{ sessions, uuidIndex }`
3. [ ] Update `getProjectSessions` to use lightweight uuidIndex
4. [ ] Remove `allEntries` array entirely
5. [ ] Test with 148MB session file to verify memory stays low

---

## 1. Chokidar File Watcher Optimization

**File:** `server/index.js` (lines 191-209)

**Current Issues:**

- `depth: 10` scans deeply nested directories unnecessarily
- `pollInterval: 50` polls every 50ms for file stability (20 times/second)
- `stabilityThreshold: 100` is too aggressive

**Changes:**

```javascript
// Before
projectsWatcher = chokidar.watch(claudeProjectsPath, {
  ignored: [...],
  persistent: true,
  ignoreInitial: true,
  followSymlinks: false,
  depth: 10,
  awaitWriteFinish: {
    stabilityThreshold: 100,
    pollInterval: 50,
  },
});

// After
projectsWatcher = chokidar.watch(claudeProjectsPath, {
  ignored: [...],
  persistent: true,
  ignoreInitial: true,
  followSymlinks: false,
  depth: 2,                    // Only need project/session level
  usePolling: false,           // Use native fs events
  awaitWriteFinish: {
    stabilityThreshold: 500,   // Wait 500ms for file stability
    pollInterval: 200,         // Poll 5 times/second instead of 20
  },
});
```

**Expected Impact:** ~75% reduction in watcher CPU usage

---

## 2. Message Body Cache Size Reduction

**File:** `server/messages-cache.js` (line 33)

**Current Issues:**

- Caches up to 500 full message bodies
- Each message can be 10-100KB (tool calls, code blocks)
- Potential memory usage: 50-500MB just for message cache

**Changes:**

```javascript
// Before
const MAX_CACHED_MESSAGES = 500;

// After
const MAX_CACHED_MESSAGES = 100; // 80% reduction
```

**Additional Enhancement - Add byte-size limit:**

```javascript
const MAX_CACHE_BYTES = 50 * 1024 * 1024; // 50MB max
let currentCacheBytes = 0;

function evictMessageCache() {
  // Evict by count
  if (
    messageBodyCache.size <= MAX_CACHED_MESSAGES &&
    currentCacheBytes <= MAX_CACHE_BYTES
  )
    return;

  const entries = Array.from(messageBodyCache.entries());
  entries.sort((a, b) => a[1].accessTime - b[1].accessTime);

  // Evict until under both limits
  while (
    (messageBodyCache.size > MAX_CACHED_MESSAGES ||
      currentCacheBytes > MAX_CACHE_BYTES) &&
    entries.length > 0
  ) {
    const [key, value] = entries.shift();
    currentCacheBytes -= value.byteSize || 0;
    messageBodyCache.delete(key);
  }
}
```

**Expected Impact:** 50-80% reduction in message cache memory

---

## 3. Process Cache Updater Interval Increase

**File:** `server/process-cache.js`

**Current Issues:**

- Runs every 60 seconds even when idle
- Spawns child processes (`ps`, `lsof`) which is CPU intensive
- Most of the time, no external Claude sessions are active

**Changes:**

```javascript
// Before
const CACHE_UPDATE_INTERVAL = 60 * 1000; // 1 minute

// After - Adaptive interval based on activity
const IDLE_CACHE_UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes when idle
const ACTIVE_CACHE_UPDATE_INTERVAL = 60 * 1000; // 1 minute when active

let isActive = false;
let updateInterval = null;

function setActiveMode(active) {
  if (isActive === active) return;
  isActive = active;

  if (updateInterval) {
    clearInterval(updateInterval);
  }

  const interval = active
    ? ACTIVE_CACHE_UPDATE_INTERVAL
    : IDLE_CACHE_UPDATE_INTERVAL;
  updateInterval = setInterval(updateCache, interval);
}

// Export function to be called when WebSocket clients connect/disconnect
export function setProcessCacheActive(active) {
  setActiveMode(active);
}
```

**Integration in index.js:**

```javascript
// When WebSocket client connects
connectedClients.add(ws);
setProcessCacheActive(connectedClients.size > 0);

// When WebSocket client disconnects
connectedClients.delete(ws);
setProcessCacheActive(connectedClients.size > 0);
```

**Expected Impact:** 80% reduction in process scanning when idle

---

## 4. History Cache Lazy Loading

**File:** `server/history-cache.js`

**Current Issues:**

- Loads and indexes ALL entries from history.jsonl into memory
- Creates `bySession` and `byProject` Maps with all entries
- With 870+ entries, this consumes significant memory

**Changes - Lazy loading approach:**

```javascript
// Before: Load everything into memory
let historyCache = {
  entries: [],
  bySession: new Map(),
  byProject: new Map(),
  mtime: null,
  timestamp: null,
};

// After: Only cache what's been accessed recently
const sessionPromptsCache = new Map(); // sessionId -> { prompts, timestamp }
const SESSION_CACHE_TTL = 60000;
const MAX_CACHED_SESSIONS = 20;

async function getSessionPrompts(sessionId) {
  // Check cache first
  const cached = sessionPromptsCache.get(sessionId);
  if (cached && Date.now() - cached.timestamp < SESSION_CACHE_TTL) {
    return cached.prompts;
  }

  // Stream file and extract only matching entries
  const prompts = await streamHistoryForSession(sessionId);

  // Cache with LRU eviction
  sessionPromptsCache.set(sessionId, { prompts, timestamp: Date.now() });
  if (sessionPromptsCache.size > MAX_CACHED_SESSIONS) {
    const oldest = sessionPromptsCache.keys().next().value;
    sessionPromptsCache.delete(oldest);
  }

  return prompts;
}

async function streamHistoryForSession(sessionId) {
  const filePath = getHistoryFilePath();
  const prompts = [];

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.includes(sessionId)) {
      // Quick string check before parsing
      const entry = parseHistoryEntry(line);
      if (entry && entry.sessionId === sessionId) {
        prompts.push(entry);
      }
    }
  }

  return prompts.sort((a, b) => a.timestamp - b.timestamp);
}
```

**Expected Impact:** 70-90% reduction in history cache memory (only active sessions cached)

---

## 5. Consolidate Background Intervals

**Files:**

- `server/process-cache.js` (60s interval)
- `server/session-lock.js` (5 min interval)
- `server/openai-codex.js` (cleanup interval)

**Current Issues:**

- Multiple independent intervals running
- Each keeps the event loop active
- No coordination or pause when idle

**Changes - Create centralized maintenance scheduler:**

**New file:** `server/maintenance-scheduler.js`

```javascript
/**
 * Centralized maintenance scheduler
 * Runs periodic tasks only when clients are connected
 */

const tasks = new Map();
let maintenanceInterval = null;
let isActive = false;

const MAINTENANCE_INTERVAL = 60 * 1000; // Check every minute

function registerTask(name, fn, intervalMs) {
  tasks.set(name, {
    fn,
    intervalMs,
    lastRun: 0,
  });
}

function runMaintenance() {
  const now = Date.now();

  for (const [name, task] of tasks) {
    if (now - task.lastRun >= task.intervalMs) {
      try {
        task.fn();
        task.lastRun = now;
      } catch (err) {
        console.error(`[Maintenance] Error in ${name}:`, err.message);
      }
    }
  }
}

function setActive(active) {
  if (isActive === active) return;
  isActive = active;

  if (active && !maintenanceInterval) {
    maintenanceInterval = setInterval(runMaintenance, MAINTENANCE_INTERVAL);
    runMaintenance(); // Run immediately
  } else if (!active && maintenanceInterval) {
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
  }
}

export { registerTask, setActive };
```

**Integration:**

```javascript
// In index.js startup
import {
  registerTask,
  setActive as setMaintenanceActive,
} from "./maintenance-scheduler.js";

// Register tasks
registerTask("process-cache", updateProcessCache, 5 * 60 * 1000);
registerTask(
  "session-lock-cleanup",
  () => sessionLock.cleanupStaleLocks(),
  5 * 60 * 1000,
);
registerTask("codex-session-cleanup", cleanupCodexSessions, 5 * 60 * 1000);

// When clients connect/disconnect
connectedClients.add(ws);
setMaintenanceActive(connectedClients.size > 0);
```

**Expected Impact:** Zero CPU from maintenance tasks when no clients connected

---

## Implementation Order

### Phase 1: Quick Wins (Low Risk)

1. [ ] Reduce message cache size (5 min)
2. [ ] Adjust chokidar settings (5 min)
3. [ ] Increase process cache interval (5 min)

### Phase 2: Medium Effort (Medium Risk)

4. [ ] Implement adaptive process cache intervals (30 min)
5. [ ] Refactor history cache to lazy loading (1 hour)

### Phase 3: Larger Refactor (Higher Risk)

6. [ ] Create centralized maintenance scheduler (1 hour)
7. [ ] Migrate existing intervals to scheduler (30 min)
8. [ ] Add idle detection and pause logic (30 min)

---

## Testing Checklist

- [ ] Monitor memory usage before/after with `process.memoryUsage()`
- [ ] Monitor CPU usage with Activity Monitor or `top`
- [ ] Verify file watcher still detects changes correctly
- [ ] Verify process cache still detects external Claude sessions
- [ ] Verify history cache still returns correct session prompts
- [ ] Test with 0 clients connected (should be minimal CPU)
- [ ] Test with 1+ clients connected (should work normally)

---

## Metrics to Track

```javascript
// Add to server for monitoring
app.get("/api/debug/resources", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    memory: {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + "MB",
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + "MB",
      rss: Math.round(mem.rss / 1024 / 1024) + "MB",
    },
    caches: {
      messageBodyCache: messageBodyCache.size,
      sessionListCaches: sessionListCaches.size,
      historyCache: sessionPromptsCache?.size || "N/A",
    },
    intervals: {
      maintenanceActive: isActive,
      connectedClients: connectedClients.size,
    },
  });
});
```

---

## Rollback Plan

Each change is independent and can be reverted individually:

1. Chokidar settings - revert constants
2. Message cache size - revert constant
3. Process cache interval - revert constant
4. History cache - revert to previous implementation
5. Maintenance scheduler - remove and restore individual intervals
