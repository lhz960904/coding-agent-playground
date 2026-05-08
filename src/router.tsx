import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Header } from "./components/Header";
import { PartTabs } from "./components/PartTabs";
import { CodeViewer } from "./components/CodeViewer";
import { Terminal, type TerminalHandle } from "./components/Terminal";
import { RunButton } from "./components/RunButton";
import { runPart, type RunHandle } from "./lib/sse";
import { articles, findPart } from "./lib/parts-meta";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: LandingPage,
});

const partRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/article/$articleId/part/$partId",
  component: PartPage,
});

const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "*",
  component: NotFound,
});

const routeTree = rootRoute.addChildren([indexRoute, partRoute, notFoundRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function LandingPage() {
  return (
    <div className="flex flex-col h-full">
      <Header />
      <main className="flex-1 overflow-auto px-6 py-12">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl font-bold mb-3">code-artisan playground</h1>
          <p className="text-[var(--color-fg-muted)] leading-relaxed mb-10">
            配套{" "}
            <a
              href="https://github.com/lhz960904/code-artisan"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-accent)] hover:underline"
            >
              code-artisan
            </a>{" "}
            拆解系列的在线运行平台。挑一篇文章，逐 part 看完整代码 + 直接跑实例。
            <br />
            无需 API key，无需配置环境，浏览器里点 Run 即可。
          </p>

          {articles.map((article) => (
            <section key={article.id} className="mb-10">
              <h2 className="text-lg font-semibold mb-1">{article.title}</h2>
              <a
                href={article.juejinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-accent)] mb-4 inline-block"
              >
                阅读原文 ↗
              </a>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-2">
                {article.parts.map((p) => (
                  <Link
                    key={p.id}
                    to="/article/$articleId/part/$partId"
                    params={{ articleId: article.id, partId: p.id }}
                    className="block p-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)] transition-colors group"
                  >
                    <div className="text-xs text-[var(--color-accent)] mb-1.5 font-semibold">
                      {p.label}
                    </div>
                    <div className="text-sm font-medium mb-1.5 group-hover:text-[var(--color-accent)]">
                      {p.title}
                    </div>
                    <div className="text-xs text-[var(--color-fg-muted)] leading-relaxed">
                      {p.summary}
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ))}

          <footer className="text-xs text-[var(--color-fg-muted)] border-t border-[var(--color-border)] pt-6 mt-12 leading-relaxed">
            <p>
              <span className="text-[var(--color-accent)]">★</span> 主项目：
              <a
                href="https://github.com/lhz960904/code-artisan"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-fg)] hover:text-[var(--color-accent)] hover:underline mx-1"
              >
                code-artisan
              </a>
              — 一个用 1 个月写出来的开源 Web AI Coding Agent。本 playground 的代码示例就是从那个项目里拆出来的。
            </p>
            <p className="mt-2">
              本平台代码：
              <a
                href="https://github.com/lhz960904/coding-agent-playground"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[var(--color-accent)] hover:underline"
              >
                github.com/lhz960904/coding-agent-playground
              </a>
            </p>
          </footer>
        </div>
      </main>
    </div>
  );
}

function PartPage() {
  const { articleId, partId } = useParams({ from: "/article/$articleId/part/$partId" });
  const data = findPart(articleId, partId);
  const termRef = useRef<TerminalHandle>(null);
  const handleRef = useRef<RunHandle | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    return () => {
      handleRef.current?.abort();
    };
  }, [partId]);

  if (!data) return <NotFound />;
  const { article, part } = data;

  const handleRun = () => {
    termRef.current?.clear();
    setRunning(true);
    const handle = runPart(part.id, (event) => {
      if (event.type === "output") {
        termRef.current?.write(event.chunk);
      } else if (event.type === "exit") {
        setRunning(false);
      } else if (event.type === "error") {
        termRef.current?.writeln(`\r\n\x1b[31m✗ ${event.message}\x1b[0m`);
        setRunning(false);
      }
    });
    handleRef.current = handle;
    handle.done.finally(() => setRunning(false));
  };

  const handleStop = () => {
    handleRef.current?.abort();
    termRef.current?.writeln("\r\n\x1b[33m⏸ 已中止\x1b[0m");
    setRunning(false);
  };

  return (
    <div className="flex flex-col h-full">
      <Header />
      <PartTabs article={article} currentPartId={part.id} />
      <div className="flex items-center justify-between px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">
            <span className="text-[var(--color-accent)] mr-2">{part.label}</span>
            {part.title}
          </div>
          <div className="text-xs text-[var(--color-fg-muted)] mt-0.5 truncate">
            {part.summary}
          </div>
        </div>
        <RunButton
          state={running ? "running" : "idle"}
          onRun={handleRun}
          onStop={handleStop}
        />
      </div>
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 min-h-0">
        <div className="border-r border-[var(--color-border)] overflow-hidden min-h-[300px] md:min-h-0">
          <CodeViewer code={part.code} />
        </div>
        <div className="overflow-hidden min-h-[300px] md:min-h-0">
          <Terminal ref={termRef} />
        </div>
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex flex-col h-full">
      <Header />
      <main className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl text-[var(--color-fg-muted)] mb-4">404</div>
          <div className="text-sm text-[var(--color-fg-muted)] mb-6">
            没找到这个 part。可能链接拼错了？
          </div>
          <Link
            to="/"
            className="inline-block px-4 py-2 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] text-sm"
          >
            ← 回首页
          </Link>
        </div>
      </main>
    </div>
  );
}
