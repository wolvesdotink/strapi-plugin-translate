// Provider registry. Decouples the translate service from the concrete LLM
// backend; new providers register themselves here and become selectable via
// `provider: "<name>"` in the plugin config.
//
// Provider contract (see docs/PROVIDER.md):
//   init({ providerOptions }) -> {
//     async translate({ text, sourceLocale, targetLocale, format, signal, voice, glossary }) -> string[]
//     async usage() -> { count: number, limit: number|null, error?: string }
//     async estimate?({ text }) -> { inputTokens, estimatedOutputTokens, estimatedCostUsd? }
//   }

import openrouter from "./openrouter";

const registry = new Map();

/**
 * Register a provider. Idempotent: re-registering the same name overwrites
 * the prior entry — useful in tests.
 *
 * @param {string} name
 * @param {{ init: function, meta?: { displayName?: string } }} mod
 */
const register = (name, mod) => {
  if (!name || typeof name !== "string") {
    throw new Error("[translate] provider name must be a non-empty string");
  }
  if (!mod || typeof mod.init !== "function") {
    throw new Error(`[translate] provider '${name}' must export an init() function`);
  }
  registry.set(name, mod);
};

/**
 * Look up a registered provider's init function. Throws a useful error
 * listing registered names if not found.
 */
const resolve = (name) => {
  const mod = registry.get(name);
  if (!mod) {
    const known = [...registry.keys()].join(", ") || "(none registered)";
    throw new Error(
      `[translate] unknown provider '${name}'. Registered: ${known}`
    );
  }
  return mod.init;
};

const list = () => [...registry.keys()];

const has = (name) => registry.has(name);

// Pre-register the bundled providers.
register("openrouter", openrouter);

export default { register, resolve, list, has };
