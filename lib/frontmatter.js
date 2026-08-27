/**
 * Parser frontmatter minimal untuk file SKILL.md.
 * Mendukung subset YAML yang umum dipakai skill:
 *   ---
 *   name: nama-skill
 *   description: "Deskripsi singkat"
 *   keywords: [pdf, dokumen, laporan]
 *   tags: doc,pdf
 *   metadata:
 *     version: "1.0"
 *   ---
 *
 * Aturan parser (sengaja sederhana & aman):
 *  - key: value di baris tunggal
 *  - nilai boleh dibungkus kutip tunggal/ganda
 *  - array inline [a, b, c] atau dipisah koma untuk keys/tags
 *  - baris indentasi setelah key tanpa nilai DILEWATI (tidak crash)
 */

/**
 * @param {string} content isi lengkap SKILL.md
 * @returns {{ attrs: Record<string,string|string[]>, body: string }}
 */
export function parseFrontmatter(content) {
  const text = String(content || '');
  const attrs = {};
  if (!text.startsWith('---')) {
    return { attrs, body: text };
  }
  const end = findClosingDelimiter(text);
  if (end < 0) {
    // Pembuka tanpa penutup: perlakukan seluruh isi sebagai body.
    return { attrs, body: text };
  }
  const block = text.slice(3, end);
  const body = text.slice(end + 3).replace(/^\s*\n/, '');
  let pendingKey = null;
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const indented = /^\s/.test(rawLine);
    const line = rawLine.trim();
    if (!line || line === '---') continue;
    if (indented && pendingKey && !attrs[pendingKey]) {
      // Struktur bersarang tidak dibaca penuh; tandai agar tidak kosong.
      continue;
    }
    pendingKey = null;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let value = cleanQuotes(m[2].trim());
    if (value === '' ) {
      pendingKey = key;
      attrs[key] = '';
      continue;
    }
    attrs[key] = normalizeValue(value, key);
  }
  return { attrs, body };
}

function findClosingDelimiter(text) {
  // Cari "\n---" pertama setelah pembuka.
  const idx = text.indexOf('\n---', 3);
  if (idx < 0) return -1;
  return idx;
}

function cleanQuotes(v) {
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function normalizeValue(value, key) {
  const v = value;
  // Array inline [a, b]
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitList(inner);
  }
  // Beberapa skill menulis "keywords: pdf, laporan" tanpa kurung
  if (/^(keywords?|tags?|aliases)$/.test(key || '')) {
    return splitList(v);
  }
  return v;
}

function splitList(inner) {
  return inner
    .split(',')
    .map((s) => cleanQuotes(s.trim()))
    .filter(Boolean)
    .flatMap((s) => (s.includes(',') ? s.split(',').map((x) => x.trim()) : [s]))
    .filter(Boolean);
}

/**
 * Ambil daftar string dari attr list-like dengan fallback cerdas.
 */
export function asList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value) return [];
  return value
    .split(/[,;]/)
    .map((s) => cleanQuotes(s.trim()))
    .filter(Boolean);
}
