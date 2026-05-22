import { describe, it, expect } from "vitest";
import factory from "../../server/services/format.js";

const svc = factory();

describe("format service", () => {
  describe("isWhitespaceOnly", () => {
    it("returns true for empty/whitespace strings", () => {
      expect(svc.isWhitespaceOnly("")).toBe(true);
      expect(svc.isWhitespaceOnly(" ")).toBe(true);
      expect(svc.isWhitespaceOnly("\n\t")).toBe(true);
      expect(svc.isWhitespaceOnly(null)).toBe(true);
      expect(svc.isWhitespaceOnly(undefined)).toBe(true);
    });
    it("returns false for non-whitespace", () => {
      expect(svc.isWhitespaceOnly("hi")).toBe(false);
      expect(svc.isWhitespaceOnly("  hi  ")).toBe(false);
    });
  });

  describe("validateHtmlShape", () => {
    it("passes on identical structures with translated text", () => {
      const a = '<p>Hallo <a href="https://example.com">Welt</a></p>';
      const b = '<p>Hello <a href="https://example.com">world</a></p>';
      expect(svc.validateHtmlShape(a, b)).toEqual({ ok: true });
    });

    it("rejects tag-name swaps", () => {
      const a = "<p><strong>hi</strong></p>";
      const b = "<p><em>hi</em></p>";
      const r = svc.validateHtmlShape(a, b);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/tag-name/i);
    });

    it("rejects extra tags", () => {
      const a = "<p>hi</p>";
      const b = "<p>hi <em>foo</em></p>";
      const r = svc.validateHtmlShape(a, b);
      expect(r.ok).toBe(false);
    });

    it("rejects URL rewrites", () => {
      const a = '<a href="https://example.com">link</a>';
      const b = '<a href="https://evil.example">link</a>';
      const r = svc.validateHtmlShape(a, b);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/url/i);
    });

    it("passes when URLs are preserved", () => {
      const a = '<a href="/about">about</a>';
      const b = '<a href="/about">about</a>';
      expect(svc.validateHtmlShape(a, b).ok).toBe(true);
    });

    it("accepts text-only changes (no tags)", () => {
      expect(svc.validateHtmlShape("Hallo Welt", "Hello world").ok).toBe(true);
    });
  });

  describe("collectBlocksTexts / applyBlocksTexts", () => {
    it("collects leaf text nodes in order", () => {
      const blocks = [
        {
          type: "paragraph",
          children: [
            { text: "Hallo " },
            { text: "Welt", bold: true },
          ],
        },
      ];
      const items = svc.collectBlocksTexts(blocks);
      expect(items.map((i) => i.text)).toEqual(["Hallo ", "Welt"]);
    });

    it("skips whitespace-only nodes", () => {
      const blocks = [
        { type: "paragraph", children: [{ text: "ok" }, { text: "  " }] },
      ];
      const items = svc.collectBlocksTexts(blocks);
      expect(items).toHaveLength(1);
    });

    it("applies translations back at the same paths", () => {
      const blocks = [
        {
          type: "paragraph",
          children: [{ text: "Hallo " }, { text: "Welt", bold: true }],
        },
      ];
      const items = svc.collectBlocksTexts(blocks);
      const out = svc.applyBlocksTexts(blocks, items, ["Hello ", "world"]);
      expect(out[0].children[0].text).toBe("Hello ");
      expect(out[0].children[1].text).toBe("world");
      // Preserves the bold marker
      expect(out[0].children[1].bold).toBe(true);
    });

    it("does not mutate the source", () => {
      const blocks = [{ type: "paragraph", children: [{ text: "hi" }] }];
      const items = svc.collectBlocksTexts(blocks);
      const out = svc.applyBlocksTexts(blocks, items, ["bonjour"]);
      expect(blocks[0].children[0].text).toBe("hi");
      expect(out[0].children[0].text).toBe("bonjour");
    });
  });
});
