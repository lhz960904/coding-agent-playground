# coding-agent-playground

> 配套 [code-artisan](https://github.com/lhz960904/code-artisan) 拆解系列的在线运行平台。每篇文章对应若干个可运行 part，读者点链接就能在浏览器看完整代码 + 直接跑实际效果，**无需配置任何 LLM key**。

![preview](./docs/preview.png)

## 当前内容

| 文章 | 状态 | Parts |
|---|---|---|
| 02 · 从零实现一个 ReAct Agent Loop | ✅ 上线 | Part 1-5（最简实现 / 可中断 / Promise.race / LLMProvider 抽象 / 流式） |

## 在线访问

- 主项目（值得 ⭐）：[github.com/lhz960904/code-artisan](https://github.com/lhz960904/code-artisan)
- 文章：见落地页 "阅读原文" 链接

## 设计要点

- **零配置**：读者不申请 DeepSeek / Anthropic key，开盒即用（key 由服务端统一持有）
- **代码只读**：Monaco `readOnly={true}` + API 白名单 `partId`，防止读者绕过前端读取服务端 env
- **terminal 风格**：参考 [codeben.dev](https://codeben.dev/)，左 Monaco 右 xterm.js，dark mode
- **流式输出**：SSE 实时把服务端 stdout 推到浏览器 terminal，还原 ReAct 循环的真实流式体感

## 安全

| 风险 | 防御 |
|---|---|
| 用户编辑代码读取 env | Monaco `readOnly={true}` |
| 用户绕过前端直接 POST 任意代码 | API 只接受 `partId` 白名单，不接受任意源码 |
| 用户狂刷 LLM key 烧钱 | IP 限速 100 次/天（in-memory MVP） |
| 长任务跑爆 | 单次 run 55s 强制 abort |
| 输出里的恶意 HTML | xterm 渲染纯文本 + ANSI，不解析 HTML/script |

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vite + React 19 + TS + Tailwind v4 + TanStack Router |
| 编辑器 | `@monaco-editor/react`（readOnly） |
| Terminal | `@xterm/xterm` + `@xterm/addon-fit` |
| 后端 | Hono on Vercel Functions（Node runtime） |
| 部署 | Vercel |
| 限速存储 | in-memory（MVP） → 后续换 Upstash KV |

## 项目结构

```
coding-agent-playground/
├── api/
│   ├── [[...slug]].ts            # Hono catch-all on Vercel Functions
│   └── _lib/
│       └── rate-limit.ts         # IP 限速（in-memory）
├── parts/                        # 服务端实际跑的代码（环境感知）
│   ├── 02-part-1.ts ~ 5.ts
│   └── _shared/
│       ├── tools.ts              # 公共 weather mock
│       └── anthropic-provider.ts
├── snippets/                     # 前端展示给读者看的代码（与文章 1:1）
│   └── 02-part-1.ts.txt ~ 5.ts.txt
├── src/                          # 前端
│   ├── main.tsx
│   ├── router.tsx                # 全部路由 + 页面
│   ├── components/
│   │   ├── Header.tsx            # 含 code-artisan 引流
│   │   ├── PartTabs.tsx
│   │   ├── CodeViewer.tsx        # Monaco readOnly
│   │   ├── Terminal.tsx          # xterm
│   │   └── RunButton.tsx
│   ├── lib/
│   │   ├── parts-meta.ts         # 文章 + part 元数据 + ?raw import snippets
│   │   └── sse.ts                # 消费 SSE 流
│   ├── styles.css                # Tailwind v4 + xterm css
│   └── vite-env.d.ts
├── public/favicon.svg
├── package.json
├── vite.config.ts
├── vercel.json
└── tsconfig.json (+ .app + .node)
```

## 本地开发

```bash
pnpm install
pnpm dev        # 前端 vite dev server
pnpm build      # 类型检查 + 生产打包
pnpm typecheck
```

> 本地开发时**后端不会自动启动**——需要 LLM key 的部分只能在 Vercel preview / production 上跑。  
> 想本地验证后端：装 `vercel` CLI 后 `vercel dev`（会自动起 Vercel Functions + 前端）。

## 部署到 Vercel

1. 把这个 repo 连接到 Vercel（[vercel.com/new](https://vercel.com/new) → Import Git Repository → 选 `coding-agent-playground`）
2. Framework Preset 选 **Vite**（vercel.json 已配好，自动识别）
3. 在 **Settings → Environment Variables** 加：
   - `DEEPSEEK_API_KEY`（必填）—— 走 OpenAI 兼容协议，所有 part 都用它
   - `ANTHROPIC_API_KEY`（可选）—— Part 4 演示双 provider 时如果配了就跑 Claude 对比
   - `RUN_RATE_LIMIT_PER_DAY`（可选，默认 100）—— 单 IP 每天最多跑多少次
4. Deploy

## 路由

- `/` — 落地页（介绍 + 所有 part 入口）
- `/article/:articleId/part/:partId` — part 详情（Code + Terminal + Run）

掘金文章里直接放这种 URL：

```
https://your-vercel-domain/article/02-react-loop/part/02-part-1
```

## API

### `POST /api/run/:partId`

触发 part 运行，返回 SSE 流：

- `event: output` — `{ stream: "stdout"|"stderr", chunk: string }`
- `event: exit` — `{ code: number }`
- `event: error` — `{ message: string }`

`partId` 必须在白名单内（见 `api/[[...slug]].ts` 的 `PART_RUNNERS`），不接受任意源码。

### `GET /api/health`

返回服务状态 + 环境变量是否就位。

## TODO

- [ ] preview 截图（部署后补）
- [ ] Upstash KV 替代 in-memory 限速（Vercel serverless 跨实例失效问题）
- [ ] 后续文章的 part 代码（03 工具系统、04 中间件、05 沙箱、06 Skills、07 MCP）
- [ ] 移动端布局优化（目前 md 以下分栏会变上下，体验一般）

## License

MIT
