/* Stickman Cricket — a single-file canvas batting game. No build step, no dependencies. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const params = new URLSearchParams(location.search);

  // ---------- helpers ----------
  let seed = parseInt(params.get('seed'), 10) || ((Date.now() % 1000000) + 1);
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => t * t * (3 - 2 * t);
  const pick = (arr) => { const tot = arr.reduce((s, o) => s + o.w, 0); let r = rnd() * tot; for (const o of arr) { if ((r -= o.w) <= 0) return o; } return arr[0]; };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  // ---------- world constants (metres, seconds) ----------
  const G = 9.8;
  const BAT_X = 19.75;      // striker stands here
  const HIT_X = 19.3;       // ideal contact point
  const STUMPS_BAT = 20.12; // striker's stumps
  const NS_X = 0.9;         // non-striker backing up
  const ROPE_X = HIT_X - 65;
  const RELEASE_X = 0.5, RELEASE_Y = 2.25, RELEASE_Z = 0.3;
  const RUN_T = 1.5;        // bowler run-up duration
  const RUN_PER = 1.15;     // seconds per run between wickets
  const FRICTION = 6.5;
  const Z_BAT = -0.5, Z_NS = -0.85, Z_BOWL = 0.4;

  const DIFFS = {
    easy:   { win: 0.20, v: [15, 18.5] },
    normal: { win: 0.15, v: [17.5, 21.5] },
    hard:   { win: 0.105, v: [20.5, 25] },
  };
  const LENGTHS = [
    { name: 'Yorker', xb: 18.4, w: 1 },
    { name: 'Full', xb: 16.2, w: 3 },
    { name: 'Good length', xb: 13.8, w: 4 },
    { name: 'Short', xb: 10.8, w: 2 },
  ];
  const LINES = [
    { name: 'on the stumps', z: 0, w: 5 },
    { name: 'outside off', z: 0.4, w: 3 },
    { name: 'down leg', z: -0.32, w: 1 },
  ];
  const KIT = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#db2777', '#65a30d', '#7c3aed', '#ca8a04', '#0f766e', '#be123c'];

  // ---------- state ----------
  const cfg = {
    overs: parseInt(store.get('sc.overs'), 10) || 2,
    wkts: parseInt(store.get('sc.wkts'), 10) || 5,
    diff: store.get('sc.diff') || 'normal',
    chase: store.get('sc.chase') === '1',
  };
  const S = { screen: 'menu', clock: 0, paused: false, muted: store.get('sc.muted') === '1' };
  const cam = { x: 10.3, s: 40 };
  let W = 0, H = 0, DPR = 1, S0 = 40, GY = 0, HZ = 0;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.round(window.innerWidth * DPR);
    H = Math.round(window.innerHeight * DPR);
    canvas.width = W; canvas.height = H;
    S0 = Math.min(W / 26, H / 11);
    GY = H * 0.66;
    HZ = H * 0.44;
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- match flow ----------
  function newMatch() {
    S.runs = 0; S.wk = 0; S.balls = 0; S.over = []; S.dots = 0;
    S.batters = [];
    for (let i = 0; i < cfg.wkts + 1; i++) S.batters.push({ name: 'Batter ' + (i + 1), runs: 0, balls: 0, fours: 0, sixes: 0, out: '', color: KIT[i % KIT.length] });
    S.striker = 0; S.non = 1; S.next = 2;
    S.target = cfg.chase ? Math.round(cfg.overs * 6 * (1.5 + rnd() * 0.5)) + 1 : 0;
    S.screen = 'play'; S.paused = false;
    cam.x = 10.3; cam.s = S0;
    setupBall();
    showScreen();
    updateHud();
  }

  function setupBall() {
    const d = DIFFS[cfg.diff];
    const L = pick(LENGTHS), Ln = pick(LINES);
    const v = lerp(d.v[0], d.v[1], rnd());
    S.del = { v, xb: L.xb + (rnd() - 0.5) * 0.8, len: L.name, line: Ln.name, z: Ln.z + (rnd() - 0.5) * 0.12, kph: Math.round(v * 6.6) };
    S.ball = { x: RELEASE_X, y: RELEASE_Y, z: RELEASE_Z, vx: 0, vy: 0, vz: 0, state: 'held', bounced: false, alpha: 1, carry: 0 };
    S.phase = 'wait'; S.pt = 0;
    S.tRun = -1; S.tArrive = 0;
    S.swing = null; S.pendingHit = null; S.hit = null; S.run = null;
    S.stumpsT = -1; S.endAt = -1; S.outcome = null; S.boundary = 0; S.missChecked = false;
    S.celebrate = false; S.catchAt = -1; S.timing = '';
    $('ballInfo').textContent = '';
    $('meter').classList.remove('show');
  }

  function release() {
    const d = S.del, b = S.ball;
    const tb = (d.xb - RELEASE_X) / d.v;
    b.state = 'bowled';
    b.x = RELEASE_X; b.y = RELEASE_Y; b.z = RELEASE_Z;
    b.vx = d.v;
    b.vy = (-RELEASE_Y + 0.5 * G * tb * tb) / tb;
    b.vz = (d.z - RELEASE_Z) / ((STUMPS_BAT - RELEASE_X) / d.v);
    S.tArrive = S.clock + (HIT_X - RELEASE_X) / d.v;
    S.phase = 'delivery';
    $('ballInfo').textContent = `${d.len}, ${d.line} · ${d.kph} km/h`;
  }

  // ---------- input / shots ----------
  function shot(type) {
    if (S.screen !== 'play' || S.paused) return;
    audioInit();
    if (S.swing || !(S.phase === 'runup' || S.phase === 'delivery')) return;
    S.swing = { type, t0: S.clock };
    const b = S.ball;
    if (S.phase === 'runup' || b.state !== 'bowled') { S.timing = 'Way too early!'; return; }
    if (b.x > STUMPS_BAT - 0.1) { S.timing = 'Too late!'; return; }
    const contact = S.clock + 0.08;
    const err = contact - S.tArrive;
    const win = DIFFS[cfg.diff].win;
    if (Math.abs(err) <= win) S.pendingHit = { at: contact, type, q: 1 - Math.abs(err) / win, err };
    else S.timing = err < 0 ? 'Too early!' : 'Too late!';
  }

  function doHit() {
    const h = S.pendingHit; S.pendingHit = null;
    const d = S.del, b = S.ball, win = DIFFS[cfg.diff].win;
    let q = h.q;
    if (d.len === 'Yorker') q *= 0.82;
    if (h.type === 'loft' && d.len === 'Short') q = Math.min(1, q * 1.12);
    if (h.type === 'ground' && d.len === 'Short') q *= 0.93;
    const p = clamp(q + (rnd() - 0.5) * 0.12, 0, 1);
    const timing = Math.abs(h.err) < win * 0.2 ? 'Perfect timing!' : h.err < 0 ? 'A touch early' : 'A touch late';
    b.x = Math.min(b.x, 19.9); b.y = Math.max(b.y, 0.3);
    b.state = 'hit'; b.bounced = false;
    S.phase = 'hit';
    S.hit = { type: h.type, p, timing };
    snd('bat', p);
    $('meterFill').style.width = Math.round(p * 100) + '%';
    $('meter').classList.add('show');

    const theta = (rnd() - 0.5) * 0.6;
    if (h.type === 'ground' && q < 0.3 && Math.abs(d.z) > 0.25 && rnd() < 0.45) {
      // thick edge to the keeper
      b.vx = 13; b.vy = 2.2; b.vz = 0.6;
      S.hit.kind = 'edge'; S.catchAt = S.clock + 0.2;
      return;
    }
    if (h.type === 'ground') {
      const runs = p < 0.22 ? 0 : p < 0.42 ? 1 : p < 0.6 ? 2 : p < 0.77 ? 3 : 4;
      const D = [2 + rnd() * 3, 13 + rnd() * 6, 25 + rnd() * 6, 37 + rnd() * 6, 76][runs];
      const v0 = Math.sqrt(2 * FRICTION * D);
      b.vx = -v0 * Math.cos(theta); b.vz = v0 * Math.sin(theta) * 0.6; b.vy = 1 + p * 1.5;
      S.hit.kind = 'ground'; S.hit.runs = runs;
      if (runs > 0 && runs < 4) S.run = { n: runs, start: S.clock + 0.3 };
      return;
    }
    // lofted
    let D, T, kind;
    if (p >= 0.7) { D = 76 + rnd() * 16; T = 2.9 + rnd() * 0.5; kind = 'six'; }
    else if (p >= 0.5) { D = 50 + rnd() * 8; T = 2.5; kind = 'loft4'; }
    else if (rnd() < 0.68) { D = 22 + p * 45; T = 3.3; kind = 'caught'; S.catchAt = S.clock + T * 0.9; }
    else { D = 24 + rnd() * 8; T = 2.6; kind = 'safe'; S.run = { n: 2, start: S.clock + 0.4 }; }
    b.vx = -(D / T) * Math.cos(theta); b.vz = (D / T) * Math.sin(theta) * 0.6;
    b.vy = (G * T) / 2 - b.y / T;
    S.hit.kind = kind; S.hit.dist = Math.round(D + (kind === 'six' ? 0 : 0));
  }

  function finish(outcome, delay) {
    if (S.outcome) return;
    S.outcome = outcome;
    S.endAt = S.clock + delay;
  }

  function endBall() {
    const o = S.outcome;
    const bt = S.batters[S.striker];
    S.balls++; bt.balls++; bt.runs += o.runs; S.runs += o.runs;
    if (o.runs === 4) bt.fours++;
    if (o.runs === 6) bt.sixes++;
    if (o.runs === 0 && !o.out) S.dots++;
    S.over.push(o.out ? 'W' : o.runs === 0 ? '•' : String(o.runs));
    if (o.out) {
      S.wk++; bt.out = o.how;
      if (S.next < S.batters.length) S.striker = S.next++;
    } else if (o.runs % 2 === 1) {
      [S.striker, S.non] = [S.non, S.striker];
    }
    const overDone = S.balls % 6 === 0;
    if (overDone) [S.striker, S.non] = [S.non, S.striker];
    S.phase = 'between'; S.pt = 0; S.overDone = overDone; S.run = null;
    const done = S.wk >= cfg.wkts || S.balls >= cfg.overs * 6 || (S.target && S.runs >= S.target);
    S.inningsDone = done;
    if (overDone && !done) setTimeout(() => banner('End of over', `${S.runs}/${S.wk} after ${S.balls / 6} ${S.balls / 6 === 1 ? 'over' : 'overs'}`, ''), 650);
    updateHud();
  }

  function banner(main, sub, cls) {
    const el = $('banner');
    $('bannerMain').textContent = main;
    $('bannerSub').textContent = sub || '';
    el.className = '';
    void el.offsetWidth;
    el.className = 'show ' + (cls || '');
    if (S.snap) { el.style.animation = 'none'; el.style.opacity = 1; }
  }

  // ---------- simulation ----------
  function update(dt) {
    S.clock += dt; S.pt += dt;
    const b = S.ball;

    if (S.phase === 'wait' && S.pt > 0.9) { S.phase = 'runup'; S.pt = 0; S.tRun = S.clock; }
    if (S.phase === 'runup' && S.pt >= RUN_T) release();

    if (b.state === 'bowled') {
      b.x += b.vx * dt; b.vy -= G * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      if (b.y <= 0.036) {
        b.y = 0.036;
        if (!b.bounced) { b.bounced = true; b.vy = -b.vy * 0.58; snd('bounce'); }
        else { b.vy = Math.abs(b.vy) * 0.4; }
      }
      if (S.pendingHit && S.clock >= S.pendingHit.at) doHit();
      else if (!S.pendingHit && !S.missChecked && b.x >= STUMPS_BAT) {
        S.missChecked = true;
        if (Math.abs(b.z) < 0.17 && b.y < 0.78) {
          S.stumpsT = S.clock; snd('stumps');
          b.vx = 3; b.vy = 1.5; b.vz = 0.8;
          banner('BOWLED!', S.swing ? 'Missed it completely' : 'Should have played at that', 'out');
          finish({ runs: 0, out: true, how: 'Bowled' }, 1.5);
        }
      }
      if (b.state === 'bowled' && b.x >= 22.8) {
        b.state = 'dead'; b.alpha = 0;
        if (!S.outcome) {
          const msg = S.swing ? (S.timing || 'Beaten!') : 'Left alone';
          banner('Dot ball', msg, '');
          finish({ runs: 0, out: false }, 0.7);
        }
      }
    } else if (b.state === 'hit') {
      const onGround = b.y <= 0.04 && b.vy <= 0.5;
      b.x += b.vx * dt; b.z += b.vz * dt;
      if (onGround) {
        b.y = 0.036; b.vy = 0;
        const sp = Math.hypot(b.vx, b.vz);
        const ns = Math.max(0, sp - FRICTION * dt);
        if (ns <= 0.25) { b.vx = 0; b.vz = 0; b.state = 'stopped'; }
        else { b.vx *= ns / sp; b.vz *= ns / sp; }
      } else {
        b.vy -= G * dt; b.y += b.vy * dt;
        if (b.y <= 0.036) {
          b.y = 0.036;
          if (!b.bounced && S.hit.type === 'loft') { b.vx *= 0.7; b.vz *= 0.7; }
          b.bounced = true;
          b.vy = Math.abs(b.vy) > 2 ? -b.vy * 0.35 : 0;
        }
      }
      b.carry = Math.max(b.carry, HIT_X - b.x);
    }

    // catches
    if (S.catchAt > 0 && S.clock >= S.catchAt && (b.state === 'hit')) {
      S.catchAt = -1;
      b.state = 'caught'; b.vx = b.vy = b.vz = 0;
      const edge = S.hit.kind === 'edge';
      snd('catch');
      banner(edge ? 'CAUGHT BEHIND!' : 'CAUGHT!', edge ? 'Thin edge, straight to the keeper' : S.hit.timing + ' · not enough on it', 'out');
      finish({ runs: 0, out: true, how: edge ? 'Caught behind' : 'Caught' }, 1.5);
    }

    // boundary
    if ((b.state === 'hit' || b.state === 'stopped') && !S.boundary && b.x < ROPE_X) {
      S.boundary = b.bounced ? 4 : 6;
      snd('boundary');
      if (S.boundary === 6) { S.celebrate = true; banner('SIX!', `${S.hit.timing} · ${Math.round(S.hit.dist)} m`, 'six'); }
      else banner('FOUR!', S.hit.type === 'ground' ? `${S.hit.timing} · raced away` : 'One bounce over the rope', 'four');
      finish({ runs: S.boundary, out: false }, S.boundary === 6 ? 1.6 : 1.2);
    }

    // running between the wickets
    if (S.run && !S.run.done && S.clock >= S.run.start + S.run.n * RUN_PER) {
      S.run.done = true;
      const n = S.run.n;
      banner(n === 1 ? '1 RUN' : `${n} RUNS`, S.hit.timing, '');
      finish({ runs: n, out: false }, 0.7);
    }
    // defended / stopped short with no runs planned
    if (b.state === 'stopped' && !S.run && !S.outcome && !S.boundary) {
      banner('Dot ball', S.hit.p < 0.22 ? 'Solid defence' : 'Straight to the fielder', '');
      finish({ runs: 0, out: false }, 0.5);
    }

    if (S.endAt > 0 && S.clock >= S.endAt) { S.endAt = -1; endBall(); }

    if (S.phase === 'between' && S.pt > 1.4) {
      if (S.inningsDone) gameOver();
      else { if (S.overDone) S.over = []; setupBall(); updateHud(); }
    }

    // camera
    let tx = 10.3, ts = S0;
    if (['hit', 'stopped', 'caught'].includes(b.state) && S.phase !== 'between') {
      const minX = Math.min(b.x - 9, -1.5), maxX = 22.5;
      tx = (minX + maxX) / 2;
      ts = Math.min(S0, W / (maxX - minX), (GY - H * 0.08) / (b.y + 2.5));
    }
    cam.x += (tx - cam.x) * Math.min(1, dt * 7);
    cam.s += (ts - cam.s) * Math.min(1, dt * (ts < cam.s ? 6 : 3));
  }

  // ---------- rendering ----------
  const P = (x, y, z) => [W / 2 + (x - cam.x) * cam.s + z * cam.s * 0.12, GY - y * cam.s + z * cam.s * 0.35];
  const off = (p, a, l, f) => [p[0] + f * Math.sin(a) * l, p[1] - Math.cos(a) * l];
  const up = (p, a, l, f) => [p[0] + f * Math.sin(a) * l, p[1] + Math.cos(a) * l];

  function line(a, b, z, w, col, cap) {
    const p = P(a[0], a[1], z), q = P(b[0], b[1], z);
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5 * DPR, w * cam.s); ctx.lineCap = cap || 'round';
    ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
  }
  function poly(pts, col) {
    ctx.fillStyle = col; ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath(); ctx.fill();
  }

  function drawBackground() {
    const sky = ctx.createLinearGradient(0, 0, 0, HZ);
    sky.addColorStop(0, '#5fa8e8'); sky.addColorStop(1, '#cfe8f7');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, HZ + 2);
    // clouds
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < 6; i++) {
      const cx = ((i * 0.23 * W + S.clock * 6 * DPR * (1 + i * 0.2) - cam.x * DPR * 0.6) % (W * 1.4) + W * 1.4) % (W * 1.4) - W * 0.2;
      const cy = HZ * (0.15 + (i % 3) * 0.17);
      const r = H * (0.035 + (i % 2) * 0.015);
      for (const [dx, dy, rx, ry] of [[0, 0, 2.2, 1], [1.4, -0.5, 1.4, 0.9], [-1.3, -0.2, 1.2, 0.7]]) {
        ctx.beginPath(); ctx.ellipse(cx + r * dx, cy + r * dy, r * rx, r * ry, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
    // distant hills
    const par = -cam.x * cam.s * 0.08;
    for (const [amp, base, col, fr] of [[0.06, 0.0, '#8fb79a', 0.004], [0.04, 0.02, '#6f9f7c', 0.007]]) {
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, HZ);
      for (let x = 0; x <= W; x += 8 * DPR) {
        const wx = (x - par * (fr * 100)) / DPR;
        const y = HZ - H * base - H * amp * (0.55 + 0.45 * Math.sin(wx * fr + fr * 300) * Math.cos(wx * fr * 0.37));
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, HZ + 2); ctx.lineTo(0, HZ + 2); ctx.fill();
    }
    // tree line
    ctx.fillStyle = '#3f6e4b';
    for (let i = -2; i < 40; i++) {
      const x = ((i * 70 * DPR + par * 0.5) % (W + 140 * DPR) + W + 140 * DPR) % (W + 140 * DPR) - 70 * DPR;
      const r = (14 + ((i * 37) % 11)) * DPR;
      ctx.beginPath(); ctx.arc(x, HZ - r * 0.4, r, 0, Math.PI * 2); ctx.fill();
    }

    // grass
    const g = ctx.createLinearGradient(0, HZ, 0, H);
    g.addColorStop(0, '#4f9a4a'); g.addColorStop(1, '#2f7a33');
    ctx.fillStyle = g; ctx.fillRect(0, HZ, W, H - HZ);

    ctx.save();
    ctx.beginPath(); ctx.rect(0, HZ, W, H - HZ); ctx.clip();
    const zFar = (HZ - GY) / (0.35 * cam.s) - 1, zNear = (H - GY) / (0.35 * cam.s) + 1;
    const xL = cam.x - W / 2 / cam.s - 20, xR = cam.x + W / 2 / cam.s + 20;
    const band = 6;
    for (let x = Math.floor(xL / band) * band; x < xR; x += band) {
      if (Math.round(x / band) % 2 === 0) continue;
      poly([P(x, 0, zFar), P(x + band, 0, zFar), P(x + band, 0, zNear), P(x, 0, zNear)], 'rgba(255,255,255,0.055)');
    }
    // 30-yard ring hint and boundary rope
    const ringX = HIT_X - 27;
    for (let zz = zFar; zz < zNear; zz += 1.2) line([ringX, 0], [ringX, 0], zz, 0, 'rgba(255,255,255,0.35)');
    ctx.setLineDash([]);
    const r1 = P(ROPE_X, 0, zFar), r2 = P(ROPE_X, 0, zNear);
    ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = Math.max(3 * DPR, 0.25 * cam.s);
    ctx.beginPath(); ctx.moveTo(r1[0], r1[1]); ctx.lineTo(r2[0], r2[1]); ctx.stroke();
    ctx.strokeStyle = '#dc2626'; ctx.lineWidth = Math.max(1.5 * DPR, 0.1 * cam.s);
    ctx.beginPath(); ctx.moveTo(r1[0], r1[1]); ctx.lineTo(r2[0], r2[1]); ctx.stroke();
    // boundary boards beyond the rope
    const bx = ROPE_X - 6;
    poly([P(bx, 0, zFar), P(bx - 0.3, 0, zFar), P(bx - 0.3, 0, zNear), P(bx, 0, zNear)], 'rgba(0,0,0,0.12)');
    ctx.restore();

    // pitch
    poly([P(-1.3, 0, -1.5), P(21.4, 0, -1.5), P(21.4, 0, 1.5), P(-1.3, 0, 1.5)], '#d8c38e');
    poly([P(-1.3, 0, -1.5), P(21.4, 0, -1.5), P(21.4, 0, -1.2), P(-1.3, 0, -1.2)], 'rgba(0,0,0,0.05)');
    const white = 'rgba(255,255,255,0.9)';
    for (const cx of [1.22, STUMPS_BAT - 1.22]) drawCrease(cx, 1.5);
    for (const cx of [0, STUMPS_BAT]) drawCrease(cx, 1.32);
    for (const [cx, dir] of [[0, 1], [STUMPS_BAT, -1]]) {
      for (const zz of [-1.32, 1.32]) {
        const a = P(cx - dir * 1.22, 0, zz), b2 = P(cx + dir * 0.6, 0, zz);
        ctx.strokeStyle = white; ctx.lineWidth = Math.max(1 * DPR, 0.05 * cam.s);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b2[0], b2[1]); ctx.stroke();
      }
    }
  }
  function drawCrease(x, half) {
    const a = P(x, 0, -half), b = P(x, 0, half);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = Math.max(1 * DPR, 0.05 * cam.s);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }

  function drawStumps(x, hitT) {
    const fly = hitT > 0 ? Math.min(1, (S.clock - hitT) * 3.5) : 0;
    const zs = [-0.11, 0, 0.11];
    const angs = [-0.5, 0.35, 0.9];
    zs.forEach((z, i) => {
      const a = angs[i] * fly * (i === 1 ? 1.2 : 1);
      const top = [x + Math.sin(a) * 0.71, Math.cos(a) * 0.71];
      line([x, 0], top, z, 0.045, '#f3e7c9', 'butt');
    });
    // bails
    const by = 0.73 + fly * 1.4 - fly * fly * 1.6;
    if (fly < 1 || by > 0) {
      line([x + fly * 1.2, Math.max(0.02, by)], [x + fly * 1.2 + 0.02, Math.max(0.02, by)], -0.055, 0.035, '#e8d6a8');
      line([x + fly * 0.8, Math.max(0.02, by)], [x + fly * 0.8 + 0.02, Math.max(0.02, by)], 0.055, 0.035, '#e8d6a8');
    }
  }

  // stick figure: spec = { x, z, f, hipY, lean, legs:[[thigh,shin],[thigh,shin]], hands:[x,y] | arms:[a,a], bat:{a} | batTip, helmet, cap, pads, color }
  const INK = '#1f2937';
  function figure(sp) {
    const { x, z, f } = sp;
    const hip = [x, sp.hipY];
    const sh = up(hip, sp.lean, 0.55, f);
    const head = up(sh, sp.lean * 0.6, 0.25, f);
    const legs = sp.legs.map(([t, s]) => { const k = off(hip, t, 0.47, f); return [k, off(k, s, 0.47, f)]; });
    const lw = 0.075;
    // back leg first (index 1), slightly lighter
    const order = [1, 0];
    for (const i of order) {
      const [k, ft] = legs[i];
      const col = i === 1 ? '#374151' : INK;
      line(hip, k, z, lw, col);
      if (sp.pads) { line(k, ft, z, 0.14, i === 1 ? '#e5e7eb' : '#f9fafb'); line(k, ft, z, 0.04, '#d1d5db'); }
      else line(k, ft, z, lw, col);
      line(ft, [ft[0] + f * 0.13, ft[1]], z, 0.07, sp.pads ? '#f9fafb' : INK);
    }
    // torso (shirt)
    line(hip, sh, z, 0.2, sp.color);
    line(hip, sh, z, 0.05, 'rgba(0,0,0,0.15)');
    // arms
    let hands = [];
    if (sp.hands) {
      const elb = [(sh[0] + sp.hands[0]) / 2, (sh[1] + sp.hands[1]) / 2 - 0.06];
      line(sh, elb, z, lw, INK); line(elb, sp.hands, z, lw, INK);
      hands = [sp.hands];
    } else if (sp.arms) {
      for (const a of sp.arms) {
        const el = off(sh, a[0], 0.31, f), hd = off(el, a[1], 0.31, f);
        line(sh, el, z, lw, INK); line(el, hd, z, lw, INK);
        hands.push(hd);
      }
    }
    // bat
    if (sp.batTip && hands[0]) {
      const h = hands[0], t = sp.batTip;
      const mid = [lerp(h[0], t[0], 0.3), lerp(h[1], t[1], 0.3)];
      line(h, mid, z, 0.045, '#3f3f46');
      line(mid, t, z, 0.11, '#e9cf98', 'butt');
      line(mid, t, z, 0.03, '#c9a86a', 'butt');
    }
    if (sp.ball && hands[0]) {
      const p = P(hands[0][0], hands[0][1], z);
      ctx.fillStyle = '#b91c1c'; ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(2.5 * DPR, 0.09 * cam.s), 0, Math.PI * 2); ctx.fill();
    }
    if (sp.gloves) for (const h of hands) {
      const p = P(h[0], h[1], z);
      ctx.fillStyle = '#f9fafb'; ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(2.5 * DPR, 0.065 * cam.s), 0, Math.PI * 2); ctx.fill();
    }
    // head
    const hp = P(head[0], head[1], z), hr = Math.max(4 * DPR, 0.14 * cam.s);
    ctx.fillStyle = '#f2c9a0'; ctx.beginPath(); ctx.arc(hp[0], hp[1], hr, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1.2 * DPR, 0.03 * cam.s); ctx.stroke();
    if (sp.helmet) {
      ctx.fillStyle = sp.helmet;
      ctx.beginPath(); ctx.arc(hp[0], hp[1], hr * 1.12, Math.PI * 1.02, Math.PI * 1.98); ctx.closePath(); ctx.fill();
      // peak + grille on the facing side
      ctx.strokeStyle = sp.helmet; ctx.lineWidth = Math.max(1.5 * DPR, hr * 0.28);
      ctx.beginPath(); ctx.moveTo(hp[0], hp[1] - hr * 0.1); ctx.lineTo(hp[0] + f * hr * 1.45, hp[1] - hr * 0.05); ctx.stroke();
      ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = Math.max(1 * DPR, hr * 0.12);
      ctx.beginPath(); ctx.moveTo(hp[0] + f * hr * 0.95, hp[1] - hr * 0.05); ctx.lineTo(hp[0] + f * hr * 0.9, hp[1] + hr * 0.75); ctx.stroke();
    }
    if (sp.cap) {
      ctx.fillStyle = sp.cap;
      ctx.beginPath(); ctx.arc(hp[0], hp[1], hr * 1.05, Math.PI * 1.08, Math.PI * 1.92); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = sp.cap; ctx.lineWidth = Math.max(1.5 * DPR, hr * 0.25);
      ctx.beginPath(); ctx.moveTo(hp[0], hp[1] - hr * 0.45); ctx.lineTo(hp[0] + f * hr * 1.4, hp[1] - hr * 0.4); ctx.stroke();
    }
  }

  // batting stance / swing driven by bat angle a (0 = bat down, + = behind)
  function batterPose(x, z, f, a, color, stride) {
    const hipY = 0.9 - stride * 0.06;
    const lean = 0.28 + stride * 0.12;
    const hip = [x, hipY];
    const sh = up(hip, lean, 0.55, f);
    const phi = 0.35 - a * 0.45;
    const hands = off(sh, phi, 0.5, f);
    const tip = [hands[0] - f * Math.sin(a) * 0.86, hands[1] - Math.cos(a) * 0.86];
    return {
      x, z, f, hipY, lean, color, hands, batTip: tip, helmet: color, pads: true, gloves: true,
      legs: [[0.32 + stride * 0.35, 0.02 + stride * 0.1], [-0.22, -0.06]],
    };
  }
  function runPose(x, z, f, phase, color, kind) {
    const s = Math.sin(phase), c = Math.cos(phase);
    const tL = 0.65 * s, tR = -0.65 * s;
    const bendL = 0.2 + 1.0 * Math.max(0, -c), bendR = 0.2 + 1.0 * Math.max(0, c);
    const sp = {
      x, z, f, color, hipY: 0.92 + 0.04 * Math.abs(c), lean: 0.32,
      legs: [[tL, tL - bendL], [tR, tR - bendR]],
    };
    if (kind === 'bat') {
      sp.hands = off(up([x, sp.hipY], 0.32, 0.55, f), 0.9 + 0.2 * s, 0.5, f);
      sp.batTip = [sp.hands[0] + f * 0.72, sp.hands[1] - 0.42];
      sp.helmet = color; sp.pads = true; sp.gloves = true;
    } else {
      sp.arms = [[-0.9 * s, -0.9 * s + 1.4], [0.9 * s, 0.9 * s + 1.4]];
    }
    return sp;
  }

  function strikerSpec() {
    const bt = S.batters[S.striker];
    const col = bt.color;
    if (S.run) {
      const r = clamp((S.clock - S.run.start) / RUN_PER, 0, S.run.n);
      if (r > 0 && r < S.run.n) {
        const k = Math.floor(r), fr = r - k;
        const from = k % 2 === 0 ? BAT_X : NS_X, to = k % 2 === 0 ? NS_X : BAT_X;
        return runPose(lerp(from, to, ease(fr)), Z_BAT, Math.sign(to - from), fr * Math.PI * 6, col, 'bat');
      }
      if (r >= S.run.n) {
        const atX = S.run.n % 2 ? NS_X : BAT_X;
        return batterPose(atX, Z_BAT, atX === BAT_X ? -1 : 1, 0.25, col, 0);
      }
    }
    if (S.celebrate) {
      const sp = batterPose(BAT_X, Z_BAT, -1, 0.25, col, 0);
      const sh = up([BAT_X, sp.hipY], sp.lean, 0.55, -1);
      sp.hands = [sh[0] - 0.1, sh[1] + 0.45];
      sp.batTip = [sp.hands[0] + 0.1, sp.hands[1] + 0.85];
      sp.legs = [[0.15, 0.05], [-0.15, -0.05]];
      return sp;
    }
    // bat angle timeline
    let a = 0.25, stride = 0;
    if (S.phase === 'runup') a = lerp(0.25, 1.95, ease(clamp((S.pt - (RUN_T - 0.7)) / 0.6, 0, 1)));
    if (S.phase === 'delivery' || S.phase === 'hit') a = 1.95;
    if (S.swing) {
      const tau = S.clock - S.swing.t0;
      const end = S.swing.type === 'loft' ? -2.9 : -1.75;
      if (tau < 0.08) a = lerp(1.95, -0.3, tau / 0.08);
      else if (tau < 0.35) a = lerp(-0.3, end, ease((tau - 0.08) / 0.27));
      else if (tau < 1.1) a = end;
      else a = lerp(end, 0.25, ease(clamp((tau - 1.1) / 0.5, 0, 1)));
      stride = clamp(tau / 0.1, 0, 1) * (tau < 1.2 ? 1 : clamp(1 - (tau - 1.2) / 0.4, 0, 1));
    }
    if (S.phase === 'between' && !S.swing) a = 0.25;
    return batterPose(BAT_X, Z_BAT, -1, a, col, stride);
  }

  function nonStrikerSpec() {
    const bt = S.batters[S.non];
    const col = bt.color;
    if (S.run) {
      const r = clamp((S.clock - S.run.start) / RUN_PER, 0, S.run.n);
      if (r > 0 && r < S.run.n) {
        const k = Math.floor(r), fr = r - k;
        const from = k % 2 === 0 ? NS_X : BAT_X, to = k % 2 === 0 ? BAT_X : NS_X;
        return runPose(lerp(from, to, ease(fr)), Z_NS, Math.sign(to - from), fr * Math.PI * 6 + 1, col, 'bat');
      }
      if (r >= S.run.n) {
        const atX = S.run.n % 2 ? BAT_X : NS_X;
        return batterPose(atX, Z_NS, atX === BAT_X ? -1 : 1, 0.25, col, 0);
      }
    }
    // backing up as the bowler delivers
    let x = NS_X;
    if (S.phase === 'delivery' || S.phase === 'hit') x = NS_X + clamp((S.clock - S.tArrive + 0.9) * 1.6, 0, 1.4);
    return batterPose(x, Z_NS, 1, 0.3, col, 0);
  }

  function bowlerSpec() {
    const col = '#b91c1c';
    if (S.phase === 'wait' || S.tRun < 0) {
      return { x: -13, z: Z_BOWL, f: 1, color: '#f8fafc', hipY: 0.95, lean: 0.05, legs: [[0.08, 0.05], [-0.08, -0.05]], arms: [[0.2, 0.5], [-0.15, 0.1]], cap: col, ball: true };
    }
    const u = S.clock - S.tRun;
    const actS = RUN_T - 0.22, actE = RUN_T + 0.2;
    let x;
    if (u < RUN_T) x = -13 + 13.2 * Math.pow(u / RUN_T, 1.25);
    else x = 0.2 + 3.2 * (1 - Math.exp(-(u - RUN_T) * 1.8));
    if (u >= actS && u <= actE) {
      const t = (u - actS) / (actE - actS);
      const alpha = lerp(-1.2, -5.7, ease(t));
      return {
        x, z: Z_BOWL, f: 1, color: '#f8fafc', hipY: 0.9, lean: lerp(-0.15, 0.45, t),
        legs: [[0.45, 0.25], [-0.55, -0.3]],
        arms: [[alpha, alpha], [lerp(2.4, -0.3, t), lerp(2.4, -0.3, t)]],
        cap: col, ball: t < 0.5,
      };
    }
    const spd = u < RUN_T ? 1 : Math.exp(-(u - RUN_T) * 1.8);
    const sp = runPose(x, Z_BOWL, 1, x * 1.7, '#f8fafc', 'bowl');
    sp.cap = col;
    if (u < RUN_T) sp.ball = true;
    if (spd < 0.25) { sp.legs = [[0.1, 0.05], [-0.1, -0.05]]; sp.arms = [[0.1, 0.1], [-0.1, -0.1]]; sp.lean = 0.05; }
    return sp;
  }

  function drawBall() {
    const b = S.ball;
    if (b.state === 'held' || b.state === 'dead') return;
    const fade = b.state === 'caught' ? Math.max(0, 1 - (S.clock - (S.endAt - 1.5)) * 1.2) : 1;
    if (fade <= 0) return;
    ctx.globalAlpha = fade;
    const sh = P(b.x, 0, b.z);
    const rr = Math.max(3 * DPR, 0.11 * cam.s);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(sh[0], sh[1], rr * 1.2, rr * 0.45, 0, 0, Math.PI * 2); ctx.fill();
    const p = P(b.x, b.y, b.z);
    ctx.fillStyle = '#c0262d'; ctx.beginPath(); ctx.arc(p[0], p[1], rr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.beginPath(); ctx.arc(p[0] - rr * 0.3, p[1] - rr * 0.35, rr * 0.35, 0, Math.PI * 2); ctx.fill();
    // motion trail when travelling fast
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > 12 && b.state !== 'caught') {
      const tl = P(b.x - b.vx * 0.04, b.y - b.vy * 0.04, b.z - b.vz * 0.04);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = rr * 1.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(tl[0], tl[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    drawBackground();
    if (S.screen === 'menu' && !S.batters) {
      // idle scene behind the menu
      figure(batterPose(BAT_X, Z_BAT, -1, 0.25, KIT[0], 0));
      drawStumps(STUMPS_BAT, -1); drawStumps(0, -1);
      figure(batterPose(NS_X, Z_NS, 1, 0.3, KIT[1], 0));
      return;
    }
    // draw far-to-near by z
    const items = [
      { z: Z_NS, d: () => figure(nonStrikerSpec()) },
      { z: Z_BAT, d: () => figure(strikerSpec()) },
      { z: 0, d: () => drawStumps(0, -1) },
      { z: 0.001, d: () => drawStumps(STUMPS_BAT, S.stumpsT) },
      { z: Z_BOWL, d: () => figure(bowlerSpec()) },
      { z: S.ball.z + 0.002, d: drawBall },
    ];
    items.sort((a, b) => a.z - b.z).forEach((it) => it.d());
  }

  // ---------- HUD ----------
  function updateHud() {
    if (!S.batters) return;
    $('sc').textContent = `${S.runs}/${S.wk}`;
    $('ov').textContent = `${Math.floor(S.balls / 6)}.${S.balls % 6} ov`;
    if (S.target) {
      const need = S.target - S.runs, left = cfg.overs * 6 - S.balls;
      $('target').textContent = need > 0 ? `Target ${S.target} · need ${need} from ${left} ${left === 1 ? 'ball' : 'balls'}` : `Target ${S.target} · reached!`;
    } else $('target').textContent = `${cfg.overs} ${cfg.overs === 1 ? 'over' : 'overs'} · ${cfg.wkts} ${cfg.wkts === 1 ? 'wicket' : 'wickets'}`;
    const rows = [S.striker, S.non].filter((i) => i < S.batters.length && !S.batters[i].out).map((i) => {
      const b = S.batters[i];
      return `<div class="bat-row ${i === S.striker ? 'on' : ''}"><span class="dot" style="background:${b.color}"></span>${b.name}${i === S.striker ? ' *' : ''}<span class="r">${b.runs} (${b.balls})</span></div>`;
    });
    $('bats').innerHTML = rows.join('');
    const chips = [];
    for (let i = 0; i < 6; i++) {
      const v = S.over[i];
      if (v === undefined) chips.push('<span class="chip empty"></span>');
      else chips.push(`<span class="chip ${v === '4' ? 'c4' : v === '6' ? 'c6' : v === 'W' ? 'cW' : ''}">${v}</span>`);
    }
    $('overBalls').innerHTML = chips.join('');
  }

  function gameOver() {
    S.screen = 'over';
    const won = S.target ? S.runs >= S.target : null;
    const ballsLeft = cfg.overs * 6 - S.balls;
    $('goTitle').textContent = S.target ? (won ? 'You won the chase' : 'Chase failed') : 'Innings complete';
    $('goScore').textContent = `${S.runs}/${S.wk}`;
    let line = `${Math.floor(S.balls / 6)}.${S.balls % 6} overs`;
    if (S.target) {
      const short = S.target - 1 - S.runs;
      line = won ? `Won with ${ballsLeft} ${ballsLeft === 1 ? 'ball' : 'balls'} to spare` : short === 0 ? 'Match tied!' : `Lost by ${short} ${short === 1 ? 'run' : 'runs'}`;
    }
    $('goLine').textContent = line;
    $('stRR').textContent = S.balls ? ((S.runs / S.balls) * 6).toFixed(1) : '0.0';
    const sum = (k) => S.batters.reduce((s, b) => s + b[k], 0);
    $('st4').textContent = sum('fours'); $('st6').textContent = sum('sixes'); $('stDot').textContent = S.dots;
    $('goCard').innerHTML = S.batters.filter((b) => b.balls > 0 || b.out).map((b) =>
      `<tr><td><span class="dot" style="display:inline-block;background:${b.color};margin-right:6px"></span>${b.name}</td><td class="how-out">${b.out || 'not out'}</td><td class="n"><b>${b.runs}</b> (${b.balls})</td></tr>`).join('');
    const key = `sc.best.${cfg.overs}.${cfg.wkts}.${cfg.diff}`;
    const best = parseInt(store.get(key), 10) || 0;
    if (S.runs > best) store.set(key, String(S.runs));
    showScreen();
  }

  function showScreen() {
    $('menu').classList.toggle('hidden', S.screen !== 'menu');
    $('gameover').classList.toggle('hidden', S.screen !== 'over');
    $('hud').classList.toggle('hidden', S.screen === 'menu');
    $('controls').classList.toggle('hidden', S.screen !== 'play');
    $('pause').classList.toggle('hidden', !(S.screen === 'play' && S.paused));
    if (S.screen === 'menu') {
      document.querySelectorAll('.seg').forEach((seg) => {
        const key = seg.dataset.key;
        seg.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', String(key === 'chase' ? (cfg.chase ? 1 : 0) : cfg[key]) === b.dataset.v));
      });
      const best = parseInt(store.get(`sc.best.${cfg.overs}.${cfg.wkts}.${cfg.diff}`), 10);
      $('bestLine').textContent = best ? `Best score with these settings: ${best}` : '';
    }
  }

  // ---------- audio ----------
  let AC = null;
  function audioInit() {
    if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { AC = null; } }
    if (AC && AC.state === 'suspended') AC.resume();
  }
  function noise(dur, type, freq, gain, when = 0) {
    const t = AC.currentTime + when;
    const buf = AC.createBuffer(1, Math.max(1, Math.floor(AC.sampleRate * dur)), AC.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    const src = AC.createBufferSource(); src.buffer = buf;
    const f = AC.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = 1.2;
    const g = AC.createGain(); g.gain.value = gain;
    src.connect(f).connect(g).connect(AC.destination); src.start(t);
  }
  function tone(freq, dur, gain, when = 0, type = 'sine') {
    const t = AC.currentTime + when;
    const o = AC.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = AC.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(AC.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  function snd(kind, p = 1) {
    if (!AC || S.muted || S.snap) return;
    try {
      if (kind === 'bat') { noise(0.09, 'bandpass', 1500 + p * 900, 0.9); tone(700 + p * 300, 0.06, 0.25, 0, 'triangle'); }
      else if (kind === 'bounce') noise(0.06, 'lowpass', 380, 0.5);
      else if (kind === 'stumps') { noise(0.12, 'bandpass', 900, 0.8); noise(0.08, 'bandpass', 1400, 0.6, 0.06); noise(0.08, 'bandpass', 1100, 0.5, 0.12); }
      else if (kind === 'boundary') { tone(660, 0.25, 0.2); tone(880, 0.35, 0.2, 0.12); tone(1320, 0.4, 0.15, 0.24); }
      else if (kind === 'catch') noise(0.05, 'lowpass', 600, 0.6);
    } catch (e) { /* ignore audio errors */ }
  }

  // ---------- wiring ----------
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      const key = seg.dataset.key, v = btn.dataset.v;
      if (key === 'chase') cfg.chase = v === '1';
      else if (key === 'diff') cfg.diff = v;
      else cfg[key] = parseInt(v, 10);
      store.set('sc.' + key, key === 'chase' ? (cfg.chase ? '1' : '0') : String(cfg[key]));
      showScreen();
    });
  });
  $('startBtn').addEventListener('click', () => { audioInit(); newMatch(); document.activeElement && document.activeElement.blur(); });
  $('againBtn').addEventListener('click', () => newMatch());
  $('menuBtn').addEventListener('click', () => { S.screen = 'menu'; showScreen(); });
  $('resumeBtn').addEventListener('click', () => togglePause(false));
  $('quitBtn').addEventListener('click', () => { S.paused = false; S.screen = 'menu'; showScreen(); });
  $('pauseBtn').addEventListener('click', () => togglePause(true));
  const setMuteLabel = () => { $('muteBtn').textContent = S.muted ? 'Sound off' : 'Sound on'; };
  $('muteBtn').addEventListener('click', () => { S.muted = !S.muted; store.set('sc.muted', S.muted ? '1' : '0'); setMuteLabel(); });
  setMuteLabel();
  function togglePause(v) {
    if (S.screen !== 'play') return;
    S.paused = v === undefined ? !S.paused : v;
    showScreen();
  }

  const press = (type) => (e) => { e.preventDefault(); shot(type); };
  $('btnGround').addEventListener('pointerdown', press('ground'));
  $('btnLoft').addEventListener('pointerdown', press('loft'));
  canvas.addEventListener('pointerdown', (e) => { if (S.screen !== 'play') return; e.preventDefault(); shot(e.button === 2 ? 'loft' : 'ground'); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (S.screen === 'menu' && e.key === 'Enter') { audioInit(); newMatch(); return; }
    if (S.screen === 'over' && e.key === 'Enter') { newMatch(); return; }
    if (e.code === 'Space') { e.preventDefault(); shot(e.shiftKey ? 'loft' : 'ground'); }
    else if (e.key === 'ArrowUp' || e.key === 'l' || e.key === 'L') { e.preventDefault(); shot('loft'); }
    else if (e.key === 'ArrowDown' || e.key === 'g' || e.key === 'G') { e.preventDefault(); shot('ground'); }
    else if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') togglePause();
    else if (e.key === 'm' || e.key === 'M') $('muteBtn').click();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.screen === 'play') togglePause(true); });

  // ---------- main loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (S.screen === 'play' && !S.paused) update(dt);
    else if (S.screen === 'menu') S.clock += dt;
    render();
    requestAnimationFrame(frame);
  }

  // Snapshot mode for screenshots: ?snap=ground|loft|none&at=SECONDS&seed=N&err=0
  if (params.has('snap')) {
    S.snap = true;
    const shotType = params.get('snap');
    const at = parseFloat(params.get('at')) || 3;
    const errOff = parseFloat(params.get('err')) || 0;
    if (params.get('ov')) cfg.overs = parseInt(params.get('ov'), 10);
    if (params.get('chase')) cfg.chase = params.get('chase') === '1';
    newMatch();
    if (params.get('score')) {
      const [r, w, b] = params.get('score').split(',').map(Number);
      S.runs = r; S.wk = w; S.balls = b; S.striker = Math.min(w, S.batters.length - 1); S.non = S.striker + 1; S.next = S.non + 1;
      S.batters[S.striker].runs = Math.round(r * 0.6); S.batters[S.striker].balls = Math.round(b * 0.55);
      S.batters[S.non].runs = Math.round(r * 0.25); S.batters[S.non].balls = Math.round(b * 0.3);
      S.over = (params.get('over') || '').split('').filter(Boolean);
      updateHud();
    }
    if (params.get('len')) { const L = LENGTHS.find((l) => l.name.startsWith(params.get('len'))); if (L) { S.del.xb = L.xb; S.del.len = L.name; } }
    if (params.get('line')) { const Ln = LINES[parseInt(params.get('line'), 10)]; S.del.z = Ln.z; S.del.line = Ln.name; }
    const dt = 1 / 120;
    let t = 0;
    const full = params.has('full');
    let autoType = shotType, autoErr = errOff;
    while (t < at) {
      if (full && S.phase === 'wait' && !S.del.auto) { S.del.auto = true; autoType = rnd() < 0.45 ? 'loft' : 'ground'; autoErr = (rnd() - 0.5) * 0.3; }
      if (autoType !== 'none' && !S.swing && S.phase === 'delivery' && S.clock >= S.tArrive - 0.08 + autoErr) shot(autoType);
      update(dt); t += dt;
      if (S.screen !== 'play' || (S.phase === 'between' && !full)) break;
    }
    // keep re-drawing the frozen frame (a resize clears the canvas)
    const still = () => { render(); requestAnimationFrame(still); };
    still();
    document.body.dataset.snap = JSON.stringify({ b: S.ball, cam, hit: S.hit, phase: S.phase, clock: S.clock, tArrive: S.tArrive, W, H });
  } else {
    showScreen();
    requestAnimationFrame(frame);
  }

  // offline install support (only works when served over http/https)
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !params.has('snap')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
