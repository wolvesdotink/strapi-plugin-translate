"use strict";

// Splits an array of strings into chunks below a max character budget so each
// LLM request stays within a safe token window. Uses a rough char-to-token
// approximation (≈ 1 token per 4 chars for European languages) — the actual
// token cap is enforced by OpenRouter / the model.
//
// When `perItem` is true, each string becomes its own chunk. This is the
// safest mode for entries with many translatable fields: batched outputs
// often exceed the model's max_output_tokens and trigger
// `finish_reason=length` truncation.

const DEFAULT_MAX_CHARS = 3000;

module.exports = () => ({
  chunk(strings, { maxChars = DEFAULT_MAX_CHARS, perItem = false } = {}) {
    if (perItem) return strings.map((s) => [s]);
    const chunks = [];
    let current = [];
    let currentSize = 0;
    for (const s of strings) {
      const len = (s || "").length;
      if (current.length > 0 && currentSize + len > maxChars) {
        chunks.push(current);
        current = [];
        currentSize = 0;
      }
      current.push(s);
      currentSize += len;
    }
    if (current.length) chunks.push(current);
    return chunks;
  },
});
