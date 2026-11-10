"""Claude calls. Opus for writing and judgement, Haiku where latency matters."""

import json
import re

import anthropic

SMART = "claude-opus-5-5"
FAST = "claude-haiku-5-5"

_client: anthropic.Anthropic | None = None


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


def ask(user: str, system: str = "", model: str = SMART, max_tokens: int = 4000,
        messages: list | None = None) -> str:
    msgs = messages if messages is not None else [{"role": "user", "content": user}]
    kw = {"system": system} if system else {}
    with client().messages.stream(model=model, max_tokens=max_tokens, messages=msgs, **kw) as s:
        r = s.get_final_message()
    return "".join(b.text for b in r.content if b.type == "text")


def ask_json(user: str, system: str = "", model: str = SMART, max_tokens: int = 4000,
             messages: list | None = None):
    text = ask(user, system, model, max_tokens, messages)
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    body = m.group(1) if m else text
    start = min([i for i in (body.find("{"), body.find("[")) if i >= 0], default=0)
    return json.loads(body[start:body.rfind("}" if body[start] == "{" else "]") + 1])
