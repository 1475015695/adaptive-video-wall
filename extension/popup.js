/**
 * Chrome Extension Popup Controller
 */
(function () {
  'use strict';

  const els = {
    popupSyncBadge: document.getElementById('popup-sync-badge'),
    btnPickVideo: document.getElementById('btn-pick-video'),
    btnOpenWall: document.getElementById('btn-open-wall'),
    btnOpenPopout: document.getElementById('btn-open-popout'),
    btnRescan: document.getElementById('btn-rescan'),
    videoList: document.getElementById('video-list'),
    optFocusWall: document.getElementById('opt-focus-wall'),
    optMuteSource: document.getElementById('opt-mute-source')
  };

  function formatRatio(r) {
    if (!Number.isFinite(r) || r <= 0) return '16:9';
    const known = [
      [16 / 9, '16:9'],
      [9 / 16, '9:16'],
      [4 / 3, '4:3'],
      [3 / 4, '3:4'],
      [1, '1:1'],
      [21 / 9, '21:9']
    ];
    for (let i = 0; i < known.length; i++) {
      if (Math.abs(r - known[i][0]) < 0.04) return known[i][1];
    }
    return r.toFixed(2) + ':1';
  }

  function renderEmpty(message) {
    els.videoList.textContent = '';
    const box = document.createElement('div');
    box.className = 'list-empty';
    box.textContent = message;
    els.videoList.appendChild(box);
  }

  function renderVideos(videos) {
    if (!videos || videos.length === 0) {
      renderEmpty('当前页面未检测到已加载的视频。\n可先点击播放视频，或使用“点选页面视频”。');
      return;
    }

    els.videoList.textContent = '';
    let syncedCount = 0;

    videos.forEach((v) => {
      if (v.alreadySynced) syncedCount++;

      const item = document.createElement('div');
      item.className = 'video-item';

      const info = document.createElement('div');
      info.className = 'video-info';

      const titleRow = document.createElement('div');
      titleRow.className = 'video-title';
      const dot = document.createElement('span');
      dot.className = 'status-dot' + (v.isPlaying ? ' is-playing' : '');
      const titleText = document.createElement('span');
      titleText.textContent = v.title || '网页视频';
      titleText.title = v.title || '';
      titleRow.appendChild(dot);
      titleRow.appendChild(titleText);

      const metaRow = document.createElement('div');
      metaRow.className = 'video-meta';
      const statusLabel = v.isPlaying ? '播放中' : '已暂停';
      metaRow.textContent = `${statusLabel} · ${v.videoWidth || v.width}×${v.videoHeight || v.height} · ${formatRatio(v.aspectRatio)}`;

      info.appendChild(titleRow);
      info.appendChild(metaRow);

      const actions = document.createElement('div');
      actions.className = 'item-actions';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn-save-item';
      saveBtn.textContent = '保存';
      saveBtn.title = '下载或录制保存该视频';
      saveBtn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({
          type: 'START_SAVE_BY_UID',
          tabId: v.tabId,
          frameId: v.frameId,
          videoUid: v.videoUid
        });
        window.close();
      });

      const syncBtn = document.createElement('button');
      syncBtn.type = 'button';
      syncBtn.className = 'btn-sync-item' + (v.alreadySynced ? ' is-synced' : '');
      syncBtn.textContent = v.alreadySynced ? '✓ 已同步' : '同步';
      syncBtn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({
          type: 'START_SYNC_BY_UID',
          tabId: v.tabId,
          frameId: v.frameId,
          videoUid: v.videoUid
        });
        syncBtn.textContent = '✓ 已同步';
        syncBtn.classList.add('is-synced');
      });

      actions.appendChild(saveBtn);
      actions.appendChild(syncBtn);

      item.appendChild(info);
      item.appendChild(actions);
      els.videoList.appendChild(item);
    });

    if (syncedCount > 0) {
      els.popupSyncBadge.textContent = `已同步 ${syncedCount} 路`;
    }
  }

  async function scanCurrentTab() {
    renderEmpty('正在扫描当前页面视频…');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        renderEmpty('无法读取当前标签页。');
        return;
      }
      const res = await chrome.runtime.sendMessage({ type: 'SCAN_TAB_VIDEOS', tabId: tab.id });
      if (!res || res.restricted) {
        renderEmpty('当前页面为浏览器受限页面（如 chrome:// 或扩展商店），请在普通网页视频页使用。');
        return;
      }
      renderVideos(res.videos || []);
    } catch (_err) {
      renderEmpty('扫描失败，请刷新页面后重试。');
    }
  }

  async function loadSettings() {
    const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }).catch(() => null);
    if (res && res.settings) {
      els.optFocusWall.checked = Boolean(res.settings.focusWallOnSync);
      els.optMuteSource.checked = Boolean(res.settings.autoMuteSourceTab);
    }
  }

  function saveSettings() {
    chrome.runtime
      .sendMessage({
        type: 'SET_SETTINGS',
        settings: {
          showHoverButton: false,
          focusWallOnSync: els.optFocusWall.checked,
          autoMuteSourceTab: els.optMuteSource.checked
        }
      })
      .catch(() => { });
  }

  els.btnPickVideo.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await chrome.runtime.sendMessage({ type: 'ENTER_PICKER_MODE', tabId: tab.id }).catch(() => { });
    }
    window.close();
  });

  els.btnOpenWall.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_WALL_TAB' }).catch(() => { });
    window.close();
  });

  els.btnOpenPopout.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_WALL_POPOUT' }).catch(() => { });
    window.close();
  });

  els.btnRescan.addEventListener('click', scanCurrentTab);
  els.optFocusWall.addEventListener('change', saveSettings);
  els.optMuteSource.addEventListener('change', saveSettings);

  loadSettings();
  scanCurrentTab();
})();
