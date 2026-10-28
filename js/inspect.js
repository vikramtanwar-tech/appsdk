// Helpers to make SDK payloads inspectable. Payloads can contain ImageData, Blob,
// ArrayBuffer/typed arrays and multi-MB base64 strings, none of which JSON.stringify handles well.

const MAX_STRING = 160;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof ImageData !== 'undefined' && v instanceof ImageData) return 'ImageData';
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v instanceof File ? 'File' : 'Blob';
  if (v instanceof ArrayBuffer) return 'ArrayBuffer';
  if (ArrayBuffer.isView(v)) return v.constructor.name;
  if (v instanceof Date) return 'Date';
  return typeof v;
}

/** TypeScript-ish description of a value's shape, e.g. `{ imageBase64: string (data:image/jpeg, 412 KB) }`. */
export function describeShape(value, indent = '') {
  const t = typeOf(value);
  const next = indent + '  ';
  switch (t) {
    case 'object': {
      const keys = Object.keys(value);
      if (!keys.length) return '{}';
      return '{\n' + keys.map(k => `${next}${k}: ${describeShape(value[k], next)}`).join(';\n') + `;\n${indent}}`;
    }
    case 'array':
      if (!value.length) return 'unknown[]  // empty';
      return `Array<${describeShape(value[0], indent)}>  // length ${value.length}`;
    case 'string': {
      const m = /^data:([^;,]+)[;,]/.exec(value);
      if (m) return `string  // data URL, ${m[1]}, ${kb(value.length)}`;
      if (value.length > MAX_STRING && /^[A-Za-z0-9+/=\s]+$/.test(value)) return `string  // base64, ${kb(value.length)}`;
      return 'string';
    }
    case 'ImageData':
      return `ImageData  // ${value.width}×${value.height}, ${kb(value.data.byteLength)}`;
    case 'Blob':
    case 'File':
      return `${t}  // type "${value.type || 'unknown'}", ${kb(value.size)}`;
    case 'ArrayBuffer':
      return `ArrayBuffer  // ${kb(value.byteLength)}`;
    default:
      if (ArrayBuffer.isView(value)) return `${t}  // ${kb(value.byteLength)}`;
      return t;
  }
}

/** Copy of the value that is readable on screen: long strings and binary are summarised. */
export async function toDisplayable(value) {
  return walk(value, async (v, t) => {
    if (t === 'string' && v.length > MAX_STRING) return `${v.slice(0, 80)}… [${v.length} chars total]`;
    if (t === 'ImageData') return { __type: 'ImageData', width: v.width, height: v.height, bytes: v.data.byteLength };
    if (t === 'Blob' || t === 'File') return { __type: t, type: v.type, size: v.size };
    if (t === 'ArrayBuffer') return { __type: 'ArrayBuffer', byteLength: v.byteLength };
    if (ArrayBuffer.isView(v)) return { __type: t, byteLength: v.byteLength };
    return undefined;
  });
}

/** Full-fidelity JSON-safe copy: binary becomes base64 so nothing is lost. */
export async function toSerializable(value) {
  return walk(value, async (v, t) => {
    if (t === 'ImageData') return { __type: 'ImageData', width: v.width, height: v.height, pngDataUrl: imageDataToDataUrl(v, 'image/png') };
    if (t === 'Blob' || t === 'File') return { __type: t, type: v.type, size: v.size, base64: bytesToBase64(new Uint8Array(await v.arrayBuffer())) };
    if (t === 'ArrayBuffer') return { __type: 'ArrayBuffer', byteLength: v.byteLength, base64: bytesToBase64(new Uint8Array(v)) };
    if (ArrayBuffer.isView(v)) return { __type: t, byteLength: v.byteLength, base64: bytesToBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    return undefined;
  });
}

async function walk(value, leaf, seen = new WeakSet()) {
  const t = typeOf(value);
  const replaced = await leaf(value, t);
  if (replaced !== undefined) return replaced;
  if (t === 'array') return Promise.all(value.map(v => walk(v, leaf, seen)));
  if (t === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await walk(v, leaf, seen);
    return out;
  }
  if (t === 'function') return '[function]';
  return value;
}

/**
 * Find the captured image in either component's payload.
 *  - document: detail.captureResponse.imageBase64 (data URL, JPEG with EXIF) or .imageData
 *  - face:     detail.imageBase64 (raw base64, no data: prefix)
 */
export async function extractImage(detail) {
  const candidates = [
    ['captureResponse.imageBase64', detail?.captureResponse?.imageBase64],
    ['imageBase64', detail?.imageBase64],
  ];
  for (const [source, v] of candidates) {
    if (typeof v === 'string' && v.length) {
      const src = v.startsWith('data:') ? v : `data:image/jpeg;base64,${v}`;
      return { source, src, bytes: Math.round((src.length - src.indexOf(',') - 1) * 0.75) };
    }
  }
  const imageData = detail?.captureResponse?.imageData;
  if (imageData instanceof ImageData) {
    const src = imageDataToDataUrl(imageData, 'image/jpeg');
    return { source: 'captureResponse.imageData', src, bytes: Math.round(src.length * 0.75) };
  }
  return null;
}

function imageDataToDataUrl(imageData, type) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return canvas.toDataURL(type, 0.92);
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function kb(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}
