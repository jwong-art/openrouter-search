# openrouter-search

OpenClaw tool plugin that exposes two independent OpenRouter search tools:

- `openrouter_perplexity_search`: Perplexity Sonar Pro web search for high-quality web research.
- `openrouter_x_search`: Grok native X Search for X/Twitter posts, accounts, threads, and social content.

Both tools consume OpenRouter credits and can work independently of OpenClaw's built-in `web_search`.

## Install

```bash
openclaw plugins install npm:@jwongart/openrouter-search@0.2.0
```

## Configuration

Request timeout is configured at plugin level and shared by both tools:

```json
{
  "plugins": {
    "entries": {
      "openrouter-search": {
        "config": {
          "timeout_ms": 120000
        }
      }
    }
  }
}
```

- `timeout_ms`: request timeout in milliseconds, from `15000` to `300000`. Default is `120000`.

## Tools

### openrouter_perplexity_search

Calls OpenRouter Chat Completions with `model=perplexity/sonar-pro-search`.

Inputs:

- `query` (required): search query to answer with Perplexity Sonar Pro Search.
- `search_context_size`: optional `low`, `medium`, or `high`. Default is `medium`.
- `user_location`: optional location hint with `country`, `region`, `city`, `latitude`, and `longitude`.
- `max_tokens`: optional maximum output tokens.

The plugin does not expose model sampling, reasoning, penalty, or structured-output tuning parameters for this tool; those are left to OpenRouter/model defaults.

### openrouter_x_search

Calls OpenRouter Chat Completions with `model=x-ai/grok-4.3`, the OpenRouter native web plugin, and `x_search_filter` hints so Grok uses xAI X Search for X/Twitter content.

Inputs:

- `query` (required): the X/Twitter search request. It can be a natural-language question, keyword query, handle-focused query, X URL, or post/status ID.
- `allowed_x_handles`: optional list of X handles to include, without `@`. Maximum 10 handles. Mutually exclusive with `excluded_x_handles`.
- `excluded_x_handles`: optional list of X handles to exclude, without `@`. Maximum 10 handles. Mutually exclusive with `allowed_x_handles`.
- `from_date`, `to_date`: optional date filters in `YYYY-MM-DD` format. OpenRouter/xAI X Search appears to treat `to_date` as an exclusive boundary; for a single-day search, set `to_date` to the next calendar day or omit it.
- `enable_image_understanding`, `enable_video_understanding`: optional booleans for media understanding in X posts.
- `max_results`: OpenRouter native web plugin result cap. Default is `5`.
- `max_tokens`: optional maximum output tokens.

The plugin does not expose model sampling, reasoning, or structured-output tuning parameters for this tool; those are left to OpenRouter/model defaults.

## Output

Both tools return natural-language `content` for OpenClaw plus structured `details`:

- `content`: the answer, a compact `Resources` list when sources are returned, model, usage/cost summary when available, and a billing note.
- `details.openrouterRequest`: the exact JSON body sent to OpenRouter.
- `details.openrouterResponse`: the raw OpenRouter Chat Completions response.
- `details.retryCount`: retry count for transient 429/5xx/network failures.

## API Key

The plugin reads the OpenRouter API key in this order:

1. `OPENROUTER_API_KEY` from the Gateway process environment.
2. `env.OPENROUTER_API_KEY` from `~/.openclaw/openclaw.json`.
3. `models.providers.openrouter.apiKey` from `~/.openclaw/openclaw.json`.

The API key is never returned in tool output.

## Build

```bash
npm install
npm run plugin:build
npm run plugin:validate
npm test
```

## License

MIT
