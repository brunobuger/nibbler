export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  level?: LogLevel;
  json?: boolean;
}

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  constructor(private opts: LoggerOptions = {}) {}

  debug(message: string, data?: unknown) {
    this.log('debug', message, data);
  }
  info(message: string, data?: unknown) {
    this.log('info', message, data);
  }
  warn(message: string, data?: unknown) {
    this.log('warn', message, data);
  }
  error(message: string, data?: unknown) {
    this.log('error', message, data);
  }

  private log(level: LogLevel, message: string, data?: unknown) {
    const configured = this.opts.level ?? 'info';
    if (levelRank[level] < levelRank[configured]) return;

    const timestamp = new Date().toISOString();

    if (this.opts.json) {
      process.stderr.write(`${JSON.stringify({ timestamp, level, message, data })}\n`);
      return;
    }

    const line = data === undefined ? `${timestamp} ${level} ${message}` : `${timestamp} ${level} ${message} ${safeJson(data)}`;
    process.stderr.write(`${line}\n`);
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '"[unserializable]"';
  }
}

