import { Link } from "@tanstack/react-router";

export function Header() {
  return (
    <header className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 h-12">
      <div className="flex items-center gap-4">
        <Link
          to="/"
          className="flex items-center gap-2 text-[var(--color-fg)] hover:text-[var(--color-accent)]"
        >
          <span className="text-[var(--color-accent)] text-lg">▸</span>
          <span className="font-semibold tracking-wide">code-artisan playground</span>
        </Link>
        <span className="text-[var(--color-fg-muted)] text-xs">配套拆解系列在线运行环境</span>
      </div>

      <nav className="flex items-center gap-3 text-xs">
        <a
          href="https://github.com/lhz960904/code-artisan"
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
        >
          ★ Star code-artisan on GitHub
        </a>
        <a
          href="https://juejin.cn/user/1574156360475198"
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
        >
          掘金主页
        </a>
      </nav>
    </header>
  );
}
