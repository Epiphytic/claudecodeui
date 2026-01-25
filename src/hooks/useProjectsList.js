import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../utils/api";

const POLL_INTERVAL = 60000; // 60 seconds (was 10 seconds)

/**
 * Hook for fetching slim projects list with ETag-based caching
 * Mirrors useSessionsList pattern for consistency
 *
 * Features:
 * - Non-blocking background refresh (doesn't show loading spinner on polls)
 * - 60-second default polling interval
 * - Manual refresh via refresh() function
 * - ETag-based caching for efficiency
 *
 * @param {string} timeframe - Time filter: '1h' | '8h' | '1d' | '1w' | '2w' | '1m' | 'all'
 * @param {boolean} enabled - Whether to enable fetching and polling
 * @returns {Object} { projects, meta, isLoading, isRefreshing, error, refresh }
 */
function useProjectsList(timeframe = "1w", enabled = true) {
  const [projects, setProjects] = useState([]);
  const [meta, setMeta] = useState(null);
  const [isLoading, setIsLoading] = useState(true); // Only true for initial load
  const [isRefreshing, setIsRefreshing] = useState(false); // True during background refresh
  const [error, setError] = useState(null);

  // Store ETag for 304 support
  const etagRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const hasInitialLoadRef = useRef(false);
  const abortControllerRef = useRef(null);

  const fetchProjects = useCallback(
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
        const response = await api.projectsList(
          timeframe,
          etagRef.current,
          abortControllerRef.current.signal,
        );

        // Handle 304 Not Modified - data unchanged, no need to update state
        if (response.status === 304) {
          setIsLoading(false);
          setIsRefreshing(false);
          hasInitialLoadRef.current = true;
          return;
        }

        if (!response.ok) {
          // Handle 503 - cache not yet initialized
          if (response.status === 503) {
            const errorData = await response.json();
            setError(errorData.message || "Projects cache not yet initialized");
            setIsLoading(false);
            setIsRefreshing(false);
            return;
          }
          throw new Error(`Failed to fetch projects: ${response.status}`);
        }

        // Store new ETag from response
        const newETag = response.headers.get("etag");
        if (newETag) {
          etagRef.current = newETag;
        }

        const data = await response.json();
        setProjects(data.projects || []);
        setMeta(data.meta || null);
        setError(null);
        hasInitialLoadRef.current = true;
      } catch (err) {
        // Ignore abort errors
        if (err.name === "AbortError") {
          return;
        }
        console.error("[useProjectsList] Error:", err);
        // Only set error if we haven't loaded data yet
        if (!hasInitialLoadRef.current) {
          setError(err.message);
        }
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [timeframe, enabled],
  );

  // Initial fetch and timeframe change
  useEffect(() => {
    if (!enabled) return;

    // Reset ETag when timeframe changes (new filter = new cache state)
    etagRef.current = null;
    hasInitialLoadRef.current = false;
    setIsLoading(true);
    fetchProjects(false);

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [timeframe, enabled, fetchProjects]);

  // Set up polling - runs silently in background
  useEffect(() => {
    if (!enabled) return;

    // Clear any existing interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    // Start polling (silent background refresh)
    pollIntervalRef.current = setInterval(
      () => fetchProjects(false),
      POLL_INTERVAL,
    );

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [enabled, fetchProjects]);

  // Force refresh function (clears ETag to force new data)
  const refresh = useCallback(() => {
    etagRef.current = null;
    fetchProjects(true);
  }, [fetchProjects]);

  return {
    projects,
    meta,
    isLoading,
    isRefreshing,
    error,
    refresh,
  };
}

export default useProjectsList;
