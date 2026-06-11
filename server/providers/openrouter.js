// OpenRouter provider for the translate plugin.
//
// OpenRouter exposes an OpenAI-compatible Chat Completions API at
// https://openrouter.ai/api/v1, so we use the `openai` npm SDK pointed at it.
// We use structured outputs (response_format: json_schema, strict: true) to
// guarantee a JSON shape we can parse, and pass `models` for OpenRouter's
// built-in fallback feature when the primary model is unavailable.
//
// Provider interface (mirrors Fekide's plugin contract):
//   provider.translate({ text, sourceLocale, targetLocale, format })
//     -> Promise<string[]>     same length as input, same order
//   provider.usage()
//     -> Promise<{ count, limit }>

// openai v4 supports both `require("openai")` and `require("openai").OpenAI`.
// We use the named export so tests can mock cleanly via `vi.mock("openai", ...)`.
import { OpenAI } from "openai";

import formatFactory from "../services/format";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Provider errors carry custom flags that the orchestrator's retry loop
 * inspects. `terminal: true` means "don't retry — the cause is permanent
 * (truncation, refusal, content filter)". `response` carries the upstream
 * response for diagnostic logging. `correctable` is set when output
 * validation fails in a way the model can fix (HTML structure mismatch,
 * length-constraint violation); the retry loop reads it to replay the
 * request with the failed output + corrective feedback appended.
 *
 * @typedef {{ index: number, kind: "html" | "length", summary: string }} CorrectableFailure
 *
 * @typedef {Error & {
 *   terminal?: boolean,
 *   response?: any,
 *   correctable?: { rawAssistantContent: string, failures: CorrectableFailure[] },
 * }} ProviderError
 */

const makeAbortError = () => {
  const e = new Error("[translate] aborted");
  e.name = "AbortError";
  return e;
};

const sleepWithBackoff = (attempt, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(makeAbortError());
    // attempt is 1-indexed: after attempt 1 sleep ~1s, after attempt 2 sleep ~2s.
    const base = 1000 * Math.pow(2, attempt - 1);
    const jitter = base * (Math.random() * 0.4 - 0.2);
    const ms = Math.max(0, Math.round(base + jitter));
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });

const getLogger = () =>
  global.strapi?.log || {
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };

// Per-item schema length limits (Strapi attribute minLength/maxLength),
// rendered into the prompt so the model rephrases to fit instead of
// producing a translation the CMS will reject at save time.
const buildConstraintsBlock = (constraints) => {
  if (!Array.isArray(constraints)) return "";
  const lines = [];
  constraints.forEach((c, i) => {
    if (!c) return;
    const parts = [];
    if (typeof c.maxLength === "number") parts.push(`at most ${c.maxLength} characters`);
    if (typeof c.minLength === "number") parts.push(`at least ${c.minLength} characters`);
    if (parts.length > 0) lines.push(`- inputs[${i}] must be ${parts.join(" and ")}`);
  });
  if (lines.length === 0) return "";
  return [
    "\nLength constraints (hard limits enforced by the CMS — count characters, not words):",
    ...lines,
    "If a literal translation would break a limit, rephrase with shorter synonyms or drop non-essential words while keeping the meaning. Never truncate mid-word or cut information arbitrarily.",
  ].join("\n");
};

const buildSystemPrompt = ({
  sourceLocale,
  targetLocale,
  format,
  voice,
  glossary,
  constraints,
}) => {
  const preserveList = (glossary && glossary.preserveExact) || [];
  const perLocaleMap =
    (glossary && glossary.perLocale && glossary.perLocale[targetLocale]) || {};

  const formatRules =
    format === "html"
      ? [
          "Each input string is HTML.",
          "Preserve all tags, attributes, classes, and URLs EXACTLY.",
          "Translate only human-readable text nodes.",
          "Do not add, remove, reorder, or rename any tag or attribute.",
        ].join(" ")
      : format === "blocks"
        ? [
            "Each input string is a JSON node serialized as text.",
            "Preserve all keys and structure exactly. Translate only string values that are human-readable.",
          ].join(" ")
        : [
            "Each input string is plain text that may contain Markdown formatting.",
            "If Markdown syntax is present, preserve it EXACTLY — including but not limited to:",
            "**bold**, __bold__, *italics*, _italics_, ~~strikethrough~~, `inline code`,",
            "[link text](url) and ![alt](url) (translate the visible text/alt, never the URL),",
            "# / ## / ### headings, > blockquotes, - / * / 1. list markers (and their indentation),",
            "fenced ``` code blocks (do NOT translate code body), and horizontal --- rules.",
            "Do not add Markdown that was not in the source. Do not strip Markdown that was.",
            "Preserve leading/trailing whitespace and newline placement so list structures stay intact.",
          ].join(" ");

  const preserveBlock = preserveList.length
    ? `\nDo NOT translate the following exact terms (keep them verbatim, including capitalization):\n${preserveList
        .map((t) => `- ${t}`)
        .join("\n")}`
    : "";

  const perLocaleBlock = Object.keys(perLocaleMap).length
    ? `\nWhen translating to ${targetLocale}, prefer these mappings when applicable:\n${Object.entries(
        perLocaleMap
      )
        .map(([k, v]) => `- "${k}" -> "${v}"`)
        .join("\n")}`
    : "";

  return [
    `You are a professional translator translating from ${sourceLocale} to ${targetLocale}.`,
    voice || "",
    formatRules,
    "",
    "Rules:",
    "- Output JSON exactly matching the schema: { translations: string[] }.",
    "- The translations array MUST have the same length as the input inputs array, in the same order.",
    "- If a string is empty, whitespace-only, a number, or a URL, return it unchanged.",
    "- Do NOT translate proper nouns, place names, or URLs.",
    "- Do NOT add explanations, prefixes, suffixes, or wrap output in code fences.",
    preserveBlock,
    perLocaleBlock,
    buildConstraintsBlock(constraints),
  ]
    .filter(Boolean)
    .join("\n");
};

// Defensive validation: array shape + structural HTML check.
// We delegate the HTML side to format.validateHtmlShape so there's one
// implementation. format service is lazily resolved because the provider
// can be init'd before the plugin is fully wired (e.g. in tests).
const resolveFormatService = () => {
  if (global.strapi?.plugin) {
    try {
      const svc = global.strapi.plugin("translate")?.service?.("format");
      if (svc) return svc;
    } catch {
      /* fall through to local fallback */
    }
  }
  // Local fallback used in tests and at register-time before services
  // are mounted. Re-uses the same module as the wired service.
  return formatFactory();
};

// Per-item length-constraint check, used by both translate() and fixText().
// Returns CorrectableFailure entries for the corrective retry loop.
const describeLengthFailures = (output, constraints) => {
  if (!Array.isArray(constraints)) return [];
  const failures = [];
  for (let i = 0; i < output.length; i++) {
    const c = constraints[i];
    if (!c || typeof output[i] !== "string") continue;
    const len = output[i].length;
    if (typeof c.maxLength === "number" && len > c.maxLength) {
      failures.push({
        index: i,
        kind: "length",
        summary: `is ${len} characters but must be at most ${c.maxLength} — rephrase it shorter while keeping the meaning`,
      });
    } else if (typeof c.minLength === "number" && len < c.minLength) {
      failures.push({
        index: i,
        kind: "length",
        summary: `is ${len} characters but must be at least ${c.minLength}`,
      });
    }
  }
  return failures;
};

const validateShape = (input, output, format, rawAssistantContent, constraints) => {
  if (!Array.isArray(output)) {
    throw new Error("translation output is not an array");
  }
  if (output.length !== input.length) {
    throw new Error(
      `translation length mismatch: expected ${input.length}, got ${output.length}`
    );
  }
  const failures = [];
  if (format === "html") {
    const fmt = resolveFormatService();
    for (let i = 0; i < input.length; i++) {
      const mismatch = fmt.describeHtmlMismatch(input[i], output[i]);
      if (mismatch) failures.push({ index: i, kind: "html", summary: mismatch.summary });
    }
  }
  failures.push(...describeLengthFailures(output, constraints));
  if (failures.length > 0) {
    const summary = failures
      .map((f) => `item ${f.index}: ${f.summary}`)
      .join("; ");
    /** @type {ProviderError} */
    const e = new Error(`translation validation failed — ${summary}`);
    // Attach the raw model output + structured failure detail so the retry
    // loop can replay the request with corrective feedback.
    e.correctable = { rawAssistantContent, failures };
    throw e;
  }
};

const buildCorrectionPrompt = (failures) => {
  const lines = failures
    .map((f) => `- Item ${f.index}: ${f.summary}`)
    .join("\n");
  const guidance = [];
  if (failures.some((f) => f.kind === "html")) {
    guidance.push(
      "Translate every text node, but preserve every tag from the source EXACTLY —",
      "do not merge, drop, or rename any <strong>, <em>, <a>, or other inline tag."
    );
  }
  if (failures.some((f) => f.kind === "length")) {
    guidance.push(
      "Where a length limit is violated, rewrite with shorter synonyms or drop",
      "non-essential words so the text fits — never truncate mid-word or cut meaning."
    );
  }
  return [
    "Your previous response had issues that must be fixed:",
    lines,
    "",
    "Re-emit the full translations array in the same order and length,",
    "keeping items that had no issue unchanged.",
    ...guidance,
  ].join("\n");
};

// Shared response unwrapping for translate() and fixText(): surfaces
// OpenRouter routing errors and cause-specific terminal failures, returns
// the raw assistant content string otherwise.
const extractContent = (response) => {
  // OpenRouter routing error shape: `error` field on the response body.
  if (response?.error) {
    const msg = response.error.message || JSON.stringify(response.error);
    /** @type {ProviderError} */
    const e = new Error(`[translate] OpenRouter error: ${msg}`);
    e.terminal = true;
    throw e;
  }

  const choice = response?.choices?.[0];
  const finishReason = choice?.finish_reason;
  const refusal = choice?.message?.refusal;
  const content = choice?.message?.content;

  if (!content) {
    // Cause-specific terminal errors — retrying won't help.
    if (finishReason === "length") {
      /** @type {ProviderError} */
      const e = new Error(
        "[translate] output truncated (finish_reason=length) — reduce maxInputCharsPerChunk or increase maxOutputTokens"
      );
      e.terminal = true;
      e.response = response;
      throw e;
    }
    if (refusal) {
      /** @type {ProviderError} */
      const e = new Error(`[translate] model refused: ${refusal}`);
      e.terminal = true;
      e.response = response;
      throw e;
    }
    if (finishReason === "content_filter") {
      /** @type {ProviderError} */
      const e = new Error(
        "[translate] response filtered by content moderation"
      );
      e.terminal = true;
      e.response = response;
      throw e;
    }
    // Otherwise: truly empty with no signal — likely transient, retry.
    /** @type {ProviderError} */
    const e = new Error("[translate] empty response from OpenRouter");
    e.response = response;
    throw e;
  }
  return content;
};

const parseJsonContent = (content, response) => {
  try {
    return JSON.parse(content);
  } catch (err) {
    /** @type {ProviderError} */
    const e = new Error(
      `[translate] could not parse JSON response: ${err.message}\nRaw: ${String(content).slice(0, 500)}`
    );
    e.response = response;
    throw e;
  }
};

const init = ({ providerOptions, clientFactory }) => {
  const {
    apiKey,
    model,
    siteUrl,
    siteName,
    fallbackModels = [],
    maxOutputTokens = 8000,
  } = providerOptions;

  // `clientFactory` is the injectable seam used by tests; production callers
  // skip it and we instantiate the real SDK.
  const makeClient = clientFactory || ((opts) => new OpenAI(opts));
  const client = makeClient({
    apiKey: apiKey || "missing",
    baseURL: OPENROUTER_BASE_URL,
    // SDK-level resilience: retry HTTP 408/409/429/5xx and network errors,
    // and cap individual requests at 90s so a stalled call can't wedge a
    // worker. Our manual retry loop (below) handles the 200-with-empty-content
    // case that the SDK can't see.
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 2,
    defaultHeaders: {
      "HTTP-Referer": siteUrl || "https://hinterland.camp",
      "X-Title": siteName || "Hinterland CMS",
    },
  });

  return {
    async translate({
      text,
      sourceLocale,
      targetLocale,
      format = "plain",
      signal,
      voice,
      glossary,
      constraints,
    }) {
      if (!apiKey) {
        throw new Error(
          "[translate] OPENROUTER_API_KEY is not set — refusing to translate"
        );
      }
      if (!Array.isArray(text) || text.length === 0) return [];

      const systemPrompt = buildSystemPrompt({
        sourceLocale,
        targetLocale,
        format,
        voice,
        glossary,
        constraints,
      });

      // Build the request body fresh per attempt so we can append corrective
      // messages on retry when the previous attempt's HTML structure failed
      // validation. `corrections` carries the failed assistant content + the
      // structured per-item failure detail produced by validateShape.
      const buildRequest = (corrections) => {
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify({ inputs: text }) },
        ];
        if (corrections) {
          messages.push({
            role: "assistant",
            content: corrections.rawAssistantContent,
          });
          messages.push({
            role: "user",
            content: buildCorrectionPrompt(corrections.failures),
          });
        }
        return {
          model,
          // OpenRouter built-in model fallback. If `model` is unavailable
          // OpenRouter will try the next entry. We always include the primary first.
          models: [model, ...fallbackModels].filter(Boolean),
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "translation_batch",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  translations: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["translations"],
                additionalProperties: false,
              },
            },
          },
          messages,
          max_tokens: maxOutputTokens,
          temperature: 0.3,
        };
      };

      const totalChars = text.reduce((a, s) => a + (s || "").length, 0);
      const logRetry = (attempt, err, response) => {
        getLogger().warn(
          `[translate] retry ${attempt}/${MAX_ATTEMPTS} (${format}): ${err?.message || err}`,
          {
            model: response?.model,
            finishReason: response?.choices?.[0]?.finish_reason,
            usage: response?.usage,
            chunkSize: { strings: text.length, chars: totalChars },
          }
        );
      };

      const attemptOnce = async (corrections) => {
        if (signal?.aborted) throw makeAbortError();

        const requestBody = buildRequest(corrections);
        const response = await client.chat.completions.create(
          requestBody,
          signal ? { signal } : undefined
        );

        const content = extractContent(response);
        const parsed = parseJsonContent(content, response);

        validateShape(text, parsed.translations, format, content, constraints);
        return parsed.translations;
      };

      let lastError;
      // When the previous attempt's output failed validation (HTML structure
      // or length constraints), carry the failure detail forward so the next
      // attempt sees its own bad output + a corrective user message.
      let corrections;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (signal?.aborted) throw makeAbortError();
        try {
          return await attemptOnce(corrections);
        } catch (err) {
          // Distinguish abort from translation failure.
          if (err?.name === "AbortError" || signal?.aborted) {
            throw makeAbortError();
          }
          // Terminal errors: surface immediately, don't retry.
          if (err?.terminal) throw err;
          lastError = err;
          logRetry(attempt, err, err?.response);
          corrections = err?.correctable || undefined;
          if (attempt < MAX_ATTEMPTS) {
            await sleepWithBackoff(attempt, signal);
          }
        }
      }
      throw lastError || new Error("[translate] exhausted retries");
    },

    /**
     * Rewrite texts that failed CMS validation at save time. Each item is a
     * text already in the target locale plus the validation message it
     * violated (e.g. "title must be at most 50 characters"). Returns the
     * revised strings in the same order. Used by the orchestrator's
     * save-repair loop, so the AI gets the exact failure reason and can
     * regenerate e.g. a shorter title with the same meaning.
     *
     * @param {object} args
     * @param {Array<{ text: string, issue: string, maxLength?: number }>} args.items
     * @param {string} args.targetLocale
     * @param {string} [args.voice]
     * @param {AbortSignal} [args.signal]
     * @returns {Promise<string[]>}
     */
    async fixText({ items, targetLocale, voice, signal }) {
      if (!apiKey) {
        throw new Error(
          "[translate] OPENROUTER_API_KEY is not set — refusing to translate"
        );
      }
      if (!Array.isArray(items) || items.length === 0) return [];

      const systemPrompt = [
        `You are a professional copy editor working in ${targetLocale}.`,
        voice || "",
        "Each input has a `text` that was rejected by a CMS validation rule and the `issue` describing why.",
        "Rewrite each text so it satisfies its rule while preserving the original meaning and language as closely as possible.",
        "Character limits are hard limits — count characters (including spaces), prefer shorter synonyms and tighter phrasing, never truncate mid-word or append ellipses.",
        "",
        "Rules:",
        "- Output JSON exactly matching the schema: { fixed: string[] }.",
        "- The fixed array MUST have the same length as the inputs array, in the same order.",
        "- Do NOT change the language of the text.",
        "- Do NOT add explanations, prefixes, or suffixes.",
      ]
        .filter(Boolean)
        .join("\n");

      const constraints = items.map((it) =>
        typeof it.maxLength === "number" ? { maxLength: it.maxLength } : undefined
      );

      const buildRequest = (corrections) => {
        const messages = [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: JSON.stringify({
              inputs: items.map(({ text, issue }) => ({ text, issue })),
            }),
          },
        ];
        if (corrections) {
          messages.push({
            role: "assistant",
            content: corrections.rawAssistantContent,
          });
          messages.push({
            role: "user",
            content: buildCorrectionPrompt(corrections.failures),
          });
        }
        return {
          model,
          models: [model, ...fallbackModels].filter(Boolean),
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "validation_fix_batch",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  fixed: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["fixed"],
                additionalProperties: false,
              },
            },
          },
          messages,
          max_tokens: maxOutputTokens,
          temperature: 0.3,
        };
      };

      const attemptOnce = async (corrections) => {
        if (signal?.aborted) throw makeAbortError();
        const response = await client.chat.completions.create(
          buildRequest(corrections),
          signal ? { signal } : undefined
        );
        const content = extractContent(response);
        const parsed = parseJsonContent(content, response);
        const fixed = parsed.fixed;
        if (!Array.isArray(fixed)) {
          throw new Error("fixText output is not an array");
        }
        if (fixed.length !== items.length) {
          throw new Error(
            `fixText length mismatch: expected ${items.length}, got ${fixed.length}`
          );
        }
        // Where we know the numeric limit, verify the rewrite actually fits
        // and re-ask with corrective feedback if not.
        const failures = describeLengthFailures(fixed, constraints);
        if (failures.length > 0) {
          /** @type {ProviderError} */
          const e = new Error(
            `fixText validation failed — ${failures
              .map((f) => `item ${f.index}: ${f.summary}`)
              .join("; ")}`
          );
          e.correctable = { rawAssistantContent: content, failures };
          throw e;
        }
        return fixed;
      };

      let lastError;
      let corrections;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (signal?.aborted) throw makeAbortError();
        try {
          return await attemptOnce(corrections);
        } catch (err) {
          if (err?.name === "AbortError" || signal?.aborted) {
            throw makeAbortError();
          }
          if (err?.terminal) throw err;
          lastError = err;
          getLogger().warn(
            `[translate] fixText retry ${attempt}/${MAX_ATTEMPTS}: ${err?.message || err}`
          );
          corrections = err?.correctable || undefined;
          if (attempt < MAX_ATTEMPTS) {
            await sleepWithBackoff(attempt, signal);
          }
        }
      }
      throw lastError || new Error("[translate] fixText exhausted retries");
    },

    async usage() {
      // OpenRouter exposes total credits used and remaining via /credits.
      try {
        const res = await fetch(`${OPENROUTER_BASE_URL}/credits`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) {
          return { count: 0, limit: null, error: `HTTP ${res.status}` };
        }
        const json = await res.json();
        const data = json && json.data ? json.data : {};
        return {
          count: data.total_usage || 0,
          limit: data.total_credits || null,
        };
      } catch (err) {
        return { count: 0, limit: null, error: err.message };
      }
    },

    /**
     * Token + cost estimate for a batch of strings. Pricing comes from the
     * plugin config (`providerOptions.pricing`) — when missing, we return
     * token counts only and leave cost undefined.
     *
     * pricing shape: { inputPerMillion: number, outputPerMillion: number }
     *   matching OpenRouter's $/M token convention.
     */
    async estimate({ text }) {
      if (!Array.isArray(text) || text.length === 0) {
        return { inputTokens: 0, estimatedOutputTokens: 0, items: 0 };
      }
      // Char-based approximation — same heuristic as the chunks service.
      // For multi-byte scripts (CJK) this under-counts; acceptable for an
      // estimate.
      const chars = text.reduce((acc, s) => acc + (s || "").length, 0);
      const inputTokens = Math.ceil(chars / 4);
      // Output tends to be ~the same size as input for translation tasks.
      // We add a 25% buffer to be safe; JSON wrapping adds a small overhead.
      const estimatedOutputTokens = Math.ceil(inputTokens * 1.25);
      const pricing = providerOptions.pricing;
      let estimatedCostUsd;
      if (
        pricing &&
        typeof pricing.inputPerMillion === "number" &&
        typeof pricing.outputPerMillion === "number"
      ) {
        estimatedCostUsd =
          (inputTokens * pricing.inputPerMillion) / 1_000_000 +
          (estimatedOutputTokens * pricing.outputPerMillion) / 1_000_000;
      }
      return {
        inputTokens,
        estimatedOutputTokens,
        estimatedCostUsd,
        items: text.length,
      };
    },
  };
};

export default { init, meta: { name: "openrouter", displayName: "OpenRouter" } };
