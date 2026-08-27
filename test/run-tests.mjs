/**
 * Test harness Skill Optimizer.
 * Jalankan: node --test test/
 *
 * Menguji: frontmatter, tokenizer, scanner, matcher TF-IDF, injector,
 * stats store, semantic parser, dan end-to-end dengan API palsu
 * (registrasi hook/tool/command persis seperti pola OpenClaw).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseFrontmatter } from '../lib/frontmatter.js';
import { tokenize } from '../lib/tokenize.js';
import { SkillScanner } from '../lib/scanner.js';
import { TfIdfMatcher } from '../lib/matcher.js';
import { buildContextBlock } from '../lib/injector.js';
import { UsageStore, formatSummary } from '../lib/stats.js';
import { parseRanked, filterByThreshold } from '../lib/semantic.js';
import { resolveConfig } from '../lib/config.js';

// ---------------------------------------------------------------------------
// Fixture skills di direktori sementara
// ---------------------------------------------------------------------------

const FIXTURES = {
  pdf: `---
name: pdf
description: "Buat dan edit dokumen PDF: laporan, kontrak, merge/split halaman."
keywords: [pdf, dokumen, laporan]
---

# PDF skill
Gunakan skill ini untuk membuat file PDF dari konten Markdown atau template.`,
  chart: `---
name: chart-generator
description: Membuat chart matplotlib/ECharts: bar chart, line chart, pie, heatmap.
tags: grafik, visualisasi, diagram
---

# Chart generator
Render data menjadi grafik PNG atau SVG siap publikasi.`,
  websearch: `---
name: web-search
description: "Cari informasi terbaru di internet: berita, harga, referensi."
---

Web search helper untuk pertanyaan yang butuh data real-time.`,
};

async function makeFixtureDir() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-opt-test-'));
  for (const [name, content] of Object.entries(FIXTURES)) {
    const dir = path.join(root, name);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'SKILL.md'), content, 'utf8');
  }
  return root;
}

// ---------------------------------------------------------------------------
// Unit: frontmatter & tokenizer
// ---------------------------------------------------------------------------

test('parseFrontmatter membaca name/description/keywords inline', () => {
  const { attrs, body } = parseFrontmatter(FIXTURES.pdf);
  assert.equal(attrs.name, 'pdf');
  assert.match(String(attrs.description), /laporan/);
  assert.deepEqual(attrs.keywords, ['pdf', 'dokumen', 'laporan']);
  assert.match(body, /PDF skill/);
});

test('parseFrontmatter tahan file tanpa frontmatter & kutip', () => {
  const plain = '# Halo\nIsi biasa tanpa FM';
  const r1 = parseFrontmatter(plain);
  assert.equal(r1.body, plain);
  const quoted = parseFrontmatter('---\nname: "abc"\ndescription: \'x y\'\n---\nbody');
  assert.equal(quoted.attrs.name, 'abc');
  assert.equal(quoted.attrs.description, 'x y');
});

test('tokenize membuang stopwords & angka murni', () => {
  const toks = tokenize('Buatk an Laporan PDF 2024 untuk saya dengan CHART!!!');
  assert.ok(toks.includes('laporan'));
  assert.ok(toks.includes('pdf'));
  assert.ok(toks.includes('chart'));
  assert.ok(!toks.includes('untuk'));
  assert.ok(!toks.includes('2024'));
});

// ---------------------------------------------------------------------------
// Unit: scanner + matcher
// ---------------------------------------------------------------------------

test('scanner menemukan 3 fixture & matcher mengurutkan relevansi', async () => {
  const root = await makeFixtureDir();
  try {
    const scanner = new SkillScanner({ scanPaths: [root], includeDefaultPaths: false });
    const records = await scanner.ensureFresh(true);
    assert.equal(records.length, 3);
    const names = records.map((r) => r.name).sort();
    assert.deepEqual(names, ['chart-generator', 'pdf', 'web-search']);

    const matcher = new TfIdfMatcher().build(records);

    // Query bahasa Indonesia sehari-hari
    const r1 = matcher.search('tolong buatkan laporan penjualan dalam bentuk pdf', { topK: 3 });
    assert.ok(r1.length >= 1, 'harus menemukan minimal satu match');
    assert.equal(r1[0].record.name, 'pdf');

    const r2 = matcher.search('buat bar chart perbandingan penjualan bulanan', { topK: 3 });
    assert.ok(r2.length >= 1);
    assert.equal(r2[0].record.name, 'chart-generator');

    // Fuzzy typo: "grfik" dekat "grafik"
    const r3 = matcher.search('buatkan grfik batang untuk data mingguan', { topK: 3 });
    assert.ok(r3.length >= 1 && r3[0].record.name === 'chart-generator',
      `fuzzy harus cocok chart, dapat: ${r3.map((x) => x.record.name).join(',')}`);

    // Skor rentang wajar
    for (const m of [...r1, ...r2]) {
      assert.ok(m.score > 0 && m.score <= 1);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('reload memperbarui daftar saat skill baru ditambahkan', async () => {
  const root = await makeFixtureDir();
  try {
    const scanner = new SkillScanner({ scanPaths: [root], includeDefaultPaths: false });
    await scanner.ensureFresh(true);
    assert.equal(scanner.recordsSync().length, 3);
    await fsp.mkdir(path.join(root, 'ocr'), { recursive: true });
    await fsp.writeFile(
      path.join(root, 'ocr', 'SKILL.md'),
      '---\nname: ocr\ndescription: ekstrak teks gambar\n---\nOCR skill',
      'utf8'
    );
    const n = await scanner.reload();
    assert.equal(n.length, 4);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unit: injector
// ---------------------------------------------------------------------------

test('injector membatasi panjang blok dan menyertakan guide path', () => {
  const matches = [
    {
      record: { name: 'pdf', displayName: 'pdf', description: 'Buat PDF laporan', file: '/tmp/pdf/SKILL.md' },
      score: 0.82,
    },
  ];
  const block = buildContextBlock(matches, { query: 'buat pdf', maxChars: 900 });
  assert.ok(block.startsWith('<skill_recommendations'));
  assert.ok(block.includes('/tmp/pdf/SKILL.md'));
  assert.ok(block.includes('0.82'));
  assert.ok(block.endsWith('</skill_recommendations>'));
  // maxChars sangat kecil -> tetap aman (minimal 1 entri)
  const tiny = buildContextBlock(matches, { query: 'q', maxChars: 300 });
  assert.ok(tiny && tiny.includes('- skill: pdf'));
  assert.equal(buildContextBlock([], {}), null);
});

// ---------------------------------------------------------------------------
// Unit: stats
// ---------------------------------------------------------------------------

test('usage store mencatat, merangkum, dan flush ke disk', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-opt-stats-'));
  try {
    const file = path.join(dir, 'stats.json');
    const store = new UsageStore({ file });
    await store.load();
    store.record({ type: 'recommend', skill: 'pdf', score: 0.9 });
    store.record({ type: 'recommend', skill: 'pdf', score: 0.5 });
    store.record({ type: 'recommend', skill: 'chart' });
    store.record({ type: 'tool_call' });
    store.record({ type: 'llm_fallback', provider: 'auto' });
    await store.flush();

    const store2 = await new UsageStore({ file }).load();
    const sum = store2.summarize(['pdf', 'chart', 'web-search']);
    assert.equal(sum.recommendTurns, 3);
    assert.equal(sum.topSkills[0].name, 'pdf');
    assert.deepEqual(sum.unused.sort(), ['web-search']);
    assert.equal(sum.llmFallbacks, 1);
    const text = formatSummary(sum);
    assert.match(text, /pdf/);
    assert.match(text, /Cakupan/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unit: semantic parse
// ---------------------------------------------------------------------------

test('parser output LLM defensif terhadap sampah & skor > 1', () => {
  const candidates = [{ name: 'pdf' }, { name: 'chart-generator' }];
  const raw = 'Blabla berikut hasilnya:\n```json\n[{"name":"pdf","score":87,"reason":"butuh PDF"},{"name":"nyasar","score":0.9}]\n```';
  const ranked = parseRanked(raw, candidates);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].score, 0.87);
  const filtered = filterByThreshold(ranked, 0.5);
  assert.equal(filtered.length, 1);
  assert.equal(parseRanked('bukan json sama sekali', candidates), null);
});

// ---------------------------------------------------------------------------
// End-to-end: fake API ala OpenClaw plugin host
// ---------------------------------------------------------------------------

function createFakeApi(pluginConfig) {
  const hooks = new Map();
  const tools = [];
  const commands = [];
  return {
    hooks,
    tools,
    commands,
    pluginConfig, // dibaca plugin lewat api.pluginConfig
    logs: [],
    logger: {
      info: (...a) => console.log('[fake-api]', ...a),
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    on(event, handler) {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event).push(handler);
      return () => {};
    },
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(def) {
      commands.push(def);
    },
    async fireHook(event, payload) {
      const out = [];
      for (const h of hooks.get(event) || []) out.push(await h(payload, {}));
      return out;
    },
  };
}

test('end-to-end register → injeksi → tool → command', async () => {
  const root = await makeFixtureDir();
  const statsFile = path.join(root, '..', `skill-opt-e2e-${Date.now()}.json`);
  try {
    const entryModule = await import('../index.js');
    const api = createFakeApi({
      scanPaths: [root],
      includeDefaultPaths: false,
      stats: { file: statsFile },
    });

    // register() dipanggil host langsung pada default export
    const entry = entryModule.default;
    assert.equal(typeof entry.register, 'function');
    entry.register(api);

    // 1. Hook before_prompt_build terdaftar & mengembalikan prependContext
    const handlers = api.hooks.get('before_prompt_build');
    assert.ok(handlers?.length === 1, 'harus ada handler before_prompt_build');
    const results = await api.fireHook('before_prompt_build', {
      prompt: 'tolong buatkan laporan penjualan format pdf ya',
    });
    const injected = results[0];
    assert.ok(injected && typeof injected.prependContext === 'string');
    assert.match(injected.prependContext, /- skill: pdf/i);

    // Perintah chat ("/skills list") tidak boleh diinjeksikan
    const cmdResults = await api.fireHook('before_prompt_build', { prompt: '/skills find pdf' });
    assert.equal(cmdResults[0], undefined);

    // Prompt pendek/tanpa match juga dilewati
    const emptyResults = await api.fireHook('before_prompt_build', { prompt: 'halo?' });
    assert.equal(emptyResults[0], undefined);

    // 2. Tool recommend_skills terdaftar & bekerja
    assert.equal(api.tools.length, 1);
    const tool = api.tools[0];
    assert.equal(tool.name, 'recommend_skills');
    assert.equal(tool.parameters.type, 'object');
    const toolRes = await tool.execute('id-1', { query: 'saya butuh grafik batang penjualan', top_k: 2 });
    assert.ok(Array.isArray(toolRes.content));
    const textOut = toolRes.content[0].text;
    assert.match(textOut, /chart-generator/);

    // 3. Command /skills terdaftar
    assert.ok(api.commands.some((c) => c.name === 'skills'));
    const cmdDef = api.commands.find((c) => c.name === 'skills');
    const listRes = await cmdDef.handler({ args: '' });
    assert.match(listRes.text, /terdeteksi/);
    const findRes = await cmdDef.handler({ args: 'find pdf laporan' });
    assert.match(findRes.text, /pdf/i);
    const reloadRes = await cmdDef.handler({ args: 'reload' });
    assert.match(reloadRes.text, /Re-scan|rescan|terindeks/);
    const statsRes = await cmdDef.handler({ args: 'stats' });
    assert.match(statsRes.text, /Statistik/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(statsFile, { force: true }).catch(() => {});
  }
});

test('config resolve menerapkan default & mengabaikan nilai rusak', () => {
  const cfg = resolveConfig({ inject: { topK: '7' }, unknownKey: true, semantic: null });
  assert.equal(cfg.inject.topK, 7);
  assert.equal(cfg.inject.minScore, 0.18);
  assert.equal(cfg.semantic.enabled, true); // semantic null -> tetap default objek
  assert.equal(cfg.commands.enabled, true);
  assert.deepEqual(resolveConfig(undefined), resolveConfig({}));
});
