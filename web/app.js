// Sprechstunde: routing, the 15-minute block (review, new words, read, speak, wrap-up) and key dispatch.
import { $, api, fail, toast, ui, stopAudio } from "/lib.js";
import { showHome } from "/pages/home.js";
import { showReview } from "/pages/review.js";
import { showMeet } from "/pages/meet.js";
import { showReader } from "/pages/reader.js";
import { showSpeak, stopCoach } from "/pages/speak.js";
import { showWrap } from "/pages/wrap.js";

const view = $("#view");
export const STEPS = [["review", "Review", 180], ["meet", "New words", 60], ["read", "Read", 360], ["speak", "Speak", 240], ["wrap", "Wrap-up", 60]];
let block = null;   // { id, plan, cards, item, step, stepStart, start }

setInterval(() => {
  if (!block || block.step === "wrap") return;
  const [, , budget] = STEPS.find(s => s[0] === block.step);
  const left = budget - Math.round((Date.now() - block.stepStart) / 1000);
  const total = Math.round((Date.now() - block.start) / 1000);
  const c = $("#clock");
  c.hidden = false; c.classList.toggle("over", left < 0);
  const f = s => `${Math.floor(Math.abs(s) / 60)}:${String(Math.abs(s) % 60).padStart(2, "0")}`;
  c.textContent = `${left < 0 ? "+" : ""}${f(left)} · ${f(total)} of 15:00`;
}, 1000);

function renderSteps() {
  const n = $("#steps");
  n.hidden = !block;
  if (!block) { $("#clock").hidden = true; return; }
  const idx = STEPS.findIndex(s => s[0] === block.step);
  n.innerHTML = STEPS.map(([k, l, b], i) => `<button class="${i < idx ? "done" : i === idx ? "on" : ""}" data-step="${k}" title="Go to ${l}">${l} ${Math.round(b / 60) || 1}m</button>`).join("");
  n.querySelectorAll("button").forEach(b => b.onclick = () => goStep(b.dataset.step));
}

// What a page needs to take part in a block. Outside a block, ctx.block is null and ctx.next is undefined.
const ctx = () => block ? { block, next: nextStep, exit: exitBlock, startNext: () => { block = null; renderSteps(); startBlock(); } } : { block: null };

function goStep(step) {
  if (!block) return;
  resetPage();
  block.step = step; block.stepStart = Date.now();
  api("/api/event", { json: { type: "step_started", block_id: block.id, item_id: block.item?.id, payload: { step } } }).catch(() => {});
  renderSteps();
  ({ review: () => showReview(view, ctx()), meet: () => showMeet(view, block.item, ctx()), read: () => showReader(view, block.item, ctx()),
     speak: () => showSpeak(view, block.item, ctx()), wrap: () => showWrap(view, block.item, ctx()) })[step]();
}
function nextStep() { const i = STEPS.findIndex(s => s[0] === block.step); if (i < STEPS.length - 1) goStep(STEPS[i + 1][0]); else exitBlock(); }
function exitBlock() { block = null; renderSteps(); location.hash = "home"; route(); }

export async function startBlock() {
  view.innerHTML = `<div class="card"><p>Getting your lesson ready… <span class="muted">(writing a new one takes about a minute)</span></p></div>`;
  try {
    const r = await api("/api/block/start", { method: "POST" });
    block = { id: r.block_id, plan: r.plan, cards: r.cards, item: r.item, start: Date.now() };
    history.replaceState(null, "", "#block");
    goStep(r.cards.length ? "review" : "meet");
  } catch (e) { fail(e); route(); }
}

function resetPage() { ui.onKey = null; ui.onKeyUp = null; $("#pop").hidden = true; stopAudio(); stopCoach(); }

async function route() {
  const [r, id, sub] = location.hash.slice(1).split("/");
  if (r === "block" && block) return;
  resetPage();
  if (r !== "block") { block = null; renderSteps(); }
  try {
    if (r === "review") {
      const cards = await api("/api/cards/due?limit=50");
      return showReview(view, { block: null, cards, next: () => location.hash = "home" });
    }
    if (r === "read" && id) return showReader(view, await api(`/api/item/${id}`), ctx());
    if (r === "speak" && id) return showSpeak(view, await api(`/api/item/${id}`), ctx(), sub);
  } catch (e) { fail(e); }
  showHome(view, { startBlock });
}
addEventListener("hashchange", route);
addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (!$("#pop").hidden && $("#pop").onkey && $("#pop").onkey(e) !== false) return;
  if (e.key === "Escape" && !$("#pop").hidden) { $("#pop").hidden = true; return; }
  ui.onKey?.(e);
});
addEventListener("keyup", e => ui.onKeyUp?.(e));
route();
