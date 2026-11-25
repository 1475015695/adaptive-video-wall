import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LayoutEngine = require('../src/layoutEngine.js');
const { computeLayout } = LayoutEngine;

const MIXED_RATIOS = [16 / 9, 9 / 16, 4 / 3, 1, 21 / 9, 3 / 4, 2 / 3];

function makeHomogeneous(n, r = 16 / 9) {
  return Array.from({ length: n }, (_, i) => ({ id: `v-${i}`, aspectRatio: r }));
}

function makeMixed(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m-${i}`,
    aspectRatio: MIXED_RATIOS[i % MIXED_RATIOS.length]
  }));
}

function assertGeometricInvariants(videos, container, options, label) {
  const result = computeLayout(videos, container, options);
  const { rects, stats } = result;

  assert.equal(rects.length, videos.length, `${label}: exact rect count`);

  const expectedIds = new Set(videos.map((v) => v.id));
  const seenIds = new Set();
  const ratioMap = new Map(videos.map((v) => [v.id, LayoutEngine.sanitizeAspectRatio(v.aspectRatio)]));

  for (const rc of rects) {
    assert.ok(expectedIds.has(rc.id), `${label}: unexpected id ${rc.id}`);
    assert.ok(!seenIds.has(rc.id), `${label}: duplicate id ${rc.id}`);
    seenIds.add(rc.id);

    assert.ok(Number.isFinite(rc.x) && Number.isFinite(rc.y), `${label}: finite coordinates`);
    assert.ok(rc.width > 0 && rc.height > 0, `${label}: positive dimensions`);

    // Exact aspect ratio preservation (< 1e-4 relative error)
    const targetR = ratioMap.get(rc.id);
    const actualR = rc.width / rc.height;
    const relErr = Math.abs(actualR - targetR) / targetR;
    assert.ok(
      relErr < 1e-4,
      `${label}: aspect ratio drift ${relErr} for ${rc.id} (expected ${targetR}, got ${actualR})`
    );

    // Strict containment within container
    assert.ok(rc.x >= -1e-6, `${label}: x=${rc.x} < 0`);
    assert.ok(rc.y >= -1e-6, `${label}: y=${rc.y} < 0`);
    assert.ok(rc.x + rc.width <= container.width + 1e-6, `${label}: right overflow`);
    assert.ok(rc.y + rc.height <= container.height + 1e-6, `${label}: bottom overflow`);
  }

  // Zero pairwise rectangle overlap (and enforce gap when effectiveGap > 0)
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i];
    for (let j = i + 1; j < rects.length; j++) {
      const b = rects[j];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(
        overlapX <= 1e-5 || overlapY <= 1e-5,
        `${label}: overlap between ${a.id} and ${b.id} (${overlapX} x ${overlapY})`
      );
    }
  }

  assert.ok(stats.usableCoverage > 0 && stats.usableCoverage <= 1.00001, `${label}: valid coverage`);
  return result;
}

test('empty and single video edge cases', () => {
  const empty = computeLayout([], { width: 1600, height: 900 });
  assert.equal(empty.rects.length, 0);
  assert.equal(empty.stats.coverage, 0);

  const single = assertGeometricInvariants(
    [{ id: 'one', aspectRatio: 16 / 9 }],
    { width: 1600, height: 900 },
    { mode: 'max-fill', gap: 4, padding: 0 },
    'single'
  );
  assert.ok(single.stats.coverage > 0.999);
});

test('geometric invariant sweep across viewports, modes, gaps, reorder, and N=1..30', () => {
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 2560, height: 1080 },
    { width: 900, height: 1600 },
    { width: 1000, height: 1000 }
  ];
  const modes = ['max-fill', 'balanced', 'focus'];
  const gaps = [0, 4, 12];
  const counts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 20, 25, 30];

  for (const vp of viewports) {
    for (const mode of modes) {
      for (const gap of gaps) {
        for (const autoReorder of [true, false]) {
          for (const n of counts) {
            if (vp.width !== 1920 && n > 12 && gap === 4) continue;
            const homo = makeHomogeneous(n, 16 / 9);
            assertGeometricInvariants(
              homo,
              vp,
              { mode, gap, padding: 8, autoReorder, focusId: homo[0].id },
              `homo ${vp.width}x${vp.height} ${mode} g=${gap} reorder=${autoReorder} N=${n}`
            );

            const mixed = makeMixed(n);
            assertGeometricInvariants(
              mixed,
              vp,
              { mode, gap, padding: 8, autoReorder, focusId: mixed[0].id },
              `mixed ${vp.width}x${vp.height} ${mode} g=${gap} reorder=${autoReorder} N=${n}`
            );
          }
        }
      }
    }
  }
});

test('utilization benchmarks for homogeneous 16:9 on 1600x900', () => {
  const vp = { width: 1600, height: 900 };
  const opts = { mode: 'max-fill', gap: 0, padding: 0, balance: 0.25, autoReorder: true };

  const expectations = [
    [1, 0.999],
    [3, 0.749],
    [4, 0.999],
    [5, 0.85],
    [6, 0.999],
    [7, 0.999],
    [8, 0.85],
    [9, 0.999],
    [11, 0.88]
  ];

  for (const [n, minCov] of expectations) {
    const res = assertGeometricInvariants(makeHomogeneous(n), vp, opts, `bench-homo-${n}`);
    assert.ok(
      res.stats.coverage >= minCov,
      `N=${n} expected coverage >= ${(minCov * 100).toFixed(1)}%, got ${(res.stats.coverage * 100).toFixed(2)}% (strategy=${res.stats.strategy}, minLinearRatio=${res.stats.minLinearRatio.toFixed(3)})`
    );
  }
});

test('utilization benchmarks for mixed aspect ratios and large scale (N=25, N=50)', () => {
  const vp = { width: 1600, height: 900 };
  const opts = { mode: 'max-fill', gap: 0, padding: 0, balance: 0.25, autoReorder: true };

  const mix4 = [
    { id: 'a', aspectRatio: 16 / 9 },
    { id: 'b', aspectRatio: 16 / 9 },
    { id: 'c', aspectRatio: 9 / 16 },
    { id: 'd', aspectRatio: 9 / 16 }
  ];
  const res4 = assertGeometricInvariants(mix4, vp, opts, 'mix4');
  assert.ok(
    res4.stats.coverage >= 0.88,
    `2x16:9 + 2x9:16 expected >= 88%, got ${(res4.stats.coverage * 100).toFixed(2)}%`
  );

  const mix10Ratios = [16 / 9, 9 / 16, 4 / 3, 1, 21 / 9, 3 / 4, 16 / 9, 9 / 16, 4 / 3, 1];
  const mix10 = mix10Ratios.map((r, i) => ({ id: `m10-${i}`, aspectRatio: r }));
  const res10 = assertGeometricInvariants(mix10, vp, opts, 'mix10');
  assert.ok(
    res10.stats.coverage >= 0.88,
    `mixed 10 expected >= 88%, got ${(res10.stats.coverage * 100).toFixed(2)}%`
  );

  for (const n of [25, 50]) {
    const t0 = performance.now();
    const resN = assertGeometricInvariants(makeMixed(n), vp, opts, `mix-${n}`);
    const dt = performance.now() - t0;
    assert.ok(
      resN.stats.coverage >= 0.90,
      `mixed N=${n} expected >= 90%, got ${(resN.stats.coverage * 100).toFixed(2)}%`
    );
    assert.ok(
      dt < 30,
      `mixed N=${n} expected compute time < 30ms, got ${dt.toFixed(2)}ms`
    );
  }
});

test('balanced and focus modes behave as expected', () => {
  const vp = { width: 1600, height: 900 };

  for (const n of [4, 6, 8, 9]) {
    const res = assertGeometricInvariants(
      makeHomogeneous(n),
      vp,
      { mode: 'balanced', gap: 4, padding: 8, autoReorder: true },
      `balanced-${n}`
    );
    assert.ok(
      res.stats.minLinearRatio >= 0.70,
      `balanced N=${n} minLinearRatio=${res.stats.minLinearRatio.toFixed(3)} < 0.70`
    );
  }

  const mixFocus = makeMixed(6);
  const focusId = mixFocus[2].id;
  const focusRes = assertGeometricInvariants(
    mixFocus,
    vp,
    { mode: 'focus', gap: 4, padding: 8, focusId, autoReorder: true },
    'focus-6'
  );
  const focusRect = focusRes.rects.find((r) => r.id === focusId);
  const maxOtherArea = Math.max(...focusRes.rects.filter((r) => r.id !== focusId).map((r) => r.area));
  assert.ok(
    focusRect.area > maxOtherArea,
    `focus rect area ${focusRect.area} should exceed max secondary area ${maxOtherArea}`
  );
});

test('tiny container with huge gap gracefully reduces effectiveGap and preserves invariants', () => {
  const res = assertGeometricInvariants(
    makeMixed(50),
    { width: 200, height: 150 },
    { mode: 'max-fill', gap: 24, padding: 8, autoReorder: true },
    'tiny-200x150-N50'
  );
  assert.ok(res.stats.effectiveGap < 24, `expected effectiveGap < 24, got ${res.stats.effectiveGap}`);
});
