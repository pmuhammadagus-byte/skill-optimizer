/**
 * Penyimpan statistik pemakaian (JSON, write atomik + debounce).
 * Mencatat: rekomendasi per skill, pemanggilan tool, fallback LLM,
 * dan jumlah pesan masuk. Ringan — tidak menyimpan isi pesan.
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultStatsFile() {
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.openclaw', 'skill-optimizer', 'usage-stats.json');
}

const FLUSH_DELAY_MS = 1500;
const DAY_MS = 24 * 60 * 60 * 1000;

export class UsageStore {
  constructor(opts = {}) {
    this.file = opts.file || defaultStatsFile();
    this.maxEntries = Math.max(500, Number(opts.maxEntries) || 5000);
    this.data = { events: [], skills: {} };
    this._dirty = false;
    this._timer = null;
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.events)) {
        parsed.skills = parsed.skills && typeof parsed.skills === 'object' ? parsed.skills : {};
        this.data = parsed;
      }
    } catch {
      /* belum ada file / korup -> mulai baru */
    }
    return this;
  }

  /** @param {{type:string, skill?:string, score?:number, provider?:string}} ev */
  record(ev) {
    const entry = { ts: Date.now(), type: ev.type };
    if (ev.skill) entry.skill = String(ev.skill).slice(0, 80);
    if (Number.isFinite(ev.score)) entry.score = Math.round(ev.score * 1000) / 1000;
    if (ev.provider) entry.provider = ev.provider;
    this.data.events.push(entry);
    if (this.data.events.length > this.maxEntries) {
      this.data.events.splice(0, this.data.events.length - this.maxEntries);
    }
    if (entry.skill) {
      const s = (this.data.skills[entry.skill] ||= { recommended: 0, used: 0, lastAt: 0 });
      if (ev.type === 'recommend') s.recommended++;
      if (ev.type === 'tool_call' || ev.type === 'recommend') s.lastAt = entry.ts;
    }
    this.scheduleFlush();
  }

  scheduleFlush() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch(() => {});
    }, FLUSH_DELAY_MS);
    // Jangan tahan proses agar tetap hidup hanya untuk flush.
    this._timer.unref?.();
  }

  async flush() {
    if (!this._dirty) return false;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.data));
    await fsp.rename(tmp, this.file); // atomik
    this._dirty = false;
    return true;
  }

  /**
   * @param {{ names?: string[] }} known list nama semua skill terdeteksi
   */
  summarize(known = []) {
    const events = this.data.events || [];
    const bySkill = new Map();
    let recommendTurns = 0;
    let llmFallbacks = 0;
    let toolCalls = 0;
    for (const e of events) {
      if (e.type === 'recommend') {
        recommendTurns++;
        if (e.skill) inc(bySkill, e.skill);
      } else if (e.type === 'llm_fallback') llmFallbacks++;
      else if (e.type === 'tool_call') toolCalls++;
    }
    const topSkills = [...bySkill.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count }));

    const knownNames = new Set(known.map(String));
    const unused = [...knownNames].filter((n) => !bySkill.has(n)).sort();

    // Aktivitas 14 hari terakhir
    const days = [];
    const now = Date.now();
    for (let i = 13; i >= 0; i--) {
      const start = new Date(Math.floor((now - i * DAY_MS) / DAY_MS) * DAY_MS).getTime();
      const end = start + DAY_MS;
      days.push(events.filter((e) => e.ts >= start && e.ts < end).length);
    }

    return {
      totalEvents: events.length,
      recommendTurns,
      distinctSkillsRecommended: bySkill.size,
      totalKnown: knownNames.size,
      llmFallbacks,
      toolCalls,
      topSkills,
      unused,
      last14Days: days,
      file: this.file,
    };
  }
}

function inc(map, k) {
  map.set(k, (map.get(k) || 0) + 1);
}

/** Render ringkasan menjadi teks multi-baris untuk balasan command. */
export function formatSummary(s) {
  const lines = [];
  lines.push('📊 Statistik Skill Optimizer');
  lines.push(`File data : ${s.file}`);
  lines.push(
    `Total     : ${s.totalEvents} event | ${s.recommendTurns} giliran dengan rekomendasi | ${s.toolCalls} panggilan tool recommend_skills`
  );
  if (s.llmFallbacks > 0) {
    lines.push(`LLM fallback dipakai ${s.llmFallbacks}x (semantic matching aktif)`);
  } else {
    lines.push('LLM fallback belum pernah dipakai (keyword TF-IDF menang terus)');
  }
  if (s.topSkills.length) {
    lines.push('\n🏆 Top skill direkomendasikan:');
    for (const t of s.topSkills) {
      lines.push(`  • ${t.name} — ${t.count}x`);
    }
  } else {
    lines.push('\nBelum ada skill yang direkomendasikan.');
  }
  const covered =
    s.totalKnown > 0 ? Math.round(((s.totalKnown - s.unused.length) / s.totalKnown) * 100) : 0;
  lines.push(
    `\nCakupan   : ${s.totalKnown - s.unused.length}/${s.totalKnown} skill pernah relevan (${covered}%)`
  );
  if (s.unused.length) {
    const show = s.unused.slice(0, 12);
    lines.push(`💤 Belum tersentuh (${s.unused.length}): ${show.join(', ')}${s.unused.length > show.length ? ', …' : ''}`);
    lines.push('   Pertimbangkan menghapus skill tak terpakai agar prompt agent lebih ramping.');
  }
  return lines.join('\n');
}
