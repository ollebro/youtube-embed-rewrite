// ==UserScript==
// @name         Watch on YouTube — Blocked Embeds
// @namespace    https://greasyfork.org/users/1621606-ollebro
// @version      5.6.0
// @description  On any site: when a YouTube embed won’t play after you try it, show Watch on YouTube on the player only.
// @author       ollebro
// @license      MIT
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @compatible   firefox Violentmonkey
// @compatible   chrome Tampermonkey
// @compatible   edge Tampermonkey
// ==/UserScript==

(function () {
  'use strict';

  const MARKER = 'data-yt-watch-mounted';
  const CLICK_MARKER = 'data-yt-watch-click';
  const LOAD_MARKER = 'data-yt-watch-load';
  const ENHANCED_MARKER = 'data-yt-watch-enhanced';
  const SHADOW_OBS_MARKER = 'data-yt-watch-shadow-obs';
  const SHADOW_WATCH_MARKER = 'data-yt-watch-shadow-watch';
  const SHELL_MODE = 'data-yt-shell-mode';
  const OVERLAY_CLASS = 'yt-embed-center-overlay';
  const HIT_CLASS = 'yt-embed-hit';
  const STYLE_ID = 'yt-embed-overlay-style';

  // Detection:
  // 1) IFrame API postMessage (play / onError) when available
  // 2) Timer after a real user gesture on the player (hit-layer for cross-origin iframes)
  // Overlay mounts on a player-sized shell only — never page chrome.
  const BLOCKED_DELAY_MS = 2000;
  const DEFAULT_SHELL_W = 640;
  const DEFAULT_SHELL_H = 360;
  const MAX_SHELL_W = 960;
  const MAX_SHELL_H = 540;
  const NO_EMBED_FALLBACK_MS = 2500;
  const MIN_PLAYBACK_SECONDS = 0.3;
  const WAIT_IFRAME_MS = 15000;
  const SCAN_DEBOUNCE_MS = 80;
  const HIT_MIN_W = 120;
  const HIT_MIN_H = 70;

  /** @type {WeakMap<HTMLIFrameElement, object>} */
  const states = new WeakMap();
  /** @type {WeakMap<Element, object>} */
  const mountStates = new WeakMap();
  /** iframe id → state (shadow-safe; getElementById does not pierce open shadow) */
  const stateByIframeId = new Map();
  /** @type {WeakMap<Element, number>} */
  const noEmbedTimers = new WeakMap();
  /** @type {WeakMap<Element, IntersectionObserver>} */
  const hitObservers = new WeakMap();

  let idSeq = 0;
  let scanTimer = null;
  /** @type {Set<Element>|null} */
  let pendingScanRoots = null;
  let needFullScan = false;
  /** @type {IntersectionObserver|null} */
  let viewportObserver = null;

  const ID_PATTERNS = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/vi\/([a-zA-Z0-9_-]{11})\//,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];

  const LAZY_EMBED_SELECTOR = [
    'f-embed[data-type="youtube"][data-id]',
    '[data-type="youtube"][data-id]',
    '.youtube-player[data-id]',
    '[data-youtube-id]',
    '[data-video-id][data-provider="youtube"]',
  ].join(', ');

  const DATA_IFRAME_SELECTOR = '[data-iframe]';
  const YTIMG_SELECTOR =
    'img[src*="i.ytimg.com/vi/"], img[src*="img.youtube.com/vi/"], source[srcset*="i.ytimg.com/vi/"]';
  const SHADOW_HOST_SELECTOR = 'shreddit-embed';
  const LITE_SELECTOR = 'lite-youtube';
  const OLD_REDDIT_THING_SELECTOR = 'div.thing[data-url], div.thing.link';
  const REDDITMEDIA_IFRAME_SELECTOR =
    'iframe.media-embed[src*="redditmedia.com/mediaembed"], iframe[src*="redditmedia.com/mediaembed"]';
  const YOUTUBE_IFRAME_SELECTOR =
    'iframe[src*="youtube.com"], iframe[src*="youtube-nocookie.com"], iframe[data-src*="youtube.com"], iframe[data-src*="youtube-nocookie.com"]';

  const YT_HOST_CANDIDATES = [
    '.lightbox__content',
    '.lightbox__body',
    '.media-embed__content',
    '.media-embed',
    '.video-wrapper',
    'lite-youtube',
    'f-embed-youtube',
    '.cmp-embed__youtube',
    '.wp-block-embed-youtube',
    '.jetpack-video-wrapper',
    '.youtube-player',
    '.youtube-container',
    '.yt-container',
    'figure.wp-block-embed',
  ].join(', ');

  const STYLE_CSS = `
    .yt-embed-player-shell[data-yt-shell-mode="fixed"] {
      position: relative !important;
      display: inline-block;
      max-width: 100%;
      vertical-align: top;
      line-height: 0;
      box-sizing: border-box;
    }
    .yt-embed-player-shell[data-yt-shell-mode="fill"] {
      position: relative !important;
      box-sizing: border-box;
    }
    .yt-embed-player-shell > iframe {
      display: block;
      width: 100%;
      height: 100%;
      max-width: 100%;
      border: 0;
    }
    .yt-embed-mount {
      position: relative;
    }
    .${HIT_CLASS} {
      position: absolute;
      inset: 0;
      z-index: 2;
      background: transparent;
      cursor: pointer;
      pointer-events: none;
    }
    .${HIT_CLASS}.is-listening:not(.is-spent) {
      pointer-events: auto;
    }
    .${HIT_CLASS}.is-spent {
      pointer-events: none;
    }
    .${OVERLAY_CLASS} {
      position: absolute;
      inset: 0;
      z-index: 5;
      display: none;
      align-items: center;
      justify-content: center;
      background: #0f0f0f;
      pointer-events: auto;
      text-align: center;
      padding: 12px;
      box-sizing: border-box;
      overflow: auto;
    }
    .${OVERLAY_CLASS}.is-visible {
      display: flex !important;
    }
    .yt-embed-mount.is-blocked iframe {
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    .yt-embed-mount.is-blocked .${HIT_CLASS} {
      pointer-events: none !important;
    }
    .yt-embed-reddit-fallback {
      margin: 8px 0 6px;
      max-width: 100%;
    }
    .yt-embed-reddit-fallback .yt-embed-reddit-cta {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      border-radius: 8px;
      background: #ff0000;
      color: #fff !important;
      font: 700 14px/1.2 system-ui, -apple-system, Segoe UI, sans-serif;
      text-decoration: none !important;
      box-shadow: 0 2px 8px rgba(0,0,0,.25);
    }
    .yt-embed-reddit-fallback .yt-embed-reddit-cta:hover {
      background: #cc0000;
      color: #fff !important;
    }
    .${OVERLAY_CLASS} .yt-embed-center-card {
      max-width: 340px;
      color: #f1f1f1;
      font: 14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif;
    }
    .${OVERLAY_CLASS} .yt-embed-center-title {
      margin: 0 0 8px;
      font-size: 16px;
      font-weight: 600;
      color: #fff;
    }
    .${OVERLAY_CLASS} .yt-embed-center-text {
      margin: 0 0 18px;
      color: #aaa;
    }
    .${OVERLAY_CLASS} .yt-embed-center-actions {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    .${OVERLAY_CLASS} .yt-embed-center-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-width: 220px;
      padding: 14px 20px;
      border-radius: 8px;
      background: #ff0000;
      color: #fff !important;
      font: 700 16px/1 system-ui, -apple-system, Segoe UI, sans-serif;
      text-decoration: none !important;
      box-shadow: 0 4px 14px rgba(0,0,0,.35);
      border: none;
      cursor: pointer;
    }
    .${OVERLAY_CLASS} .yt-embed-center-link:hover {
      background: #cc0000;
      color: #fff !important;
    }
    .${OVERLAY_CLASS} .yt-embed-center-link:focus-visible {
      outline: 2px solid #fff;
      outline-offset: 3px;
    }
    .${OVERLAY_CLASS} .yt-embed-center-link svg {
      width: 22px;
      height: 22px;
      flex-shrink: 0;
    }
    .${OVERLAY_CLASS} .yt-embed-dismiss {
      background: transparent;
      border: none;
      color: #aaa;
      font: 13px/1.3 system-ui, -apple-system, Segoe UI, sans-serif;
      text-decoration: underline;
      cursor: pointer;
      padding: 6px 8px;
    }
    .${OVERLAY_CLASS} .yt-embed-dismiss:hover {
      color: #fff;
    }
    .${OVERLAY_CLASS} .yt-embed-dismiss:focus-visible {
      outline: 2px solid #fff;
      outline-offset: 2px;
      border-radius: 4px;
    }
  `;

  const YT_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
    '<path d="M23.5 6.2c-.3-.9-1.1-1.6-2-1.8C19.2 4 12 4 12 4s-7.2 0-9.5.4c-.9.2-1.7.9-2 1.8C0 8.5 0 12 0 12s0 3.5.5 5.8c.3.9 1.1 1.6 2 1.8 2.3.4 9.5.4 9.5.4s7.2 0 9.5-.4c.9-.2 1.7-.9 2-1.8.5-2.3.5-5.8.5-5.8s0-3.5-.5-5.8zM9.6 15.6V8.4L15.8 12l-6.2 3.6z"/>' +
    '</svg>';

  // --- utils -----------------------------------------------------------------

  function extractId(value) {
    if (!value || typeof value !== 'string') return null;
    for (const pattern of ID_PATTERNS) {
      const match = value.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  function isVideoId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id);
  }

  function iframeSrc(iframe) {
    return iframe?.src || iframe?.getAttribute?.('src') || iframe?.getAttribute?.('data-src') || '';
  }

  function isYoutubeHost(hostname) {
    return /(?:^|\.)youtube(?:-nocookie)?\.com$/i.test(hostname || '');
  }

  function isYoutubeIframeEl(el) {
    return el instanceof HTMLIFrameElement && /youtube(-nocookie)?\.com/i.test(iframeSrc(el));
  }

  function isRedditMediaIframeEl(el) {
    if (!(el instanceof HTMLIFrameElement)) return false;
    const src = iframeSrc(el);
    return /redditmedia\.com\/mediaembed/i.test(src) || el.classList.contains('media-embed');
  }

  function isYoutubePageUrl(url) {
    return !!url && /(?:youtube\.com|youtu\.be)\b/i.test(url);
  }

  function watchUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  function isValidMount(mount) {
    if (!(mount instanceof Element)) return false;
    const tag = mount.tagName;
    return tag !== 'STYLE' && tag !== 'LINK' && tag !== 'SCRIPT';
  }

  function ensureRelative(el) {
    if (!el) return;
    try {
      if (getComputedStyle(el).position === 'static') {
        el.style.position = 'relative';
      }
    } catch {
      /* cross-origin computed style edge cases */
    }
  }

  function parseJsonAttr(el, name) {
    const raw = el.getAttribute?.(name);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      try {
        return JSON.parse(
          raw.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&')
        );
      } catch {
        return null;
      }
    }
  }

  /** Parse CMS JSON for a YouTube video id. Avoid bare `id` keys (too ambiguous). */
  function videoIdFromConfigObject(obj, depth = 0) {
    if (!obj || depth > 5) return null;
    if (typeof obj === 'string') return extractId(obj) || (isVideoId(obj) ? obj : null);
    if (typeof obj !== 'object') return null;

    const keys = [
      'youtubeCepVideoId',
      'youtubeVideoId',
      'videoId',
      'videoid',
      'youtubeId',
      'ytId',
    ];
    for (const key of keys) {
      const v = obj[key];
      if (isVideoId(v)) return v;
      if (typeof v === 'string') {
        const fromStr = extractId(v);
        if (fromStr) return fromStr;
      }
    }

    if (typeof obj.src === 'string' && /youtube/i.test(obj.src)) {
      const id = extractId(obj.src);
      if (id) return id;
    }

    if (obj.embeddableProperties) {
      const nested = videoIdFromConfigObject(obj.embeddableProperties, depth + 1);
      if (nested) return nested;
    }

    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') {
        const nested = videoIdFromConfigObject(v, depth + 1);
        if (nested) return nested;
      } else if (typeof v === 'string' && /youtube|youtu\.be|ytimg/i.test(v)) {
        const id = extractId(v);
        if (id) return id;
      }
    }
    return null;
  }

  function videoIdFromElementConfig(el) {
    if (!(el instanceof Element)) return null;
    const fromIframe = videoIdFromConfigObject(parseJsonAttr(el, 'data-iframe'));
    if (fromIframe) return fromIframe;
    const fromLayer = videoIdFromConfigObject(parseJsonAttr(el, 'data-cmp-data-layer'));
    if (fromLayer) return fromLayer;
    for (const name of ['data-video-id', 'data-youtube-id', 'data-videoid', 'videoid']) {
      const v = el.getAttribute(name);
      if (isVideoId(v)) return v;
      const from = extractId(v || '');
      if (from) return from;
    }
    return extractId(el.getAttribute('data-iframe') || '') || null;
  }

  function clampShellSize(w, h) {
    let width = w > 0 ? w : DEFAULT_SHELL_W;
    let height = h > 0 ? h : DEFAULT_SHELL_H;
    if (width > MAX_SHELL_W || height > MAX_SHELL_H) {
      const scale = Math.min(MAX_SHELL_W / width, MAX_SHELL_H / height, 1);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    if (
      typeof window !== 'undefined' &&
      width >= window.innerWidth * 0.92 &&
      height >= window.innerHeight * 0.7
    ) {
      width = DEFAULT_SHELL_W;
      height = DEFAULT_SHELL_H;
    }
    return { width, height };
  }

  function isReasonablePlayerMount(el, mediaEl) {
    if (!(el instanceof Element)) return false;
    if (el === document.body || el === document.documentElement) return false;
    if (
      el.matches?.(
        'body, html, main, #content, #siteTable, .side, .content, .expando, .entry, .thing'
      )
    ) {
      return false;
    }
    if (el.classList.contains('yt-embed-player-shell')) return true;

    let er;
    try {
      er = el.getBoundingClientRect();
    } catch {
      return false;
    }
    if (er.width < 40 || er.height < 40) return true;

    if (
      typeof window !== 'undefined' &&
      er.width >= window.innerWidth * 0.92 &&
      er.height >= window.innerHeight * 0.7
    ) {
      return false;
    }

    if (mediaEl instanceof Element) {
      try {
        const mr = mediaEl.getBoundingClientRect();
        if (mr.width > 40 && mr.height > 40) {
          if (er.width > mr.width * 1.6 || er.height > mr.height * 1.6) return false;
        }
      } catch {
        /* ignore */
      }
    }
    return true;
  }

  // --- styles / overlay ------------------------------------------------------

  function injectStyles(into) {
    const parent =
      into instanceof ShadowRoot
        ? into
        : into || document.head || document.documentElement;
    if (!parent || parent.getElementById?.(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_CSS;
    parent.appendChild(style);
  }

  function ensureOverlay(mount, videoId) {
    ensureRelative(mount);
    mount.classList.add('yt-embed-mount');

    let overlay = mount.querySelector(`:scope > .${OVERLAY_CLASS}`);
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = OVERLAY_CLASS;
      overlay.setAttribute('role', 'alert');
      overlay.setAttribute('aria-live', 'polite');
      overlay.innerHTML =
        '<div class="yt-embed-center-card">' +
        '<p class="yt-embed-center-title">Can\u2019t play here</p>' +
        '<p class="yt-embed-center-text">This embed is blocked. Open the video on YouTube instead.</p>' +
        '<div class="yt-embed-center-actions">' +
        `<a class="yt-embed-center-link" href="${watchUrl(videoId)}" target="_blank" rel="noopener noreferrer">` +
        YT_ICON +
        '<span>Watch on YouTube</span></a>' +
        '<button type="button" class="yt-embed-dismiss">Show embed anyway</button>' +
        '</div></div>';
      mount.appendChild(overlay);

      overlay.querySelector('.yt-embed-dismiss')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const state = mountStates.get(mount);
        if (state) dismissBlocked(state);
      });
    }

    const link = overlay.querySelector('.yt-embed-center-link');
    if (link) link.href = watchUrl(videoId);
    return overlay;
  }

  function setIframeHidden(iframe, hidden) {
    if (!(iframe instanceof HTMLIFrameElement)) return;
    if (hidden) {
      iframe.style.setProperty('opacity', '0', 'important');
      iframe.style.setProperty('visibility', 'hidden', 'important');
      iframe.style.setProperty('pointer-events', 'none', 'important');
    } else {
      iframe.style.removeProperty('opacity');
      iframe.style.removeProperty('visibility');
      iframe.style.removeProperty('pointer-events');
    }
  }

  function setAllIframesHidden(mount, hidden) {
    if (!mount) return;
    mount.querySelectorAll('iframe').forEach((f) => setIframeHidden(f, hidden));
  }

  function clearTimer(state) {
    if (!state?.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
  }

  function showBlocked(state) {
    if (!state || state.playing || state.blockedShown || state.dismissed) return;
    clearTimer(state);
    state.blockedShown = true;
    state.mount.classList.add('is-blocked');
    state.overlay.classList.add('is-visible');
    state.mount.appendChild(state.overlay);
    setIframeHidden(state.iframe, true);
    setAllIframesHidden(state.mount, true);
    const hit = state.mount.querySelector(`:scope > .${HIT_CLASS}`);
    if (hit) {
      hit.classList.add('is-spent');
      hit.classList.remove('is-listening');
    }
    const link = state.overlay.querySelector('.yt-embed-center-link');
    try {
      link?.focus({ preventScroll: true });
    } catch {
      link?.focus();
    }
  }

  function hideBlocked(state) {
    if (!state) return;
    state.blockedShown = false;
    state.playing = true;
    state.mount.classList.remove('is-blocked');
    state.overlay.classList.remove('is-visible');
    setIframeHidden(state.iframe, false);
    setAllIframesHidden(state.mount, false);
    clearTimer(state);
  }

  function dismissBlocked(state) {
    if (!state) return;
    state.dismissed = true;
    state.blockedShown = false;
    state.mount.classList.remove('is-blocked');
    state.overlay.classList.remove('is-visible');
    setIframeHidden(state.iframe, false);
    setAllIframesHidden(state.mount, false);
    clearTimer(state);
  }

  function scheduleBlockedCheck(state) {
    if (!state || state.playing || state.blockedShown || state.dismissed || state.timer) return;
    if (!state.userActivated) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (!state.playing && !state.blockedShown && !state.dismissed) {
        showBlocked(state);
      }
    }, BLOCKED_DELAY_MS);
  }

  function primeBlockedCheck(mount, videoId) {
    if (!isValidMount(mount) || !isVideoId(videoId)) return;
    if (
      !mount.classList.contains('yt-embed-player-shell') &&
      !isReasonablePlayerMount(mount)
    ) {
      return;
    }
    const state = getOrCreateState(mount, videoId);
    if (!state || state.dismissed) return;
    state.userActivated = true;
    scheduleBlockedCheck(state);
  }

  // --- shells / interaction --------------------------------------------------

  function ensurePlayerShell(mediaEl) {
    if (!(mediaEl instanceof Element)) return null;

    const existing = mediaEl.closest?.('.yt-embed-player-shell');
    if (existing) return existing;
    if (mediaEl.classList?.contains('yt-embed-player-shell')) return mediaEl;

    const parent = mediaEl.parentElement;
    if (!parent) return null;

    // YouTube: fill the site's player host (lightbox/modal) — never freeze collapsed size
    if (isYoutubeIframeEl(mediaEl)) {
      const host = mediaEl.closest(YT_HOST_CANDIDATES) || parent;
      if (
        host &&
        host !== document.body &&
        host !== document.documentElement &&
        !host.matches?.('body, html, main, #content')
      ) {
        ensureRelative(host);
        host.classList.add('yt-embed-player-shell');
        host.setAttribute(SHELL_MODE, 'fill');
        mediaEl.style.width = '100%';
        mediaEl.style.height = '100%';
        mediaEl.style.border = '0';
        mediaEl.style.display = 'block';
        return host;
      }
    }

    // Fixed wrap (redditmedia / fallback)
    const wrap = document.createElement('div');
    wrap.className = 'yt-embed-player-shell';
    wrap.setAttribute(SHELL_MODE, 'fixed');

    const attrW = parseInt(mediaEl.getAttribute?.('width') || '', 10);
    const attrH = parseInt(mediaEl.getAttribute?.('height') || '', 10);
    let rawW = 0;
    let rawH = 0;
    try {
      const rect = mediaEl.getBoundingClientRect();
      rawW = attrW > 0 ? attrW : Math.round(rect.width || 0);
      rawH = attrH > 0 ? attrH : Math.round(rect.height || 0);
    } catch {
      rawW = attrW;
      rawH = attrH;
    }
    if (rawW < 80 || rawH < 45) {
      rawW = DEFAULT_SHELL_W;
      rawH = DEFAULT_SHELL_H;
    }
    const { width, height } = clampShellSize(rawW, rawH);
    wrap.style.width = `${width}px`;
    wrap.style.height = `${height}px`;
    wrap.style.maxWidth = '100%';
    wrap.style.boxSizing = 'border-box';

    parent.insertBefore(wrap, mediaEl);
    wrap.appendChild(mediaEl);

    if (mediaEl instanceof HTMLIFrameElement) {
      mediaEl.style.width = '100%';
      mediaEl.style.height = '100%';
      mediaEl.style.border = '0';
      mediaEl.removeAttribute('width');
      mediaEl.removeAttribute('height');
    }
    return wrap;
  }

  function ensureInteractionCatcher(mount, videoId) {
    if (!isValidMount(mount) || !isVideoId(videoId)) return;
    if (mount.querySelector(`:scope > .${HIT_CLASS}`)) return;

    ensureRelative(mount);
    const hit = document.createElement('div');
    hit.className = HIT_CLASS;
    hit.setAttribute('aria-hidden', 'true');

    const arm = () => {
      if (hit.classList.contains('is-spent')) return;
      if (!hit.classList.contains('is-listening')) return;
      hit.classList.add('is-spent');
      primeBlockedCheck(mount, videoId);
      waitForIframe(mount);
      const wrap =
        mount.closest(
          '.cmp-embed, .cmp-embed__youtube, .embed, .expando, .lightbox, .lightbox__content, .media-embed'
        ) || mount.parentElement;
      if (wrap && wrap !== mount) waitForIframe(wrap);
    };

    hit.addEventListener('pointerdown', arm, true);
    hit.addEventListener('click', arm, true);
    mount.appendChild(hit);

    const syncListening = (rect, isIntersecting) => {
      if (hit.classList.contains('is-spent')) return;
      const bigEnough = rect.width >= HIT_MIN_W && rect.height >= HIT_MIN_H;
      // Treat as visible if intersecting OR already has a solid on-screen box
      // (some browsers report intersectionRatio 0 for oversized/off-ratio boxes).
      const onScreen =
        isIntersecting ||
        (rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < (window.innerHeight || 0) &&
          rect.left < (window.innerWidth || 0));
      if (onScreen && bigEnough) hit.classList.add('is-listening');
      else hit.classList.remove('is-listening');
    };

    // Immediate check — don't wait for IO callback (fixes headless + already-visible players)
    try {
      syncListening(mount.getBoundingClientRect(), true);
    } catch {
      /* ignore */
    }

    if (typeof IntersectionObserver === 'function') {
      const prev = hitObservers.get(mount);
      if (prev) prev.disconnect();
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            syncListening(entry.boundingClientRect, entry.isIntersecting);
          }
        },
        { threshold: [0, 0.05, 0.15, 0.4, 0.7] }
      );
      io.observe(mount);
      hitObservers.set(mount, io);
    }
  }

  function nextIframeId(videoId) {
    idSeq += 1;
    return `yt-embed-watch-${videoId}-${idSeq}`;
  }

  function getOrCreateState(mount, videoId) {
    if (!isValidMount(mount)) return null;

    let state = mountStates.get(mount);
    if (state) {
      if (videoId && state.videoId !== videoId) {
        state.videoId = videoId;
        const link = state.overlay.querySelector('.yt-embed-center-link');
        if (link) link.href = watchUrl(videoId);
      }
      return state;
    }

    const root = mount.getRootNode();
    if (root instanceof ShadowRoot) injectStyles(root);

    const overlay = ensureOverlay(mount, videoId);
    state = {
      iframe: null,
      mount,
      overlay,
      videoId,
      playing: false,
      blockedShown: false,
      dismissed: false,
      userActivated: false,
      timer: null,
      iframeId: nextIframeId(videoId),
    };
    mountStates.set(mount, state);
    mount.setAttribute(MARKER, videoId);
    ensureInteractionCatcher(mount, videoId);
    return state;
  }

  function registerIframeId(state, iframe) {
    if (state.iframeId && stateByIframeId.get(state.iframeId) === state) {
      stateByIframeId.delete(state.iframeId);
    }
    if (iframe.id) {
      state.iframeId = iframe.id;
    } else {
      if (!state.iframeId) state.iframeId = nextIframeId(state.videoId);
      iframe.id = state.iframeId;
    }
    stateByIframeId.set(state.iframeId, state);
  }

  function enhanceEmbedSrc(rawSrc) {
    if (!rawSrc) return null;
    try {
      const url = new URL(rawSrc, location.href);
      if (!isYoutubeHost(url.hostname)) return null;
      let changed = false;
      if (/youtube-nocookie\.com$/i.test(url.hostname)) {
        url.hostname = 'www.youtube.com';
        changed = true;
      }
      if (url.searchParams.get('enablejsapi') !== '1') {
        url.searchParams.set('enablejsapi', '1');
        changed = true;
      }
      if (!url.searchParams.has('origin') && location.origin && location.origin !== 'null') {
        url.searchParams.set('origin', location.origin);
        changed = true;
      }
      return changed ? url.toString() : null;
    } catch {
      return null;
    }
  }

  function enhanceIframeSrc(iframe) {
    if (!(iframe instanceof HTMLIFrameElement)) return;
    if (iframe.hasAttribute(ENHANCED_MARKER)) return;

    const raw = iframeSrc(iframe);
    if (!raw || !/youtube(-nocookie)?\.com/i.test(raw)) return;

    const next = enhanceEmbedSrc(raw);
    // Mark even when unchanged so we don't re-parse forever
    iframe.setAttribute(ENHANCED_MARKER, '1');
    if (!next || next === raw) return;

    if (iframe.getAttribute('src') || iframe.src) {
      iframe.src = next;
    } else if (iframe.getAttribute('data-src')) {
      iframe.setAttribute('data-src', next);
    }
  }

  function linkIframe(state, iframe) {
    if (!(iframe instanceof HTMLIFrameElement) || !state) return;

    if (state.iframe === iframe) {
      enhanceIframeSrc(iframe);
      if (state.userActivated) scheduleBlockedCheck(state);
      return;
    }

    // Drop previous iframe mapping if any
    if (state.iframe && states.get(state.iframe) === state) {
      states.delete(state.iframe);
    }

    state.iframe = iframe;
    states.set(iframe, state);
    iframe.setAttribute(MARKER, state.videoId);
    registerIframeId(state, iframe);
    enhanceIframeSrc(iframe);

    if (!iframe.hasAttribute(LOAD_MARKER)) {
      iframe.setAttribute(LOAD_MARKER, '1');
      iframe.addEventListener('load', () => {
        if (state.userActivated) scheduleBlockedCheck(state);
      });
    }

    if (state.userActivated) scheduleBlockedCheck(state);
  }

  function getMountPoint(iframe) {
    const shell = ensurePlayerShell(iframe);
    if (shell) return shell;

    const root = iframe.getRootNode();
    if (root instanceof ShadowRoot) {
      return iframe.closest('lite-youtube') || iframe.parentElement;
    }

    const candidates = [
      iframe.closest('lite-youtube'),
      iframe.closest('.yt-embed-player-shell'),
      iframe.closest('[data-iframe]'),
      iframe.closest(YT_HOST_CANDIDATES),
      iframe.closest('f-embed[data-type="youtube"]'),
      iframe.closest('[data-type="youtube"]'),
      iframe.parentElement,
    ];
    for (const c of candidates) {
      if (c && isValidMount(c) && isReasonablePlayerMount(c, iframe)) return c;
    }
    return iframe.parentElement;
  }

  function findYoutubeIframe(root) {
    return root?.querySelector?.(YOUTUBE_IFRAME_SELECTOR) || null;
  }

  function waitForIframe(container) {
    if (!container) return;
    const existing = findYoutubeIframe(container) || container.querySelector?.(REDDITMEDIA_IFRAME_SELECTOR);
    if (existing instanceof HTMLIFrameElement) {
      if (isYoutubeIframeEl(existing)) attachIframe(existing);
      else if (isRedditMediaIframeEl(existing)) attachRedditMediaIframe(existing);
      return;
    }

    const observer = new MutationObserver(() => {
      const iframe =
        findYoutubeIframe(container) || container.querySelector?.(REDDITMEDIA_IFRAME_SELECTOR);
      if (!(iframe instanceof HTMLIFrameElement)) return;
      observer.disconnect();
      if (isYoutubeIframeEl(iframe)) attachIframe(iframe);
      else if (isRedditMediaIframeEl(iframe)) attachRedditMediaIframe(iframe);
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'data-src'],
    });
    setTimeout(() => observer.disconnect(), WAIT_IFRAME_MS);
  }

  // --- attach paths ----------------------------------------------------------

  function attachIframe(iframe) {
    if (!(iframe instanceof HTMLIFrameElement)) return;
    const src = iframeSrc(iframe);
    if (!/youtube(-nocookie)?\.com/i.test(src)) return;
    const videoId = extractId(src);
    if (!videoId) return;
    const mount = getMountPoint(iframe);
    if (!isValidMount(mount)) return;
    const state = states.get(iframe) || getOrCreateState(mount, videoId);
    if (!state) return;
    linkIframe(state, iframe);
  }

  function attachFacadeMount(mount, videoId) {
    if (!isValidMount(mount) || !isVideoId(videoId)) return null;

    const innerIframe =
      findYoutubeIframe(mount) ||
      (mount.matches?.(REDDITMEDIA_IFRAME_SELECTOR) ? mount : null) ||
      mount.querySelector?.(REDDITMEDIA_IFRAME_SELECTOR);

    let target = mount;
    if (innerIframe instanceof HTMLIFrameElement) {
      const shell = ensurePlayerShell(innerIframe);
      if (shell) target = shell;
    } else if (!isReasonablePlayerMount(mount)) {
      return null;
    }

    if (!isValidMount(target)) return null;
    if (
      !target.classList.contains('yt-embed-player-shell') &&
      !isReasonablePlayerMount(target, innerIframe || null)
    ) {
      if (innerIframe instanceof HTMLIFrameElement) {
        target = ensurePlayerShell(innerIframe);
      } else {
        return null;
      }
    }
    if (!isValidMount(target)) return null;

    const state = getOrCreateState(target, videoId);
    if (!state) return null;
    const yt = findYoutubeIframe(target);
    if (yt) linkIframe(state, yt);
    return target;
  }

  function attachDataIframeEmbed(el) {
    if (!(el instanceof Element)) return;
    const cfg = parseJsonAttr(el, 'data-iframe');
    if (!cfg) {
      const raw = el.getAttribute('data-iframe') || '';
      if (!/youtube/i.test(raw)) return;
      const id = extractId(raw);
      if (id) attachFacadeMount(el, id);
      return;
    }
    const type = String(cfg.type || '').toLowerCase();
    const src = String(cfg.src || cfg.url || '');
    if (type && type !== 'youtube' && !/youtube/i.test(src)) return;
    if (!type && !/youtube/i.test(src)) return;
    const videoId = videoIdFromConfigObject(cfg) || extractId(src);
    if (!videoId) return;
    attachFacadeMount(el, videoId);
  }

  function attachYtimgFacade(node) {
    if (!(node instanceof Element)) return;
    const ref = node.getAttribute('src') || node.getAttribute('srcset') || '';
    const videoId = extractId(ref);
    if (!videoId) return;

    const candidates = [
      node.closest(DATA_IFRAME_SELECTOR),
      node.closest('.cmp-embed__youtube'),
      node.closest('.cmp-embed'),
      node.closest('.wp-block-embed-youtube, .youtube-player, .yt-container'),
      node.closest('picture')?.parentElement,
    ].filter(Boolean);

    let mount = null;
    for (const c of candidates) {
      if (isValidMount(c) && isReasonablePlayerMount(c, node)) {
        mount = c;
        break;
      }
    }
    if (!mount) {
      const pic = node.closest('picture') || node;
      // Only shell posters that sit in an embed context
      if (
        !pic.closest(
          '.cmp-embed, .cmp-embed__youtube, .embed, .expando, .media-preview, [data-iframe]'
        )
      ) {
        return;
      }
      mount = ensurePlayerShell(pic);
    }
    if (!mount || !isValidMount(mount)) return;

    if (
      !mount.hasAttribute('data-iframe') &&
      !mount.classList.contains('yt-embed-player-shell') &&
      !/embed|youtube|player|video|thumbnail/i.test(String(mount.className || '')) &&
      !mount.closest('.cmp-embed, .embed, .cmp-embed__youtube, .expando, .media-preview')
    ) {
      return;
    }

    const cfgHost = node.closest(DATA_IFRAME_SELECTOR) || mount;
    attachFacadeMount(mount, videoIdFromElementConfig(cfgHost) || videoId);
  }

  function attachLazyEmbed(el) {
    const videoId =
      el.dataset?.id ||
      el.getAttribute('data-youtube-id') ||
      el.getAttribute('data-video-id') ||
      el.dataset?.youtubeId;
    if (!isVideoId(videoId)) return;

    const type = (el.dataset?.type || el.getAttribute('data-provider') || '').toLowerCase();
    if (type && type !== 'youtube') return;

    const container =
      el.querySelector('f-embed-youtube') || el.querySelector(LITE_SELECTOR) || el;

    if (!container.hasAttribute(CLICK_MARKER)) {
      container.setAttribute(CLICK_MARKER, '1');
      container.addEventListener(
        'click',
        () => {
          primeBlockedCheck(container, videoId);
          waitForIframe(container);
        },
        true
      );
    }

    getOrCreateState(container, videoId);
    const iframe = findYoutubeIframe(container);
    if (iframe) attachIframe(iframe);
  }

  function attachLiteElement(lite) {
    if (!(lite instanceof Element) || !isValidMount(lite)) return;
    const videoId =
      lite.getAttribute('videoid') ||
      lite.getAttribute('video-id') ||
      extractId(lite.getAttribute('src') || '');
    if (!isVideoId(videoId)) return;

    if (!lite.hasAttribute(CLICK_MARKER)) {
      lite.setAttribute(CLICK_MARKER, '1');
      lite.addEventListener(
        'click',
        () => {
          primeBlockedCheck(lite, videoId);
          waitForIframe(lite);
        },
        true
      );
    }

    const state = getOrCreateState(lite, videoId);
    if (!state) return;
    const iframe = findYoutubeIframe(lite);
    if (iframe) linkIframe(state, iframe);
  }

  // --- old.reddit ------------------------------------------------------------

  function clearNoEmbedTimer(thing) {
    const t = noEmbedTimers.get(thing);
    if (t != null) {
      clearTimeout(t);
      noEmbedTimers.delete(thing);
    }
  }

  function insertOldRedditWatchLink(thing, videoId) {
    if (thing.querySelector('.yt-embed-reddit-fallback')) return;
    if (thing.querySelector(REDDITMEDIA_IFRAME_SELECTOR)) return;

    const entry = thing.querySelector(':scope > .entry') || thing.querySelector('.entry');
    if (!entry) return;

    const bar = document.createElement('div');
    bar.className = 'yt-embed-reddit-fallback';
    bar.innerHTML =
      `<a class="yt-embed-reddit-cta" href="${watchUrl(videoId)}" target="_blank" rel="noopener noreferrer">` +
      YT_ICON +
      '<span>Watch on YouTube</span></a>';

    const topMatter = entry.querySelector(':scope > .top-matter');
    if (topMatter) topMatter.insertAdjacentElement('afterend', bar);
    else entry.appendChild(bar);
  }

  function scheduleOldRedditNoEmbedFallback(thing, videoId) {
    if (thing.querySelector('.yt-embed-reddit-fallback')) return;
    if (noEmbedTimers.has(thing)) return;

    const timer = setTimeout(() => {
      noEmbedTimers.delete(thing);
      if (!thing.isConnected) return;
      if (thing.querySelector(REDDITMEDIA_IFRAME_SELECTOR)) {
        attachOldRedditYoutubeThing(thing);
        return;
      }
      if (thing.querySelector('.expando-button, .expando')) return;
      insertOldRedditWatchLink(thing, videoId);
    }, NO_EMBED_FALLBACK_MS);
    noEmbedTimers.set(thing, timer);
  }

  function attachOldRedditYoutubeThing(thing) {
    if (!(thing instanceof Element)) return;

    const url = thing.getAttribute('data-url') || '';
    const domain = (thing.getAttribute('data-domain') || '').toLowerCase();
    if (!isYoutubePageUrl(url) && !/^(youtu\.be|youtube\.com)$/i.test(domain)) return;

    const videoId = extractId(url);
    if (!videoId) return;

    const btn = thing.querySelector('.expando-button');
    if (btn && !btn.hasAttribute(CLICK_MARKER)) {
      btn.setAttribute(CLICK_MARKER, '1');
      btn.addEventListener(
        'click',
        () => {
          clearNoEmbedTimer(thing);
          setTimeout(() => attachOldRedditYoutubeThing(thing), 150);
        },
        true
      );
    }

    const mediaEmbed = thing.querySelector(REDDITMEDIA_IFRAME_SELECTOR);
    if (mediaEmbed) {
      clearNoEmbedTimer(thing);
      thing.querySelector('.yt-embed-reddit-fallback')?.remove();
      const shell = ensurePlayerShell(mediaEmbed);
      if (!shell) return;
      attachFacadeMount(shell, videoId);
      return;
    }

    if (thing.querySelector('.expando-button, .expando')) {
      clearNoEmbedTimer(thing);
      return;
    }

    scheduleOldRedditNoEmbedFallback(thing, videoId);
  }

  function attachRedditMediaIframe(iframe) {
    if (!(iframe instanceof HTMLIFrameElement)) return;
    if (!isRedditMediaIframeEl(iframe)) return;
    const thing = iframe.closest('.thing');
    if (!thing) return;

    const url = thing.getAttribute('data-url') || '';
    const domain = (thing.getAttribute('data-domain') || '').toLowerCase();
    if (!isYoutubePageUrl(url) && !/^(youtu\.be|youtube\.com)$/i.test(domain)) return;
    const videoId = extractId(url);
    if (!videoId) return;

    const shell = ensurePlayerShell(iframe);
    if (!shell) return;
    attachFacadeMount(shell, videoId);
  }

  // --- shadow / reddit new ---------------------------------------------------

  function attachShadowHost(host) {
    const shadow = host.shadowRoot;
    if (!shadow) return false;
    injectStyles(shadow);

    const lite = shadow.querySelector(LITE_SELECTOR);
    if (lite && isValidMount(lite)) {
      const videoId =
        lite.getAttribute('videoid') ||
        lite.getAttribute('video-id') ||
        extractId(host.getAttribute('html') || '');
      if (!isVideoId(videoId)) return false;

      const existing = mountStates.get(lite);
      if (lite.hasAttribute(MARKER) && existing?.videoId && existing.videoId !== videoId) {
        if (existing.iframeId) stateByIframeId.delete(existing.iframeId);
        lite.removeAttribute(MARKER);
        mountStates.delete(lite);
      }

      if (!lite.hasAttribute(CLICK_MARKER)) {
        lite.setAttribute(CLICK_MARKER, '1');
        lite.addEventListener(
          'click',
          () => {
            primeBlockedCheck(lite, videoId);
            waitForIframe(shadow);
          },
          true
        );
      }

      const state = getOrCreateState(lite, videoId);
      if (!state) return false;
      const iframe = findYoutubeIframe(shadow);
      if (iframe) linkIframe(state, iframe);
      return true;
    }

    const iframe = findYoutubeIframe(shadow);
    if (iframe) {
      attachIframe(iframe);
      return true;
    }
    return false;
  }

  function startShadowObserver(host, shadow) {
    if (host.hasAttribute(SHADOW_OBS_MARKER)) return;
    host.setAttribute(SHADOW_OBS_MARKER, '1');
    const observer = new MutationObserver(() => {
      attachShadowHost(host);
    });
    observer.observe(shadow, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'data-src', 'videoid', 'html'],
    });
  }

  function watchShadowHost(host) {
    if (!(host instanceof Element)) return;

    if (!host.hasAttribute(SHADOW_WATCH_MARKER)) {
      host.setAttribute(SHADOW_WATCH_MARKER, '1');
      host.addEventListener(
        'click',
        () => {
          attachShadowHost(host);
          const shadow = host.shadowRoot;
          if (!shadow) return;
          const lite = shadow.querySelector(LITE_SELECTOR);
          const videoId =
            lite?.getAttribute('videoid') ||
            lite?.getAttribute('video-id') ||
            extractId(host.getAttribute('html') || '');
          if (lite && isVideoId(videoId)) primeBlockedCheck(lite, videoId);
          waitForIframe(shadow);
        },
        true
      );
    }

    if (!viewportObserver) {
      viewportObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) attachShadowHost(entry.target);
          }
        },
        { rootMargin: '300px' }
      );
    }
    viewportObserver.observe(host);

    const boot = (attempts = 0) => {
      const shadow = host.shadowRoot;
      if (!shadow) {
        if (attempts < 120) requestAnimationFrame(() => boot(attempts + 1));
        return;
      }
      attachShadowHost(host);
      startShadowObserver(host, shadow);
    };
    boot();
  }

  function discoverOpenShadowEmbeds(root) {
    if (!root?.querySelectorAll) return;
    // Prefer custom elements (hyphenated tags) — cheaper than every node on huge pages
    const customs = root.querySelectorAll('*');
    for (const el of customs) {
      if (!el.tagName || !el.tagName.includes('-')) continue;
      if (el.hasAttribute(SHADOW_WATCH_MARKER)) continue;
      const shadow = el.shadowRoot;
      if (!shadow) continue;
      if (
        shadow.querySelector(
          'iframe[src*="youtube"], iframe[data-src*="youtube"], lite-youtube'
        )
      ) {
        safeCall(watchShadowHost, el);
      }
    }
  }

  // --- scan / observe --------------------------------------------------------

  function safeCall(fn, arg) {
    try {
      fn(arg);
    } catch {
      /* never abort the whole scan */
    }
  }

  function isDocumentRoot(root) {
    return root === document || root === document.documentElement || root === document.body;
  }

  function scan(root = document) {
    if (!root?.querySelectorAll) return;

    root.querySelectorAll(YOUTUBE_IFRAME_SELECTOR).forEach((el) => safeCall(attachIframe, el));
    root.querySelectorAll(REDDITMEDIA_IFRAME_SELECTOR).forEach((el) =>
      safeCall(attachRedditMediaIframe, el)
    );
    root.querySelectorAll(LITE_SELECTOR).forEach((el) => safeCall(attachLiteElement, el));
    root.querySelectorAll(LAZY_EMBED_SELECTOR).forEach((el) => safeCall(attachLazyEmbed, el));
    root.querySelectorAll(DATA_IFRAME_SELECTOR).forEach((el) => safeCall(attachDataIframeEmbed, el));
    root.querySelectorAll(YTIMG_SELECTOR).forEach((el) => safeCall(attachYtimgFacade, el));
    root.querySelectorAll(OLD_REDDIT_THING_SELECTOR).forEach((el) =>
      safeCall(attachOldRedditYoutubeThing, el)
    );
    root.querySelectorAll(SHADOW_HOST_SELECTOR).forEach((el) => safeCall(watchShadowHost, el));

    if (isDocumentRoot(root)) {
      discoverOpenShadowEmbeds(document);
    } else if (root instanceof Element && root.shadowRoot) {
      safeCall(watchShadowHost, root);
    }
  }

  function scheduleScan(root) {
    if (root && root !== document && root.nodeType === 1) {
      if (!needFullScan) {
        if (!pendingScanRoots) pendingScanRoots = new Set();
        pendingScanRoots.add(root);
      }
    } else {
      needFullScan = true;
      pendingScanRoots = null;
    }

    if (scanTimer != null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const full = needFullScan;
      const roots = pendingScanRoots;
      needFullScan = false;
      pendingScanRoots = null;
      if (full || !roots) {
        scan(document);
        return;
      }
      for (const r of roots) {
        if (r.isConnected !== false) scan(r);
      }
    }, SCAN_DEBOUNCE_MS);
  }

  function handleYoutubeMessage(event) {
    let originHost;
    try {
      originHost = new URL(event.origin).hostname;
    } catch {
      return;
    }
    if (!isYoutubeHost(originHost)) {
      return;
    }

    let data = event.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (!data || typeof data !== 'object') return;

    const iframeId = data.id;
    if (!iframeId) return;

    let state = stateByIframeId.get(iframeId);
    if (!state) {
      const iframe = document.getElementById(iframeId);
      if (iframe instanceof HTMLIFrameElement) state = states.get(iframe);
    }
    if (!state) return;

    if (data.event === 'infoDelivery' && data.info && typeof data.info === 'object') {
      const time = data.info.currentTime;
      const playerState = data.info.playerState;
      // 1 = playing
      if (typeof time === 'number' && time > MIN_PLAYBACK_SECONDS && playerState === 1) {
        hideBlocked(state);
      }
      return;
    }

    if (data.event === 'onError') {
      state.userActivated = true;
      showBlocked(state);
    }
  }

  function start() {
    injectStyles();
    window.addEventListener('message', handleYoutubeMessage, true);

    const runScan = () => scheduleScan(document);
    if (document.documentElement) runScan();
    else document.addEventListener('DOMContentLoaded', runScan, { once: true });

    const observer = new MutationObserver((mutations) => {
      let needFull = false;
      const roots = new Set();

      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          const t = mutation.target;
          if (t instanceof HTMLIFrameElement) {
            // Only clear enhance marker when the URL actually changed to a new value
            if (mutation.attributeName === 'src' || mutation.attributeName === 'data-src') {
              const prev = mutation.oldValue;
              const cur =
                mutation.attributeName === 'src'
                  ? t.getAttribute('src')
                  : t.getAttribute('data-src');
              if (prev !== cur) t.removeAttribute(ENHANCED_MARKER);
            }
            attachIframe(t);
            attachRedditMediaIframe(t);
          }
          continue;
        }

        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLIFrameElement) {
            attachIframe(node);
            attachRedditMediaIframe(node);
          } else if (node instanceof Element) {
            roots.add(node);
          } else if (node instanceof DocumentFragment) {
            needFull = true;
          }
        }
      }

      if (needFull) scheduleScan(document);
      else for (const r of roots) scheduleScan(r);
    });

    const observe = () => {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'data-src'],
        attributeOldValue: true,
      });
      runScan();
    };

    if (document.documentElement) observe();
    else document.addEventListener('DOMContentLoaded', observe, { once: true });
  }

  start();
})();
