"""Download DW "Harry – gefangen in der Zeit" lesson data and episode audio.

Uses the GraphQL endpoint behind learngerman.dw.com. For each of the 100
episodes it saves the lesson JSON (name, description, HTML manuscript, audio
URLs) to data/raw/harry/lesson-NNN.json and the English-narrated episode MP3 to
data/media/harry-NNN.mp3.

    uv run --with httpx python tools/fetch_dw_harry.py
"""

import json
import re
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "harry"
MEDIA = ROOT / "data" / "media"
GQL = "https://learngerman.dw.com/graphql"
COURSES = [67188986, 68307842]  # Harry A1 (episodes 1-50), A2 (51-100)

LESSON_QUERY = """
query($id: Int!) { content(id: $id, lang: GERMAN) { ... on Lesson {
  id name namedUrl teaser description manuscript
  audios { id name mp3Src duration }
} } }
"""


def gql(client: httpx.Client, query: str, variables: dict | None = None) -> dict:
    r = client.post(GQL, json={"query": query, "variables": variables or {}})
    body = r.json()
    if body.get("errors"):
        raise RuntimeError(body["errors"])
    return body["data"]


def course_lessons(client: httpx.Client, course_id: int) -> list[int]:
    q = "{ content(id: %d, lang: GERMAN) { ... on Course { contentLinks(targetTypes: [LESSON]) { targetId } } } }" % course_id
    data = gql(client, q)
    return [l["targetId"] for l in data["content"]["contentLinks"]]


def download(client: httpx.Client, url: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 100_000:
        return True
    with client.stream("GET", url) as r:
        if r.status_code != 200:
            return False
        tmp = dest.with_suffix(".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_bytes():
                f.write(chunk)
        tmp.rename(dest)
    return True


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    MEDIA.mkdir(parents=True, exist_ok=True)
    client = httpx.Client(timeout=120, follow_redirects=True)
    lesson_ids = [lid for c in COURSES for lid in course_lessons(client, c)]
    print(f"{len(lesson_ids)} lessons")
    for lid in lesson_ids:
        lesson = gql(client, LESSON_QUERY, {"id": lid})["content"]
        m = re.match(r"(\d+)\s", lesson["name"])
        if not m:
            print("skip, no episode number:", lesson["name"], file=sys.stderr)
            continue
        n = int(m.group(1))
        (RAW / f"lesson-{n:03d}.json").write_text(json.dumps(lesson, ensure_ascii=False, indent=1))
        ep = [a for a in lesson["audios"] if "/episodes/" in (a.get("mp3Src") or "")]
        if not ep:
            print(f"{n:03d}: no episode audio", file=sys.stderr)
            continue
        src = ep[0]["mp3Src"]
        en_src = src.replace("/episodes/de/", "/episodes/en/")
        ok = download(client, en_src, MEDIA / f"harry-{n:03d}.mp3") or download(client, src, MEDIA / f"harry-{n:03d}.mp3")
        print(f"{n:03d} {lesson['name']!r} audio={'ok' if ok else 'FAILED'}")


if __name__ == "__main__":
    main()
