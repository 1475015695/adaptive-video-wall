/**
 * Wall Page Extension Bridge
 *
 * Connects index.html / app.js to the Chrome Extension runtime when opened as
 * chrome-extension://<id>/index.html, and degrades cleanly to a harmless stub
 * when opened standalone via file:// or localhost.
 */
(function (root) {
  'use strict';

  const isExtension =
    typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);

  if (!isExtension) {
    root.WallBridge = {
      isExtension: false,
      onSyncedVideo: () => { },
      onTrackAdded: () => { },
      onSourceState: () => { },
      onSourceClosed: () => { },
      onHighlight: () => { },
      sendControl: () => { },
      openPopout: () => { },
      notifyCount: () => { },
      startPicker: () => { },
      downloadUrl: () => Promise.resolve({ ok: false })
    };
    return;
  }

  const callbacks = {
    syncedVideo: null,
    trackAdded: null,
    sourceState: null,
    sourceClosed: null,
    highlight: null
  };

  const peers = new Map(); // streamId -> { pc, mediaStream, pendingIce, remoteSet }

  async function handleAddSyncedVideo(msg) {
    const streamId = msg.streamId;
    const meta = msg.meta || {};

    if (msg.transport === 'direct-url') {
      if (callbacks.syncedVideo) {
        callbacks.syncedVideo({
          streamId,
          transport: 'direct-url',
          src: msg.src,
          meta
        });
      }
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: [] });
    const mediaStream = new MediaStream();
    const session = {
      pc,
      mediaStream,
      pendingIce: [],
      remoteSet: false
    };
    peers.set(streamId, session);

    pc.ontrack = (e) => {
      if (e.streams && e.streams[0]) {
        e.streams[0].getTracks().forEach((t) => {
          if (!mediaStream.getTracks().some((m) => m.id === t.id)) {
            mediaStream.addTrack(t);
          }
        });
      } else if (e.track) {
        mediaStream.addTrack(e.track);
      }
      if (callbacks.trackAdded) {
        callbacks.trackAdded(streamId);
      }
    };

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

    if (callbacks.syncedVideo) {
      callbacks.syncedVideo({
        streamId,
        transport: 'webrtc',
        mediaStream,
        meta
      });
    }

    await chrome.runtime.sendMessage({ type: 'WALL_PEER_READY', streamId }).catch(() => { });
  }

  async function handleRtcSignal(msg) {
    const session = peers.get(msg.streamId);
    if (!session || !msg.signal) return;
    const { pc, pendingIce } = session;
    const sig = msg.signal;

    if (sig.type === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp });
      session.remoteSet = true;
      while (pendingIce.length > 0) {
        const cand = pendingIce.shift();
        await pc.addIceCandidate(cand).catch(() => { });
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await chrome.runtime
        .sendMessage({
          type: 'RTC_SIGNAL',
          streamId: msg.streamId,
          signal: { type: 'answer', sdp: pc.localDescription.sdp }
        })
        .catch(() => { });
    } else if (sig.type === 'ice' && sig.candidate) {
      if (session.remoteSet) {
        await pc.addIceCandidate(sig.candidate).catch(() => { });
      } else {
        pendingIce.push(sig.candidate);
      }
    }
  }

  function closePeer(streamId) {
    const session = peers.get(streamId);
    if (!session) return;
    try {
      session.pc.close();
    } catch (_err) {
      // Ignore
    }
    session.mediaStream.getTracks().forEach((t) => t.stop());
    peers.delete(streamId);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'WALL_PING') {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'WALL_ADD_SYNCED_VIDEO') {
      handleAddSyncedVideo(msg);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'RTC_SIGNAL') {
      handleRtcSignal(msg);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'WALL_SOURCE_STATE') {
      if (callbacks.sourceState) callbacks.sourceState(msg.streamId, msg.state);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'WALL_SOURCE_CLOSED') {
      closePeer(msg.streamId);
      if (callbacks.sourceClosed) callbacks.sourceClosed(msg.streamId);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'WALL_HIGHLIGHT_VIDEO') {
      if (callbacks.highlight) callbacks.highlight(msg.streamId);
      sendResponse({ ok: true });
    }
  });

  window.addEventListener('beforeunload', () => {
    for (const streamId of peers.keys()) {
      closePeer(streamId);
    }
  });

  root.WallBridge = {
    isExtension: true,
    ready: () => chrome.runtime.sendMessage({ type: 'WALL_READY' }).catch(() => { }),
    onSyncedVideo: (fn) => {
      callbacks.syncedVideo = fn;
    },
    onTrackAdded: (fn) => {
      callbacks.trackAdded = fn;
    },
    onSourceState: (fn) => {
      callbacks.sourceState = fn;
    },
    onSourceClosed: (fn) => {
      callbacks.sourceClosed = fn;
    },
    onHighlight: (fn) => {
      callbacks.highlight = fn;
    },
    sendControl: (streamId, action, value) => {
      if (action === 'stop') closePeer(streamId);
      return chrome.runtime
        .sendMessage({ type: 'REMOTE_VIDEO_CONTROL', streamId, action, value })
        .catch(() => { });
    },
    openPopout: () => chrome.runtime.sendMessage({ type: 'OPEN_WALL_POPOUT' }).catch(() => { }),
    notifyCount: (count) =>
      chrome.runtime.sendMessage({ type: 'WALL_COUNT_CHANGED', count }).catch(() => { }),
    startPicker: () => chrome.runtime.sendMessage({ type: 'ENTER_PICKER_MODE' }).catch(() => { }),
    downloadUrl: (url, filename, saveAs = true) =>
      chrome.runtime
        .sendMessage({ type: 'DOWNLOAD_VIDEO_URL', url, filename, saveAs })
        .catch(() => ({ ok: false }))
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
