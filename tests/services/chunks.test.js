import { describe, it, expect } from "vitest";
import factory from "../../server/services/chunks.js";

const svc = factory();

describe("chunks service", () => {
  it("perItem mode returns one chunk per string", () => {
    const out = svc.chunk(["a", "b", "c"], { perItem: true });
    expect(out).toEqual([["a"], ["b"], ["c"]]);
  });

  it("batches strings until maxChars is exceeded", () => {
    const strings = ["a".repeat(100), "b".repeat(100), "c".repeat(100)];
    const out = svc.chunk(strings, { maxChars: 250 });
    // First two fit (200 chars), third pushes past 250 so new chunk
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(2);
    expect(out[1]).toHaveLength(1);
  });

  it("a single oversized string still becomes its own chunk", () => {
    const strings = ["x".repeat(10_000)];
    const out = svc.chunk(strings, { maxChars: 100 });
    expect(out).toEqual([["x".repeat(10_000)]]);
  });

  it("empty input returns empty array", () => {
    expect(svc.chunk([])).toEqual([]);
  });

  it("uses default maxChars when none provided", () => {
    const strings = ["a".repeat(1000), "b".repeat(1000), "c".repeat(1000), "d".repeat(1000)];
    const out = svc.chunk(strings);
    // default 3000; first 3 fit (3000), then "d" starts a new chunk
    expect(out).toHaveLength(2);
  });
});
