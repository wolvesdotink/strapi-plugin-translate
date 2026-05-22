import { describe, it, expect, beforeEach } from "vitest";

describe("provider registry", () => {
  let providers;
  beforeEach(async () => {
    // Reset module cache so each test gets a fresh registry
    delete require.cache[require.resolve("../../server/providers/index.js")];
    providers = require("../../server/providers/index.js");
  });

  it("has openrouter pre-registered", () => {
    expect(providers.has("openrouter")).toBe(true);
    expect(providers.list()).toContain("openrouter");
  });

  it("resolves openrouter to a callable init", () => {
    const init = providers.resolve("openrouter");
    expect(typeof init).toBe("function");
  });

  it("register / resolve a new provider", () => {
    const init = ({ providerOptions }) => ({
      translate: async () => [],
      usage: async () => ({ count: 0, limit: null }),
    });
    providers.register("custom", { init, meta: { name: "custom" } });
    expect(providers.has("custom")).toBe(true);
    expect(providers.resolve("custom")).toBe(init);
  });

  it("throws on unknown provider with a useful message", () => {
    expect(() => providers.resolve("nonexistent")).toThrow(/unknown provider/i);
    expect(() => providers.resolve("nonexistent")).toThrow(/openrouter/);
  });

  it("rejects providers without init", () => {
    expect(() => providers.register("broken", {})).toThrow(/init/);
    expect(() => providers.register("", { init: () => {} })).toThrow();
  });

  it("re-registration overwrites", () => {
    const init1 = () => ({ translate: async () => [], usage: async () => ({}) });
    const init2 = () => ({ translate: async () => [], usage: async () => ({}) });
    providers.register("x", { init: init1 });
    providers.register("x", { init: init2 });
    expect(providers.resolve("x")).toBe(init2);
  });
});
