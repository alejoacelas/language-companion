const dot = document.getElementById('dot');
const label = document.getElementById('server');

chrome.runtime.sendMessage({ type: 'api', method: 'GET', path: '/api/ping' }, (r) => {
  const ok = r?.ok && r.data?.ok;
  dot.className = 'dot ' + (ok ? 'ok' : 'down');
  label.textContent = ok ? 'Server reachable' : 'Server not reachable (localhost:8790)';
});

chrome.storage.sync.get({ sites: { youtube: true, netflix: true } }, ({ sites }) => {
  for (const site of ['youtube', 'netflix']) {
    const box = document.getElementById(site);
    box.checked = sites[site] !== false;
    box.addEventListener('change', () => {
      sites[site] = box.checked;
      chrome.storage.sync.set({ sites });
    });
  }
});
