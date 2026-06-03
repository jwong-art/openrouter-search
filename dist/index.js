import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { createPerplexitySearchTool } from "./perplexity.js";
import { createXSearchTool } from "./x-search.js";
const DEFAULT_TIMEOUT_MS = 120_000;
const pluginDescription = "Provides independent OpenRouter search tools for Perplexity web search and Grok X Search. " +
    "These tools consume OpenRouter credits and can work independently of OpenClaw's built-in web_search.";
const pluginConfigSchema = Type.Object({
    timeout_ms: Type.Optional(Type.Integer({
        minimum: 15_000,
        maximum: 300_000,
        default: DEFAULT_TIMEOUT_MS,
        description: "Request timeout in milliseconds. Default is 120000, maximum is 300000.",
    })),
}, { additionalProperties: false });
export default defineToolPlugin({
    id: "openrouter-search",
    name: "@jwongart/openrouter-search",
    description: pluginDescription,
    configSchema: pluginConfigSchema,
    tools: (tool) => [createPerplexitySearchTool(tool), createXSearchTool(tool)],
});
