// ==UserScript==
// @name         Watch on YouTube — Blocked Embeds
// @namespace    https://greasyfork.org/users/1621606-ollebro
// @version      5.3.0
// @description  On any site: when a YouTube embed won’t play, show Watch on YouTube. Prefers player API signals; falls back to a local timer if those are blocked.
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
  const STYLE_ID = 'yt-embed-overlay-style';

  // Works on any page (global @match). Universal paths:
  //   live iframes, lite-youtube, lazy CMS facades (data-iframe JSON, ytimg thumbs),
  //   open-shadow hosts. Site-specific class names are helpers only.
  //
  // Detection layers (best then fallback):
  // 1) IFrame API via enablejsapi + postMessage (play / onError) when available
  // 2) Local timer after user interaction if API messages never arrive
  // Escape hatch is always a first-party youtube.com/watch link.
  /** Fallback timer after the user tries to play (not on passive load). */
  const BLOCKED_DELAY_MS = 2000;
  const MIN_PLAYBACK_SECONDS = 0.3;
  const WAIT_IFRAME_MS = 15000;
  const SCAN_DEBOUNCE_MS = 80;

  /** iframe element -> state */
  const states = new WeakMap();
  /** mount element -> state */
  const mountStates = new WeakMap();
  /** iframe id -> state (works across open shadow roots; getElementById does not) */
  const stateByIframeId = new Map();

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

  const STYLE_CSS = `
    .yt-embed-mount {
      position: relative;
    }
    .${OVERLAY_CLASS} {
      position: absolute;
      inset: 0;
      z-index: 2147483647;
      display: none;
      align-items: center;
      justify-content: center;
      background: #0f0f0f;
      pointer-events: auto;
      text-align: center;
      padding: 16px;
      box-sizing: border-box;
    }
    .${OVERLAY_CLASS}.is-visible {
      display: flex !important;
    }
    .yt-embed-mount.is-blocked iframe {
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
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

  /**
   * Wire a lazy facade (thumbnail / config, iframe created later or never).
   * Click starts the blocked timer even if no iframe appears.
   */
  function attachFacadeMount(mount, videoId) {
    if (!isValidMount(mount) || !isVideoId(videoId)) return;

    const state = getOrCreateState(mount, videoId);
    if (!state) return;

    if (!mount.hasAttribute(CLICK_MARKER)) {
      mount.setAttribute(CLICK_MARKER, '1');
      mount.addEventListener(
        'click',
        () => {
          primeBlockedCheck(mount, videoId);
          waitForIframe(mount);
          // Some CMS inject the iframe on the wrapper, not the facade node.
          const wrap = mount.closest('.cmp-embed, .embed, [class*="embed"]') || mount.parentElement;
          if (wrap && wrap !== mount) waitForIframe(wrap);
        },
        true
      );
    }

    const iframe = findYoutubeIframe(mount) || findYoutubeIframe(mount.parentElement);
    if (iframe) attachIframe(iframe);
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

    const mount =
      node.closest(DATA_IFRAME_SELECTOR) ||
      node.closest(
        [
          '.cmp-embed__youtube',
          '.cmp-embed',
          '.wp-block-embed-youtube',
          '.youtube-player',
          '[class*="youtube"]',
          '[class*="Youtube"]',
        ].join(', ')
      ) ||
      node.closest('picture')?.parentElement ||
      null;

    if (!mount || !isValidMount(mount)) return;
    // Avoid wiring random ytimg icons/avatars without embed context.
    if (
      !mount.hasAttribute('data-iframe') &&
      !/embed|youtube|player|video/i.test(mount.className || '') &&
      !mount.closest('.cmp-embed, .embed, [class*="youtube"]')
    ) {
      return;
    }

    attachFacadeMount(mount, videoIdFromElementConfig(mount) || videoId);
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
    const state = getOrCreateState(mount, videoId);
    if (!state || state.dismissed) return;
    state.userActivated = true;
    scheduleBlockedCheck(state);
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
    ensureMountClickHandler(mount, videoId);
    return state;
  }

  /** Generic mounts: interaction means the user tried to use the embed. */
  function ensureMountClickHandler(mount, videoId) {
    if (!mount || mount.hasAttribute(ACTIVATE_MARKER)) return;
    mount.setAttribute(ACTIVATE_MARKER, '1');
    mount.addEventListener(
      'pointerdown',
      () => {
        primeBlockedCheck(mount, videoId || mount.getAttribute(MARKER));
      },
      true
    );
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
    const root = iframe.getRootNode();
    if (root instanceof ShadowRoot) {
      return iframe.closest('lite-youtube') || iframe.parentElement;
    }

    return (
      iframe.closest('lite-youtube') ||
      iframe.closest('[data-iframe]') ||
      iframe.closest('.cmp-embed__youtube') ||
      iframe.closest('.cmp-embed') ||
      iframe.closest('f-embed-youtube') ||
      iframe.closest('f-embed[data-type="youtube"]') ||
      iframe.closest('[data-type="youtube"]') ||
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
      ) ||
      iframe.parentElement
    );
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
    root.querySelectorAll(LITE_SELECTOR).forEach((el) => safeCall(attachLiteElement, el));
    root.querySelectorAll(LAZY_EMBED_SELECTOR).forEach((el) => safeCall(attachLazyEmbed, el));
    // Lazy facades: config JSON / CMS thumbs before an iframe exists (AEM, etc.).
    root.querySelectorAll(DATA_IFRAME_SELECTOR).forEach((el) => safeCall(attachDataIframeEmbed, el));
    root.querySelectorAll(YTIMG_SELECTOR).forEach((el) => safeCall(attachYtimgFacade, el));
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
