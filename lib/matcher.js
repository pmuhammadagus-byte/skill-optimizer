/**
 * Matcher TF-IDF: menghitung relevansi query pengguna terhadap daftar skill.
 *
 * Skor = jumlah tf-idf token query yang cocok dengan dokumen skill,
 * dinormalisasi cosine terhadap ||dokumen||, lalu diberi bonus:
 *  - kecocokan persis nama skill            -> x1.6
 *  - substring nama skill                   -> x1.35
 *  - fuzziness trigram >= 0.7 pada satu tok -> hitung 0.5 * idf token tsb.
 */

import { tokenize } from './tokenize.js';

export class TfIdfMatcher {
  /** @param {import('./scanner.js').SkillRecord[]} records */
  build(records) {
    this.docs = records.map((r) => {
      const tf = new Map();
      for (const [tok, count] of r.terms) tf.set(tok, count);
      return { record: r, tf };
    });
    // Document frequency
    const df = new Map();
    for (const doc of this.docs) {
      for (const tok of doc.tf.keys()) df.set(tok, (df.get(tok) || 0) + 1);
    }
    this.idf = new Map();
    const N = Math.max(this.docs.length, 1);
    for (const [tok, f] of df) {
      this.idf.set(tok, Math.log((N + 1) / (f + 1)) + 1); // smooth idf
    }
    // Norm vektor tiap dokumen
    for (const doc of this.docs) {
      let sum = 0;
      for (const [tok, c] of doc.tf) {
        const w = (c * (this.idf.get(tok) || 1));
        sum += w * w;
      }
      doc.norm = Math.sqrt(sum) || 1;
    }
    return this;
  }

  /**
   * @param {string} query teks permintaan pengguna
   * @param {{ topK?: number, minScore?: number }} opts
   * @returns {{ record, score, matchedTokens }[]}
   */
  search(query, opts = {}) {
    const topK = clampInt(opts.topK ?? 3, 1, 10);
    const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.18;
    if (!this.docs?.length) return [];
    const qTokens = [...new Set(tokenize(query))];
    if (!qTokens.length) return [];

    const results = [];
    for (const doc of this.docs) {
      const { record, tf } = doc;
      let score = 0;
      const matched = [];

      for (const q of qTokens) {
        const idf = this.idf.get(q) || Math.log((this.docs.length + 1) / 2) + 1;
        if (tf.has(q)) {
          score += (tf.get(q) * idf) / doc.norm;
          matched.push(q);
          continue;
        }
        // Fuzzy per-token via jarak Levenshtein normalisasi ke vocab dokumen
        let best = 0;
        let bestTok = null;
        for (const tok of tf.keys()) {
          const sim = levSim(q, tok);
          if (sim > best) {
            best = sim;
            bestTok = tok;
          }
        }
        if (best >= 0.75 && bestTok && this.idf.has(bestTok)) {
          score += (0.5 * tf.get(bestTok) * this.idf.get(bestTok)) / doc.norm;
          matched.push(q);
        }
      }

      if (score <= 0) continue;

      // Bonus nama: token query semua ada dalam nama skill (persis)
      const nameToks = tokenize(record.displayName.replace(/[-_]/g, ' '));
      const nameHit =
        nameToks.length > 0 &&
        qTokens.filter((q) => nameToks.includes(q)).length / Math.max(qTokens.length, 1);

      if (nameToks.join(' ') === qTokens.join(' ')) {
        score *= 1.6; // "pdf editor" vs skill "pdf editor"
      } else if (nameHit >= 0.5) {
        score *= 1.35;
      }

      if (score >= minScore) {
        results.push({ record, score: Math.min(score, 1), matchedTokens: matched });
      }
    }
    results.sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name));
    return results.slice(0, topK);
  }
}

/** Kemiripan 0..1 via jarak Levenshtein ternormalisasi panjang maksimum. */
export function levSim(a, b) {
  a = String(a);
  b = String(b);
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const maxLen = Math.max(la, lb);
  // Satu-per-satu baris DP dengan band |la-lb| penuh — token pendek, murah.
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return 1 - prev[lb] / maxLen;
}

/** Jaccard kemiripan trigram 2 string (0..1). Disimpan untuk analisis. */
export function trigramSim(a, b) {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

function trigrams(s) {
  const t = ` ${String(s)} `;
  const out = new Set();
  if (t.length < 3) {
    out.add(t.trim());
    return out;
  }
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
