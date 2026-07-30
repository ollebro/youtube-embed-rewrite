// ==UserScript==
// @name         Watch on YouTube — Blocked Embeds
// @namespace    https://greasyfork.org/users/1621606-ollebro
// @version      5.5.3
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
  const ACTIVATE_MARKER = 'data-yt-watch-activate';
  const LOAD_MARKER = 'data-yt-watch-load';
  const ENHANCED_MARKER = 'data-yt-watch-enhanced';
  const SHADOW_OBS_MARKER = 'data-yt-watch-shadow-obs';
  const SHADOW_WATCH_MARKER = 'data-yt-watch-shadow-watch';
  const OVERLAY_CLASS = 'yt-embed-center-overlay';
  const HIT_CLASS = 'yt-embed-hit';
  const STYLE_ID = 'yt-embed-overlay-style';

  // Works on any page (global @match). Universal paths:
  //   live iframes, lite-youtube, lazy CMS facades (data-iframe JSON, ytimg thumbs),
  //   open-shadow hosts, wrapper embeds (e.g. old.reddit redditmedia → youtu.be data-url).
  //
  // Detection layers (best then fallback):
  // 1) IFrame API via enablejsapi + postMessage (play / onError) when available
  // 2) Local timer ONLY after a real user gesture on the player (never auto)
  // Escape hatch is always a first-party youtube.com/watch link.
  // Overlay always mounts on a tight player shell — never full-page wrappers.
  /** Fallback timer after the user tries to play (not on passive load). */
  const BLOCKED_DELAY_MS = 2000;
  const DEFAULT_SHELL_W = 640;
  const DEFAULT_SHELL_H = 360;
  const MAX_SHELL_W = 960;
  const MAX_SHELL_H = 540;
  /** Wait for late redditmedia injection before offering a no-embed fallback. */
  const NO_EMBED_FALLBACK_MS = 2500;
  const MIN_PLAYBACK_SECONDS = 0.3;
  const WAIT_IFRAME_MS = 15000;
  const SCAN_DEBOUNCE_MS = 80;

  /** iframe element -> state */
  const states = new WeakMap();
  /** mount element -> state */
  const mountStates = new WeakMap();
  /** iframe id -> state (works across open shadow roots; getElementById does not) */
  const stateByIframeId = new Map();
  /** old.reddit thing element -> pending no-embed fallback timer */
  const noEmbedTimers = new WeakMap();

  let idSeq = 0;
  let scanTimer = null;
  /** @type {Set<Element> | null} */
  let pendingScanRoots = null;
  let needFullScan = false;
  let viewportObserver = null;

  const ID_PATTERNS = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/vi\/([a-zA-Z0-9_-]{11})\//,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];

  /** Lazy hosts that store a video id before creating an iframe (generic + common CMS). */
  const LAZY_EMBED_SELECTOR = [
    'f-embed[data-type="youtube"][data-id]',
    '[data-type="youtube"][data-id]',
    '.youtube-player[data-id]',
    '[data-youtube-id]',
    '[data-video-id][data-provider="youtube"]',
  ].join(', ');

  /** Config JSON on the element (e.g. Adobe AEM cmp-embed data-iframe). */
  const DATA_IFRAME_SELECTOR = '[data-iframe]';
  /** YouTube poster thumbnails used as click-to-load facades. */
  const YTIMG_SELECTOR =
    'img[src*="i.ytimg.com/vi/"], img[src*="img.youtube.com/vi/"], source[srcset*="i.ytimg.com/vi/"]';

  /** Cheap known open-shadow hosts; full scans also discover other custom elements. */
  const SHADOW_HOST_SELECTOR = 'shreddit-embed';
  const LITE_SELECTOR = 'lite-youtube';
  /** old.reddit link posts (YouTube URL on data-url; player is redditmedia iframe). */
  const OLD_REDDIT_THING_SELECTOR = 'div.thing[data-url], div.thing.link';
  const REDDITMEDIA_IFRAME_SELECTOR =
    'iframe.media-embed[src*="redditmedia.com/mediaembed"], iframe[src*="redditmedia.com/mediaembed"]';

  const STYLE_CSS = `
    /* Tight box around the actual player — never the full page/column */
    .yt-embed-player-shell {
      position: relative !important;
      display: inline-block;
      max-width: 100%;
      vertical-align: top;
      line-height: 0;
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
    /*
     * Cross-origin iframes swallow clicks (parent never sees them).
     * Transparent catcher on top of the player arms the blocked timer on first try,
     * then disables itself so further clicks reach the iframe.
     */
    .${HIT_CLASS} {
      position: absolute;
      inset: 0;
      z-index: 2;
      background: transparent;
      cursor: pointer;
      pointer-events: auto;
    }
    .${HIT_CLASS}.is-armed {
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
    /* old.reddit: no embed available — small CTA, not a blocking overlay */
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

  /** Parse CMS JSON blobs (data-iframe, data-layer) for a YouTube video id. */
  function videoIdFromConfigObject(obj, depth = 0) {
    if (!obj || depth > 6) return null;
    if (typeof obj === 'string') return extractId(obj) || (isVideoId(obj) ? obj : null);
    if (typeof obj !== 'object') return null;

    const directKeys = [
      'youtubeCepVideoId',
      'youtubeVideoId',
      'videoId',
      'videoid',
      'youtubeId',
      'ytId',
      'id',
    ];
    for (const key of directKeys) {
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
    if (obj.type && String(obj.type).toLowerCase() === 'youtube' && typeof obj.src === 'string') {
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

  function parseJsonAttr(el, name) {
    const raw = el.getAttribute?.(name);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      // HTML-entity-encoded quotes sometimes appear in static markup
      try {
        const decoded = raw
          .replace(/&quot;/g, '"')
          .replace(/&#34;/g, '"')
          .replace(/&amp;/g, '&');
        return JSON.parse(decoded);
      } catch {
        return null;
      }
    }
  }

  function videoIdFromElementConfig(el) {
    if (!(el instanceof Element)) return null;

    const fromIframeAttr = videoIdFromConfigObject(parseJsonAttr(el, 'data-iframe'));
    if (fromIframeAttr) return fromIframeAttr;

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
    // Never stretch to full page column; cap oversized readings.
    if (width > MAX_SHELL_W || height > MAX_SHELL_H) {
      const scale = Math.min(MAX_SHELL_W / width, MAX_SHELL_H / height, 1);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    // Reject full-viewport takeover — fall back to defaults.
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

  /**
   * Wrap a media element in a tight shell so the overlay only covers the player,
   * not a full-width column / page section. Never uses width:100% of a page wrapper.
   */
  function ensurePlayerShell(mediaEl) {
    if (!(mediaEl instanceof Element)) return null;

    const existing = mediaEl.closest?.('.yt-embed-player-shell');
    if (existing) {
      // Re-clamp if a previous version sized it to full viewport.
      const r = existing.getBoundingClientRect();
      if (
        r.width >= (window.innerWidth || 0) * 0.92 &&
        r.height >= (window.innerHeight || 0) * 0.7
      ) {
        const { width, height } = clampShellSize(DEFAULT_SHELL_W, DEFAULT_SHELL_H);
        existing.style.width = `${width}px`;
        existing.style.height = `${height}px`;
        existing.style.maxWidth = '100%';
      }
      return existing;
    }
    if (mediaEl.classList?.contains('yt-embed-player-shell')) return mediaEl;

    const parent = mediaEl.parentElement;
    if (!parent) return null;

    const wrap = document.createElement('div');
    wrap.className = 'yt-embed-player-shell';

    const attrW = parseInt(mediaEl.getAttribute?.('width') || '', 10);
    const attrH = parseInt(mediaEl.getAttribute?.('height') || '', 10);
    const rect = mediaEl.getBoundingClientRect?.();
    const rawW = attrW > 0 ? attrW : Math.round(rect?.width || mediaEl.offsetWidth || 0);
    const rawH = attrH > 0 ? attrH : Math.round(rect?.height || mediaEl.offsetHeight || 0);
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

  /** Reject mounts that are basically the whole viewport / content column. */
  function isReasonablePlayerMount(el, mediaEl) {
    if (!(el instanceof Element)) return false;
    if (el === document.body || el === document.documentElement) return false;
    // Structural page chrome — never valid player boxes
    if (
      el.matches?.(
        'body, html, main, #content, #siteTable, .side, .content, .expando, .entry, .thing'
      )
    ) {
      return false;
    }
    // Our shell is always OK
    if (el.classList.contains('yt-embed-player-shell')) return true;

    const er = el.getBoundingClientRect();
    if (er.width < 40 || er.height < 40) return true; // not laid out yet

    // Full-viewport takeover (both axes)
    if (
      typeof window !== 'undefined' &&
      er.width >= window.innerWidth * 0.92 &&
      er.height >= window.innerHeight * 0.7
    ) {
      return false;
    }

    // Mount much larger than the media it wraps
    if (mediaEl instanceof Element) {
      const mr = mediaEl.getBoundingClientRect();
      if (mr.width > 40 && mr.height > 40) {
        if (er.width > mr.width * 1.6 || er.height > mr.height * 1.6) return false;
      }
    }
    return true;
  }

  /**
   * Wire a player-sized mount. Click/pointer on it starts the blocked timer.
   * Never auto-shows the overlay without a user gesture.
   */
  function attachFacadeMount(mount, videoId) {
    if (!isValidMount(mount) || !isVideoId(videoId)) return null;

    // Prefer existing player iframe inside the facade (tight shell only).
    const innerIframe =
      findYoutubeIframe(mount) ||
      (mount.matches?.(REDDITMEDIA_IFRAME_SELECTOR)
        ? mount
        : null) ||
      mount.querySelector?.(REDDITMEDIA_IFRAME_SELECTOR) ||
      mount.querySelector?.('iframe.media-embed');

    let target = mount;
    if (innerIframe instanceof HTMLIFrameElement) {
      const shell = ensurePlayerShell(innerIframe);
      if (shell) target = shell;
    } else if (!isReasonablePlayerMount(mount)) {
      // Do not mount on oversized wrappers (full-width .expando etc.)
      return null;
    }

    if (!isValidMount(target) || !isReasonablePlayerMount(target, innerIframe || null)) {
      // Still too big — force a default-sized shell around media if possible
      if (innerIframe instanceof HTMLIFrameElement) {
        target = ensurePlayerShell(innerIframe);
      } else {
        return null;
      }
    }
    if (!isValidMount(target)) return null;

    const state = getOrCreateState(target, videoId);
    if (!state) return null;
    // getOrCreateState installs the hit-layer catcher (needed for cross-origin iframes)

    const iframe = findYoutubeIframe(target);
    if (iframe) linkIframe(state, iframe);
    return target;
  }

  /** Adobe AEM / generic: data-iframe JSON with type youtube + src. */
  function attachDataIframeEmbed(el) {
    if (!(el instanceof Element)) return;
    const cfg = parseJsonAttr(el, 'data-iframe');
    if (!cfg) {
      // Attribute contains youtube but is not JSON — try extractId
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

  /** Click-to-load posters (i.ytimg.com/vi/ID/...) inside embed-like containers. */
  function attachYtimgFacade(node) {
    if (!(node instanceof Element)) return;
    const ref =
      node.getAttribute('src') ||
      node.getAttribute('srcset') ||
      '';
    const videoId = extractId(ref);
    if (!videoId) return;

    const candidates = [
      node.closest(DATA_IFRAME_SELECTOR),
      node.closest('.cmp-embed__youtube'),
      node.closest('.cmp-embed'),
      node.closest('.wp-block-embed-youtube, .youtube-player, .yt-container'),
      node.closest('picture')?.parentElement,
    ].filter(Boolean);

    // Prefer the smallest reasonable candidate (player box, not page chrome).
    let mount = null;
    for (const c of candidates) {
      if (isValidMount(c) && isReasonablePlayerMount(c, node)) {
        mount = c;
        break;
      }
    }
    if (!mount) {
      // Tight shell around the poster itself.
      mount = ensurePlayerShell(node.closest('picture') || node);
    }

    if (!mount || !isValidMount(mount)) return;
    // Avoid wiring random ytimg icons/avatars without embed context.
    if (
      !mount.hasAttribute('data-iframe') &&
      !mount.classList.contains('yt-embed-player-shell') &&
      !/embed|youtube|player|video|thumbnail/i.test(mount.className || '') &&
      !mount.closest('.cmp-embed, .embed, .cmp-embed__youtube, .expando, .media-preview')
    ) {
      return;
    }

    const cfgHost = node.closest(DATA_IFRAME_SELECTOR) || mount;
    attachFacadeMount(mount, videoIdFromElementConfig(cfgHost) || videoId);
  }

  function iframeSrc(iframe) {
    return iframe.src || iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
  }

  function isYoutubeHost(hostname) {
    return /(?:^|\.)youtube(?:-nocookie)?\.com$/i.test(hostname || '');
  }

  function watchUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  /**
   * Prefer www over nocookie when rewriting, and enable the IFrame API so play/error
   * postMessages work when the environment allows them. If messages never arrive,
   * the interaction timer still shows the overlay (fallback).
   */
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

  const YT_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
    '<path d="M23.5 6.2c-.3-.9-1.1-1.6-2-1.8C19.2 4 12 4 12 4s-7.2 0-9.5.4c-.9.2-1.7.9-2 1.8C0 8.5 0 12 0 12s0 3.5.5 5.8c.3.9 1.1 1.6 2 1.8 2.3.4 9.5.4 9.5.4s7.2 0 9.5-.4c.9-.2 1.7-.9 2-1.8.5-2.3.5-5.8.5-5.8s0-3.5-.5-5.8zM9.6 15.6V8.4L15.8 12l-6.2 3.6z"/>' +
    '</svg>';

  function ensureRelative(el) {
    if (el && getComputedStyle(el).position === 'static') {
      el.style.position = 'relative';
    }
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

      const dismiss = overlay.querySelector('.yt-embed-dismiss');
      dismiss?.addEventListener('click', (e) => {
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

  function clearTimer(state) {
    if (!state.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
  }

  function setIframeHidden(iframe, hidden) {
    if (!iframe) return;
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

  function showBlocked(state) {
    if (state.playing || state.blockedShown || state.dismissed) return;
    clearTimer(state);
    state.blockedShown = true;
    state.mount.classList.add('is-blocked');
    state.overlay.classList.add('is-visible');
    state.mount.appendChild(state.overlay);
    setIframeHidden(state.iframe, true);
    // Also hide any nested media iframes (redditmedia, etc.)
    state.mount.querySelectorAll('iframe').forEach((f) => setIframeHidden(f, true));
    const hit = state.mount.querySelector(`:scope > .${HIT_CLASS}`);
    if (hit) hit.classList.add('is-armed');

    const link = state.overlay.querySelector('.yt-embed-center-link');
    try {
      link?.focus({ preventScroll: true });
    } catch {
      link?.focus();
    }
  }

  function hideBlocked(state) {
    state.blockedShown = false;
    state.playing = true;
    state.mount.classList.remove('is-blocked');
    state.overlay.classList.remove('is-visible');
    setIframeHidden(state.iframe, false);
    clearTimer(state);
  }

  function dismissBlocked(state) {
    state.dismissed = true;
    state.blockedShown = false;
    state.mount.classList.remove('is-blocked');
    state.overlay.classList.remove('is-visible');
    setIframeHidden(state.iframe, false);
    clearTimer(state);
  }

  /**
   * Fallback “is it blocked?” signal: local timer after user interaction.
   * Prefer API play/error messages when they work; if they never arrive (or are
   * stripped by privacy tooling), this still surfaces the escape hatch.
   * MUST NOT run without userActivated (never auto on page load).
   */
  function scheduleBlockedCheck(state) {
    if (state.playing || state.blockedShown || state.dismissed || state.timer) return;
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
    // Shells are always OK; reject only huge non-shell mounts.
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

  /**
   * Clicks on cross-origin iframes never bubble to the parent page.
   * A transparent hit layer captures the first interaction, arms the timer,
   * then lets further clicks through to the iframe.
   */
  function ensureInteractionCatcher(mount, videoId) {
    if (!isValidMount(mount) || !isVideoId(videoId)) return;
    if (mount.querySelector(`:scope > .${HIT_CLASS}`)) return;

    ensureRelative(mount);
    const hit = document.createElement('div');
    hit.className = HIT_CLASS;
    hit.setAttribute('aria-hidden', 'true');
    hit.title = 'Click to play';

    const arm = () => {
      if (hit.classList.contains('is-armed')) return;
      hit.classList.add('is-armed');
      primeBlockedCheck(mount, videoId);
      // Re-scan for late iframe injection after the user tried to play
      waitForIframe(mount);
      const wrap =
        mount.closest('.cmp-embed, .cmp-embed__youtube, .embed, .expando') ||
        mount.parentElement;
      if (wrap && wrap !== mount) waitForIframe(wrap);
    };

    hit.addEventListener('pointerdown', arm, true);
    hit.addEventListener('click', arm, true);
    mount.appendChild(hit);
  }

  function isValidMount(mount) {
    if (!(mount instanceof Element)) return false;
    const tag = mount.tagName;
    return tag !== 'STYLE' && tag !== 'LINK' && tag !== 'SCRIPT';
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

    // Prefer existing page id so we do not break host postMessage wiring.
    if (iframe.id) {
      state.iframeId = iframe.id;
    } else {
      if (!state.iframeId) state.iframeId = nextIframeId(state.videoId);
      iframe.id = state.iframeId;
    }

    stateByIframeId.set(state.iframeId, state);
  }

  function enhanceIframeSrc(iframe) {
    if (!(iframe instanceof HTMLIFrameElement)) return;
    if (iframe.hasAttribute(ENHANCED_MARKER)) return;

    const raw = iframeSrc(iframe);
    if (!raw || !/youtube(-nocookie)?\.com/i.test(raw)) return;

    const next = enhanceEmbedSrc(raw);
    iframe.setAttribute(ENHANCED_MARKER, '1');
    if (!next || next === raw) return;

    // Prefer property assignment so the browser reloads with API enabled.
    if (iframe.getAttribute('src') || iframe.src) {
      iframe.src = next;
    } else if (iframe.getAttribute('data-src')) {
      iframe.setAttribute('data-src', next);
    }
  }

  function linkIframe(state, iframe) {
    if (!(iframe instanceof HTMLIFrameElement)) return;

    if (state.iframe === iframe) {
      enhanceIframeSrc(iframe);
      if (state.userActivated) scheduleBlockedCheck(state);
      return;
    }

    state.iframe = iframe;
    states.set(iframe, state);
    iframe.setAttribute(MARKER, state.videoId);
    registerIframeId(state, iframe);
    enhanceIframeSrc(iframe);

    if (!iframe.hasAttribute(LOAD_MARKER)) {
      iframe.setAttribute(LOAD_MARKER, '1');
      // Load alone does not mean blocked — only continue a user-started check.
      iframe.addEventListener('load', () => {
        if (state.userActivated) scheduleBlockedCheck(state);
      });
    }

    if (state.userActivated) scheduleBlockedCheck(state);
  }

  function getMountPoint(iframe) {
    // Always prefer a tight shell around the iframe so the overlay matches the player.
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
      iframe.closest('.cmp-embed__youtube'),
      iframe.closest('f-embed-youtube'),
      iframe.closest('f-embed[data-type="youtube"]'),
      iframe.closest('[data-type="youtube"]'),
      iframe.closest(
        [
          '.wp-block-embed-youtube',
          '.wp-block-embed.is-provider-youtube',
          '.jetpack-video-wrapper',
          '.video-player',
          '.youtube-player',
          '.youtube-container',
          '.yt-container',
          'figure.wp-block-embed',
        ].join(', ')
      ),
      iframe.parentElement,
    ];

    for (const c of candidates) {
      if (c && isValidMount(c) && isReasonablePlayerMount(c, iframe)) return c;
    }
    return iframe.parentElement;
  }

  function findYoutubeIframe(root) {
    return root?.querySelector?.('iframe[src*="youtube"], iframe[data-src*="youtube"]') || null;
  }

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

  function waitForIframe(container) {
    if (!container) return;

    const existing = findYoutubeIframe(container);
    if (existing) {
      attachIframe(existing);
      return;
    }

    const observer = new MutationObserver(() => {
      const iframe = findYoutubeIframe(container);
      if (!iframe) return;
      observer.disconnect();
      attachIframe(iframe);
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'data-src'],
    });

    setTimeout(() => observer.disconnect(), WAIT_IFRAME_MS);
  }

  function ensureLiteClickHandler(lite, waitRoot) {
    if (!lite || lite.hasAttribute(CLICK_MARKER)) return;
    lite.setAttribute(CLICK_MARKER, '1');
    lite.addEventListener(
      'click',
      () => {
        const videoId =
          lite.getAttribute('videoid') ||
          lite.getAttribute('video-id') ||
          extractId(lite.getAttribute('src') || '');
        if (videoId) primeBlockedCheck(lite, videoId);
        waitForIframe(waitRoot || lite);
      },
      true
    );
  }

  function liteVideoId(lite, host) {
    return (
      lite?.getAttribute('videoid') ||
      lite?.getAttribute('video-id') ||
      extractId(lite?.getAttribute('src') || '') ||
      extractId(host?.getAttribute?.('html') || '') ||
      null
    );
  }

  /** Light-DOM (or any) lite-youtube — common facades before the iframe exists. */
  function attachLiteElement(lite) {
    if (!(lite instanceof Element) || !isValidMount(lite)) return;
    const videoId = liteVideoId(lite);
    if (!videoId) return;

    ensureLiteClickHandler(lite, lite);
    const state = getOrCreateState(lite, videoId);
    if (!state) return;

    const iframe = findYoutubeIframe(lite);
    if (iframe) linkIframe(state, iframe);
  }

  function syncShadowIframe(host, shadow, lite) {
    const iframe = findYoutubeIframe(shadow);
    if (!iframe) return;
    if (lite) {
      const state = mountStates.get(lite);
      if (state) linkIframe(state, iframe);
      else attachIframe(iframe);
    } else {
      attachIframe(iframe);
    }
  }

  function attachShadowHost(host) {
    const shadow = host.shadowRoot;
    if (!shadow) return false;

    injectStyles(shadow);

    const lite = shadow.querySelector(LITE_SELECTOR);
    if (lite && isValidMount(lite)) {
      const videoId = liteVideoId(lite, host);
      if (!videoId) return false;

      const existing = mountStates.get(lite);
      if (lite.hasAttribute(MARKER) && existing?.videoId && existing.videoId !== videoId) {
        if (existing.iframeId) stateByIframeId.delete(existing.iframeId);
        lite.removeAttribute(MARKER);
        mountStates.delete(lite);
      }

      ensureLiteClickHandler(lite, shadow);

      if (lite.hasAttribute(MARKER)) {
        syncShadowIframe(host, shadow, lite);
        return true;
      }

      const state = getOrCreateState(lite, videoId);
      if (!state) return false;
      syncShadowIframe(host, shadow, lite);
      return true;
    }

    // Open shadow with a bare YouTube iframe (no lite-youtube facade).
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
      const lite = shadow.querySelector(LITE_SELECTOR);
      if (lite) syncShadowIframe(host, shadow, lite);
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
          const videoId = liteVideoId(lite, host);
          if (lite && videoId) primeBlockedCheck(lite, videoId);
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

    const boot = () => {
      const shadow = host.shadowRoot;
      if (!shadow) {
        requestAnimationFrame(boot);
        return;
      }
      attachShadowHost(host);
      startShadowObserver(host, shadow);
    };
    boot();
  }

  /**
   * Full-document only: find custom elements with open shadow that already
   * contain a YouTube embed (not limited to one site’s host tag).
   */
  function discoverOpenShadowEmbeds(root) {
    if (!root?.querySelectorAll) return;
    const nodes = root.querySelectorAll('*');
    for (const el of nodes) {
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

  function attachLazyEmbed(el) {
    const videoId =
      el.dataset?.id ||
      el.getAttribute('data-youtube-id') ||
      el.getAttribute('data-video-id') ||
      el.dataset?.youtubeId;
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return;

    const type = (el.dataset?.type || el.getAttribute('data-provider') || '').toLowerCase();
    if (type && type !== 'youtube') return;
    // data-youtube-id alone is enough; data-video-id needs provider=youtube (selector).

    const container =
      el.querySelector('f-embed-youtube') ||
      el.querySelector(LITE_SELECTOR) ||
      el;

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

  function isYoutubePageUrl(url) {
    if (!url) return false;
    return /(?:youtube\.com|youtu\.be)\b/i.test(url);
  }

  function isVisibleBox(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * old.reddit YouTube link posts (data-url → youtu.be):
   * A) Media embed iframe present → shell + hit layer; overlay only after click+timeout
   * B) No embed ever → small non-blocking Watch link (never auto dark-overlay)
   */
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
          // User is expanding media — cancel any pending no-embed CTA
          clearNoEmbedTimer(thing);
          setTimeout(() => attachOldRedditYoutubeThing(thing), 150);
        },
        true
      );
    }

    const mediaEmbed = thing.querySelector(REDDITMEDIA_IFRAME_SELECTOR);
    if (mediaEmbed) {
      clearNoEmbedTimer(thing);
      // Remove no-embed fallback if Reddit injected a real player
      thing.querySelector('.yt-embed-reddit-fallback')?.remove();
      const shell = ensurePlayerShell(mediaEmbed);
      if (!shell) return;
      attachFacadeMount(shell, videoId);
      return;
    }

    // Expando controls present → user can still open the player; don't steal play.
    if (thing.querySelector('.expando-button, .expando')) {
      clearNoEmbedTimer(thing);
      return;
    }

    // No player yet — wait before offering a small fallback link (late embeds).
    scheduleOldRedditNoEmbedFallback(thing, videoId);
  }

  function clearNoEmbedTimer(thing) {
    const t = noEmbedTimers.get(thing);
    if (t != null) {
      clearTimeout(t);
      noEmbedTimers.delete(thing);
    }
  }

  function scheduleOldRedditNoEmbedFallback(thing, videoId) {
    if (thing.querySelector('.yt-embed-reddit-fallback')) return;
    if (noEmbedTimers.has(thing)) return;

    const timer = setTimeout(() => {
      noEmbedTimers.delete(thing);
      if (!thing.isConnected) return;
      // Media or expand control appeared in the meantime
      if (thing.querySelector(REDDITMEDIA_IFRAME_SELECTOR)) {
        attachOldRedditYoutubeThing(thing);
        return;
      }
      if (thing.querySelector('.expando-button, .expando')) return;
      insertOldRedditWatchLink(thing, videoId);
    }, NO_EMBED_FALLBACK_MS);

    noEmbedTimers.set(thing, timer);
  }

  /**
   * Compact non-blocking CTA under the title — not a full dark overlay.
   * Only used when Reddit never provides an in-page player.
   */
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

  function attachRedditMediaIframe(iframe) {
    if (!(iframe instanceof HTMLIFrameElement)) return;
    const src = iframeSrc(iframe);
    if (!/redditmedia\.com\/mediaembed/i.test(src) && !iframe.classList.contains('media-embed')) {
      return;
    }
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
    // No auto-prime — wait for user gesture on the shell.
  }

  function safeCall(fn, arg) {
    try {
      fn(arg);
    } catch {
      /* never let one bad node abort the whole scan */
    }
  }

  function isDocumentRoot(root) {
    return (
      root === document ||
      root === document.documentElement ||
      root === document.body
    );
  }

  function scan(root = document) {
    if (!root?.querySelectorAll) return;

    // Universal path first: any YouTube iframe in this root.
    root.querySelectorAll('iframe[src*="youtube"], iframe[data-src*="youtube"]').forEach((el) =>
      safeCall(attachIframe, el)
    );
    // old.reddit media wrapper (not youtube.com — opaque redditmedia embed).
    root.querySelectorAll(REDDITMEDIA_IFRAME_SELECTOR).forEach((el) =>
      safeCall(attachRedditMediaIframe, el)
    );
    root.querySelectorAll(LITE_SELECTOR).forEach((el) => safeCall(attachLiteElement, el));
    root.querySelectorAll(LAZY_EMBED_SELECTOR).forEach((el) => safeCall(attachLazyEmbed, el));
    // Lazy facades: config JSON / CMS thumbs before an iframe exists (AEM, etc.).
    root.querySelectorAll(DATA_IFRAME_SELECTOR).forEach((el) => safeCall(attachDataIframeEmbed, el));
    root.querySelectorAll(YTIMG_SELECTOR).forEach((el) => safeCall(attachYtimgFacade, el));
    root.querySelectorAll(OLD_REDDIT_THING_SELECTOR).forEach((el) =>
      safeCall(attachOldRedditYoutubeThing, el)
    );
    root.querySelectorAll(SHADOW_HOST_SELECTOR).forEach((el) => safeCall(watchShadowHost, el));

    // Open shadow is invisible to normal querySelectorAll from outside.
    if (isDocumentRoot(root)) {
      discoverOpenShadowEmbeds(document);
    } else if (root instanceof Element && root.shadowRoot) {
      safeCall(watchShadowHost, root);
    }
  }

  /**
   * Debounced scan. Full-document requests are sticky: a later partial root
   * must not cancel an earlier full scan (SPA mutations used to demote it).
   */
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

  /**
   * Preferred when available: real play → hide overlay; onError → show it.
   * If privacy tooling blocks these messages, scheduleBlockedCheck still runs.
   */
  function handleYoutubeMessage(event) {
    if (!/https?:\/\/([a-z0-9-]+\.)?(youtube\.com|youtube-nocookie\.com)/i.test(event.origin)) {
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
            // Allow re-enhance only if host swapped src without our marker cleanup.
            if (mutation.attributeName === 'src' || mutation.attributeName === 'data-src') {
              t.removeAttribute(ENHANCED_MARKER);
            }
            attachIframe(t);
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

      if (needFull) {
        scheduleScan(document);
      } else {
        for (const r of roots) scheduleScan(r);
      }
    });

    const observe = () => {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'data-src'],
      });
      runScan();
    };

    if (document.documentElement) observe();
    else document.addEventListener('DOMContentLoaded', observe, { once: true });
  }

  start();
})();
