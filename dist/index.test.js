import { afterEach, describe, expect, it, vi } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
function registerTools() {
    const registered = [];
    entry.register({
        pluginConfig: { timeout_ms: 180000 },
        registerTool(tool) {
            registered.push(tool);
        },
    });
    return registered.map((item) => typeof item === "function" ? item({ config: { timeout_ms: 180000 }, api: {}, toolContext: {} }) : item);
}
describe("openrouter-search", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete process.env.OPENROUTER_API_KEY;
    });
    it("declares the combined OpenRouter search plugin metadata", () => {
        const metadata = getToolPluginMetadata(entry);
        expect(metadata?.id).toBe("openrouter-search");
        expect(metadata?.name).toBe("@jwongart/openrouter-search");
        expect(metadata?.description).toContain("OpenRouter search tools");
        expect(metadata?.configSchema.properties).toHaveProperty("timeout_ms");
        expect(metadata?.tools.map((tool) => tool.name)).toEqual([
            "openrouter_perplexity_search",
            "openrouter_x_search",
        ]);
        const perplexityParameters = metadata?.tools.find((tool) => tool.name === "openrouter_perplexity_search")
            ?.parameters;
        expect(perplexityParameters.properties).toHaveProperty("query");
        expect(perplexityParameters.properties.search_context_size.default).toBe("medium");
        expect(perplexityParameters.properties).not.toHaveProperty("temperature");
        expect(perplexityParameters.properties).not.toHaveProperty("top_p");
        const xParameters = metadata?.tools.find((tool) => tool.name === "openrouter_x_search")?.parameters;
        expect(xParameters.properties.allowed_x_handles.maxItems).toBe(10);
        expect(xParameters.properties.excluded_x_handles.description).toContain("Mutually exclusive");
        expect(xParameters.properties).toHaveProperty("max_tokens");
        expect(xParameters.properties).not.toHaveProperty("temperature");
        expect(xParameters.properties).not.toHaveProperty("top_p");
        expect(xParameters.properties).not.toHaveProperty("response_format");
        expect(xParameters.properties).not.toHaveProperty("reasoning");
        expect(xParameters.properties).not.toHaveProperty("include_reasoning");
    });
    it("builds a Perplexity web search request", async () => {
        process.env.OPENROUTER_API_KEY = "test-key";
        let capturedBody;
        vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
            capturedBody = JSON.parse(String(init.body));
            return new Response(JSON.stringify({
                id: "gen-perplexity-test",
                model: "perplexity/sonar-pro-search",
                choices: [
                    {
                        message: {
                            content: "Search answer.",
                            annotations: [
                                {
                                    type: "url_citation",
                                    url_citation: { url: "https://example.com/source", title: "Example Source" },
                                },
                            ],
                        },
                    },
                ],
                usage: { total_tokens: 123, cost: 0.001 },
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        }));
        const tools = registerTools();
        const tool = tools.find((candidate) => candidate.name === "openrouter_perplexity_search");
        const result = await tool.execute("test-call", {
            query: "latest OpenRouter news",
            search_context_size: "high",
            user_location: { country: "US", city: "San Francisco" },
            max_tokens: 700,
        }, AbortSignal.timeout(1000), undefined);
        expect(capturedBody).toMatchObject({
            model: "perplexity/sonar-pro-search",
            messages: [{ role: "user", content: "latest OpenRouter news" }],
            web_search_options: {
                search_context_size: "high",
                user_location: { country: "US", city: "San Francisco" },
            },
            max_tokens: 700,
        });
        expect(capturedBody).not.toHaveProperty("temperature");
        expect(capturedBody).not.toHaveProperty("top_p");
        expect(result.content[0].text).toContain("Search answer.");
        expect(result.content[0].text).toContain("Example Source");
        expect(result.details.openrouterRequest).toEqual(capturedBody);
    });
    it("builds a Grok native X Search request", async () => {
        process.env.OPENROUTER_API_KEY = "test-key";
        let capturedBody;
        vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
            capturedBody = JSON.parse(String(init.body));
            return new Response(JSON.stringify({
                id: "gen-x-test",
                model: "x-ai/grok-4.3-20260430",
                choices: [
                    {
                        message: {
                            content: "Recent X findings.",
                            tool_calls: [
                                {
                                    type: "function",
                                    function: { name: "x_keyword_search", arguments: "{\"query\":\"from:OpenRouterAI\"}" },
                                },
                            ],
                            annotations: [
                                {
                                    type: "url_citation",
                                    url_citation: { url: "https://x.com/OpenRouterAI/status/123", title: "1" },
                                },
                            ],
                        },
                    },
                ],
                usage: { total_tokens: 456, cost: 0.002 },
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        }));
        const tools = registerTools();
        const tool = tools.find((candidate) => candidate.name === "openrouter_x_search");
        const result = await tool.execute("test-call", {
            query: "OpenRouter posts",
            allowed_x_handles: ["OpenRouterAI"],
            from_date: "2026-06-01",
            enable_image_understanding: false,
            max_results: 7,
            max_tokens: 600,
        }, AbortSignal.timeout(1000), undefined);
        expect(capturedBody).toMatchObject({
            model: "x-ai/grok-4.3",
            plugins: [{ id: "web", engine: "native", max_results: 7 }],
            x_search_filter: {
                allowed_x_handles: ["OpenRouterAI"],
                from_date: "2026-06-01",
                enable_image_understanding: false,
            },
            max_tokens: 600,
        });
        expect(capturedBody).not.toHaveProperty("temperature");
        expect(capturedBody).not.toHaveProperty("top_p");
        expect(capturedBody).not.toHaveProperty("response_format");
        expect(capturedBody).not.toHaveProperty("reasoning");
        expect(capturedBody).not.toHaveProperty("include_reasoning");
        expect(capturedBody.messages[0].content).toContain("Use X/Twitter search only");
        expect(capturedBody.messages[0].content).toContain("Query: OpenRouter posts");
        expect(result.content[0].text).toContain("Recent X findings.");
        expect(result.content[0].text).toContain("Search tools: x_keyword_search");
        expect(result.details.openrouterRequest).toEqual(capturedBody);
    });
    it("rejects mutually exclusive X handle filters before calling OpenRouter", async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        const tools = registerTools();
        const tool = tools.find((candidate) => candidate.name === "openrouter_x_search");
        await expect(tool.execute("test-call", {
            query: "OpenRouter posts",
            allowed_x_handles: ["OpenRouterAI"],
            excluded_x_handles: ["xai"],
        }, AbortSignal.timeout(1000), undefined)).rejects.toThrow("allowed_x_handles and excluded_x_handles are mutually exclusive");
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
