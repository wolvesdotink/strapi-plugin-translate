// Display helpers shared by the translate dialogs.

export const formatCost = (n) => {
  if (typeof n !== "number" || !isFinite(n)) return null;
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
};

export const formatTokens = (n) => {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
};

// Truncate a long string for diff display. Diff values for richtext/blocks
// can be huge; show the first ~400 chars with an ellipsis.
export const truncate = (v, n = 400) => {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") {
    try {
      const s = JSON.stringify(v);
      return s.length > n ? `${s.slice(0, n)}…` : s;
    } catch {
      return String(v);
    }
  }
  if (v.length <= n) return v;
  return `${v.slice(0, n)}…`;
};

// Turn a dot-joined diff path ("hero.sections.0.title") into a breadcrumb
// the editor can actually parse: "Hero › Sections › [1] › Title". Numeric
// segments are shown 1-indexed in brackets so they read as list positions.
export const humanizeSegment = (seg) => {
  if (/^\d+$/.test(seg)) return `[${Number(seg) + 1}]`;
  // camelCase → "Camel Case"
  const spaced = seg.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};
export const humanizePath = (path) => {
  if (!path) return "";
  return path.split(".").map(humanizeSegment).join(" › ");
};

// Empty/missing values in the diff get a soft placeholder instead of an
// empty box, so the editor can tell "no value" from "value is whitespace".
export const renderDiffValue = (v) => {
  if (v === undefined || v === null) return { text: "—", muted: true };
  if (typeof v === "string" && v.length === 0)
    return { text: "(empty)", muted: true };
  return { text: truncate(v), muted: false };
};

// Top-level fields arrive as their own modules, labelled with the raw
// attribute name ("title"); show them like the editor's field labels.
export const moduleLabel = (module) =>
  module.key?.startsWith("root/")
    ? humanizeSegment(module.label)
    : module.label;
