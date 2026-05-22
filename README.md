# strapi-plugin-translate

AI-powered translation of localized Strapi v5 entries via [OpenRouter](https://openrouter.ai) LLMs. Walks the schema of a content type, sends every translatable string through an LLM in concurrent chunks, and writes the result back into the target locale of the same document.

## Features

- **Document Action** in the Edit View — one click to translate the current entry into one or many target locales.
- **Schema-aware walker** — handles components, dynamic zones, repeatable components, Strapi blocks (rich-text JSON), and CKEditor HTML.
- **Format-aware prompts** — preserves Markdown, HTML, and Strapi-blocks structure exactly; translates only human-readable text nodes.
- **Multi-locale batches** — pick several targets at once; they're processed sequentially with a live progress bar.
- **Cancellable jobs** — abort in-flight translations from the UI.
- **Voice & glossary** — admin-editable tonality instructions, plus a per-locale glossary and a preserve-exactly list (brand/place names).
- **Stale-relation preflight** — verifies relations/media exist before burning LLM tokens; surfaces dangling refs as warnings instead of aborting.
- **OpenRouter** — uses OpenRouter's OpenAI-compatible API with structured JSON outputs and built-in model fallback.

## Requirements

- Strapi v5 (`@strapi/strapi` ^5.0.0)
- Node.js 18+
- An [OpenRouter](https://openrouter.ai) API key
- The `@strapi/plugin-i18n` plugin enabled (this plugin reads locales from it)

## Installation

```bash
npm install strapi-plugin-translate
# or
yarn add strapi-plugin-translate
# or
bun add strapi-plugin-translate
```

## Configuration

Enable and configure the plugin in `config/plugins.js`:

```js
module.exports = ({ env }) => ({
  translate: {
    enabled: true,
    config: {
      provider: "openrouter",
      providerOptions: {
        apiKey: env("OPENROUTER_API_KEY"),
        model: env("OPENROUTER_MODEL", "anthropic/claude-sonnet-4.6"),
        // OpenRouter required attribution headers
        siteUrl: env("PUBLIC_URL", "https://your-site.example"),
        siteName: "Your Site CMS",
        // Hard cap for safety. Lower this if you see finish_reason=length truncation.
        maxOutputTokens: 8000,
        // Optional fallback models if the primary is unavailable (OpenRouter feature)
        fallbackModels: [],
      },
      settings: {
        // Source locale used when the request doesn't specify one
        sourceLocale: "de",
        // Voice/tone steering injected into the system prompt
        voice:
          "Warm, inviting copy. Keep tone natural to the target language — " +
          "do not translate literally. Maintain identical HTML structure and URLs.",
        // Optional path to a default glossary file (relative to project root, or absolute)
        glossaryPath: "./config/translate-glossary.json",
        // Per-request safety
        maxInputCharsPerChunk: 12000,
        // Per-format provider call concurrency. Each format group
        // (plain / html / blocks) runs this many requests in parallel.
        maxConcurrentChunks: 10,
        // Send each translatable field as its own LLM request. Defaults true —
        // safest mode for entries with many fields. Set false to batch up to
        // maxInputCharsPerChunk per request.
        perItemChunks: true,
      },
    },
  },
});
```

### Environment variables

```
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=anthropic/claude-sonnet-4.6   # optional, has default
PUBLIC_URL=https://your-site.example          # used for OpenRouter attribution
```

## Marking fields as translatable

The plugin walks the schema and looks for a `pluginOptions.translate.translate` directive on each attribute. Set it via the Content-Type Builder (advanced settings → "Translate" directive) or by editing the schema JSON directly:

```json
{
  "kind": "collectionType",
  "attributes": {
    "title": {
      "type": "string",
      "pluginOptions": { "translate": { "translate": "translate" } }
    },
    "slug": {
      "type": "uid",
      "pluginOptions": { "translate": { "translate": "copy" } }
    },
    "createdBy": {
      "type": "relation",
      "pluginOptions": { "translate": { "translate": "skip" } }
    }
  }
}
```

### Directives

| Directive    | Behavior                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `translate`  | Send the value through the LLM. Use for strings, text, richtext, blocks.                          |
| `copy`       | Copy the value verbatim. Default for non-translatable scalars (numbers, dates, enums).            |
| `skip`       | Don't write the field at all. Use for relations/media that shouldn't be re-linked automatically.  |
| `delete`     | Set the field to `null` on the target locale.                                                     |
| `regenerate` | Don't write the field; let a lifecycle hook re-derive it. Use for `uid` slugs.                    |

`uid`-typed fields marked `translate` are coerced to `regenerate` automatically (translating a slug breaks URL routing). If you want a uid field copied verbatim, set its directive to `copy` explicitly.

Numbers, dates, booleans, and enums are always copied (never sent to the LLM) regardless of directive.

Components and dynamic zones default to `translate` (recurse) — inner fields still default to `skip` unless individually marked, so nothing leaks accidentally.

## How it works

```
POST /translate/document   { uid, documentId, sourceLocale, targetLocales }
  -> 202 { jobId }                          # fire-and-forget
GET  /translate/jobs/:id                    # poll for progress
POST /translate/jobs/:id/cancel             # abort
```

For each document the plugin:

1. **Fetches** the source entry with a deep populate over components, dynamic zones, and media.
2. **Walks** the schema collecting translatable strings grouped by format (plain / html / blocks) and records where each translation should go in the target tree.
3. **Preflights** every relation/media reference (one query per target table). Stale refs are stripped from the payload and reported as warnings.
4. **Chunks** strings within a char budget and **calls the provider** concurrently per format group.
5. **Applies** translations back into a fresh data tree and **upserts** via the Document Service API.

Each provider call uses [JSON Schema structured outputs](https://openrouter.ai/docs#models/parameters) so the response is guaranteed to be `{ translations: string[] }` with the same length and order as the input. Three retry attempts with exponential backoff handle transient blips; "terminal" causes (output truncated, refusal, content filter) fail fast without burning further attempts.

## Settings page

The admin Settings → Translate page lets editors tune:

- **Voice & tone** — free-form instructions baked into the system prompt.
- **Preserve exactly** — terms kept verbatim across all locales (brand names, places, products).
- **Per-locale glossary** — preferred target phrasings for ambiguous source terms.

Edits are stored in `strapi.store` and picked up on the next translation job. "Reset to defaults" restores the values from `config/plugins.js` (voice) and the `glossaryPath` file.

## Supported locales

The plugin reads locales from `@strapi/plugin-i18n` at request time — whatever locales you enable in `Settings → Internationalization` become valid targets. No code change required to add a locale. (If the i18n plugin is unavailable, a small fallback set is used so the plugin still loads.)

## Glossary file

Optional. JSON shape:

```json
{
  "preserveExact": ["Hinterland Camp", "Bregenzerwald"],
  "perLocale": {
    "en": { "Motorhome Pitches": "Private Campsites" },
    "fr": {}
  }
}
```

`preserveExact` entries become a "do not translate" list in the system prompt. `perLocale` entries become "prefer this mapping" instructions for the matching target.

## API endpoints

All routes are admin-scoped (require an authenticated admin user).

| Method | Path                              | Description                                              |
| ------ | --------------------------------- | -------------------------------------------------------- |
| POST   | `/translate/document`             | Start a translation job (returns jobId)                  |
| POST   | `/translate/bulk`                 | Translate many documents of one CT at once               |
| POST   | `/translate/estimate`             | Token + cost estimate (no provider calls billed)         |
| POST   | `/translate/preview`              | Translate but stage for review                           |
| GET    | `/translate/preview/:id`          | Read a staged preview                                    |
| POST   | `/translate/preview/:id/accept`   | Apply a staged preview                                   |
| POST   | `/translate/preview/:id/discard`  | Drop a staged preview                                    |
| GET    | `/translate/jobs/:id`             | Poll job status                                          |
| POST   | `/translate/jobs/:id/cancel`      | Cancel a job                                             |
| GET    | `/translate/usage`                | OpenRouter credit usage                                  |
| GET    | `/translate/locales`              | Locales from `@strapi/plugin-i18n`                       |
| GET    | `/translate/settings`             | Voice + glossary                                         |
| PUT    | `/translate/settings`             | Save voice + glossary                                    |
| POST   | `/translate/settings/reset`       | Reset to register-time defaults                          |
| GET    | `/translate/cache/stats`          | Translation memory cache size and age                    |
| DELETE | `/translate/cache`                | Clear the translation memory cache                       |

## Translation memory cache

Strings already translated for a `(source, target, voice, glossary)` tuple are persisted in `strapi.store` and skipped on subsequent runs. Editing the glossary invalidates the relevant entries automatically (glossary fingerprint is baked into the cache key). Disable with `cache: { enabled: false }` in plugin settings, or clear via the admin Settings page.

## Auto-translate (opt-in)

Wire automatic propagation from a source locale to target locales on publish or update:

```js
// config/plugins.js
module.exports = ({ env }) => ({
  translate: {
    enabled: true,
    config: {
      // ...provider/settings as above
      autoTranslate: {
        enabled: true,
        rules: [
          {
            uid: "api::page.page",
            sourceLocale: "de",
            targetLocales: ["en", "fr"],
            on: "publish",   // "publish" | "update"
          },
        ],
      },
    },
  },
});
```

Auto-jobs are flagged `source: "auto"` on the job snapshot for observability.

## Preview / review before save

Pass `Preview translation` from the document action modal to stage a translation. The plugin runs the full pipeline but stops before the upsert; the proposed payload + a structural diff are returned for an editor to accept or discard. Previews TTL after 1 hour.

## Provider registry

The plugin ships with the `openrouter` provider. To add another (DeepL, Anthropic direct, Google Translate, etc.) implement the contract in `docs/PROVIDER.md` and call:

```js
const providers = require("strapi-plugin-translate/server/providers");
providers.register("your-provider", require("./your-provider"));
```

## Testing

```
npm test          # vitest
npm run verify    # plugin loads + tests
npm run typecheck # tsc --noEmit (JSDoc-level)
```

## License

MIT
