// Shared helpers for every page: DOM, API, toasts, key hints, audio and German word rendering.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json) { init.method = init.method || "POST"; init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(opts.json); }
  const r = await fetch(path, init);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export function toast(msg, ms = 2000) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms); }
export function fail(e) { console.error(e); toast("Error: " + e.message, 5000); }

// The footer lists the keys of the current page: keys([["Space", "play"], ...]).
export function keys(list) { $("#keys").innerHTML = list.map(([k, l]) => `<span><kbd>${esc(k)}</kbd> ${esc(l)}</span>`).join(""); }

// The current page's key handlers. Pages set ui.onKey / ui.onKeyUp; the router clears them on navigation.
export const ui = { onKey: null, onKeyUp: null };

// ---------- audio ----------
let current = null;
let playToken = 0;
export function stopAudio() { playToken++; current?.pause(); current = null; }
const ttsUrl = (text, lang, speed = 1) => `/api/tts?text=${encodeURIComponent(text)}&lang=${lang}${speed !== 1 ? `&speed=${speed}` : ""}`;

function playUrl(url, token) {
  return new Promise(res => {
    if (token !== playToken) return res(false);
    const a = new Audio(url); current = a;
    a.onended = () => res(token === playToken);
    a.onerror = () => res(false);
    a.play().catch(() => res(false));
  });
}

// Speak text with the local voice for its language; speed below 1 is a slower, re-synthesised reading.
export function playTTS(text, lang = "de", speed = 1) { stopAudio(); return playUrl(ttsUrl(text, lang, speed), playToken); }

// Split an English line with *German* words into [lang, text] segments.
export function segments(line) {
  if (line.lang === "de") return [["de", line.text]];
  const out = [];
  line.text.split(/\*([^*]+)\*/).forEach((s, i) => { if (s.trim()) out.push([i % 2 ? "de" : "en", s.trim()]); });
  return out;
}

// Play a line, switching voices for German words inside English narration. Resolves true if it played to the end.
// `speed` below 1 slows the German parts; narration stays at normal speed.
export async function playLine(line, { speed = 1 } = {}) {
  stopAudio(); const token = playToken;
  const segs = segments(line).map(([lang, text]) => [lang, text, lang === "de" ? speed : 1]);
  segs.forEach(([lang, text, sp]) => fetch(ttsUrl(text, lang, sp)).catch(() => {}));  // warm the cache in parallel
  for (const [lang, text, sp] of segs) if (!(await playUrl(ttsUrl(text, lang, sp), token))) return false;
  return true;
}

// ---------- German text ----------
const WORD = /([\p{L}\p{M}ß'’-]+)/u;
export const tokens = t => t.split(WORD);

// Render German text with clickable words; words whose form is in `newForms` are highlighted as new.
export function germanHTML(text, newForms = new Set()) {
  return tokens(text).map((t, k) => k % 2 ? `<span class="w${newForms.has(t.toLowerCase()) ? " new" : ""}" lang="de">${esc(t)}</span>` : esc(t)).join("");
}

// Render English narration, turning *German* spans into clickable German words.
export function narrationHTML(text, newForms = new Set()) {
  return text.split(/\*([^*]+)\*/).map((s, i) => i % 2 ? `<span class="de-inline">${germanHTML(s, newForms)}</span>` : esc(s)).join("");
}

export const newFormsOf = item => new Set((item?.lesson?.new_words || []).flatMap(w => w.forms || []));

export const fmtPct = x => x == null ? "–" : Math.round(x * 100) + "%";
