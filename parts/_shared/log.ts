const TAG_STYLES: Record<string, { color: string; showTag: boolean; raw?: boolean }> = {
  user:        { color: "\x1b[36m", showTag: true },  // cyan
  step:        { color: "\x1b[33m", showTag: true },  // yellow
  tool_calls:  { color: "\x1b[35m", showTag: true },  // magenta
  tool_use:    { color: "\x1b[35m", showTag: true },
  tool_result: { color: "\x1b[34m", showTag: true },  // blue
  tool_done:   { color: "\x1b[34m", showTag: true },
  assistant:   { color: "\x1b[32m", showTag: true },  // green
  done:        { color: "\x1b[32m", showTag: false }, // ✓ done
  error:       { color: "\x1b[31m", showTag: true },  // red
  aborted:     { color: "\x1b[31m", showTag: true },
  provider:    { color: "\x1b[2m",  showTag: true },  // dim with tag
  dim:         { color: "\x1b[2m",  showTag: false }, // 整段 dim 灰
  raw:         { color: "",         showTag: false, raw: true }, // 流式 token，不换行
};

const RESET = "\x1b[0m";

export type LogFn = (tag: string, ...rest: unknown[]) => void;

export function makeLogger(emit: (text: string) => void): LogFn {
  return (tag, ...rest) => {
    const body = rest
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join(" ");
    const style = TAG_STYLES[tag];
    if (!style) {
      emit((body ? `${tag} ${body}` : tag) + "\n");
      return;
    }
    if (style.raw) {
      emit(body);
      return;
    }
    if (tag === "done") {
      emit(`${style.color}✓ done${body ? " " + body : ""}${RESET}\n`);
      return;
    }
    if (style.showTag) {
      const head = `${style.color}[${tag}]${RESET}`;
      emit((body ? `${head} ${body}` : head) + "\n");
    } else {
      emit(`${style.color}${body}${RESET}\n`);
    }
  };
}
