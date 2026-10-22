(() => {
  const $ = id => document.getElementById(id);
  const OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
  const LINES = [
    { a: 54,  b: 284, label: 'الجبهة' },
    { a: 234, b: 454, label: 'الخدود' },
    { a: 172, b: 397, label: 'الفك' },
    { a: 10,  b: 152, label: 'الطول', vertical: true }
  ];
  const MAX_SIDE = 1280;

  let mesh = null, meshReady = null, pending = null;
  let photo = null;            // canvas with the user's photo
  let pts = null;              // landmarks in pixels [{x,y}]
  let result = null;           // {key, scores, ratios}
  let frame = null;            // selected frame key for try-on
  let tab = 'hair';

  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function say(t, err) { const m = $('msg'); m.textContent = t || ''; m.classList.toggle('err', !!err); }
  function busy(on, t) { $('busy').hidden = !on; if (t) $('busyText').textContent = t; }
  const paint = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));

  // ---------- face mesh ----------
  function getMesh() {
    if (meshReady) return meshReady;
    meshReady = (async () => {
      mesh = new FaceMesh({ locateFile: f => 'lib/fm/' + f });
      mesh.setOptions({ maxNumFaces: 1, refineLandmarks: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5, selfieMode: false });
      mesh.onResults(r => { if (pending) { const p = pending; pending = null; p(r); } });
      await mesh.initialize();
      return mesh;
    })();
    meshReady.catch(() => { meshReady = null; });
    return meshReady;
  }
  async function detect(canvas) {
    const m = await getMesh();
    if (typeof m.reset === 'function') m.reset();
    const res = new Promise(r => { pending = r; });
    await m.send({ image: canvas });
    return res;
  }

  // ---------- geometry ----------
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  function measure(P) {
    const cheek = dist(P[234], P[454]);
    const R = dist(P[10], P[152]) / cheek;
    const J = dist(P[172], P[397]) / cheek;
    const F = dist(P[54], P[284]) / cheek;
    const yaw = Math.abs(dist(P[1], P[234]) - dist(P[1], P[454])) / cheek;
    const roll = Math.atan2(P[263].y - P[33].y, P[263].x - P[33].x);
    return { cheek, R, J, F, yaw, roll };
  }
  function classify(m) {
    const d = [m.R - BASE.R, m.J - BASE.J, m.F - BASE.F];
    const w = [1, 1.3, 1.3], s2 = 0.06 * 0.06;
    const raw = {};
    let sum = 0;
    for (const [k, s] of Object.entries(SHAPES)) {
      let q = 0; for (let i = 0; i < 3; i++) q += w[i] * (d[i] - s.proto[i]) ** 2;
      raw[k] = Math.exp(-q / s2); sum += raw[k];
    }
    const scores = Object.entries(raw).map(([k, v]) => [k, sum ? v / sum : 0]).sort((a, b) => b[1] - a[1]);
    return { key: scores[0][0], scores, ratios: m };
  }

  // ---------- drawing ----------
  function lensPath(ctx, type) {
    // one lens centred at (0,0), outer side towards +x; lens centres sit at x = ±C (C below)
    ctx.beginPath();
    switch (type) {
      case 'rect': roundRect(ctx, -0.38, -0.21, 0.78, 0.42, 0.08); break;
      case 'square': roundRect(ctx, -0.36, -0.31, 0.74, 0.6, 0.07); break;
      case 'round': ctx.arc(0, 0, 0.34, 0, Math.PI * 2); break;
      case 'oval': ctx.ellipse(0, 0, 0.39, 0.27, 0, 0, Math.PI * 2); break;
      case 'aviator':
        ctx.moveTo(-0.34, -0.25); ctx.lineTo(0.4, -0.28);
        ctx.bezierCurveTo(0.47, -0.08, 0.38, 0.3, 0.1, 0.37);
        ctx.bezierCurveTo(-0.18, 0.42, -0.38, 0.18, -0.34, -0.25); break;
      case 'browline':
        ctx.moveTo(-0.38, -0.19); ctx.lineTo(0.4, -0.22);
        ctx.bezierCurveTo(0.42, 0.1, 0.28, 0.29, 0.01, 0.29);
        ctx.bezierCurveTo(-0.28, 0.29, -0.4, 0.09, -0.38, -0.19); break;
      case 'cateye':
        ctx.moveTo(-0.36, -0.14); ctx.quadraticCurveTo(0.08, -0.27, 0.46, -0.33);
        ctx.quadraticCurveTo(0.41, 0.09, 0.16, 0.26);
        ctx.quadraticCurveTo(-0.18, 0.33, -0.35, 0.12); ctx.closePath(); break;
    }
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function drawFrame(ctx, type, P, m) {
    const eyeL = { x: (P[33].x + P[133].x) / 2, y: (P[33].y + P[133].y) / 2 };
    const eyeR = { x: (P[362].x + P[263].x) / 2, y: (P[362].y + P[263].y) / 2 };
    const cx = (eyeL.x + eyeR.x) / 2, cy = (eyeL.y + eyeR.y) / 2;
    const C = 0.48, u = (dist(eyeL, eyeR) / 2) / C;   // lens centres land on the eyes
    const col = type === 'aviator' ? '#b08d3c' : '#141414';
    const lw = type === 'browline' ? 0.032 : 0.04;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(m.roll); ctx.scale(u, u);
    ctx.strokeStyle = col; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      ctx.save(); ctx.translate(side * C, 0); ctx.scale(side, 1);
      lensPath(ctx, type);
      ctx.fillStyle = 'rgba(160,190,210,0.16)'; ctx.fill();
      ctx.lineWidth = lw; ctx.stroke();
      if (type === 'browline') { ctx.beginPath(); ctx.moveTo(-0.39, -0.19); ctx.lineTo(0.41, -0.22); ctx.lineWidth = 0.11; ctx.stroke(); }
      ctx.restore();
    }
    ctx.lineWidth = lw; ctx.beginPath();
    ctx.moveTo(-0.13, -0.1); ctx.quadraticCurveTo(0, -0.2, 0.13, -0.1);              // bridge
    if (type === 'aviator') { ctx.moveTo(-0.14, -0.25); ctx.lineTo(0.14, -0.25); }   // double bridge
    ctx.moveTo(-C - 0.4, -0.19); ctx.lineTo(-C - 0.58, -0.17);                        // temples
    ctx.moveTo(C + 0.4, -0.19); ctx.lineTo(C + 0.58, -0.17);
    ctx.stroke();
    ctx.restore();
  }

  function drawOverlay(ctx, P, m, scale) {
    const acc = css('--line') || '#f2b134';
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2.2 * scale;
    ctx.setLineDash([6 * scale, 6 * scale]);
    ctx.beginPath(); OVAL.forEach((i, k) => k ? ctx.lineTo(P[i].x, P[i].y) : ctx.moveTo(P[i].x, P[i].y)); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `600 ${Math.round(13 * scale)}px "IBM Plex Sans Arabic", Tahoma, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const L of LINES) {
      const a = P[L.a], b = P[L.b];
      ctx.strokeStyle = acc; ctx.lineWidth = 3 * scale;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p.x, p.y, 4 * scale, 0, Math.PI * 2); ctx.fillStyle = acc; ctx.fill(); }
      const tx = L.vertical ? a.x + 10 * scale : b.x + 10 * scale;
      const ty = L.vertical ? (a.y + b.y) / 2 : b.y;
      const w = ctx.measureText(L.label).width + 12 * scale;
      let x = tx; if (x + w > ctx.canvas.width / ctx.getTransform().a - 4) x = Math.min(a.x, b.x) - 10 * scale - w;
      const tx2 = Math.max(4, x);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(tx2, ty - 11 * scale, w, 22 * scale, 6 * scale) : ctx.rect(tx2, ty - 11 * scale, w, 22 * scale); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(L.label, tx2 + w / 2, ty + 1);
    }
    ctx.restore();
  }

  // Zoom the photo to the face (portrait 4:5) so the lines and glasses are easy to see and share.
  function cropToFace() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of OVAL) { const p = pts[i]; x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    const fw = x1 - x0, fh = y1 - y0;
    let w = Math.max(fw * 2.1, fh * 1.75 / 1.25), h = w * 1.25;
    w = Math.min(w, photo.width); h = Math.min(h, photo.height);
    if (h / w > 1.25) h = w * 1.25; else w = Math.min(w, h / 1.25);
    let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2 - fh * 0.08;
    let sx = Math.max(0, Math.min(photo.width - w, cx - w / 2)), sy = Math.max(0, Math.min(photo.height - h, cy - h / 2));
    const out = Math.min(900, w) / w;
    const c = document.createElement('canvas'); c.width = Math.round(w * out); c.height = Math.round(h * out);
    c.getContext('2d').drawImage(photo, sx, sy, w, h, 0, 0, c.width, c.height);
    pts = pts.map(p => ({ x: (p.x - sx) * out, y: (p.y - sy) * out }));
    photo = c;
  }

  function renderStage() {
    const c = $('view'), ctx = c.getContext('2d');
    c.width = photo.width; c.height = photo.height;
    ctx.drawImage(photo, 0, 0);
    if (!pts) return;
    const s = Math.max(1, photo.width / 380);
    if (frame) drawFrame(ctx, frame, pts, result.ratios);
    else if ($('showLines').checked) drawOverlay(ctx, pts, result.ratios, s);
  }

  // Shareable card: photo with lines + a band with the result.
  async function makeCard() {
    const W = 1080, pad = 48;
    const k = W / photo.width, ph = Math.round(photo.height * k);
    const band = 300;
    const c = document.createElement('canvas'); c.width = W; c.height = ph + band;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#14191f'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.save(); ctx.scale(k, k); ctx.drawImage(photo, 0, 0);
    if (frame) drawFrame(ctx, frame, pts, result.ratios); else drawOverlay(ctx, pts, result.ratios, Math.max(1, photo.width / 380));
    ctx.restore();
    const S = SHAPES[result.key];
    ctx.direction = 'rtl'; ctx.textAlign = 'right'; ctx.fillStyle = '#9fb3c3';
    ctx.font = '500 34px "IBM Plex Sans Arabic", Tahoma, sans-serif';
    ctx.fillText('شكل وجهك', W - pad, ph + 70);
    ctx.fillStyle = '#ffffff'; ctx.font = '700 72px "Reem Kufi", Tahoma, sans-serif';
    ctx.fillText(S.name, W - pad, ph + 160);
    ctx.fillStyle = '#f2b134'; ctx.font = '500 32px "IBM Plex Sans Arabic", Tahoma, sans-serif';
    const line = frame ? 'تجربة نظارة: ' + FRAMES[frame].name : tab === 'hijab' ? 'لفّة مناسبة: ' + S.hijab.good[0] : tab === 'glasses' ? 'نظارات مناسبة: ' + S.glasses.good.map(k => FRAMES[k].name).join('، ') : 'أنسب قصة: ' + S.hair.good[0];
    ctx.fillText(line.length > 52 ? line.slice(0, 50) + '…' : line, W - pad, ph + 232);
    return new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  }

  // ---------- result UI ----------
  function li(t) { const e = document.createElement('li'); e.textContent = t; return e; }
  function fill(id, arr) { const u = $(id); u.replaceChildren(...arr.map(li)); }

  function showResult() {
    const S = SHAPES[result.key];
    $('shapeName').textContent = S.name;
    $('shapeAbout').textContent = S.about;
    const bars = $('bars'); bars.replaceChildren();
    for (const [k, v] of result.scores.slice(0, 3)) {
      const row = document.createElement('div'); row.className = 'barrow';
      const n = document.createElement('span'); n.textContent = SHAPES[k].name;
      const t = document.createElement('div'); t.className = 'track';
      const f = document.createElement('i'); f.style.width = Math.max(3, Math.round(v * 100)) + '%'; t.append(f);
      const p = document.createElement('b'); p.textContent = Math.round(v * 100) + '٪';
      row.append(n, t, p); bars.append(row);
    }
    const r = result.ratios;
    $('ratios').textContent = `الطول ÷ عرض الخدود ${r.R.toFixed(2)} · الفك ${r.J.toFixed(2)} · الجبهة ${r.F.toFixed(2)}`;
    fill('hairGood', S.hair.good); fill('hairAvoid', S.hair.avoid); fill('beard', S.hair.beard);
    fill('hijabGood', S.hijab.good); fill('hijabAvoid', S.hijab.avoid);
    fill('glassAvoid', S.glasses.avoid);
    const chips = $('frames'); chips.replaceChildren();
    const order = [...S.glasses.good, ...Object.keys(FRAMES).filter(k => !S.glasses.good.includes(k))];
    for (const k of order) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
      b.textContent = FRAMES[k].name + (S.glasses.good.includes(k) ? ' ✓' : '');
      b.dataset.good = S.glasses.good.includes(k);
      b.setAttribute('aria-pressed', frame === k);
      b.onclick = () => { frame = frame === k ? null : k; showResult(); renderStage(); };
      chips.append(b);
    }
    $('result').hidden = false;
    setTab(tab);
  }
  function setTab(t) {
    tab = t;
    for (const k of ['hair', 'glasses', 'hijab']) {
      $('tab-' + k).setAttribute('aria-selected', k === t);
      $('pane-' + k).hidden = k !== t;
    }
    if (t !== 'glasses' && frame) { frame = null; showResult(); renderStage(); }
  }
  ['hair', 'glasses', 'hijab'].forEach(k => $('tab-' + k).onclick = () => setTab(k));
  $('showLines').onchange = renderStage;

  // ---------- input ----------
  async function decode(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      const url = URL.createObjectURL(file);
      try { const im = new Image(); im.src = url; await im.decode(); return im; } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
  }
  async function handle(file) {
    if (!file) return;
    say(''); frame = null;
    try {
      busy(true, 'جاري فتح الصورة…'); await paint();
      let img;
      try { img = await decode(file); } catch { throw new Error('ما گدرت أفتح الصورة. جرّب لقطة شاشة منها أو صورة JPG.'); }
      const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      photo = document.createElement('canvas');
      photo.width = Math.round(img.width * k); photo.height = Math.round(img.height * k);
      photo.getContext('2d').drawImage(img, 0, 0, photo.width, photo.height);
      pts = null; result = null; $('result').hidden = true; $('stageWrap').hidden = false; renderStage();
      busy(true, 'جاري قراءة ملامح الوجه…'); await paint();
      const r = await detect(photo);
      const lm = r.multiFaceLandmarks && r.multiFaceLandmarks[0];
      if (!lm) throw new Error('ما لگيت وجه بالصورة. صوّر وجهك من الگدام بإضاءة زينة.');
      pts = lm.map(p => ({ x: p.x * photo.width, y: p.y * photo.height }));
      cropToFace();
      const m = measure(pts);
      result = classify(m);
      renderStage(); showResult();
      if (m.yaw > 0.22) say('وجهك مايل شوية، فالنتيجة ممكن ما تكون دقيقة. للأدق: صوّر من الگدام والشعر مرجوع عن الجبهة.');
      else say('');
      $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      console.error(e);
      say(e && e.message ? e.message : String(e), true);
    } finally { busy(false); }
  }
  for (const id of ['fileCam', 'fileGal']) $(id).addEventListener('change', e => { handle(e.target.files[0]); e.target.value = ''; });

  // ---------- save & share (Capacitor) ----------
  const Plug = () => (window.Capacitor && window.Capacitor.Plugins) || {};
  const toB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  async function shareCard(text) {
    const { Filesystem, Share } = Plug();
    const blob = await makeCard();
    if (!Filesystem || !Share) { say('المشاركة تشتغل داخل التطبيق فقط.'); return; }
    const data = (await toB64(blob)).split(',')[1];
    const w = await Filesystem.writeFile({ path: 'shakl-' + Date.now() + '.jpg', data, directory: 'CACHE' });
    await Share.share({ title: 'شكل وجهك', text, files: [w.uri], dialogTitle: 'مشاركة' });
  }
  function summary() {
    const S = SHAPES[result.key];
    if (tab === 'glasses') return `شكل وجهي ${S.name}. النظارات المناسبة: ${S.glasses.good.map(k => FRAMES[k].name).join('، ')}.`;
    if (tab === 'hijab') return `شكل وجهي ${S.name}. اللفّات المناسبة: ${S.hijab.good.join('، ')}.`;
    return `مرحبا، شكل وجهي ${S.name}. القصات المناسبة إلي: ${S.hair.good.join('، ')}. واللحية: ${S.hair.beard.join('، ')}.`;
  }
  $('share').onclick = async () => {
    if (!result) return;
    try { await shareCard(summary()); }
    catch (e) { if (!/cancel/i.test(String(e && e.message))) say('المشاركة ما اشتغلت: ' + (e.message || e), true); }
  };
  $('save').onclick = async () => {
    if (!result) return;
    const { Media } = Plug();
    try {
      if (!Media) throw new Error('no media');
      const ALBUM = 'شكل وجهك';
      const find = async () => ((await Media.getAlbums()).albums || []).find(a => a.name === ALBUM);
      let a = await find(); if (!a) { await Media.createAlbum({ name: ALBUM }); a = await find(); }
      if (!a) throw new Error('no album');
      await Media.savePhoto({ path: await toB64(await makeCard()), albumIdentifier: a.identifier, fileName: 'shakl-' + Date.now() });
      say('انحفظت بالاستوديو بألبوم "شكل وجهك".');
    } catch (e) {
      console.error(e);
      say('ما گدرت أحفظها مباشرة. اختار "حفظ" أو "الصور" من قائمة المشاركة.');
      try { await shareCard(''); } catch {}
    }
  };

  // warm up the model in the background so the first photo is quicker
  setTimeout(() => { getMesh().catch(e => console.warn('mesh init', e)); }, 400);

  // test hook
  window.__shakl = { handle, measure, classify, get result() { return result; }, makeCard };
})();
