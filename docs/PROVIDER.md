# Provider contract

Translation providers plug into the plugin via the registry in
`server/providers/index.js`. A provider is a module that exports `init` and
optionally `meta`:

```js
module.exports = {
  init({ providerOptions }) {
    return {
      async translate({ text, sourceLocale, targetLocale, format, signal, voice, glossary }) {
        // returns string[] same length and order as `text`
      },
      async usage() {
        // returns { count: number, limit: number|null, error?: string }
      },
      async estimate({ text }) {
        // optional; returns { inputTokens, estimatedOutputTokens, estimatedCostUsd?, items }
      },
    };
  },
  meta: { name: "your-provider", displayName: "Your Provider" },
};
```

## Registering

```js
// somewhere in your app's bootstrap
const providers = require("strapi-plugin-translate/server/providers");
providers.register("your-provider", require("./your-provider"));
```

Then configure the plugin to use it:

```js
// config/plugins.js
module.exports = {
  translate: {
    enabled: true,
    config: {
      provider: "your-provider",
      providerOptions: { apiKey: env("..."), ... },
    },
  },
};
```

## `translate()` semantics

- **Input**: an array of strings of length N. `format` is one of
  `"plain"`, `"html"`, or `"blocks"`. The provider MUST treat each item as a
  self-contained translation unit (do not concatenate them).
- **Output**: an array of strings of length N, in the same order. Empty,
  whitespace-only, or URL-only inputs should be passed through unchanged.
- **`signal`**: an AbortSignal. The provider MUST honor it; if aborted, throw
  an Error with `.name === "AbortError"`.
- **Errors**: throw on hard failures. Mark non-retriable errors by setting
  `err.terminal = true` so the orchestrator skips its retry loop.
- **Voice & glossary**: opaque to the orchestrator. Bake them into the system
  prompt or equivalent provider-side mechanism. `glossary.preserveExact` is a
  list of strings to keep verbatim; `glossary.perLocale[targetLocale]` is a
  `{source: target}` map of preferred mappings.

## `usage()` semantics

Returns the provider's current credit/usage snapshot. Used by the admin UI's
"OpenRouter credits" tile. Implementations that don't have a usage API should
return `{ count: 0, limit: null }`.

## `estimate()` semantics

Optional. Token/cost estimate for a batch of strings. Returns:

```js
{
  inputTokens: number,
  estimatedOutputTokens: number,
  estimatedCostUsd?: number, // omit when pricing unknown
  items: number,
}
```

When omitted, the orchestrator falls back to a generic char-based estimate.

## Bundled providers

| Name         | Provider             | Notes                                            |
| ------------ | -------------------- | ------------------------------------------------ |
| `openrouter` | OpenRouter (default) | Routes any model exposed by OpenRouter via OpenAI-compatible API. |
