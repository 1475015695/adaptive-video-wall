/**
 * Chrome Extension Content Script
 *
 * Runs across all frames, discovers <video> elements (including open Shadow DOM),
 * provides Hover Quick-Sync button + Picker Mode highlight overlay, and streams
 * live video/audio via local WebRTC loopback (or Direct URL fallback).
 */
(function () {
  'use strict';

  if (globalThis.__adaptiveWallContentLoaded) return;
  globalThis.__adaptiveWallContentLoaded = true;

  // Never inject capture UI inside our own extension's player tab
  if (location.protocol === 'chrome-extension:') return;

  const videoUidMap = new WeakMap();
  const uidToVideoMap = new Map();
  let uidCounter = 0;

  const activePeers = new Map(); // streamId -> { pc, stream, video, cleanup }
  const pendingPeerReady = new Set();
  const syncedUids = new Set();

  let settings = {
    showHoverButton: false,
    focusWallOnSync: false,
    autoMuteSourceTab: true
  };

  let pickerActive = false;
  let hoverVideo = null;
  let pickerHoveredVideo = null;
  let hoverLockOnButton = false;
  let toastTimer = null;
  let lastContextVideo = null;
  let lastContextTime = 0;
  let activeRecorderSession = null;

  function getVideoUid(video) {
    let uid = videoUidMap.get(video);
    if (!uid) {
      uid = 'v-' + (++uidCounter) + '-' + Math.random().toString(36).slice(2, 7);
      videoUidMap.set(video, uid);
    }
    uidToVideoMap.set(uid, video);
    return uid;
  }

  function findFastVideos() {
    const live = document.getElementsByTagName('video');
    if (cachedShadowVideos.length === 0) return live;
    const out = Array.from(live);
    for (let i = 0; i < cachedShadowVideos.length; i++) {
      const v = cachedShadowVideos[i];
      if (v && v.isConnected && !out.includes(v)) out.push(v);
    }
    return out;
  }

  let cachedShadowVideos = [];

  function findAllVideos() {
    const videos = [];
    const seen = new Set();
    const shadowFound = [];

    function walk(rootNode, inShadow) {
      if (!rootNode) return;
      if (rootNode.querySelectorAll) {
        const list = rootNode.querySelectorAll('video');
        for (let i = 0; i < list.length; i++) {
          if (!seen.has(list[i])) {
            seen.add(list[i]);
            videos.push(list[i]);
            if (inShadow) shadowFound.push(list[i]);
          }
        }
        const allEls = rootNode.querySelectorAll('*');
        for (let i = 0; i < allEls.length; i++) {
          if (allEls[i].shadowRoot) {
            walk(allEls[i].shadowRoot, true);
          }
        }
      }
    }

    walk(document, false);
    cachedShadowVideos = shadowFound;
    return videos;
  }

  function isElementVisible(rect) {
    return (
      rect.width >= 60 &&
      rect.height >= 45 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  }

  function getBestTitle(video) {
    const aria = video.getAttribute('aria-label') || video.getAttribute('title');
    if (aria && aria.trim()) return aria.trim().slice(0, 60);
    return (document.title || location.hostname || '网页视频').trim().slice(0, 60);
  }

  function scanVideosForPopup() {
    const list = findAllVideos();
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const rect = v.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 45) continue;
      if (v.readyState === 0 && !v.currentSrc && !v.srcObject) continue;

      const uid = getVideoUid(v);
      const vw = v.videoWidth || Math.round(rect.width);
      const vh = v.videoHeight || Math.round(rect.height);
      const aspectRatio = vw > 0 && vh > 0 ? vw / vh : 16 / 9;
      const src = v.currentSrc || '';

      out.push({
        videoUid: uid,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        videoWidth: vw,
        videoHeight: vh,
        aspectRatio,
        paused: v.paused,
        isPlaying: !v.paused && !v.ended && v.readyState >= 2,
        currentTime: v.currentTime || 0,
        duration: Number.isFinite(v.duration) ? v.duration : 0,
        playbackRate: v.playbackRate || 1,
        title: getBestTitle(v),
        currentSrc: src,
        isBlob: src.startsWith('blob:')
      });
    }
    return out;
  }

  // ===== Isolated Shadow DOM Overlay =====
  let shadowRoot = null;
  let hoverPillEl = null;
  let pickerOverlayEl = null;
  let pickerBoxEl = null;
  let pickerLabelEl = null;
  let toastEl = null;
  let toastTextEl = null;
  let toastActionEl = null;

  function ensureOverlayUi() {
    if (shadowRoot) return;
    const mountTarget = document.body || document.documentElement;
    if (!mountTarget) return;
    const host = document.createElement('div');
    host.id = '__adaptive-wall-ext-host';
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;contain:layout size style;';
    shadowRoot = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
      .hover-pill {
        position: fixed;
        z-index: 10;
        display: none;
        align-items: center;
        gap: 6px;
        height: 30px;
        padding: 0 11px;
        border-radius: 999px;
        border: 1px solid rgba(56, 189, 248, 0.55);
        background: rgba(11, 15, 25, 0.86);
        color: #e0f2fe;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        pointer-events: auto;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(10px);
        transition: transform 120ms ease, background 140ms ease;
      }
      .hover-pill:hover {
        background: rgba(14, 165, 233, 0.92);
        color: #04121c;
        transform: scale(1.03);
      }
      .hover-pill.is-synced {
        border-color: rgba(52, 211, 153, 0.65);
        color: #6ee7b7;
      }
      .picker-overlay {
        position: fixed;
        inset: 0;
        display: none;
        background: rgba(5, 8, 15, 0.28);
        cursor: crosshair;
        pointer-events: auto;
      }
      .picker-banner {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 9px 16px;
        border-radius: 999px;
        background: rgba(11, 15, 25, 0.92);
        border: 1px solid rgba(56, 189, 248, 0.5);
        color: #f1f5f9;
        font-size: 13px;
        font-weight: 500;
        box-shadow: 0 14px 40px rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(14px);
        pointer-events: auto;
      }
      .picker-cancel {
        border: 1px solid rgba(255, 255, 255, 0.22);
        background: rgba(255, 255, 255, 0.1);
        color: #f8fafc;
        border-radius: 999px;
        padding: 3px 10px;
        font-size: 12px;
        cursor: pointer;
      }
      .picker-cancel:hover {
        background: rgba(244, 63, 94, 0.35);
      }
      .picker-box {
        position: fixed;
        display: none;
        border: 3px solid #38bdf8;
        border-radius: 8px;
        background: rgba(56, 189, 248, 0.12);
        box-shadow: 0 0 0 2px rgba(7, 10, 18, 0.5), 0 0 28px rgba(56, 189, 248, 0.45);
        pointer-events: none;
      }
      .picker-label {
        position: absolute;
        left: 10px;
        top: 10px;
        padding: 4px 10px;
        border-radius: 6px;
        background: rgba(7, 10, 18, 0.88);
        border: 1px solid rgba(56, 189, 248, 0.6);
        color: #bae6fd;
        font-size: 12px;
        font-weight: 600;
        white-space: nowrap;
      }
      .toast {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 20;
        display: none;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        border-radius: 12px;
        background: rgba(13, 17, 28, 0.94);
        border: 1px solid rgba(56, 189, 248, 0.45);
        color: #f1f5f9;
        font-size: 13px;
        box-shadow: 0 12px 34px rgba(0, 0, 0, 0.55);
        pointer-events: auto;
      }
      .toast.is-error {
        border-color: rgba(244, 63, 94, 0.65);
        color: #fecdd3;
      }
      .toast-btn {
        border: none;
        border-radius: 7px;
        padding: 4px 10px;
        background: #38bdf8;
        color: #04121c;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .rec-pill {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 25;
        display: none;
        align-items: center;
        gap: 8px;
        padding: 7px 13px;
        border-radius: 999px;
        background: rgba(15, 17, 26, 0.92);
        border: 1px solid rgba(244, 63, 94, 0.65);
        color: #ffe4e6;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        pointer-events: auto;
        box-shadow: 0 8px 26px rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(10px);
      }
      .rec-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #f43f5e;
        box-shadow: 0 0 8px #f43f5e;
      }
    `;
    shadowRoot.appendChild(style);

    // Hover Quick-Sync Pill
    hoverPillEl = document.createElement('button');
    hoverPillEl.type = 'button';
    hoverPillEl.className = 'hover-pill';
    hoverPillEl.textContent = '⊞ 同步到视频墙';
    hoverPillEl.addEventListener('mouseenter', () => {
      hoverLockOnButton = true;
    });
    hoverPillEl.addEventListener('mouseleave', () => {
      hoverLockOnButton = false;
    });
    hoverPillEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    hoverPillEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (hoverVideo) {
        syncVideoElement(hoverVideo);
      }
    });
    shadowRoot.appendChild(hoverPillEl);

    // Picker Mode Overlay
    pickerOverlayEl = document.createElement('div');
    pickerOverlayEl.className = 'picker-overlay';

    const banner = document.createElement('div');
    banner.className = 'picker-banner';
    const bannerText = document.createElement('span');
    bannerText.textContent = '点击任意视频将其同步到自适应视频墙';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'picker-cancel';
    cancelBtn.textContent = 'Esc 取消';
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'EXIT_PICKER_MODE' }).catch(() => { });
      exitPickerMode();
    });
    banner.appendChild(bannerText);
    banner.appendChild(cancelBtn);

    pickerBoxEl = document.createElement('div');
    pickerBoxEl.className = 'picker-box';
    pickerLabelEl = document.createElement('div');
    pickerLabelEl.className = 'picker-label';
    pickerBoxEl.appendChild(pickerLabelEl);

    pickerOverlayEl.appendChild(pickerBoxEl);
    pickerOverlayEl.appendChild(banner);

    pickerOverlayEl.addEventListener('mousemove', (e) => {
      const hit = hitTestVideo(e.clientX, e.clientY, 60, 45);
      pickerHoveredVideo = hit;
      if (hit) {
        const r = hit.getBoundingClientRect();
        pickerBoxEl.style.display = 'block';
        pickerBoxEl.style.left = `${r.left}px`;
        pickerBoxEl.style.top = `${r.top}px`;
        pickerBoxEl.style.width = `${r.width}px`;
        pickerBoxEl.style.height = `${r.height}px`;
        const vw = hit.videoWidth || Math.round(r.width);
        const vh = hit.videoHeight || Math.round(r.height);
        pickerLabelEl.textContent = `点击同步 · ${vw}×${vh}`;
      } else {
        pickerBoxEl.style.display = 'none';
      }
    });

    pickerOverlayEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = pickerHoveredVideo || hitTestVideo(e.clientX, e.clientY, 60, 45);
      if (target) {
        syncVideoElement(target);
      }
      chrome.runtime.sendMessage({ type: 'EXIT_PICKER_MODE' }).catch(() => { });
      exitPickerMode();
    });

    shadowRoot.appendChild(pickerOverlayEl);

    // Toast Notification
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastTextEl = document.createElement('span');
    toastActionEl = document.createElement('button');
    toastActionEl.type = 'button';
    toastActionEl.className = 'toast-btn';
    toastActionEl.textContent = '查看视频墙';
    toastActionEl.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_WALL_TAB' }).catch(() => { });
      toastEl.style.display = 'none';
    });
    toastEl.appendChild(toastTextEl);
    toastEl.appendChild(toastActionEl);
    shadowRoot.appendChild(toastEl);

    const recPill = document.createElement('button');
    recPill.type = 'button';
    recPill.className = 'rec-pill';
    recPill.innerHTML = '<span class="rec-dot"></span><span class="rec-text">正在录制视频 00:00 · 点击保存</span>';
    recPill.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (activeRecorderSession) {
        activeRecorderSession.stopAndSave();
      }
    });
    shadowRoot.appendChild(recPill);
    shadowRoot._recPill = recPill;
    shadowRoot._recText = recPill.querySelector('.rec-text');

    (document.body || document.documentElement).appendChild(host);
  }

  function showToast(text, isError, showJumpBtn) {
    ensureOverlayUi();
    toastTextEl.textContent = text;
    toastEl.classList.toggle('is-error', Boolean(isError));
    toastActionEl.style.display = showJumpBtn ? 'inline-block' : 'none';
    toastEl.style.display = 'flex';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.display = 'none';
    }, 3600);
  }

  function hitTestVideo(clientX, clientY, minW, minH, deepScan) {
    const videos = deepScan ? findAllVideos() : findFastVideos();
    let bestPlaying = null;
    let bestLoaded = null;
    let bestPlayingArea = Infinity;
    let bestLoadedArea = Infinity;

    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      if (v.readyState < 1 && !v.currentSrc && !v.srcObject) continue;
      const rect = v.getBoundingClientRect();
      if (rect.width < minW || rect.height < minH) continue;
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        const area = rect.width * rect.height;
        if (!v.paused && !v.ended) {
          if (area < bestPlayingArea) {
            bestPlayingArea = area;
            bestPlaying = v;
          }
        } else if (area < bestLoadedArea) {
          bestLoadedArea = area;
          bestLoaded = v;
        }
      }
    }
    return bestPlaying || bestLoaded;
  }

  function updateHoverPill(clientX, clientY) {
    if (!settings.showHoverButton || pickerActive) {
      if (hoverPillEl) hoverPillEl.style.display = 'none';
      return;
    }
    if (hoverLockOnButton) return;

    const hit = hitTestVideo(clientX, clientY, 180, 100);
    hoverVideo = hit;

    if (!hit) {
      if (hoverPillEl) hoverPillEl.style.display = 'none';
      return;
    }

    const rect = hit.getBoundingClientRect();
    if (!isElementVisible(rect)) {
      if (hoverPillEl) hoverPillEl.style.display = 'none';
      return;
    }

    ensureOverlayUi();
    const uid = getVideoUid(hit);
    const isSynced = syncedUids.has(uid);
    hoverPillEl.textContent = isSynced ? '✓ 已同步到视频墙' : '⊞ 同步到视频墙';
    hoverPillEl.classList.toggle('is-synced', isSynced);
    hoverPillEl.style.display = 'inline-flex';

    const top = Math.max(8, rect.top + 10);
    const rightBound = Math.min(window.innerWidth - 8, rect.right - 10);
    const left = Math.max(8, rightBound - (hoverPillEl.offsetWidth || 124));
    hoverPillEl.style.top = `${top}px`;
    hoverPillEl.style.left = `${left}px`;
  }

  function enterPickerMode() {
    ensureOverlayUi();
    findAllVideos(); // Refresh Shadow DOM video cache once on picker entry
    pickerActive = true;
    pickerHoveredVideo = null;
    if (hoverPillEl) hoverPillEl.style.display = 'none';
    pickerBoxEl.style.display = 'none';
    pickerOverlayEl.style.display = 'block';
    return true;
  }

  function exitPickerMode() {
    pickerActive = false;
    pickerHoveredVideo = null;
    if (pickerOverlayEl) pickerOverlayEl.style.display = 'none';
    if (pickerBoxEl) pickerBoxEl.style.display = 'none';
  }

  function extractVideoMeta(video, uid) {
    const rect = video.getBoundingClientRect();
    const vw = video.videoWidth || Math.round(rect.width) || 16;
    const vh = video.videoHeight || Math.round(rect.height) || 9;
    return {
      videoUid: uid,
      title: getBestTitle(video),
      hostname: location.hostname,
      aspectRatio: vw > 0 && vh > 0 ? vw / vh : 16 / 9,
      videoWidth: video.videoWidth || 0,
      videoHeight: video.videoHeight || 0,
      paused: video.paused,
      currentTime: video.currentTime || 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      playbackRate: video.playbackRate || 1
    };
  }

  /**
   * 2-Tier Capture & Sync:
   * Tier 1: video.captureStream() -> local WebRTC loopback
   * Tier 2: Direct http(s) URL mirror if CORS blocks captureStream
   */
  async function syncVideoElement(video) {
    if (!video) return;
    const uid = getVideoUid(video);
    const meta = extractVideoMeta(video, uid);

    let capturedStream = null;
    let transport = 'webrtc';
    let captureFailed = false;

    try {
      const fn = video.captureStream || video.mozCaptureStream;
      if (typeof fn === 'function') {
        capturedStream = fn.call(video);
        const tracks = capturedStream ? capturedStream.getTracks() : [];
        if (video.readyState >= 2 && tracks.length === 0) {
          captureFailed = true;
        }
      } else {
        captureFailed = true;
      }
    } catch (_err) {
      captureFailed = true;
    }

    const src = video.currentSrc || '';
    const isHttpUrl = /^https?:\/\//i.test(src);

    if (captureFailed || !capturedStream) {
      if (isHttpUrl) {
        transport = 'direct-url';
        if (capturedStream) {
          capturedStream.getTracks().forEach((t) => t.stop());
          capturedStream = null;
        }
      } else {
        showToast('该视频受版权保护 (DRM) 或跨域限制，无法直接捕获', true, false);
        return;
      }
    }

    const sendSyncMsg = () =>
      chrome.runtime.sendMessage({
        type: 'SYNC_VIDEO_REQUEST',
        videoUid: uid,
        transport,
        src: transport === 'direct-url' ? src : null,
        meta
      });

    let response;
    try {
      if (!chrome?.runtime?.id) {
        throw new Error('Extension context invalidated');
      }
      response = await sendSyncMsg();
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (!chrome?.runtime?.id || /context invalidated/i.test(msg)) {
        if (capturedStream) capturedStream.getTracks().forEach((t) => t.stop());
        showToast('扩展已更新或重载，请先刷新当前网页后再同步', true, false);
        return;
      }
      // Retry once in case MV3 Service Worker was cold-starting
      try {
        await new Promise((r) => setTimeout(r, 150));
        response = await sendSyncMsg();
      } catch (retryErr) {
        console.warn('[AdaptiveWall] SYNC_VIDEO_REQUEST failed:', retryErr);
        if (capturedStream) capturedStream.getTracks().forEach((t) => t.stop());
        showToast('无法连接视频墙后台服务，请刷新网页或重载扩展后重试', true, false);
        return;
      }
    }

    if (!response || !response.ok) {
      if (capturedStream) capturedStream.getTracks().forEach((t) => t.stop());
      showToast('同步视频失败，请重试', true, false);
      return;
    }

    syncedUids.add(uid);
    if (hoverVideo === video && hoverPillEl) {
      hoverPillEl.textContent = '✓ 已同步到视频墙';
      hoverPillEl.classList.add('is-synced');
    }

    if (response.alreadySynced) {
      if (capturedStream) capturedStream.getTracks().forEach((t) => t.stop());
      showToast('该视频已在视频墙中同步', false, true);
      return;
    }

    const streamId = response.streamId;
    setupPeerSession(streamId, video, uid, capturedStream, transport);
    showToast('已同步到自适应视频墙 ✓', false, !settings.focusWallOnSync);
  }

  function setupPeerSession(streamId, video, uid, initialStream, transport) {
    let pc = null;
    let currentStream = initialStream;
    let remoteDescriptionSet = false;
    const pendingIce = [];
    let startedOffer = false;
    let needsRefreshOnPlay = false;
    let refreshing = false;
    let lastObservedTime = video.currentTime || 0;
    let userPaused = video.paused;
    let keepAliveTimestamps = [];

    const tryKeepAlivePlay = () => {
      if (userPaused || video.ended || !video.paused) return;
      const now = Date.now();
      keepAliveTimestamps = keepAliveTimestamps.filter((t) => now - t < 2000);
      if (keepAliveTimestamps.length >= 4) return; // Prevent tight retry loop
      keepAliveTimestamps.push(now);
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => { });
    };

    const sendState = () => {
      const curTime = video.currentTime || 0;
      const loopedBack = !video.paused && !video.ended && lastObservedTime - curTime > 1.5;
      lastObservedTime = curTime;

      if (!userPaused && video.paused && !video.ended && document.hidden) {
        tryKeepAlivePlay();
      }

      if (
        transport === 'webrtc' &&
        pc &&
        !video.paused &&
        !video.ended &&
        (loopedBack || (currentStream && currentStream.getTracks().some((t) => t.readyState === 'ended')))
      ) {
        refreshCaptureStream();
      }
      const vw = video.videoWidth || 0;
      const vh = video.videoHeight || 0;
      chrome.runtime
        .sendMessage({
          type: 'SOURCE_VIDEO_STATE',
          streamId,
          state: {
            paused: video.paused,
            ended: video.ended,
            currentTime: video.currentTime || 0,
            duration: Number.isFinite(video.duration) ? video.duration : 0,
            playbackRate: video.playbackRate || 1,
            videoWidth: vw,
            videoHeight: vh,
            aspectRatio: vw > 0 && vh > 0 ? vw / vh : undefined
          }
        })
        .catch(() => { });
    };

    function bindTrackEnded(stream) {
      if (!stream) return;
      stream.getTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (!video.paused && !video.ended) {
            refreshCaptureStream();
          } else {
            needsRefreshOnPlay = true;
          }
        });
      });
    }

    async function refreshCaptureStream() {
      if (transport !== 'webrtc' || !pc || refreshing) return;
      refreshing = true;
      needsRefreshOnPlay = false;
      try {
        const fn = video.captureStream || video.mozCaptureStream;
        if (typeof fn !== 'function') return;
        const nextStream = fn.call(video);
        const nextTracks = nextStream ? nextStream.getTracks() : [];
        if (nextTracks.length === 0) return;

        const senders = pc.getSenders();
        for (let i = 0; i < senders.length; i++) {
          const sender = senders[i];
          const kind = sender.track ? sender.track.kind : null;
          if (!kind) continue;
          const replacement = nextTracks.find((t) => t.kind === kind && t.readyState === 'live');
          if (replacement && replacement !== sender.track) {
            await sender.replaceTrack(replacement).catch(() => { });
          }
        }

        const oldStream = currentStream;
        currentStream = nextStream;
        session.stream = nextStream;
        bindTrackEnded(nextStream);
        if (oldStream && oldStream !== nextStream) {
          oldStream.getTracks().forEach((t) => {
            if (!nextTracks.includes(t)) t.stop();
          });
        }
      } catch (_err) {
        // Ignore transient capture errors during seek/loop
      } finally {
        refreshing = false;
      }
    }

    const onVideoEnded = () => {
      needsRefreshOnPlay = true;
      sendState();
    };

    const onVideoResume = () => {
      if (
        needsRefreshOnPlay ||
        (currentStream && currentStream.getTracks().some((t) => t.readyState === 'ended'))
      ) {
        refreshCaptureStream();
      }
      sendState();
    };

    const onVideoPlay = () => {
      userPaused = false;
      sendState();
    };

    const onVideoPause = () => {
      if (!document.hidden && document.hasFocus()) {
        // User paused directly on the active source page
        userPaused = true;
      } else if (!userPaused && !video.ended) {
        // Background tab pause (site visibility handler or browser throttling) -> keep alive
        setTimeout(tryKeepAlivePlay, 30);
      }
      sendState();
    };

    const onVisibilityChange = () => {
      if (document.hidden && !userPaused && !video.ended) {
        setTimeout(tryKeepAlivePlay, 60);
      }
    };

    if (currentStream) bindTrackEnded(currentStream);

    const events = ['seeked', 'ratechange', 'resize', 'loadedmetadata'];
    events.forEach((ev) => video.addEventListener(ev, sendState));
    video.addEventListener('play', onVideoPlay);
    video.addEventListener('pause', onVideoPause);
    video.addEventListener('ended', onVideoEnded);
    video.addEventListener('playing', onVideoResume);
    video.addEventListener('loadeddata', onVideoResume);
    document.addEventListener('visibilitychange', onVisibilityChange, true);
    const timer = setInterval(sendState, 500);

    async function startWebRTCOffer() {
      if (transport !== 'webrtc' || !currentStream || startedOffer) return;
      startedOffer = true;

      pc = new RTCPeerConnection({ iceServers: [] });
      session.pc = pc;

      currentStream.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, currentStream);
        if (track.kind === 'video' && sender && typeof sender.setParameters === 'function') {
          try {
            const params = sender.getParameters();
            params.degradationPreference = 'maintain-resolution';
            sender.setParameters(params).catch(() => { });
          } catch (_err) {
            // Ignore unsupported sender parameter
          }
        }
      });

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          chrome.runtime
            .sendMessage({
              type: 'RTC_SIGNAL',
              streamId,
              signal: { type: 'ice', candidate: e.candidate.toJSON() }
            })
            .catch(() => { });
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await chrome.runtime.sendMessage({
        type: 'RTC_SIGNAL',
        streamId,
        signal: { type: 'offer', sdp: pc.localDescription.sdp }
      });
    }

    async function handleSignal(signal) {
      if (!pc) return;
      if (signal.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        remoteDescriptionSet = true;
        while (pendingIce.length > 0) {
          const cand = pendingIce.shift();
          await pc.addIceCandidate(cand).catch(() => { });
        }
      } else if (signal.type === 'ice' && signal.candidate) {
        if (remoteDescriptionSet) {
          await pc.addIceCandidate(signal.candidate).catch(() => { });
        } else {
          pendingIce.push(signal.candidate);
        }
      }
    }

    function handleControl(action, value) {
      if (action === 'play') {
        userPaused = false;
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(() => { });
      } else if (action === 'pause') {
        userPaused = true;
        video.pause();
      } else if (action === 'seek' && Number.isFinite(value)) {
        video.currentTime = value;
      } else if (action === 'setRate' && Number.isFinite(value) && value > 0) {
        video.playbackRate = value;
      } else if (action === 'stop') {
        cleanup();
      }
      setTimeout(sendState, 50);
    }

    function cleanup() {
      clearInterval(timer);
      events.forEach((ev) => video.removeEventListener(ev, sendState));
      video.removeEventListener('play', onVideoPlay);
      video.removeEventListener('pause', onVideoPause);
      video.removeEventListener('ended', onVideoEnded);
      video.removeEventListener('playing', onVideoResume);
      video.removeEventListener('loadeddata', onVideoResume);
      document.removeEventListener('visibilitychange', onVisibilityChange, true);
      if (pc) {
        try {
          pc.close();
        } catch (_err) {
          // Ignore
        }
        pc = null;
      }
      if (currentStream) {
        currentStream.getTracks().forEach((t) => t.stop());
        currentStream = null;
      }
      activePeers.delete(streamId);
      syncedUids.delete(uid);
      if (hoverVideo === video && hoverPillEl) {
        hoverPillEl.textContent = '⊞ 同步到视频墙';
        hoverPillEl.classList.remove('is-synced');
      }
    }

    const session = {
      pc,
      stream: currentStream,
      video,
      uid,
      startWebRTCOffer,
      handleSignal,
      handleControl,
      cleanup
    };

    activePeers.set(streamId, session);
    sendState();

    if (pendingPeerReady.has(streamId)) {
      pendingPeerReady.delete(streamId);
      startWebRTCOffer();
    }
  }

  // ===== Save / Record Video =====
  function pickRecorderMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm'
    ];
    for (let i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function formatRecTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  async function saveVideoElement(video) {
    if (!video) return;
    const title = getBestTitle(video);
    const src = video.currentSrc || '';

    // 1. Direct downloadable http(s) URL (non-blob)
    if (/^https?:\/\//i.test(src) && !src.startsWith('blob:')) {
      const extMatch = src.split('?')[0].match(/\.(mp4|webm|mov|m4v|mkv|ogv)$/i);
      const ext = extMatch ? '.' + extMatch[1].toLowerCase() : '.mp4';
      const res = await chrome.runtime
        .sendMessage({
          type: 'DOWNLOAD_VIDEO_URL',
          url: src,
          filename: title + ext,
          saveAs: true
        })
        .catch(() => null);
      if (res && res.ok) {
        showToast('已开始下载视频 ✓', false, false);
      } else {
        showToast('下载请求失败，请检查权限或重试', true, false);
      }
      return;
    }

    // 2. Toggle off existing recording
    if (activeRecorderSession) {
      activeRecorderSession.stopAndSave();
      return;
    }

    // 3. Record live MSE / blob stream via captureStream() + MediaRecorder
    let stream = null;
    try {
      const fn = video.captureStream || video.mozCaptureStream;
      if (typeof fn === 'function') {
        stream = fn.call(video);
      }
    } catch (_err) {
      stream = null;
    }

    if (!stream || stream.getTracks().length === 0) {
      showToast('该视频受版权保护 (DRM) 或跨域限制，无法保存', true, false);
      return;
    }

    const mimeType = pickRecorderMimeType();
    let recorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (_err) {
      stream.getTracks().forEach((t) => t.stop());
      showToast('浏览器不支持录制该视频流', true, false);
      return;
    }

    ensureOverlayUi();
    const chunks = [];
    const startedAt = Date.now();
    let stopped = false;

    const updateRecText = () => {
      if (shadowRoot && shadowRoot._recText) {
        const secs = Math.floor((Date.now() - startedAt) / 1000);
        shadowRoot._recText.textContent = `正在录制视频 ${formatRecTime(secs)} · 点击停止并保存`;
      }
    };

    if (shadowRoot && shadowRoot._recPill) {
      shadowRoot._recPill.style.display = 'inline-flex';
      updateRecText();
    }
    const recTimer = setInterval(updateRecText, 500);

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const stopAndSave = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(recTimer);
      video.removeEventListener('ended', stopAndSave);
      if (shadowRoot && shadowRoot._recPill) {
        shadowRoot._recPill.style.display = 'none';
      }
      activeRecorderSession = null;
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
    };

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (chunks.length === 0) {
        showToast('未捕获到有效视频数据，请确保视频正在播放', true, false);
        return;
      }
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
      const blobUrl = URL.createObjectURL(blob);
      const res = await chrome.runtime
        .sendMessage({
          type: 'DOWNLOAD_VIDEO_URL',
          url: blobUrl,
          filename: title + '.webm',
          saveAs: true
        })
        .catch(() => null);
      if (!res || !res.ok) {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = title.replace(/[\\/:*?"<>|]+/g, '_') + '.webm';
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      showToast('视频已保存为 WebM 文件 ✓', false, false);
    };

    video.addEventListener('ended', stopAndSave);
    activeRecorderSession = { stopAndSave };
    recorder.start(500);
    showToast('已开始录制当前视频，再次点击或播放结束将自动保存', false, false);
  }

  // ===== Exposed Hooks & Event Listeners =====
  globalThis.__adaptiveWallScan = scanVideosForPopup;
  globalThis.__adaptiveWallEnterPicker = enterPickerMode;
  globalThis.__adaptiveWallExitPicker = exitPickerMode;

  document.addEventListener(
    'contextmenu',
    (e) => {
      lastContextVideo = hitTestVideo(e.clientX, e.clientY, 60, 45, true);
      lastContextTime = Date.now();
    },
    { capture: true, passive: true }
  );

  window.addEventListener(
    'scroll',
    () => {
      if (hoverPillEl && !hoverLockOnButton) {
        hoverPillEl.style.display = 'none';
      }
    },
    { passive: true, capture: true }
  );

  window.addEventListener(
    'keydown',
    (e) => {
      if (pickerActive && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'EXIT_PICKER_MODE' }).catch(() => { });
        exitPickerMode();
      }
    },
    true
  );

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'PING') {
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'ENTER_PICKER_MODE') {
        enterPickerMode();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'EXIT_PICKER_MODE') {
        exitPickerMode();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'SYNC_VIDEO_BY_UID') {
        const video = uidToVideoMap.get(msg.videoUid);
        if (video) {
          syncVideoElement(video);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'Video not found' });
        }
        return;
      }

      if (msg.type === 'SAVE_VIDEO_BY_UID') {
        const video = uidToVideoMap.get(msg.videoUid);
        if (video) {
          saveVideoElement(video);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'Video not found' });
        }
        return;
      }

      if (msg.type === 'SYNC_CONTEXT_VIDEO') {
        const target =
          lastContextVideo && lastContextVideo.isConnected && Date.now() - lastContextTime < 20000
            ? lastContextVideo
            : null;
        if (target) {
          syncVideoElement(target);
          sendResponse({ ok: true, found: true });
        } else {
          sendResponse({ ok: true, found: false });
        }
        return;
      }

      if (msg.type === 'SAVE_CONTEXT_VIDEO') {
        let target =
          lastContextVideo && lastContextVideo.isConnected && Date.now() - lastContextTime < 20000
            ? lastContextVideo
            : null;
        if (!target) {
          const all = findAllVideos().filter((v) => v.readyState >= 1 || v.currentSrc);
          target = all.find((v) => !v.paused && !v.ended) || all[0] || null;
        }
        if (target) {
          saveVideoElement(target);
          sendResponse({ ok: true, found: true });
        } else {
          showToast('当前页面未找到可保存的视频', true, false);
          sendResponse({ ok: true, found: false });
        }
        return;
      }

      if (msg.type === 'WALL_PEER_READY') {
        const session = activePeers.get(msg.streamId);
        if (session) {
          session.startWebRTCOffer();
        } else {
          pendingPeerReady.add(msg.streamId);
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'RTC_SIGNAL') {
        const session = activePeers.get(msg.streamId);
        if (session) session.handleSignal(msg.signal);
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'REMOTE_VIDEO_CONTROL') {
        const session = activePeers.get(msg.streamId);
        if (session) session.handleControl(msg.action, msg.value);
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'SYNC_STATUS_CHANGED') {
        if (!msg.synced && msg.videoUid) {
          syncedUids.delete(msg.videoUid);
        }
        sendResponse({ ok: true });
      }
    });

    // Hydrate initial settings & already-synced UIDs only when videos exist
    chrome.runtime
      .sendMessage({ type: 'GET_SETTINGS' })
      .then((res) => {
        if (res && res.settings) settings = Object.assign(settings, res.settings);
      })
      .catch(() => { });

    if (document.getElementsByTagName('video').length > 0) {
      chrome.runtime
        .sendMessage({ type: 'GET_ACTIVE_STREAM_KEYS' })
        .then((res) => {
          if (res && Array.isArray(res.videoUids)) {
            res.videoUids.forEach((uid) => syncedUids.add(uid));
          }
        })
        .catch(() => { });
    }

    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings && changes.settings.newValue) {
          settings = Object.assign(settings, changes.settings.newValue);
          if (!settings.showHoverButton && hoverPillEl) {
            hoverPillEl.style.display = 'none';
          }
        }
      });
    }
  }
})();
