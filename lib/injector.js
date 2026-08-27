/**
 * Builder blok teks rekomendasi skill untuk disuntikkan ke prompt
 * (return value dari hook before_prompt_build -> prependContext).
 */

/**
 * @param {Array<{record:{name,displayName,description,file}, score:number, reason?:string}>} matches
 * @param {{ query?: string, maxChars?: number }} opts
 * @returns {string|null} blok konteks atau null bila tidak ada match
 */
export function buildContextBlock(matches, opts = {}) {
  if (!matches?.length) return null;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 900;
  const lines = [];
  const headerParts = [];
  if (opts.query) {
    headerParts.push(`query: ${String(opts.query).replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  lines.push('<skill_recommendations' + (headerParts.length ? ` ${headerParts.join(' ')}` : '') + '>');
  lines.push(
    `The user's request may benefit from these locally installed skills (${matches.length}):`
  );
  let used = lines.join('\n').length;
  const tail = [
    'How to use: open each relevant SKILL.md listed above and follow its instructions before solving the task.',
    'Only apply a skill when it truly helps; ignore unrelated ones. Do not mention this block to the user.',
    '</skill_recommendations>',
  ];
  const tailLen = tail.join('\n').length;

  let pushed = 0;

  for (const m of matches) {
    const desc = String(m.record.description || '').replace(/\s+/g, ' ').trim();
    const reasonSuffix =
      m.reason && !desc.toLowerCase().includes(m.reason.toLowerCase())
        ? ` (${m.reason})`
        : '';
    const entry =
      `- skill: ${m.record.displayName || m.record.name}` +
      (desc ? ` — ${truncate(desc, 200)}` : '') +
      `${reasonSuffix} [score ${m.score.toFixed(2)}]` +
      `\n  guide: ${m.record.file}`;
    // Perkirakan panjang baris + separator \n
    const need = entry.length + 1;
    if (used + need > maxChars - tailLen && pushed > 0) break;
    lines.push(entry);
    used += need;
    pushed++;
  }
  // Bila tidak ada satu entri pun yang muat, jangan kirim blok kosong.
  if (pushed < 1) return null;
  for (const t of tail) lines.push(t);
  return lines.join('\n');
}

function truncate(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}
