# youtube-embed-rewrite — agent instructions

Public product is a single userscript. Keep the GitHub tree minimal.

## Canonical files (committed)

| File | Role |
|------|------|
| `youtube-nocookie-to-youtube.user.js` | Product — Greasy Fork code sync target |
| `ADDITIONAL_INFO.md` | User-facing Greasy Fork description sync |
| `README.md` | Public project readme |
| `AGENTS.md` | This file |
| `.gitignore` | Keep tests/tooling local |

## Do not commit

- Smoke tests, Playwright, `package.json`, publish helpers, debug scripts
- Session files, screenshots, absolute machine paths, secrets

## Design

1. **Any site** — not a shortlist of domains.
2. **Prefer IFrame API** when messages work; **timer fallback** after user interaction if not.
3. **Lazy facades** (`data-iframe` JSON, ytimg posters, lite-youtube) must prime on click even when no iframe exists yet.
3b. **old.reddit** posts use a cross-origin `redditmedia.com` iframe — use `div.thing[data-url]` for the video id and mount on `.expando`.
4. **Escape hatch** — first-party `youtube.com/watch?v=…`. Do not spoof embed verification.
5. **No overlay on passive load.**
6. **`@grant none`**. Bump `@version` on user-facing changes.

## Release

Bump `@version` → commit → push `main` → Greasy Fork “Update and sync now” (or webhook).
