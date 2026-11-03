"""Download DW audio courses whose episodes mix English narration with German dialogue.

For each episode this saves the learngerman.dw.com article HTML, the English-edition
manuscript PDF and its extracted text under data/raw/<series>/, and the episode MP3
under data/media/<id>.mp3. It also writes data/raw/<series>/manifest.json, which
tools/build_dw_scripts.py turns into content items.

Run: uv run --with requests python -I tools/fetch_dw_courses.py [mission-berlin|radio-d ...]
Needs `pdftotext` (poppler) on PATH.
"""

import json
import re
import subprocess
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BASE = "https://learngerman.dw.com"
UA = {"User-Agent": "Mozilla/5.0 (language-companion personal study app)"}

SERIES = {
    "mission-berlin": {
        "series": "Mission Berlin",
        "navs": ["/en/mission-berlin-episodes/s-9837"],
        "title_re": r"^Mission Berlin (\d+)\s*[–-]\s*(.+)$",
        "level": lambda n: "A1",
        "pdf_name": "PDF Version of the Manuscript",
    },
    "radio-d": {
        "series": "Radio D",
        "navs": ["/en/radio-d-teil-1/s-9672", "/en/radio-d-teil-2/s-9673"],
        "title_re": r"^Episode (\d+)\s*[–-]\s*(.+)$",
        "level": lambda n: "A1" if n <= 26 else "A2",
        "pdf_name": "PDF Version of the Manuscript",
    },
}


def get(url, **kw):
    for attempt in range(4):
        try:
            r = requests.get(url, headers=UA, timeout=60, **kw)
            r.raise_for_status()
            return r
        except requests.RequestException:
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))


def apollo(html):
    m = re.search(r"window\.__APOLLO_STATE__\s*=\s*(\{.*?\});?\s*</script>", html, re.S)
    if not m:
        raise ValueError("no __APOLLO_STATE__ in page")
    return json.loads(m.group(1))


def deref(state, obj):
    if isinstance(obj, dict) and "__ref" in obj:
        return state.get(obj["__ref"], {})
    return obj


def episodes_from_nav(nav_path, title_re):
    state = apollo(get(BASE + nav_path).text)
    found = {}
    for key, val in state.items():
        if not key.startswith("Article:"):
            continue
        m = re.match(title_re, val.get("name") or "")
        if m and val.get("namedUrl"):
            found[int(m.group(1))] = {
                "title": m.group(2).strip(),
                "full_title": val["name"],
                "url": BASE + val["namedUrl"],
                "article_id": val["id"],
            }
    return found


def episode_assets(html, article_id, pdf_name):
    state = apollo(html)
    art = state[f"Article:{article_id}"]
    mp3 = None
    for ref in art.get("audios") or []:
        audio = deref(state, ref)
        if audio.get("mp3Src"):
            mp3 = audio["mp3Src"]
            break
    pdf = None
    for key, link in state.items():
        if key.startswith("ContentLink:") and link.get("name") == pdf_name:
            target = deref(state, link.get("target"))
            pdf = target.get("staticUrl")
    return mp3, pdf


def download(url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with get(url, stream=True) as r, open(tmp, "wb") as f:
        for chunk in r.iter_content(1 << 16):
            f.write(chunk)
    tmp.rename(dest)


def fetch_series(key):
    cfg = SERIES[key]
    raw = DATA / "raw" / key
    raw.mkdir(parents=True, exist_ok=True)
    eps = {}
    for nav in cfg["navs"]:
        eps.update(episodes_from_nav(nav, cfg["title_re"]))
    manifest = []
    for n in sorted(eps):
        ep = eps[n]
        item_id = f"{key}-{n:02d}"
        html_path = raw / f"{item_id}.html"
        if not html_path.exists():
            html_path.write_text(get(ep["url"]).text)
        mp3, pdf = episode_assets(html_path.read_text(), ep["article_id"], cfg["pdf_name"])
        entry = {
            "id": item_id,
            "series": cfg["series"],
            "order": n,
            "level": cfg["level"](n),
            "title": ep["title"],
            "url": ep["url"],
            "mp3_url": mp3,
            "pdf_url": pdf,
            "media_path": None,
            "pdf_path": None,
            "text_path": None,
        }
        if mp3:
            download(mp3, DATA / "media" / f"{item_id}.mp3")
            entry["media_path"] = f"media/{item_id}.mp3"
        if pdf:
            pdf_path = raw / f"{item_id}.pdf"
            download(pdf, pdf_path)
            txt_path = raw / f"{item_id}.txt"
            subprocess.run(["pdftotext", "-enc", "UTF-8", str(pdf_path), str(txt_path)], check=True)
            entry["pdf_path"] = str(pdf_path.relative_to(DATA))
            entry["text_path"] = str(txt_path.relative_to(DATA))
        print(f"{item_id}: mp3={'yes' if mp3 else 'NO'} pdf={'yes' if pdf else 'NO'} {ep['full_title']}")
        manifest.append(entry)
    (raw / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"{key}: {len(manifest)} episodes")


if __name__ == "__main__":
    for key in sys.argv[1:] or list(SERIES):
        fetch_series(key)
