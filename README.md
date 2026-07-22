# Watch on YouTube — Blocked Embeds

Userscript for **any website**: when a YouTube embed won’t play, show a **Watch on YouTube** overlay that opens the normal watch page.

## Install

**[Install from Greasy Fork](https://greasyfork.org/en/scripts/586322-watch-on-youtube-blocked-embeds)** (recommended — auto-updates).

Or open [`youtube-nocookie-to-youtube.user.js`](youtube-nocookie-to-youtube.user.js) with Violentmonkey / Tampermonkey.

## Why

YouTube **embeds** often fail bot/human checks — especially with privacy addons or strict browser settings — while the same video may still work on `youtube.com` itself. This script does not try to pass embed verification. It offers a local escape hatch to the first-party watch URL.

## How it works

| Layer | Behavior |
|-------|----------|
| **IFrame API** (when available) | `enablejsapi` + play / error messages — hide overlay if playing, show sooner on hard errors |
| **Local timer** (fallback) | After you try to play, if playback never confirms, show the overlay |
| **Escape** | Link to `https://www.youtube.com/watch?v=…` |

Also best-effort: rewrite `youtube-nocookie.com` → `www.youtube.com` on the embed URL.

Supports live iframes and **lazy facades** that only inject an iframe on click (CMS `data-iframe` JSON, YouTube thumbnail posters, `lite-youtube`, etc.).

### Overlay

- **Watch on YouTube** — open the watch page in a new tab  
- **Show embed anyway** — dismiss for that mount  

No overlay on passive load of a working idle player.

## License

MIT (see the userscript header).

## Source & distribution

| | |
|--|--|
| **Code** | [`youtube-nocookie-to-youtube.user.js`](youtube-nocookie-to-youtube.user.js) |
| **Greasy Fork** | [script 586322](https://greasyfork.org/en/scripts/586322-watch-on-youtube-blocked-embeds) |
| **GF code sync** | raw `main` userscript URL |
| **GF additional info** | raw [`ADDITIONAL_INFO.md`](ADDITIONAL_INFO.md) |

Release: bump `@version` in the userscript → push to `main` → Greasy Fork sync.
