import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "x-ai/grok-4.3";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_X_HANDLES = 10;
const MAX_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 750;
const MAX_SOURCE_TITLE_CHARS = 240;
const MAX_SOURCE_SNIPPET_CHARS = 500;
const MAX_SOURCE_SITE_NAME_CHARS = 120;
const toolDescription = "Search X (Twitter) content through OpenRouter using Grok 4.3 native X Search. " +
    "This tool is primarily for X posts, accounts, threads, and recent social content, and it consumes OpenRouter credits. " +
    "Outputs include the raw OpenRouter response in details.openrouterResponse and usage/cost information when OpenRouter returns it.";
const pluginConfigSchema = Type.Object({
    timeout_ms: Type.Optional(Type.Integer({
        minimum: 15_000,
        maximum: 300_000,
        default: DEFAULT_TIMEOUT_MS,
        description: "Request timeout in milliseconds. Default is 120000, maximum is 300000.",
    })),
}, { additionalProperties: false });
const handle = Type.String({
    minLength: 1,
    maxLength: 15,
    pattern: "^[A-Za-z0-9_]+$",
    description: "X handle without @.",
});
const fromDateString = Type.String({
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    description: "Start date in YYYY-MM-DD format.",
});
const toDateString = Type.String({
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    description: "End date in YYYY-MM-DD format. OpenRouter/xAI X Search appears to treat to_date as an exclusive boundary; for a single-day search, set to_date to the next calendar day or omit it.",
});
const openrouterXSearchParams = Type.Object({
    query: Type.String({
        minLength: 1,
        maxLength: 4000,
        description: "X/Twitter search request. Can be natural language, keywords, an X URL, a post/status ID, or a handle-focused query.",
    }),
    allowed_x_handles: Type.Optional(Type.Array(handle, {
        maxItems: MAX_X_HANDLES,
        description: "Only search these X handles. Handles should not include @. Mutually exclusive with excluded_x_handles.",
    })),
    excluded_x_handles: Type.Optional(Type.Array(handle, {
        maxItems: MAX_X_HANDLES,
        description: "Exclude these X handles. Handles should not include @. Mutually exclusive with allowed_x_handles.",
    })),
    from_date: Type.Optional(fromDateString),
    to_date: Type.Optional(toDateString),
    enable_image_understanding: Type.Optional(Type.Boolean({ description: "Ask xAI X Search to understand images attached to X posts when supported." })),
    enable_video_understanding: Type.Optional(Type.Boolean({ description: "Ask xAI X Search to understand videos attached to X posts when supported." })),
    max_results: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 20,
        default: DEFAULT_MAX_RESULTS,
        description: "Maximum native search results requested through OpenRouter's web plugin.",
    })),
    max_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 8000 })),
}, { additionalProperties: false });
function stripJsonc(text) {
    let output = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        const next = text[i + 1];
        if (inString) {
            output += char;
            if (escaped)
                escaped = false;
            else if (char === "\\")
                escaped = true;
            else if (char === "\"")
                inString = false;
            continue;
        }
        if (char === "\"") {
            inString = true;
            output += char;
            continue;
        }
        if (char === "/" && next === "/") {
            i += 2;
            while (i < text.length && !["\n", "\r"].includes(text[i]))
                i += 1;
            output += text[i] ?? "";
            continue;
        }
        if (char === "/" && next === "*") {
            i += 2;
            while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/"))
                i += 1;
            i += 1;
            continue;
        }
        output += char;
    }
    return output.replace(/,\s*([}\]])/g, "$1");
}
function readOpenClawConfig() {
    const configPath = process.env.OPENCLAW_CONFIG ?? path.join(os.homedir(), ".openclaw", "openclaw.json");
    if (!fs.existsSync(configPath))
        return {};
    const text = fs.readFileSync(configPath, "utf8");
    return JSON.parse(stripJsonc(text));
}
function readNestedString(value, pathParts) {
    let current = value;
    for (const part of pathParts) {
        if (!current || typeof current !== "object" || !(part in current))
            return undefined;
        current = current[part];
    }
    return typeof current === "string" && current.trim() ? current.trim() : undefined;
}
function resolveOpenRouterApiKey() {
    const envKey = process.env.OPENROUTER_API_KEY?.trim();
    if (envKey)
        return envKey;
    const config = readOpenClawConfig();
    const configEnvKey = readNestedString(config, ["env", "OPENROUTER_API_KEY"]);
    if (configEnvKey)
        return configEnvKey;
    const providerKey = readNestedString(config, ["models", "providers", "openrouter", "apiKey"]);
    if (providerKey)
        return providerKey;
    throw new Error("OpenRouter API key not found. Set OPENROUTER_API_KEY in the OpenClaw environment or in ~/.openclaw/openclaw.json env.OPENROUTER_API_KEY.");
}
function sleep(ms, signal) {
    if (signal?.aborted)
        return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(signal.reason);
        }, { once: true });
    });
}
function isAbortLikeError(error) {
    return ((error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) ||
        (typeof DOMException !== "undefined" &&
            error instanceof DOMException &&
            (error.name === "AbortError" || error.name === "TimeoutError")));
}
function parseResponseText(responseText) {
    try {
        return JSON.parse(responseText);
    }
    catch {
        return { text: responseText };
    }
}
function normalizeContent(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
            if (typeof part === "string")
                return part;
            if (part && typeof part === "object") {
                const text = part.text;
                if (typeof text === "string")
                    return text;
            }
            return "";
        })
            .filter(Boolean)
            .join("\n");
    }
    return "";
}
function collapseWhitespace(value) {
    return value.replace(/\s+/gu, " ").trim();
}
function truncateText(value, maxChars) {
    const normalized = collapseWhitespace(value);
    if (normalized.length <= maxChars)
        return normalized;
    return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
function readStringField(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return undefined;
}
function resolveSiteName(url) {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./u, "");
        return hostname || undefined;
    }
    catch {
        return undefined;
    }
}
function isMeaningfulTitle(title, url) {
    if (!title)
        return false;
    const normalized = collapseWhitespace(title);
    if (!normalized || /^\d+$/u.test(normalized))
        return false;
    return normalized !== url;
}
function extractCitations(message, rawResponse) {
    const citations = [];
    const addCitation = (url, title, startIndex, endIndex) => {
        if (typeof url !== "string" || !url.trim())
            return;
        const normalizedUrl = url.trim();
        const normalizedTitle = typeof title === "string" && isMeaningfulTitle(title, normalizedUrl) ? title.trim() : undefined;
        citations.push({
            url: normalizedUrl,
            ...(normalizedTitle ? { title: normalizedTitle } : {}),
            ...(typeof startIndex === "number" ? { startIndex } : {}),
            ...(typeof endIndex === "number" ? { endIndex } : {}),
        });
    };
    if (Array.isArray(message.citations)) {
        for (const citation of message.citations) {
            if (typeof citation === "string")
                addCitation(citation);
            else if (citation && typeof citation === "object") {
                const record = citation;
                addCitation(record.url, record.title);
            }
        }
    }
    if (Array.isArray(message.annotations)) {
        for (const annotation of message.annotations) {
            if (!annotation || typeof annotation !== "object")
                continue;
            const record = annotation;
            if (record.type === "url_citation") {
                const nested = record.url_citation;
                if (nested && typeof nested === "object") {
                    const citation = nested;
                    addCitation(citation.url, citation.title, citation.start_index, citation.end_index);
                }
                else {
                    addCitation(record.url, record.title, record.start_index, record.end_index);
                }
            }
        }
    }
    const topLevelCitations = rawResponse.citations;
    if (Array.isArray(topLevelCitations)) {
        for (const citation of topLevelCitations) {
            if (typeof citation === "string")
                addCitation(citation);
            else if (citation && typeof citation === "object") {
                const record = citation;
                addCitation(record.url, record.title);
            }
        }
    }
    const seen = new Set();
    return citations.filter((citation) => {
        if (seen.has(citation.url))
            return false;
        seen.add(citation.url);
        return true;
    });
}
function extractDetailedSources(message, rawResponse) {
    const sources = [];
    const addSource = (source) => {
        if (!source.url.trim())
            return;
        sources.push({
            url: source.url.trim(),
            ...(source.title ? { title: truncateText(source.title, MAX_SOURCE_TITLE_CHARS) } : {}),
            ...(source.snippet ? { snippet: truncateText(source.snippet, MAX_SOURCE_SNIPPET_CHARS) } : {}),
            ...(source.siteName ? { siteName: truncateText(source.siteName, MAX_SOURCE_SITE_NAME_CHARS) } : {}),
        });
    };
    if (Array.isArray(rawResponse.search_results)) {
        for (const item of rawResponse.search_results) {
            if (!item || typeof item !== "object" || Array.isArray(item))
                continue;
            const record = item;
            const url = readStringField(record, ["url", "link"]);
            if (!url)
                continue;
            const title = readStringField(record, ["title", "name"]);
            addSource({
                url,
                title: isMeaningfulTitle(title, url) ? title : undefined,
                snippet: readStringField(record, ["snippet", "content", "text", "description"]),
                siteName: readStringField(record, ["siteName", "site_name", "source", "domain"]) ?? resolveSiteName(url),
            });
        }
    }
    for (const citation of extractCitations(message, rawResponse)) {
        addSource({
            url: citation.url,
            title: citation.title,
            siteName: resolveSiteName(citation.url),
        });
    }
    const seen = new Set();
    return sources.filter((source) => {
        if (seen.has(source.url))
            return false;
        seen.add(source.url);
        return true;
    });
}
function getAssistantMessage(rawResponse) {
    const choices = rawResponse.choices;
    const firstChoice = Array.isArray(choices) && choices[0] && typeof choices[0] === "object"
        ? choices[0]
        : {};
    return firstChoice.message && typeof firstChoice.message === "object"
        ? firstChoice.message
        : {};
}
function extractToolCallNames(message) {
    if (!Array.isArray(message.tool_calls))
        return [];
    const names = [];
    for (const toolCall of message.tool_calls) {
        if (!toolCall || typeof toolCall !== "object")
            continue;
        const record = toolCall;
        const nested = record.function;
        const name = nested && typeof nested === "object" ? nested.name : record.name;
        if (typeof name === "string" && name.trim())
            names.push(name.trim());
    }
    return [...new Set(names)];
}
function readNumber(record, key) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
function formatInteger(value) {
    return Math.round(value).toLocaleString("en-US");
}
function formatCost(value) {
    const formatted = value.toFixed(8).replace(/0+$/u, "").replace(/\.$/u, "");
    return `$${formatted || "0"}`;
}
function formatUsage(rawResponse) {
    const usage = rawResponse.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage))
        return [];
    const usageRecord = usage;
    const promptTokens = readNumber(usageRecord, "prompt_tokens");
    const completionTokens = readNumber(usageRecord, "completion_tokens");
    const totalTokens = readNumber(usageRecord, "total_tokens");
    const cost = readNumber(usageRecord, "cost") ??
        readNumber(usageRecord, "total_cost") ??
        readNumber(usageRecord, "estimated_cost");
    const lines = [];
    if (promptTokens !== undefined && completionTokens !== undefined && totalTokens !== undefined) {
        lines.push(`Usage: ${formatInteger(promptTokens)} prompt + ${formatInteger(completionTokens)} completion = ${formatInteger(totalTokens)} tokens`);
    }
    else if (totalTokens !== undefined) {
        lines.push(`Usage: ${formatInteger(totalTokens)} tokens`);
    }
    if (cost !== undefined)
        lines.push(`Estimated cost: ${formatCost(cost)}`);
    return lines;
}
function formatToolText(rawResponse) {
    const message = getAssistantMessage(rawResponse);
    const model = typeof rawResponse.model === "string" ? rawResponse.model : DEFAULT_MODEL;
    const answer = normalizeContent(message.content);
    const sources = extractDetailedSources(message, rawResponse);
    const toolCallNames = extractToolCallNames(message);
    const lines = [answer.trim() || "(No answer text returned.)"];
    if (sources.length) {
        lines.push("", "Resources:");
        sources.forEach((source, index) => {
            if (source.title) {
                lines.push(`${index + 1}. ${source.title}`);
                lines.push(`   ${source.url}`);
            }
            else if (source.snippet && source.siteName) {
                lines.push(`${index + 1}. ${source.siteName}`);
                lines.push(`   ${source.url}`);
            }
            else {
                lines.push(`${index + 1}. ${source.url}`);
            }
            if (source.snippet)
                lines.push(`   ${source.snippet}`);
        });
    }
    if (toolCallNames.length)
        lines.push("", `Search tools: ${toolCallNames.join(", ")}`);
    lines.push("", `Model: ${model}`);
    const usageLines = formatUsage(rawResponse);
    if (usageLines.length)
        lines.push(...usageLines);
    lines.push("Billing: This tool consumes OpenRouter credits.");
    return lines.join("\n");
}
function cleanStringArray(values) {
    if (!values?.length)
        return undefined;
    const cleaned = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
    return cleaned.length ? cleaned : undefined;
}
function buildXSearchFilter(params) {
    const filter = {};
    const allowed = cleanStringArray(params.allowed_x_handles);
    const excluded = cleanStringArray(params.excluded_x_handles);
    if (allowed && allowed.length > MAX_X_HANDLES) {
        throw new Error(`allowed_x_handles supports at most ${MAX_X_HANDLES} handles for OpenRouter x_search_filter.`);
    }
    if (excluded && excluded.length > MAX_X_HANDLES) {
        throw new Error(`excluded_x_handles supports at most ${MAX_X_HANDLES} handles for OpenRouter x_search_filter.`);
    }
    if (allowed && excluded) {
        throw new Error("allowed_x_handles and excluded_x_handles are mutually exclusive for OpenRouter x_search_filter.");
    }
    if (allowed)
        filter.allowed_x_handles = allowed;
    if (excluded)
        filter.excluded_x_handles = excluded;
    if (params.from_date)
        filter.from_date = params.from_date;
    if (params.to_date)
        filter.to_date = params.to_date;
    if (params.enable_image_understanding !== undefined)
        filter.enable_image_understanding = params.enable_image_understanding;
    if (params.enable_video_understanding !== undefined)
        filter.enable_video_understanding = params.enable_video_understanding;
    return Object.keys(filter).length ? filter : undefined;
}
function buildPrompt(params) {
    const constraints = [
        "Use X/Twitter search only. Do not use ordinary webpages or general web results.",
        "Return concise findings with post dates, handles, and X URLs whenever available.",
        "If the query is an X URL or status ID, fetch that post/thread directly.",
    ];
    const handleHints = [];
    if (params.allowed_x_handles?.length)
        handleHints.push(`Allowed handles: ${params.allowed_x_handles.join(", ")}`);
    if (params.excluded_x_handles?.length)
        handleHints.push(`Excluded handles: ${params.excluded_x_handles.join(", ")}`);
    if (params.from_date)
        handleHints.push(`From date: ${params.from_date}`);
    if (params.to_date)
        handleHints.push(`To date: ${params.to_date}`);
    return [...constraints, ...handleHints, "", `Query: ${params.query}`].join("\n");
}
function buildOpenRouterRequest(params) {
    const xSearchFilter = buildXSearchFilter(params);
    const body = {
        model: DEFAULT_MODEL,
        messages: [{ role: "user", content: buildPrompt(params) }],
        plugins: [
            {
                id: "web",
                engine: "native",
                max_results: params.max_results ?? DEFAULT_MAX_RESULTS,
            },
        ],
    };
    if (xSearchFilter)
        body.x_search_filter = xSearchFilter;
    if (params.max_tokens !== undefined)
        body.max_tokens = params.max_tokens;
    return body;
}
function resolveTimeoutMs(config) {
    return config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
}
async function callOpenRouterXSearch(params, config, signal) {
    const body = buildOpenRouterRequest(params);
    const timeoutSignal = AbortSignal.timeout(resolveTimeoutMs(config));
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    let responseText = "";
    let rawResponse = {};
    let attempt = 0;
    for (; attempt <= MAX_RETRIES; attempt += 1) {
        try {
            response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${resolveOpenRouterApiKey()}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://openclaw.local/",
                    "X-Title": "OpenClaw Independent OpenRouter X Search",
                },
                body: JSON.stringify(body),
                signal: requestSignal,
            });
            responseText = await response.text();
            rawResponse = parseResponseText(responseText);
            if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt >= MAX_RETRIES)
                break;
        }
        catch (error) {
            if (isAbortLikeError(error) || attempt >= MAX_RETRIES)
                throw error;
        }
        await sleep(RETRY_BASE_DELAY_MS * (attempt + 1), requestSignal);
    }
    if (!response)
        throw new Error("OpenRouter X Search failed: no response returned.");
    if (!response.ok) {
        const message = readNestedString(rawResponse, ["error", "message"]) ??
            readNestedString(rawResponse, ["message"]) ??
            responseText.slice(0, 1000);
        throw new Error(`OpenRouter X Search failed after ${attempt + 1} attempt(s): HTTP ${response.status} ${message}`);
    }
    return {
        request: body,
        response: rawResponse,
        retryCount: attempt,
    };
}
export function createXSearchTool(tool) {
    return tool({
        name: "openrouter_x_search",
        label: "OpenRouter X Search",
        description: toolDescription,
        parameters: openrouterXSearchParams,
        factory: (context) => ({
            name: "openrouter_x_search",
            label: "OpenRouter X Search",
            description: toolDescription,
            parameters: openrouterXSearchParams,
            execute: async (_toolCallId, params, signal) => {
                const result = await callOpenRouterXSearch(params, context.config, signal);
                return {
                    content: [
                        {
                            type: "text",
                            text: formatToolText(result.response),
                        },
                    ],
                    details: {
                        ok: true,
                        provider: "openrouter",
                        endpoint: OPENROUTER_CHAT_COMPLETIONS_URL,
                        retryCount: result.retryCount,
                        openrouterRequest: result.request,
                        openrouterResponse: result.response,
                    },
                };
            },
        }),
    });
}
