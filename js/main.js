import { initPermissions } from './permissions.js';
import { describeShape, toDisplayable, toSerializable, extractImage } from './inspect.js';

const $ = sel => document.querySelector(sel);

// Every event name the two SDK components dispatch (read from the SDK's static *EventName fields at runtime,
// with these as a fallback). Listening to all of them lets you see the full lifecycle, not just `capture`.
const FALLBACK_EVENTS = {
  document: ['open', 'detect', 'capture', 'close', 'userCanceled', 'failure'],
  face: ['beforeInitialize', 'initialize', 'beforeOpen', 'open', 'detect', 'beforeCapture', 'capture', 'close', 'userCanceled', 'failure'],
};

// Public properties of the two SDK components (from the SDK's index.d.ts), shown as on-screen settings.
// Their defaults are read from a fresh component instance once the SDK loads, so the form matches the
// bundled SDK version. `parent` writes the value into an object property instead (cameraDpiStrategy).
const SETTINGS = {
  document: [
    { group: 'Capture mode', key: 'documentType', label: 'Document type', type: 'select', options: ['auto', 'id', 'passport'] },
    { group: 'Capture mode', key: 'enableAutoCapture', label: 'Start in auto-capture mode', type: 'bool' },
    { group: 'Capture mode', key: 'enableTapToCapture', label: 'Allow tap-to-capture (manual)', type: 'bool' },
    { group: 'Capture mode', key: 'showToggle', label: 'Show auto/manual toggle', type: 'bool' },
    { group: 'Timing', key: 'toggleAutoCaptureDelay', label: 'Show toggle after', type: 'number', unit: 'ms' },
    { group: 'Timing', key: 'enableAutoCaptureTimeout', label: 'Auto-capture timeout', type: 'bool' },
    { group: 'Timing', key: 'autoCaptureTimeout', label: 'Auto-capture times out after', type: 'number', unit: 'ms' },
    { group: 'Timing', key: 'successTime', label: '"Photo taken" overlay shown for', type: 'number', unit: 'ms' },
    { group: 'Screens', key: 'showPreviewScreen', label: 'Review/retake screen after capture', type: 'bool' },
    { group: 'Screens', key: 'showBackOfDocumentAnimation', label: 'Back-of-document animation', type: 'bool' },
    { group: 'Screens', key: 'showHelpIcon', label: 'Help icon', type: 'bool' },
    { group: 'Screens', key: 'showBackButton', label: 'Back button', type: 'bool' },
    { group: 'Camera & security', key: 'ios17Zoom', parent: 'cameraDpiStrategy', label: 'iOS 17 camera zoom', type: 'select', options: ['', '1', '1.3', '1.6'], numeric: true },
    { group: 'Camera & security', key: 'enableInjectionAttackDetection', label: 'Injection attack detection signals', type: 'bool',
      hint: 'Adds captureResponse.metrics.iadSignals. May ask for motion-sensor permission.' },
  ],
  face: [
    { group: 'Capture', key: 'showPreviewScreen', label: 'Review/retake screen after capture', type: 'bool' },
    { group: 'Capture', key: 'showBackButton', label: 'Back button', type: 'bool' },
    { group: 'Capture', key: 'enableOrientationLock', label: 'Lock to portrait orientation', type: 'bool' },
    { group: 'Timing', key: 'initializationTimeoutDuration', label: 'Initialisation times out after', type: 'number', unit: 'ms' },
    { group: 'Timing', key: 'autoCaptureTimeoutDuration', label: 'Auto-capture times out after', type: 'number', unit: 'ms' },
  ],
};

const EXTRA_HINT = {
  document: '{ "texts": { "autoCaptureText": "…" }, "hints": { "fixGlareHint": { "title": "…", "description": "…" } }, "cameraDpiStrategy": { "samsungZoom": 1.75 } }',
  face: '{ "texts": { "faceInstruction": "…" }, "hints": { "faceNotFoundHint": "…" }, "uiTexts": { "step1Title": "…" } }',
};

const STORAGE_KEY = 'sc-harness-settings-v1';

const state = {
  sdk: null,
  mode: 'document',
  element: null,
  lastCapture: null, // { mode, eventName, detail, receivedAt }
  defaults: {}, // { document: {key: value}, face: {...} } read from the SDK
};

// ---------- SDK loading ----------

async function loadSdk() {
  const status = $('#capture-status');
  try {
    // Load the self-contained SDK bundle from ./sdk/ at runtime (no npm/node_modules needed).
    // Importing it registers <live-document-camera> and <live-face-camera>.
    // Resolved against the page URL so the folder can be hosted under any path.
    const sdkUrl = new URL('sdk/smartcapture.esm.js', document.baseURI).href;
    state.sdk = await import(sdkUrl);
    $('#sdk-version').textContent = `SDK @gbgplc/smartcapture-web ${state.sdk.version} loaded`;
    $('#sdk-version').dataset.state = 'ok';
    status.textContent = state.sdk.isLiveCaptureSupported?.() === false
      ? 'SDK loaded, but it reports live capture is NOT supported in this browser.'
      : 'SDK loaded. Grant camera permission, then start a capture.';
    logEvent('sdk', 'loaded', { exports: Object.keys(state.sdk).sort() });
    initSettings();
  } catch (err) {
    $('#sdk-version').textContent = 'SDK failed to load';
    $('#sdk-version').dataset.state = 'error';
    status.textContent = `SDK failed to load: ${err.message}`;
    logEvent('sdk', 'loadError', { message: err.message, stack: err.stack });
    console.error(err);
  }
  updateButtons();
}

function eventNamesFor(mode) {
  const cls = mode === 'document' ? state.sdk?.LiveDocumentCamera : state.sdk?.LiveFaceCamera;
  if (!cls) return FALLBACK_EVENTS[mode];
  const names = Object.getOwnPropertyNames(cls)
    .filter(k => k.endsWith('EventName'))
    .map(k => cls[k])
    .filter(v => typeof v === 'string');
  return names.length ? [...new Set(names)] : FALLBACK_EVENTS[mode];
}

// ---------- Capture lifecycle ----------

function startCapture() {
  closeCapture();
  const mode = state.mode;
  const el = document.createElement(mode === 'document' ? 'live-document-camera' : 'live-face-camera');

  let props;
  try {
    props = readSettings(mode);
  } catch (err) {
    $('#capture-status').textContent = err.message;
    return;
  }
  if (mode === 'face') {
    const deviceId = $('#camera-select').value;
    if (deviceId) props.deviceId = deviceId;
  }
  Object.assign(el, props);

  // The SDK's own overlay/extra events are useful too, so listen for them alongside the declared ones.
  const names = [...eventNamesFor(mode), 'overlay-shown', 'overlay-hidden'];
  for (const name of names) {
    el.addEventListener(name, e => onSdkEvent(mode, name, e));
  }

  $('#sdk-host').appendChild(el);
  state.element = el;
  logEvent(mode, 'mounted', { tag: el.tagName.toLowerCase(), settings: props, listeningTo: names });

  // Both components open/close their camera from the `isOpen` property.
  // The face component wraps IDLive, which drops openCamera() calls made before its
  // `initialize` event, so only flip isOpen once that fires. The document component
  // just needs Lit's first render to have happened.
  if (mode === 'face') {
    el.addEventListener('initialize', () => { if (state.element === el) el.isOpen = true; }, { once: true });
  } else {
    requestAnimationFrame(() => { el.isOpen = true; });
  }
  $('#capture-status').textContent = `${mode} camera opening…`;
  updateButtons();
}

function closeCapture() {
  const el = state.element;
  if (!el) return;
  el.isOpen = false;
  // Give the component a moment to stop its media tracks before removal.
  setTimeout(() => el.remove(), 300);
  state.element = null;
  updateButtons();
}

function onSdkEvent(mode, name, e) {
  const detail = e.detail;
  const isDetect = name === 'detect';
  const logDetect = mode === 'document' ? $('#log-detect').checked : $('#log-detect-face').checked;

  if (!isDetect || logDetect) logEvent(mode, name, detail);
  if (isDetect) updateDetectStatus(mode, detail);

  switch (name) {
    case 'capture':
      state.lastCapture = { mode, eventName: name, detail, receivedAt: new Date().toISOString() };
      renderOutput();
      $('#capture-status').textContent = `${mode} captured ✔`;
      // Face component keeps its overlay up until closed; close it so the output is visible.
      if (mode === 'face') setTimeout(closeCapture, 1500);
      break;
    case 'failure':
      $('#capture-status').textContent = `${mode} failure: ${detail?.error?.message ?? JSON.stringify(detail)}`;
      break;
    case 'userCanceled':
      $('#capture-status').textContent = `${mode} capture cancelled by user.`;
      closeCapture();
      break;
    case 'close':
      if (state.element && state.lastCapture?.mode === mode) closeCapture();
      break;
  }
}

function updateDetectStatus(mode, detail) {
  let text;
  if (mode === 'document') {
    const camState = state.sdk?.CameraState?.[detail?.cameraState] ?? detail?.cameraState;
    const failed = detail?.detectResponse?.failedChecks?.join(', ');
    text = `detect → cameraState=${camState}${failed ? ` · failedChecks: ${failed}` : ''}`;
  } else {
    const errors = detail?.errors;
    text = `detect → ${Array.isArray(errors) && errors.length ? errors.join(', ') : 'face OK'}`;
  }
  $('#capture-status').textContent = text;
}

// ---------- SDK settings ----------

function initSettings() {
  for (const mode of Object.keys(SETTINGS)) {
    const probe = document.createElement(mode === 'document' ? 'live-document-camera' : 'live-face-camera');
    state.defaults[mode] = Object.fromEntries(SETTINGS[mode].map(o => [o.key, o.parent ? probe[o.parent]?.[o.key] : probe[o.key]]));
    renderSettings(mode);
    const host = $(`[data-settings="${mode}"]`);
    host.addEventListener('change', onSettingsChange);
    host.addEventListener('input', onSettingsChange);
  }
  applyValues(loadSaved());
  validateSettings();
  $('#settings-reset').disabled = false;
}

function renderSettings(mode) {
  const host = $(`[data-settings="${mode}"]`);
  host.innerHTML = '';
  const groups = new Map();
  for (const opt of SETTINGS[mode]) {
    if (!groups.has(opt.group)) {
      const details = document.createElement('details');
      details.open = groups.size === 0;
      details.innerHTML = `<summary>${opt.group}</summary>`;
      host.appendChild(details);
      groups.set(opt.group, details);
    }
    groups.get(opt.group).appendChild(settingField(mode, opt));
  }
  // Anything the form doesn't cover (texts, hints, aria labels, experimental camera options) as raw JSON.
  const adv = document.createElement('details');
  adv.innerHTML = `<summary>Advanced: extra properties (JSON)</summary>
    <label class="field">
      <span class="hint">Set on the component as-is, after the options above. Object values are merged one level deep.</span>
      <textarea id="opt-${mode}-extra" spellcheck="false" placeholder='${EXTRA_HINT[mode]}'></textarea>
    </label>`;
  host.appendChild(adv);
}

function settingField(mode, opt) {
  const id = `opt-${mode}-${opt.key}`;
  const def = state.defaults[mode][opt.key];
  const wrap = document.createElement('label');
  if (opt.type === 'bool') {
    wrap.className = 'check';
    wrap.innerHTML = `<input type="checkbox" id="${id}" /> <span>${opt.label}</span>`;
    wrap.querySelector('input').checked = !!def;
  } else {
    wrap.className = 'field';
    const control = opt.type === 'select'
      ? `<select id="${id}">${opt.options.map(v => `<option value="${v}">${v === '' ? 'SDK default' : v}</option>`).join('')}</select>`
      : `<div class="unit"><input type="number" inputmode="numeric" min="0" step="500" id="${id}" placeholder="${def ?? ''}" /><span>${opt.unit}</span></div>`;
    wrap.innerHTML = `<span>${opt.label}</span>${control}`;
    const input = wrap.querySelector('input, select');
    input.value = def ?? '';
  }
  if (opt.hint) wrap.insertAdjacentHTML('beforeend', `<span class="hint">${opt.hint}</span>`);
  return wrap;
}

function readSettings(mode) {
  const props = {};
  for (const opt of SETTINGS[mode]) {
    const input = $(`#opt-${mode}-${opt.key}`);
    let value;
    if (opt.type === 'bool') value = input.checked;
    else if (input.value === '') continue; // leave the SDK default in place
    else value = opt.type === 'number' || opt.numeric ? Number(input.value) : input.value;
    if (opt.parent) props[opt.parent] = { ...props[opt.parent], [opt.key]: value };
    else props[opt.key] = value;
  }
  const extra = readExtra(mode);
  for (const [key, value] of Object.entries(extra)) {
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    props[key] = isObj(value) && isObj(props[key]) ? { ...props[key], ...value } : value;
  }
  return props;
}

function readExtra(mode) {
  const area = $(`#opt-${mode}-extra`);
  const text = area.value.trim();
  area.closest('.field').classList.remove('invalid');
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('must be a JSON object');
    return value;
  } catch (err) {
    area.closest('.field').classList.add('invalid');
    throw new Error(`Extra properties (JSON) for ${mode}: ${err.message}`);
  }
}

// Combinations the SDK accepts but that won't behave as the tester probably expects.
function validateSettings() {
  const warnings = [];
  const v = key => $(`#opt-document-${key}`);
  const num = key => Number(v(key).value || state.defaults.document[key]);
  if (!v('enableAutoCapture').checked && !v('enableTapToCapture').checked) {
    warnings.push('Document: auto-capture and tap-to-capture are both off, so the user has no way to capture.');
  }
  if (v('enableAutoCaptureTimeout').checked && num('autoCaptureTimeout') <= num('toggleAutoCaptureDelay')) {
    warnings.push('Document: the auto-capture timeout should be longer than the toggle delay.');
  }
  for (const mode of Object.keys(SETTINGS)) {
    try { readExtra(mode); } catch (err) { warnings.push(err.message); }
  }
  const box = $('#settings-warning');
  box.hidden = !warnings.length;
  box.textContent = warnings.join(' ');
}

function onSettingsChange() {
  validateSettings();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collectValues()));
  } catch { /* storage unavailable: settings just won't be remembered */ }
}

// Raw form values (not SDK props), so they can be saved and restored exactly.
function collectValues() {
  const values = {};
  document.querySelectorAll('.settings input, .settings select, .settings textarea').forEach(el => {
    values[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return values;
}

function applyValues(values) {
  for (const [id, value] of Object.entries(values)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
  }
}

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function resetSettings() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  for (const mode of Object.keys(SETTINGS)) renderSettings(mode);
  validateSettings();
  flash('#settings-reset', 'Reset ✔');
}

// ---------- Output rendering ----------

async function renderOutput() {
  const cap = state.lastCapture;
  if (!cap) return;
  $('#output-empty').hidden = true;
  $('#output').hidden = false;

  const envelope = { mode: cap.mode, event: cap.eventName, receivedAt: cap.receivedAt, detail: cap.detail };
  $('#output-shape').textContent = describeShape(envelope);
  $('#output-json').textContent = JSON.stringify(await toDisplayable(envelope), null, 2);

  const img = await extractImage(cap.detail);
  const imgEl = $('#output-image');
  if (img) {
    imgEl.src = img.src;
    imgEl.onload = () => {
      $('#output-image-meta').textContent = `${img.source} · ${imgEl.naturalWidth}×${imgEl.naturalHeight}px · ~${Math.round(img.bytes / 1024)} KB`;
    };
    state.lastCapture.image = img;
  } else {
    imgEl.removeAttribute('src');
    $('#output-image-meta').textContent = 'No image found in payload.';
  }
  updateButtons();
}

async function copyJson() {
  const text = JSON.stringify(await toSerializable(state.lastCapture.detail), null, 2);
  await navigator.clipboard.writeText(text);
  flash('#copy-json', 'Copied');
}

async function downloadJson() {
  const cap = state.lastCapture;
  const payload = { mode: cap.mode, event: cap.eventName, receivedAt: cap.receivedAt, detail: await toSerializable(cap.detail) };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${cap.mode}-capture-${Date.now()}.json`);
}

function downloadImage() {
  const img = state.lastCapture?.image;
  if (!img) return;
  const a = document.createElement('a');
  a.href = img.src;
  a.download = `${state.lastCapture.mode}-capture-${Date.now()}.jpg`;
  a.click();
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Event log ----------

function logEvent(source, name, detail) {
  const li = document.createElement('li');
  li.className = `log-item ${name === 'failure' || name.toLowerCase().includes('error') ? 'err' : ''} ${name === 'capture' ? 'ok' : ''}`;
  const time = new Date().toLocaleTimeString([], { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.innerHTML = `<span class="time">${time}</span> <span class="src">${source}</span> <strong>${name}</strong>`;
  details.appendChild(summary);

  const pre = document.createElement('pre');
  pre.className = 'code';
  pre.textContent = detail === undefined ? '(no detail)' : '…';
  details.appendChild(pre);
  // Serialize lazily — payloads can contain large ImageData/Blob values.
  details.addEventListener('toggle', async () => {
    if (details.open && pre.textContent === '…') {
      pre.textContent = describeShape(detail) + '\n\n' + JSON.stringify(await toDisplayable(detail), null, 2);
    }
  }, { once: false });

  li.appendChild(details);
  const log = $('#event-log');
  log.prepend(li);
  while (log.children.length > 300) log.lastChild.remove();
}

// ---------- UI glue ----------

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
  document.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== mode; });
}

function updateButtons() {
  const ready = !!state.sdk;
  $('#capture-start').disabled = !ready;
  $('#capture-stop').disabled = !state.element;
  const hasCapture = !!state.lastCapture;
  $('#copy-json').disabled = !hasCapture;
  $('#download-json').disabled = !hasCapture;
  $('#download-image').disabled = !state.lastCapture?.image;
}

function flash(sel, text) {
  const el = $(sel);
  const old = el.textContent;
  el.textContent = text;
  setTimeout(() => { el.textContent = old; }, 1200);
}

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));
$('#capture-start').addEventListener('click', startCapture);
$('#capture-stop').addEventListener('click', closeCapture);
$('#copy-json').addEventListener('click', copyJson);
$('#download-json').addEventListener('click', downloadJson);
$('#download-image').addEventListener('click', downloadImage);
$('#log-clear').addEventListener('click', () => { $('#event-log').innerHTML = ''; });
$('#settings-reset').addEventListener('click', resetSettings);

initPermissions({ onLog: (name, detail) => logEvent('permission', name, detail) });
loadSdk();
