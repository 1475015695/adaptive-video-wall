/**
 * Chrome MV3 Background Service Worker
 *
 * Manages Wall tab/window lifecycle, dynamic multi-frame content script injection,
 * WebRTC signaling routing, source-tab auto-mute/unmute restoration, and toolbar actions.
 */
(function (root) {
  'use strict';

  const DEFAULT_SETTINGS = {
    showHoverButton: false,
    focusWallOnSync: false,
    autoMuteSourceTab: true
  };

  function sanitizeFilename(name, fallbackExt) {
    const clean = String(name || 'video')
      .replace(/[\\/:*?"<>|\r\n]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    const base = clean || 'video';
    if (/\.(mp4|webm|mov|m4v|mkv|ogv)$/i.test(base)) return base;
    return base + (fallbackExt || '.mp4');
  }

  function isInjectableUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (!/^(https?|file):\/\//i.test(url)) return false;
    if (/^https:\/\/chrome(webstore)?\.google\.com/i.test(url)) return false;
    return true;
  }

  function createBackgroundController(chromeApi) {
    let wallTabId = null;
    let wallReady = false;
    let creatingWallPromise = null;
    let streamSeq = 0;

    const pendingAdds = [];
    const streams = new Map(); // streamId -> { streamId, sourceTabId, sourceFrameId, videoUid, transport, meta }
    const videoKeyToStreamId = new Map(); // `${tabId}:${frameId}:${videoUid}` -> streamId
    const autoMutedTabs = new Set();

    function wallUrl() {
      return chromeApi.runtime.getURL('index.html');
    }

    async function persistAutoMutedTabs() {
      if (!chromeApi.storage || !chromeApi.storage.session) return;
      try {
        await chromeApi.storage.session.set({
          autoMutedTabs: Array.from(autoMutedTabs)
        });
      } catch (_err) {
        // Ignore session storage errors in restricted environments
      }
    }

    async function loadAutoMutedTabs() {
      if (!chromeApi.storage || !chromeApi.storage.session) return;
      try {
        const res = await chromeApi.storage.session.get('autoMutedTabs');
        if (Array.isArray(res && res.autoMutedTabs)) {
          res.autoMutedTabs.forEach((id) => autoMutedTabs.add(id));
        }
      } catch (_err) {
        // Ignore
      }
    }

    async function getSettings() {
      if (!chromeApi.storage || !chromeApi.storage.local) {
        return Object.assign({}, DEFAULT_SETTINGS);
      }
      try {
        const data = await chromeApi.storage.local.get('settings');
        return Object.assign({}, DEFAULT_SETTINGS, (data && data.settings) || {});
      } catch (_err) {
        return Object.assign({}, DEFAULT_SETTINGS);
      }
    }

    async function updateBadge() {
      if (!chromeApi.action || !chromeApi.action.setBadgeText) return;
      try {
        const count = streams.size;
        await chromeApi.action.setBadgeText({ text: count > 0 ? String(count) : '' });
        if (count > 0 && chromeApi.action.setBadgeBackgroundColor) {
          await chromeApi.action.setBadgeBackgroundColor({ color: '#0ea5e9' });
        }
      } catch (_err) {
        // Ignore
      }
    }

    async function safeSendToTab(tabId, message, options) {
      if (tabId === null || tabId === undefined) return null;
      try {
        if (options && typeof options.frameId === 'number') {
          return await chromeApi.tabs.sendMessage(tabId, message, { frameId: options.frameId });
        }
        return await chromeApi.tabs.sendMessage(tabId, message);
      } catch (_err) {
        return null;
      }
    }

    async function findExistingWallTab() {
      if (wallTabId !== null) {
        try {
          const t = await chromeApi.tabs.get(wallTabId);
          if (t && t.url && t.url.startsWith(wallUrl())) {
            return t;
          }
        } catch (_err) {
          wallTabId = null;
          wallReady = false;
        }
      }
      try {
        const tabs = await chromeApi.tabs.query({ url: wallUrl() + '*' });
        if (tabs && tabs.length > 0) {
          wallTabId = tabs[0].id;
          if (!wallReady) {
            const pingRes = await safeSendToTab(wallTabId, { type: 'WALL_PING' });
            if (pingRes && pingRes.ok) {
              wallReady = true;
            }
          }
          return tabs[0];
        }
      } catch (_err) {
        // Ignore
      }
      return null;
    }

    async function focusTab(tab) {
      if (!tab) return;
      try {
        if (chromeApi.windows && typeof tab.windowId === 'number') {
          await chromeApi.windows.update(tab.windowId, { focused: true });
        }
        await chromeApi.tabs.update(tab.id, { active: true });
      } catch (_err) {
        // Ignore
      }
    }

    /**
     * focusMode: 'always' | 'settings' | 'initial-only'
     */
    async function getOrCreateWallTab(focusMode, settings) {
      const existing = await findExistingWallTab();
      if (existing) {
        const shouldFocus =
          focusMode === 'always' ||
          (focusMode === 'settings' && settings && settings.focusWallOnSync);
        if (shouldFocus) {
          await focusTab(existing);
        }
        return existing;
      }

      if (creatingWallPromise) {
        return await creatingWallPromise;
      }

      creatingWallPromise = (async () => {
        try {
          wallReady = false;
          const tab = await chromeApi.tabs.create({ url: wallUrl(), active: true });
          wallTabId = tab.id;
          return tab;
        } finally {
          creatingWallPromise = null;
        }
      })();

      return await creatingWallPromise;
    }

    async function openWallPopoutWindow() {
      const existing = await findExistingWallTab();
      if (existing) {
        await focusTab(existing);
        return existing;
      }
      wallReady = false;
      const win = await chromeApi.windows.create({
        url: wallUrl(),
        type: 'popup',
        width: 1280,
        height: 760
      });
      if (win && win.tabs && win.tabs[0]) {
        wallTabId = win.tabs[0].id;
        return win.tabs[0];
      }
      return null;
    }

    async function ensureContentScript(tabId) {
      let tab;
      try {
        tab = await chromeApi.tabs.get(tabId);
      } catch (_err) {
        return false;
      }
      if (!tab || !isInjectableUrl(tab.url)) return false;

      const pong = await safeSendToTab(tabId, { type: 'PING' });
      if (pong && pong.ok) return true;

      try {
        await chromeApi.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ['extension/content.js']
        });
        return true;
      } catch (_err) {
        return false;
      }
    }

    async function scanTabVideos(tabId) {
      const ok = await ensureContentScript(tabId);
      if (!ok) {
        return { ok: false, restricted: true, videos: [] };
      }
      try {
        const results = await chromeApi.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => (globalThis.__adaptiveWallScan ? globalThis.__adaptiveWallScan() : [])
        });

        const videos = [];
        for (let i = 0; i < (results || []).length; i++) {
          const frameRes = results[i];
          const frameId = typeof frameRes.frameId === 'number' ? frameRes.frameId : 0;
          const list = Array.isArray(frameRes.result) ? frameRes.result : [];
          for (let j = 0; j < list.length; j++) {
            const v = list[j];
            const key = `${tabId}:${frameId}:${v.videoUid}`;
            videos.push(
              Object.assign({}, v, {
                tabId,
                frameId,
                alreadySynced: videoKeyToStreamId.has(key)
              })
            );
          }
        }

        videos.sort((a, b) => {
          if (a.isPlaying !== b.isPlaying) return a.isPlaying ? -1 : 1;
          return b.width * b.height - a.width * a.height;
        });

        return { ok: true, restricted: false, videos };
      } catch (_err) {
        return { ok: false, restricted: true, videos: [] };
      }
    }

    async function setMainWorldKeepAlive(tabId, frameId, delta) {
      if (!chromeApi.scripting || !chromeApi.scripting.executeScript) return;
      try {
        await chromeApi.scripting.executeScript({
          target: { tabId, frameIds: [typeof frameId === 'number' ? frameId : 0] },
          world: 'MAIN',
          args: [delta],
          func: (d) => {
            window.__adaptiveWallKeepAliveCount = Math.max(
              0,
              (window.__adaptiveWallKeepAliveCount || 0) + d
            );
            const active = window.__adaptiveWallKeepAliveCount > 0;
            if (active && !window.__adaptiveWallVisPatched) {
              window.__adaptiveWallVisPatched = true;
              const docProto = Document.prototype;
              window.__adaptiveWallOrigHidden = Object.getOwnPropertyDescriptor(docProto, 'hidden');
              window.__adaptiveWallOrigVisState = Object.getOwnPropertyDescriptor(
                docProto,
                'visibilityState'
              );
              try {
                Object.defineProperty(document, 'hidden', {
                  configurable: true,
                  get: () =>
                    window.__adaptiveWallKeepAliveCount > 0
                      ? false
                      : window.__adaptiveWallOrigHidden?.get?.call(document) ?? false
                });
                Object.defineProperty(document, 'visibilityState', {
                  configurable: true,
                  get: () =>
                    window.__adaptiveWallKeepAliveCount > 0
                      ? 'visible'
                      : window.__adaptiveWallOrigVisState?.get?.call(document) ?? 'visible'
                });
              } catch (_e) {
                // Ignore non-configurable document properties
              }
              window.__adaptiveWallVisBlocker = (ev) => {
                if (window.__adaptiveWallKeepAliveCount > 0 && document.visibilityState === 'visible') {
                  ev.stopImmediatePropagation();
                }
              };
              document.addEventListener('visibilitychange', window.__adaptiveWallVisBlocker, true);
              document.addEventListener('webkitvisibilitychange', window.__adaptiveWallVisBlocker, true);
            } else if (!active && window.__adaptiveWallVisPatched) {
              window.__adaptiveWallVisPatched = false;
              try {
                delete document.hidden;
                delete document.visibilityState;
              } catch (_e) {
                // Ignore
              }
              if (window.__adaptiveWallVisBlocker) {
                document.removeEventListener('visibilitychange', window.__adaptiveWallVisBlocker, true);
                document.removeEventListener(
                  'webkitvisibilitychange',
                  window.__adaptiveWallVisBlocker,
                  true
                );
              }
            }
          }
        });
      } catch (_err) {
        // Ignore restricted frames
      }
    }

    async function maybeRestoreSourceTabMute(sourceTabId) {
      if (sourceTabId === null || sourceTabId === undefined) return;
      let hasAnyStream = false;
      let hasWebRtcStream = false;
      for (const s of streams.values()) {
        if (s.sourceTabId === sourceTabId) {
          hasAnyStream = true;
          if (s.transport === 'webrtc') hasWebRtcStream = true;
        }
      }
      if (!hasAnyStream) {
        try {
          await chromeApi.tabs.update(sourceTabId, { autoDiscardable: true });
        } catch (_err) {
          // Ignore closed tab
        }
      }
      if (hasWebRtcStream) return;
      if (autoMutedTabs.has(sourceTabId)) {
        autoMutedTabs.delete(sourceTabId);
        await persistAutoMutedTabs();
        try {
          await chromeApi.tabs.update(sourceTabId, { muted: false });
        } catch (_err) {
          // Tab might already be closed
        }
      }
    }

    async function cleanupStream(streamId, notifySource) {
      const stream = streams.get(streamId);
      if (!stream) return;

      streams.delete(streamId);
      const key = `${stream.sourceTabId}:${stream.sourceFrameId}:${stream.videoUid}`;
      videoKeyToStreamId.delete(key);

      await setMainWorldKeepAlive(stream.sourceTabId, stream.sourceFrameId, -1);

      if (notifySource) {
        await safeSendToTab(
          stream.sourceTabId,
          { type: 'REMOTE_VIDEO_CONTROL', streamId, action: 'stop' },
          { frameId: stream.sourceFrameId }
        );
      } else {
        await safeSendToTab(
          stream.sourceTabId,
          { type: 'SYNC_STATUS_CHANGED', videoUid: stream.videoUid, synced: false },
          { frameId: stream.sourceFrameId }
        );
      }

      await maybeRestoreSourceTabMute(stream.sourceTabId);
      await updateBadge();
    }

    async function flushPendingAdds() {
      if (!wallReady || wallTabId === null || pendingAdds.length === 0) return;
      const queued = pendingAdds.splice(0, pendingAdds.length);
      for (let i = 0; i < queued.length; i++) {
        await safeSendToTab(wallTabId, queued[i]);
      }
    }

    async function enterPickerMode(tabId) {
      let targetTabId = tabId;
      if (targetTabId === null || targetTabId === undefined) {
        const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
        if (!tabs || !tabs[0]) return { ok: false };
        targetTabId = tabs[0].id;
      }
      const ok = await ensureContentScript(targetTabId);
      if (!ok) return { ok: false, restricted: true };

      try {
        const results = await chromeApi.scripting.executeScript({
          target: { tabId: targetTabId, allFrames: true },
          func: () => (globalThis.__adaptiveWallEnterPicker ? globalThis.__adaptiveWallEnterPicker() : false)
        });
        return { ok: Array.isArray(results) && results.some((r) => r.result) };
      } catch (_err) {
        await safeSendToTab(targetTabId, { type: 'ENTER_PICKER_MODE' });
        return { ok: true };
      }
    }

    async function exitPickerMode(tabId) {
      if (tabId === null || tabId === undefined) return;
      try {
        await chromeApi.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => {
            if (globalThis.__adaptiveWallExitPicker) globalThis.__adaptiveWallExitPicker();
          }
        });
      } catch (_err) {
        await safeSendToTab(tabId, { type: 'EXIT_PICKER_MODE' });
      }
    }

    async function handleSyncVideoRequest(msg, sender) {
      if (!sender || !sender.tab) return { ok: false, error: 'Missing sender tab' };
      const sourceTabId = sender.tab.id;
      const sourceFrameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
      const videoUid = msg.videoUid;
      const videoKey = `${sourceTabId}:${sourceFrameId}:${videoUid}`;
      const settings = await getSettings();

      if (videoKeyToStreamId.has(videoKey)) {
        const existingId = videoKeyToStreamId.get(videoKey);
        const existingTab = await getOrCreateWallTab('settings', settings);
        if (existingTab && wallReady) {
          await safeSendToTab(existingTab.id, { type: 'WALL_HIGHLIGHT_VIDEO', streamId: existingId });
        }
        return { ok: true, alreadySynced: true, streamId: existingId };
      }

      const streamId = `sync-${++streamSeq}-${Date.now().toString(36)}`;
      const streamEntry = {
        streamId,
        sourceTabId,
        sourceFrameId,
        videoUid,
        transport: msg.transport || 'webrtc',
        meta: Object.assign({}, msg.meta || {}, {
          sourceTabId,
          sourceFrameId,
          videoUid
        })
      };

      streams.set(streamId, streamEntry);
      videoKeyToStreamId.set(videoKey, streamId);

      // Prevent Chrome Memory Saver from discarding active source tab & keep page visibility alive
      try {
        await chromeApi.tabs.update(sourceTabId, { autoDiscardable: false });
      } catch (_err) {
        // Ignore
      }
      await setMainWorldKeepAlive(sourceTabId, sourceFrameId, +1);

      // Auto-mute source tab for WebRTC streams so audio isn't doubled
      if (streamEntry.transport === 'webrtc' && settings.autoMuteSourceTab) {
        try {
          const srcTab = await chromeApi.tabs.get(sourceTabId);
          const alreadyMuted = Boolean(srcTab && srcTab.mutedInfo && srcTab.mutedInfo.muted);
          if (!alreadyMuted) {
            await chromeApi.tabs.update(sourceTabId, { muted: true });
            autoMutedTabs.add(sourceTabId);
            await persistAutoMutedTabs();
          }
        } catch (_err) {
          // Ignore if tab mute fails
        }
      }

      const wallTab = await getOrCreateWallTab('settings', settings);
      const addPayload = {
        type: 'WALL_ADD_SYNCED_VIDEO',
        streamId,
        transport: streamEntry.transport,
        src: msg.src || null,
        meta: streamEntry.meta
      };

      if (wallReady && wallTab && wallTab.id === wallTabId) {
        // Send after returning SYNC_VIDEO_REQUEST response so content.js registers activePeers first
        setTimeout(async () => {
          const sent = await safeSendToTab(wallTabId, addPayload);
          if (sent === null) {
            wallReady = false;
            pendingAdds.push(addPayload);
          }
        }, 0);
      } else {
        pendingAdds.push(addPayload);
      }

      await updateBadge();
      return { ok: true, alreadySynced: false, streamId };
    }

    async function handleMessage(msg, sender) {
      if (!msg || typeof msg.type !== 'string') return { ok: false };

      switch (msg.type) {
        case 'PING':
          return { ok: true };

        case 'GET_SETTINGS':
          return { ok: true, settings: await getSettings() };

        case 'SET_SETTINGS': {
          const next = Object.assign({}, await getSettings(), msg.settings || {});
          if (chromeApi.storage && chromeApi.storage.local) {
            await chromeApi.storage.local.set({ settings: next });
          }
          return { ok: true, settings: next };
        }

        case 'GET_ACTIVE_STREAM_KEYS': {
          if (!sender || !sender.tab) return { ok: true, videoUids: [] };
          const tabId = sender.tab.id;
          const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
          const uids = [];
          for (const s of streams.values()) {
            if (s.sourceTabId === tabId && s.sourceFrameId === frameId) {
              uids.push(s.videoUid);
            }
          }
          return { ok: true, videoUids: uids };
        }

        case 'SYNC_VIDEO_REQUEST':
          return await handleSyncVideoRequest(msg, sender);

        case 'WALL_READY': {
          if (sender && sender.tab) {
            wallTabId = sender.tab.id;
          }
          wallReady = true;
          await flushPendingAdds();
          return { ok: true, activeStreamIds: Array.from(streams.keys()) };
        }

        case 'WALL_PEER_READY': {
          const stream = streams.get(msg.streamId);
          if (!stream) return { ok: false };
          await safeSendToTab(
            stream.sourceTabId,
            { type: 'WALL_PEER_READY', streamId: msg.streamId },
            { frameId: stream.sourceFrameId }
          );
          return { ok: true };
        }

        case 'RTC_SIGNAL': {
          const stream = streams.get(msg.streamId);
          if (!stream) return { ok: false };
          const fromWall = sender && sender.tab && sender.tab.id === wallTabId;
          if (fromWall) {
            await safeSendToTab(
              stream.sourceTabId,
              { type: 'RTC_SIGNAL', streamId: msg.streamId, signal: msg.signal },
              { frameId: stream.sourceFrameId }
            );
          } else if (wallTabId !== null) {
            await safeSendToTab(wallTabId, {
              type: 'RTC_SIGNAL',
              streamId: msg.streamId,
              signal: msg.signal
            });
          }
          return { ok: true };
        }

        case 'SOURCE_VIDEO_STATE': {
          if (wallTabId !== null && wallReady) {
            await safeSendToTab(wallTabId, {
              type: 'WALL_SOURCE_STATE',
              streamId: msg.streamId,
              state: msg.state
            });
          }
          return { ok: true };
        }

        case 'REMOTE_VIDEO_CONTROL': {
          const stream = streams.get(msg.streamId);
          if (!stream) return { ok: false };

          if (msg.action === 'jumpToTab') {
            try {
              const srcTab = await chromeApi.tabs.get(stream.sourceTabId);
              await focusTab(srcTab);
            } catch (_err) {
              return { ok: false };
            }
            return { ok: true };
          }

          if (msg.action === 'stop') {
            await cleanupStream(msg.streamId, true);
            return { ok: true };
          }

          await safeSendToTab(
            stream.sourceTabId,
            {
              type: 'REMOTE_VIDEO_CONTROL',
              streamId: msg.streamId,
              action: msg.action,
              value: msg.value
            },
            { frameId: stream.sourceFrameId }
          );
          return { ok: true };
        }

        case 'OPEN_WALL_TAB': {
          const tab = await getOrCreateWallTab('always', await getSettings());
          return { ok: Boolean(tab), tabId: tab ? tab.id : null };
        }

        case 'OPEN_WALL_POPOUT': {
          const tab = await openWallPopoutWindow();
          return { ok: Boolean(tab), tabId: tab ? tab.id : null };
        }

        case 'SCAN_TAB_VIDEOS': {
          let tabId = msg.tabId;
          if (tabId === null || tabId === undefined) {
            const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
            if (!tabs || !tabs[0]) return { ok: false, restricted: true, videos: [] };
            tabId = tabs[0].id;
          }
          return await scanTabVideos(tabId);
        }

        case 'START_SYNC_BY_UID': {
          await safeSendToTab(
            msg.tabId,
            { type: 'SYNC_VIDEO_BY_UID', videoUid: msg.videoUid },
            { frameId: msg.frameId || 0 }
          );
          return { ok: true };
        }

        case 'START_SAVE_BY_UID': {
          await safeSendToTab(
            msg.tabId,
            { type: 'SAVE_VIDEO_BY_UID', videoUid: msg.videoUid },
            { frameId: msg.frameId || 0 }
          );
          return { ok: true };
        }

        case 'DOWNLOAD_VIDEO_URL': {
          if (!msg.url || !chromeApi.downloads || !chromeApi.downloads.download) {
            return { ok: false, error: 'Downloads API unavailable' };
          }
          try {
            const filename = sanitizeFilename(msg.filename, '.mp4');
            const downloadId = await chromeApi.downloads.download({
              url: msg.url,
              filename,
              saveAs: msg.saveAs !== false
            });
            return { ok: true, downloadId };
          } catch (err) {
            return { ok: false, error: String(err && err.message ? err.message : err) };
          }
        }

        case 'ENTER_PICKER_MODE':
          return await enterPickerMode(msg.tabId);

        case 'EXIT_PICKER_MODE': {
          const tabId = msg.tabId || (sender && sender.tab && sender.tab.id);
          await exitPickerMode(tabId);
          return { ok: true };
        }

        case 'WALL_COUNT_CHANGED': {
          // Fallback badge sync when wall holds mix of local + synced videos
          if (streams.size === 0 && chromeApi.action && chromeApi.action.setBadgeText) {
            const c = Number(msg.count) || 0;
            try {
              await chromeApi.action.setBadgeText({ text: c > 0 ? String(c) : '' });
            } catch (_err) {
              // Ignore
            }
          }
          return { ok: true };
        }

        default:
          return { ok: false };
      }
    }

    async function handleTabRemoved(tabId) {
      if (tabId === wallTabId) {
        const activeIds = Array.from(streams.keys());
        for (let i = 0; i < activeIds.length; i++) {
          const s = streams.get(activeIds[i]);
          if (s) {
            await setMainWorldKeepAlive(s.sourceTabId, s.sourceFrameId, -1);
            try {
              await chromeApi.tabs.update(s.sourceTabId, { autoDiscardable: true });
            } catch (_err) {
              // Ignore
            }
            await safeSendToTab(
              s.sourceTabId,
              { type: 'REMOTE_VIDEO_CONTROL', streamId: s.streamId, action: 'stop' },
              { frameId: s.sourceFrameId }
            );
          }
        }
        streams.clear();
        videoKeyToStreamId.clear();
        pendingAdds.length = 0;
        wallTabId = null;
        wallReady = false;

        // Restore mute on any auto-muted tabs
        const toUnmute = Array.from(autoMutedTabs);
        autoMutedTabs.clear();
        await persistAutoMutedTabs();
        for (let i = 0; i < toUnmute.length; i++) {
          try {
            await chromeApi.tabs.update(toUnmute[i], { muted: false });
          } catch (_err) {
            // Ignore closed tabs
          }
        }
        await updateBadge();
        return;
      }

      // Source tab closed
      const closedStreamIds = [];
      for (const s of streams.values()) {
        if (s.sourceTabId === tabId) {
          closedStreamIds.push(s.streamId);
        }
      }
      if (closedStreamIds.length > 0) {
        for (let i = 0; i < closedStreamIds.length; i++) {
          const sid = closedStreamIds[i];
          const s = streams.get(sid);
          if (s) {
            videoKeyToStreamId.delete(`${s.sourceTabId}:${s.sourceFrameId}:${s.videoUid}`);
            streams.delete(sid);
          }
          if (wallTabId !== null && wallReady) {
            await safeSendToTab(wallTabId, { type: 'WALL_SOURCE_CLOSED', streamId: sid });
          }
        }
        autoMutedTabs.delete(tabId);
        await persistAutoMutedTabs();
        await updateBadge();
      }
    }

    function bindListeners() {
      loadAutoMutedTabs();

      if (chromeApi.runtime && chromeApi.runtime.onMessage) {
        chromeApi.runtime.onMessage.addListener((msg, sender, sendResponse) => {
          handleMessage(msg, sender)
            .then((res) => sendResponse(res))
            .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
          return true;
        });
      }

      if (chromeApi.tabs && chromeApi.tabs.onRemoved) {
        chromeApi.tabs.onRemoved.addListener((tabId) => {
          handleTabRemoved(tabId);
        });
      }

      if (chromeApi.runtime && chromeApi.runtime.onInstalled && chromeApi.contextMenus) {
        chromeApi.runtime.onInstalled.addListener(() => {
          try {
            chromeApi.contextMenus.removeAll(() => {
              chromeApi.contextMenus.create({
                id: 'adaptive-wall-add',
                title: '添加到自适应视频墙',
                contexts: ['page', 'video', 'frame']
              });
              chromeApi.contextMenus.create({
                id: 'adaptive-wall-save',
                title: '保存该视频到本地',
                contexts: ['page', 'video', 'frame']
              });
              chromeApi.contextMenus.create({
                id: 'adaptive-wall-pick',
                title: '点选页面视频（高亮选框）',
                contexts: ['page', 'video', 'frame']
              });
              chromeApi.contextMenus.create({
                id: 'adaptive-wall-open',
                title: '打开自适应视频墙',
                contexts: ['page', 'video', 'frame', 'action']
              });
            });
          } catch (_err) {
            // Ignore
          }
        });
      }

      if (chromeApi.contextMenus && chromeApi.contextMenus.onClicked) {
        chromeApi.contextMenus.onClicked.addListener(async (info, tab) => {
          if (!tab) return;
          const frameId = typeof info.frameId === 'number' ? info.frameId : 0;

          if (info.menuItemId === 'adaptive-wall-add') {
            const ok = await ensureContentScript(tab.id);
            if (!ok) return;
            const res = await safeSendToTab(tab.id, { type: 'SYNC_CONTEXT_VIDEO' }, { frameId });
            if (!res || !res.found) {
              await enterPickerMode(tab.id);
            }
          } else if (info.menuItemId === 'adaptive-wall-save') {
            const ok = await ensureContentScript(tab.id);
            if (!ok) return;
            const res = await safeSendToTab(tab.id, { type: 'SAVE_CONTEXT_VIDEO' }, { frameId });
            if (!res || !res.found) {
              // Fallback: if single/playing video exists in main frame, try frame 0
              if (frameId !== 0) {
                await safeSendToTab(tab.id, { type: 'SAVE_CONTEXT_VIDEO' }, { frameId: 0 });
              }
            }
          } else if (info.menuItemId === 'adaptive-wall-pick') {
            enterPickerMode(tab.id);
          } else if (info.menuItemId === 'adaptive-wall-open') {
            getOrCreateWallTab('always', DEFAULT_SETTINGS);
          }
        });
      }

      if (chromeApi.commands && chromeApi.commands.onCommand) {
        chromeApi.commands.onCommand.addListener((command) => {
          if (command === 'pick-video') {
            enterPickerMode(null);
          }
        });
      }
    }

    return {
      bindListeners,
      handleMessage,
      handleTabRemoved,
      scanTabVideos,
      getOrCreateWallTab,
      _getState: () => ({
        wallTabId,
        wallReady,
        pendingAddsCount: pendingAdds.length,
        streamCount: streams.size,
        autoMutedTabs: Array.from(autoMutedTabs)
      })
    };
  }

  // Auto-start inside Chrome MV3 Service Worker context
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
    const controller = createBackgroundController(chrome);
    controller.bindListeners();
    root.__adaptiveWallBackground = controller;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      DEFAULT_SETTINGS,
      isInjectableUrl,
      createBackgroundController
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
