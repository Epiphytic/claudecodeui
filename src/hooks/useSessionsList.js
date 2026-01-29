import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../utils/api";

// Exponential backoff constants
const POLL_INITIAL = 60000; // 1 minute initial
const POLL_MAX = 60 * 60 * 1000; // 1 hour max
const BACKOFF_MULTIPLIER = 1.5;

/**
 * Hook for fetching sessions list with ETag-based caching
 *
 * Features:
 * - Non-blocking background refresh (doesn't show loading spinner on polls)
 * - Exponential backoff: starts at 1 min, backs off to 1 hour max
 * - Resets to 1 min when changes detected or manual refresh
 * - Manual refresh via refresh() function
 * - ETag-based caching for efficiency
 *
 * @param {string} timeframe - Time filter: '1h' | '8h' | '1d' | '1w' | '2w' | '1m' | 'all'
 * @param {boolean} enabled - Whether to enable fetching and polling
 * @returns {Object} { sessions, meta, isLoading, isRefreshing, error, refresh, pollInterval }
 */
function useSessionsList(timeframe = "1w", enabled = true) {
  const [sessions, setSessions] = useState([]);
  const [meta, setMeta] = useState(null);
  const [isLoading, setIsLoading] = useState(true); // Only true for initial load
  const [isRefreshing, setIsRefreshing] = useState(false); // True during background refresh
  const [error, setError] = useState(null);
  const [pollInterval, setPollInterval] = useState(POLL_INITIAL);

  // Store ETag for 304 support
  const etagRef = useRef(null);
  const pollTimeoutRef = useRef(null);
  const pollIntervalRef = useRef(POLL_INITIAL);
  const hasInitialLoadRef = useRef(false);
  const abortControllerRef = useRef(null);

  // Reset poll interval to initial value
  const resetPollInterval = useCallback(() => {
    pollIntervalRef.current = POLL_INITIAL;
    setPollInterval(POLL_INITIAL);
  }, []);

  // Increase poll interval with exponential backoff
  const increasePollInterval = useCallback(() => {
    const newInterval = Math.min(
      pollIntervalRef.current * BACKOFF_MULTIPLIER,
      POLL_MAX,
    );
    pollIntervalRef.current = newInterval;
    setPollInterval(newInterval);
  }, []);

  const fetchSessions = useCallback(
    async (isManualRefresh = false) => {
      if (!enabled) return;

      // Cancel any in-flight request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

      // Only show loading spinner on initial load or manual refresh
      const showLoading = !hasInitialLoadRef.current || isManualRefresh;
      if (showLoading) {
        if (hasInitialLoadRef.current) {
          setIsRefreshing(true);
        } else {
          setIsLoading(true);
        }
      }

      try {
        const response = await api.sessionsList(
          timeframe,
          etagRef.current,
          abortControllerRef.current.signal,
        );

        // Handle 304 Not Modified - data unchanged, increase backoff
        if (response.status === 304) {
          setIsLoading(false);
          setIsRefreshing(false);
          hasInitialLoadRef.current = true;
          // No changes - increase backoff interval
          increasePollInterval();
          return;
        }

        if (!response.ok) {
          // Handle 503 - cache not yet initialized
          if (response.status === 503) {
            const errorData = await response.json();
            setError(errorData.message || "Sessions cache not yet initialized");
            setIsLoading(false);
            setIsRefreshing(false);
            return;
          }
          throw new Error(`Failed to fetch sessions: ${response.status}`);
        }

        // Store new ETag from response
        const newETag = response.headers.get("etag");
        if (newETag) {
          etagRef.current = newETag;
        }

        const data = await response.json();
        setSessions(data.sessions || []);
        setMeta(data.meta || null);
        setError(null);
        hasInitialLoadRef.current = true;
        // Changes detected - reset to initial interval
        resetPollInterval();
      } catch (err) {
        // Ignore abort errors
        if (err.name === "AbortError") {
          return;
        }
        console.error("[useSessionsList] Error:", err);
        // Only set error if we haven't loaded data yet
        if (!hasInitialLoadRef.current) {
          setError(err.message);
        }
        // On error, increase backoff
        increasePollInterval();
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [timeframe, enabled, resetPollInterval, increasePollInterval],
  );

  // Initial fetch and timeframe change
  useEffect(() => {
    if (!enabled) return;

    // Reset ETag when timeframe changes (new filter = new cache state)
    etagRef.current = null;
    hasInitialLoadRef.current = false;
    setIsLoading(true);
    fetchSessions(false);

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [timeframe, enabled, fetchSessions]);

  // Set up polling with exponential backoff - runs silently in background
  useEffect(() => {
    if (!enabled) return;

    // Use setTimeout with dynamic interval for exponential backoff
    const scheduleNextPoll = () => {
      pollTimeoutRef.current = setTimeout(async () => {
        await fetchSessions(false);
        // Schedule next poll with current interval (may have changed)
        scheduleNextPoll();
      }, pollIntervalRef.current);
    };

    scheduleNextPoll();

    return () => {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };
  }, [enabled, fetchSessions]);

  // Force refresh function (clears ETag to force new data, resets interval)
  const refresh = useCallback(() => {
    etagRef.current = null;
    resetPollInterval();
    fetchSessions(true);
  }, [fetchSessions, resetPollInterval]);

  return {
    sessions,
    meta,
    isLoading,
    isRefreshing,
    error,
    refresh,
    pollInterval,
  };
}

export default useSessionsList;
