# Agent notes

## Credentials

`.env` is built from `.env.tpl` with `op --account my.1password.com inject -i .env.tpl -o .env -f`.

| Variable | 1Password location |
|---|---|
| `ANTHROPIC_API_KEY` | personal account, vault `mac-agents`, item `ANTHROPIC_API_KEY — personal-apps-2026-10` (id `mj6dyf42xml2ughfxqzpxey3zi`), field `credential` |
| `OPENAI_API_KEY` | personal account, vault `mac-agents`, item `MEALS_FEEDBACK_OPENAI_API_KEY — meals-feedback` (id `3yt6acocp5bcut6wogmao5wxdu`), field `credential` |
| `GRANOLA_API_KEY` | personal account, vault `server-agents`, item `GRANOLA_API_KEY — desk-pipeline` (id `muq3to7rl6k5z7yuq663dschie`), field `credential`. `op-agent` on the Mac can't reach this vault, so `.env` is built with plain `op`. |
