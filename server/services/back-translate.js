// Back-translate sanity check.
//
// After a forward translation, optionally round-trip the result back to the
// source language and compare to the original. Low similarity flags a
// potential hallucination/quality issue. Cheap to run on a sample (top-N
// longest strings) rather than the whole document. Opt-in by callers.

/**
 * Normalize text for similarity comparison:
 *   - lowercase
 *   - strip punctuation (keep letters, digits, whitespace, hyphens)
 *   - collapse whitespace
 */
const normalize = (s) => {
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
};

/**
 * Compute a 0..1 similarity score between two strings using normalized
 * Levenshtein. 1.0 = identical, 0.0 = completely different.
 *
 * Levenshtein matrix is O(n*m) — fine for sentence-length strings, but we
 * cap input length at 4_000 chars to avoid pathological cases.
 */
const similarity = (a, b) => {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length === 0 && nb.length === 0) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  const A = na.slice(0, 4000);
  const B = nb.slice(0, 4000);
  const m = A.length;
  const n = B.length;
  // Use two rolling rows of the matrix.
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = A.charCodeAt(i - 1) === B.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  const dist = prev[n];
  const maxLen = Math.max(m, n);
  return 1 - dist / maxLen;
};

/**
 * Pick a sample for back-translation. Returns the N longest items per format
 * group, capped at maxTotal across all groups, biased toward "items that have
 * enough signal to detect drift".
 */
const sampleItems = (items, { perGroup = 5, maxTotal = 30 } = {}) => {
  if (!Array.isArray(items) || items.length === 0) return [];
  const indexed = items.map((it, i) => ({ ...it, originIdx: i }));
  indexed.sort((a, b) => (b.text || "").length - (a.text || "").length);
  return indexed.slice(0, Math.min(perGroup, maxTotal));
};

export default ({ strapi }) => {
  return {
    normalize,
    similarity,
    sampleItems,

    /**
     * Run a back-translation pass on (source, translated) pairs.
     * Returns { warnings, samples } where warnings are pairs with similarity
     * below the configured threshold.
     *
     * @param {object} args
     * @param {Array<{ original: string, translated: string, format?: string, label?: string }>} args.pairs
     * @param {string} args.sourceLocale  source language code (we translate target back to this)
     * @param {string} args.targetLocale  language we just translated to
     * @param {string} [args.voice]       voice instructions (same as forward)
     * @param {object} [args.glossary]    glossary (same as forward)
     * @param {AbortSignal} [args.signal] abort
     * @param {number} [args.threshold]   0..1 — similarity below this triggers a warning. Default 0.5
     */
    async check({ pairs, sourceLocale, targetLocale, voice, glossary, signal, threshold = 0.5 }) {
      if (!Array.isArray(pairs) || pairs.length === 0) {
        return { warnings: [], samples: [] };
      }
      const provider = strapi.plugin("translate").provider;
      // Group by format so we hand the provider homogeneous batches.
      const byFormat = new Map();
      for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        const f = p.format || "plain";
        if (!byFormat.has(f)) byFormat.set(f, []);
        byFormat.get(f).push({ ...p, originIdx: i });
      }
      const samples = new Array(pairs.length);
      const warnings = [];

      for (const [format, batch] of byFormat) {
        const inputs = batch.map((p) => p.translated);
        const out = await provider.translate({
          text: inputs,
          sourceLocale: targetLocale,
          targetLocale: sourceLocale,
          format,
          signal,
          voice,
          glossary,
        });
        for (let i = 0; i < batch.length; i++) {
          const p = batch[i];
          const back = out[i] || "";
          const score = similarity(p.original, back);
          samples[p.originIdx] = {
            original: p.original,
            translated: p.translated,
            backTranslated: back,
            similarity: score,
            label: p.label,
          };
          if (score < threshold) {
            warnings.push({
              label: p.label,
              similarity: score,
              original: p.original,
              translated: p.translated,
              backTranslated: back,
            });
          }
        }
      }
      return { warnings, samples };
    },
  };
};

export { similarity, normalize, sampleItems };
