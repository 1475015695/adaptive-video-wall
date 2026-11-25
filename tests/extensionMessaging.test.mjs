import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBackgroundController, isInjectableUrl } = require('../extension/background.js');

function createMockChrome(initialTabs = [], initialSettings = {}) {
  let nextTabId = 100;
  const tabs = new Map();
  const sentMessages = [];
  const badgeHistory = [];
  const sessionStore = {};
  const localStore = { settings: initialSettings };

  for (const t of initialTabs) {
    tabs.set(t.id, Object.assign({ windowId: 1, active: false, mutedInfo: { muted: false } }, t));
  }

  const chromeApi = {
    runtime: {
      getURL: (p) => `chrome-extension://test-ext-id/${p}`
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: localStore[key] }),
        set: async (obj) => Object.assign(localStore, obj)
      },
      session: {
        get: async (key) => ({ [key]: sessionStore[key] }),
        set: async (obj) => Object.assign(sessionStore, obj)
      }
    },
    action: {
      setBadgeText: async ({ text }) => {
        badgeHistory.push(text);
      },
      setBadgeBackgroundColor: async () => {}
    },
    windows: {
      update: async () => ({}),
      create: async (opts) => {
        const id = ++nextTabId;
        const tab = { id, windowId: 2, url: opts.url, active: true, mutedInfo: { muted: false } };
        tabs.set(id, tab);
        return { id: 2, tabs: [tab] };
      }
    },
    tabs: {
      get: async (tabId) => {
        const t = tabs.get(tabId);
        if (!t) throw new Error('Tab not found');
        return t;
      },
      query: async (q) => {
        const res = [];
        for (const t of tabs.values()) {
          if (q.url) {
            const prefix = q.url.replace(/\*$/, '');
            if (!t.url || !t.url.startsWith(prefix)) continue;
          }
          if (q.active && !t.active) continue;
          res.push(t);
        }
        return res;
      },
      create: async (opts) => {
        const id = ++nextTabId;
        const tab = { id, windowId: 1, url: opts.url, active: Boolean(opts.active), mutedInfo: { muted: false } };
        tabs.set(id, tab);
        return tab;
      },
      update: async (tabId, props) => {
        const t = tabs.get(tabId);
        if (!t) throw new Error('Tab not found');
        if ('muted' in props) t.mutedInfo = { muted: Boolean(props.muted) };
        if ('active' in props) t.active = Boolean(props.active);
        return t;
      },
      sendMessage: async (tabId, msg, options) => {
        sentMessages.push({ tabId, frameId: options?.frameId ?? null, msg });
        return { ok: true };
      }
    },
    scripting: {
      executeScript: async () => []
    }
  };

  return { chromeApi, tabs, sentMessages, badgeHistory };
}

test('isInjectableUrl filters restricted protocols and webstore', () => {
  assert.equal(isInjectableUrl('https://www.youtube.com/watch?v=1'), true);
  assert.equal(isInjectableUrl('http://localhost:8080/video.html'), true);
  assert.equal(isInjectableUrl('file:///Users/demo/video.html'), true);
  assert.equal(isInjectableUrl('chrome://extensions'), false);
  assert.equal(isInjectableUrl('chrome-extension://abc/index.html'), false);
  assert.equal(isInjectableUrl('https://chromewebstore.google.com/detail/xyz'), false);
});

test('queuing SYNC_VIDEO_REQUEST, WALL_READY flush, WALL_PEER_READY & RTC_SIGNAL routing', async () => {
  const { chromeApi, tabs, sentMessages, badgeHistory } = createMockChrome([
    { id: 10, url: 'https://www.bilibili.com/video/BV1xx', active: true, mutedInfo: { muted: false } }
  ]);
  const bg = createBackgroundController(chromeApi);

  // 1. Source frame 3 sends SYNC_VIDEO_REQUEST before wall tab is ready
  const syncRes = await bg.handleMessage(
    {
      type: 'SYNC_VIDEO_REQUEST',
      videoUid: 'v-1',
      transport: 'webrtc',
      meta: { title: 'Test Video', aspectRatio: 16 / 9 }
    },
    { tab: tabs.get(10), frameId: 3 }
  );

  assert.equal(syncRes.ok, true);
  assert.equal(syncRes.alreadySynced, false);
  const streamId = syncRes.streamId;

  // Source tab should have been auto-muted
  assert.equal(tabs.get(10).mutedInfo.muted, true);
  assert.equal(badgeHistory.at(-1), '1');

  // Wall tab was created as tabId 101; pending add has not been flushed until WALL_READY
  const wallTab = tabs.get(101);
  assert.ok(wallTab.url.endsWith('index.html'));
  assert.equal(
    sentMessages.some((m) => m.tabId === 101 && m.msg.type === 'WALL_ADD_SYNCED_VIDEO'),
    false
  );

  // 2. Wall tab signals WALL_READY -> flushes WALL_ADD_SYNCED_VIDEO
  await bg.handleMessage({ type: 'WALL_READY' }, { tab: wallTab, frameId: 0 });
  const addMsg = sentMessages.find((m) => m.tabId === 101 && m.msg.type === 'WALL_ADD_SYNCED_VIDEO');
  assert.ok(addMsg);
  assert.equal(addMsg.msg.streamId, streamId);

  // 3. Wall tab signals WALL_PEER_READY -> routed to sourceTabId=10, frameId=3
  await bg.handleMessage({ type: 'WALL_PEER_READY', streamId }, { tab: wallTab, frameId: 0 });
  const peerReadyMsg = sentMessages.find((m) => m.tabId === 10 && m.msg.type === 'WALL_PEER_READY');
  assert.ok(peerReadyMsg);
  assert.equal(peerReadyMsg.frameId, 3);

  // 4. Bidirectional RTC_SIGNAL routing
  await bg.handleMessage(
    { type: 'RTC_SIGNAL', streamId, signal: { type: 'offer', sdp: 'v=0...' } },
    { tab: tabs.get(10), frameId: 3 }
  );
  const offerToWall = sentMessages.find(
    (m) => m.tabId === 101 && m.msg.type === 'RTC_SIGNAL' && m.msg.signal.type === 'offer'
  );
  assert.ok(offerToWall);

  await bg.handleMessage(
    { type: 'RTC_SIGNAL', streamId, signal: { type: 'answer', sdp: 'v=0ans...' } },
    { tab: wallTab, frameId: 0 }
  );
  const ansToSource = sentMessages.find(
    (m) => m.tabId === 10 && m.msg.type === 'RTC_SIGNAL' && m.msg.signal.type === 'answer'
  );
  assert.ok(ansToSource);
  assert.equal(ansToSource.frameId, 3);

  // 5. Duplicate sync request highlights existing tile instead of duplicating
  const dupRes = await bg.handleMessage(
    { type: 'SYNC_VIDEO_REQUEST', videoUid: 'v-1', transport: 'webrtc' },
    { tab: tabs.get(10), frameId: 3 }
  );
  assert.equal(dupRes.alreadySynced, true);
  assert.equal(dupRes.streamId, streamId);
  assert.ok(sentMessages.some((m) => m.tabId === 101 && m.msg.type === 'WALL_HIGHLIGHT_VIDEO'));

  // 6. Remote stop restores auto-mute on source tab
  await bg.handleMessage({ type: 'REMOTE_VIDEO_CONTROL', streamId, action: 'stop' }, { tab: wallTab });
  assert.equal(tabs.get(10).mutedInfo.muted, false);
  assert.equal(badgeHistory.at(-1), '');
});

test('closing wall tab stops all streams and restores only auto-muted tabs', async () => {
  const { chromeApi, tabs, sentMessages } = createMockChrome([
    { id: 20, url: 'https://youtube.com/watch?v=a', active: true, mutedInfo: { muted: false } },
    { id: 21, url: 'https://twitch.tv/demo', active: false, mutedInfo: { muted: true } } // already muted by user
  ]);
  const bg = createBackgroundController(chromeApi);

  const s1 = await bg.handleMessage(
    { type: 'SYNC_VIDEO_REQUEST', videoUid: 'u1', transport: 'webrtc' },
    { tab: tabs.get(20), frameId: 0 }
  );
  const s2 = await bg.handleMessage(
    { type: 'SYNC_VIDEO_REQUEST', videoUid: 'u2', transport: 'webrtc' },
    { tab: tabs.get(21), frameId: 0 }
  );
  const wallTab = tabs.get(101);
  await bg.handleMessage({ type: 'WALL_READY' }, { tab: wallTab, frameId: 0 });

  assert.equal(tabs.get(20).mutedInfo.muted, true);
  assert.equal(tabs.get(21).mutedInfo.muted, true);

  // Close wall tab
  await bg.handleTabRemoved(101);

  assert.ok(sentMessages.some((m) => m.tabId === 20 && m.msg.action === 'stop' && m.msg.streamId === s1.streamId));
  assert.ok(sentMessages.some((m) => m.tabId === 21 && m.msg.action === 'stop' && m.msg.streamId === s2.streamId));

  // Tab 20 was auto-muted -> restored to unmuted; Tab 21 was already user-muted -> remains muted
  assert.equal(tabs.get(20).mutedInfo.muted, false);
  assert.equal(tabs.get(21).mutedInfo.muted, true);
});

test('closing source tab notifies wall tab with WALL_SOURCE_CLOSED', async () => {
  const { chromeApi, tabs, sentMessages } = createMockChrome([
    { id: 30, url: 'https://vimeo.com/123', active: true, mutedInfo: { muted: false } }
  ]);
  const bg = createBackgroundController(chromeApi);

  const s = await bg.handleMessage(
    { type: 'SYNC_VIDEO_REQUEST', videoUid: 'v30', transport: 'direct-url', src: 'https://cdn.example.com/a.mp4' },
    { tab: tabs.get(30), frameId: 0 }
  );
  await bg.handleMessage({ type: 'WALL_READY' }, { tab: tabs.get(101), frameId: 0 });

  await bg.handleTabRemoved(30);
  const closedMsg = sentMessages.find((m) => m.tabId === 101 && m.msg.type === 'WALL_SOURCE_CLOSED');
  assert.ok(closedMsg);
  assert.equal(closedMsg.msg.streamId, s.streamId);
});
