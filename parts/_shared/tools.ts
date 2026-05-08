export const weatherTools = [
  {
    type: "function" as const,
    function: {
      name: "get_weather",
      description: "查询某个城市的天气",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

type ToolFn = (input: any, ctx?: { signal?: AbortSignal }) => Promise<string>;

export const weatherImpls: Record<string, ToolFn> = {
  get_weather: async ({ city }) => {
    await sleep(300);
    return `${city} 今天 25°C 晴`;
  },
};

export const racingTools = [
  weatherTools[0],
  {
    type: "function" as const,
    function: {
      name: "search_news",
      description: "搜索某个城市的本地新闻（演示用，故意慢 3 秒）",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

export const racingImpls: Record<string, ToolFn> = {
  get_weather: weatherImpls.get_weather,
  search_news: async ({ city }) => {
    await sleep(3000);
    return `${city} 今日要闻：mock 新闻数据（故意慢 3 秒，演示 Promise.race 比 Promise.all 优秀的体感）`;
  },
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
