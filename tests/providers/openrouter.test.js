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

  it("retries with corrective feedback when HTML structure is wrong", async () => {
    const sourceHtml =
      "<p><strong>a</strong> <strong>b</strong> <strong>c</strong> <strong>d</strong></p>";
    const badHtml = "<p><strong>a</strong> <strong>b</strong> c d</p>";
    const goodHtml =
      "<p><strong>A</strong> <strong>B</strong> <strong>C</strong> <strong>D</strong></p>";

    let n = 0;
    const fake = makeFakeClient({
      respond: async () => {
        n += 1;
        if (n === 1) return okResp([badHtml]);
        return okResp([goodHtml]);
      },
    });
    const provider = openrouter.init({
      providerOptions: baseOpts,
      clientFactory: fake.factory,
    });

    const out = await provider.translate({
      text: [sourceHtml],
      sourceLocale: "de",
      targetLocale: "en",
      format: "html",
    });

    expect(out).toEqual([goodHtml]);
    expect(fake.calls).toHaveLength(2);

    // First attempt: just system + user.
    expect(fake.calls[0].body.messages).toHaveLength(2);

    // Second attempt: system + user + assistant (the failed echo) + user (corrective prompt).
    const retryMsgs = fake.calls[1].body.messages;
    expect(retryMsgs).toHaveLength(4);
    expect(retryMsgs[2].role).toBe("assistant");
    expect(retryMsgs[2].content).toContain(badHtml);
    expect(retryMsgs[3].role).toBe("user");
    expect(retryMsgs[3].content).toMatch(/missing 2 <strong>/i);
    expect(retryMsgs[3].content).toMatch(/item 0/i);
  }, 15_000);

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

  it("renders length constraints into the system prompt", async () => {
    const fake = makeFakeClient({ respond: async () => okResp(["Hi", "World"]) });
    const provider = openrouter.init({
      providerOptions: baseOpts,
      clientFactory: fake.factory,
    });
    await provider.translate({
      text: ["Hallo", "Welt"],
      sourceLocale: "de",
      targetLocale: "en",
      format: "plain",
      constraints: [{ maxLength: 10 }, undefined],
    });
    const system = fake.calls[0].body.messages[0].content;
    expect(system).toContain("inputs[0] must be at most 10 characters");
    expect(system).not.toContain("inputs[1]");
  });

  it("retries with corrective feedback when output exceeds maxLength", async () => {
    let n = 0;
    const fake = makeFakeClient({
      respond: async () => {
        n += 1;
        if (n === 1) return okResp(["this translation is way too long"]);
        return okResp(["short"]);
      },
    });
    const provider = openrouter.init({
      providerOptions: baseOpts,
      clientFactory: fake.factory,
    });
    const out = await provider.translate({
      text: ["kurz"],
      sourceLocale: "de",
      targetLocale: "en",
      format: "plain",
      constraints: [{ maxLength: 10 }],
    });
    expect(out).toEqual(["short"]);
    expect(fake.calls).toHaveLength(2);
    // Second attempt carries the failed output + a corrective user message.
    const retryMsgs = fake.calls[1].body.messages;
    expect(retryMsgs).toHaveLength(4);
    expect(retryMsgs[2].role).toBe("assistant");
    expect(retryMsgs[3].role).toBe("user");
    expect(retryMsgs[3].content).toMatch(/item 0/i);
    expect(retryMsgs[3].content).toMatch(/at most 10/i);
  }, 15_000);

  describe("fixText", () => {
    const okFixResp = (fixed) => ({
      model: "mock-model",
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify({ fixed }) } },
      ],
    });

    it("rewrites failing texts using the validation message", async () => {
      const fake = makeFakeClient({ respond: async () => okFixResp(["Kurzer Titel"]) });
      const provider = openrouter.init({
        providerOptions: baseOpts,
        clientFactory: fake.factory,
      });
      const out = await provider.fixText({
        items: [
          {
            text: "Ein viel zu langer übersetzter Titel",
            issue: "title must be at most 20 characters",
            maxLength: 20,
          },
        ],
        targetLocale: "de",
        voice: "warm",
      });
      expect(out).toEqual(["Kurzer Titel"]);
      const userMsg = fake.calls[0].body.messages[1].content;
      expect(userMsg).toContain("Ein viel zu langer übersetzter Titel");
      expect(userMsg).toContain("at most 20 characters");
      const system = fake.calls[0].body.messages[0].content;
      expect(system).toContain("warm");
    });

    it("re-asks with corrective feedback when the rewrite still exceeds maxLength", async () => {
      let n = 0;
      const fake = makeFakeClient({
        respond: async () => {
          n += 1;
          if (n === 1) return okFixResp(["immer noch viel zu lang"]);
          return okFixResp(["passt"]);
        },
      });
      const provider = openrouter.init({
        providerOptions: baseOpts,
        clientFactory: fake.factory,
      });
      const out = await provider.fixText({
        items: [{ text: "zu lang", issue: "must be at most 10 characters", maxLength: 10 }],
        targetLocale: "de",
      });
      expect(out).toEqual(["passt"]);
      expect(fake.calls).toHaveLength(2);
      const retryMsgs = fake.calls[1].body.messages;
      expect(retryMsgs[3].content).toMatch(/at most 10/i);
    }, 15_000);

    it("returns [] for empty input without calling the API", async () => {
      const fake = makeFakeClient({ respond: async () => okFixResp(["never"]) });
      const provider = openrouter.init({
        providerOptions: baseOpts,
        clientFactory: fake.factory,
      });
      const out = await provider.fixText({ items: [], targetLocale: "de" });
      expect(out).toEqual([]);
      expect(fake.calls).toHaveLength(0);
    });
  });

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
