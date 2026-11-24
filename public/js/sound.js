// UI sounds — synthesized with Web Audio (no audio files).
// Designed to feel "satisfying": rounded bubble-pop clicks with a soft body,
// a tiny bit of randomness so repeated taps never sound robotic, and a gentle
// compressor + low-pass on the master so nothing is sharp or tinny.
// Silent automatically when: the device is on silent / Do Not Disturb (the OS
// mutes web audio), the tab is hidden, or the user turns sound off in Profile.
const KEY_ON = 'alaan.sound', KEY_VOL = 'alaan.volume';
let ctx = null, master = null, unlocked = false, lastPlay = {}, clickBuf = null, clickLoading = false;
const CLICK_URL = '/sounds/click.wav'; // the store's chosen click sound

export const sound = {
  get enabled() { try { return localStorage.getItem(KEY_ON) !== 'off'; } catch { return true; } },
  set enabled(v) { try { localStorage.setItem(KEY_ON, v ? 'on' : 'off'); } catch { /* blocked */ } },
  get volume() { try { const v = Number(localStorage.getItem(KEY_VOL)); return Number.isFinite(v) && v > 0 ? Math.min(1, v) : 0.6; } catch { return 0.6; } },
  set volume(v) { try { localStorage.setItem(KEY_VOL, String(v)); } catch { /* blocked */ } if (master) master.gain.value = v * 0.5; },
  play(name) {
    if (!sound.enabled || document.hidden) return;
    const fn = FX[name]; if (!fn) return;
    try {
      ensure();
      // De-bounce double triggers. Celebratory sounds can never legitimately repeat within 1.2 s,
      // so a second call from another code path is ignored instead of playing twice.
      const gap = name === 'success' || name === 'coin' || name === 'notify' ? 1200 : 35;
      const now = performance.now(); if (lastPlay[name] && now - lastPlay[name] < gap) return; lastPlay[name] = now;
      // Phones suspend audio after the screen locks or the app goes to the background:
      // resume it inside this tap and play as soon as it is running again.
      if (ctx.state !== 'running') { ctx.resume().then(() => { if (ctx.state === 'running') fn(ctx.currentTime + 0.01); }).catch(() => {}); return; }
      fn(ctx.currentTime + 0.005);
    } catch { /* audio unavailable */ }
  },
};

function ensure() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) throw new Error('no audio');
  ctx = new AC();
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = .002; comp.release.value = .12;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000; lp.Q.value = .5;
  master = ctx.createGain(); master.gain.value = sound.volume * 0.5;
  master.connect(lp).connect(comp).connect(ctx.destination);
  loadClick();
}
function loadClick() {
  if (clickBuf || clickLoading) return; clickLoading = true;
  fetch(CLICK_URL).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)).then(buf => { clickBuf = buf; }).catch(() => { clickLoading = false; });
}
// Plays the click sample; falls back to the synthesized bubble until it loads.
function click(t, { rate = 1, gain = 1 } = {}) {
  if (!clickBuf) { bubble(t, { gain }); return; }
  const s = ctx.createBufferSource(), g = ctx.createGain();
  s.buffer = clickBuf; s.playbackRate.value = rate; g.gain.value = gain;
  s.connect(g).connect(master); s.start(t);
}
// Unlock (and re-unlock) audio on every user gesture: iOS/Android suspend or "interrupt" the
// audio context after a call, screen lock or app switch, and only a tap may start it again.
const unlock = () => { try { ensure(); if (ctx.state !== 'running') ctx.resume().catch(() => {}); unlocked = true; } catch { /* ignore */ } };
addEventListener('pointerdown', unlock, { passive: true, capture: true }); addEventListener('touchend', unlock, { passive: true, capture: true }); addEventListener('keydown', unlock, { capture: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx && ctx.state !== 'running' && unlocked) ctx.resume().catch(() => {}); });

// ---- Building blocks ----------------------------------------------------
const vary = (v, pct = .04) => v * (1 + (Math.random() * 2 - 1) * pct);
function blip(t, { from, to, dur = .08, gain = .5, type = 'sine', attack = .002, curve = 'exp' }) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(from, t); if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack);
  if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t + dur); else g.gain.setTargetAtTime(0.0001, t + attack, dur / 4);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + .05);
}
let noiseBuf;
function burst(t, { dur = .03, gain = .3, type = 'bandpass', freq = 2000, q = 1, sweepTo = null }) {
  if (!noiseBuf) { noiseBuf = ctx.createBuffer(1, ctx.sampleRate * .5, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf; s.loop = true; f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + .003); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + dur + .02);
}
// The signature click: rounded "bubble" pop + soft body thump + tiny bright tick.
function bubble(t, { pitch = 1, gain = 1, bodyGain = .45 } = {}) {
  const p = vary(pitch);
  blip(t, { from: 760 * p, to: 420 * p, dur: .07, gain: .55 * gain });          // the pop
  blip(t, { from: 160 * p, to: 95 * p, dur: .06, gain: bodyGain * gain });     // soft low body
  burst(t, { dur: .018, gain: .14 * gain, freq: 3200, q: 1.2 });               // tick
}

// ---- Effects ------------------------------------------------------------
const FX = {
  tap: t => click(t),
  tab: t => click(t),
  toggle: t => click(t),
  pop: t => { const p = vary(1, .06); blip(t, { from: 320 * p, to: 980 * p, dur: .11, gain: .5 }); blip(t + .01, { from: 140, to: 90, dur: .05, gain: .3 }); burst(t + .005, { dur: .02, gain: .12, freq: 4000, q: 1.5 }); },
  remove: t => { blip(t, { from: 640, to: 240, dur: .14, gain: .4 }); blip(t, { from: 130, to: 80, dur: .07, gain: .3 }); },
  success: t => {
    [659.25, 783.99, 987.77, 1318.5].forEach((f, i) => { const at = t + i * .085; blip(at, { from: f, dur: .45, gain: .26, curve: 'target' }); blip(at, { from: f * 2.01, dur: .25, gain: .06, type: 'triangle', curve: 'target' }); });
    blip(t, { from: 196, dur: .5, gain: .18, curve: 'target' });
    burst(t + .3, { dur: .12, gain: .06, type: 'highpass', freq: 5000 });
  },
  coin: t => { blip(t, { from: 2093, dur: .22, gain: .18, type: 'triangle', curve: 'target' }); blip(t + .06, { from: 2637, dur: .32, gain: .2, curve: 'target' }); blip(t, { from: 1046, dur: .12, gain: .08 }); },
  error: t => { blip(t, { from: 230, to: 170, dur: .13, gain: .38, type: 'triangle' }); blip(t + .14, { from: 200, to: 140, dur: .16, gain: .34, type: 'triangle' }); burst(t, { dur: .03, gain: .08, freq: 900, q: 1 }); },
  warn: t => { blip(t, { from: 420, to: 330, dur: .12, gain: .28, type: 'triangle' }); },
  notify: t => { blip(t, { from: 880, dur: .35, gain: .28, curve: 'target' }); blip(t, { from: 1760, dur: .2, gain: .08, curve: 'target' }); blip(t + .13, { from: 1174.7, dur: .45, gain: .22, curve: 'target' }); },
  open: t => { burst(t, { dur: .12, gain: .09, freq: 500, q: .7, sweepTo: 2600 }); blip(t, { from: 280, to: 520, dur: .1, gain: .12 }); },
  close: t => { burst(t, { dur: .1, gain: .08, freq: 2400, q: .7, sweepTo: 500 }); blip(t, { from: 520, to: 280, dur: .09, gain: .1 }); },
};

// ---- Global hooks: every actual control activation clicks; scrolling never does. ----
// Use click rather than pointerdown so a swipe/scroll gesture never triggers a sound,
// and touch browsers cannot double-play pointer + touch feedback. It listens in the capture
// phase so a control that calls stopPropagation() (the + on a product card) is still heard.
document.addEventListener('click', e => {
  const selector = 'button, a[href], [role="button"], .product, .list__item.click, tr.click, .kpi.click, .card.click, .order, .tap, .cal .day, .day, .userchip';
  const target = e.composedPath().find(node => node instanceof Element && (node.matches(selector) || typeof node.onclick === 'function'));
  if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true' || target.closest('[data-silent-click]')) return;
  if (target.matches('.theme, .toggle')) sound.play('toggle');
  else if (target.matches('.pills button, .seg button, .bottomnav a, .rail a, .tabs a, .tabs button')) sound.play('tab');
  else sound.play('tap');
}, true); // capture: buttons that stop the click from bubbling (like the + on a material) still click
