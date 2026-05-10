import { AsyncLocalStorage } from "node:async_hooks";

type Emitter = (chunk: string) => void;
const als = new AsyncLocalStorage<Emitter>();

const TAG_COLORS: Record<string, string> = {
  user: "\x1b[36m",
  step: "\x1b[33m",
  tool_calls: "\x1b[35m",
  tool_use: "\x1b[35m",
  tool_result: "\x1b[34m",
  tool_done: "\x1b[34m",
  assistant: "\x1b[32m",
  done: "\x1b[32m",
  error: "\x1b[31m",
  aborted: "\x1b[31m",
  dim: "\x1b[2m",
  info: "\x1b[2m",
};
const RESET = "\x1b[0m";

function inspect(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function colorizeFirstTag(line: string): string {
  const m = line.match(/^\[(\w+)\]/);
  if (!m) return line;
  const color = TAG_COLORS[m[1]];
  if (!color) return line;
  return `${color}${m[0]}${RESET}${line.slice(m[0].length)}`;
}

const origConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function emitLine(args: unknown[]) {
  const e = als.getStore();
  if (!e) {
    origConsole.log(...args);
    return;
  }
  const text = args.map(inspect).join(" ");
  e(colorizeFirstTag(text) + "\n");
}

console.log = (...args: unknown[]) => emitLine(args);
console.info = (...args: unknown[]) => emitLine(args);
console.warn = (...args: unknown[]) => emitLine(args);
console.error = (...args: unknown[]) => emitLine(args);

const proc: any = (globalThis as any).process ?? ((globalThis as any).process = {});
if (!proc.stdout) {
  proc.stdout = {
    write: (chunk: any) => {
      const e = als.getStore();
      if (!e) return false;
      e(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    },
  };
}

export function withConsoleEmitter<T>(emitter: Emitter, fn: () => Promise<T>): Promise<T> {
  return als.run(emitter, fn);
}
