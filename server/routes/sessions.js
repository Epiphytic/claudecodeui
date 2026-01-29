/**
 * SESSIONS API ROUTES
 * ===================
 *
 * GET /api/sessions/list
 * Returns a flat list of all sessions with optional timeframe filtering.
 * Supports ETag/304 caching for efficient polling.
 *
 * Now reads directly from SQLite for better performance and memory efficiency.
 */

import express from "express";
import crypto from "crypto";
import { getSessions, getSessionCount } from "../database.js";

const router = express.Router();

/**
 * Timeframe definitions in milliseconds
 */
const TIMEFRAME_MS = {
  "1h": 60 * 60 * 1000,
  "8h": 8 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "2w": 14 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
  all: Infinity,
};

/**
 * GET /api/sessions/list
 *
 * Query Parameters:
 * - timeframe: '1h' | '8h' | '1d' | '1w' | '2w' | '1m' | 'all' (default: '1w')
 *
 * Headers:
 * - If-None-Match: ETag from previous response (for 304 support)
 *
 * Response:
 * - 304 Not Modified (if ETag matches)
 * - 200 OK with sessions data
 */
router.get("/list", async (req, res) => {
  try {
    // Get timeframe from query (validate against known values)
    const timeframe =
      TIMEFRAME_MS[req.query.timeframe] !== undefined
        ? req.query.timeframe
        : "1w";

    // Get sessions from SQLite filtered by timeframe
    const timeframMs =
      TIMEFRAME_MS[timeframe] === Infinity ? null : TIMEFRAME_MS[timeframe];

    const sessionsRaw = getSessions({ timeframMs, limit: 1000 });

    // Get total count (without timeframe filter)
    const allSessions = getSessions({ limit: 10000 });
    const totalCount = allSessions.length;

    // Generate stable ETag based on session count and the minute (changes at most once/minute)
    // This prevents constant 200 responses during active conversations
    const minuteTimestamp = Math.floor(Date.now() / 60000);
    const hash = crypto.createHash("md5");
    hash.update(
      `${sessionsRaw.length}-${totalCount}-${minuteTimestamp}-${timeframe}`,
    );
    const currentETag = `"${hash.digest("hex")}"`;

    // Check If-None-Match header for conditional request
    const clientETag = req.headers["if-none-match"];
    if (clientETag && clientETag === currentETag) {
      // Data hasn't changed - return 304
      return res.status(304).end();
    }

    // Transform sessions to match expected format
    const sessions = sessionsRaw.map((s) => ({
      id: s.id,
      summary: s.summary || "New Session",
      lastActivity: s.lastActivity
        ? new Date(s.lastActivity).toISOString()
        : null,
      messageCount: s.messageCount || 0,
      provider: s.provider || "claude",
      cwd: s.cwd,
      project: {
        name: s.projectName,
        displayName: s.projectDisplayName || s.projectName,
        fullPath: s.projectFullPath,
      },
    }));

    // Set caching headers (Cloudflare-friendly)
    res.set({
      "Cache-Control": "public, max-age=10, stale-while-revalidate=5",
      ETag: currentETag,
    });

    // Return sessions data
    res.json({
      sessions,
      meta: {
        totalCount,
        filteredCount: sessions.length,
        timeframe,
        cacheTimestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[ERROR] Sessions list endpoint error:", error);
    res.status(500).json({
      error: "Failed to retrieve sessions",
      message: error.message,
    });
  }
});

/**
 * GET /api/sessions/cache-status
 * Returns current cache status (for debugging/monitoring)
 */
router.get("/cache-status", (req, res) => {
  try {
    const count = getSessionCount();
    res.json({
      initialized: true,
      sessionCount: count,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
