# Provider contract

Translation providers plug into the plugin via the registry in
`server/providers/index.js`. A provider is a module that exports `init` and
optionally `meta`:

```js
export default {
  init({ providerOptions }) {
    return {
      async translate({ text, sourceLocale, targetLocale, format, signal, voice, glossary, constraints }) {
        // returns string[] same length and order as `text`
      },
      async usage() {
        // returns { count: number, limit: number|null, error?: string }
      },
      async estimate({ text }) {
        // optional; returns { inputTokens, estimatedOutputTokens, estimatedCostUsd?, items }
      },
      async fixText({ items, targetLocale, voice, signal }) {
        // optional; rewrites texts that failed CMS validation at save time.
        // items: [{ text, issue, maxLength? }] — returns string[] same length/order
      },
    };
  },
  meta: { name: "your-provider", displayName: "Your Provider" },
};
```

## Registering

The provider registry (`server/providers/index.js`) is **bundled into the
published package** — the server is compiled to a single `dist/` bundle, so the
registry is not importable as a standalone module from an installed copy, and
registering against a separately-imported copy would mutate a different registry
instance than the running server uses.

To add a provider, register it inside the plugin's own server source and
rebuild:

```js
// server/providers/index.js — alongside the bundled openrouter registration
import yourProvider from "./your-provider";
register("your-provider", yourProvider);
```

The cleanest path is to contribute the provider upstream (or maintain a fork).
Then select it via config:

```js
// config/plugins.js
export default {
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
- **`constraints`**: optional array aligned with `text`; each entry is
  `undefined` or `{ maxLength?, minLength? }` taken from the Strapi attribute
  schema. A translation that violates `maxLength` fails the entity validator at
  save time, so the provider should make the model respect the limit (the
  bundled OpenRouter provider folds it into the prompt and re-asks with
  corrective feedback when the output overshoots).

## `fixText()` semantics

Optional. The orchestrator's save-repair loop calls it when the target-locale
upsert is rejected by Strapi's entity validation on an LLM-written field —
e.g. a translated title that outgrew the schema's `maxLength`. Each item
carries the failing `text` (already in `targetLocale`), the exact validation
`issue` message, and `maxLength` when the limit could be parsed from the
message. Return the rewritten strings (same length and order) — same meaning,
same language, but satisfying the rule. Providers without `fixText` simply
surface the validation error unchanged.

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
