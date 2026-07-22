Embedded YouTube videos on blogs, forums, and news sites sometimes refuse to play and show a bot-check or sign-in message — even when the same video works on YouTube itself. That is especially common with privacy addons or strict browser settings.

This userscript does **not** try to pass embed verification. When an embed won’t play, it shows a **Watch on YouTube** button that opens the video on `youtube.com` in a normal first-party tab.

## How it works

1. **Prefer the IFrame API** when the environment allows it (`enablejsapi`, play / error messages).
2. **Fallback:** after you try to play, a short local timer shows the overlay if playback never confirms — no dependency on third-party embed signals that privacy tools may block.
3. **Escape hatch:** opens `youtube.com/watch?v=…`. It does not make the embed play in place.

## Notes

- Applies to **all sites** where YouTube embeds appear
- Overlay appears after you interact with a broken embed (or on a hard player error) — not on every idle player
- Optional **Show embed anyway** dismiss if the embed actually works
- No data collection or external requests from the script itself

## Source

- GitHub: https://github.com/ollebro/youtube-embed-rewrite  
- Issues / contributions welcome there
