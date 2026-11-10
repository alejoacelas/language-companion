// Sends the extension's real messages through background.js to a running server.
// Run: node extension/dev/check_server.mjs [port]   (default 8790; use a copy of the DB: lookup/ignore/watch write)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const port = process.argv[2] || '8790';
let listener;
const chrome = { runtime: { onMessage: { addListener: (fn) => (listener = fn) } } };
const src = readFileSync(new URL('../background.js', import.meta.url), 'utf8').replace(':8790', ':' + port);
vm.runInNewContext(src, { chrome, fetch, URL, JSON, String, console });

// JSON round trip: replies are built in the vm realm, whose Object prototype differs.
const send = (msg) => new Promise((resolve) => assert.equal(listener(msg, {}, (r) => resolve(JSON.parse(JSON.stringify(r)))), true));
const api = (method, path, body) => send({ type: 'api', method, path, body });

const ping = await api('GET', '/api/ping');
assert.deepEqual(ping, { ok: true, data: { ok: true } });
console.log('ping          ', JSON.stringify(ping.data));

const sentence = 'Die Regierung hat gestern ein neues Gesetz beschlossen.';
const status = await api('POST', '/api/words/status', { tokens: ['Die', 'Regierung', 'gestern', 'beschlossen'] });
assert.ok(status.ok, status.error);
for (const info of Object.values(status.data.tokens)) assert.ok(['new', 'learning', 'known', 'ignored'].includes(info.status));
console.log('words/status  ', JSON.stringify(status.data.tokens));

const look = await api('POST', '/api/lookup', { word: 'beschlossen', sentence, source: 'youtube', external_id: 'devcheck', title: 'dev check' });
assert.ok(look.ok, look.error);
for (const k of ['lemma', 'gloss', 'article', 'contextual', 'status', 'card_added']) assert.ok(k in look.data, 'lookup missing ' + k);
console.log('lookup        ', JSON.stringify(look.data));

const watch = await api('POST', '/api/watch', {
  source: 'youtube', external_id: 'devcheck', title: 'dev check', url: 'https://www.youtube.com/watch?v=devcheck', seconds: 30,
  sentences: [{ de: sentence, start: 0, end: 3.5 }],
});
assert.deepEqual(watch, { ok: true, data: { ok: true } });
console.log('watch         ', JSON.stringify(watch.data));

const ign = await api('POST', '/api/ignore', { lemma: look.data.lemma });
assert.deepEqual(ign, { ok: true, data: { ok: true } });
const after = await api('POST', '/api/words/status', { tokens: ['beschlossen'] });
assert.equal(after.data.tokens.beschlossen.status, 'ignored');
console.log('ignore        ', look.data.lemma, '-> status now', after.data.tokens.beschlossen.status);

assert.equal(listener({ type: 'api', path: '/etc/passwd' }, {}, () => {}), undefined); // non-/api/ paths are refused
console.log('\nall server calls ok');
