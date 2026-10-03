// Test harness for the KC Snap single-file booth.
//
// The app is one inline <script> IIFE inside the HTML page, with no exports
// and no build step. This harness loads the real page, builds a small fake
// DOM from its markup, and runs the real script against fakes for every
// browser API it touches (camera, canvas, timers, PeerJS, MediaPipe). Nothing
// here edits the page: the only change to the script is an eval hook appended
// in memory, just before the IIFE closes, so tests can reach its private
// state — kc.eval('busy'), kc.eval('setEffect(4)') and so on.
//
// No third-party packages: Node's built-in test runner and these fakes only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const HTML_PATH = process.env.KC_SNAP_HTML
  ? path.resolve(process.env.KC_SNAP_HTML)
  : path.resolve(here, '..', 'index.html');

let cachedParts = null;

/* The page split into the pieces the tests need: the stylesheet, the body
   markup before the first <script>, and the inline app script. */
export function extractParts(){
  if (cachedParts) return cachedParts;
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const css = html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'));
  const bodyStart = html.indexOf('<body>') + '<body>'.length;
  const markup = html.slice(bodyStart, html.indexOf('<script', bodyStart));
  const m = html.match(/<script>\r?\n([\s\S]*?)\r?\n<\/script>/);
  if (!m) throw new Error('inline <script> not found in ' + HTML_PATH);
  cachedParts = { css, markup, script: m[1] };
  return cachedParts;
}

/* ------------------------------------------------------------------ */
/* Microtasks and a controllable clock                                */
/* ------------------------------------------------------------------ */

// setImmediate runs after the microtask queue has fully drained.
export const flushMicrotasks = () => new Promise(r => setImmediate(r));

class FakeClock {
  constructor(){
    this.now = 1000;
    this.seq = 0;
    this.timers = new Map();
    this.frames = [];
    this.setTimeout = (fn, ms = 0, ...args) => this._add(fn, ms, args, false);
    this.setInterval = (fn, ms = 0, ...args) => this._add(fn, ms, args, true);
    this.clearTimeout = (id) => { this.timers.delete(id); };
    this.clearInterval = (id) => { this.timers.delete(id); };
    this.requestAnimationFrame = (fn) => { this.frames.push(fn); return this.frames.length; };
  }
  _add(fn, ms, args, repeat){
    const id = ++this.seq;
    const delay = Math.max(0, Number(ms) || 0);
    this.timers.set(id, { fn, args, delay, at: this.now + (repeat ? Math.max(1, delay) : delay), repeat });
    return id;
  }
  pendingWithDelay(ms){
    let n = 0;
    for (const t of this.timers.values()) if (!t.repeat && t.delay === ms) n++;
    return n;
  }
  // Runs every timer due within `ms`, in order, letting promise chains settle between them.
  async advance(ms){
    const end = this.now + ms;
    for (;;){
      await flushMicrotasks();
      let nextId = null, next = null;
      for (const [id, t] of this.timers){
        if (t.at <= end && (!next || t.at < next.at)){ next = t; nextId = id; }
      }
      if (!next) break;
      this.now = Math.max(this.now, next.at);
      if (next.repeat) next.at += Math.max(1, next.delay);
      else this.timers.delete(nextId);
      next.fn(...next.args);
    }
    this.now = end;
    await flushMicrotasks();
  }
  // Runs `n` animation frames, 16ms apart.
  async frame(n = 1){
    for (let i = 0; i < n; i++){
      this.now += 16;
      const due = this.frames;
      this.frames = [];
      for (const f of due) f(this.now);
      await flushMicrotasks();
    }
  }
}

/* ------------------------------------------------------------------ */
/* A small DOM                                                        */
/* ------------------------------------------------------------------ */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", times: '×', nbsp: ' ', middot: '·' };

function decodeEntities(s){
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
  });
}

function parseInto(doc, parent, html){
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  const stack = [parent];
  let m;
  while ((m = re.exec(html))){
    const top = stack[stack.length - 1];
    if (m[0].startsWith('<!--')) continue;
    if (m[1]){
      const tag = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--){
        if (stack[i].localName === tag){ stack.length = i; break; }
      }
      continue;
    }
    if (m[2]){
      const tag = m[2].toLowerCase();
      const el = doc.createElement(tag);
      const attrRe = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a;
      while ((a = attrRe.exec(m[3] || ''))){
        const v = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '';
        el.setAttribute(a[1], decodeEntities(v));
      }
      top.appendChild(el);
      if (!VOID.has(tag) && !m[4]) stack.push(el);
      continue;
    }
    if (m[5]) top.appendChild(doc.createTextNode(decodeEntities(m[5])));
  }
}

function serialize(n){
  if (n.nodeType === 3) return n.data.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const attrs = [...n._attrs].map(([k, v]) => v === '' ? ' ' + k : ' ' + k + '="' + v.replace(/"/g, '&quot;') + '"').join('');
  if (VOID.has(n.localName)) return '<' + n.localName + attrs + '>';
  return '<' + n.localName + attrs + '>' + n.childNodes.map(serialize).join('') + '</' + n.localName + '>';
}

function walk(node, fn){
  fn(node);
  if (node.childNodes) for (const c of node.childNodes.slice()) walk(c, fn);
}

function compileCompound(s){
  if (/\s/.test(s)) throw new Error('harness: descendant selectors are not supported: ' + s);
  const re = /\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|([#.]?)([\w-]+)/g;
  const tests = [];
  let m;
  while ((m = re.exec(s))){
    if (m[1]){
      const name = m[1].toLowerCase();
      const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
      tests.push(n => n.hasAttribute(name) && (val === undefined || n.getAttribute(name) === val));
    } else if (m[5] === '#'){
      const id = m[6];
      tests.push(n => n.id === id);
    } else if (m[5] === '.'){
      const c = m[6];
      tests.push(n => n.classList.contains(c));
    } else {
      const t = m[6].toLowerCase();
      tests.push(n => n.localName === t);
    }
  }
  return n => n.nodeType === 1 && tests.every(t => t(n));
}

function compileSelector(sel){
  const parts = sel.trim().split(/\s*,\s*/).map(compileCompound);
  return n => parts.some(p => p(n));
}

class FakeEvent {
  constructor(type, init = {}){
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this._stopped = false;
  }
  preventDefault(){ this.defaultPrevented = true; }
  stopPropagation(){ this._stopped = true; }
}

class FakeEventTarget {
  constructor(){ this._listeners = new Map(); }
  addEventListener(type, fn, opts){
    if (!fn) return;
    const list = this._listeners.get(type) || [];
    if (list.some(l => l.fn === fn)) return;
    list.push({ fn, once: !!(opts && opts.once) });
    this._listeners.set(type, list);
  }
  removeEventListener(type, fn){
    const list = this._listeners.get(type);
    if (!list) return;
    const i = list.findIndex(l => l.fn === fn);
    if (i >= 0) list.splice(i, 1);
  }
  listenerCount(type){ return (this._listeners.get(type) || []).length; }
  _fire(evt){
    evt.currentTarget = this;
    const handler = this['on' + evt.type];
    if (typeof handler === 'function') handler.call(this, evt);
    for (const l of (this._listeners.get(evt.type) || []).slice()){
      if (l.once) this.removeEventListener(evt.type, l.fn);
      l.fn.call(this, evt);
    }
  }
  dispatchEvent(evt){
    if (!evt.target) evt.target = this;
    let node = this;
    while (node){
      node._fire(evt);
      if (!evt.bubbles || evt._stopped) break;
      node = node.parentNode;
    }
    return !evt.defaultPrevented;
  }
}

class FakeText {
  constructor(data){ this.nodeType = 3; this.data = String(data); this.parentNode = null; }
  get textContent(){ return this.data; }
}

function makeClassList(el){
  const get = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  const set = (arr) => el.setAttribute('class', arr.join(' '));
  return {
    add(...c){ const a = get(); c.forEach(x => { if (!a.includes(x)) a.push(x); }); set(a); },
    remove(...c){ set(get().filter(x => !c.includes(x))); },
    contains(c){ return get().includes(c); },
    toggle(c, force){
      const has = get().includes(c);
      const want = force === undefined ? !has : !!force;
      if (want && !has) this.add(c);
      else if (!want && has) this.remove(c);
      return want;
    },
  };
}

function makeDataset(el){
  const attr = p => 'data-' + p.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  return new Proxy({}, {
    get: (_, p) => {
      if (typeof p !== 'string') return undefined;
      const v = el.getAttribute(attr(p));
      return v === null ? undefined : v;
    },
    set: (_, p, v) => { el.setAttribute(attr(p), v); return true; },
  });
}

function makeStyle(){
  return {
    setProperty(n, v){ this[n] = String(v); },
    getPropertyValue(n){ return this[n] || ''; },
    removeProperty(n){ delete this[n]; },
  };
}

class FakeElement extends FakeEventTarget {
  constructor(doc, tag){
    super();
    this.ownerDocument = doc;
    this.localName = tag;
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.parentNode = null;
    this._attrs = new Map();
    this.style = makeStyle();
    this.classList = makeClassList(this);
    this.dataset = makeDataset(this);
  }
  get children(){ return this.childNodes.filter(n => n.nodeType === 1); }
  setAttribute(n, v){ this._attrs.set(String(n).toLowerCase(), String(v)); }
  getAttribute(n){ const v = this._attrs.get(String(n).toLowerCase()); return v === undefined ? null : v; }
  hasAttribute(n){ return this._attrs.has(String(n).toLowerCase()); }
  removeAttribute(n){ this._attrs.delete(String(n).toLowerCase()); }
  _reflect(name){ return this.getAttribute(name) || ''; }
  get id(){ return this._reflect('id'); }
  set id(v){ this.setAttribute('id', v); }
  get className(){ return this._reflect('class'); }
  set className(v){ this.setAttribute('class', v); }
  get title(){ return this._reflect('title'); }
  set title(v){ this.setAttribute('title', v); }
  get type(){ return this._reflect('type'); }
  set type(v){ this.setAttribute('type', v); }
  get alt(){ return this._reflect('alt'); }
  set alt(v){ this.setAttribute('alt', v); }
  get href(){ return this._reflect('href'); }
  set href(v){ this.setAttribute('href', v); }
  get download(){ return this._reflect('download'); }
  set download(v){ this.setAttribute('download', v); }
  get hidden(){ return this.hasAttribute('hidden'); }
  set hidden(v){ if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get disabled(){ return this.hasAttribute('disabled'); }
  set disabled(v){ if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get value(){ return this._value !== undefined ? this._value : (this.getAttribute('value') || ''); }
  set value(v){ this._value = String(v); }
  get checked(){ return this._checked !== undefined ? this._checked : this.hasAttribute('checked'); }
  set checked(v){ this._checked = !!v; }
  appendChild(c){
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  insertBefore(c, ref){
    if (!ref) return this.appendChild(c);
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c);
    return c;
  }
  removeChild(c){
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  remove(){ if (this.parentNode) this.parentNode.removeChild(this); }
  get isConnected(){
    for (let n = this; n; n = n.parentNode) if (n === this.ownerDocument) return true;
    return false;
  }
  get textContent(){ return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v){
    this.childNodes.forEach(c => { c.parentNode = null; });
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  get innerHTML(){ return this.childNodes.map(serialize).join(''); }
  set innerHTML(v){ this.textContent = ''; parseInto(this.ownerDocument, this, String(v)); }
  querySelectorAll(sel){
    const match = compileSelector(sel);
    const out = [];
    walk(this, n => { if (n !== this && match(n)) out.push(n); });
    return out;
  }
  querySelector(sel){ return this.querySelectorAll(sel)[0] || null; }
  matches(sel){ return compileSelector(sel)(this); }
  closest(sel){
    const match = compileSelector(sel);
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (match(n)) return n;
    return null;
  }
  click(){
    // A disabled form control ignores click(), as in a browser.
    if (this.disabled && /^(button|input|select|textarea)$/.test(this.localName)) return;
    if (this.localName === 'a'){
      this.ownerDocument.env.anchorClicks.push({ href: this.href, download: this.download, connected: this.isConnected });
    }
    this.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  }
  focus(){}
  blur(){}
  select(){}
  setSelectionRange(){}
  scrollIntoView(){ this.ownerDocument.env.scrollIntoViewCalls++; }
  getBoundingClientRect(){
    const r = this._rect || { left: 0, top: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height };
  }
  get offsetWidth(){ return 0; }
}

/* ---- canvas ----
   Drawing calls are accepted and ignored, except on tiny canvases (the
   ctx.filter probe), which keep real pixels so the probe can be exercised.
   ctxFilter decides what the 2D context does with `filter`:
     'native'          - a real attribute that changes what gets drawn
     'expando'         - no attribute at all (Safari/iOS < 18): assigning it
                         just creates a plain property that does nothing
     'native-shielded' - real filter, but pixel readback is blanked out */
function parseColor(c){
  const s = String(c).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) return [...m[1]].map(h => parseInt(h + h, 16)).concat(255);
  m = s.match(/^#([0-9a-f]{6})$/);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).concat(255);
  m = s.match(/^rgba?\(([^)]*)\)$/);
  if (m){
    const p = m[1].split(',').map(x => parseFloat(x));
    return [p[0], p[1], p[2], Math.round((p[3] === undefined ? 1 : p[3]) * 255)];
  }
  return [0, 0, 0, 255];
}

class Ctx2D {
  constructor(canvas){
    this.canvas = canvas;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.font = '10px sans-serif';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this.shadowColor = 'transparent';
    this.shadowBlur = 0;
    this.shadowOffsetX = 0;
    this.shadowOffsetY = 0;
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = 'low';
    this.calls = null;      // set to [] to record calls
  }
  // Each recorded call also notes the blend mode and alpha it was made under.
  _rec(name, args){
    if (!this.calls) return;
    const entry = [name, ...args];
    entry.op = this.globalCompositeOperation;
    entry.alpha = this.globalAlpha;
    this.calls.push(entry);
  }
  _filterInverts(){ return false; }
  _tint(rgba){
    if (!this._filterInverts()) return rgba;
    return [255 - rgba[0], 255 - rgba[1], 255 - rgba[2], rgba[3]];
  }
  _paint(x, y, w, h, rgba){
    const px = this.canvas._pixels;
    if (!px) return;
    const cw = this.canvas.width, ch = this.canvas.height;
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(ch, Math.ceil(y + h)); yy++){
      for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(cw, Math.ceil(x + w)); xx++){
        px.set(rgba, (yy * cw + xx) * 4);
      }
    }
  }
  save(){} restore(){} setTransform(){} resetTransform(){} transform(){} translate(){} scale(){} rotate(){}
  beginPath(){} closePath(){} moveTo(){} lineTo(){} rect(){} roundRect(){} arc(){} arcTo(){}
  fill(){} stroke(){} clip(){} strokeRect(){}
  clearRect(x, y, w, h){ this._paint(x, y, w, h, [0, 0, 0, 0]); }
  fillRect(x, y, w, h){ this._rec('fillRect', [x, y, w, h]); this._paint(x, y, w, h, this._tint(parseColor(this.fillStyle))); }
  fillText(...a){ this._rec('fillText', a); }
  measureText(t){ return { width: String(t).length * 8 }; }
  createLinearGradient(){ return { addColorStop(){} }; }
  createRadialGradient(){ return { addColorStop(){} }; }
  drawImage(img, ...a){
    this._rec('drawImage', [img, ...a]);
    const dst = this.canvas._pixels, src = img && img._pixels;
    if (!dst || !src) return;
    let sx = 0, sy = 0, sw = img.width, sh = img.height, dx, dy, dw, dh;
    if (a.length === 2){ [dx, dy] = a; dw = sw; dh = sh; }
    else if (a.length === 4){ [dx, dy, dw, dh] = a; }
    else { [sx, sy, sw, sh, dx, dy, dw, dh] = a; }
    for (let yy = 0; yy < dh; yy++){
      for (let xx = 0; xx < dw; xx++){
        const tx = Math.floor(dx + xx), ty = Math.floor(dy + yy);
        if (tx < 0 || ty < 0 || tx >= this.canvas.width || ty >= this.canvas.height) continue;
        const fx = Math.floor(sx + xx * sw / dw), fy = Math.floor(sy + yy * sh / dh);
        const o = (fy * img.width + fx) * 4;
        dst.set(this._tint([src[o], src[o + 1], src[o + 2], src[o + 3]]), (ty * this.canvas.width + tx) * 4);
      }
    }
  }
  getImageData(x, y, w, h){
    this._rec('getImageData', [x, y, w, h]);
    const data = new Uint8ClampedArray(w * h * 4);
    const px = this.canvas._pixels;
    if (px && !this._shielded){
      for (let yy = 0; yy < h; yy++){
        for (let xx = 0; xx < w; xx++){
          const o = ((y + yy) * this.canvas.width + (x + xx)) * 4;
          data.set(px.subarray(o, o + 4), (yy * w + xx) * 4);
        }
      }
    }
    return { data, width: w, height: h };
  }
  putImageData(img, x = 0, y = 0){
    this._rec('putImageData', [img, x, y]);
    const px = this.canvas._pixels;
    if (!px) return;
    for (let yy = 0; yy < img.height; yy++){
      for (let xx = 0; xx < img.width; xx++){
        const o = (yy * img.width + xx) * 4;
        px.set(img.data.subarray(o, o + 4), ((y + yy) * this.canvas.width + (x + xx)) * 4);
      }
    }
  }
}

// A context whose `filter` attribute exists and really changes what is drawn.
class Ctx2DWithFilter extends Ctx2D {
  constructor(canvas, shielded){ super(canvas); this._filter = 'none'; this._shielded = !!shielded; }
  get filter(){ return this._filter; }
  set filter(v){ this._filter = String(v); }
  _filterInverts(){ return /invert\(\s*1\s*\)/.test(this._filter); }
}

class FakeCanvas extends FakeElement {
  constructor(doc){ super(doc, 'canvas'); this._w = 300; this._h = 150; this._ctx = null; this._pixels = null; }
  get width(){ return this._w; }
  set width(v){ this._w = Math.max(0, Math.floor(Number(v)) || 0); this._resetPixels(); }
  get height(){ return this._h; }
  set height(v){ this._h = Math.max(0, Math.floor(Number(v)) || 0); this._resetPixels(); }
  _resetPixels(){ this._pixels = (this._w * this._h <= 64) ? new Uint8ClampedArray(this._w * this._h * 4) : null; }
  getContext(type){
    if (type !== '2d') return null;
    if (!this._ctx){
      const mode = this.ownerDocument.env.ctxFilter;
      this._ctx = mode === 'expando' ? new Ctx2D(this) : new Ctx2DWithFilter(this, mode === 'native-shielded');
    }
    return this._ctx;
  }
  toDataURL(type = 'image/png'){
    const env = this.ownerDocument.env;
    const url = 'data:' + type + ';base64,FAKE' + (++env.dataUrlSeq);
    env.imageSizes.set(url, { w: this._w, h: this._h });
    return url;
  }
  toBlob(cb, type = 'image/png'){
    const env = this.ownerDocument.env;
    const blob = env.toBlobReturnsNull ? null : new Blob(['fake ' + this._w + 'x' + this._h], { type });
    // Asynchronous, as in a browser: encoding happens off the current task.
    env.clock.setTimeout(() => cb(blob), 0);
  }
  // A live video track of this canvas, for MediaRecorder.
  captureStream(fps){
    const env = this.ownerDocument.env;
    const track = { kind: 'video', stopped: false, stop(){ this.stopped = true; } };
    const stream = { canvas: this, fps, track, getTracks: () => [track] };
    env.captureStreams.push(stream);
    return stream;
  }
}

class FakeVideo extends FakeElement {
  constructor(doc){
    super(doc, 'video');
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.readyState = 0;
    this.paused = true;
    this.currentTime = 0;
    this.playCalls = 0;
    this._src = null;
  }
  get srcObject(){ return this._src; }
  set srcObject(s){
    this._src = s;
    if (s && s._size){
      this.videoWidth = s._size.w;
      this.videoHeight = s._size.h;
      this.readyState = 4;
    } else {
      this.videoWidth = 0;
      this.videoHeight = 0;
      this.readyState = 0;
      this.paused = true;
    }
  }
  play(){ this.playCalls++; this.paused = false; return Promise.resolve(); }
  pause(){ this.paused = true; }
}

/* Image dimensions straight from the PNG/JPEG header, so the page's real
   embedded art loads at its real size. */
const headerSizeCache = new Map();
function sizeFromDataUrl(url){
  if (headerSizeCache.has(url)) return headerSizeCache.get(url);
  let size = null;
  const m = /^data:image\/(png|jpeg);base64,/.exec(url);
  if (m){
    const b = Buffer.from(url.slice(m[0].length), 'base64');
    if (m[1] === 'png' && b.length > 24) size = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (m[1] === 'jpeg'){
      let o = 2;
      while (o + 9 < b.length){
        if (b[o] !== 0xFF){ o++; continue; }
        const marker = b[o + 1];
        const len = b.readUInt16BE(o + 2);
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC){
          size = { w: b.readUInt16BE(o + 7), h: b.readUInt16BE(o + 5) };
          break;
        }
        o += 2 + len;
      }
    }
  }
  headerSizeCache.set(url, size);
  return size;
}

class FakeImg extends FakeElement {
  constructor(doc){ super(doc, 'img'); this.complete = true; this.naturalWidth = 0; this.naturalHeight = 0; }
  get src(){ return this.getAttribute('src') || ''; }
  set src(v){
    v = String(v);
    this.setAttribute('src', v);
    this.complete = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    const env = this.ownerDocument.env;
    queueMicrotask(() => {
      if (this.getAttribute('src') !== v) return;
      const size = env.imageSizes.get(v) || sizeFromDataUrl(v);
      this.complete = true;
      if (!size){ this._fire(new FakeEvent('error')); return; }
      this.naturalWidth = size.w;
      this.naturalHeight = size.h;
      this._fire(new FakeEvent('load'));
    });
  }
  get width(){ return this.naturalWidth; }
  get height(){ return this.naturalHeight; }
}

class FakeDocument extends FakeEventTarget {
  constructor(env){
    super();
    this.env = env;
    this.nodeType = 9;
    this.hidden = false;
    this.visibilityState = 'visible';
    this.documentElement = this.createElement('html');
    this.documentElement.parentNode = this;
    this.head = this.documentElement.appendChild(this.createElement('head'));
    this.body = this.documentElement.appendChild(this.createElement('body'));
    this.fonts = { load: () => Promise.resolve([]), ready: Promise.resolve() };
  }
  createElement(tag){
    tag = String(tag).toLowerCase();
    if (tag === 'canvas') return new FakeCanvas(this);
    if (tag === 'video') return new FakeVideo(this);
    if (tag === 'img') return new FakeImg(this);
    return new FakeElement(this, tag);
  }
  createTextNode(d){ return new FakeText(d); }
  getElementById(id){
    let found = null;
    walk(this.documentElement, n => { if (!found && n.nodeType === 1 && n.id === id) found = n; });
    return found;
  }
  querySelectorAll(sel){ return this.documentElement.querySelectorAll(sel); }
  querySelector(sel){ return this.documentElement.querySelector(sel); }
  execCommand(){ return true; }
}

/* ------------------------------------------------------------------ */
/* Camera, PeerJS and MediaPipe fakes                                 */
/* ------------------------------------------------------------------ */

class FakeTrack extends FakeEventTarget {
  constructor(env, settings){
    super();
    this.kind = 'video';
    this.readyState = 'live';
    this.stopped = false;
    this.caps = {};
    this._settings = settings;
    env.tracks.push(this);
  }
  stop(){ this.readyState = 'ended'; this.stopped = true; }      // never fires 'ended', as in a browser
  getCapabilities(){ return this.caps; }
  getSettings(){ return this._settings; }
  async applyConstraints(){}
  // The OS taking the camera away: the one case that fires 'ended'.
  endExternally(){ this.readyState = 'ended'; this._fire(new FakeEvent('ended')); }
}

class FakeStream {
  constructor(track, size){ this._tracks = [track]; this._size = size; }
  getTracks(){ return this._tracks.slice(); }
  getVideoTracks(){ return this._tracks.filter(t => t.kind === 'video'); }
}

class Emitter {
  constructor(){ this._handlers = new Map(); }
  on(e, f){ const l = this._handlers.get(e) || []; l.push({ f, once: false }); this._handlers.set(e, l); return this; }
  once(e, f){ const l = this._handlers.get(e) || []; l.push({ f, once: true }); this._handlers.set(e, l); return this; }
  off(e, f){ const l = this._handlers.get(e) || []; const i = l.findIndex(x => x.f === f); if (i >= 0) l.splice(i, 1); return this; }
  emit(e, ...args){
    const l = (this._handlers.get(e) || []).slice();
    for (const x of l){ if (x.once) this.off(e, x.f); x.f(...args); }
    return l.length > 0;
  }
}

export class FakeMediaConnection extends Emitter {
  constructor(peerId, stream){
    super();
    this.peer = peerId;
    this.localStream = stream;
    this.open = false;
    this.closed = false;
    this.answeredWith = undefined;
    this.peerConnection = { getSenders: () => [], addEventListener(){}, iceConnectionState: 'connected', connectionState: 'connected' };
  }
  answer(s){ this.answeredWith = s; this.open = true; }
  close(){ if (this.closed) return; this.closed = true; this.open = false; this.emit('close'); }
}

export class FakeDataConnection extends Emitter {
  constructor(peerId){ super(); this.peer = peerId; this.open = false; this.closed = false; this.sent = []; }
  send(m){ this.sent.push(m); }
  close(){ if (this.closed) return; this.closed = true; this.open = false; this.emit('close'); }
  openNow(){ this.open = true; this.emit('open'); }
}

function makePeerClass(env){
  return class FakePeer extends Emitter {
    constructor(id, options){
      super();
      if (id && typeof id === 'object'){ options = id; id = null; }
      this.id = id || ('GUEST' + (env.peers.length + 1));
      this.options = options;
      this.destroyed = false;
      this.reconnects = 0;
      this.outgoingCalls = [];
      this.outgoingConns = [];
      env.peers.push(this);
    }
    call(remoteId, stream){ const c = new FakeMediaConnection(remoteId, stream); this.outgoingCalls.push(c); return c; }
    connect(remoteId){ const c = new FakeDataConnection(remoteId); this.outgoingConns.push(c); return c; }
    reconnect(){ if (this.destroyed) throw new Error('This peer has been destroyed'); this.reconnects++; }
    destroy(){
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('disconnected', this.id);
      this.emit('close');
    }
  };
}

function makeSegmentationClass(env){
  return class FakeSelfieSegmentation {
    constructor(opts){ this.opts = opts; this._onResults = null; this.closed = false; env.segs.push(this); }
    setOptions(){}
    onResults(f){ this._onResults = f; }
    async send(){ env.segSends++; if (this._onResults) this._onResults({}); }
    close(){ this.closed = true; }
  };
}

/* MediaRecorder: records nothing, but keeps the browser's shape — start(),
   then stop() delivers one dataavailable and a stop event on a later task.
   env.videoTypes is what isTypeSupported() says yes to. */
function makeMediaRecorderClass(env){
  return class FakeMediaRecorder {
    static isTypeSupported(type){ return env.videoTypes.includes(type); }
    constructor(stream, options = {}){
      this.stream = stream;
      this.mimeType = options.mimeType || '';
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
      this.onerror = null;
      this.startedAt = null;
      this.stoppedAt = null;
      env.recorders.push(this);
    }
    start(timeslice){
      this.state = 'recording';
      this.timeslice = timeslice;
      this.startedAt = env.clock.now;
    }
    stop(){
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      this.stoppedAt = env.clock.now;
      env.clock.setTimeout(() => {
        if (this.ondataavailable) this.ondataavailable({ data: new Blob(['fake video'], { type: this.mimeType }) });
        if (this.onstop) this.onstop();
      }, 0);
    }
  };
}

function facingOf(constraints){
  const v = constraints && constraints.video;
  return (v && typeof v === 'object' && v.facingMode) ? v.facingMode.ideal || v.facingMode.exact : undefined;
}

export function busyCameraError(){
  return Object.assign(new Error('Could not start video source'), { name: 'NotReadableError' });
}

/* ------------------------------------------------------------------ */
/* Loading the page                                                   */
/* ------------------------------------------------------------------ */

function makeEnv(opts){
  const env = {
    peers: [], tracks: [], shares: [], anchorClicks: [], segs: [],
    gumCalls: 0, gumLog: [], segSends: 0, dataUrlSeq: 0, scrollIntoViewCalls: 0,
    recorders: [], captureStreams: [],
    // What MediaRecorder.isTypeSupported() accepts: WebM only by default, as in Firefox.
    videoTypes: opts.videoTypes || ['video/webm;codecs=vp8', 'video/webm'],
    imageSizes: new Map(),
    ctxFilter: opts.ctxFilter || 'native',
    toBlobReturnsNull: !!opts.toBlobReturnsNull,
  };
  env.clock = new FakeClock();
  env.document = new FakeDocument(env);
  const cam = opts.camera || { w: 1280, h: 720 };

  /* getUserMedia. oneCameraAtATime models the many phones that cannot open a
     second camera while one is still live. Tests may replace env.gumImpl. */
  env.cameraStream = (constraints) => {
    const track = new FakeTrack(env, { width: cam.w, height: cam.h, deviceId: 'cam' + env.tracks.length, facingMode: facingOf(constraints) });
    track.local = true;
    return new FakeStream(track, { w: cam.w, h: cam.h });
  };
  env.cameraIsHeld = () => env.tracks.some(t => t.local && t.readyState === 'live');
  env.gumImpl = async (constraints) => {
    if (opts.oneCameraAtATime && env.cameraIsHeld()) throw busyCameraError();
    return env.cameraStream(constraints);
  };
  env.facingOf = facingOf;
  env.makeStream = (size = cam) => new FakeStream(new FakeTrack(env, { width: size.w, height: size.h }), { w: size.w, h: size.h });

  const url = { current: new URL(opts.url || 'https://booth.example/') };
  env.location = {
    get href(){ return url.current.href; },
    get protocol(){ return url.current.protocol; },
    get search(){ return url.current.search; },
    get hash(){ return url.current.hash; },
    get host(){ return url.current.host; },
    get pathname(){ return url.current.pathname; },
    get origin(){ return url.current.origin; },
    toString(){ return url.current.href; },
  };
  env.history = {
    state: null,
    replaceState(state, _title, next){ url.current = new URL(String(next), url.current); this.state = state; },
    pushState(state, _title, next){ url.current = new URL(String(next), url.current); this.state = state; },
  };

  env.navigator = {
    userAgent: 'kc-snap-tests',
    mediaDevices: {
      getUserMedia: (c) => { env.gumCalls++; env.gumLog.push(c); return env.gumImpl(c); },
      enumerateDevices: async () => [],
    },
    canShare: () => true,
    share: async (data) => { env.shares.push(data); },
    clipboard: { writeText: async () => {} },
  };

  const Peer = makePeerClass(env);
  const SelfieSegmentation = opts.segmentation ? makeSegmentationClass(env) : undefined;
  // noMediaRecorder: a browser that can't record video (older Safari, some WebViews).
  const MediaRecorder = opts.noMediaRecorder ? undefined : makeMediaRecorderClass(env);
  const mobile = !!opts.mobile;
  const Image = function Image(){ return env.document.createElement('img'); };

  env.window = {
    matchMedia: () => ({ matches: mobile, addEventListener(){}, removeEventListener(){} }),
    isSecureContext: true,
    crypto: globalThis.crypto,
    Peer,
    SelfieSegmentation,
    MediaRecorder,
  };

  env.globals = {
    window: env.window,
    document: env.document,
    navigator: env.navigator,
    location: env.location,
    history: env.history,
    performance: { now: () => env.clock.now },
    requestAnimationFrame: env.clock.requestAnimationFrame,
    setTimeout: env.clock.setTimeout,
    clearTimeout: env.clock.clearTimeout,
    setInterval: env.clock.setInterval,
    clearInterval: env.clock.clearInterval,
    Image,
    URL,
    URLSearchParams,
    File,
    console,
    crypto: globalThis.crypto,
    Peer,
    SelfieSegmentation,
    MediaRecorder,
    Blob,
  };
  return env;
}

// The one in-memory change: an eval hook just before the IIFE closes.
function instrument(script){
  const end = script.lastIndexOf('})();');
  if (end < 0) throw new Error('harness: could not find the end of the app IIFE');
  return script.slice(0, end) + '\n;window.__kcEval = (__kcCode) => eval(__kcCode);\n' + script.slice(end);
}

export async function loadBooth(opts = {}){
  const env = makeEnv(opts);
  const { markup, script } = extractParts();
  parseInto(env.document, env.document.body, markup);
  const names = Object.keys(env.globals);
  // The page script runs with every browser global it uses passed in as a
  // parameter, so nothing in it can reach Node's own timers or globals.
  const run = new Function(...names, instrument(script));
  run(...names.map(n => env.globals[n]));
  await env.clock.advance(0);

  const kc = {
    env,
    clock: env.clock,
    document: env.document,
    window: env.window,
    eval: (code) => env.window.__kcEval(code),
    $: (id) => env.document.getElementById(id),
    flush: flushMicrotasks,
    makeIncomingCall: (peerId) => new FakeMediaConnection(peerId),
    makeIncomingConn: (peerId) => new FakeDataConnection(peerId),
    makeRemoteStream: () => env.makeStream({ w: 640, h: 480 }),
    // The red button, before the camera is on: starts it.
    async startCamera(){
      env.document.getElementById('macShutter').click();
      await env.clock.advance(10);
      if (!kc.eval('stream')) throw new Error('camera did not start');
    },
    // The red button with the camera on: one full capture sequence.
    async capture(){
      env.document.getElementById('macShutter').click();
      await env.clock.advance(30000);
    },
  };
  return kc;
}
