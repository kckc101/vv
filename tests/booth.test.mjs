// Regression tests for the audit fixes. Each test names the audit item it
// covers (B = bug, C = compatibility, D = dead code, O = optimisation).
// Run with: npm test   (or: node --test "tests/*.test.mjs")

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { loadBooth, extractParts, busyCameraError } from './harness.mjs';

/* ---------------- helpers ---------------- */

async function openRoom(kc){
  kc.$('createQrBtn').click();
  await kc.clock.advance(10);
  const host = kc.env.peers.at(-1);
  host.emit('open', host.id);
  return host;
}

// A host with a friend fully connected: call answered, data channel open, video arriving.
async function startHostParty(kc, guestId = 'GUEST-A'){
  const host = await openRoom(kc);
  const call = kc.makeIncomingCall(guestId);
  host.emit('call', call);
  const conn = kc.makeIncomingConn(guestId);
  host.emit('connection', conn);
  conn.openNow();
  call.emit('stream', kc.makeRemoteStream());
  assert.equal(kc.eval('partyMode'), true, 'party should be running');
  return { host, call, conn };
}

async function startJoin(kc, code = 'ABCDEFGH'){
  const pending = kc.eval(`joinParty(${JSON.stringify(code)})`);
  await kc.clock.advance(10);
  await pending;
  return kc.env.peers.at(-1);
}

// Index of a party backdrop by id.
function backdrop(kc, id){
  const i = kc.eval('PARTY_BACKGROUNDS.findIndex(b => b.id === ' + JSON.stringify(id) + ')');
  assert.ok(i >= 0, 'backdrop ' + id + ' exists');
  return i;
}

// The strip column is showing one big print (as opposed to the four-frame strip).
function singlePrint(kc){
  return !kc.$('effectStripWrap').hidden && kc.$('normalStripWrap').hidden
    && kc.$('effectStrip').classList.contains('single-frame');
}

// The stylesheet's declarations, without its (many) comments.
function stylesheet(){
  return extractParts().css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/* CSS rules whose selector is exactly `selector`. */
function rulesFor(css, selector){
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?:^|[\\n}])\\s*' + esc + '\\s*\\{([^}]*)\\}', 'g');
  const out = [];
  let m;
  while ((m = re.exec(css))) out.push(m[1]);
  return out;
}

/* ---------------- load ---------------- */

test('page script loads without throwing and builds one pip and one frame per shot (O7)', async () => {
  const kc = await loadBooth();
  const total = kc.eval('TOTAL_SHOTS');
  assert.equal(kc.document.querySelectorAll('.shot-pip').length, total);
  for (let i = 0; i < total; i++) assert.ok(kc.$('frame' + i), 'frame' + i + ' exists');
  assert.equal(kc.$('frame0').textContent, '01');
  assert.equal(kc.$('shotCount').textContent, '0 / ' + total);
  const kids = kc.$('strip').children;
  assert.ok(kids[kids.length - 1].classList.contains('strip-footer'), 'frames sit before the footer');
  assert.equal(kc.$('captureBtn').textContent, 'Take strip (' + total + ' shots)');
});

/* ---------------- B1 / C4: stylesheet ---------------- */

test('B1: the reel rail can be swiped sideways on a touch screen', () => {
  const rules = rulesFor(stylesheet(), '.reel-strip');
  assert.ok(rules.length > 0, '.reel-strip rule found');
  for (const body of rules){
    const m = body.match(/touch-action:\s*([^;]+);/);
    if (!m) continue;
    const value = m[1].trim();
    assert.ok(/pan-x|manipulation|auto/.test(value), `touch-action "${value}" blocks horizontal panning`);
  }
});

test('C4: no background-attachment: fixed (ignored on iOS, janky on Android)', () => {
  const css = stylesheet();
  assert.ok(!/background-attachment\s*:\s*fixed/.test(css));
  // The colour washes moved, they didn't disappear.
  const before = rulesFor(css, 'body::before').join('');
  assert.match(before, /position:fixed/);
  assert.equal((before.match(/radial-gradient/g) || []).length, 2);
});

/* ---------------- B2: ctx.filter probe ---------------- */

test('B2: the ctx.filter probe says no when the property is only a JS expando', async () => {
  const kc = await loadBooth({ ctxFilter: 'expando' });
  assert.equal(kc.eval('CTX_FILTER_OK'), false);
});

test('B2: the ctx.filter probe says yes when the filter really changes pixels', async () => {
  const kc = await loadBooth({ ctxFilter: 'native' });
  assert.equal(kc.eval('CTX_FILTER_OK'), true);
});

test('B2: with pixel readback shielded, the probe trusts the property instead', async () => {
  const kc = await loadBooth({ ctxFilter: 'native-shielded' });
  assert.equal(kc.eval('CTX_FILTER_OK'), true);
});

test('B2: without ctx.filter, captured shots are toned by hand', async () => {
  const kc = await loadBooth({ ctxFilter: 'expando' });
  await kc.startCamera();
  kc.eval('applyFilterIndex(11)');                     // Classic Mono
  const ctx = kc.$('freezeCanvas').getContext('2d');
  ctx.calls = [];
  await kc.capture();
  assert.ok(ctx.calls.some(c => c[0] === 'putImageData'), 'manual colour matrix ran on the shot');
});

/* ---------------- C6: hue-rotate units ---------------- */

test('C6: hue-rotate accepts turn, rad and grad as well as deg', async () => {
  const kc = await loadBooth();
  const m = (s) => kc.eval(`filterStringToMatrix(${JSON.stringify(s)})`);
  const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  const ref = m('hue-rotate(180deg)');
  assert.ok(close(m('hue-rotate(0.5turn)'), ref));
  assert.ok(close(m('hue-rotate(' + Math.PI + 'rad)'), ref));
  assert.ok(close(m('hue-rotate(200grad)'), ref));
  assert.ok(!close(ref, m('none')));
});

/* ---------------- B3: remote backdrop messages ---------------- */

test('B3: a backdrop change from the friend waits until the running capture ends', async () => {
  const kc = await loadBooth();
  const subway = backdrop(kc, 'bg_subway');            // a single-shot scene: the layout would flip
  await kc.startCamera();
  kc.eval('partyMode = true');
  const run = kc.eval('runCaptureSequence()');
  await kc.clock.advance(500);
  assert.equal(kc.eval('busy'), true);
  kc.eval('handlePartyData')({ type: 'bg', index: subway });
  assert.equal(kc.eval('selectedBgIndex'), 0, 'not applied mid-sequence');
  assert.equal(kc.$('effectStripWrap').hidden, true, 'layout did not flip mid-sequence');
  await kc.clock.advance(30000);
  await run;
  assert.equal(kc.eval('shots.length'), kc.eval('TOTAL_SHOTS'), 'the strip was shot in full');
  assert.equal(kc.eval('selectedBgIndex'), subway, 'applied once the sequence ended');
  assert.ok(singlePrint(kc), 'and the layout followed it');
});

test('B3: malformed backdrop indexes from the other device are ignored', async () => {
  const kc = await loadBooth();
  const handle = kc.eval('handlePartyData');
  const count = kc.eval('PARTY_BACKGROUNDS.length');
  for (const index of ['1', 1.5, -1, count, 99, '__proto__', 'length', null, undefined]){
    handle({ type: 'bg', index });
    assert.equal(kc.eval('selectedBgIndex'), 0, `index ${String(index)} was accepted`);
  }
  handle({ type: 'bg', index: count - 1 });
  assert.equal(kc.eval('selectedBgIndex'), count - 1);
});

/* ---------------- B4: one guest per room ---------------- */

test('B4: a room answers one guest and turns a second caller away', async () => {
  const kc = await loadBooth();
  const host = await openRoom(kc);
  const a = kc.makeIncomingCall('GUEST-A');
  host.emit('call', a);
  assert.ok(a.answeredWith, 'first caller answered with the camera');
  const b = kc.makeIncomingCall('GUEST-B');
  host.emit('call', b);
  assert.equal(b.answeredWith, undefined, 'second caller never sees the camera');
  assert.equal(b.closed, true);
  assert.equal(kc.eval('mediaCall'), a);

  const strangerConn = kc.makeIncomingConn('GUEST-B');
  host.emit('connection', strangerConn);
  assert.equal(strangerConn.closed, true, 'data channel from a stranger refused');
  const friendConn = kc.makeIncomingConn('GUEST-A');
  host.emit('connection', friendConn);
  assert.equal(kc.eval('partyConn'), friendConn);
});

test('B4: a turned-away caller cannot end the real party', async () => {
  const kc = await loadBooth();
  const { host } = await startHostParty(kc);
  const b = kc.makeIncomingCall('GUEST-B');
  host.emit('call', b);
  b.close();
  assert.equal(kc.eval('partyMode'), true);
});

test('B4: a call that fails before the party starts frees the room for a retry', async () => {
  const kc = await loadBooth();
  const host = await openRoom(kc);
  const a = kc.makeIncomingCall('GUEST-A');
  host.emit('call', a);
  a.emit('error', new Error('negotiation failed'));
  assert.equal(kc.eval('mediaCall'), null);
  const c = kc.makeIncomingCall('GUEST-C');
  host.emit('call', c);
  assert.ok(c.answeredWith, 'the room took the next caller');
  assert.equal(host.destroyed, false, 'the room itself stayed open');
});

/* ---------------- B5: guest dials once ---------------- */

test('B5: a guest dials the host once even after the broker reconnects', async () => {
  const kc = await loadBooth();
  const guest = await startJoin(kc);
  guest.emit('open', guest.id);
  assert.equal(guest.outgoingCalls.length, 1);
  guest.emit('disconnected');
  assert.equal(guest.reconnects, 1, 'reconnect attempted');
  guest.emit('open', guest.id);
  assert.equal(guest.outgoingCalls.length, 1, 'no second call');
  assert.equal(guest.outgoingConns.length, 1, 'no second data channel');
});

/* ---------------- B6: one peer at a time ---------------- */

test('B6: joining while hosting closes the room instead of orphaning it', async () => {
  const kc = await loadBooth();
  const host = await openRoom(kc);
  assert.ok(kc.$('qrHostFrame').classList.contains('show'));
  const guest = await startJoin(kc, 'ZZZZZZZZ');
  assert.equal(host.destroyed, true, 'the old room was destroyed');
  assert.notEqual(guest, host);
  assert.equal(kc.eval('peer'), guest);
  assert.equal(kc.$('qrHostFrame').classList.contains('show'), false);
  assert.equal(kc.$('createQrBtn').disabled, false);
  // The destroyed room's own 'disconnected' must not resurrect it.
  host.emit('disconnected');
  assert.equal(host.reconnects, 0);
});

test('B6: a failed join destroys its peer before the retry', async () => {
  const kc = await loadBooth();
  const first = await startJoin(kc);
  first.emit('error', { type: 'peer-unavailable' });
  assert.equal(first.destroyed, true);
  assert.equal(kc.eval('peer'), null);
  assert.equal(kc.$('joinBtn').disabled, false);
  assert.match(kc.$('joinStatus').textContent, /peer-unavailable/);
  const second = await startJoin(kc);
  assert.notEqual(second, first);
  assert.equal(kc.env.peers.filter(p => !p.destroyed).length, 1, 'only one live peer');
});

test('B6: Create a room and Connect are locked while a party runs', async () => {
  const kc = await loadBooth();
  await startHostParty(kc);
  assert.equal(kc.$('createQrBtn').disabled, true);
  assert.equal(kc.$('joinBtn').disabled, true);
  const before = kc.env.peers.length;
  await startJoin(kc, 'ZZZZZZZZ');
  assert.equal(kc.env.peers.length, before, 'no new peer while in a party');
  kc.eval("exitPartyMode('You left the party.')");
  assert.equal(kc.$('createQrBtn').disabled, false);
  assert.equal(kc.$('joinBtn').disabled, false);
});

test('B6: a non-fatal error keeps the room open; a fatal one closes it', async () => {
  const kc = await loadBooth();
  const host = await openRoom(kc);
  host.emit('error', { type: 'webrtc' });
  assert.equal(host.destroyed, false);
  assert.match(kc.$('qrHostStatus').textContent, /still open/);
  host.emit('error', { type: 'network' });
  assert.equal(host.destroyed, true);
  assert.equal(kc.$('createQrBtn').disabled, false);
});

/* ---------------- B7: stalled friend ---------------- */

test('B7: a stalled friend with the data channel open is shown as paused, not dropped', async () => {
  const kc = await loadBooth();
  await startHostParty(kc);
  await kc.clock.advance(8000);                   // ten watchdog ticks without a new frame
  assert.equal(kc.eval('partyMode'), true);
  assert.match(kc.$('qrHostStatus').textContent, /paused/);
  kc.$('remoteVideo').currentTime = 12.5;          // frames resume
  await kc.clock.advance(800);
  assert.match(kc.$('qrHostStatus').textContent, /Connected/);
  assert.equal(kc.eval('partyMode'), true);
});

test('B7: the data channel closing without a goodbye is a reconnect, ended by its deadline', async () => {
  const kc = await loadBooth();
  const { conn } = await startHostParty(kc);
  conn.close();
  await kc.clock.advance(6000);
  assert.equal(kc.eval('partyMode'), true, 'not ended: the friend may be switching networks');
  assert.ok(kc.eval('!!reconnecting'));
  assert.match(kc.$('qrHostStatus').textContent, /reconnecting/i);
  await kc.clock.advance(40000);                    // 46 s in all, past the 45 s window
  assert.equal(kc.eval('partyMode'), false);
  assert.match(kc.$('qrHostStatus').textContent, /couldn\u2019t be restored/);
});

test('B7: a stall that never recovers still ends the party after about 45 s', async () => {
  const kc = await loadBooth();
  await startHostParty(kc);
  await kc.clock.advance(30000);
  assert.equal(kc.eval('partyMode'), true);
  await kc.clock.advance(17000);
  assert.equal(kc.eval('partyMode'), false);
});

/* ---------------- B8: camera taken away ---------------- */

test('B8: a camera taken away by the OS returns the booth to its start state', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.env.tracks.at(-1).endExternally();
  const shutter = kc.$('macShutter');
  assert.equal(kc.eval('stream'), null);
  assert.ok(shutter.classList.contains('is-start'));
  assert.equal(shutter.disabled, false);
  assert.equal(kc.$('placeholder').style.display, 'flex');
  assert.match(kc.$('placeholder').textContent, /camera stopped/i);

  shutter.click();                                  // the same red button brings it back
  await kc.clock.advance(10);
  assert.ok(kc.eval('stream'));
  assert.ok(!shutter.classList.contains('is-start'));
  assert.equal(kc.$('placeholder').style.display, 'none');
});

test('B8: losing the camera mid-strip stops the sequence instead of shooting black frames', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.$('macShutter').click();
  await kc.clock.advance(1500);
  kc.env.tracks.at(-1).endExternally();
  await kc.clock.advance(5000);
  assert.equal(kc.eval('busy'), false);
  assert.equal(kc.eval('shots.length'), 0);
  assert.equal(kc.$('downloadBtn').disabled, true);
  assert.equal(kc.$('startBtn').disabled, false, 'the shutter can restart the camera');
});

/* ---------------- B9: one camera at a time ---------------- */

test('B9: switching cameras on a phone that holds one camera at a time releases the old one and retries', async () => {
  const kc = await loadBooth({ oneCameraAtATime: true });
  await kc.startCamera();
  const front = kc.env.tracks.at(-1);
  kc.document.querySelector('.cam-chip[data-facing="environment"]').click();
  await kc.clock.advance(10);
  assert.equal(front.stopped, true);
  assert.equal(kc.eval('currentFacing'), 'environment');
  assert.ok(kc.eval('stream'));
  assert.ok(kc.document.querySelector('.cam-chip[data-facing="environment"]').classList.contains('active'));
});

test('B9: if the new camera still fails, the old one is put back', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  // Busy while anything is held; once released, only the front camera opens.
  kc.env.gumImpl = async (c) => {
    if (kc.env.cameraIsHeld()) throw busyCameraError();
    if (kc.env.facingOf(c) !== 'user') throw busyCameraError();
    return kc.env.cameraStream(c);
  };
  kc.document.querySelector('.cam-chip[data-facing="environment"]').click();
  await kc.clock.advance(10);
  assert.ok(kc.eval('stream'), 'booth is not left dark');
  assert.equal(kc.eval('currentFacing'), 'user');
  assert.ok(kc.document.querySelector('.cam-chip[data-facing="user"]').classList.contains('active'));
  for (const chip of kc.$('facingGroup').querySelectorAll('.cam-chip')) assert.equal(chip.disabled, false);
});

/* ---------------- B10: 0.5x chip ---------------- */

test('B10: 0.5x comes back after switching to a camera that may have it', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  const wide = kc.document.querySelector('.cam-chip[data-zoom="0.5"]');
  wide.click();
  await kc.clock.advance(10);
  assert.equal(wide.disabled, true, 'front camera has no wider lens');
  assert.ok(wide.title);
  kc.document.querySelector('.cam-chip[data-facing="environment"]').click();
  await kc.clock.advance(10);
  assert.equal(wide.title, '');
  assert.equal(wide.disabled, false);
});

/* ---------------- B11: download during a capture ---------------- */

test('B11: Download is disabled while a new strip is being shot', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  await kc.capture();
  assert.equal(kc.$('downloadBtn').disabled, false);
  kc.$('macShutter').click();
  await kc.clock.advance(100);
  assert.equal(kc.$('downloadBtn').disabled, true);
  await kc.clock.advance(30000);
  assert.equal(kc.$('downloadBtn').disabled, false);
});

/* ---------------- B12: party changes mid-capture ---------------- */

test('B12: a friend leaving mid-strip aborts the party capture cleanly', async () => {
  const kc = await loadBooth();
  await startHostParty(kc);
  kc.$('macShutter').click();
  await kc.clock.advance(5500);                     // one party shot in, the second counting down
  assert.equal(kc.eval('shots.length'), 1);
  kc.eval("exitPartyMode('Your friend left the party.')");
  await kc.clock.advance(3000);
  assert.equal(kc.eval('busy'), false);
  assert.equal(kc.eval('shots.length'), 1, 'no frozen party frames shot after the friend left');
  assert.equal(kc.$('downloadBtn').disabled, true, 'a partial strip is not offered for download');
  assert.equal(kc.$('normalStripWrap').hidden, false);
  assert.equal(kc.$('video').classList.contains('cam-hidden'), false, 'back on the plain camera');
});

test('B12: a friend connecting mid-strip waits for the strip to finish', async () => {
  const kc = await loadBooth();
  const host = await openRoom(kc);
  kc.$('macShutter').click();
  await kc.clock.advance(1500);
  const conn = kc.makeIncomingConn('GUEST-A');
  host.emit('connection', conn);
  conn.openNow();
  const call = kc.makeIncomingCall('GUEST-A');
  host.emit('call', call);
  call.emit('stream', kc.makeRemoteStream());
  assert.equal(kc.eval('partyMode'), false, 'not switched mid-strip');
  await kc.clock.advance(30000);
  assert.equal(kc.eval('shots.length'), kc.eval('TOTAL_SHOTS'));
  assert.equal(kc.eval('partyMode'), true, 'entered once the strip was done');
});

/* ---------------- B13: effect canvas size ---------------- */

test('B13: the Photobooth canvas resizes when only its height is off', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  const ec = kc.$('effectCanvas');
  ec.width = 720;                                   // right width, wrong height
  ec.height = 1280;
  kc.eval('setEffect(5)');
  await kc.clock.frame(2);
  assert.deepEqual([ec.width, ec.height], [720, 960]);
});

/* ---------------- B14: segmentation timer ---------------- */

test('B14: segmentation clears its 8 s timeout once send() settles', async () => {
  const kc = await loadBooth({ segmentation: true });
  await kc.startCamera();
  await kc.eval('segmentInto(function(){}, video)');
  assert.ok(kc.env.segSends >= 1, 'send() ran');
  assert.equal(kc.clock.pendingWithDelay(8000), 0);
});

/* ---------------- B15: overlapping starts ---------------- */

test('B15: overlapping camera starts share one getUserMedia request', async () => {
  const kc = await loadBooth();
  const a = kc.eval('ensureCamera()');
  const b = kc.eval('ensureCamera()');
  await kc.clock.advance(10);
  const [sa, sb] = await Promise.all([a, b]);
  assert.equal(sa, sb);
  assert.equal(kc.env.gumCalls, 1);
  // A restart after the camera is lost must not stack a second set of listeners.
  kc.env.tracks.at(-1).endExternally();
  await kc.startCamera();
  assert.equal(kc.$('video').listenerCount('loadedmetadata'), 1);
  assert.equal(kc.$('video').listenerCount('resize'), 1);
});

/* ---------------- B16: room link ---------------- */

test('B16: a guest who gets in drops ?connect= and the Join label resets afterwards', async () => {
  const kc = await loadBooth({ url: 'https://booth.example/?connect=ABCDEFGH' });
  assert.equal(kc.$('joinBtn').textContent, 'Join ABCDEFGH');
  kc.$('joinBtn').click();
  await kc.clock.advance(10);
  const guest = kc.env.peers.at(-1);
  guest.emit('open', guest.id);
  assert.equal(guest.outgoingCalls[0].peer, 'ABCDEFGH');
  guest.outgoingCalls[0].emit('stream', kc.makeRemoteStream());
  assert.equal(kc.eval('partyMode'), true);
  assert.equal(kc.env.location.search, '');
  kc.eval("exitPartyMode('You left the party.')");
  assert.equal(kc.$('joinBtn').textContent, 'Connect');
});

/* ---------------- B17: explicit play() ---------------- */

test('B17: the local preview is started with play(), not autoplay alone', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  assert.ok(kc.$('video').playCalls >= 1);
});

/* ---------------- B18: per-source mask coverage ---------------- */

test('B18: the lighting hint reads this camera’s mask, not the friend’s', async () => {
  const kc = await loadBooth();
  kc.eval('partyMode = true; aiCutout = true; localCutAt = performance.now() + 60000');
  kc.eval('maskCoverageBy.local = 0.5; maskCoverageBy.remote = 0.99');
  await kc.clock.advance(800);
  assert.equal(kc.$('segStatus').hidden, true, 'friend’s full-frame mask ignored');
  kc.eval('maskCoverageBy.local = 0.99');
  await kc.clock.advance(800);
  assert.equal(kc.$('segStatus').hidden, false);
  assert.match(kc.$('segStatus').textContent, /lighting/);
});

/* ---------------- C2: collage ready before the tap ---------------- */

test('C2: the collage is rendered before Download is tapped, so share() runs inside the tap', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  await kc.capture();                               // also lets the background render finish
  kc.$('downloadBtn').click();
  await kc.flush();                                 // microtasks only: no timers, no frames
  assert.equal(kc.env.shares.length, 1);
  assert.equal(kc.env.shares[0].files[0].name, 'kc-snap.jpg');
});

test('C2: a new strip replaces the prepared collage', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  await kc.capture();
  const first = kc.eval('collagePrep');
  await kc.capture();
  const second = kc.eval('collagePrep');
  assert.notEqual(second, first);
  assert.equal(second.urls, kc.eval('shots'));
});

/* ---------------- C3: reel accessibility ---------------- */

test('C3: reel strips are button groups with aria-pressed on the live circle', async () => {
  const kc = await loadBooth();
  for (const id of ['stripFilters', 'stripEffects', 'stripFriends']){
    assert.equal(kc.$(id).getAttribute('role'), 'group');
  }
  kc.document.querySelector('.mode-tab[data-mode="filters"]').click();
  const thumbs = kc.$('stripFilters').children;
  assert.equal(thumbs[0].getAttribute('aria-pressed'), 'true');
  thumbs[3].click();
  assert.equal(thumbs[0].getAttribute('aria-pressed'), 'false');
  assert.equal(thumbs[3].getAttribute('aria-pressed'), 'true');
});

/* ---------------- C5: fallback download link ---------------- */

test('C5: the toBlob-less fallback link is attached to the page when clicked', async () => {
  const kc = await loadBooth({ toBlobReturnsNull: true });
  await kc.startCamera();
  await kc.capture();
  kc.$('downloadBtn').click();
  await kc.clock.advance(50);
  assert.equal(kc.env.anchorClicks.length, 1);
  assert.equal(kc.env.anchorClicks[0].connected, true);
  assert.match(kc.env.anchorClicks[0].href, /^data:image\/jpeg/);
  assert.equal(kc.env.anchorClicks[0].download, 'kc-snap.jpg');
});

/* ---------------- D7: paywall QR ---------------- */

test('D7: the paywall QR is not decoded at page load', async () => {
  const kc = await loadBooth();
  assert.equal(kc.$('qrImg').getAttribute('src'), null);
  assert.ok(!kc.eval('payStepHTML').includes('base64'), 'no copy of the PNG kept in memory');
});

/* ---------------- O1 / O2: shared drawing helpers ---------------- */

test('O1: one crop-to-fill helper measures images by their pixels', async () => {
  const kc = await loadBooth();
  const ctx = kc.document.createElement('canvas').getContext('2d');
  ctx.calls = [];
  const img = { naturalWidth: 200, naturalHeight: 100, width: 50, height: 50 };   // laid out smaller than its pixels
  kc.eval('drawCoverImage')(ctx, img, 0, 0, 100, 100, false);
  const call = ctx.calls.find(c => c[0] === 'drawImage');
  assert.deepEqual(call.slice(2), [50, 0, 100, 100, 0, 0, 100, 100]);
});

test('O2: drawPersonInRect at 94% matches the old full-scene placement', async () => {
  const kc = await loadBooth();
  const ctx = kc.document.createElement('canvas').getContext('2d');
  ctx.calls = [];
  const person = { width: 100, height: 200 };
  kc.eval('drawPersonInRect')(ctx, person, 0.32, 0, 0, 960, 720, false, 0.94);
  const [, , dx, dy, dw, dh] = ctx.calls.find(c => c[0] === 'drawImage');
  // Old drawPersonNatural: targetH = h*0.94, centred on w*0.32, bottom-anchored.
  const th = 720 * 0.94, tw = 100 * th / 200;
  const expected = [960 * 0.32 - tw / 2, 720 - th, tw, th];
  [dx, dy, dw, dh].forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `arg ${i}: ${v} vs ${expected[i]}`));
});

/* ---------------- O3: shared backdrop images ---------------- */

test('O3: the backdrop thumbnail is a small generated copy, not a second full-size decode', async () => {
  const kc = await loadBooth();
  assert.equal(kc.eval('bgImages.length'), kc.eval('PARTY_BACKGROUNDS.length'));
  const thumbs = kc.$('stripFriends').querySelectorAll('img');
  assert.equal(thumbs.length, 1);
  for (const thumb of thumbs) assert.match(thumb.src, /FAKE/);
});

/* ---------------- removed effects ---------------- */

test('Effects and Add friends both offer Flipbook and Subway Door; Effects adds Living Room', async () => {
  const kc = await loadBooth();
  const effects = kc.$('stripEffects').querySelectorAll('.reel-thumb').map(b => b.getAttribute('aria-label'));
  assert.deepEqual(effects, ['Photobooth B&W effect', 'Flipbook effect', 'Subway Door effect', 'Living Room effect']);
  const backdrops = kc.$('stripFriends').querySelectorAll('.reel-thumb').map(b => b.getAttribute('aria-label'));
  assert.deepEqual(backdrops, ['Paper backdrop', 'Flipbook backdrop', 'Subway Door backdrop']);
  assert.deepEqual(kc.eval('EFFECT_ITEMS.map(e => e.id)'), [5, 7, 8, 9]);
  assert.deepEqual(kc.eval('PARTY_BACKGROUNDS.map(b => b.id)'), ['bg1_paper', 'bg_flipbook', 'bg_subway']);
  // The drawn scenes get drawn thumbnails, not image files.
  for (const id of ['effectThumb7', 'effectThumb8', 'bgThumb_bg_flipbook', 'bgThumb_bg_subway']){
    assert.equal(kc.$(id).localName, 'canvas', id);
  }
});

test('Starfield and UAE Frame are gone from the page, assets included', () => {
  const { script, markup } = extractParts();
  for (const name of ['UAE_BG_SRC', 'UAE_FRAME', 'uaeBgImg', 'STARFIELD_SRC', 'starBgImg',
    'drawLightWrap', 'effectCutoutCanvas', 'partyBgFrame', 'applyPartyBgLayout', 'presentedVideoSize']){
    assert.ok(!new RegExp('\\b' + name + '\\b').test(script), name + ' is still referenced');
  }
  assert.ok(!/effectCutoutCanvas/.test(markup));
  assert.ok(!/label:\s*'(UAE|UAE Frame|Starfield)'/.test(script));
});

test('party mode composites one open scene on the four-frame strip', async () => {
  const kc = await loadBooth();
  await startHostParty(kc);
  await kc.clock.frame(2);
  const pc = kc.$('partyCanvas');
  assert.deepEqual([pc.width, pc.height], [1280, 720], 'the fixed party stage');
  assert.equal(pc.style.display, 'block');
  assert.equal(kc.$('normalStripWrap').hidden, false);
  assert.equal(kc.$('effectStripWrap').hidden, true);
  await kc.capture();
  assert.equal(kc.eval('shots.length'), kc.eval('TOTAL_SHOTS'));
});

/* ---------------- O4 / D5: layouts ---------------- */

test('O4: Photobooth B&W lands on the single print and back again', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  const single = () => !kc.$('effectStripWrap').hidden && kc.$('normalStripWrap').hidden
    && kc.$('effectStrip').classList.contains('single-frame') && kc.$('pips').hidden
    && kc.$('shotCount').textContent === '0 / 1' && kc.$('captureBtn').textContent === 'Take photo (1 shot)';
  const four = () => kc.$('effectStripWrap').hidden && !kc.$('normalStripWrap').hidden
    && !kc.$('effectStrip').classList.contains('single-frame') && !kc.$('pips').hidden
    && kc.$('captureBtn').textContent.startsWith('Take strip');

  kc.eval('setEffect(5)');
  assert.ok(single());
  assert.equal(kc.$('effectStripLabel').textContent, 'Photobooth shot');
  assert.equal(kc.$('effectCanvas').style.display, 'block');
  kc.eval('setEffect(0)');
  assert.ok(four());
  assert.equal(kc.$('effectCanvas').style.display, 'none');
});

test('D5: removed effect ids (pose effects 1-3, UAE Frame 4, Starfield 6) fall back to no effect', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  for (const id of [1, 2, 3, 4, 6]){
    kc.eval(`setEffect(${id})`);
    assert.equal(kc.eval('activeEffect'), 0, `effect ${id} was accepted`);
    assert.equal(kc.$('effectCanvas').style.display, 'none');
  }
});

test('O4: a single-shot effect capture fills the print and enables its download', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(5)');
  await kc.clock.frame(1);
  await kc.capture();
  assert.equal(kc.eval('effectShots.length'), 1);
  assert.ok(kc.$('efc0').querySelector('img'));
  assert.equal(kc.$('downloadEffectBtn').disabled, false);
  assert.equal(kc.$('shotCount').textContent, '1 / 1');
});

/* ---------------- Flipbook ---------------- */

test('Flipbook: a 2:1 book on its own print, ready to make a video', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(FLIPBOOK_ID)');
  assert.ok(singlePrint(kc));
  assert.equal(kc.$('effectStripLabel').textContent, 'Flipbook');
  assert.equal(kc.$('captureBtn').textContent, 'Make flipbook (10 s video)');
  assert.equal(kc.$('viewfinder').style.aspectRatio, '1200 / 600');
  assert.equal(kc.$('effectCanvas').style.display, 'block');
  await kc.clock.frame(3);
  const ec = kc.$('effectCanvas');
  assert.deepEqual([ec.width, ec.height], [1200, 600]);
});

test('Flipbook: 25 page turns in the 10 seconds — first at 0, last landing at 10 s', async () => {
  const kc = await loadBooth();
  const flipState = kc.eval('flipState');
  const pages = new Set();
  let most = 0;
  for (let t = 0; t < 10000; t += 5){
    const s = flipState(t);
    most = Math.max(most, s.flying.length);
    for (const f of s.flying){
      pages.add(f.page);
      assert.ok(f.theta >= 0 && f.theta <= Math.PI, 'angle stays within rotateY(0..-180deg)');
    }
  }
  assert.equal(pages.size, 25);
  assert.ok(most >= 1 && most <= 2, 'pages in the air: ' + most);
  // The first page lifts at the shutter press...
  assert.deepEqual(flipState(0).flying.map(f => [f.page, f.p]), [[0, 0]]);
  // ...and the last is all but down as the countdown ends, then nothing moves.
  const end = flipState(9999).flying;
  assert.equal(end.length, 1);
  assert.equal(end[0].page, 24);
  assert.ok(end[0].p > 0.99);
  assert.deepEqual(flipState(10000).flying, []);
  assert.deepEqual(flipState(-1).flying, []);
  const ease = kc.eval('flipEase');
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
});

// Counts flying pages drawn, by wrapping drawFlyingPage inside the page script.
function countFlips(kc){
  kc.eval('window.__flips = 0; drawFlyingPage = (orig => (...a) => { window.__flips++; return orig(...a); })(drawFlyingPage)');
  return () => kc.window.__flips;
}

test('Flipbook: idle, the book sits still — no pages flip, nothing is recording', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(FLIPBOOK_ID)');
  const flips = countFlips(kc);
  for (let i = 0; i < 6; i++){
    await kc.clock.advance(400);                    // timers run as normal...
    await kc.clock.frame(5);                        // ...and so does the live preview
  }
  assert.equal(flips(), 0, 'no page moved');
  assert.equal(kc.eval('flipbookActive'), null);
  assert.equal(kc.env.recorders.length, 0);
  assert.equal(kc.$('recTimer').hidden, true);
  const ec = kc.$('effectCanvas');
  assert.deepEqual([ec.width, ec.height], [1200, 600], 'the live book is still drawn');
});

test('Flipbook: the shutter starts the countdown, the flipping and the recorder in the same instant', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(FLIPBOOK_ID)');
  const flips = countFlips(kc);
  const pressedAt = kc.clock.now;
  kc.$('macShutter').click();
  // Nothing has been awaited: all three are already running, off one clock reading.
  assert.equal(kc.env.recorders.length, 1);
  const rec = kc.env.recorders[0];
  assert.equal(rec.state, 'recording');
  assert.equal(rec.startedAt, pressedAt);
  assert.equal(kc.eval('flipbookActive.start'), pressedAt);
  assert.equal(kc.$('recTimer').hidden, false);
  assert.equal(kc.$('recTimerText').textContent, '0:10');
  assert.equal(kc.$('countdown').style.display || 'none', 'none', 'no 4-3-2-1 count-in first');
  await kc.clock.frame(3);
  assert.ok(flips() > 0, 'pages flip from the first frame');
  await kc.clock.advance(3000);
  assert.equal(kc.$('recTimerText').textContent, '0:07');
  assert.equal(kc.$('shotCount').textContent, 'Recording 7s');
});

test('Flipbook: at zero the pages stop, the book settles and the video is ready', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(FLIPBOOK_ID)');
  const flips = countFlips(kc);
  kc.$('macShutter').click();
  await kc.clock.advance(10000);
  const rec = kc.env.recorders[0];
  assert.equal(rec.state, 'inactive');
  assert.equal(rec.stoppedAt - rec.startedAt, 10000, 'stopped as the countdown hit zero');
  assert.equal(rec.stream.canvas, kc.$('effectCanvas'), 'recorded the scene canvas');
  assert.equal(rec.stream.fps, 30);
  await kc.clock.advance(50);
  assert.equal(rec.stream.track.stopped, true, 'canvas stream released');
  assert.equal(kc.eval('flipbookActive'), null);
  assert.equal(kc.$('recTimer').hidden, true);
  const before = flips();
  await kc.clock.frame(5);
  assert.equal(flips(), before, 'settled: nothing flips after zero');
  assert.equal(kc.eval('effectResult.kind'), 'video');
  const v = kc.$('efc0').querySelector('video');
  assert.ok(v, 'the print plays the flipbook');
  assert.match(v.src, /^blob:/);
  assert.equal(v.loop && v.muted && v.autoplay, true);
  assert.equal(kc.$('downloadEffectBtn').disabled, false);
  assert.equal(kc.$('shotCount').textContent, '1 / 1');
  assert.equal(kc.eval('busy'), false);
});

test('Flipbook: a lifting page keeps its moment while the page beneath stays live', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(FLIPBOOK_ID)');
  kc.$('macShutter').click();
  await kc.clock.frame(1);
  const slot0 = kc.eval('fbFlyTex[0]').getContext('2d');
  slot0.calls = [];
  await kc.clock.frame(3);                          // page 0 is still in the air
  assert.equal(slot0.calls.filter(c => c[0] === 'drawImage').length, 0, 'page 0 kept the frame it lifted with');
  assert.equal(kc.eval('fbFlyPage[0]'), 0);
  await kc.clock.advance(10050);
  await kc.clock.frame(1);
  assert.deepEqual(kc.eval('fbFlyPage.slice()'), [-1, -1, -1], 'pages reset for the next flipbook');
});

test('Flipbook: every flying page stays hinged on the spine', async () => {
  const kc = await loadBooth();
  const pageStrips = kc.eval('pageStrips');
  const spine = kc.eval('FB_SPINE_X'), W = kc.eval('FB_PAGE_W'), H = kc.eval('FB_PAGE_H');
  for (const theta of [0, 0.6, Math.PI / 2, 2.4, Math.PI]){
    for (const curl of [-0.8, 0, 0.8]){
      const pts = pageStrips(theta, curl);
      assert.equal(pts.length, kc.eval('FLIPBOOK.strips') + 1);
      assert.equal(pts[0].x, spine, `theta ${theta}, curl ${curl}`);
    }
  }
  const flat = pageStrips(0, 0);
  assert.ok(Math.abs(flat.at(-1).x - (spine + W)) < 1e-6, 'flat page lies over the stack');
  assert.ok(Math.abs(flat.at(-1).h - H) < 1e-6);
  const over = pageStrips(Math.PI, 0);
  assert.ok(Math.abs(over.at(-1).x - (spine - W)) < 1e-6, 'turned page lies on the other side');
});

test('Flipbook: page photos are mapped exactly onto each perspective strip', async () => {
  const kc = await loadBooth();
  const triangleTransform = kc.eval('triangleTransform');
  const src = [{ x: 0, y: 0 }, { x: 31.5, y: 0 }, { x: 31.5, y: 297 }];
  const dst = [{ x: 222, y: 30 }, { x: 260.4, y: 12.7 }, { x: 260.4, y: 587.3 }];  // a trapezoid half
  const [a, b, c, d, e, f] = triangleTransform(...src, ...dst);
  src.forEach((p, i) => {
    assert.ok(Math.abs(a * p.x + c * p.y + e - dst[i].x) < 1e-9, 'x of corner ' + i);
    assert.ok(Math.abs(b * p.x + d * p.y + f - dst[i].y) < 1e-9, 'y of corner ' + i);
  });
  assert.equal(triangleTransform(src[0], src[0], src[1], ...dst), null, 'degenerate source is refused');
});

test('Flipbook: the finished video is not mirrored like the live selfie camera', () => {
  const css = stylesheet();
  assert.match(rulesFor(css, 'video').join(''), /scaleX\(-1\)/, 'the live camera is mirrored');
  assert.match(rulesFor(css, '.strip-frame video').join(''), /transform:\s*none/);
});

test('Flipbook: Download hands the video over inside the tap', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(FLIPBOOK_ID)');
  await kc.capture();
  kc.$('downloadEffectBtn').click();
  await kc.flush();                                 // microtasks only: no timers, no frames
  assert.equal(kc.env.shares.length, 1);
  const file = kc.env.shares[0].files[0];
  assert.match(file.name, /^kc-snap-flipbook-\d+\.webm$/);
  assert.equal(file.type, 'video/webm');
});

test('Flipbook: records MP4 where the browser can', async () => {
  const kc = await loadBooth({ videoTypes: ['video/mp4', 'video/webm'] });
  await kc.startCamera();
  kc.eval('setEffect(FLIPBOOK_ID)');
  await kc.capture();
  assert.equal(kc.env.recorders[0].mimeType, 'video/mp4');
  kc.$('downloadEffectBtn').click();
  await kc.flush();
  assert.match(kc.env.shares[0].files[0].name, /\.mp4$/);
});

test('Flipbook: without video recording it falls back to a still of the book', async () => {
  const kc = await loadBooth({ noMediaRecorder: true });
  await kc.startCamera();
  kc.eval('setEffect(FLIPBOOK_ID)');
  await kc.capture();
  assert.equal(kc.env.recorders.length, 0);
  assert.equal(kc.eval('effectResult.kind'), 'image');
  assert.ok(kc.$('efc0').querySelector('img'));
  kc.$('downloadEffectBtn').click();
  await kc.flush();
  assert.match(kc.env.shares[0].files[0].name, /^kc-snap-flipbook-\d+\.jpg$/);
});

test('Flipbook: losing the camera mid-recording leaves no half-made video', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(FLIPBOOK_ID)');
  kc.$('macShutter').click();
  await kc.clock.advance(5000);                     // halfway through the 10 seconds
  assert.equal(kc.env.recorders[0].state, 'recording');
  kc.env.tracks.at(-1).endExternally();
  await kc.clock.advance(3000);
  assert.equal(kc.env.recorders[0].state, 'inactive');
  assert.equal(kc.eval('effectResult'), null);
  assert.equal(kc.eval('flipbookActive'), null, 'the pages stopped too');
  assert.equal(kc.$('recTimer').hidden, true);
  assert.equal(kc.eval('busy'), false);
  assert.equal(kc.$('downloadEffectBtn').disabled, true);
});

test('Flipbook: leaving it discards the video and frees its memory', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(FLIPBOOK_ID)');
  await kc.capture();
  const url = kc.eval('effectResult.url');
  assert.ok(resolveObjectURL(url), 'video blob is live');
  kc.eval('setEffect(0)');
  assert.equal(kc.eval('effectResult'), null);
  assert.equal(resolveObjectURL(url), undefined, 'blob URL revoked');
  assert.equal(kc.$('downloadEffectBtn').disabled, true);
});

/* ---------------- Subway Door ---------------- */

test('Subway Door: one framed photo of the 1200x900 door scene', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(SUBWAY_ID)');
  assert.ok(singlePrint(kc));
  assert.equal(kc.$('effectStripLabel').textContent, 'Subway Door shot');
  assert.equal(kc.$('captureBtn').textContent, 'Take photo (1 shot)');
  await kc.clock.frame(3);
  const ec = kc.$('effectCanvas');
  assert.deepEqual([ec.width, ec.height], [1200, 900]);
  await kc.capture();
  assert.equal(kc.eval('effectShots.length'), 1);
  kc.$('downloadEffectBtn').click();
  await kc.clock.advance(50);
  assert.match(kc.env.shares[0].files[0].name, /^kc-snap-subway-\d+\.jpg$/);
});

test('Subway Door: the template puts the windows in the door and the feed across both', async () => {
  const kc = await loadBooth();
  const S = kc.eval('SUBWAY');
  const inside = (r, o) => r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h;
  assert.equal(S.windows.length, 2);
  for (const w of S.windows){
    assert.ok(inside(w, S.opening), 'window sits in the door');
    assert.ok(inside(w, S.feed), 'the live feed covers the window');
    assert.ok(inside(w, S.interior), 'the carriage is drawn behind the window');
  }
  assert.ok(S.windows[0].x + S.windows[0].w < 600 && S.windows[1].x > 600, 'one window per leaf');
  assert.equal(S.labels.left, '<-- Skipped backward 3 seconds');
  assert.equal(S.labels.right, 'Next ->');
  const ctx = kc.document.createElement('canvas').getContext('2d');
  ctx.calls = [];
  kc.eval('paintSubwayFront')(ctx);
  const texts = ctx.calls.filter(c => c[0] === 'fillText').map(c => c[1]);
  assert.deepEqual(texts, [S.labels.left, S.labels.right]);
});

test('Subway Door: the reflection is see-through, screened over the carriage and under the frame', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(SUBWAY_ID)');
  await kc.clock.frame(1);
  const ctx = kc.$('effectCanvas').getContext('2d');
  ctx.calls = [];
  await kc.clock.frame(1);
  const draws = ctx.calls.filter(c => c[0] === 'drawImage');
  const at = (img) => draws.findIndex(c => c[1] === img);
  const interior = at(kc.eval("subwayLayer('interior')"));
  const reflection = at(kc.eval('subwayReflection'));
  const front = at(kc.eval("subwayLayer('front')"));
  assert.ok(interior >= 0 && reflection > interior && front > reflection, 'carriage, then reflection, then door');
  assert.equal(draws[reflection].op, 'screen');
  assert.ok(draws[reflection].alpha > 0 && draws[reflection].alpha < 1);
});

test('Subway Door uses the AI cutout on its own, and says so while it loads', async () => {
  const kc = await loadBooth({ segmentation: true });
  await kc.startCamera();
  kc.eval('setEffect(SUBWAY_ID)');
  const before = kc.env.segSends;
  await kc.clock.frame(20);
  assert.ok(kc.env.segSends > before, 'segmentation runs for the effect');
  await kc.clock.advance(800);
  assert.equal(kc.$('segStatus').hidden, false);
  assert.match(kc.$('segStatus').textContent, /Loading AI cutout/);
  kc.eval('setEffect(FLIPBOOK_ID)');               // the flipbook needs no cutout
  const during = kc.env.segSends;
  await kc.clock.frame(20);
  assert.equal(kc.env.segSends, during);
  await kc.clock.advance(800);
  assert.equal(kc.$('segStatus').hidden, true);
});

/* ---------------- the scenes as party backdrops ---------------- */

test('party: the Subway Door backdrop puts you both in the windows, one framed photo', async () => {
  const kc = await loadBooth();
  const { conn } = await startHostParty(kc);
  const subway = backdrop(kc, 'bg_subway');
  kc.eval(`selectBgIndex(${subway}, true)`);
  assert.deepEqual(conn.sent.at(-1), { type: 'bg', index: subway }, 'the friend is told');
  assert.ok(singlePrint(kc));
  assert.equal(kc.$('effectStripLabel').textContent, 'Subway Door shot');
  await kc.clock.frame(2);
  const pc = kc.$('partyCanvas');
  assert.deepEqual([pc.width, pc.height], [1200, 900]);
  await kc.capture();
  assert.equal(kc.eval('effectShots.length'), 1);
  assert.equal(kc.$('downloadEffectBtn').disabled, false);
});

test('party: the Flipbook backdrop records the party scene as the flipbook', async () => {
  const kc = await loadBooth();
  await startHostParty(kc);
  kc.eval(`selectBgIndex(${backdrop(kc, 'bg_flipbook')}, true)`);
  assert.equal(kc.$('captureBtn').textContent, 'Make flipbook (10 s video)');
  await kc.clock.frame(2);
  const pc = kc.$('partyCanvas');
  assert.deepEqual([pc.width, pc.height], [1200, 600]);
  await kc.capture();
  assert.equal(kc.env.recorders[0].stream.canvas, pc);
  assert.equal(kc.eval('effectResult.kind'), 'video');
  assert.ok(kc.$('efc0').querySelector('video'));
});

test('party: leaving a drawn backdrop returns to the four-frame strip', async () => {
  const kc = await loadBooth();
  await startHostParty(kc);
  kc.eval(`selectBgIndex(${backdrop(kc, 'bg_subway')}, true)`);
  assert.ok(singlePrint(kc));
  kc.eval("exitPartyMode('You left the party.')");
  assert.equal(kc.$('normalStripWrap').hidden, false);
  assert.equal(kc.$('effectStripWrap').hidden, true);
  assert.equal(kc.$('pips').hidden, false);
});

test('both scenes draw where ctx.filter is missing (older iOS)', async () => {
  const kc = await loadBooth({ ctxFilter: 'expando' });
  await kc.startCamera();
  const ec = kc.$('effectCanvas');
  kc.eval('setEffect(FLIPBOOK_ID)');
  await kc.clock.frame(2);
  assert.deepEqual([ec.width, ec.height], [1200, 600]);
  kc.eval('setEffect(SUBWAY_ID)');
  await kc.clock.frame(2);
  assert.deepEqual([ec.width, ec.height], [1200, 900]);
});

/* ---------------- Living Room (the KC Studio 2-frame template) ---------------- */

// A fresh, 16:9 AI cutout of you, as the effect's segmentation loop leaves it.
function freshCutout(kc){
  kc.eval('effectCutCanvas.width = 1280; effectCutCanvas.height = 720; effectCutAt = performance.now() + 600000');
}

test('Living Room: the template is one print, shot twice, shown without a Polaroid border', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(LIVING_ROOM_ID)');
  assert.ok(singlePrint(kc));
  assert.ok(kc.$('effectStrip').classList.contains('self-framed'));
  assert.equal(kc.$('effectStripLabel').textContent, 'Living Room');
  assert.equal(kc.$('captureBtn').textContent, 'Take 2 photos');
  assert.equal(kc.$('shotCount').textContent, '0 / 2');
  assert.equal(kc.$('viewfinder').style.aspectRatio, '472 / 828');
  assert.equal(kc.$('effectCanvas').style.filter, 'none', 'the template is never tinted in the preview');
  await kc.clock.frame(3);
  const ec = kc.$('effectCanvas');
  assert.deepEqual([ec.width, ec.height], [472, 828]);
  kc.eval('setEffect(5)');
  assert.ok(!kc.$('effectStrip').classList.contains('self-framed'), 'other prints keep their border');
  assert.match(kc.$('effectCanvas').style.filter, /contrast/);
});

test('Living Room: the two windows sit inside the template, one above the other', async () => {
  const kc = await loadBooth();
  const [top, bottom] = kc.eval('LIVING_ROOM.windows');
  const S = kc.eval('SCENES.livingroom');
  for (const w of [top, bottom]){
    assert.ok(w.x >= 0 && w.y >= 0 && w.x + w.w <= S.w && w.y + w.h <= S.h);
  }
  assert.deepEqual([top.w, top.h], [bottom.w, bottom.h], 'same size, so one layer of you fits both');
  assert.ok(top.y + top.h < bottom.y, 'top window above the bottom one');
  assert.equal(kc.eval('livingRoomImg.naturalWidth'), 472);
  assert.equal(kc.eval('livingRoomImg.naturalHeight'), 828);
});

test('Living Room: you sit on the sofa, bottom-anchored on the seat line and centred on it', async () => {
  const kc = await loadBooth({ recordCalls: true });
  freshCutout(kc);
  const layer = kc.document.createElement('canvas');
  const out = kc.eval('livingRoomPersonLayer')(layer, 470, 290, 1);
  assert.equal(out, layer);
  const [, src, dx, dy, dw, dh] = layer.getContext('2d').calls.find(c => c[0] === 'drawImage');
  assert.equal(src, kc.eval('effectCutCanvas'));
  assert.ok(Math.abs(dy + dh - 290) < 1e-9, 'the bottom of the camera frame is the window bottom: the seat');
  assert.ok(Math.abs(dh - 290 * kc.eval('LIVING_ROOM.heightFrac')) < 1e-9);
  assert.ok(Math.abs(dx + dw / 2 - 470 * kc.eval('LIVING_ROOM.seatX')) < 1e-9, 'centred on the sofa');
  assert.ok(Math.abs(dw / dh - 16 / 9) < 1e-9, 'not stretched');
  kc.eval('effectCutAt = performance.now() - 5000');   // older than CUT_FRESH_MS
  assert.equal(kc.eval('livingRoomPersonLayer')(layer, 470, 290, 1), null, 'no stale cutout');
});

test('Living Room: idle, you show live in both windows', async () => {
  const kc = await loadBooth({ recordCalls: true });
  await kc.startCamera();
  kc.eval('setEffect(LIVING_ROOM_ID)');
  freshCutout(kc);
  const ctx = kc.$('effectCanvas').getContext('2d');
  await kc.clock.frame(1);
  ctx.calls.length = 0;
  await kc.clock.frame(1);
  const layer = kc.eval('lrPreviewLayer');
  const draws = ctx.calls.filter(c => c[0] === 'drawImage');
  assert.equal(draws[0][1], kc.eval('livingRoomImg'), 'the template first');
  const people = draws.filter(c => c[1] === layer).map(c => c.slice(2));
  assert.deepEqual(people, kc.eval('LIVING_ROOM.windows').map(w => [w.x, w.y, w.w, w.h]));
});

test('Living Room: while the cutout loads, the plain camera frames the shot', async () => {
  const kc = await loadBooth({ recordCalls: true, segmentation: true });
  await kc.startCamera();
  kc.eval('setEffect(LIVING_ROOM_ID)');
  const before = kc.env.segSends;
  await kc.clock.frame(20);
  assert.ok(kc.env.segSends > before, 'the effect runs the AI cutout');
  kc.eval('effectCutAt = 0');
  const ctx = kc.$('effectCanvas').getContext('2d');
  ctx.calls.length = 0;
  await kc.clock.frame(1);
  const fromCamera = ctx.calls.filter(c => c[0] === 'drawImage' && c[1] === kc.$('video'));
  assert.equal(fromCamera.length, 2, 'a camera panel in each window');
});

test('Living Room: two 3-second countdowns; the top window locks before the bottom one is shot', async () => {
  const kc = await loadBooth({ recordCalls: true });
  await kc.startCamera();
  kc.eval('setEffect(LIVING_ROOM_ID)');
  freshCutout(kc);
  kc.$('macShutter').click();
  await kc.clock.advance(10);
  assert.equal(kc.$('countdown').dataset.count, '3', 'a 3-second countdown, not the strip one of 4');
  assert.equal(kc.eval('livingRoomCapture.active'), 0);

  await kc.clock.advance(3100);                     // shot 1 is in
  assert.equal(kc.eval('livingRoomCapture.shots.length'), 1);
  const shot1 = kc.eval('livingRoomCapture.shots[0]');
  assert.deepEqual([shot1.width, shot1.height], [470 * 3, 290 * 3], 'shot at export resolution');
  assert.equal(kc.$('shotCount').textContent, '1 / 2');

  await kc.clock.advance(300);                      // second countdown running
  assert.equal(kc.eval('livingRoomCapture.active'), 1);
  assert.equal(kc.$('countdown').dataset.count, '3');
  const ctx = kc.$('effectCanvas').getContext('2d');
  ctx.calls.length = 0;
  await kc.clock.frame(1);
  const [top, bottom] = kc.eval('LIVING_ROOM.windows');
  const live = kc.eval('lrPreviewLayer');
  const draws = ctx.calls.filter(c => c[0] === 'drawImage');
  assert.ok(draws.some(c => c[1] === shot1 && c[2] === top.x && c[3] === top.y), 'shot 1 is locked into the top window');
  assert.ok(draws.some(c => c[1] === live && c[3] === bottom.y), 'the bottom window is live');
  assert.ok(!draws.some(c => c[1] === live && c[3] === top.y), 'the top one no longer is');
  assert.equal(kc.$('efc0').querySelector('img'), null, 'nothing in the collage yet');
  assert.equal(kc.$('downloadEffectBtn').disabled, true);

  await kc.clock.advance(3000);                     // shot 2 is in
  assert.equal(kc.eval('livingRoomCapture.shots.length'), 2);
  assert.equal(kc.$('shotCount').textContent, '2 / 2');

  await kc.clock.advance(2000);                     // held, flattened, handed to the print
  assert.equal(kc.eval('busy'), false);
  assert.equal(kc.eval('livingRoomCapture'), null, 'idle again: both windows live');
  assert.equal(kc.eval('effectResult.tag'), 'living-room');
  const img = kc.$('efc0').querySelector('img');
  assert.ok(img, 'the collage shows the result');
  assert.match(img.src, /^blob:/);
  assert.equal(kc.$('downloadEffectBtn').disabled, false);
  assert.equal(kc.$('shotCount').textContent, '2 / 2');
});

test('Living Room: the download flattens template + both shots into one 3x JPEG', async () => {
  const kc = await loadBooth({ recordCalls: true });
  await kc.startCamera();
  kc.eval('setEffect(LIVING_ROOM_ID)');
  freshCutout(kc);
  await kc.capture();
  kc.$('downloadEffectBtn').click();
  await kc.flush();                                 // inside the tap: the file is already made
  assert.equal(kc.env.shares.length, 1);
  const file = kc.env.shares[0].files[0];
  assert.match(file.name, /^kc-snap-living-room-\d+\.jpg$/);
  assert.equal(file.type, 'image/jpeg');
  assert.equal(await file.text(), 'fake 1416x2484', 'the whole 472x828 template, at 3x');

  // The flattening itself: template first, then each shot back into its window.
  const shots = [kc.document.createElement('canvas'), kc.document.createElement('canvas')];
  shots.forEach(s => { s.width = 1410; s.height = 870; });
  const out = kc.eval('renderLivingRoomCollage')(shots, 3);
  const draws = out.getContext('2d').calls.filter(c => c[0] === 'drawImage');
  assert.deepEqual(draws.map(c => [c[1], ...c.slice(2)]), [
    [kc.eval('livingRoomImg'), 0, 0, 1416, 2484],
    [shots[0], 3, 144, 1410, 870],
    [shots[1], 3, 1122, 1410, 870],
  ]);
});

test('Living Room: losing the camera between the shots leaves nothing half-made', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(LIVING_ROOM_ID)');
  freshCutout(kc);
  kc.$('macShutter').click();
  await kc.clock.advance(4000);                     // shot 1 taken, second countdown running
  kc.env.tracks.at(-1).endExternally();
  await kc.clock.advance(6000);
  assert.equal(kc.eval('busy'), false);
  assert.equal(kc.eval('livingRoomCapture'), null);
  assert.equal(kc.eval('effectResult'), null);
  assert.equal(kc.$('efc0').querySelector('img'), null);
  assert.equal(kc.$('downloadEffectBtn').disabled, true);
});

test('Living Room: leaving the effect discards the collage and frees its memory', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(LIVING_ROOM_ID)');
  freshCutout(kc);
  await kc.capture();
  const url = kc.eval('effectResult.url');
  assert.ok(resolveObjectURL(url));
  kc.eval('setEffect(0)');
  assert.equal(kc.eval('effectResult'), null);
  assert.equal(resolveObjectURL(url), undefined, 'blob URL revoked');
});

test('Living Room: the rail circle is cut from the template itself', async () => {
  const kc = await loadBooth({ recordCalls: true });
  const thumb = kc.$('effectThumb9');
  assert.equal(thumb.localName, 'canvas');
  const draw = thumb.getContext('2d').calls.find(c => c[0] === 'drawImage');
  assert.ok(draw, 'drawn once the template decoded');
  assert.equal(draw[1], kc.eval('livingRoomImg'));
});

test('a cutout that finds nobody says so, instead of leaving an empty set', async () => {
  const kc = await loadBooth({ segmentation: true });
  await kc.startCamera();
  kc.eval('setEffect(LIVING_ROOM_ID)');
  freshCutout(kc);
  kc.eval('maskCoverageBy.effect = 0');
  await kc.clock.advance(800);
  assert.equal(kc.$('segStatus').hidden, false);
  assert.match(kc.$('segStatus').textContent, /find you/);
  kc.eval('maskCoverageBy.effect = 0.3');
  await kc.clock.advance(800);
  assert.equal(kc.$('segStatus').hidden, true);
});

test('Living Room: the cutout pauses once both windows are locked, so the collage encodes fast', async () => {
  const kc = await loadBooth({ segmentation: true });
  await kc.startCamera();
  kc.eval('setEffect(LIVING_ROOM_ID)');
  kc.$('macShutter').click();
  await kc.clock.advance(6400);                     // both shots in, holding
  assert.equal(kc.eval('livingRoomCapture.shots.length'), 2);
  const before = kc.env.segSends;
  await kc.clock.frame(20);
  assert.equal(kc.env.segSends, before, 'no segmentation while nothing live is shown');
  await kc.clock.advance(3000);
  assert.equal(kc.eval('livingRoomCapture'), null);
  await kc.clock.frame(20);
  assert.ok(kc.env.segSends > before, 'and it resumes once the booth is live again');
});

/* ================================================================
   Party mode: stage, fit, sync, segmentation, recovery, playback
   ================================================================ */

// A guest fully connected to a host: call answered, channel open, video arriving.
async function startGuestParty(kc, code = 'ABCDEFGH', remote){
  const guest = await startJoin(kc, code);
  guest.emit('open', guest.id);
  const call = guest.outgoingCalls.at(-1), conn = guest.outgoingConns.at(-1);
  conn.openNow();
  call.emit('stream', remote || kc.makeRemoteStream());
  assert.equal(kc.eval('partyMode'), true, 'party should be running');
  return { guest, call, conn };
}

// drawImage calls on a canvas whose source is `src`, as [sx, sy, sw, sh, dx, dy, dw, dh].
function drawsOf(ctx, src){
  return ctx.calls.filter(c => c[0] === 'drawImage' && c[1] === src).map(c => c.slice(2));
}

/* ---- the stage ---- */

test('party: one fixed 1280x720 stage, and the viewfinder takes its shape', async () => {
  const kc = await loadBooth({ camera: { w: 960, h: 1280 } });   // a portrait webcam: base shape 960/1280
  await kc.startCamera();
  assert.equal(kc.$('viewfinder').style.aspectRatio, '960 / 1280');
  await startHostParty(kc);
  assert.equal(kc.$('viewfinder').style.aspectRatio, '1280 / 720', 'preview shows what the shutter shoots');
  // The camera changing shape mid-party (a phone rotating) doesn't reshape the stage.
  const v = kc.$('video');
  v.videoWidth = 1280; v.videoHeight = 960;
  kc.eval('syncViewfinderAspect()');          // what the camera's resize event runs
  assert.equal(kc.$('viewfinder').style.aspectRatio, '1280 / 720');
  kc.eval("exitPartyMode('You left the party.')");
  assert.equal(kc.$('viewfinder').style.aspectRatio, '1280 / 960', 'back to the camera’s own shape');
});

test('party: the guest’s stage is the same 1280x720, whoever opened the room', async () => {
  const kc = await loadBooth({ mobile: true, camera: { w: 720, h: 1280 } });
  await kc.startCamera();
  await startGuestParty(kc);
  await kc.clock.frame(3);
  const pc = kc.$('partyCanvas');
  assert.deepEqual([pc.width, pc.height], [1280, 720]);
  assert.equal(kc.$('viewfinder').style.aspectRatio, '1280 / 720');
});

/* ---- fitting ---- */

test('fitRect: cover fills the box with one uniform scale; contain shows all of it', async () => {
  const kc = await loadBooth();
  const fit = kc.eval('fitRect');
  for (const [sw, sh] of [[960, 1280], [1280, 720], [720, 1280], [640, 480]]){
    const c = fit(sw, sh, 640, 720, 'cover', 0.5, 0.15);
    assert.ok(Math.abs(c.sw / c.sh - 640 / 720) < 1e-9, `${sw}x${sh}: no stretch`);
    assert.deepEqual([c.dx, c.dy, c.dw, c.dh], [0, 0, 640, 720], 'fills the half');
    assert.ok(c.sx >= 0 && c.sy >= 0 && c.sx + c.sw <= sw + 1e-9 && c.sy + c.sh <= sh + 1e-9, 'crop inside the source');
    const k = fit(sw, sh, 640, 720, 'contain', 0.5, 0.5);
    assert.ok(Math.abs(k.dw / k.dh - sw / sh) < 1e-9, 'contain keeps the source shape');
    assert.ok(k.dw <= 640 + 1e-9 && k.dh <= 720 + 1e-9);
  }
  // A portrait frame cropped vertically keeps its top: the head, not the waist.
  const p = fit(720, 1280, 640, 720, 'cover', 0.5, 0.15);
  assert.ok(p.sy < (1280 - p.sh) * 0.2, 'crop taken mostly from the bottom');
});

test('party: host on the left, guest on the right, on BOTH devices', async () => {
  for (const role of ['host', 'guest']){
    const kc = await loadBooth({ recordCalls: true });
    await kc.startCamera();
    if (role === 'host') await startHostParty(kc); else await startGuestParty(kc);
    kc.eval('mirrorPreview = false; remoteMirror = false');      // read positions without the flip
    const ctx = kc.$('partyCanvas').getContext('2d');
    await kc.clock.frame(1);
    ctx.calls.length = 0;
    await kc.clock.frame(1);
    const me = drawsOf(ctx, kc.$('video')).at(-1), friend = drawsOf(ctx, kc.$('remoteVideo')).at(-1);
    const left = [0, 0, 640, 720], right = [640, 0, 640, 720];
    assert.deepEqual(me.slice(4), role === 'host' ? left : right, role + ': where I stand');
    assert.deepEqual(friend.slice(4), role === 'host' ? right : left, role + ': where my friend stands');
  }
});

test('party: a portrait phone and a landscape webcam each fill their half, unstretched', async () => {
  const kc = await loadBooth({ recordCalls: true, camera: { w: 1280, h: 720 } });
  await kc.startCamera();
  await startHostParty(kc, 'GUEST-A');
  // The friend's feed turns portrait (a phone held upright).
  const portrait = kc.env.makeStream({ w: 720, h: 1280 });
  kc.eval('attachRemoteStream')(portrait);
  kc.eval('mirrorPreview = false; remoteMirror = false');
  const ctx = kc.$('partyCanvas').getContext('2d');
  await kc.clock.frame(1);
  ctx.calls.length = 0;
  await kc.clock.frame(1);
  for (const src of [kc.$('video'), kc.$('remoteVideo')]){
    const [sx, sy, sw, sh, , , dw, dh] = drawsOf(ctx, src).at(-1);
    assert.ok(Math.abs(sw / sh - dw / dh) < 1e-9, src.id + ': same shape in and out');
    assert.deepEqual([dw, dh], [640, 720], src.id + ': fills its half');
    assert.ok(sx >= 0 && sy >= 0, src.id);
  }
  // Cutouts get the same fit as the plain feeds.
  kc.eval('localCutoutCanvas.width = 1280; localCutoutCanvas.height = 720; localCutAt = performance.now() + 1e6');
  ctx.calls.length = 0;
  await kc.clock.frame(1);
  assert.deepEqual(drawsOf(ctx, kc.$('localCutoutCanvas')).at(-1).slice(4), [0, 0, 640, 720]);
});

test('party: two plain camera halves get a hairline between them', async () => {
  const kc = await loadBooth({ recordCalls: true });
  await kc.startCamera();
  await startHostParty(kc);
  const ctx = kc.$('partyCanvas').getContext('2d');
  ctx.calls.length = 0;
  await kc.clock.frame(1);
  assert.ok(ctx.calls.some(c => c[0] === 'fillRect' && c[1] === 639 && c[3] === 2 && c[4] === 720));
});

/* ---- mirroring in sync ---- */

test('party: each device tells the other how it shows its user, and both draw them that way', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  const { conn } = await startHostParty(kc);
  assert.ok(conn.sent.some(m => m.type === 'cam' && m.mirror === true), 'sent on connect');
  const handle = kc.eval('handlePartyData');
  handle({ type: 'cam', mirror: false });
  assert.equal(kc.eval('remoteMirror'), false);
  for (const bad of ['no', 0, 1, null, undefined, {}]){
    handle({ type: 'cam', mirror: bad });
    assert.equal(kc.eval('remoteMirror'), false, 'ignored: ' + String(bad));
  }
  conn.sent.length = 0;
  kc.eval('setMirror(false)');                        // switched to the back camera
  assert.deepEqual(conn.sent, [{ type: 'cam', mirror: false }]);
});

/* ---- segmentation ---- */

test('party: the two feeds take turns on the model, one inference per tick', async () => {
  const kc = await loadBooth({ segmentation: true });
  await kc.startCamera();
  await startHostParty(kc);
  kc.eval(`window.__order = [];
    onLocalSegResult = (o => r => { window.__order.push('L'); return o(r); })(onLocalSegResult);
    onRemoteSegResult = (o => r => { window.__order.push('R'); return o(r); })(onRemoteSegResult);`);
  const before = kc.env.segSends;
  await kc.clock.frame(40);                         // 640 ms
  const order = kc.window.__order.join('');
  assert.ok(order.length >= 6, 'ran: ' + order);
  assert.ok(!/LL|RR/.test(order), 'alternates: ' + order);
  // One per 55 ms tick at most; the old loop ran two per tick.
  assert.ok(kc.env.segSends - before <= Math.ceil(640 / 55) + 1, 'sends: ' + (kc.env.segSends - before));
});

test('segmentation input is capped on the long edge, so portrait feeds cost no more', async () => {
  for (const [mobile, cap] of [[false, 640], [true, 320]]){
    const kc = await loadBooth({ mobile });
    const scale = kc.eval('scaleRemoteSeg');
    const portrait = scale({ width: 720, height: 1280 });
    const landscape = scale({ width: 1280, height: 720 });
    assert.equal(Math.max(portrait.width, portrait.height), cap, `portrait, mobile=${mobile}`);
    assert.equal(Math.max(landscape.width, landscape.height), cap, `landscape, mobile=${mobile}`);
    assert.equal(portrait.width * portrait.height, landscape.width * landscape.height, 'same pixel budget either way up');
    const small = { width: 200, height: 300 };
    assert.equal(scale(small), small, 'already small: used as is');
  }
});

test('party: people move every frame between masks (the live video through the last matte)', async () => {
  const kc = await loadBooth({ recordCalls: true });
  await kc.startCamera();
  await startHostParty(kc);
  const mask = kc.document.createElement('canvas');
  mask.width = 256; mask.height = 144;
  kc.eval('onLocalSegResult')({ segmentationMask: mask });   // one mask, then no more
  assert.equal(kc.eval('localCutFresh()'), true);
  const ctx = kc.$('localCutoutCanvas').getContext('2d');
  ctx.calls.length = 0;
  await kc.clock.frame(4);
  assert.ok(drawsOf(ctx, kc.$('video')).length >= 3, 'the cutout is redrawn from the live video each frame');
  // The feed changes shape (a phone rotating): the old matte is not stretched over it.
  const v = kc.$('video');
  v.videoWidth = 720; v.videoHeight = 1280;
  ctx.calls.length = 0;
  await kc.clock.frame(3);
  assert.equal(drawsOf(ctx, v).length, 0);
});

/* ---- a lost WebGL context ---- */

test('a lost WebGL context retires the model at once and rebuilds it', async () => {
  const kc = await loadBooth({ segmentation: true });
  await kc.startCamera();
  await startHostParty(kc);
  await kc.clock.frame(5);
  const first = kc.eval('sharedSeg');
  assert.ok(first, 'model running');
  kc.eval('localCutAt = performance.now()');
  // MediaPipe's GL canvas, created through the (watched) getContext.
  const gl = kc.document.createElement('canvas');
  assert.ok(gl.getContext('webgl2'));
  let prevented = false;
  const evt = { type: 'webglcontextlost', bubbles: false, target: null, preventDefault(){ prevented = true; }, stopPropagation(){} };
  gl._fire(evt);
  assert.equal(prevented, true, 'asks the browser for the context back');
  assert.equal(kc.eval('sharedSeg'), null);
  assert.equal(first.closed, true);
  assert.equal(kc.eval('localCutFresh()'), false, 'plain feeds straight away');
  assert.equal(kc.eval('segFailed'), false, 'not counted as the model failing');
  const built = kc.env.segs.length;
  await kc.clock.frame(20);                         // inside the 1.5 s grace
  assert.equal(kc.env.segs.length, built);
  await kc.clock.advance(1600);
  await kc.clock.frame(10);
  assert.ok(kc.env.segs.length > built, 'a fresh instance');
  await kc.clock.advance(900);
  assert.match(kc.$('partyDiag').textContent, /GPU resets: 1/);
  // 'webglcontextrestored' lets it rebuild without waiting out the grace.
  gl._fire({ type: 'webglcontextlost', preventDefault(){}, stopPropagation(){} });
  const after = kc.env.segs.length;
  gl._fire({ type: 'webglcontextrestored', preventDefault(){}, stopPropagation(){} });
  await kc.clock.frame(10);
  assert.ok(kc.env.segs.length > after);
});

/* ---- staying connected ---- */

test('reconnect (guest): ICE failing redials the host and the party carries on', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  const { guest, call } = await startGuestParty(kc, 'HOSTCODE');
  call.peerConnection.setState('failed');
  assert.equal(kc.eval('partyMode'), true, 'still in the party');
  assert.ok(kc.eval('!!reconnecting'));
  assert.equal(kc.$('partyBadge').textContent, 'Reconnecting…');
  assert.match(kc.$('joinStatus').textContent, /reconnecting/i);
  assert.equal(kc.$('remoteVideo').srcObject, null, 'the frozen feed is dropped');
  assert.equal(call.closed, true);
  await kc.clock.advance(600);                      // first backoff
  assert.equal(guest.outgoingCalls.length, 2, 'redialled');
  const redial = guest.outgoingCalls.at(-1);
  assert.equal(redial.peer, 'HOSTCODE');
  assert.equal(guest.outgoingConns.length, 2, 'and a new data channel');
  guest.outgoingConns.at(-1).openNow();
  redial.emit('stream', kc.makeRemoteStream());
  assert.equal(kc.eval('reconnecting'), null);
  assert.equal(kc.eval('partyMode'), true);
  assert.equal(kc.$('partyBadge').textContent, 'Party mode · 2 in frame');
  assert.match(kc.$('joinStatus').textContent, /Connected/);
  assert.ok(kc.$('remoteVideo').srcObject, 'friend back on screen');
});

test('reconnect: a brief ICE "disconnected" blip is ridden out; a long one is not', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  const { call } = await startGuestParty(kc);
  call.peerConnection.setState('disconnected');
  await kc.clock.advance(3000);
  call.peerConnection.setState('connected');
  await kc.clock.advance(3000);
  assert.equal(kc.eval('reconnecting'), null, 'blip: nothing happened');
  call.peerConnection.setState('disconnected');
  await kc.clock.advance(4100);
  assert.ok(kc.eval('!!reconnecting'), 'stuck for 4 s: reconnecting');
});

test('reconnect (guest): waits for its own broker connection before redialling', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  const { guest, call } = await startGuestParty(kc);
  guest.disconnected = true;                        // the network switch took the broker socket too
  call.peerConnection.setState('failed');
  await kc.clock.advance(2500);
  assert.equal(guest.outgoingCalls.length, 1, 'no call without a broker');
  assert.ok(guest.reconnects >= 1, 'asked the broker connection back');
  guest.disconnected = false;
  await kc.clock.advance(6000);
  assert.equal(guest.outgoingCalls.length, 2, 'redialled once it was back');
});

test('reconnect (host): the same guest coming back replaces the dead call; strangers still can’t', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  const { host, call } = await startHostParty(kc, 'GUEST-A');
  // The guest redials before the host has even noticed the old call die.
  const back = kc.makeIncomingCall('GUEST-A');
  host.emit('call', back);
  assert.equal(call.closed, true, 'old call closed');
  assert.ok(back.answeredWith, 'the guest is let back in');
  const stranger = kc.makeIncomingCall('GUEST-B');
  host.emit('call', stranger);
  assert.equal(stranger.answeredWith, undefined);
  assert.equal(stranger.closed, true);
  const conn = kc.makeIncomingConn('GUEST-A');
  host.emit('connection', conn);
  conn.openNow();
  back.emit('stream', kc.makeRemoteStream());
  assert.equal(kc.eval('reconnecting'), null);
  assert.equal(kc.eval('partyMode'), true);
  assert.equal(kc.eval('mediaCall'), back);
  assert.equal(kc.eval('partyConn'), conn);
});

test('reconnect: no shooting while the friend is gone', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  const { call } = await startHostParty(kc);
  call.peerConnection.setState('failed');
  kc.$('macShutter').click();
  await kc.clock.advance(100);
  assert.equal(kc.eval('busy'), false);
});

test('a goodbye ends the party at once; leaving sends one', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  const { conn } = await startHostParty(kc);
  kc.eval('handlePartyData')({ type: 'bye' });
  assert.equal(kc.eval('partyMode'), false);
  assert.equal(kc.eval('reconnecting'), null);
  assert.match(kc.$('qrHostStatus').textContent, /left the party/);

  const kc2 = await loadBooth();
  await kc2.startCamera();
  const party = await startGuestParty(kc2);
  kc2.$('leavePartyBtn').click();
  assert.ok(party.conn.sent.some(m => m.type === 'bye'));
  assert.ok(conn);
});

test('a friend vanishing without a goodbye (closed tab) ends after the reconnect window', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  const { call } = await startHostParty(kc);
  call.close();
  await kc.clock.advance(44000);
  assert.equal(kc.eval('partyMode'), true);
  await kc.clock.advance(2000);
  assert.equal(kc.eval('partyMode'), false);
});

/* ---- sending ---- */

test('a phone sends "balanced" so its frame rate survives a congested link; a laptop keeps resolution', async () => {
  for (const [mobile, pref, rate] of [[true, 'balanced', 1500000], [false, 'maintain-resolution', 2500000]]){
    const kc = await loadBooth({ mobile });
    await kc.startCamera();
    const { call } = await startHostParty(kc);
    await kc.clock.advance(1300);
    const p = call.peerConnection.videoSender.params;
    assert.equal(p.degradationPreference, pref);
    assert.equal(p.encodings[0].maxBitrate, rate);
  }
});

/* ---- playback ---- */

test('both videos are muted, inline and autoplay (property and attribute) before play()', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  await startHostParty(kc);
  for (const v of [kc.$('video'), kc.$('remoteVideo')]){
    assert.equal(v.muted, true, v.id);
    assert.equal(v.playsInline, true, v.id);
    assert.equal(v.autoplay, true, v.id);
    for (const a of ['muted', 'autoplay', 'playsinline', 'webkit-playsinline']) assert.ok(v.hasAttribute(a), v.id + ' ' + a);
    assert.ok(v.playCalls >= 1, v.id + ' played');
  }
  const { markup } = extractParts();
  assert.equal((markup.match(/webkit-playsinline/g) || []).length, 2, 'in the markup too');
});

test('coming back to the page restarts BOTH videos (iOS pauses them in the background)', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  await startHostParty(kc);
  const local = kc.$('video'), remote = kc.$('remoteVideo');
  const l = local.playCalls, r = remote.playCalls;
  kc.document.hidden = false;
  kc.document._fire({ type: 'visibilitychange', preventDefault(){}, stopPropagation(){} });
  assert.ok(local.playCalls > l, 'local preview restarted');
  assert.ok(remote.playCalls > r, 'friend restarted');
  kc.window._fire({ type: 'pageshow', preventDefault(){}, stopPropagation(){} });
  assert.ok(local.playCalls > l + 1, 'and on a back/forward-cache restore');
  // The camera track coming back from a mute (a call took it) restarts the preview.
  const before = local.playCalls;
  kc.env.tracks.find(t => t.local && t.readyState === 'live')._fire({ type: 'unmute', preventDefault(){}, stopPropagation(){} });
  assert.ok(local.playCalls > before);
});

/* ---- orientation ---- */

test('rotating re-syncs the viewfinder and re-centres the rail, once per rotation', async () => {
  const kc = await loadBooth({ mobile: true, camera: { w: 1280, h: 720 } });
  await kc.startCamera();
  kc.document.querySelector('.mode-tab[data-mode="filters"]').click();
  const v = kc.$('video');
  v.videoWidth = 1080; v.videoHeight = 1920;          // the sensor's frames turned
  const scrolls = kc.env.scrollIntoViewCalls;
  for (let i = 0; i < 5; i++) kc.window._fire({ type: 'resize', preventDefault(){}, stopPropagation(){} });
  kc.window._fire({ type: 'orientationchange', preventDefault(){}, stopPropagation(){} });
  await kc.clock.advance(300);
  assert.equal(kc.$('viewfinder').style.aspectRatio, '1920 / 1080', 'presented landscape on a phone');
  assert.equal(kc.env.scrollIntoViewCalls - scrolls, 1, 'debounced to one pass');
  assert.match(kc.$('camReadout').textContent, /1080×1920/);
});

test('long counters can’t widen the title bar; party readouts wrap', () => {
  const css = stylesheet();
  const status = rulesFor(css, '.mac-status').join('');
  assert.match(status, /max-width:\s*38%/);
  assert.match(status, /min-width:\s*0/);
  assert.match(rulesFor(css, '#shotCount').join(''), /text-overflow:\s*ellipsis/);
  assert.match(rulesFor(css, '.party-status').join(''), /overflow-wrap:\s*anywhere/);
});
