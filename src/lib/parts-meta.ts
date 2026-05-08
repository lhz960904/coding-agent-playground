import part1 from "../../snippets/02-part-1.ts.txt?raw";
import part2 from "../../snippets/02-part-2.ts.txt?raw";
import part3 from "../../snippets/02-part-3.ts.txt?raw";
import part4 from "../../snippets/02-part-4.ts.txt?raw";
import part5 from "../../snippets/02-part-5.ts.txt?raw";

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
        summary: "while + Promise.all 的 ReAct 循环，<40 行跑通模型 ↔ 工具调用",
        code: part1,
      },
      {
        id: "02-part-2",
        label: "Part 2",
        title: "可中断：AbortController 接入",
        summary: "用 AbortSignal 把中止信号贯穿 LLM 请求和工具执行，演示 5 秒后自动 abort",
        code: part2,
      },
      {
        id: "02-part-3",
        label: "Part 3",
        title: "并发优化：Promise.race",
        summary: "一个慢工具 + 一个快工具，对比 Promise.all 整体等待 vs Promise.race 边出边消费",
        code: part3,
      },
      {
        id: "02-part-4",
        label: "Part 4",
        title: "多模型：LLMProvider 抽象",
        summary: "block-based 内部消息 + Provider 接口，主循环不动，DeepSeek / Claude 即插即换",
        code: part4,
      },
      {
        id: "02-part-5",
        label: "Part 5",
        title: "全流程流式：stream + invoke 复用",
        summary: "Provider 把流式事件累积成快照，主循环 yield partial，invoke 复用 stream",
        code: part5,
      },
    ],
  },
];

export function findArticle(id: string): ArticleMeta | undefined {
  return articles.find((a) => a.id === id);
}

export function findPart(articleId: string, partId: string): { article: ArticleMeta; part: PartMeta } | undefined {
  const article = findArticle(articleId);
  if (!article) return;
  const part = article.parts.find((p) => p.id === partId);
  if (!part) return;
  return { article, part };
}
