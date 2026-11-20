import type { LogLevel } from './config/env';

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

export function createLogger(
  minimumLevel: LogLevel,
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
): Logger {
  return (level, event, fields = {}) => {
    if (priorities[level] < priorities[minimumLevel]) {
      return;
    }

    write(JSON.stringify({ ...fields, time: new Date().toISOString(), level, event }));
  };
}
