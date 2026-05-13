import part1Source from "../../parts/02-part-1.ts?raw";
import part2Source from "../../parts/02-part-2.ts?raw";
import part3Source from "../../parts/02-part-3.ts?raw";
import part4Source from "../../parts/02-part-4.ts?raw";
import part5Source from "../../parts/02-part-5.ts?raw";
import part03_1Source from "../../parts/03-part-1.ts?raw";
import part03_2Source from "../../parts/03-part-2.ts?raw";
import part03_3Source from "../../parts/03-part-3.ts?raw";
import part03_4Source from "../../parts/03-part-4.ts?raw";

export type ArticleMeta = {
  id: string;
  title: string;
  juejinUrl: string;
  parts: PartMeta[];
};

export type PartMeta = {
  id: string;
  label: string;
  title: string;
  summary: string;
  code: string;
};

function prepare(source: string): string {
  return source.trimEnd() + "\n";
}

export const articles: ArticleMeta[] = [
  {
    id: "02-react-loop",
    title: "code-artisan 02 · 从零实现一个 ReAct Agent Loop",
    juejinUrl: "https://juejin.cn/post/code-artisan-02",
    parts: [
      {
        id: "02-part-1",
        label: "Part 1",
        title: "核心概念 + 最简实现",
        summary: "Agent class + while + Promise.all 的 ReAct 循环。最简形态，直接复制就能跑（只需 openai SDK）",
        code: prepare(part1Source),
      },
      {
        id: "02-part-2",
        label: "Part 2",
        title: "优雅中断：abort 时不留 tool_use 孤儿",
        summary: "用户中途点取消，怎么干净地停下来。tool_use 没拿到 tool_result 时手动补占位，避免下次请求 400",
        code: prepare(part2Source),
      },
      {
        id: "02-part-3",
        label: "Part 3",
        title: "流式结构：partial / message 事件",
        summary: "agent.stream() 吐 partial（按 token 推流，前端做打字机）+ message（定稿，前端落到消息列表）",
        code: prepare(part3Source),
      },
      {
        id: "02-part-4",
        label: "Part 4",
        title: "流式 + race：多工具边出边送给客户端",
        summary: "工具改 AsyncGen + Promise.race。一个慢一个快时，客户端立刻能渲染快的，不用等慢的拖累",
        code: prepare(part4Source),
      },
      {
        id: "02-part-5",
        label: "Part 5",
        title: "Provider 抽象：屏蔽 OpenAI / Anthropic 协议差异",
        summary: "block-based 内部消息 + LLMProvider 接口。主循环不动，DeepSeek / Kimi / Claude 即插即换",
        code: prepare(part5Source),
      },
    ],
  },
  {
    id: "03-tools",
    title: "code-artisan 03 · 从通用 Agent 到 Coding Agent，工具系统怎么搭",
    juejinUrl: "https://juejin.cn/post/code-artisan-03",
    parts: [
      {
        id: "03-part-1",
        label: "Part 1",
        title: "defineTool + Zod：工具定义的统一形态",
        summary: "schema 和 impl 写在一起，类型从 Zod 推导。z.toJSONSchema 转成 OpenAI / Anthropic 的 JSON Schema",
        code: prepare(part03_1Source),
      },
      {
        id: "03-part-2",
        label: "Part 2",
        title: "read_file：第一个 builtin 工具",
        summary: "用 node:fs/promises 直接实现 read_file。文件超过 12k 字符时自动头尾截断，避免撑爆 LLM 上下文",
        code: prepare(part03_2Source),
      },
      {
        id: "03-part-3",
        label: "Part 3",
        title: "write_file / str_replace / bash + 错误隔离",
        summary: "把通用 agent 武装成 coding agent。4 个 builtin + 单工具失败兜底（catch 后包成 Error: xxx 给 LLM）",
        code: prepare(part03_3Source),
      },
      {
        id: "03-part-4",
        label: "Part 4",
        title: "长任务 bash：run_in_background + session 池",
        summary: "child_process.spawn 跑后台进程，bash_output 轮询输出，kill_shell 关停。dev server 这种慢热服务的标准玩法",
        code: prepare(part03_4Source),
      },
    ],
  },
];

export function findArticle(id: string): ArticleMeta | undefined {
  return articles.find((a) => a.id === id);
}

export function findPart(articleId: string, partId: string) {
  const article = findArticle(articleId);
  if (!article) return;
  const part = article.parts.find((p) => p.id === partId);
  if (!part) return;
  return { article, part };
}
