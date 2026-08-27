/**
 * Fallback semantic matching via LLM.
 *
 * Strategi berlapis (mengikuti config.semantic.provider):
 *  1. "zai"    -> z-ai-web-dev-sdk (jika tersedia di lingkungan gateway)
 *  2. "openai" -> HTTP chat completions kompatibel OpenAI
 *             (openaiBaseUrl + openaiApiKey + openaiModel)
 *  3. "auto"   -> coba z-ai dulu, lalu openai bila dikonfigurasi
 *
 * Semua jalur dilindungi timeout & try/catch: kegagalan APA PUN mengembalikan
 * null sehingga caller jatuh kembali ke hasil keyword (graceful degradation).
 */

import { setTimeout as delay } from 'node:timers/promises';

let _zaiCache;
let _zaiTried = false;

async function loadZai() {
  if (_zaiTried) return _zaiCache;
  _zaiTried = true;
  try {
    const mod = await import('z-ai-web-dev-sdk');
    const ZAI = mod.default || mod.ZAI || mod;
    _zaiCache = await ZAI.create();
  } catch {
    _zaiCache = undefined; // SDK tidak terpasang / tidak bisa init
  }
  return _zaiCache;
}

/**
 * @param {string} query
 * @param {Array<{name:string,description:string}>} candidates
 * @param {{ provider?:string, threshold?:number, timeoutMs?:number,
 *           openaiBaseUrl?:string, openaiApiKey?:string, openaiModel?:string }} cfg
 * @returns {Promise<null | Array<{ name:string, score:number, reason:string }>>}
 */
export async function semanticRank(query, candidates, cfg = {}) {
  if (!query || !candidates?.length) return [];
  const provider = cfg.provider || 'auto';
  const withTimeout = async (fn) => {
    let timer;
    try {
      return await Promise.race([
        fn(),
        delay(cfg.timeoutMs ?? 6000).then(() => null),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const runZai = async () => {
    if (provider === 'openai') return null;
    const zai = await loadZai();
    if (!zai?.chat?.completions?.create) return null;
    const content = await askLLM(async (messages) => {
      const res = await zai.chat.completions.create({
        messages,
        thinking: { type: 'disabled' },
      });
      return res.choices?.[0]?.message?.content ?? '';
    }, query, candidates);
    return parseRanked(content, candidates);
  };

  const runOpenAI = async () => {
    if (provider === 'zai') return null;
    const baseUrl = cfg.openaiBaseUrl;
    const apiKey = cfg.openaiApiKey;
    if (!baseUrl || !apiKey) return null;
    const content = await askLLM(async (messages) => {
      const ctrl = new AbortController();
      const to = delay(cfg.timeoutMs ?? 6000).then(() => {
        ctrl.abort();
        return null;
      });
      try {
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: cfg.openaiModel || 'gpt-4o-mini',
            messages,
            temperature: 0,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) return '';
        const json = await res.json().catch(() => null);
        return json?.choices?.[0]?.message?.content ?? '';
      } catch {
        return '';
      } finally {
        clearTimeout(to);
      }
    }, query, candidates);
    return parseRanked(content, candidates);
  };

  for (const path of [runZai, runOpenAI]) {
    const result = await withTimeout(path);
    if (result && result.length) return filterByThreshold(result, cfg.threshold ?? 0.3);
  }
  return null; // semua jalur gagal / tidak tersedia
}

function systemPrompt() {
  return [
    'Kamu adalah matcher skill untuk agen OpenClaw.',
    'Diberikan daftar skill (nama + deskripsi) dan sebuah permintaan pengguna.',
    'Nilai setiap skill dengan skor relevansi 0 sampai 1.',
    'Balas HANYA array JSON valid tanpa penjelasan:',
    '[{"name":"nama-skill","score":0.87,"reason":"singkat"}]',
    'Jangan menambahkan skill yang tidak ada di daftar. Skor < 0.2 artinya tidak relevan.',
  ].join(' ');
}

async function askLLM(call, query, candidates) {
  const list = candidates
    .map((c) => `- ${c.name}: ${String(c.description || '').slice(0, 220)}`)
    .join('\n');
  const user = `Daftar skill:\n${list}\n\nPermintaan pengguna: "${String(query).slice(0, 500)}"\n\nSertakan SEMUA skill dalam array JSON.`;
  try {
    return await call(
      [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: user },
      ],
      query,
      candidates
    );
  } catch {
    return '';
  }
}

/** Parsing defensif output LLM -> entri valid milik daftar kandidat saja. */
export function parseRanked(raw, candidates) {
  if (!raw) return null;
  const match = String(raw).match(/\[[\s\S]*\]/);
  if (!match) return null;
  let arr;
  try {
    arr = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const byName = new Map(candidates.map((c) => [c.name.toLowerCase(), c]));
  const out = [];
  for (const item of arr) {
    const nameRaw = typeof item?.name === 'string' ? item.name.trim().toLowerCase() : '';
    const rec = byName.get(nameRaw);
    if (!rec) continue;
    const score = Number(item?.score);
    if (!Number.isFinite(score)) continue;
    const norm = Math.max(0, Math.min(1, score <= 1 ? score : score / 100));
    out.push({ name: rec.name, score: norm, reason: String(item?.reason || '').slice(0, 120) });
  }
  return out;
}

export function filterByThreshold(ranked, threshold) {
  const kept = ranked.filter((r) => r.score >= threshold);
  kept.sort((a, b) => b.score - a.score);
  return kept.slice(0, 10);
}
