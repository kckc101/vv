# KC Snap

An online photo booth in a single HTML page. Shoot a four-frame strip from a
phone or laptop, add a filter or an effect, or connect a second device for party
mode and appear in one shared frame.

Effects:

- **Photobooth B&W**: you, toned and pinned to a corkboard; one framed photo.
- **Flipbook**: a vintage photobooth flipbook with you on its top page. It
  sits still until the shutter is pressed; then the 10-second countdown, the
  page flipping and the video recording all start at once, and at zero the
  book settles and the video is ready (MP4 or WebM, depending on the browser;
  a still of the book where video recording isn't available).
- **Subway Door**: you, as a see-through reflection in the windows of a train
  door, with the empty carriage visible behind the glass; one framed photo.
- **Living Room**: the KC Studio 2-frame template (a dark living room with a
  leather sofa). The AI cutout seats you on the sofa in both windows; the
  shutter takes two shots, each after a 3-second countdown, top window first.
  The template and both shots are flattened into one 1416x2484 JPEG.

All but Living Room are drawn in code; Living Room uses the supplied template
image, embedded in `index.html`.

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
cutout, used by party mode, Subway Door and Living Room) load from jsdelivr.

## Party mode

- **One stage for both devices.** The shared scene is a fixed 1280x720 canvas
  and the viewfinder takes its shape, so what you see is what's shot, on a
  phone or a laptop, host or guest.
- **Same picture on both screens.** The host stands on the left and the guest
  on the right on both devices, each drawn mirrored the way their own device
  shows them (the devices tell each other).
- **Mixed cameras.** Each person fills their own half with cover-fit and no
  stretching, so a portrait phone (720x1280) next to a landscape webcam
  (1280x720) comes out at a comparable size.
- **Network switches.** If the connection drops without a goodbye (Wi-Fi to
  mobile data, say), the booth stays in the party and reconnects for up to 45
  seconds. Leaving sends a goodbye, so the other side ends at once.
- **AI cutout.** The two feeds take turns on the model (one inference per tick,
  input capped at 360p, or 320 px on phones), and people are redrawn live
  between masks. A lost WebGL context rebuilds the model in a couple of
  seconds.

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
