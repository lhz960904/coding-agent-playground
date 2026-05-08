import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export type TerminalHandle = {
  write: (text: string) => void;
  writeln: (text: string) => void;
  clear: () => void;
};

export const Terminal = forwardRef<TerminalHandle>(function Terminal(_, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      fontFamily: "JetBrains Mono, Cascadia Code, ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      cursorStyle: "block",
      convertEol: true,
      theme: {
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#10b981",
        cursorAccent: "#0d1117",
        selectionBackground: "rgba(16, 185, 129, 0.25)",
        black: "#484f58",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#f0f6fc",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    xtermRef.current = term;
    fitRef.current = fit;

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // container 尺寸为 0 时 fit 会抛，忽略
      }
    });
    ro.observe(containerRef.current);
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        // ignore
      }
    });

    term.writeln("\x1b[2m点击右上角 Run 按钮跑一下 ↗\x1b[0m");

    return () => {
      ro.disconnect();
      term.dispose();
      xtermRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    write: (text: string) => xtermRef.current?.write(text),
    writeln: (text: string) => xtermRef.current?.writeln(text),
    clear: () => xtermRef.current?.clear(),
  }));

  return (
    <div className="h-full w-full overflow-hidden bg-[#0d1117] p-3">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
});
