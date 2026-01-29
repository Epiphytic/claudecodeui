/**
 * Logger Module
 *
 * Provides structured logging with:
 * - Multiple log levels (debug, info, warn, error)
 * - JSON output format option (via LOG_FORMAT=json env var)
 * - Pretty printing for development (default)
 * - Configurable log level via LOG_LEVEL env var
 */

import pino from "pino";

// Get log level from environment (default: info)
// In production, you might want 'warn' or 'error'
const logLevel = process.env.LOG_LEVEL || "info";

// Check if JSON format is requested
const useJsonFormat = process.env.LOG_FORMAT === "json";

// Create logger options
const loggerOptions = {
  level: logLevel,
  // Add timestamp in ISO format
  timestamp: pino.stdTimeFunctions.isoTime,
  // Add base fields to all log entries
  base: {
    pid: process.pid,
    app: "claudecodeui",
  },
};

// Configure transport based on format preference
let transport;
if (!useJsonFormat) {
  // Pretty printing for development
  transport = {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname,app",
      messageFormat: "{msg}",
    },
  };
}

// Create the logger
const logger = transport
  ? pino(loggerOptions, pino.transport(transport))
  : pino(loggerOptions);

// Create child loggers for different modules
function createLogger(module) {
  return logger.child({ module });
}

// Export both the base logger and the factory function
export { logger, createLogger };
export default logger;
