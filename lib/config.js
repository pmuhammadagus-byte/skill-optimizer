/**
 * Normalisasi konfigurasi plugin (api.pluginConfig) dengan nilai default.
 * Aman terhadap config kosong/parsial/tipe salah.
 */

export const DEFAULT_CONFIG = Object.freeze({
  scanPaths: [],
  includeDefaultPaths: true,
  inject: {
    enabled: true,
    topK: 3,
    minScore: 0.18,
    maxChars: 900,
    skipCommands: true,
    dedupWindowMs: 90_000,
  },
  semantic: {
    enabled: true,
    strongScore: 0.45,
    threshold: 0.3,
    timeoutMs: 6000,
    provider: 'auto',
    openaiBaseUrl: undefined,
    openaiApiKey: undefined,
    openaiModel: 'gpt-4o-mini',
  },
  stats: {
    enabled: true,
    file: undefined,
  },
  commands: {
    enabled: true,
  },
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Gabungan dalam-deep: nilai user menimpa default; array diganti seluruhnya. */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function resolveConfig(rawConfig) {
  let merged = DEFAULT_CONFIG;
  try {
    merged = deepMerge(DEFAULT_CONFIG, rawConfig || {});
  } catch {
    merged = DEFAULT_CONFIG;
  }
  const cfg = structuredClone(merged);

  // Validasi tipe per bagian
  cfg.scanPaths = Array.isArray(cfg.scanPaths)
    ? cfg.scanPaths.filter((p) => typeof p === 'string' && p.trim())
    : [];
  cfg.includeDefaultPaths = cfg.includeDefaultPaths !== false;
  if (!isPlainObject(cfg.inject)) cfg.inject = structuredClone(DEFAULT_CONFIG.inject);
  if (!isPlainObject(cfg.semantic)) cfg.semantic = structuredClone(DEFAULT_CONFIG.semantic);
  if (!isPlainObject(cfg.stats)) cfg.stats = { ...DEFAULT_CONFIG.stats };
  if (!isPlainObject(cfg.commands)) cfg.commands = { ...DEFAULT_CONFIG.commands };
  cfg.inject.topK = clamp(cfg.inject.topK, 1, 10, 3);
  cfg.inject.minScore = clampNum(cfg.inject.minScore, 0, 1, 0.18);
  cfg.inject.maxChars = clamp(Math.round(Number(cfg.inject.maxChars)) || 900, 200, 4000, 900);
  cfg.inject.skipCommands = cfg.inject.skipCommands !== false;
  cfg.inject.dedupWindowMs = Math.max(0, Number(cfg.inject.dedupWindowMs) || 0);
  cfg.semantic.enabled = cfg.semantic.enabled !== false;
  cfg.semantic.strongScore = clampNum(cfg.semantic.strongScore, 0, 1, 0.45);
  cfg.semantic.threshold = clampNum(cfg.semantic.threshold, 0, 1, 0.3);
  cfg.semantic.timeoutMs = clamp(Math.round(Number(cfg.semantic.timeoutMs)) || 6000, 500, 30000, 6000);
  cfg.semantic.provider = ['auto', 'zai', 'openai'].includes(cfg.semantic.provider)
    ? cfg.semantic.provider
    : 'auto';
  cfg.commands.enabled = cfg.commands?.enabled !== false;
  return cfg;
}

function clamp(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}
