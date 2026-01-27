/**
 * Centralized Maintenance Scheduler
 *
 * Consolidates all periodic maintenance tasks into a single scheduler
 * that only runs when clients are connected. This reduces CPU usage
 * when the application is idle.
 *
 * Features:
 * - Single interval timer instead of multiple
 * - Tasks only run when clients are connected
 * - Each task has its own interval configuration
 * - Automatic task execution based on elapsed time
 */

import { createLogger } from "./logger.js";

const log = createLogger("maintenance-scheduler");

// Registered tasks: name -> { fn, intervalMs, lastRun }
const tasks = new Map();

// Main scheduler state
let maintenanceInterval = null;
let isActive = false;

// Check every minute for due tasks
const MAINTENANCE_INTERVAL = 60 * 1000;

/**
 * Register a maintenance task
 * @param {string} name - Unique task name
 * @param {function} fn - Task function to execute
 * @param {number} intervalMs - How often to run (in milliseconds)
 */
function registerTask(name, fn, intervalMs) {
  tasks.set(name, {
    fn,
    intervalMs,
    lastRun: 0,
  });
  log.debug({ name, intervalMs }, "Registered maintenance task");
}

/**
 * Unregister a maintenance task
 * @param {string} name - Task name to remove
 * @returns {boolean} - Whether task was removed
 */
function unregisterTask(name) {
  const removed = tasks.delete(name);
  if (removed) {
    log.debug({ name }, "Unregistered maintenance task");
  }
  return removed;
}

/**
 * Run all due maintenance tasks
 */
function runMaintenance() {
  const now = Date.now();
  let tasksRun = 0;

  for (const [name, task] of tasks) {
    if (now - task.lastRun >= task.intervalMs) {
      try {
        log.debug({ name }, "Running maintenance task");
        const result = task.fn();

        // Handle async tasks
        if (result instanceof Promise) {
          result.catch((err) => {
            log.error(
              { name, error: err.message },
              "Async maintenance task error",
            );
          });
        }

        task.lastRun = now;
        tasksRun++;
      } catch (err) {
        log.error({ name, error: err.message }, "Maintenance task error");
      }
    }
  }

  if (tasksRun > 0) {
    log.debug(
      { tasksRun, totalTasks: tasks.size },
      "Maintenance cycle completed",
    );
  }
}

/**
 * Set the scheduler active state
 * @param {boolean} active - Whether maintenance should be active
 */
function setActive(active) {
  if (isActive === active) return;
  isActive = active;

  if (active && !maintenanceInterval) {
    log.info({ taskCount: tasks.size }, "Starting maintenance scheduler");
    maintenanceInterval = setInterval(runMaintenance, MAINTENANCE_INTERVAL);
    // Run immediately when becoming active
    runMaintenance();
  } else if (!active && maintenanceInterval) {
    log.info("Stopping maintenance scheduler (no clients connected)");
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
  }
}

/**
 * Check if the scheduler is currently active
 * @returns {boolean}
 */
function isSchedulerActive() {
  return isActive;
}

/**
 * Get status of all registered tasks
 * @returns {Array<{ name: string, intervalMs: number, lastRun: number, msSinceLastRun: number }>}
 */
function getTaskStatus() {
  const now = Date.now();
  const status = [];

  for (const [name, task] of tasks) {
    status.push({
      name,
      intervalMs: task.intervalMs,
      lastRun: task.lastRun,
      msSinceLastRun: task.lastRun > 0 ? now - task.lastRun : null,
    });
  }

  return status;
}

/**
 * Force run a specific task immediately
 * @param {string} name - Task name to run
 * @returns {boolean} - Whether task was found and executed
 */
function forceRunTask(name) {
  const task = tasks.get(name);
  if (!task) return false;

  try {
    task.fn();
    task.lastRun = Date.now();
    log.info({ name }, "Force-ran maintenance task");
    return true;
  } catch (err) {
    log.error({ name, error: err.message }, "Force-run maintenance task error");
    return false;
  }
}

export {
  registerTask,
  unregisterTask,
  setActive,
  isSchedulerActive,
  getTaskStatus,
  forceRunTask,
  MAINTENANCE_INTERVAL,
};
