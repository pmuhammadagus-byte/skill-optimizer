/**
 * Scanner skill lokal.
 *
 * Mendeteksi semua subfolder yang berisi SKILL.md di lokasi standar OpenClaw
 * (termasuk hasil `openclaw skills install` dari ClawHub) dan lokasi tambahan
 * dari konfigurasi. Prioritas duplikat: urutan scan — path lebih awal menang.
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter, asList } from './frontmatter.js';
import { tokenize, topTokens } from './tokenize.js';

/** Lokasi bawaan mengikuti konvensi OpenClaw (Workspace > Local > Global > Claude-compatible). */
export function defaultScanPaths() {
  const home = process.env.HOME || os.homedir();
  return [
    path.join(process.cwd(), 'skills'),
    path.join(home, '.openclaw', 'workspace', 'skills'),
    path.join(home, '.openclaw', 'skills'),
    path.join(home, '.claude', 'skills'),
  ];
}

const BODY_SAMPLE_CHARS = 1500;
const BODY_TOKEN_LIMIT = 18;
const SCAN_TTL_MS = 60_000;

/**
 * @typedef {Object} SkillRecord
 * @property {string} name        nama unik skill (dari frontmatter atau nama folder)
 * @property {string} displayName nama tampilan
 * @property {string} description deskripsi dari frontmatter (atau potongan body)
 * @property {string[]} keywords  kata kunci gabungan (keywords/tags/aliases)
 * @property {[string, number][]} terms token utama dokumen beserta frekuensinya
 * @property {string} dir         folder skill
 * @property {string} file        path lengkap SKILL.md
 * @property {string} source      root folder asal
 * @property {number} mtime       waktu modifikasi file
 */

export class SkillScanner {
  /**
   * @param {{ scanPaths?: string[], includeDefaultPaths?: boolean, logger?: object }} opts
   */
  constructor(opts = {}) {
    this.opts = opts;
    this._records = [];
    /** @type {Map<string, string>} name -> signature perubahan */
    this._signatures = new Map();
    this._lastScan = 0;
    this._inflight = null;
    this._firstScanDone = false;
  }

  pathsToScan() {
    const extra = (this.opts.scanPaths || []).map((p) => p.trim()).filter(Boolean);
    if (this.opts.includeDefaultPaths === false) return extra;
    return [...extra, ...defaultScanPaths()];
  }

  async ensureFresh(force = false) {
    if (this._inflight) return this._inflight;
    const age = Date.now() - this._lastScan;
    if (!force && this._firstScanDone && age < SCAN_TTL_MS) {
      return this._records;
    }
    this._inflight = this.#scan().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  reload() {
    return this.ensureFresh(true);
  }

  recordsSync() {
    return this._records;
  }

  async #scan() {
    const found = [];
    const signatures = new Map();
    for (const root of this.pathsToScan()) {
      let entries;
      try {
        entries = await fsp.readdir(root, { withFileTypes: true });
      } catch {
        continue; // Folder tidak ada atau tak bisa dibaca → lewati tanpa suara.
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        signatures.set(ent.name, '');
        const record = await readSkillDir(path.join(root, ent.name), ent.name, root);
        if (record && !found.some((r) => r.name === record.name)) {
          found.push(record);
          signatures.set(ent.name, `${record.file}`);
        }
      }
    }
    this._records = found;
    this._signatures = signatures;
    this._lastScan = Date.now();
    this._firstScanDone = true;
    if (this.opts.logger?.debug) {
      this.opts.logger.debug(`[skill-optimizer] ${found.length} skill terdeteksi`);
    }
    return found;
  }
}

/** Baca satu folder skill menjadi SkillRecord (null bila bukan skill). */
async function readSkillDir(dir, folderName, sourceRoot) {
  const file = path.join(dir, 'SKILL.md');
  let content;
  try {
    content = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const { attrs, body } = parseFrontmatter(content);
  const fmName = typeof attrs.name === 'string' ? attrs.name.trim() : '';
  const name = slugify(fmName || folderName);
  const description =
    (typeof attrs.description === 'string' ? attrs.description.trim() : '') ||
    firstSentence(body);
  const keywords = [
    ...asList(attrs.keywords),
    ...asList(attrs.keyword),
    ...asList(attrs.tags),
    ...asList(attrs.aliases),
  ];

  // Token dokumen: nama + deskripsi + kata kunci + sampel body.
  const docTokens = tokenize(
    [name.replace(/-/g, ' '), description, keywords.join(' '), sampleBody(body)].join(' ')
  );
  const freqTop = topTokens(docTokens, BODY_TOKEN_LIMIT);
  // Bobot ekstra untuk token yang muncul di nama/deskripsi/keyword.
  const headlineTokens = new Set(
    tokenize(`${name.replace(/-/g, ' ')} ${description} ${keywords.join(' ')}`)
  );
  const terms = [];
  for (const [tok, count] of freqTop) {
    terms.push([tok, count + (headlineTokens.has(tok) ? count : 0)]);
  }
  return {
    name,
    displayName: fmName || folderName,
    description,
    keywords,
    terms,
    dir,
    file,
    source: sourceRoot,
    mtime: Date.now(),
  };
}

function sampleBody(body) {
  const clean = String(body || '').replace(/^#.*$/gm, ' ').replace(/[*_`>]/g, ' ');
  return clean.slice(0, BODY_SAMPLE_CHARS);
}

function firstSentence(body) {
  const clean = String(body || '')
    .replace(/^#+\s.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const cut = clean.split(/[.!?\n]/)[0].trim();
  return cut.length > 160 ? cut.slice(0, 157) + '…' : cut;
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed-skill';
}
