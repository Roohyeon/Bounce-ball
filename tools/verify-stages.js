// 모든 스테이지가 "실제로 깰 수 있는지" 자동으로 확인하는 도구.
// 사용법: node tools/verify-stages.js            (전체)
//         node tools/verify-stages.js 3 5        (3번, 5번 스테이지만)
//
// 방식: index.html 안의 "// ==SIM START== ~ // ==SIM END==" 구간(게임 물리 코드)을
//       그대로 잘라 와서 실행한다 → 게임과 똑같은 물리로 검증된다.
//       입력(왼쪽/가만히/오른쪽)을 6프레임 단위로 바꿔 가며 탐색하고,
//       별을 많이 먹은 상태부터 먼저 펼쳐 본다(최선 우선 탐색).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/\/\/ ==SIM START==([\s\S]*?)\/\/ ==SIM END==/);
if (!m) { console.error('index.html에서 SIM 구간을 찾지 못함'); process.exit(1); }
const context = vm.createContext({ Math, Error, Set, Map, Array, JSON });
const sim = vm.runInContext(m[1] + '\n;({ STAGES, createWorld, stepWorld, PHYS })', context);

const CHUNK = 6;               // 한 번 고른 입력을 유지하는 프레임 수
const ACTIONS = [-1, 0, 1];
const MAX_NODES = 1500000;

function clone(w) {
  const L = w.level;
  const level = Object.assign(Object.create(Object.getPrototypeOf(L)), L);
  level.grid = L.grid.map(r => r.slice());
  level.stars = L.stars.map(s => ({ ...s }));
  level.crumbling = new Map(L.crumbling);
  const ball = Object.assign(Object.create(Object.getPrototypeOf(w.ball)), w.ball);
  if (w.ball.portalLock) ball.portalLock = { ...w.ball.portalLock };
  return { ...w, level, ball };
}

function solve(index) {
  const start = sim.createWorld(index);
  const crumbleCells = [];
  start.level.grid.forEach((row, r) => row.forEach((ch, c) => { if (ch === 'C') crumbleCells.push([r, c]); }));
  const key = w => {
    const b = w.ball;
    const stars = w.level.stars.map(s => (s.taken ? 1 : 0)).join('');
    const crumbles = crumbleCells.map(([r, c]) => (w.level.grid[r][c] === 'C' ? (w.level.crumbling.has(r * 24 + c) ? 2 : 1) : 0)).join('');
    return `${Math.round(b.x / 5)},${Math.round(b.y / 5)},${Math.round(b.vx)},${Math.round(b.vy / 2)},${b.dash},${b.portalLock ? 1 : 0},${stars},${crumbles}`;
  };

  const total = start.level.stars.length;
  const buckets = Array.from({ length: total + 1 }, () => []);
  const heads = new Array(total + 1).fill(0);
  buckets[0].push({ w: start, path: [] });
  const seen = new Set([key(start)]);
  let nodes = 0, best = 0, bestMask = '';

  while (nodes < MAX_NODES) {
    let k = total;
    while (k >= 0 && heads[k] >= buckets[k].length) k--;
    if (k < 0) break;
    const node = buckets[k][heads[k]++];
    nodes++;
    for (const a of ACTIONS) {
      const w = clone(node.w);
      for (let i = 0; i < CHUNK && w.status === 'playing'; i++) sim.stepWorld(w, a);
      if (w.status === 'dead') continue;
      const path = node.path.concat(a);
      if (w.status === 'clear') return { ok: true, frames: w.frame, nodes, path };
      const kk = key(w);
      if (seen.has(kk)) continue;
      seen.add(kk);
      const got = total - w.level.starsLeft;
      if (got > best) { best = got; bestMask = w.level.stars.map(s => (s.taken ? '★' : '·')).join(''); }
      buckets[got].push({ w, path });
    }
  }
  return { ok: false, nodes, best, total, bestMask };
}

const only = process.argv.slice(2).map(n => Number(n) - 1);
let failed = 0;
sim.STAGES.forEach((stage, i) => {
  if (only.length && !only.includes(i)) return;
  const t0 = Date.now();
  const r = solve(i);
  const ms = Date.now() - t0;
  if (r.ok) {
    console.log(`✔ Stage ${i + 1} "${stage.name}" 클리어 가능 — ${(r.frames / 60).toFixed(1)}초 경로, 탐색 ${r.nodes}개, ${ms}ms`);
  } else {
    failed++;
    console.log(`✘ Stage ${i + 1} "${stage.name}" 클리어 경로 못 찾음 — 최대 별 ${r.best}/${r.total} [${r.bestMask}], 탐색 ${r.nodes}개, ${ms}ms`);
  }
});
process.exit(failed ? 1 : 0);
