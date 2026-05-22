import { describe, it, expect, beforeEach } from "vitest";
import openrouter from "../../server/providers/openrouter.js";

// Build a fake openai client. Each test installs a `respond` function that
// returns the next response (and can throw for failure scenarios). The whole
// thing avoids `vi.mock` entirely — production code accepts a clientFactory
// for tests.
const makeFakeClient = ({ respond, abortChecks = true }) => {
  const calls = [];
  return {
    factory: () => ({
      chat: {
        completions: {
          create: async (body, opts) => {
            calls.push({ body, opts });
            if (abortChecks && opts?.signal?.aborted) {
              const e = new Error("aborted");
              e.name = "AbortError";
              throw e;
            }
            return respond(body, opts);
          },
        },
      },
    }),
    calls,
  };
};

const okResp = (translations, finish = "stop") => ({
  model: "mock-model",
  choices: [
    {
      finish_reason: finish,
      message: { content: JSON.stringify({ translations }) },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
});

const baseOpts = {
  apiKey: "sk-or-test",
  model: "anthropic/claude-sonnet-4.6",
  siteUrl: "https://example",
  siteName: "Test",
};

describe("openrouter provider", () => {
  it("translates plain text successfully", async () => {
    const fake = makeFakeClient({ respond: async () => okResp(["Hello", "World"]) });
    const provider = openrouter.init({
      providerOptions: baseOpts,
      clientFactory: fake.factory,
    });
    const out = await provider.translate({
      text: ["Hallo", "Welt"],
      sourceLocale: "de",
      targetLocale: "en",
      format: "plain",
    });
    expect(out).toEqual(["Hello", "World"]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].body.messages[1].content).toContain("Hallo");
  });

  it("includes voice + glossary in the system prompt", async () => {
    const fake = makeFakeClient({ respond: async () => okResp(["Bonjour"]) });
    const provider = openrouter.init({
      providerOptions: baseOpts,
      clientFactory: fake.factory,
    });
    await provider.translate({
      text: ["Hallo"],
      sourceLocale: "de",
      targetLocale: "fr",
      format: "plain",
      voice: "Use a warm tone.",
      glossary: {
        preserveExact: ["Hinterland Camp"],
        perLocale: { fr: { Hütte: "cabane" } },
      },
    });
    const system = fake.calls[0].body.messages[0].content;
    expect(system).toContain("Use a warm tone");
    expect(system).toContain("Hinterland Camp");
    expect(system).toContain("cabane");
  });

  it("treats finish_reason=length as terminal", async () => {
    const fake = makeFakeClient({
      respond: async () => ({
        model: "mock-model",
        choices: [{ finish_reason: "length", message: { content: null } }],
      }),
    });
    const provider = openrouter.init({
      providerOptions: baseOpts,
      clientFactory: fake.factory,
    });
    await expect(
      provider.translate({
        text: ["x"],
        sourceLocale: "de",
        targetLocale: "en",
        format: "plain",
      })
    ).rejects.toThrow(/truncated|length/i);
    expect(fake.calls).toHaveLength(1);
  });

  it("treats refusal as terminal", async () => {
    const fake = makeFakeClient({
      respond: async () => ({
        model: "mock-model",
        choices: [
          {
            finish_reason: "stop",
            message: { content: null, refusal: "I won't translate that" },
          },
        ],
      }),
    });
    const provider = openrouter.init({
      providerOptions: baseOpts,
      clientFactory: fake.factory,
    });
    await expect(
      provider.translate({
        text: ["x"],
        sourceLocale: "de",
        targetLocale: "en",
        format: "plain",
      })
    ).rejects.toThrow(/refused/i);
  });

  it("treats content_filter as terminal", async () => {
    const fake = makeFakeClient({
      respond: async () => ({
        model: "mock-model",
        choices: [{ finish_reason: "content_filter", message: { content: null } }],
      }),
    });
    const provider = openrouter.init({
      providerOptions: baseOpts,
      clientFactory: fake.factory,
    });
    await expect(
      provider.translate({
        text: ["x"],
        sourceLocale: "de",
        targetLocale: "en",
        format: "plain",
      })
    ).rejects.toThrow(/content moderation/i);
  });

  it("retries on transient empty response", async () => {
    let n = 0;
    const fake = makeFakeClient({
      respond: async () => {
        n += 1;
        if (n < 2) {
          return {
            model: "mock-model",
            choices: [{ finish_reason: "stop", message: { content: null } }],
          };
        }
        return okResp(["ok"]);
      },
    });
    const provider = openrouter.init({
      providerOptions: baseOpts,
      clientFactory: fake.factory,
    });
    const out = await provider.translate({
      text: ["x"],
      sourceLocale: "de",
      targetLocale: "en",
      format: "plain",
    });
    expect(out).toEqual(["ok"]);
    expect(n).toBe(2);
  }, 15_000);

  it("throws AbortError when signal is aborted before call", async () => {
    const fake = makeFakeClient({ respond: async () => okResp(["never"]) });
    const provider = openrouter.init({
      providerOptions: baseOpts,
      clientFactory: fake.factory,
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      provider.translate({
        text: ["x"],
        sourceLocale: "de",
        targetLocale: "en",
        format: "plain",
        signal: ctrl.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws when apiKey is missing", async () => {
    const fake = makeFakeClient({ respond: async () => okResp(["never"]) });
    const provider = openrouter.init({
      providerOptions: { ...baseOpts, apiKey: null },
      clientFactory: fake.factory,
    });
    await expect(
      provider.translate({
        text: ["x"],
        sourceLocale: "de",
        targetLocale: "en",
        format: "plain",
      })
    ).rejects.toThrow(/api.*key/i);
  });

  it("returns [] for empty input without calling the API", async () => {
    const fake = makeFakeClient({ respond: async () => okResp(["never"]) });
    const provider = openrouter.init({
      providerOptions: baseOpts,
      clientFactory: fake.factory,
    });
    const out = await provider.translate({
      text: [],
      sourceLocale: "de",
      targetLocale: "en",
      format: "plain",
    });
    expect(out).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects length mismatch as a terminal-or-retriable failure", async () => {
    // Length mismatch is retriable (not marked terminal). It will retry 3
    // times and then throw the last error. Test verifies the eventual error.
    const fake = makeFakeClient({ respond: async () => okResp(["only one"]) });
    const provider = openrouter.init({
      providerOptions: baseOpts,
      clientFactory: fake.factory,
    });
    await expect(
      provider.translate({
        text: ["a", "b", "c"],
        sourceLocale: "de",
        targetLocale: "en",
        format: "plain",
      })
    ).rejects.toThrow(/length mismatch/i);
  }, 30_000);

  describe("estimate", () => {
    it("returns token counts without pricing", async () => {
      const provider = openrouter.init({ providerOptions: baseOpts });
      const out = await provider.estimate({ text: ["four", "score", "and seven"] });
      expect(out.inputTokens).toBeGreaterThan(0);
      expect(out.estimatedOutputTokens).toBeGreaterThanOrEqual(out.inputTokens);
      expect(out.estimatedCostUsd).toBeUndefined();
      expect(out.items).toBe(3);
    });

    it("computes cost when pricing provided", async () => {
      const provider = openrouter.init({
        providerOptions: {
          ...baseOpts,
          pricing: { inputPerMillion: 3, outputPerMillion: 15 },
        },
      });
      const out = await provider.estimate({ text: ["x".repeat(4000)] });
      expect(out.estimatedCostUsd).toBeGreaterThan(0);
    });

    it("returns zeros for empty input", async () => {
      const provider = openrouter.init({ providerOptions: baseOpts });
      const out = await provider.estimate({ text: [] });
      expect(out).toEqual({ inputTokens: 0, estimatedOutputTokens: 0, items: 0 });
    });
  });
});
