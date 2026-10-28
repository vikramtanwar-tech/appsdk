# Smart Capture SDK test page (hosting package)

This is a static web page for testing the GBG Smart Capture Web SDK (v2.3.0) in a browser. It asks for camera permission,
captures an identity document or a face, and shows the full response from the SDK. The page is a mobile-only
view: on a desktop it shows as a phone-width column, and the SDK's camera screen is kept to that width too.

The page has no build step and no server-side code, and hosting it does not need npm or Node. Copy the folder
(without `tools/`) to any static web host. Node is only needed to rebuild `sdk/` from a new SDK package.

> **Confidential.** `sdk/` contains GBG's proprietary SDK. Its licence forbids publishing or disclosing it without
> GBG's written consent. Keep this repository private.

> **For testing only.** The SDK package includes a *development* build of the IDLive face-capture library.
> The browser console shows "This is a development build of the IDLive Face Capture. Do not use it in production!".
> Ask GBG for a production build before going live.

## Contents

```text
index.html                              the page
css/styles.css                          styles
js/main.js                              page logic: loads the SDK, runs captures, shows output
js/permissions.js                       camera permission check and request
js/inspect.js                           formats SDK payloads for display and download
sdk/smartcapture.esm.js                 GBG Smart Capture SDK, all dependencies included (16 MB)
sdk/smart-capture/SmartCaptureWorker.js SDK worker for document capture, loaded automatically (12 MB)
web.config                              optional IIS / Azure App Service settings
nginx.conf.example                      optional nginx example
tools/sdk-bundle/                       rebuilds sdk/ from GBG's package (not needed for hosting)
```

## Hosting requirements

1. **Serve over HTTPS.** Browsers only allow camera access on HTTPS or `http://localhost`.
2. **Keep the folder structure as it is.** The page can live at any path (for example `/smartcapture/`),
   but `sdk/smart-capture/` must stay next to `sdk/smartcapture.esm.js`.
3. **Serve `.js` files as `text/javascript`.** Most hosts do this by default. IIS needs the included `web.config`.
4. **Turn on gzip or brotli compression.** Without it, the first load is about 28 MB instead of about 11 MB.
   The files in `sdk/` can be cached for a long time.
5. **Content Security Policy:** if your host adds one, it must allow:
   `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self' data: blob: https://cdn.jsdelivr.net https://unpkg.com; media-src blob:; style-src 'self' 'unsafe-inline'`
   - SDK 2.3.0 needs `'unsafe-eval'`: its obfuscated code uses `eval`. Without it the SDK does not load.
   - The SDK's animation library downloads its WASM from `cdn.jsdelivr.net` (backup: `unpkg.com`).
     If those are blocked, capture still works but the document guide animation does not show.
6. **Iframes:** to embed the page in an iframe, the iframe needs `allow="camera"`. For full-screen and
   motion-sensor features, add `fullscreen; accelerometer; gyroscope`. The host should restrict framing with
   `Content-Security-Policy: frame-ancestors <your app's origin>`.

Opening `index.html` directly from disk (`file://`) does not work. Browsers block ES modules and the camera there.

### Loading the SDK from another origin

If an app on one domain imports `sdk/smartcapture.esm.js` from another domain (for example an S3 bucket):

- The SDK's host must send CORS headers (`Access-Control-Allow-Origin`), or the import is blocked.
- **Document capture fails** with "Smart Capture Module failed to init", even with CORS. The SDK starts its
  worker through a `blob:` wrapper and sends its first message before the worker has loaded, so the message is
  lost. This is an SDK bug; report it to GBG. Workarounds, in order of preference:
  1. Serve the SDK from the app's own domain (for example a CloudFront path rule or reverse proxy to the bucket).
  2. Embed this page in an iframe and pass results to the app with `postMessage`.
  3. Run a shim in the app that queues worker messages until the worker has loaded.
- Don't load the SDK through a `blob:` URL or S3 pre-signed URLs: the SDK finds its worker by a path relative to
  its own URL, and both break that.

## Quick local check

From this folder, run any static server, for example:

```bash
npx serve .            # or: python -m http.server 8080
```

Then open `http://localhost:<port>/` in Chrome, Edge or Safari.

## Using the page

1. **Camera permission:** shows the current state. Click *Request camera access*.
   If access is blocked, the page explains how to unblock it.
2. **Capture:** choose *Document* or *Face*, set the options, then *Start capture*. The SDK opens a full-screen
   camera view.
   - The options are the components' public properties. Each starts at the default the bundled SDK reports.
   - *Advanced: extra properties (JSON)* sets anything else, such as texts, hints and accessibility labels,
     and the experimental camera options.
   - The page remembers your choices in this browser. *Reset to SDK defaults* clears them.
   - The `mounted` entry in the event log shows the settings applied to each capture.
3. **SDK output:** shows the captured image, the type outline of the response, and its values.
   *Download JSON* saves the full response.
4. **Event log:** lists every event the SDK sent. Click an entry to see its payload.

## SDK output summary

- **Document `capture`:** `event.detail.captureResponse` contains
  - `imageBase64`: a JPEG data URL with EXIF metadata
  - `imageData`: the raw pixels
  - the quality flags `isGood`, `isSharp`, `isGlareFree` and `isAdequateDpi`
  - `failedChecks[]`
  - `imageWidth` and `imageHeight`
  - `isPortraitOrientation`
  - `metrics`
- **Face `capture`:** `event.detail` contains
  - `imageBase64`: raw base64 with no `data:` prefix
  - `encryptedFile`: a Blob with the liveness payload
- **`failure`:** `event.detail.error` is `{ code, message }`.

## Updating the SDK

`tools/sdk-bundle/` rebuilds `sdk/` from GBG's package. It needs Node 24 or later and npm registry access,
because the SDK's open-source dependencies (`lit`, `piexifjs`, `tslib`, `@lottiefiles/dotlottie-wc`) are not in
GBG's package.

1. Put GBG's package at the repository root as `appsdk.tgz`. Git ignores it.
2. Run:

   ```bash
   cd tools/sdk-bundle
   npm install          # use `npm install ../../appsdk.tgz` instead after replacing the package with a new version
   npm run build        # writes ../../sdk/smartcapture.esm.js and ../../sdk/smart-capture/SmartCaptureWorker.js
   ```

The page reads the version from the bundle, so nothing else needs to change. If a new SDK version changes
its exports, check `js/main.js`.

Do not minify or otherwise re-process the files in `sdk/`. The SDK's obfuscated code has anti-tamper protection
and freezes the page if its code is rewritten. For the same reason `.gitattributes` marks `sdk/` as binary, so git
never converts its line endings.
