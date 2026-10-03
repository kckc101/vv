# KC Snap

An online photo booth in a single HTML page. Shoot a four-frame strip from a
phone or laptop, add a filter or an effect, or connect a second device for party
mode and appear in one shared frame.

Effects, all drawn in code (no image files):

- **Photobooth B&W**: you, toned and pinned to a corkboard; one framed photo.
- **Flipbook**: a vintage photobooth flipbook with you on its top page. It
  sits still until the shutter is pressed; then the 10-second countdown, the
  page flipping and the video recording all start at once, and at zero the
  book settles and the video is ready (MP4 or WebM, depending on the browser;
  a still of the book where video recording isn't available).
- **Subway Door**: you, as a see-through reflection in the windows of a train
  door, with the empty carriage visible behind the glass; one framed photo.

Flipbook and Subway Door are also party backdrops, alongside Paper.

Everything runs in the browser: solo photos never leave the device, and party
mode connects the two cameras directly (WebRTC through the public PeerJS broker).

## Run it

`index.html` is the whole app: no build step, no dependencies to install. The
camera only works on `https://` or `localhost`, so serve the folder rather than
opening the file directly:

```sh
python -m http.server 8000
```

then open <http://localhost:8000/>.

It needs an internet connection: PeerJS (party mode) and MediaPipe (the AI
cutout, used by party mode and Subway Door) load from jsdelivr.

## Party mode across networks

Party mode uses STUN only, which can't connect two devices when one of them is
behind a strict NAT (common on mobile data and office Wi-Fi). Add a TURN relay
to `TURN_SERVERS` in `index.html` to fix that.

## Checks

Development only, needs Node 20+:

```sh
npm test         # regression tests (Node's built-in test runner, no packages)
npm run lint     # ESLint on the inline script and the tests, run through npx
npm run check    # both
```

The tests run the real page script against a small fake DOM and fake camera,
canvas, timers and PeerJS. See `tests/harness.mjs`.
