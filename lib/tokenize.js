/**
 * Stopwords ringan untuk bahasa Inggris + Indonesia.
 * Digunakan tokenizer untuk membuang kata yang tidak membantu pencocokan skill.
 */

export const STOPWORDS = new Set([
  // Bahasa Indonesia
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'pada', 'ini', 'itu',
  'adalah', 'akan', 'atau', 'juga', 'bisa', 'agar', 'karena', 'supaya', 'saat',
  'ada', 'para', 'saya', 'kamu', 'dia', 'kami', 'kita', 'mereka', 'nya',
  'tidak', 'buatkan', 'tolong', 'mohon', 'coba', 'aja', 'saja', 'kalau',
  'gimana', 'bagaimana', 'kenapa', 'apa', 'siapa', 'dimana', 'kapan',
  'boleh', 'mau', 'pengen', 'ingin', 'perlu', 'harus', 'udah', 'belum',
  // Bahasa Inggris
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by',
  'from', 'as', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you',
  'he', 'she', 'we', 'they', 'my', 'your', 'our', 'their', 'me', 'him',
  'her', 'them', 'do', 'does', 'did', 'can', 'could', 'should', 'would',
  'will', 'shall', 'may', 'might', 'must', 'have', 'has', 'had',
  'please', 'how', 'what', 'when', 'where', 'which', 'who', 'why',
  'there', 'here', 'about', 'into', 'over', 'under', 'some', 'any',
]);

/**
 * Tokenisasi teks bebas: huruf/angka saja, lowercase, min 2 karakter,
 * buang stopwords dan angka murni.
 */
export function tokenize(text) {
  if (!text) return [];
  const raw = String(text)
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f]+/i)
    .filter(Boolean);
  const out = [];
  for (const tok of raw) {
    if (tok.length < 2) continue;
    if (/^\d+$/.test(tok)) continue;
    if (STOPWORDS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

/**
 * Ambil n token paling sering muncul dari sebuah dokumen.
 */
export function topTokens(tokens, n) {
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
}
