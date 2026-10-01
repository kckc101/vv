// Regression tests for the audit fixes. Each test names the audit item it
// covers (B = bug, C = compatibility, D = dead code, O = optimisation).
// Run with: npm test   (or: node --test "tests/*.test.mjs")

import test from 'node:test';
import assert from 'node:assert/strict';
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
  await kc.startCamera();
  kc.eval('partyMode = true');
  const run = kc.eval('runCaptureSequence()');
  await kc.clock.advance(500);
  assert.equal(kc.eval('busy'), true);
  kc.eval('handlePartyData')({ type: 'bg', index: 1 });    // the UAE poster, which has a photo box
  assert.equal(kc.eval('selectedBgIndex'), 0, 'not applied mid-sequence');
  assert.equal(kc.$('effectStripWrap').hidden, true, 'layout did not flip mid-sequence');
  await kc.clock.advance(30000);
  await run;
  assert.equal(kc.eval('shots.length'), kc.eval('TOTAL_SHOTS'), 'the strip was shot in full');
  assert.equal(kc.eval('selectedBgIndex'), 1, 'applied once the sequence ended');
  assert.equal(kc.$('effectStripWrap').hidden, false);
});

test('B3: malformed backdrop indexes from the other device are ignored', async () => {
  const kc = await loadBooth();
  const handle = kc.eval('handlePartyData');
  for (const index of ['1', 1.5, -1, 99, '__proto__', 'length', null, undefined]){
    handle({ type: 'bg', index });
    assert.equal(kc.eval('selectedBgIndex'), 0, `index ${String(index)} was accepted`);
  }
  handle({ type: 'bg', index: 2 });
  assert.equal(kc.eval('selectedBgIndex'), 2);
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

test('B7: a stall with the data channel closed ends the party at the stall mark', async () => {
  const kc = await loadBooth();
  const { conn } = await startHostParty(kc);
  conn.close();
  await kc.clock.advance(6000);
  assert.equal(kc.eval('partyMode'), false);
  assert.match(kc.$('qrHostStatus').textContent, /left the party/);
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

test('B12: a friend leaving mid-shot aborts the party capture cleanly', async () => {
  const kc = await loadBooth();
  await startHostParty(kc);
  kc.eval('selectBgIndex(1, true)');                // the poster with a photo box: one framed shot
  assert.equal(kc.$('effectStripWrap').hidden, false);
  kc.$('macShutter').click();
  await kc.clock.advance(1500);
  kc.eval("exitPartyMode('Your friend left the party.')");
  await kc.clock.advance(3000);
  assert.equal(kc.eval('busy'), false);
  assert.equal(kc.eval('effectShots.length'), 0, 'no frozen party frame captured');
  assert.equal(kc.$('effectStripWrap').hidden, true, 'back on the ordinary strip');
  assert.equal(kc.$('normalStripWrap').hidden, false);
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
  const kc = await loadBooth({ camera: { w: 720, h: 1280 } });   // desktop, portrait webcam
  await kc.startCamera();
  const ec = kc.$('effectCanvas');
  kc.eval('setEffect(6)');
  await kc.clock.frame(2);
  assert.deepEqual([ec.width, ec.height], [720, 1280]);
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

test('O3: party backdrops reuse the effect images instead of decoding them again', async () => {
  const kc = await loadBooth();
  assert.equal(kc.eval('bgImages[1]'), kc.eval('uaeBgImg'));
  assert.equal(kc.eval('bgImages[2]'), kc.eval('starBgImg'));
  for (const thumb of kc.$('stripFriends').querySelectorAll('img')){
    assert.match(thumb.src, /FAKE/, 'thumbnail is a small generated copy, not the full-size art');
  }
});

/* ---------------- O4 / D5: layouts ---------------- */

test('O4: each effect lands on the right strip layout', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  const single = () => !kc.$('effectStripWrap').hidden && kc.$('normalStripWrap').hidden
    && kc.$('effectStrip').classList.contains('single-frame') && kc.$('pips').hidden
    && kc.$('shotCount').textContent === '0 / 1' && kc.$('captureBtn').textContent === 'Take photo (1 shot)';
  const four = () => kc.$('effectStripWrap').hidden && !kc.$('normalStripWrap').hidden
    && !kc.$('effectStrip').classList.contains('single-frame') && !kc.$('pips').hidden
    && kc.$('captureBtn').textContent.startsWith('Take strip');

  kc.eval('setEffect(4)');
  assert.ok(single());
  assert.equal(kc.$('effectStripLabel').textContent, 'UAE Frame shot');
  kc.eval('setEffect(5)');
  assert.ok(single());
  assert.equal(kc.$('effectStripLabel').textContent, 'Photobooth shot');
  kc.eval('setEffect(6)');
  assert.ok(four());
  assert.equal(kc.$('effectCanvas').style.display, 'block');
  kc.eval('setEffect(0)');
  assert.ok(four());
  assert.equal(kc.$('effectCanvas').style.display, 'none');
});

test('D5: a removed pose effect id falls back to no effect', async () => {
  const kc = await loadBooth();
  kc.eval('setEffect(2)');
  assert.equal(kc.eval('activeEffect'), 0);
});

test('O4: a single-shot effect capture fills the print and enables its download', async () => {
  const kc = await loadBooth();
  await kc.startCamera();
  kc.eval('setEffect(4)');
  await kc.clock.frame(1);
  await kc.capture();
  assert.equal(kc.eval('effectShots.length'), 1);
  assert.ok(kc.$('efc0').querySelector('img'));
  assert.equal(kc.$('downloadEffectBtn').disabled, false);
  assert.equal(kc.$('shotCount').textContent, '1 / 1');
});
