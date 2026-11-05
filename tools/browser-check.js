// 실제 브라우저(Chrome/Edge 헤드리스)로 index.html을 열어 확인하는 도구.
// 사용법: node tools/browser-check.js [브라우저 실행 파일 경로] [스크린샷 폴더]
// 외부 패키지 없이 Node 22 내장 WebSocket으로 Chrome DevTools Protocol에 직접 연결한다.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BROWSER = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = process.argv[3] || path.join(os.tmpdir(), 'bouncy-star-shots');
const PORT = 9333;
const PAGE = 'file:///' + path.join(__dirname, '..', 'index.html').replace(/\\/g, '/');
fs.mkdirSync(SHOTS, { recursive: true });

const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`); };

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-profile-'));
  const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1280,720', '--no-first-run', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await wait(200);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch (e) { /* 아직 안 뜸 */ }
  }
  if (!target) { console.error('브라우저 연결 실패'); proc.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) errors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(msg.params.entry.text);
  });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const key = async (code, keyName, holdMs = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyName });
    if (holdMs) await wait(holdMs);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyName });
  };

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: PAGE });
  await wait(1200);

  check('타이틀 화면 표시', await evaluate(`state === 'title' && !document.getElementById('screen-title').hidden`));
  await shot('1-title');

  await evaluate(`document.getElementById('btn-start').click()`);
  await wait(300);
  check('시작 → 1스테이지 플레이', await evaluate(`state === 'play' && world.index === 0`));

  const x0 = await evaluate('world.ball.x');
  await key('ArrowRight', 'ArrowRight', 700);
  const x1 = await evaluate('world.ball.x');
  check('→ 키로 오른쪽 이동', x1 > x0 + 50, `${x0.toFixed(0)} → ${x1.toFixed(0)}`);
  await wait(900);
  const vxAfter = await evaluate('Math.abs(world.ball.vx)');
  check('키를 떼면 멈춤', vxAfter < 0.1, `|vx|=${vxAfter.toFixed(3)}`);
  await shot('2-play');

  // 공이 계속 튀는지: 2초 동안 바닥 근처에 머물러 있지 않고 위아래로 움직이는지
  const ys = [];
  for (let i = 0; i < 20; i++) { ys.push(await evaluate('world.ball.y')); await wait(50); }
  check('공이 저절로 튐', Math.max(...ys) - Math.min(...ys) > 60, `높이 변화 ${(Math.max(...ys) - Math.min(...ys)).toFixed(0)}px`);

  await key('Escape', 'Escape');
  await wait(100);
  const fPause = await evaluate('world.frame');
  await wait(500);
  check('Esc 일시정지 (물리 멈춤)', await evaluate(`state === 'pause'`) && (await evaluate('world.frame')) === fPause);
  await shot('3-pause');
  await key('KeyP', 'p');
  await wait(100);
  check('P로 다시 진행', await evaluate(`state === 'play'`));

  const before = await evaluate(`world.level.stars[0].taken = true; world.level.grid[12][0] = '.'; attempts`);
  await key('KeyR', 'r');
  await wait(100);
  check('R 재시작 → 별·블록 복구, 시도 +1', await evaluate(`!world.level.stars[0].taken && world.level.grid[12][0] === '#' && attempts === ${before + 1}`));

  // 144Hz 모니터 흉내: 6.94ms 간격으로 1초어치(144번) 그려도 물리는 60번만
  const fa = await evaluate(`(() => { const f0 = world.frame; let t = last; for (let i = 0; i < 144; i++) { t += 1000 / 144; frame(t); } return world.frame - f0; })()`);
  check('144Hz에서도 물리 1초 = 60프레임', fa >= 59 && fa <= 61, `${fa}프레임`);
  const fb = await evaluate(`(() => { const f0 = world.frame; let t = last; for (let i = 0; i < 60; i++) { t += 1000 / 60; frame(t); } return world.frame - f0; })()`);
  check('60Hz에서 물리 1초 = 60프레임', fb >= 59 && fb <= 61, `${fb}프레임`);

  // 클리어 흐름: 별을 모두 먹은 상태로 만들기
  await evaluate(`world.level.stars.forEach(s => s.taken = true)`);
  await wait(1500);
  check('별 전부 → 클리어 팝업', await evaluate(`state === 'clear' && !document.getElementById('screen-clear').hidden`));
  check('localStorage에 진행 저장', (await evaluate(`localStorage.getItem('bouncy-star.v1')`) || '').includes('"cleared":[0]'));
  await shot('4-clear');
  await evaluate(`document.getElementById('btn-next').click()`);
  await wait(200);
  check('다음 스테이지로 이동', await evaluate(`state === 'play' && world.index === 1`));

  // 떨어지면 실패 → 자동 재시작
  await evaluate(`world.ball.y = 900`);
  await wait(1200);
  check('낙사 → 자동 재시작', await evaluate(`world.status === 'playing' && attempts === 2`));

  // 모든 스테이지 맵 그리기 (스크린샷)
  for (let i = 0; i < await evaluate('STAGES.length'); i++) {
    await evaluate(`startStage(${i})`);
    await wait(250);
    await shot(`stage-${String(i + 1).padStart(2, '0')}`);
  }

  // 마지막 스테이지 클리어 → 엔딩
  await evaluate(`STAGES.forEach((_, i) => progress.cleared.add(i)); startStage(STAGES.length - 1); world.level.stars.forEach(s => s.taken = true)`);
  await wait(1500);
  check('마지막 스테이지 → 엔딩 화면', await evaluate(`state === 'end'`));
  await shot('5-end');

  await evaluate(`setState('select')`);
  await wait(200);
  await shot('6-select');

  // 모바일 세로·가로: 캔버스가 화면 밖으로 잘리지 않는지
  for (const [w, h, name] of [[390, 844, '세로'], [844, 390, '가로']]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await wait(400);
    const r = await evaluate(`(() => { const b = canvas.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom, innerWidth, innerHeight]; })()`);
    check(`모바일 ${name}(${w}×${h}) 잘림 없음`, r[0] >= -0.5 && r[1] >= -0.5 && r[2] <= r[4] + 0.5 && r[3] <= r[5] + 0.5, `캔버스 ${Math.round(r[2] - r[0])}×${Math.round(r[3] - r[1])}`);
    await shot(`7-mobile-${w}x${h}`);
  }

  // 터치: 화면 오른쪽 절반 누르기 → 오른쪽 이동
  await evaluate(`startStage(0)`);
  await wait(200);
  const tx0 = await evaluate('world.ball.x');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 844 * 0.75, y: 380 }] });   // 오른쪽 절반, 캔버스 밖 여백 포함
  await wait(600);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const tx1 = await evaluate('world.ball.x');
  check('터치 오른쪽 절반 → 오른쪽 이동', tx1 > tx0 + 30, `${tx0.toFixed(0)} → ${tx1.toFixed(0)}`);

  // localStorage가 막힌 환경(시크릿 창 흉내): 접근 시 에러를 던지게 하고 다시 열기
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });` });
  await send('Page.navigate', { url: PAGE });
  await wait(1000);
  await evaluate(`document.getElementById('btn-start').click()`);
  await wait(300);
  await evaluate(`world.level.stars.forEach(s => s.taken = true)`);
  await wait(1500);
  check('localStorage 차단돼도 실행·클리어 됨', await evaluate(`state === 'clear'`));

  check('콘솔 에러 없음', errors.length === 0, errors.slice(0, 5).join(' | '));
  console.log(`스크린샷: ${SHOTS}`);
  ws.close();
  proc.kill();
  process.exit(results.every(r => r.ok) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
