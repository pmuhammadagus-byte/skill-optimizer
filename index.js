/**
 * Skill Optimizer — plugin OpenClaw
 * ====================================
 * Mengoptimalkan penggunaan skill milik gateway:
 *
 *  1. Smart Router   : tiap pesan user dianalisis; skill relevan disuntikkan
 *                      ke prompt via hook before_prompt_build (prependContext).
 *  2. Hybrid matching: TF-IDF keyword cepat & offline; jika skor rendah dan
 *                      diaktifkan, jatuh kembali ke semantic LLM.
 *  3. Tool on-demand : agent bisa memanggil tool `recommend_skills`.
 *  4. Perintah chat  : /skills [list|find|reload|stats].
 *  5. Statistik      : pencatatan ringan pemakaian + laporan.
 *
 * Semua pendaftaran dibungkus try/catch agar plugin tidak pernah
 * membuat Gateway gagal start bila suatu API tidak tersedia di versi host.
 */

import { resolveConfig } from './lib/config.js';
import { SkillScanner } from './lib/scanner.js';
import { TfIdfMatcher } from './lib/matcher.js';
import { semanticRank } from './lib/semantic.js';
import { buildContextBlock } from './lib/injector.js';
import { UsageStore, formatSummary, defaultStatsFile } from './lib/stats.js';
import { tokenize } from './lib/tokenize.js';

/** Shim definePluginEntry: pakai SDK resmi bila ada, fallback identitas. */
async function loadDefinePluginEntry() {
  try {
    const mod = await import('openclaw/plugin-sdk/plugin-entry');
    if (typeof mod?.definePluginEntry === 'function') return mod.definePluginEntry;
  } catch {
    /* Host tidak memetakan subpath SDK (mis. mode link manual) → identitas */
  }
  return (entry) => entry;
}

const PLUGIN_ID = 'skill-optimizer';

export default (await loadDefinePluginEntry())({
  id: PLUGIN_ID,
  name: 'Skill Optimizer',
  description:
    'Rekomendasi skill otomatis per pesan (hybrid TF-IDF + LLM), tool recommend_skills, dan perintah /skills.',
  register(api) {
    const log = makeLogger(api);
    let cfg;
    try {
      cfg = resolveConfig(api.pluginConfig);
    } catch {
      cfg = resolveConfig(undefined);
    }

    // ---- Komponen inti -------------------------------------------------
    const scanner = new SkillScanner({
      scanPaths: cfg.scanPaths,
      includeDefaultPaths: cfg.includeDefaultPaths,
      logger: log,
    });
    const matcher = new TfIdfMatcher();

    /** Sinkron ulang index matcher dari records scanner. */
    const rebuildIndex = async () => {
      const records = await scanner.ensureFresh();
      matcher.build(records);
      return records;
    };

    /** @type {Map<string,{at:number,block:string}>} cache anti-spam injeksi */
    const recentInjections = new Map();

    const statsEnabled = cfg.stats?.enabled !== false && cfg.stats !== false;
    const store = statsEnabled
      ? new UsageStore({ file: cfg.stats?.file || defaultStatsFile() })
      : null;

    const safeInit = async () => {
      await store?.load().catch(() => {});
      try {
        const n = await rebuildIndex();
        log.info(`[skill-optimizer] aktif — ${n.length} skill terindeks`);
      } catch (err) {
        log.warn(`[skill-optimizer] gagal scan awal: ${err?.message || err}`);
      }
    };
    safeInit(); // berjalan paralel; tidak menahan startup gateway

    // ---- Helper scoring ------------------------------------------------
    const isCommandText = (t) => typeof t === 'string' && /^\s*\/[a-z]/i.test(t);

    /**
     * Hitung matches hybrid utk sebuah query. Selalu index-bangun dulu
     * (dengan TTL scan) supaya file SKILL.md baru langsung terlihat.
     */
    const findMatches = async (query, { withSemantic = true } = {}) => {
      let records;
      try {
        records = await rebuildIndex();
      } catch (err) {
        log.warn(`[skill-optimizer] scan ulang gagal: ${err?.message || err}`);
        records = scanner.recordsSync();
      }
      if (!records.length) return [];

      const kwHits = matcher.search(query, {
        topK: Math.max(cfg.inject.topK, 5), // kandidat lebih banyak utk rerank
        minScore: cfg.inject.minScore,
      });

      const bestScore = kwHits[0]?.score ?? 0;
      if (
        !withSemantic ||
        !cfg.semantic.enabled ||
        bestScore >= cfg.semantic.strongScore ||
        tokenize(query).length < 2
      ) {
        return kwHits.slice(0, cfg.inject.topK);
      }

      // ---- Fallback semantic ------------------------------------------
      try {
        const ranked = await semanticRank(query, kwHits, cfg.semantic).catch(() => null);
        if (ranked && ranked.length) {
          store?.record({ type: 'llm_fallback', provider: cfg.semantic.provider });
          const byName = new Map(kwHits.map((h) => [h.record.name, h]));
          return ranked
            .map((r) => ({ ...byName.get(r.name), reason: r.reason }))
            .filter(Boolean)
            .slice(0, cfg.inject.topK);
        }
      } catch (err) {
        log.debug(`semantic fallback error: ${err?.message || err}`);
      }
      // Tidak ada hasil semantic → tetap pakai keyword jika ada.
      return bestScore > 0 ? kwHits.slice(0, cfg.inject.topK) : [];
    };

    // ---- 1) Hook prompt: injeksi konteks -------------------------------
    tryRegister(() =>
      api.on?.call(api, 'before_prompt_build', async (event, ctx) => {
        if (!cfg.inject.enabled) return undefined;
        try {
          const query = String(event?.prompt ?? event?.cleanedBody ?? '').trim();
          if (!query || query.length < 4) return undefined;
          if (cfg.inject.skipCommands && isCommandText(query)) return undefined;

          const matches = await findMatches(query);
          if (!matches.length) return undefined;

          const block = buildContextBlock(matches, { query, maxChars: cfg.inject.maxChars });
          if (!block) return undefined;

          // Anti-duplikasi dalam jendela waktu singkat (mis. retry pesan)
          if (cfg.inject.dedupWindowMs > 0) {
            const key = block.slice(0, 120);
            const last = recentInjections.get(key);
            const now = Date.now();
            for (const [k, v] of recentInjections) {
              if (now - v.at > cfg.inject.dedupWindowMs) recentInjections.delete(k);
            }
            if (last && now - last.at < cfg.inject.dedupWindowMs) return undefined;
            recentInjections.set(key, { at: now, block });
          }

          for (const m of matches) {
            store?.record({ type: 'recommend', skill: m.record.name, score: m.score });
          }
          log.debug(
            `[skill-optimizer] menginjeksikan ${matches.length} rekomendasi${
              ctx?.agentId ? ` (agent ${ctx.agentId})` : ''
            }`
          );
          return { prependContext: block };
        } catch (err) {
          log.warn(`[skill-optimizer] before_prompt_build error: ${err?.message || err}`);
          return undefined; // JANGAN pernah blokir turn pengguna
        }
      }),
      log,
      'before_prompt_build'
    );

    // ---- 2) Observasi pesan masuk (untuk statistik) --------------------
    tryRegister(() =>
      api.on?.call(api, 'message_received', () => {
        store?.record({ type: 'message' });
      }),
      log,
      'message_received'
    );

    // ---- 3) Flush statistik saat giliran agen selesai ------------------
    tryRegister(() =>
      api.on?.call(api, 'agent_end', () => {
        store?.scheduleFlush();
      }),
      log,
      'agent_end'
    );

    // ---- 4) Tool on-demand untuk agent ---------------------------------
    tryRegister(() => {
      const registerTool =
        api.registerTool?.bind(api) ??
        api.registerAgentTool?.bind(api) ??
        null;
      if (!registerTool) return;
      registerTool({
        name: 'recommend_skills',
        description:
          'Cari skill lokal OpenClaw yang paling relevan untuk sebuah permintaan. ' +
          'Gunakan sebelum mengerjakan tugas yang mungkin sudah punya skill panduan.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Kalimat kebutuhan pengguna, mis. "buat laporan PDF penjualan"',
            },
            top_k: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
          },
          required: ['query'],
          additionalProperties: false,
        },
        async execute(_id, params) {
          const query = String(params?.query ?? '').trim();
          if (!query) {
            return textResult('Parameter query wajib diisi.');
          }
          store?.record({ type: 'tool_call' });
          const topK = clampInt(params?.top_k ?? 3, 1, 10);
          const matches = await findMatches(query, { withSemantic: true });
          const pool = (matches || []).slice(0, topK);
          if (!pool.length) {
            return textResult(`Tidak ada skill lokal yang cocok untuk: "${query}"`);
          }
          for (const m of pool) {
            store?.record({ type: 'recommend', skill: m.record.name, score: m.score });
          }
          const lines = [
            `Skill relevan untuk "${query}" (${pool.length}):`,
            ...pool.map(
              (m, i) =>
                `${i + 1}. ${m.record.displayName || m.record.name} [skor ${Number(m.score).toFixed(2)}]${
                  m.reason ? ` — ${m.reason}` : ''
                }\n   ${String(m.record.description || '').replace(/\s+/g, ' ').slice(0, 160)}\n   Panduan: ${m.record.file}`
            ),
            '',
            'Buka SKILL.md panduan di atas dan ikuti instruksinya bila tugas memang sesuai.',
          ];
          return textResult(lines.join('\n'));
        },
      });
    }, log, 'registerTool(recommend_skills)');

    // ---- 5) Command /skills --------------------------------------------
    if (cfg.commands.enabled && typeof api.registerCommand === 'function') {
      tryRegister(() =>
        api.registerCommand({
          name: 'skills',
          description: 'Skill Optimizer: daftar/reload/statistik skill terdeteksi.',
          acceptsArgs: true,
          handler: async (ctx) => {
            try {
              const argsRaw = String(ctx?.args ?? '').trim();
              const [sub, ...rest] = argsRaw.split(/\s+/);
              const argStr = rest.join(' ').trim();
              switch ((sub || 'list').toLowerCase()) {
                case 'list': {
                  const records = await scanner.ensureFresh();
                  if (!records.length) {
                    return cmdOut(
                      'Tidak ada skill terdeteksi.\nPastikan folder skills berisi subfolder dengan SKILL.md ' +
                        '(contoh: ~/.openclaw/skills/<nama>/SKILL.md), atau set scanPaths pada config plugin.'
                    );
                  }
                  const lines = [`📚 ${records.length} skill terdeteksi:\n`];
                  for (const r of records) {
                    lines.push(`• ${r.displayName}${r.displayName !== r.name ? ` (${r.name})` : ''}`);
                    if (r.description) lines.push(`  ${String(r.description).replace(/\s+/g, ' ').slice(0, 110)}`);
                    lines.push(`  ${r.dir}`);
                    if (r.keywords?.length) lines.push(`  tag: ${r.keywords.slice(0, 6).join(', ')}`);
                  }
                  lines.push('\n/skills find <kata> uji pencarian • /skills reload rescan • /skills stats laporan');
                  return cmdOut(lines.join('\n'));
                }
                case 'find': {
                  if (!argStr) return cmdOut('Pemakaian: /skills find <kata kunci>');
                  const matches = await findMatches(argStr, { withSemantic: true });
                  if (!matches.length) {
                    return cmdOut(`Tidak ada skill cocok untuk "${argStr}".`);
                  }
                  const lines = [`🔍 Hasil untuk "${argStr}":\n`];
                  for (const m of matches) {
                    lines.push(
                      `• ${m.record.displayName} — skor ${Number(m.score).toFixed(2)}${m.reason ? ` (${m.reason})` : ''}`
                    );
                  }
                  return cmdOut(lines.join('\n'));
                }
                case 'reload': {
                  await scanner.reload();
                  const n = await rebuildIndex();
                  return cmdOut(`✅ Re-scan selesai: ${n.length} skill terindeks.`);
                }
                case 'stats': {
                  if (!store) return cmdOut('Statistik dimatikan lewat config (stats.enabled=false).');
                  const records = await scanner.ensureFresh();
                  store.scheduleFlush();
                  return cmdOut(formatSummary(store.summarize(records.map((r) => r.name))));
                }
                default:
                  return cmdOut('Sub-perintah: list | find <kata> | reload | stats');
              }
            } catch (err) {
              log.warn(`/skills error: ${err?.message || err}`);
              return cmdOut(`⚠️ /skills gagal: ${err?.message || err}`);
            }
          },
        })
      , log, 'registerCommand(/skills)');
    } else if (cfg.commands.enabled) {
      log.debug('api.registerCommand tidak tersedia di host ini — command dilewati.');
    }

    // ---- 6) Lifecycle: flush di stop -----------------------------------
    tryRegister(() => {
      api.lifecycle?.registerRuntimeLifecycle?.({
        onStop: async () => {
          await store?.flush().catch(() => {});
        },
      });
    }, log, 'lifecycle');

    log.info('[skill-optimizer] registrasi selesai');
  },
});

// ---------------------------------------------------------------------------
// Util kecil
// ---------------------------------------------------------------------------

function tryRegister(fn, log, label) {
  try {
    fn();
  } catch (err) {
    log.warn(`[skill-optimizer] registrasi ${label} gagal: ${err?.message || err}`);
  }
}

function makeLogger(api) {
  const base = api?.logger && typeof api.logger === 'object' ? api.logger : {};
  const noop = () => {};
  return {
    info: base.info?.bind(base) ?? console.info.bind(console),
    warn: base.warn?.bind(base) ?? console.warn.bind(console),
    error: base.error?.bind(base) ?? console.error.bind(console),
    debug: base.debug?.bind(base) ?? noop,
  };
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function cmdOut(text) {
  return { text };
}
