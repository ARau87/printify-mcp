export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Writes prefixed lines to stderr. Never stdout: stdout carries the MCP protocol. */
export function createLogger(
  write: (text: string) => unknown = (text) => process.stderr.write(text),
): Logger {
  const writer = (prefix: string) => (message: string) => {
    write(`printify-mcp: ${prefix}${message}\n`);
  };
  return { info: writer(''), warn: writer('warning: '), error: writer('error: ') };
}
