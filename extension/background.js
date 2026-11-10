// All network calls to the local server (and Netflix subtitle files) go through here:
// content scripts on https pages cannot reach http://localhost themselves.
const BASE = 'http://localhost:8790';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'api' && typeof msg.path === 'string' && msg.path.startsWith('/api/')) {
    callApi(msg.method || 'GET', msg.path, msg.body).then(sendResponse);
    return true;
  }
  if (msg?.type === 'fetchText' && isSubtitleHost(msg.url)) {
    fetch(msg.url)
      .then(async (r) => sendResponse(r.ok ? { ok: true, text: await r.text() } : { ok: false, error: `HTTP ${r.status}` }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

async function callApi(method, path, body) {
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => null);
    return r.ok ? { ok: true, data } : { ok: false, error: `HTTP ${r.status}`, data };
  } catch (err) {
    return { ok: false, error: 'Server not reachable at ' + BASE };
  }
}

function isSubtitleHost(url) {
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.nflxvideo.net') || host.endsWith('.nflxso.net');
  } catch {
    return false;
  }
}
