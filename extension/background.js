// All network calls to the local server go through here:
// content scripts on https pages cannot reach http://localhost themselves.
const BASE = 'http://localhost:8790';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'api' && typeof msg.path === 'string' && msg.path.startsWith('/api/')) {
    callApi(msg.method || 'GET', msg.path, msg.body).then(sendResponse);
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

// Unpacked install: reload when the files on disk get a new version, so updates need no click.
chrome.alarms.create('check-update', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'check-update') return;
  try {
    const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    if (disk.version !== chrome.runtime.getManifest().version) chrome.runtime.reload();
  } catch {}
});
