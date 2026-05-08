import { Link } from "@tanstack/react-router";
import type { ArticleMeta } from "../lib/parts-meta";

export function PartTabs({
  article,
  currentPartId,
}: {
  article: ArticleMeta;
  currentPartId: string;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-2 overflow-x-auto">
      <span className="text-xs text-[var(--color-fg-muted)] mr-3 whitespace-nowrap">
        {article.title.replace(/^code-artisan \d+ · /, "")}
      </span>
      {article.parts.map((p) => {
        const active = p.id === currentPartId;
        return (
          <Link
            key={p.id}
            to="/article/$articleId/part/$partId"
            params={{ articleId: article.id, partId: p.id }}
            className={`px-3 py-1 rounded text-xs whitespace-nowrap transition-colors ${
              active
                ? "bg-[var(--color-accent)] text-black font-semibold"
                : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg)]"
            }`}
          >
            {p.label}
          </Link>
        );
      })}
      <a
        href={article.juejinUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-auto text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-accent)] whitespace-nowrap"
      >
        阅读原文 →
      </a>
    </div>
  );
}
