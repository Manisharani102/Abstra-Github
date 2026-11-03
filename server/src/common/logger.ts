import { LoggerService } from '@nestjs/common';

const SECRET_KEY_PATTERN = /token|secret|password|authorization|cookie|private_?key|webhook_?url|api_?key/i;
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /ghs_[A-Za-z0-9]{20,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /gsk_[A-Za-z0-9]{20,}/g, // Groq keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function scrubString(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce((acc, re) => acc.replace(re, '[REDACTED]'), value);
}

/** Deep-copies a value, redacting anything that looks like a secret by key name or value shape. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return scrubString(value);
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

/** One JSON object per line, so Render's log viewer (or any log shipper) can parse it. */
export class JsonLogger implements LoggerService {
  private write(level: Level, message: unknown, context?: string, extra?: Record<string, unknown>) {
    const line = {
      ts: new Date().toISOString(),
      level,
      context,
      msg: typeof message === 'string' ? scrubString(message) : redact(message),
      ...(extra ? (redact(extra) as Record<string, unknown>) : {}),
    };
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(JSON.stringify(line) + '\n');
  }

  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }
  error(message: unknown, trace?: string, context?: string) {
    this.write('error', message, context, trace ? { trace: scrubString(trace) } : undefined);
  }
  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    if (process.env.NODE_ENV !== 'production') this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string) {
    this.debug(message, context);
  }
}

/** Small structured logger for app code: `log.info('delivery.claimed', { deliveryId })`. */
export class AppLogger {
  private static sink = new JsonLogger();
  constructor(private readonly context: string) {}

  private emit(level: Level, event: string, fields?: Record<string, unknown>) {
    // Core keys go last so a field (e.g. a GitHub `event` name) can never overwrite them.
    const line = {
      ...(redact(fields ?? {}) as object),
      ts: new Date().toISOString(),
      level,
      context: this.context,
      msg: event,
    };
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(JSON.stringify(line) + '\n');
  }

  info(event: string, fields?: Record<string, unknown>) {
    this.emit('info', event, fields);
  }
  warn(event: string, fields?: Record<string, unknown>) {
    this.emit('warn', event, fields);
  }
  error(event: string, fields?: Record<string, unknown>) {
    this.emit('error', event, fields);
  }

  static get nest() {
    return AppLogger.sink;
  }
}

export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return scrubString(msg).slice(0, 1000);
}
