/**
 * Adaptive Multi-Video Player Application Controller
 *
 * Reconciles active video tiles without destroying DOM/video elements on relayout,
 * handles local files, remote URLs, live demo streams, drag-and-drop reordering,
 * solo mode, and keyboard shortcuts.
 */
(function () {
  'use strict';

  const LayoutEngine = globalThis.LayoutEngine;
  const DemoStream = globalThis.DemoStream;
  const WallBridge = globalThis.WallBridge || { isExtension: false };

  const ICONS = {
    play: '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
    muted: '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
    volume: '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
    focus: '<svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    expand: '<svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
    shrink: '<svg viewBox="0 0 24 24"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>',
    close: '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    loop: '<svg viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    headphone: '<svg viewBox="0 0 24 24"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
    jump: '<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
  };

  const els = {
    stage: document.getElementById('stage'),
    emptyState: document.getElementById('empty-state'),
    emptyExtHint: document.getElementById('empty-ext-hint'),
    emptyPickFiles: document.getElementById('empty-pick-files'),
    emptyOpenUrl: document.getElementById('empty-open-url'),
    demoPreset6: document.getElementById('demo-preset-6'),
    demoPresetMix: document.getElementById('demo-preset-mix'),
    demoPreset9: document.getElementById('demo-preset-9'),
    hud: document.getElementById('hud'),
    hudCoverageFill: document.getElementById('hud-coverage-fill'),
    hudCoverageText: document.getElementById('hud-coverage-text'),
    hudCountBadge: document.getElementById('hud-count-badge'),
    btnAddFiles: document.getElementById('btn-add-files'),
    btnAddUrl: document.getElementById('btn-add-url'),
    demoRatioSelect: document.getElementById('demo-ratio-select'),
    btnAddDemo: document.getElementById('btn-add-demo'),
    btnPlayAll: document.getElementById('btn-play-all'),
    btnMuteAll: document.getElementById('btn-mute-all'),
    btnFullscreen: document.getElementById('btn-fullscreen'),
    btnPopoutWindow: document.getElementById('btn-popout-window'),
    btnSettings: document.getElementById('btn-settings'),
    btnPinHud: document.getElementById('btn-pin-hud'),
    btnClearAll: document.getElementById('btn-clear-all'),
    btnHelp: document.getElementById('btn-help'),
    settingsPopover: document.getElementById('settings-popover'),
    rangeGap: document.getElementById('range-gap'),
    valGap: document.getElementById('val-gap'),
    rangeBalance: document.getElementById('range-balance'),
    valBalance: document.getElementById('val-balance'),
    toggleReorder: document.getElementById('toggle-reorder'),
    toggleDebug: document.getElementById('toggle-debug'),
    statStrategy: document.getElementById('stat-strategy'),
    statMinRatio: document.getElementById('stat-min-ratio'),
    statComputeMs: document.getElementById('stat-compute-ms'),
    fileInput: document.getElementById('file-input'),
    dropOverlay: document.getElementById('drop-overlay'),
    urlModal: document.getElementById('url-modal'),
    urlTextarea: document.getElementById('url-textarea'),
    btnUrlClose: document.getElementById('btn-url-close'),
    btnUrlCancel: document.getElementById('btn-url-cancel'),
    btnUrlConfirm: document.getElementById('btn-url-confirm'),
    helpModal: document.getElementById('help-modal'),
    btnHelpClose: document.getElementById('btn-help-close'),
    modeButtons: Array.from(document.querySelectorAll('.mode-btn'))
  };

  const state = {
    videos: [],
    mode: 'max-fill',
    gap: 4,
    padding: 8,
    balance: 0.25,
    autoReorder: true,
    focusId: null,
    soloId: null,
    showDebug: false,
    dockPinned: false,
    allMuted: true,
    nextSeq: 1
  };

  const tileMap = new Map();
  let hudHideTimer = null;
  let resizeTimer = null;
  let dragSourceId = null;
  let lastLayoutStats = null;
  let layoutRafPending = false;

  const SPEED_STEPS = [1, 1.5, 2, 0.5];

  function formatRatioLabel(r) {
    const known = [
      [16 / 9, '16:9'],
      [9 / 16, '9:16'],
      [4 / 3, '4:3'],
      [3 / 4, '3:4'],
      [1, '1:1'],
      [21 / 9, '21:9'],
      [2 / 3, '2:3'],
      [3 / 2, '3:2']
    ];
    for (let i = 0; i < known.length; i++) {
      if (Math.abs(r - known[i][0]) < 0.03) return known[i][1];
    }
    return r.toFixed(2) + ':1';
  }

  function formatDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const total = Math.floor(sec);
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (hrs > 0) {
      return hrs + ':' + String(mins).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
    return String(mins).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function showHudTemporarily() {
    els.hud.classList.add('is-visible');
    if (hudHideTimer) clearTimeout(hudHideTimer);
    if (state.dockPinned || state.videos.length === 0 || !els.settingsPopover.hidden) return;
    hudHideTimer = setTimeout(() => {
      if (
        !state.dockPinned &&
        state.videos.length > 0 &&
        els.settingsPopover.hidden &&
        !els.hud.matches(':hover')
      ) {
        els.hud.classList.remove('is-visible');
      }
    }, 2200);
  }

  function handleWindowPointerMove(e) {
    if (state.dockPinned || state.videos.length === 0) {
      showHudTemporarily();
      return;
    }
    const nearBottomEdge = window.innerHeight - e.clientY <= 24;
    if (nearBottomEdge || els.hud.contains(e.target)) {
      showHudTemporarily();
    }
  }

  function scheduleLayout() {
    if (layoutRafPending) return;
    layoutRafPending = true;
    requestAnimationFrame(() => {
      layoutRafPending = false;
      applyLayout();
    });
  }

  function createTileDom(video) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.id = video.id;

    const mediaWrap = document.createElement('div');
    mediaWrap.className = 'tile-media-wrap';
    mediaWrap.appendChild(video.mediaEl);
    tile.appendChild(mediaWrap);

    const errorBox = document.createElement('div');
    errorBox.className = 'tile-error';
    errorBox.hidden = true;
    tile.appendChild(errorBox);

    const debugBox = document.createElement('div');
    debugBox.className = 'tile-debug';
    debugBox.hidden = !state.showDebug;
    tile.appendChild(debugBox);

    const overlay = document.createElement('div');
    overlay.className = 'tile-overlay';

    let overlayHideTimer = null;
    let isOverlayScrubbing = false;

    const hideTileOverlay = () => {
      if (overlayHideTimer) {
        clearTimeout(overlayHideTimer);
        overlayHideTimer = null;
      }
      if (!isOverlayScrubbing) {
        tile.classList.remove('is-overlay-visible');
      }
    };

    const showTileOverlay = () => {
      tile.classList.add('is-overlay-visible');
      if (overlayHideTimer) clearTimeout(overlayHideTimer);
      overlayHideTimer = setTimeout(() => {
        if (!isOverlayScrubbing) {
          tile.classList.remove('is-overlay-visible');
        }
      }, 2000);
    };

    tile.addEventListener('mousemove', showTileOverlay, { passive: true });
    tile.addEventListener('touchstart', showTileOverlay, { passive: true });
    tile.addEventListener('mouseleave', hideTileOverlay);
    tile.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button, input') : null;
      if (btn && typeof btn.blur === 'function') {
        setTimeout(() => btn.blur(), 0);
      }
    });

    // Top bar
    const topBar = document.createElement('div');
    topBar.className = 'tile-top';
    topBar.draggable = true;

    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    const titleEl = document.createElement('span');
    titleEl.className = 'tile-title';
    titleEl.textContent = video.name;
    titleEl.title = video.name;
    const ratioPill = document.createElement('span');
    ratioPill.className = 'tile-ratio-pill';
    ratioPill.textContent = formatRatioLabel(video.aspectRatio);
    meta.appendChild(titleEl);
    meta.appendChild(ratioPill);

    let syncBadge = null;
    if (video.sync) {
      syncBadge = document.createElement('span');
      syncBadge.className = 'tile-sync-badge';
      syncBadge.textContent = video.sync.transport === 'webrtc' ? 'SYNC' : 'URL';
      meta.appendChild(syncBadge);
    }

    const topActions = document.createElement('div');
    topActions.className = 'tile-actions';

    let btnJump = null;
    if (video.sync) {
      btnJump = document.createElement('button');
      btnJump.type = 'button';
      btnJump.className = 'tile-btn tile-btn-jump';
      btnJump.title = '跳转回原网页标签页';
      btnJump.innerHTML = ICONS.jump;
      topActions.appendChild(btnJump);
    }

    const btnSave = document.createElement('button');
    btnSave.type = 'button';
    btnSave.className = 'tile-btn tile-btn-save';
    btnSave.title = '保存视频（直链下载或实时录制）';
    btnSave.innerHTML = ICONS.download;

    const btnFocus = document.createElement('button');
    btnFocus.type = 'button';
    btnFocus.className = 'tile-btn tile-btn-focus';
    btnFocus.title = '设为焦点主画面';
    btnFocus.innerHTML = ICONS.focus;

    const btnSolo = document.createElement('button');
    btnSolo.type = 'button';
    btnSolo.className = 'tile-btn tile-btn-solo';
    btnSolo.title = '独享全屏 (双击画面)';
    btnSolo.innerHTML = ICONS.expand;

    const btnRemove = document.createElement('button');
    btnRemove.type = 'button';
    btnRemove.className = 'tile-btn tile-btn-danger tile-btn-remove';
    btnRemove.title = '移除此视频';
    btnRemove.innerHTML = ICONS.close;

    topActions.appendChild(btnSave);
    topActions.appendChild(btnFocus);
    topActions.appendChild(btnSolo);
    topActions.appendChild(btnRemove);
    topBar.appendChild(meta);
    topBar.appendChild(topActions);

    // Bottom bar
    const bottomBar = document.createElement('div');
    bottomBar.className = 'tile-bottom';

    const leftControls = document.createElement('div');
    leftControls.className = 'tile-controls-left';

    const btnPlay = document.createElement('button');
    btnPlay.type = 'button';
    btnPlay.className = 'tile-btn tile-btn-play';
    btnPlay.title = '播放 / 暂停';
    btnPlay.innerHTML = ICONS.pause;

    const btnMute = document.createElement('button');
    btnMute.type = 'button';
    btnMute.className = 'tile-btn tile-btn-mute';
    btnMute.title = '静音切换 (Alt+点击 = 独听)';
    btnMute.innerHTML = ICONS.muted;

    const btnSoloAudio = document.createElement('button');
    btnSoloAudio.type = 'button';
    btnSoloAudio.className = 'tile-btn tile-btn-solo-audio';
    btnSoloAudio.title = '仅听此路声音 (静音其他画面)';
    btnSoloAudio.innerHTML = ICONS.headphone;

    leftControls.appendChild(btnPlay);
    leftControls.appendChild(btnMute);
    if (!video.demo) leftControls.appendChild(btnSoloAudio);

    const seekWrap = document.createElement('div');
    seekWrap.className = 'tile-seek-wrap';
    const seekInput = document.createElement('input');
    seekInput.type = 'range';
    seekInput.className = 'tile-seek';
    seekInput.min = '0';
    seekInput.max = '1000';
    seekInput.value = '0';
    const timeEl = document.createElement('span');
    timeEl.className = 'tile-time';
    timeEl.textContent = '00:00';
    if (video.demo) {
      seekWrap.style.visibility = 'hidden';
    } else {
      seekWrap.appendChild(seekInput);
      seekWrap.appendChild(timeEl);
    }

    const rightControls = document.createElement('div');
    rightControls.className = 'tile-controls-right';

    const btnRate = document.createElement('button');
    btnRate.type = 'button';
    btnRate.className = 'tile-btn tile-btn-rate';
    btnRate.title = '切换倍速';
    btnRate.textContent = '1x';

    const btnLoop = document.createElement('button');
    btnLoop.type = 'button';
    btnLoop.className = 'tile-btn tile-btn-loop is-active';
    btnLoop.title = '循环播放';
    btnLoop.innerHTML = ICONS.loop;

    rightControls.appendChild(btnRate);
    if (!video.demo && !video.sync) rightControls.appendChild(btnLoop);

    bottomBar.appendChild(leftControls);
    bottomBar.appendChild(seekWrap);
    bottomBar.appendChild(rightControls);

    overlay.appendChild(topBar);
    overlay.appendChild(bottomBar);
    tile.appendChild(overlay);

    const refs = {
      tile,
      errorBox,
      debugBox,
      ratioPill,
      syncBadge,
      btnJump,
      btnSave,
      btnFocus,
      btnSolo,
      btnPlay,
      btnMute,
      btnSoloAudio,
      seekInput,
      timeEl,
      btnRate,
      btnLoop
    };

    if (btnJump && video.sync) {
      btnJump.addEventListener('click', (e) => {
        e.stopPropagation();
        WallBridge.sendControl(video.sync.streamId, 'jumpToTab');
      });
    }

    // Wire per-tile interactions
    btnSave.addEventListener('click', (e) => {
      e.stopPropagation();
      saveTileVideo(video, btnSave);
    });

    btnFocus.addEventListener('click', (e) => {
      e.stopPropagation();
      state.focusId = video.id;
      setMode('focus');
    });

    btnSolo.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSolo(video.id);
    });

    tile.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input')) return;
      toggleSolo(video.id);
    });

    btnRemove.addEventListener('click', (e) => {
      e.stopPropagation();
      removeVideo(video.id);
    });

    btnPlay.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleVideoPlay(video);
    });

    btnMute.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.altKey) {
        soloAudio(video.id);
      } else {
        toggleVideoMute(video);
      }
    });

    btnSoloAudio.addEventListener('click', (e) => {
      e.stopPropagation();
      soloAudio(video.id);
    });

    btnRate.addEventListener('click', (e) => {
      e.stopPropagation();
      video.rateIndex = (video.rateIndex + 1) % SPEED_STEPS.length;
      const rate = SPEED_STEPS[video.rateIndex];
      if (video.sync) {
        video.sync.playbackRate = rate;
        WallBridge.sendControl(video.sync.streamId, 'setRate', rate);
      } else if (video.demo) {
        video.demo.setRate(rate);
      } else if (video.videoEl) {
        video.videoEl.playbackRate = rate;
      }
      btnRate.textContent = rate + 'x';
    });

    btnLoop.addEventListener('click', (e) => {
      e.stopPropagation();
      if (video.videoEl) {
        video.videoEl.loop = !video.videoEl.loop;
        btnLoop.classList.toggle('is-active', video.videoEl.loop);
      }
    });

    if (video.sync) {
      seekInput.addEventListener('input', () => {
        isOverlayScrubbing = true;
        showTileOverlay();
        const dur = video.sync.duration;
        if (Number.isFinite(dur) && dur > 0) {
          const targetTime = (Number(seekInput.value) / 1000) * dur;
          timeEl.textContent = formatDuration(targetTime) + ' / ' + formatDuration(dur);
        }
      });
      seekInput.addEventListener('change', () => {
        isOverlayScrubbing = false;
        showTileOverlay();
        const dur = video.sync.duration;
        if (Number.isFinite(dur) && dur > 0) {
          const targetTime = (Number(seekInput.value) / 1000) * dur;
          WallBridge.sendControl(video.sync.streamId, 'seek', targetTime);
        }
      });
      video._updateSyncSeekUi = () => {
        if (isOverlayScrubbing || !video.sync) return;
        const cur = video.sync.currentTime || 0;
        const dur = video.sync.duration || 0;
        if (Number.isFinite(dur) && dur > 0) {
          seekInput.disabled = false;
          seekInput.value = String(Math.round((cur / dur) * 1000));
          timeEl.textContent = formatDuration(cur) + ' / ' + formatDuration(dur);
        } else {
          seekInput.disabled = true;
          timeEl.textContent = 'LIVE ' + formatDuration(cur);
        }
      };
    } else if (!video.demo && video.videoEl) {
      seekInput.addEventListener('input', () => {
        isOverlayScrubbing = true;
        showTileOverlay();
        const dur = video.videoEl.duration;
        if (Number.isFinite(dur) && dur > 0) {
          video.videoEl.currentTime = (Number(seekInput.value) / 1000) * dur;
        }
      });
      seekInput.addEventListener('change', () => {
        isOverlayScrubbing = false;
        showTileOverlay();
      });
      video.videoEl.addEventListener('timeupdate', () => {
        if (isOverlayScrubbing) return;
        const cur = video.videoEl.currentTime || 0;
        const dur = video.videoEl.duration;
        if (Number.isFinite(dur) && dur > 0) {
          seekInput.value = String(Math.round((cur / dur) * 1000));
          timeEl.textContent = formatDuration(cur) + ' / ' + formatDuration(dur);
        } else {
          timeEl.textContent = formatDuration(cur);
        }
      });
      video.videoEl.addEventListener('play', () => syncTileButtonState(video));
      video.videoEl.addEventListener('pause', () => syncTileButtonState(video));
      video.videoEl.addEventListener('volumechange', () => syncTileButtonState(video));
    }

    // Tile drag-and-drop position swapping
    topBar.addEventListener('dragstart', (e) => {
      dragSourceId = video.id;
      tile.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', video.id);
      }
    });

    topBar.addEventListener('dragend', () => {
      dragSourceId = null;
      tile.classList.remove('is-dragging');
      tileMap.forEach((entry) => entry.refs.tile.classList.remove('is-drop-target'));
    });

    tile.addEventListener('dragover', (e) => {
      if (!dragSourceId || dragSourceId === video.id) return;
      e.preventDefault();
      tile.classList.add('is-drop-target');
    });

    tile.addEventListener('dragleave', () => {
      tile.classList.remove('is-drop-target');
    });

    tile.addEventListener('drop', (e) => {
      if (!dragSourceId || dragSourceId === video.id) return;
      e.preventDefault();
      e.stopPropagation();
      tile.classList.remove('is-drop-target');
      swapVideos(dragSourceId, video.id);
      dragSourceId = null;
    });

    return refs;
  }

  function syncTileButtonState(video) {
    const entry = tileMap.get(video.id);
    if (!entry) return;
    const { refs } = entry;

    const paused = video.sync
      ? Boolean(video.sync.paused)
      : video.demo
        ? video.demo.isPaused()
        : video.videoEl
          ? video.videoEl.paused
          : false;
    refs.tile.classList.toggle('is-paused', paused);
    refs.btnPlay.innerHTML = paused ? ICONS.play : ICONS.pause;

    const muted = video.videoEl ? video.videoEl.muted : true;
    refs.btnMute.innerHTML = muted ? ICONS.muted : ICONS.volume;
    refs.btnMute.classList.toggle('is-active', !muted);

    if (video.sync && refs.syncBadge) {
      if (video.sync.sourceClosed) {
        refs.syncBadge.textContent = '已关闭';
        refs.syncBadge.classList.add('is-closed');
      } else {
        refs.syncBadge.textContent = video.sync.transport === 'webrtc' ? 'SYNC' : 'URL';
        refs.syncBadge.classList.remove('is-closed');
      }
      if (video.sync.playbackRate) {
        refs.btnRate.textContent = video.sync.playbackRate + 'x';
      }
      if (video._updateSyncSeekUi) video._updateSyncSeekUi();
    }

    refs.btnFocus.classList.toggle('is-active', state.mode === 'focus' && state.focusId === video.id);
    refs.tile.classList.toggle('is-focused', state.mode === 'focus' && state.focusId === video.id);

    const isSolo = state.soloId === video.id;
    refs.tile.classList.toggle('is-solo', isSolo);
    refs.btnSolo.innerHTML = isSolo ? ICONS.shrink : ICONS.expand;
    refs.btnSolo.classList.toggle('is-active', isSolo);
    refs.ratioPill.textContent = formatRatioLabel(video.aspectRatio);
  }

  function applyLayout() {
    const hasVideos = state.videos.length > 0;
    els.emptyState.hidden = hasVideos;
    if (!hasVideos) {
      els.hud.classList.add('is-visible');
    }

    const stageRect = els.stage.getBoundingClientRect();
    const container = {
      width: stageRect.width || window.innerWidth,
      height: stageRect.height || window.innerHeight
    };

    // Reconcile DOM tiles
    const activeIds = new Set(state.videos.map((v) => v.id));
    for (const [id, entry] of tileMap.entries()) {
      if (!activeIds.has(id)) {
        entry.refs.tile.remove();
        tileMap.delete(id);
      }
    }

    for (let i = 0; i < state.videos.length; i++) {
      const video = state.videos[i];
      if (!tileMap.has(video.id)) {
        const refs = createTileDom(video);
        els.stage.appendChild(refs.tile);
        tileMap.set(video.id, { video, refs });
      }
      syncTileButtonState(video);
    }

    if (!hasVideos) {
      updateTelemetry({
        coverage: 0,
        usableCoverage: 0,
        minLinearRatio: 1,
        strategy: 'empty',
        computeMs: 0
      });
      return;
    }

    // Solo view expands 1 video cleanly while keeping all others alive underneath
    if (state.soloId && activeIds.has(state.soloId)) {
      const soloVideo = state.videos.find((v) => v.id === state.soloId);
      const result = LayoutEngine.computeLayout(
        [{ id: soloVideo.id, aspectRatio: soloVideo.aspectRatio }],
        container,
        { mode: 'max-fill', gap: 0, padding: 0 }
      );
      const rc = result.rects[0];
      for (const [id, entry] of tileMap.entries()) {
        const t = entry.refs.tile;
        if (id === state.soloId && rc) {
          t.style.visibility = 'visible';
          t.style.transform = `translate3d(${rc.x.toFixed(2)}px, ${rc.y.toFixed(2)}px, 0)`;
          t.style.width = `${rc.width.toFixed(2)}px`;
          t.style.height = `${rc.height.toFixed(2)}px`;
          entry.refs.debugBox.hidden = !state.showDebug;
          entry.refs.debugBox.textContent = `${formatRatioLabel(rc.aspectRatio)} · ${Math.round(rc.width)}×${Math.round(rc.height)} · 100.0%`;
        } else {
          t.style.visibility = 'hidden';
        }
      }
      updateTelemetry(result.stats);
      return;
    }

    const layoutInput = state.videos.map((v) => ({ id: v.id, aspectRatio: v.aspectRatio }));
    const result = LayoutEngine.computeLayout(layoutInput, container, {
      mode: state.mode,
      gap: state.gap,
      padding: state.padding,
      balance: state.balance,
      autoReorder: state.autoReorder,
      focusId: state.focusId
    });

    const rectById = new Map();
    for (let i = 0; i < result.rects.length; i++) {
      rectById.set(result.rects[i].id, result.rects[i]);
    }

    for (const [id, entry] of tileMap.entries()) {
      const rc = rectById.get(id);
      const t = entry.refs.tile;
      t.style.visibility = 'visible';
      if (rc) {
        t.style.transform = `translate3d(${rc.x.toFixed(2)}px, ${rc.y.toFixed(2)}px, 0)`;
        t.style.width = `${rc.width.toFixed(2)}px`;
        t.style.height = `${rc.height.toFixed(2)}px`;
        entry.refs.debugBox.hidden = !state.showDebug;
        entry.refs.debugBox.textContent =
          `${formatRatioLabel(rc.aspectRatio)} · ${Math.round(rc.width)}×${Math.round(rc.height)} · ${(rc.areaShare * 100).toFixed(1)}%`;
      }
    }

    updateTelemetry(result.stats);
  }

  function updateTelemetry(stats) {
    lastLayoutStats = stats;
    const pct = (stats.usableCoverage * 100).toFixed(1);
    els.hudCoverageFill.style.width = Math.min(100, stats.usableCoverage * 100).toFixed(1) + '%';
    els.hudCoverageText.textContent = `利用率 ${pct}%`;
    els.hudCountBadge.textContent = `${state.videos.length} 路`;
    els.statStrategy.textContent = stats.strategy || '-';
    els.statMinRatio.textContent = (stats.minLinearRatio || 1).toFixed(2);
    els.statComputeMs.textContent = (stats.computeMs || 0).toFixed(1) + ' ms';
    if (WallBridge.isExtension) WallBridge.notifyCount(state.videos.length);
    syncGlobalButtons();
  }

  function syncGlobalButtons() {
    const anyPlaying = state.videos.some((v) =>
      v.sync
        ? !v.sync.paused
        : v.demo
          ? !v.demo.isPaused()
          : v.videoEl
            ? !v.videoEl.paused
            : false
    );
    els.btnPlayAll.innerHTML = anyPlaying ? ICONS.pause : ICONS.play;
    els.btnPlayAll.classList.toggle('is-active', anyPlaying);

    const anyUnmuted = state.videos.some((v) => v.videoEl && !v.videoEl.muted);
    state.allMuted = !anyUnmuted;
    els.btnMuteAll.innerHTML = anyUnmuted ? ICONS.volume : ICONS.muted;
    els.btnMuteAll.classList.toggle('is-active', anyUnmuted);

    els.modeButtons.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.mode === state.mode);
    });
    els.btnPinHud.classList.toggle('is-active', state.dockPinned);
    els.hud.classList.toggle('is-pinned', state.dockPinned);
    els.stage.classList.toggle('has-pinned-hud', state.dockPinned && state.videos.length > 0);
  }

  function addMediaVideo(srcUrl, name, objectUrlToRevoke) {
    const id = 'vid-' + state.nextSeq++;
    const videoEl = document.createElement('video');
    videoEl.className = 'tile-media';
    videoEl.src = srcUrl;
    videoEl.muted = state.allMuted;
    videoEl.playsInline = true;
    videoEl.autoplay = true;
    videoEl.loop = true;

    const record = {
      id,
      name: name || '视频 ' + id,
      aspectRatio: 16 / 9,
      mediaEl: videoEl,
      videoEl,
      demo: null,
      objectUrl: objectUrlToRevoke || null,
      rateIndex: 0
    };

    const updateDims = () => {
      if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        const nextR = videoEl.videoWidth / videoEl.videoHeight;
        if (Math.abs(nextR - record.aspectRatio) > 1e-4) {
          record.aspectRatio = nextR;
          scheduleLayout();
        }
      }
    };

    videoEl.addEventListener('loadedmetadata', () => {
      const entry = tileMap.get(id);
      if (entry) entry.refs.errorBox.hidden = true;
      updateDims();
    });
    videoEl.addEventListener('resize', updateDims);
    videoEl.addEventListener('error', () => {
      const entry = tileMap.get(id);
      if (entry) {
        const box = entry.refs.errorBox;
        box.hidden = false;
        box.textContent = '';
        const strong = document.createElement('strong');
        strong.textContent = '无法加载视频';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = record.name;
        const hintSpan = document.createElement('span');
        hintSpan.style.opacity = '0.7';
        hintSpan.textContent = '请检查链接跨域限制或编码格式';
        box.appendChild(strong);
        box.appendChild(nameSpan);
        box.appendChild(hintSpan);
      }
    });

    const playPromise = videoEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => { });
    }

    state.videos.push(record);
    if (!state.focusId) state.focusId = id;
    scheduleLayout();
    showHudTemporarily();
  }

  function addDemoVideo(aspectPreset) {
    const presetKeys = Object.keys(DemoStream.PRESETS);
    const chosenPreset =
      aspectPreset && aspectPreset !== 'random'
        ? aspectPreset
        : presetKeys[Math.floor(Math.random() * presetKeys.length)];

    const seq = state.nextSeq++;
    const id = 'demo-' + seq;
    const demo = DemoStream.createDemoVideoSource({
      aspectPreset: chosenPreset,
      label: `演示 #${seq}`,
      index: seq - 1
    });

    demo.element.className = 'tile-media';

    const record = {
      id,
      name: `演示 #${seq} (${demo.presetLabel})`,
      aspectRatio: demo.aspectRatio,
      mediaEl: demo.element,
      videoEl: demo.videoElement,
      demo,
      objectUrl: null,
      rateIndex: 0
    };

    state.videos.push(record);
    if (!state.focusId) state.focusId = id;
    scheduleLayout();
    showHudTemporarily();
  }

  function addSyncedVideo(payload) {
    const { streamId, transport, mediaStream, src, meta } = payload;
    const existing = state.videos.find((v) => v.id === streamId);
    if (existing) return;

    const videoEl = document.createElement('video');
    videoEl.className = 'tile-media';
    videoEl.muted = state.allMuted;
    videoEl.playsInline = true;
    videoEl.autoplay = true;

    if (transport === 'webrtc' && mediaStream) {
      videoEl.srcObject = mediaStream;
    } else if (src) {
      videoEl.src = src;
      videoEl.loop = true;
    }

    const initRatio =
      meta && Number.isFinite(meta.aspectRatio) && meta.aspectRatio > 0 ? meta.aspectRatio : 16 / 9;

    const record = {
      id: streamId,
      name: (meta && meta.title) || '网页同步视频',
      aspectRatio: initRatio,
      mediaEl: videoEl,
      videoEl,
      demo: null,
      objectUrl: null,
      rateIndex: 0,
      sync: {
        streamId,
        transport,
        sourceClosed: false,
        paused: Boolean(meta && meta.paused),
        currentTime: (meta && meta.currentTime) || 0,
        duration: (meta && meta.duration) || 0,
        playbackRate: (meta && meta.playbackRate) || 1
      }
    };

    const updateDims = () => {
      if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        const nextR = videoEl.videoWidth / videoEl.videoHeight;
        if (Math.abs(nextR - record.aspectRatio) > 1e-4) {
          record.aspectRatio = nextR;
          scheduleLayout();
        }
      }
    };

    videoEl.addEventListener('loadedmetadata', updateDims);
    videoEl.addEventListener('resize', updateDims);
    videoEl.addEventListener('volumechange', () => syncTileButtonState(record));

    const playPromise = videoEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => { });
    }

    state.videos.push(record);
    if (!state.focusId) state.focusId = streamId;
    scheduleLayout();
    showHudTemporarily();
  }

  function triggerDownload(url, filename) {
    if (WallBridge.isExtension && typeof WallBridge.downloadUrl === 'function') {
      WallBridge.downloadUrl(url, filename, true).then((res) => {
        if (!res || !res.ok) {
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          a.click();
        }
      });
      return;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }

  function saveTileVideo(video, btnEl) {
    const cleanBase = String(video.name || 'video')
      .replace(/[\\/:*?"<>|\r\n]+/g, '_')
      .trim()
      .slice(0, 64) || 'video';

    // Stop active recording if already recording this tile
    if (video._recorderSession) {
      video._recorderSession.stop();
      return;
    }

    // Direct URL or local file download
    const src = video.videoEl && !video.sync?.transport?.includes('webrtc') ? video.videoEl.currentSrc : '';
    if (src && (/^(https?|blob):/i.test(src)) && !(video.sync && video.sync.transport === 'webrtc') && !video.demo) {
      const extMatch = src.split('?')[0].match(/\.(mp4|webm|mov|m4v|mkv|ogv)$/i);
      const ext = extMatch ? '.' + extMatch[1].toLowerCase() : '.mp4';
      triggerDownload(src, cleanBase + ext);
      return;
    }

    // Record live WebRTC / Demo MediaStream via MediaRecorder
    let stream = null;
    if (video.videoEl && video.videoEl.srcObject) {
      stream = video.videoEl.srcObject;
    } else if (video.demo && video.demo.canvas && typeof video.demo.canvas.captureStream === 'function') {
      stream = video.demo.canvas.captureStream(30);
    }

    if (!stream || typeof MediaRecorder === 'undefined') return;

    const mimeCandidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks = [];
    const startTs = Date.now();

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const timer = setInterval(() => {
      const secs = Math.floor((Date.now() - startTs) / 1000);
      const m = String(Math.floor(secs / 60)).padStart(2, '0');
      const s = String(secs % 60).padStart(2, '0');
      btnEl.textContent = `● ${m}:${s}`;
    }, 500);

    recorder.onstop = () => {
      clearInterval(timer);
      video._recorderSession = null;
      btnEl.classList.remove('is-recording');
      btnEl.innerHTML = ICONS.download;
      if (chunks.length === 0) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
      const blobUrl = URL.createObjectURL(blob);
      triggerDownload(blobUrl, cleanBase + '.webm');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    };

    video._recorderSession = {
      stop: () => {
        if (recorder.state !== 'inactive') recorder.stop();
      }
    };
    btnEl.classList.add('is-recording');
    btnEl.textContent = '● 00:00';
    recorder.start(500);
  }

  function removeVideo(id) {
    const idx = state.videos.findIndex((v) => v.id === id);
    if (idx < 0) return;
    const [removed] = state.videos.splice(idx, 1);

    if (removed._recorderSession) removed._recorderSession.stop();

    if (removed.sync) {
      WallBridge.sendControl(removed.sync.streamId, 'stop');
    }
    if (removed.demo) removed.demo.destroy();
    if (removed.videoEl && !removed.demo) {
      removed.videoEl.pause();
      removed.videoEl.srcObject = null;
      removed.videoEl.removeAttribute('src');
      removed.videoEl.load();
    }
    if (removed.objectUrl) {
      URL.revokeObjectURL(removed.objectUrl);
    }

    if (state.focusId === id) {
      state.focusId = state.videos.length > 0 ? state.videos[0].id : null;
    }
    if (state.soloId === id) {
      state.soloId = null;
    }

    scheduleLayout();
    showHudTemporarily();
  }

  function clearAllVideos() {
    while (state.videos.length > 0) {
      const v = state.videos.pop();
      if (v.sync) {
        WallBridge.sendControl(v.sync.streamId, 'stop');
      }
      if (v.demo) v.demo.destroy();
      if (v.videoEl && !v.demo) {
        v.videoEl.pause();
        v.videoEl.srcObject = null;
        v.videoEl.removeAttribute('src');
        v.videoEl.load();
      }
      if (v.objectUrl) URL.revokeObjectURL(v.objectUrl);
    }
    state.focusId = null;
    state.soloId = null;
    scheduleLayout();
    showHudTemporarily();
  }

  function toggleVideoPlay(video) {
    if (video.sync) {
      const nextPaused = !video.sync.paused;
      video.sync.paused = nextPaused;
      WallBridge.sendControl(video.sync.streamId, nextPaused ? 'pause' : 'play');
    } else if (video.demo) {
      if (video.demo.isPaused()) video.demo.play();
      else video.demo.pause();
    } else if (video.videoEl) {
      if (video.videoEl.paused) {
        const p = video.videoEl.play();
        if (p && typeof p.catch === 'function') p.catch(() => { });
      } else {
        video.videoEl.pause();
      }
    }
    syncTileButtonState(video);
    syncGlobalButtons();
  }

  function toggleVideoMute(video) {
    if (!video.videoEl) return;
    video.videoEl.muted = !video.videoEl.muted;
    syncTileButtonState(video);
    syncGlobalButtons();
  }

  function soloAudio(targetId) {
    state.videos.forEach((v) => {
      if (v.videoEl) {
        v.videoEl.muted = v.id !== targetId;
        syncTileButtonState(v);
      }
    });
    syncGlobalButtons();
  }

  function togglePlayAll() {
    if (state.videos.length === 0) return;
    const anyPlaying = state.videos.some((v) =>
      v.sync
        ? !v.sync.paused
        : v.demo
          ? !v.demo.isPaused()
          : v.videoEl
            ? !v.videoEl.paused
            : false
    );
    state.videos.forEach((v) => {
      if (v.sync) {
        v.sync.paused = anyPlaying;
        WallBridge.sendControl(v.sync.streamId, anyPlaying ? 'pause' : 'play');
      } else if (v.demo) {
        if (anyPlaying) v.demo.pause();
        else v.demo.play();
      } else if (v.videoEl) {
        if (anyPlaying) v.videoEl.pause();
        else {
          const p = v.videoEl.play();
          if (p && typeof p.catch === 'function') p.catch(() => { });
        }
      }
      syncTileButtonState(v);
    });
    syncGlobalButtons();
  }

  function toggleMuteAll() {
    if (state.videos.length === 0) return;
    const nextMuted = !state.allMuted;
    state.allMuted = nextMuted;
    state.videos.forEach((v) => {
      if (v.videoEl) {
        v.videoEl.muted = nextMuted;
        syncTileButtonState(v);
      }
    });
    syncGlobalButtons();
  }

  function toggleSolo(id) {
    state.soloId = state.soloId === id ? null : id;
    scheduleLayout();
  }

  function swapVideos(idA, idB) {
    const idxA = state.videos.findIndex((v) => v.id === idA);
    const idxB = state.videos.findIndex((v) => v.id === idB);
    if (idxA < 0 || idxB < 0 || idxA === idxB) return;

    const tmp = state.videos[idxA];
    state.videos[idxA] = state.videos[idxB];
    state.videos[idxB] = tmp;

    // Swapping positions turns off automatic ratio reordering so manual placement sticks
    if (state.autoReorder) {
      state.autoReorder = false;
      els.toggleReorder.checked = false;
    }
    scheduleLayout();
  }

  function setMode(nextMode) {
    state.mode = nextMode;
    if (nextMode === 'focus' && !state.focusId && state.videos.length > 0) {
      state.focusId = state.videos[0].id;
    }
    state.soloId = null;
    syncGlobalButtons();
    scheduleLayout();
  }

  function ingestFiles(fileList) {
    const files = Array.from(fileList || []);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|mkv|ogv|avi)$/i.test(f.name)) {
        continue;
      }
      const url = URL.createObjectURL(f);
      addMediaVideo(url, f.name, url);
    }
  }

  function openModal(modalEl) {
    modalEl.hidden = false;
    els.settingsPopover.hidden = true;
  }

  function closeAllModals() {
    els.urlModal.hidden = true;
    els.helpModal.hidden = true;
    els.settingsPopover.hidden = true;
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      const p = document.documentElement.requestFullscreen?.();
      if (p && typeof p.catch === 'function') p.catch(() => { });
    } else {
      const p = document.exitFullscreen?.();
      if (p && typeof p.catch === 'function') p.catch(() => { });
    }
  }

  // ===== Event Wiring =====
  function bindEvents() {
    // ResizeObserver with transition suppression during live window drag
    const ro = new ResizeObserver(() => {
      els.stage.classList.add('is-resizing');
      applyLayout();
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        els.stage.classList.remove('is-resizing');
      }, 140);
    });
    ro.observe(els.stage);

    window.addEventListener('mousemove', handleWindowPointerMove, { passive: true });
    window.addEventListener('touchstart', showHudTemporarily, { passive: true });
    els.hud.addEventListener('mouseenter', showHudTemporarily);
    els.hud.addEventListener('mouseleave', () => {
      if (!state.dockPinned && state.videos.length > 0 && els.settingsPopover.hidden) {
        if (hudHideTimer) clearTimeout(hudHideTimer);
        hudHideTimer = setTimeout(() => {
          if (!state.dockPinned && !els.hud.matches(':hover') && els.settingsPopover.hidden) {
            els.hud.classList.remove('is-visible');
          }
        }, 500);
      }
    });

    // Local file pickers
    els.emptyPickFiles.addEventListener('click', () => els.fileInput.click());
    els.btnAddFiles.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', (e) => {
      ingestFiles(e.target.files);
      e.target.value = '';
    });

    // Global drag & drop files
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (dragSourceId) return;
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        dragDepth++;
        els.dropOverlay.hidden = false;
      }
    });
    window.addEventListener('dragover', (e) => {
      if (dragSourceId) return;
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
      }
    });
    window.addEventListener('dragleave', () => {
      if (dragSourceId) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) els.dropOverlay.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (dragSourceId) return;
      dragDepth = 0;
      els.dropOverlay.hidden = true;
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        e.preventDefault();
        ingestFiles(e.dataTransfer.files);
      }
    });

    // URL modal
    els.emptyOpenUrl.addEventListener('click', () => {
      openModal(els.urlModal);
      els.urlTextarea.focus();
    });
    els.btnAddUrl.addEventListener('click', () => {
      openModal(els.urlModal);
      els.urlTextarea.focus();
    });
    els.btnUrlClose.addEventListener('click', () => (els.urlModal.hidden = true));
    els.btnUrlCancel.addEventListener('click', () => (els.urlModal.hidden = true));
    els.btnUrlConfirm.addEventListener('click', () => {
      const lines = els.urlTextarea.value
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /^https?:\/\//i.test(s) || /^blob:/i.test(s) || s.startsWith('/'));
      lines.forEach((url) => {
        const cleanName = url.split('/').pop()?.split('?')[0] || url;
        addMediaVideo(url, cleanName, null);
      });
      els.urlTextarea.value = '';
      els.urlModal.hidden = true;
    });

    // Help modal
    els.btnHelp.addEventListener('click', () => openModal(els.helpModal));
    els.btnHelpClose.addEventListener('click', () => (els.helpModal.hidden = true));
    [els.urlModal, els.helpModal].forEach((modal) => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.hidden = true;
      });
    });

    // Demo launchers
    els.btnAddDemo.addEventListener('click', () => addDemoVideo(els.demoRatioSelect.value));
    els.demoPreset6.addEventListener('click', () => {
      clearAllVideos();
      for (let i = 0; i < 6; i++) addDemoVideo('16:9');
    });
    els.demoPresetMix.addEventListener('click', () => {
      clearAllVideos();
      ['16:9', '9:16', '16:9', '9:16', '16:9'].forEach((p) => addDemoVideo(p));
    });
    els.demoPreset9.addEventListener('click', () => {
      clearAllVideos();
      ['16:9', '9:16', '4:3', '1:1', '21:9', '3:4', '16:9', '2:3', '9:16'].forEach((p) =>
        addDemoVideo(p)
      );
    });

    // Mode buttons
    els.modeButtons.forEach((btn) => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    // Global playback & actions
    els.btnPlayAll.addEventListener('click', togglePlayAll);
    els.btnMuteAll.addEventListener('click', toggleMuteAll);
    els.btnFullscreen.addEventListener('click', toggleFullscreen);
    if (els.btnPopoutWindow) {
      els.btnPopoutWindow.hidden = !WallBridge.isExtension;
      els.btnPopoutWindow.addEventListener('click', () => WallBridge.openPopout());
    }
    if (els.emptyExtHint) {
      els.emptyExtHint.hidden = !WallBridge.isExtension;
    }
    els.btnClearAll.addEventListener('click', clearAllVideos);

    els.btnPinHud.addEventListener('click', () => {
      state.dockPinned = !state.dockPinned;
      syncGlobalButtons();
      showHudTemporarily();
    });

    els.btnSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      els.settingsPopover.hidden = !els.settingsPopover.hidden;
      els.btnSettings.classList.toggle('is-active', !els.settingsPopover.hidden);
      showHudTemporarily();
    });

    document.addEventListener('click', (e) => {
      if (
        !els.settingsPopover.hidden &&
        !els.settingsPopover.contains(e.target) &&
        !els.btnSettings.contains(e.target)
      ) {
        els.settingsPopover.hidden = true;
        els.btnSettings.classList.remove('is-active');
      }
    });

    // Settings controls
    els.rangeGap.addEventListener('input', () => {
      state.gap = Number(els.rangeGap.value);
      els.valGap.textContent = state.gap + ' px';
      scheduleLayout();
    });

    els.rangeBalance.addEventListener('input', () => {
      const pct = Number(els.rangeBalance.value);
      state.balance = pct / 100;
      els.valBalance.textContent = pct + '%';
      scheduleLayout();
    });

    els.toggleReorder.addEventListener('change', () => {
      state.autoReorder = els.toggleReorder.checked;
      scheduleLayout();
    });

    els.toggleDebug.addEventListener('change', () => {
      state.showDebug = els.toggleDebug.checked;
      scheduleLayout();
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (e.key === 'Escape') closeAllModals();
        return;
      }

      if (e.key === 'Escape') {
        if (state.soloId) {
          state.soloId = null;
          scheduleLayout();
        } else {
          closeAllModals();
        }
        return;
      }

      if (e.key === ' ') {
        e.preventDefault();
        togglePlayAll();
      } else if (e.key === 'm' || e.key === 'M') {
        toggleMuteAll();
      } else if (e.key === '1') {
        setMode('max-fill');
      } else if (e.key === '2') {
        setMode('balanced');
      } else if (e.key === '3') {
        setMode('focus');
      } else if (e.key === 'g' || e.key === 'G') {
        const nextGap = state.gap === 0 ? 4 : state.gap === 4 ? 10 : 0;
        state.gap = nextGap;
        els.rangeGap.value = String(nextGap);
        els.valGap.textContent = nextGap + ' px';
        scheduleLayout();
      } else if (e.key === 'i' || e.key === 'I') {
        state.showDebug = !state.showDebug;
        els.toggleDebug.checked = state.showDebug;
        scheduleLayout();
      } else if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen();
      } else if (e.key === '+' || e.key === '=') {
        addDemoVideo(els.demoRatioSelect.value);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (state.videos.length > 0) {
          removeVideo(state.videos[state.videos.length - 1].id);
        }
      } else if (e.key === '?') {
        openModal(els.helpModal);
      }
    });
  }

  function initExtensionBridge() {
    if (!WallBridge.isExtension) return;

    WallBridge.onSyncedVideo((payload) => {
      addSyncedVideo(payload);
    });

    if (typeof WallBridge.onTrackAdded === 'function') {
      WallBridge.onTrackAdded((streamId) => {
        const video = state.videos.find((v) => v.id === streamId);
        if (video && video.videoEl) {
          const p = video.videoEl.play();
          if (p && typeof p.catch === 'function') p.catch(() => { });
        }
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        state.videos.forEach((v) => {
          if (v.sync && !v.sync.paused && v.videoEl && v.videoEl.paused) {
            const p = v.videoEl.play();
            if (p && typeof p.catch === 'function') p.catch(() => { });
          }
        });
      }
    });

    WallBridge.onSourceState((streamId, st) => {
      const video = state.videos.find((v) => v.id === streamId);
      if (!video || !video.sync || !st) return;

      video.sync.paused = Boolean(st.paused);
      video.sync.currentTime = st.currentTime || 0;
      video.sync.duration = st.duration || 0;
      video.sync.playbackRate = st.playbackRate || 1;

      if (!video.sync.paused && video.videoEl && video.videoEl.paused) {
        const p = video.videoEl.play();
        if (p && typeof p.catch === 'function') p.catch(() => { });
      }

      if (Number.isFinite(st.aspectRatio) && st.aspectRatio > 0) {
        if (Math.abs(st.aspectRatio - video.aspectRatio) > 1e-4) {
          video.aspectRatio = st.aspectRatio;
          scheduleLayout();
        }
      }
      syncTileButtonState(video);
      syncGlobalButtons();
    });

    WallBridge.onSourceClosed((streamId) => {
      const video = state.videos.find((v) => v.id === streamId);
      if (!video || !video.sync) return;
      video.sync.sourceClosed = true;
      syncTileButtonState(video);
    });

    WallBridge.onHighlight((streamId) => {
      const entry = tileMap.get(streamId);
      if (!entry) return;
      entry.refs.tile.classList.add('is-highlighted');
      setTimeout(() => {
        entry.refs.tile.classList.remove('is-highlighted');
      }, 1100);
    });

    WallBridge.ready();
  }

  bindEvents();
  initExtensionBridge();
  applyLayout();
})();
