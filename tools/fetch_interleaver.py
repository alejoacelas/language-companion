"""Fetch Interleaver's German course ("Maya in Berlin", 28 weeks, A1–A2) into content items.

Interleaver (https://interleaver.org, MIT licence) is an LLM-generated, line-aligned
story course: every German line comes with its own English gloss, and the
"English first" MP3 speaks each line in English, then in German. Lines and
translations are copied as published.

Run: uv run --with requests python -I tools/fetch_interleaver.py
"""

import html
import json
import re
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw" / "interleaver"
SITE = "https://interleaver.org/"
UA = {"User-Agent": "Mozilla/5.0 (language-companion personal study app)"}


def get(url):
    r = requests.get(url, headers=UA, timeout=120)
    r.raise_for_status()
    return r


def text_of(fragment):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", fragment))).strip()


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    index = get(SITE + "german.html").text
    (RAW / "german.html").write_text(index)
    weeks = re.findall(
        r"<b>Week (\d+)</b>.*?<span class=muted>([^<]+)</span></td><td><audio[^>]*src=\"([^\"]+english-then-german\.mp3)\".*?href=\"(transcripts/german/week\d+\.html)\"",
        index,
        re.S,
    )
    print(f"{len(weeks)} weeks listed")
    for num, title, mp3_url, transcript_path in weeks:
        n = int(num)
        item_id = f"interleaver-{n:02d}"
        page_path = RAW / f"{item_id}.html"
        if not page_path.exists():
            page_path.write_text(get(SITE + transcript_path).text)
        page = page_path.read_text()
        lines = []
        for de, en in re.findall(r"<tr class=tr><td>(.*?)</td><td class=muted>(.*?)</td></tr>", page, re.S):
            lines.append({"id": f"l{len(lines) + 1}", "speaker": "Narrator", "lang": "de", "text": text_of(de), "en": text_of(en)})
        media_path = DATA / "media" / f"{item_id}.mp3"
        if not media_path.exists():
            media_path.write_bytes(get(mp3_url).content)
        item = {
            "id": item_id,
            "kind": "episode",
            "series": "Interleaver – Maya in Berlin",
            # Week 23's published title has curriculum notes leaked into it; keep the part before them.
            "title": re.split(r"\)\s*\*\*|\s\*\*", html.unescape(title))[0].strip(),
            "order": n,
            # The course spans A1–A2 over 28 weeks; the split at week 15 is an estimate.
            "level": "A1" if n <= 14 else "A2",
            "source": {
                "name": "Interleaver",
                "url": SITE + transcript_path,
                "note": "Free, MIT-licensed, LLM-generated course. German lines and English glosses as published; audio is the 'English first' version (each line in English, then German).",
            },
            "media": {"type": "audio", "path": f"media/{item_id}.mp3"},
            "external_link": {"label": "Interleaver German course", "url": SITE + "german.html"},
            "lines": lines,
        }
        (DATA / "content" / f"{item_id}.json").write_text(json.dumps(item, ensure_ascii=False, indent=2))
        print(f"{item_id}: {len(lines)} lines, {item['title']}")


if __name__ == "__main__":
    main()
