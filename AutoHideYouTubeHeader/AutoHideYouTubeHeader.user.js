// ==UserScript==
// @name         Auto Hide YouTube Header | Keep Search
// @description  Reclaim header space and reveal a floating search bar on upward scroll, with a full-header toggle.
// @version      2026.11.15.07
// @author       ŌKUMA
// @namespace    https://okuma.dev/
// @homepageURL  https://github.com/Okumai/UserScripts
// @supportURL   https://github.com/Okumai/UserScripts/issues
// @downloadURL  https://raw.githubusercontent.com/Okumai/UserScripts/refs/heads/master/AutoHideYouTubeHeader/AutoHideYouTubeHeader.user.js
// @updateURL    https://raw.githubusercontent.com/Okumai/UserScripts/refs/heads/master/AutoHideYouTubeHeader/AutoHideYouTubeHeader.user.js
// @match        https://www.youtube.com/*
// @grant        none
// @license      MIT
// @run-at       document-end
// ==/UserScript==

(() => {
    'use strict';

    if (window.top !== window.self) return;
    window.__autoHideYouTubeHeader?.destroy();

    const PREFIX = '[Auto Hide YouTube Header]';
    const HOST_ID = 'auto-hide-youtube-header-toggle';
    const HIDDEN_ATTR = 'data-auto-hide-youtube-header';
    const SEARCH_ATTR = 'data-auto-hide-youtube-header-search';
    const FLOATING_ATTR = 'data-auto-hide-youtube-header-floating';
    const LAYOUT_ATTR = 'data-auto-hide-youtube-header-layout';
    const IDLE_ATTR = 'data-auto-hide-youtube-header-idle';
    const IDLE_DELAY = 2000;
    const SEARCH_SELECTOR = '.ytSearchboxComponentHost, yt-searchbox, ytd-searchbox';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const events = new AbortController();
    const markedSearches = new Set();
    const markedHeaders = new Set();
    let hidden = true;
    let floating = false;
    let lastScrollY = Math.max(0, window.scrollY);
    const scrollPositions = new WeakMap();
    let frame = null;
    let idleTimer = null;
    let destroyed = false;

    const style = document.createElement('style');
    style.id = 'auto-hide-youtube-header-style';
    style.textContent = `
        /* Reclaim layout space without moving/cloning the native search DOM. */
        html[${LAYOUT_ATTR}] ytd-app {
            --ytd-masthead-height: 0px !important;
        }
        html[${LAYOUT_ATTR}] ytd-watch-flexy {
            --ytd-watch-flexy-masthead-height: 0px !important;
        }
        html[${LAYOUT_ATTR}] ytd-page-manager#page-manager {
            margin-top: 0 !important;
        }
        html[${LAYOUT_ATTR}] #masthead-container.ytd-app {
            height: 0 !important;
            min-height: 0 !important;
            background: transparent !important;
        }
        ytd-masthead[${HIDDEN_ATTR}] {
            display: none !important;
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100% !important;
            height: 56px !important;
            min-height: 56px !important;
            margin: 0 !important;
            transform: none !important;
            z-index: 2021 !important;
            background: transparent !important;
            box-shadow: none !important;
            border-bottom: none !important;
            pointer-events: none !important;
        }
        ytd-masthead[${HIDDEN_ATTR}][${FLOATING_ATTR}] {
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
            transition: opacity .3s ease, visibility 0s !important;
        }
        html[${IDLE_ATTR}] ytd-masthead[${HIDDEN_ATTR}][${FLOATING_ATTR}] {
            opacity: 0 !important;
            visibility: hidden !important;
            transition: opacity .3s ease, visibility 0s .3s !important;
        }
        @media (prefers-reduced-motion: reduce) {
            ytd-masthead[${HIDDEN_ATTR}][${FLOATING_ATTR}] {
                transition: none !important;
            }
        }
        ytd-masthead[${HIDDEN_ATTR}] > #background {
            display: none !important;
        }
        ytd-masthead[${HIDDEN_ATTR}] #container.ytd-masthead {
            justify-content: center !important;
            height: 56px !important;
            box-sizing: border-box !important;
            background: transparent !important;
        }
        ytd-masthead[${HIDDEN_ATTR}] #container.ytd-masthead > :not(#center),
        ytd-masthead[${HIDDEN_ATTR}] #center.ytd-masthead > :not([${SEARCH_ATTR}]):not(#${HOST_ID}) {
            display: none !important;
        }
        ytd-masthead[${HIDDEN_ATTR}] #center.ytd-masthead {
            display: flex !important;
            flex: 1 1 auto !important;
            align-items: center !important;
            justify-content: center !important;
            min-width: 0 !important;
            max-width: 320px !important;
            margin: 0 auto !important;
        }
        ytd-masthead[${HIDDEN_ATTR}] [${SEARCH_ATTR}] {
            display: flex !important;
            flex: 1 1 auto !important;
            min-width: 0 !important;
            margin: 0 !important;
            pointer-events: auto !important;
        }
        /* Remove native leading search padding so the toggle stays close in both modes. */
        ytd-masthead [${SEARCH_ATTR}],
        ytd-masthead [${SEARCH_ATTR}] .ytSearchboxComponentInputWrapper,
        ytd-masthead [${SEARCH_ATTR}] #search-form {
            margin-left: 0 !important;
        }
        #${HOST_ID} {
            display: inline-flex !important;
            flex: 0 0 40px !important;
            align-items: center !important;
            margin: 0 !important;
            pointer-events: auto !important;
        }
    `;

    // Isolate button styling, without innerHTML or Trusted Types HTML sinks.
    const host = document.createElement('span');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    const buttonStyle = document.createElement('style');
    buttonStyle.textContent = `
        button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 40px;
            height: 40px;
            padding: 0;
            border: 0;
            border-radius: 50%;
            background: #fff;
            color: #000;
            box-shadow: 0 1px 4px rgba(0, 0, 0, .25);
            transition: background-color .15s, color .15s;
            cursor: pointer;
            appearance: none;
        }
        button:hover, button:focus-visible { background: #000; color: #fff; }
        button:focus-visible { outline: 2px solid #666; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) {
            button { transition: none; }
        }
        svg { width: 24px; height: 24px; pointer-events: none; }
    `;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', 'Hide YouTube header');
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [name, value] of Object.entries({
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        'stroke-width': '2', 'stroke-linecap': 'round',
        'stroke-linejoin': 'round', 'aria-hidden': 'true'
    })) svg.setAttribute(name, value);
    const outline = document.createElementNS(SVG_NS, 'path');
    outline.setAttribute('d', 'M3 3h18v18H3Z M3 8h18');
    const arrow = document.createElementNS(SVG_NS, 'path');
    arrow.setAttribute('d', 'm9 16 3-3 3 3');
    svg.append(outline, arrow);
    button.append(svg);
    shadow.append(buttonStyle, button);

    function refreshButton() {
        button.setAttribute('aria-pressed', String(hidden));
        button.title = hidden ? 'Show full header' : 'Hide header (scroll up to show search)';
        button.setAttribute('aria-label', button.title);
        // Flip the entire icon vertically to distinguish hidden and expanded states.
        svg.style.transform = hidden ? 'scaleY(-1)' : 'scaleY(1)';
    }

    function sync() {
        if (destroyed) return;
        if (!style.isConnected) document.documentElement.append(style);
        const header = document.querySelector('ytd-masthead');
        const center = header?.querySelector('#center.ytd-masthead');
        // Only collapse a supported layout with an actual search box.
        const search = center && Array.from(center.children).find(node => node.matches(SEARCH_SELECTOR));
        for (const old of markedHeaders) {
            if (old !== header || !search || !hidden) {
                old.removeAttribute(HIDDEN_ATTR);
                old.removeAttribute(FLOATING_ATTR);
                markedHeaders.delete(old);
            }
        }
        for (const old of markedSearches) {
            if (old !== search) {
                old.removeAttribute(SEARCH_ATTR);
                markedSearches.delete(old);
            }
        }
        document.documentElement.toggleAttribute(LAYOUT_ATTR, Boolean(hidden && search));
        if (!hidden || !floating || !search) clearIdle();
        if (!search) {
            host.remove();
            return;
        }
        if (!search.hasAttribute(SEARCH_ATTR)) search.setAttribute(SEARCH_ATTR, '');
        markedSearches.add(search);
        if (host.parentNode !== center || host.nextElementSibling !== search) {
            center.insertBefore(host, search);
        }
        if (hidden) {
            if (!header.hasAttribute(HIDDEN_ATTR)) header.setAttribute(HIDDEN_ATTR, '');
            header.toggleAttribute(FLOATING_ATTR, floating);
            markedHeaders.add(header);
        }
    }

    function clearIdle() {
        clearTimeout(idleTimer);
        idleTimer = null;
        document.documentElement.removeAttribute(IDLE_ATTR);
    }

    function wakeFloating() {
        clearIdle();
        if (destroyed || !hidden || !floating) return;
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (!destroyed && hidden && floating) {
                document.documentElement.setAttribute(IDLE_ATTR, '');
            }
        }, IDLE_DELAY);
    }

    // Capture scroll events from both the page and nested scrolling feeds.
    // Ignore search suggestions: scrolling them must not dismiss the search bar.
    function onScroll(event) {
        const target = event.target;
        const pageScroll = target === document || target === document.documentElement || target === document.body;
        if (!pageScroll && (!(target instanceof Element) || target.closest('ytd-masthead'))) return;
        const y = Math.max(0, pageScroll ? window.scrollY : target.scrollTop);
        const previous = pageScroll ? lastScrollY : (scrollPositions.get(target) ?? 0);
        if (Math.abs(y - previous) < 2) return;
        if (pageScroll) lastScrollY = y;
        else scrollPositions.set(target, y);
        if (!hidden) return;
        const next = y < previous;
        if (floating !== next) {
            floating = next;
            wakeFloating();
            // Do not leave keyboard focus inside a now-invisible search field.
            if (!floating) {
                const header = document.querySelector('ytd-masthead');
                if (header?.contains(document.activeElement)) document.activeElement.blur();
            }
            sync();
        }
    }

    function resetFloating() {
        floating = false;
        clearIdle();
        lastScrollY = Math.max(0, window.scrollY);
        sync();
    }

    function scheduleSync() {
        if (destroyed || frame !== null) return;
        frame = requestAnimationFrame(() => {
            frame = null;
            sync();
        });
    }

    button.addEventListener('click', event => {
        event.stopPropagation();
        hidden = !hidden;
        floating = false;
        lastScrollY = Math.max(0, window.scrollY);
        refreshButton();
        sync();
    }, { signal: events.signal });
    for (const name of ['pointerdown', 'dblclick', 'keydown', 'keyup']) {
        button.addEventListener(name, event => event.stopPropagation(), { signal: events.signal });
    }

    // YouTube replaces header nodes during SPA navigation; no polling needed.
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('pointermove', wakeFloating, { passive: true, signal: events.signal });
    document.addEventListener('scroll', onScroll, { capture: true, passive: true, signal: events.signal });
    document.addEventListener('yt-navigate-start', resetFloating, { signal: events.signal });
    document.addEventListener('yt-navigate-finish', resetFloating, { signal: events.signal });
    document.addEventListener('yt-page-data-updated', scheduleSync, { signal: events.signal });

    window.__autoHideYouTubeHeader = {
        destroy() {
            destroyed = true;
            clearIdle();
            observer.disconnect();
            events.abort();
            if (frame !== null) cancelAnimationFrame(frame);
            for (const header of markedHeaders) {
                header.removeAttribute(HIDDEN_ATTR);
                header.removeAttribute(FLOATING_ATTR);
            }
            document.documentElement.removeAttribute(LAYOUT_ATTR);
            for (const search of markedSearches) search.removeAttribute(SEARCH_ATTR);
            markedHeaders.clear();
            markedSearches.clear();
            host.remove();
            style.remove();
        }
    };

    refreshButton();
    sync();
    console.info(PREFIX, 'Started; header hidden by default');
})();
