/**
 * Structured stderr logging. MCP uses stdout for protocol,
 * so all debug/info/error output goes to stderr.
 *
 * Control level: LOG_LEVEL=debug|info|warn|error (default: info)
 * Color output: enabled by default in TTY, disabled in pipes
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";
const USE_COLOR = process.stderr?.isTTY ?? false;

// ANSI color codes
const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m", // gray
  info: "\x1b[36m",  // cyan
  warn: "\x1b[33m",  // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

// Track start time for relative timestamps
const START_TIME = Date.now();

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[MIN_LEVEL];
}

function formatMessage(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): string {
  const elapsed = ((Date.now() - START_TIME) / 1000).toFixed(1);
  const levelTag = level.toUpperCase().padEnd(5);

  if (USE_COLOR) {
    const color = COLORS[level];
    const dataStr = data && Object.keys(data).length > 0 ? ` ${DIM}${JSON.stringify(data)}${RESET}` : "";
    return `${DIM}+${elapsed}s${RESET} ${color}${levelTag}${RESET} ${DIM}[${component}]${RESET} ${message}${dataStr}`;
  }

  const dataStr = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : "";
  return `+${elapsed}s ${levelTag} [${component}] ${message}${dataStr}`;
}

export function createLogger(component: string) {
  return {
    debug(message: string, data?: Record<string, unknown>) {
      if (shouldLog("debug")) console.error(formatMessage("debug", component, message, data));
    },
    info(message: string, data?: Record<string, unknown>) {
      if (shouldLog("info")) console.error(formatMessage("info", component, message, data));
    },
    warn(message: string, data?: Record<string, unknown>) {
      if (shouldLog("warn")) console.error(formatMessage("warn", component, message, data));
    },
    error(message: string, data?: Record<string, unknown>) {
      if (shouldLog("error")) console.error(formatMessage("error", component, message, data));
    },
  };
}
