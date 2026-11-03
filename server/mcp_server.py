"""MCP server exposing the learner's progress to any LLM client (read-only).

Run: uv run python -m server.mcp_server   (stdio transport)
"""

import json

from mcp.server.mcpserver import MCPServer

from . import content, curriculum, progress, srs

mcp = MCPServer("language-companion")


@mcp.tool()
def progress_summary() -> str:
    """Overall progress: blocks done, streak, card counts, recent words, top pronunciation issues, recent block summaries."""
    return json.dumps(progress.summary(), ensure_ascii=False, indent=2)


@mcp.tool()
def curriculum_status() -> str:
    """Where the learner is on the lesson ladder: lessons written and done, the next lesson, words met and known."""
    return json.dumps(curriculum.status(), ensure_ascii=False, indent=2)


@mcp.tool()
def words(known_only: bool = False) -> str:
    """Every German word the learner has met in lessons, with meaning, lesson, reviews, readings and look-ups."""
    ws = [{k: w[k] for k in ("de", "en", "lesson", "known", "good_reviews", "seen", "clicks")} for w in curriculum.word_states()]
    return json.dumps([w for w in ws if w["known"] or not known_only], ensure_ascii=False)


@mcp.tool()
def recent_activity(days: int = 7, limit: int = 200) -> str:
    """Raw activity events (cards added, reviews, items read, pronunciation attempts) from the last `days` days, newest first."""
    return json.dumps(progress.recent_activity(days, limit), ensure_ascii=False)


@mcp.tool()
def pronunciation_issues(days: int = 30) -> str:
    """Most frequent expected→heard sound confusions in recent pronunciation attempts."""
    return json.dumps(progress.pronunciation_issues(days), ensure_ascii=False)


@mcp.tool()
def due_cards(limit: int = 30) -> str:
    """Vocabulary cards due for review now."""
    return json.dumps([{k: c[k] for k in ("front", "back", "context_de", "due")} for c in srs.due(limit)], ensure_ascii=False)


@mcp.tool()
def catalog() -> str:
    """All reading and watching items with status (new, started, done)."""
    return json.dumps(content.catalog(), ensure_ascii=False)


if __name__ == "__main__":
    mcp.run()
