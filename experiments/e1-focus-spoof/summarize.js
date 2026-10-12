const fs = require('fs');
const path = require('path');
const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => /^e1-result-.*\.json$/.test(f)).sort();
const rows = [];
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { rows.push([f, 'PARSE_ERROR']); continue; }
  const sd = j.snapshotDiff || {};
  const park = j.park || {};
  const cur = j.cursor || {};
  const box = sd.box ? `${sd.box.x},${sd.box.y}-${sd.box.x2},${sd.box.y2}` : '-';
  rows.push([
    f.replace('e1-result-', '').replace('.json', ''),
    `${(j.target || {}).proc}`,
    `${(j.control || {}).class}`,
    j.charMode || '?',
    String(j.charsSent),
    park.note || 'n/a',
    park.targetWasForeground ? 'TG' : '--',
    `${cur.dx}x${cur.dy}`,
    (j.fg || {}).stable ? 'stable' : 'CHANGED',
    sd.available ? String(sd.changedPixels) : 'n/a',
    box,
  ]);
}
const head = ['file', 'proc', 'injected-to', 'mode', 'chars', 'park', 'fgIsTgt', 'cursor', 'fgDur', 'snapPx', 'box'];
rows.unshift(head);
const w = head.map((_, i) => Math.max(...rows.map(r => (r[i] || '').length)));
for (const r of rows) console.log(r.map((c, i) => String(c || '').padEnd(w[i])).join('  '));
