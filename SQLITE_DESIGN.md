# SQLite-Based Caching Architecture

## Problem Statement

Current memory usage grows to 7-12GB because:

1. Every file change triggers full re-parsing of ALL JSONL files
2. Multiple in-memory caches store overlapping data
3. No incremental updates - entire files re-parsed on any change
4. Old chat logs cached unnecessarily (UI rarely needs them)

## Proposed Solution

Replace in-memory caches with SQLite database:

- Single source of truth for all session/project data
- Incremental updates via byte offset tracking
- SQLite handles caching automatically (page cache)
- Persistent across restarts (no cold-start parsing)
- Efficient queries without loading everything into memory

## Database Schema

```sql
-- Track file processing state for incremental updates
CREATE TABLE file_state (
  file_path TEXT PRIMARY KEY,
  last_byte_offset INTEGER DEFAULT 0,
  last_mtime REAL,
  last_processed_at INTEGER
);

-- Projects metadata
CREATE TABLE projects (
  name TEXT PRIMARY KEY,
  display_name TEXT,
  full_path TEXT,
  session_count INTEGER DEFAULT 0,
  last_activity INTEGER,
  has_claude_sessions INTEGER DEFAULT 0,
  has_cursor_sessions INTEGER DEFAULT 0,
  has_codex_sessions INTEGER DEFAULT 0,
  has_taskmaster INTEGER DEFAULT 0,
  updated_at INTEGER
);

-- Sessions metadata (lightweight)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  summary TEXT DEFAULT 'New Session',
  message_count INTEGER DEFAULT 0,
  last_activity INTEGER,
  cwd TEXT,
  provider TEXT DEFAULT 'claude',
  is_grouped INTEGER DEFAULT 0,
  group_id TEXT,
  updated_at INTEGER,
  FOREIGN KEY (project_name) REFERENCES projects(name)
);

-- Message index (byte offsets for on-demand loading)
CREATE TABLE message_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_number INTEGER NOT NULL,
  uuid TEXT,
  type TEXT,
  timestamp INTEGER,
  byte_offset INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  UNIQUE(session_id, message_number),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- UUID mapping for timeline detection
CREATE TABLE uuid_mapping (
  uuid TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_uuid TEXT,
  type TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- History prompts (from history.jsonl)
CREATE TABLE history_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  prompt TEXT,
  timestamp INTEGER,
  project_path TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Indexes for common queries
CREATE INDEX idx_sessions_project ON sessions(project_name);
CREATE INDEX idx_sessions_activity ON sessions(last_activity DESC);
CREATE INDEX idx_messages_session ON message_index(session_id);
CREATE INDEX idx_uuid_session ON uuid_mapping(session_id);
CREATE INDEX idx_history_session ON history_prompts(session_id);
```

## Incremental Update Strategy

### On File Change (via chokidar)

```javascript
async function processFileIncremental(filePath) {
  const db = getDatabase();

  // Get last processed state
  const state = db
    .prepare(
      "SELECT last_byte_offset, last_mtime FROM file_state WHERE file_path = ?",
    )
    .get(filePath);

  const stats = await fs.stat(filePath);

  // Skip if unchanged
  if (state && state.last_mtime === stats.mtimeMs) {
    return;
  }

  // Start reading from last offset (or 0 for new files)
  const startOffset = state?.last_byte_offset || 0;

  // Stream only NEW entries
  const stream = fs.createReadStream(filePath, { start: startOffset });
  // ... process new entries only ...

  // Update file state
  db.prepare("INSERT OR REPLACE INTO file_state VALUES (?, ?, ?, ?)").run(
    filePath,
    newOffset,
    stats.mtimeMs,
    Date.now(),
  );
}
```

### Message Retrieval

```javascript
async function getMessageByNumber(projectName, sessionId, messageNumber) {
  const db = getDatabase();

  // Get byte offset from SQLite
  const index = db
    .prepare(
      `
    SELECT byte_offset, file_path FROM message_index
    WHERE session_id = ? AND message_number = ?
  `,
    )
    .get(sessionId, messageNumber);

  if (!index) return null;

  // Read single line from file at offset
  return readLineAtOffset(index.file_path, index.byte_offset);
}
```

## API Endpoints with Cloudflare Caching

### Static Data (long cache)

```javascript
// Sessions list - ETag based, 5 min cache
app.get("/api/sessions/list", (req, res) => {
  res.setHeader(
    "Cache-Control",
    "public, max-age=300, stale-while-revalidate=60",
  );
  res.setHeader("ETag", `"sessions-${getSessionsVersion()}"`);
  // ...
});

// Individual message (immutable) - 1 hour cache
app.get("/api/.../messages/number/:num", (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600, immutable");
  // ...
});

// Message list - ETag based, 1 min cache
app.get("/api/.../messages/list", (req, res) => {
  res.setHeader(
    "Cache-Control",
    "public, max-age=60, stale-while-revalidate=30",
  );
  res.setHeader("ETag", `"list-${sessionId}-${messageCount}"`);
  // ...
});
```

### Dynamic Data (short cache or no cache)

```javascript
// Process detection - short cache
app.get("/api/external-sessions", (req, res) => {
  res.setHeader("Cache-Control", "private, max-age=30");
  // ...
});
```

## Migration Plan

### Phase 1: Add SQLite (parallel operation)

1. Add `better-sqlite3` dependency
2. Create database module with schema
3. Run SQLite updates alongside existing caches
4. Verify data consistency

### Phase 2: Switch to SQLite

1. Update API endpoints to read from SQLite
2. Remove duplicate in-memory caches
3. Add Cloudflare cache headers
4. Test performance

### Phase 3: Cleanup

1. Remove old cache modules
2. Remove `lastProjectsData` (unused)
3. Optimize queries based on usage patterns

## Expected Benefits

| Metric                | Before               | After                  |
| --------------------- | -------------------- | ---------------------- |
| Memory at rest        | 300MB                | ~100MB                 |
| Memory after requests | 7-12GB               | ~200MB                 |
| Cold start            | Parse all files      | Read from SQLite       |
| File change           | Re-parse entire file | Process only new bytes |
| Cloudflare caching    | Limited              | Full cache headers     |

## Files to Modify/Create

### New Files

- `server/database.js` - SQLite connection and schema
- `server/db-indexer.js` - Incremental file processing
- `server/db-queries.js` - Query helpers

### Modify

- `server/index.js` - Use SQLite, add cache headers
- `server/projects.js` - Remove full-file parsing
- Remove or gut: `sessions-cache.js`, `projects-cache.js`, `messages-cache.js`, `history-cache.js`

## Dependencies

```json
{
  "better-sqlite3": "^11.0.0"
}
```

`better-sqlite3` is chosen because:

- Synchronous API (simpler code)
- Best Node.js SQLite performance
- No native module issues on most platforms
