// Camera permission handling: query state, request access with a clear prompt,
// explain what to do when blocked, and list available cameras.

const $ = sel => document.querySelector(sel);

const HELP = {
  insecure:
    'Camera access requires a secure context. Open this page on http://localhost, or run `npm run dev:https` to test from another device.',
  unsupported: 'This browser does not expose navigator.mediaDevices.getUserMedia.',
  denied:
    'Camera access is blocked. Click the camera/lock icon in the address bar, set Camera to "Allow", then press Re-check. On iOS: Settings › Safari › Camera. On Android: site settings in Chrome.',
  NotFoundError: 'No camera was found on this device.',
  NotReadableError: 'The camera is in use by another application (Teams, Zoom, another tab…). Close it and try again.',
  OverconstrainedError: 'The selected camera cannot satisfy the requested constraints.',
};

let onLog = () => {};
let permissionStatus = null;

export async function initPermissions(opts = {}) {
  onLog = opts.onLog ?? onLog;
  $('#perm-request').addEventListener('click', requestAccess);
  $('#perm-recheck').addEventListener('click', refresh);

  if (!window.isSecureContext) return setStatus('insecure', HELP.insecure);
  if (!navigator.mediaDevices?.getUserMedia) return setStatus('unsupported', HELP.unsupported);

  // Permissions API gives us the state without prompting, and live updates when the user changes it.
  // Firefox/Safari may not support the 'camera' name — fall back to probing enumerateDevices labels.
  try {
    permissionStatus = await navigator.permissions.query({ name: 'camera' });
    permissionStatus.onchange = () => {
      onLog('stateChange', { state: permissionStatus.state });
      refresh();
    };
  } catch {
    permissionStatus = null;
  }
  await refresh();
}

async function refresh() {
  const state = await currentState();
  if (state === 'granted') {
    setStatus('granted');
    await listCameras();
  } else if (state === 'denied') {
    setStatus('denied', HELP.denied);
  } else {
    setStatus('prompt', 'Click "Request camera access" — your browser will ask for permission.');
  }
  return state;
}

async function currentState() {
  if (permissionStatus) return permissionStatus.state;
  // Without the Permissions API, labelled devices imply a previous grant.
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  return devices.some(d => d.kind === 'videoinput' && d.label) ? 'granted' : 'prompt';
}

export async function requestAccess() {
  const btn = $('#perm-request');
  btn.disabled = true;
  setStatus('requesting', 'Waiting for your response to the browser prompt…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    onLog('granted', { label: track?.label, settings: track?.getSettings?.() });
    await showPreview(stream);
    setStatus('granted');
    await listCameras();
  } catch (err) {
    onLog('requestError', { name: err.name, message: err.message });
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      setStatus('denied', HELP.denied);
    } else {
      setStatus('error', HELP[err.name] ?? `${err.name}: ${err.message}`);
    }
  } finally {
    btn.disabled = false;
  }
}

// Show a short live preview so the user can confirm the camera works, then release it
// so the SDK can open its own stream (many devices only allow one consumer at a time).
async function showPreview(stream) {
  const video = $('#perm-preview');
  video.srcObject = stream;
  video.hidden = false;
  await video.play().catch(() => {});
  setTimeout(() => {
    stream.getTracks().forEach(t => t.stop());
    video.srcObject = null;
    video.hidden = true;
  }, 2500);
}

async function listCameras() {
  const select = $('#camera-select');
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  select.innerHTML = '';
  select.appendChild(new Option('Default (let the SDK choose)', ''));
  devices.forEach((d, i) => select.appendChild(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  select.disabled = devices.length === 0;
  onLog('devices', devices.map(d => ({ label: d.label, deviceId: d.deviceId, groupId: d.groupId })));
}

function setStatus(state, help) {
  const pill = $('#perm-status');
  pill.textContent = state;
  pill.dataset.state = { granted: 'ok', denied: 'error', insecure: 'error', unsupported: 'error', error: 'error' }[state] ?? 'warn';
  const helpEl = $('#perm-help');
  helpEl.hidden = !help;
  helpEl.textContent = help ?? '';
  $('#perm-request').hidden = state === 'granted';
}
