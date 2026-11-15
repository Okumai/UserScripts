// ==UserScript==
// @name         Auto YouTube Shorts | Auto-Next with Preload
// @description  Auto-switch to the next YouTube Short, preload videos, skip ads, and toggle video information with player controls.
// @version      2026.11.15.02
// @author       ŌKUMA
// @namespace    https://okuma.dev/
// @homepageURL  https://github.com/Okumai/UserScripts
// @supportURL   https://github.com/Okumai/UserScripts/issues
// @match        https://www.youtube.com/shorts/*
// @match        https://m.youtube.com/shorts/*
// @grant        none
// @license      MIT
// @run-at       document-end
// ==/UserScript==

(() => {
    'use strict';

    const BUILD = 'overlay-rebuild-02';
    const PREFIX = '[Shorts Auto Next]';
    const ROOT_ID = 'shorts-auto-next-overlay-v2';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const REEL_SELECTOR = 'ytd-reel-video-renderer, ytm-reel-item-renderer';
    const AD_SKIP_DELAY = 3000;

    console.info(PREFIX, 'BOOT', BUILD, location.href);

    if (window.top !== window.self) {
        console.info(PREFIX, 'Skipped child frame');
        return;
    }

    window.__shortsAutoNextOverlayV2?.destroy();

    let autoNext = true;
    let skipAds = true;
    let hideInfo = false;
    let currentVideo = null;
    let currentSource = '';
    let currentPage = location.href;
    let adSince = null;
    let nextAllowedAt = 0;
    let timer = null;
    let uiTimer = null;
    let uiFrame = null;
    let pointer = null;
    let keyboardNavigation = false;
    let root = null;
    let mountedLogged = false;
    let waitingLogged = false;
    let lastError = '';

    const events = new AbortController();
    const boundVideos = new WeakSet();
    const originalLoops = new WeakMap();
    const hiddenElements = new Map();
    const buttons = new Map();

    function log(...values) {
        console.info(PREFIX, ...values);
    }

    function isShortsPage() {
        return location.pathname.startsWith('/shorts/');
    }

    // Select the video with the largest visible area, not a preloaded neighbor.
    function getVideo() {
        const videos = document.querySelectorAll(
            '#shorts-player video, ytd-reel-video-renderer video, ytm-reel-item-renderer video'
        );
        let best = null;
        let largestArea = 0;

        for (const video of videos) {
            const rect = video.getBoundingClientRect();
            const style = getComputedStyle(video);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                continue;
            }
            const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
            const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
            const area = width * height;
            if (area > largestArea) {
                largestArea = area;
                best = video;
            }
        }
        return best;
    }

    function setVisible(visible) {
        root?.style.setProperty('display', visible ? 'block' : 'none', 'important');
    }

    // Include ancestor opacity: native controls often fade their wrapper, not the button.
    function getNativeOpacity(element) {
        let opacity = 1;
        for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (node.hidden || style.display === 'none' ||
                style.visibility === 'hidden' || style.visibility === 'collapse') return 0;
            const value = Number.parseFloat(style.opacity);
            if (Number.isFinite(value)) opacity *= value;
            if (opacity < 0.01) return 0;
        }
        return opacity;
    }

    function containsPointer(rect) {
        return pointer && pointer.x >= rect.left && pointer.x <= rect.right &&
            pointer.y >= rect.top && pointer.y <= rect.bottom;
    }

    function syncOverlay() {
        if (!root || !isShortsPage() || !currentVideo?.isConnected || document.hidden) {
            setVisible(false);
            return;
        }
        const video = currentVideo;
        const rect = video.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 ||
            rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) {
            setVisible(false);
            return;
        }
        const reel = video.closest(REEL_SELECTOR);
        const controls = reel?.querySelector('ytd-shorts-player-controls');
        // Align icon centers to a real button, not a potentially full-height host.
        const nativeButton = controls?.querySelector('#play-pause-button-shape button') ||
            controls?.querySelector('#left-controls button') || controls?.querySelector('button');
        const nativeRect = nativeButton?.getBoundingClientRect();
        const hasNativeGeometry = nativeRect && nativeRect.width > 0 && nativeRect.height > 0;
        const top = hasNativeGeometry ? nativeRect.top + nativeRect.height / 2 - 24 : rect.top + 8;
        const center = rect.left + rect.width / 2;
        root.style.setProperty('left', `${Math.max(72, Math.min(center, innerWidth - 72))}px`, 'important');
        root.style.setProperty('top', `${Math.max(0, Math.min(top, innerHeight - 48))}px`, 'important');

        const parent = document.fullscreenElement || document.documentElement;
        if (root.parentNode !== parent) {
            parent.appendChild(root);
            log('Overlay attached', parent.tagName, BUILD);
        }
        const playerArea = reel?.querySelector('#player-container') || video;
        const overPlayer = Boolean(containsPointer(playerArea.getBoundingClientRect()));
        const overOverlay = Boolean(containsPointer(root.getBoundingClientRect()));
        const focused = keyboardNavigation && Boolean(root.shadowRoot?.activeElement);
        const nativeOpacity = nativeButton ? getNativeOpacity(nativeButton) : 1;
        // Keep buttons usable while the pointer or keyboard focus is on the overlay.
        // Its separate DOM parent must not cause a hide/show feedback loop.
        const interacting = (overOverlay || focused) && root.style.getPropertyValue('display') !== 'none';
        const visible = interacting || (overPlayer && nativeOpacity > 0);
        root.style.setProperty('opacity', String(interacting ? 1 : nativeOpacity), 'important');
        setVisible(visible);
        if (!mountedLogged) {
            mountedLogged = true;
            log('OVERLAY READY', BUILD, root.id);
        }
    }

    function safeSyncOverlay() {
        try {
            syncOverlay();
        } catch (error) {
            setVisible(false);
            const signature = String(error.stack || error);
            if (signature !== lastError) {
                console.error(PREFIX, 'Overlay visibility update failed', BUILD, error);
                lastError = signature;
            }
        }
    }

    function scheduleOverlaySync() {
        if (uiFrame !== null) return;
        uiFrame = requestAnimationFrame(() => {
            uiFrame = null;
            safeSyncOverlay();
        });
    }

    function restoreLoop(video) {
        if (video && originalLoops.has(video)) {
            video.loop = originalLoops.get(video);
        }
    }

    function restoreElement(element, saved) {
        if (saved.value) {
            element.style.setProperty('visibility', saved.value, saved.priority);
        } else {
            element.style.removeProperty('visibility');
        }
    }

    // Change metadata only; preserve the video, captions, and native controls.
    function updateInfo(reel) {
        const selectors = [
            '#metapanel', '#metadata', '#metadata-container', '#shorts-info', '#actions',
            '.ytReelPlayerOverlayViewModelMetadataContainer',
            '.ytReelPlayerOverlayViewModelActionsContainer',
            '.ytReelMetapanelViewModelHost', '.reel-player-overlay-metadata'
        ].join(', ');
        const desired = new Set(hideInfo && reel ? reel.querySelectorAll(selectors) : []);

        for (const [element, saved] of hiddenElements) {
            if (!desired.has(element)) {
                restoreElement(element, saved);
                hiddenElements.delete(element);
            }
        }
        for (const element of desired) {
            if (!hiddenElements.has(element)) {
                hiddenElements.set(element, {
                    value: element.style.getPropertyValue('visibility'),
                    priority: element.style.getPropertyPriority('visibility')
                });
            }
            element.style.setProperty('visibility', 'hidden', 'important');
        }
    }

    function refreshButtons() {
        const states = { auto: autoNext, ads: skipAds, info: hideInfo };
        for (const [key, button] of buttons) {
            const enabled = states[key];
            button.setAttribute('aria-pressed', String(enabled));
            button.title = `${button.getAttribute('aria-label')}: ${enabled ? 'On' : 'Off'}`;
        }
    }

    // Build SVG nodes without innerHTML or Trusted Types HTML sinks.
    function createButton(key, label, paths, toggle) {
        const button = document.createElement('button');
        button.id = `shorts-${key}-button`;
        button.type = 'button';
        button.setAttribute('aria-label', label);
        const svg = document.createElementNS(SVG_NS, 'svg');
        for (const [name, value] of Object.entries({
            viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
            'stroke-width': '2', 'stroke-linecap': 'round',
            'stroke-linejoin': 'round', 'aria-hidden': 'true'
        })) {
            svg.setAttribute(name, value);
        }
        for (const d of paths) {
            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', d);
            svg.appendChild(path);
        }
        button.appendChild(svg);
        button.addEventListener('click', event => {
            event.stopPropagation();
            toggle();
            refreshButtons();
            safeTick();
        }, { signal: events.signal });
        for (const name of ['pointerdown', 'dblclick', 'keydown', 'keyup']) {
            button.addEventListener(name, event => event.stopPropagation(), {
                signal: events.signal
            });
        }
        buttons.set(key, button);
        return button;
    }

    function createOverlay() {
        root = document.createElement('div');
        root.id = ROOT_ID;
        for (const [name, value] of Object.entries({
            all: 'initial', position: 'fixed', display: 'none', width: 'max-content',
            height: '48px', margin: '0', padding: '0', transform: 'translateX(-50%)',
            'z-index': '2147483647', 'pointer-events': 'auto'
        })) {
            root.style.setProperty(name, value, 'important');
        }
        const shadow = root.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
            .bar {
                display: flex;
                align-items: center;
                gap: 4px;
                height: 48px;
                padding: 0 4px;
                border-radius: 24px;
                background: rgba(0, 0, 0, .35);
            }
            button {
                position: relative;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                box-sizing: border-box;
                width: 40px;
                height: 40px;
                margin: 0;
                padding: 0;
                border: 0;
                border-radius: 50%;
                background: transparent;
                color: #fff;
                cursor: pointer;
                appearance: none;
            }
            button:hover { background: rgba(255, 255, 255, .18); }
            button:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
            button[aria-pressed="true"]::after {
                content: "";
                position: absolute;
                bottom: 2px;
                width: 4px;
                height: 4px;
                border-radius: 50%;
                background: #fff;
            }
            svg { display: block; width: 24px; height: 24px; pointer-events: none; }
        `;
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.setAttribute('role', 'group');
        bar.setAttribute('aria-label', 'Shorts playback options');
        bar.append(
            createButton('auto', 'Auto-next', ['M5 5 15 12 5 19Z', 'M19 5v14'], () => {
                autoNext = !autoNext;
                log('Auto-next:', autoNext ? 'On' : 'Off');
            }),
            createButton('ads', 'Skip ads', [
                'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z', 'm9 9 6 6m0-6-6 6'
            ], () => {
                skipAds = !skipAds;
                adSince = null;
                log('Skip ads:', skipAds ? 'On' : 'Off');
            }),
            createButton('info', 'Hide video information', [
                'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z',
                'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'
            ], () => {
                hideInfo = !hideInfo;
                log('Video information:', hideInfo ? 'Hidden' : 'Visible');
            })
        );
        shadow.append(style, bar);
        refreshButtons();
        log('Overlay created', BUILD);
    }

    function clickNext() {
        if (!isShortsPage() || Date.now() < nextAllowedAt) return;
        const button = document.querySelector('#navigation-button-down button');
        const video = getVideo();
        if (!button && !video) return;
        nextAllowedAt = Date.now() + 2000;
        adSince = null;
        if (button) {
            button.click();
            log('Next video requested through navigation button');
        } else {
            video.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40,
                bubbles: true, cancelable: true
            }));
            log('Next video requested through keyboard fallback');
        }
    }

    function isAdvertisement(reel) {
        if (!reel) return false;
        if (reel.matches('[is-ad], [is-advertisement]') || reel.querySelector([
            'reels-ad-card-buttoned-view-model', 'yt-ad-metadata-shape',
            'ad-button-view-model', '.yt-badge-shape--ad',
            '[data-badge-text="Ad" i]', '[data-badge-text*="Sponsored" i]', '.ad-showing'
        ].join(', '))) return true;
        return Array.from(reel.querySelectorAll('.yt-badge-shape__text, .yt-badge-shape'))
            .some(badge => /^(ad|ads|advertisement|sponsored)(\s|$)/i.test(badge.textContent.trim()));
    }

    function preloadNext(reel) {
        if (!autoNext || !reel) return;
        const item = reel.closest(
            '.reel-video-in-sequence-new, .reel-video-in-sequence'
        ) || reel;
        const nextVideo = item.nextElementSibling?.querySelector('video');
        if (nextVideo && nextVideo.preload !== 'auto') {
            // Let YouTube manage loading without resetting its media pipeline.
            nextVideo.preload = 'auto';
        }
    }

    function tick() {
        if (!root) return;
        if (currentPage !== location.href) {
            currentPage = location.href;
            adSince = null;
        }
        const video = isShortsPage() ? getVideo() : null;
        if (!video) {
            setVisible(false);
            restoreLoop(currentVideo);
            currentVideo = null;
            currentSource = '';
            adSince = null;
            updateInfo(null);
            if (isShortsPage() && !waitingLogged) {
                log('Waiting for a visible Shorts video', BUILD);
                waitingLogged = true;
            }
            return;
        }
        waitingLogged = false;
        const source = video.currentSrc || video.src;
        if (currentVideo !== video || currentSource !== source) {
            if (currentVideo !== video) restoreLoop(currentVideo);
            currentVideo = video;
            currentSource = source;
            adSince = null;
        }
        if (!originalLoops.has(video)) originalLoops.set(video, video.loop);
        video.loop = !autoNext;
        if (!boundVideos.has(video)) {
            boundVideos.add(video);
            video.addEventListener('ended', () => {
                if (autoNext && isShortsPage() && video === getVideo()) clickNext();
            }, { signal: events.signal });
        }
        const reel = video.closest(REEL_SELECTOR);
        safeSyncOverlay();
        updateInfo(reel);
        preloadNext(reel);
        if (skipAds && isAdvertisement(reel)) {
            if (adSince === null) {
                adSince = Date.now();
                log('Advertisement detected; waiting 3 seconds');
            } else if (Date.now() - adSince >= AD_SKIP_DELAY) {
                clickNext();
            }
        } else {
            adSince = null;
        }
    }

    function safeTick() {
        try {
            tick();
            lastError = '';
        } catch (error) {
            // Avoid flooding the console when the same error persists.
            const signature = String(error.stack || error);
            if (signature !== lastError) {
                console.error(PREFIX, 'Overlay update failed', BUILD, error);
                lastError = signature;
            }
        }
    }

    function start() {
        try {
            createOverlay();
            safeTick();
            timer = setInterval(safeTick, 300);
            // Poll computed styles during native opacity transitions, even without DOM mutations.
            uiTimer = setInterval(safeSyncOverlay, 100);
            document.addEventListener('pointermove', event => {
                pointer = { x: event.clientX, y: event.clientY };
                keyboardNavigation = false;
                scheduleOverlaySync();
            }, { capture: true, passive: true, signal: events.signal });
            document.addEventListener('keydown', event => {
                if (event.key === 'Tab') {
                    keyboardNavigation = true;
                    scheduleOverlaySync();
                }
            }, { capture: true, signal: events.signal });
            document.addEventListener('pointerout', event => {
                if (!event.relatedTarget) {
                    pointer = null;
                    setVisible(false);
                }
            }, { capture: true, signal: events.signal });
            window.addEventListener('blur', () => {
                pointer = null;
                root?.shadowRoot?.activeElement?.blur();
                setVisible(false);
            }, { signal: events.signal });
            document.addEventListener('visibilitychange', safeSyncOverlay, { signal: events.signal });
            document.addEventListener('focusin', scheduleOverlaySync, { signal: events.signal });
            document.addEventListener('focusout', scheduleOverlaySync, { signal: events.signal });
            window.addEventListener('resize', safeTick, { signal: events.signal });
            document.addEventListener('fullscreenchange', safeTick, { signal: events.signal });
            document.addEventListener('yt-navigate-finish', safeTick, { signal: events.signal });
            log('STARTED', BUILD);
        } catch (error) {
            console.error(PREFIX, 'Startup failed', BUILD, error);
        }
    }

    window.__shortsAutoNextOverlayV2 = {
        destroy() {
            clearInterval(timer);
            clearInterval(uiTimer);
            if (uiFrame !== null) cancelAnimationFrame(uiFrame);
            events.abort();
            restoreLoop(currentVideo);
            for (const [element, saved] of hiddenElements) restoreElement(element, saved);
            hiddenElements.clear();
            root?.remove();
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true, signal: events.signal });
    } else {
        start();
    }
})();
