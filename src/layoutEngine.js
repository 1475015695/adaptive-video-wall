/**
 * Adaptive Multi-Video Layout Engine
 *
 * Computes gap-aware, exact aspect-ratio-preserving layouts for N >= 1 videos
 * inside any container rectangle, maximizing screen coverage while preventing
 * microscopic tiles via configurable balance constraints.
 */
(function (root) {
  'use strict';

  const EPS = 1e-9;
  const MIN_RATIO = 0.1;
  const MAX_RATIO = 10;

  function clamp(val, min, max) {
    return val < min ? min : val > max ? max : val;
  }

  function sanitizeAspectRatio(r) {
    if (!Number.isFinite(r) || r <= 0) return 16 / 9;
    return clamp(r, MIN_RATIO, MAX_RATIO);
  }

  /**
   * Bottom-up exact affine relation w(h) = a * h + b for a slicing tree with gap g.
   */
  function computeAffineTree(node, gap) {
    if (node.type === 'leaf') {
      return {
        type: 'leaf',
        id: node.id,
        r: node.r,
        isSpacer: Boolean(node.isSpacer),
        a: node.r,
        b: 0
      };
    }

    const left = computeAffineTree(node.left, gap);
    const right = computeAffineTree(node.right, gap);

    if (node.type === 'H') {
      return {
        type: 'H',
        left,
        right,
        a: left.a + right.a,
        b: left.b + right.b + gap
      };
    }

    // V-split: left on top, right on bottom, shared width w
    const a = 1 / (1 / left.a + 1 / right.a);
    const b = a * (left.b / left.a + right.b / right.a - gap);
    return {
      type: 'V',
      left,
      right,
      a,
      b
    };
  }

  function projectAffineTree(node, x, y, w, h, gap, outRects) {
    if (node.type === 'leaf') {
      if (!node.isSpacer) {
        outRects.push({
          id: node.id,
          x,
          y,
          width: w,
          height: h,
          aspectRatio: node.r
        });
      }
      return;
    }

    if (node.type === 'H') {
      const wL = node.left.a * h + node.left.b;
      const wR = node.right.a * h + node.right.b;
      projectAffineTree(node.left, x, y, wL, h, gap, outRects);
      projectAffineTree(node.right, x + wL + gap, y, wR, h, gap, outRects);
      return;
    }

    const hL = (w - node.left.b) / node.left.a;
    const hR = (w - node.right.b) / node.right.a;
    projectAffineTree(node.left, x, y, w, hL, gap, outRects);
    projectAffineTree(node.right, x, y + hL + gap, w, hR, gap, outRects);
  }

  function buildGapCandidates(gap) {
    if (gap <= 0) return [0];
    const raw = [gap, gap * 0.5, gap * 0.25, gap * 0.1, 0];
    const unique = [];
    for (let i = 0; i < raw.length; i++) {
      const g = raw[i] < 0.05 ? 0 : raw[i];
      if (unique.length === 0 || Math.abs(unique[unique.length - 1] - g) > 1e-6) {
        unique.push(g);
      }
    }
    if (unique[unique.length - 1] !== 0) unique.push(0);
    return unique;
  }

  /**
   * Solves a slicing tree inside usable box (W, H) offset by (padX, padY) with gap fallback.
   */
  function solveTreeWithGap(tree, usableW, usableH, padX, padY, requestedGap) {
    const gaps = buildGapCandidates(requestedGap);

    for (let gi = 0; gi < gaps.length; gi++) {
      const g = gaps[gi];
      const affine = computeAffineTree(tree, g);
      if (!Number.isFinite(affine.a) || affine.a <= EPS) continue;

      let h = Math.min(usableH, (usableW - affine.b) / affine.a);
      let w = affine.a * h + affine.b;

      // Guard tiny floating-point overshoot against usableW
      if (w > usableW) {
        h -= (w - usableW) / affine.a + 1e-11;
        w = affine.a * h + affine.b;
      }
      if (h > usableH) {
        h = usableH - 1e-11;
        w = affine.a * h + affine.b;
      }

      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        continue;
      }

      const x0 = padX + Math.max(0, (usableW - w) * 0.5);
      const y0 = padY + Math.max(0, (usableH - h) * 0.5);
      const rects = [];
      projectAffineTree(affine, x0, y0, w, h, g, rects);

      const minDimThreshold = g > 0 ? 4.0 : 0;
      let valid = rects.length > 0;
      for (let i = 0; i < rects.length; i++) {
        const rc = rects[i];
        if (
          !Number.isFinite(rc.width) ||
          !Number.isFinite(rc.height) ||
          rc.width <= minDimThreshold ||
          rc.height <= minDimThreshold
        ) {
          valid = false;
          break;
        }
      }

      if (valid) {
        return { rects, effectiveGap: g };
      }
    }

    return null;
  }

  /**
   * Solves equal-height centered rows (handles incomplete last rows cleanly, e.g. N=3 -> 75%).
   */
  function solveEqualHeightRows(rows, usableW, usableH, padX, padY, requestedGap) {
    const k = rows.length;
    if (k === 0) return null;
    const gaps = buildGapCandidates(requestedGap);

    for (let gi = 0; gi < gaps.length; gi++) {
      const g = gaps[gi];
      let hStar = (usableH - (k - 1) * g) / k;
      if (hStar <= 0) continue;

      for (let j = 0; j < k; j++) {
        const row = rows[j];
        let sumR = 0;
        for (let i = 0; i < row.length; i++) sumR += row[i].r;
        const maxRowH = (usableW - (row.length - 1) * g) / sumR;
        if (maxRowH < hStar) hStar = maxRowH;
      }

      if (!Number.isFinite(hStar) || hStar <= (g > 0 ? 4.0 : 0)) continue;

      let minW = Infinity;
      for (let j = 0; j < k; j++) {
        const row = rows[j];
        for (let i = 0; i < row.length; i++) {
          const w = row[i].r * hStar;
          if (w < minW) minW = w;
        }
      }
      if (minW <= (g > 0 ? 4.0 : 0)) continue;

      const totalH = k * hStar + (k - 1) * g;
      let y = padY + Math.max(0, (usableH - totalH) * 0.5);
      const rects = [];

      for (let j = 0; j < k; j++) {
        const row = rows[j];
        let sumR = 0;
        for (let i = 0; i < row.length; i++) sumR += row[i].r;
        const rowW = sumR * hStar + (row.length - 1) * g;
        let x = padX + Math.max(0, (usableW - rowW) * 0.5);

        for (let i = 0; i < row.length; i++) {
          const item = row[i];
          const w = item.r * hStar;
          rects.push({
            id: item.id,
            x,
            y,
            width: w,
            height: hStar,
            aspectRatio: item.r
          });
          x += w + g;
        }
        y += hStar + g;
      }

      return { rects, effectiveGap: g };
    }

    return null;
  }

  /**
   * Dual solver: equal-width centered columns.
   */
  function solveEqualWidthCols(cols, usableW, usableH, padX, padY, requestedGap) {
    const k = cols.length;
    if (k === 0) return null;
    const gaps = buildGapCandidates(requestedGap);

    for (let gi = 0; gi < gaps.length; gi++) {
      const g = gaps[gi];
      let wStar = (usableW - (k - 1) * g) / k;
      if (wStar <= 0) continue;

      for (let j = 0; j < k; j++) {
        const col = cols[j];
        let sumInvR = 0;
        for (let i = 0; i < col.length; i++) sumInvR += 1 / col[i].r;
        const maxColW = (usableH - (col.length - 1) * g) / sumInvR;
        if (maxColW < wStar) wStar = maxColW;
      }

      if (!Number.isFinite(wStar) || wStar <= (g > 0 ? 4.0 : 0)) continue;

      let minH = Infinity;
      for (let j = 0; j < k; j++) {
        const col = cols[j];
        for (let i = 0; i < col.length; i++) {
          const h = wStar / col[i].r;
          if (h < minH) minH = h;
        }
      }
      if (minH <= (g > 0 ? 4.0 : 0)) continue;

      const totalW = k * wStar + (k - 1) * g;
      let x = padX + Math.max(0, (usableW - totalW) * 0.5);
      const rects = [];

      for (let j = 0; j < k; j++) {
        const col = cols[j];
        let sumInvR = 0;
        for (let i = 0; i < col.length; i++) sumInvR += 1 / col[i].r;
        const colH = sumInvR * wStar + (col.length - 1) * g;
        let y = padY + Math.max(0, (usableH - colH) * 0.5);

        for (let i = 0; i < col.length; i++) {
          const item = col[i];
          const h = wStar / item.r;
          rects.push({
            id: item.id,
            x,
            y,
            width: wStar,
            height: h,
            aspectRatio: item.r
          });
          y += h + g;
        }
        x += wStar + g;
      }

      return { rects, effectiveGap: g };
    }

    return null;
  }

  /**
   * Computes metrics and objective score for solved candidate rectangles.
   */
  function scoreCandidate(solved, usableArea, containerArea, options, meta) {
    const rects = solved.rects;
    const n = rects.length;
    if (n === 0 || usableArea <= 0) {
      return {
        score: -Infinity,
        coverage: 0,
        usableCoverage: 0,
        totalVideoArea: 0,
        minLinearRatio: 1
      };
    }

    let totalArea = 0;
    let minS = Infinity;
    let maxS = 0;
    let sumS = 0;
    let focusArea = 0;
    let maxSecondaryArea = 0;

    const focusId = options.focusId;

    for (let i = 0; i < n; i++) {
      const rc = rects[i];
      const area = rc.width * rc.height;
      const s = Math.sqrt(area);
      totalArea += area;
      if (s < minS) minS = s;
      if (s > maxS) maxS = s;
      sumS += s;

      if (focusId !== null && rc.id === focusId) {
        focusArea = area;
      } else if (area > maxSecondaryArea) {
        maxSecondaryArea = area;
      }
    }

    const usableCoverage = totalArea / usableArea;
    const coverage = containerArea > 0 ? totalArea / containerArea : 0;
    const minLinearRatio = maxS > 0 ? minS / maxS : 1;
    const balance = clamp(
      Number.isFinite(options.balance) ? options.balance : 0.25,
      0,
      1
    );
    const spacerPenalty = meta && meta.hasSpacer ? 0.9994 : 1.0;

    let score = usableCoverage;

    if (options.mode === 'balanced') {
      const drop = minLinearRatio < 0.65 ? Math.pow(minLinearRatio / 0.65, 1.5) : 1;
      score = usableCoverage * Math.pow(minLinearRatio, 1.35) * drop * spacerPenalty;
    } else if (options.mode === 'focus' && n >= 2) {
      const focusShare = totalArea > 0 ? focusArea / totalArea : 0;
      let prominenceFactor = 1.0;
      if (focusArea < 1.35 * maxSecondaryArea) {
        const ratio = maxSecondaryArea > 0 ? focusArea / (1.35 * maxSecondaryArea) : 0;
        prominenceFactor = 0.25 * Math.pow(Math.max(0, ratio), 2);
      }
      let shareBonus = 1.0;
      if (focusShare >= 0.35 && focusShare <= 0.72) {
        shareBonus = 1.12;
      } else if (focusShare < 0.35) {
        shareBonus = 0.8 + 0.32 * (focusShare / 0.35);
      } else {
        shareBonus = 1.12 - 0.15 * ((focusShare - 0.72) / 0.28);
      }
      const secondaryPenalty = minLinearRatio < 0.18 ? Math.pow(minLinearRatio / 0.18, 2) : 1;
      score = usableCoverage * prominenceFactor * shareBonus * secondaryPenalty * spacerPenalty;
    } else {
      // max-fill mode
      const floor = 0.28 + 0.48 * balance;
      let floorPenalty = 1.0;
      if (minLinearRatio < floor) {
        const ratio = minLinearRatio / floor;
        floorPenalty = ratio * ratio;
      }
      const gentleUniformity = 1 - 0.14 * balance * (1 - minLinearRatio);
      const meanS = sumS / n;
      const meanBalanceTie = meanS > 0 ? 1 + 0.002 * (minS / meanS) : 1;
      score = usableCoverage * floorPenalty * gentleUniformity * meanBalanceTie * spacerPenalty;
    }

    return {
      score,
      coverage,
      usableCoverage,
      totalVideoArea: totalArea,
      minLinearRatio
    };
  }

  function makeLeaf(item) {
    return { type: 'leaf', id: item.id, r: item.r, isSpacer: Boolean(item.isSpacer) };
  }

  function buildChainTree(nodes, op) {
    if (nodes.length === 1) return nodes[0];
    // Balanced binary reduction minimizes numerical depth and supports clean local refinement
    function reduce(lo, hi) {
      if (hi - lo === 1) return nodes[lo];
      const mid = (lo + hi) >> 1;
      return {
        type: op,
        left: reduce(lo, mid),
        right: reduce(mid, hi)
      };
    }
    return reduce(0, nodes.length);
  }

  function rowsToTree(rows) {
    const rowTrees = [];
    for (let j = 0; j < rows.length; j++) {
      const rowLeaves = rows[j].map(makeLeaf);
      rowTrees.push(buildChainTree(rowLeaves, 'H'));
    }
    return buildChainTree(rowTrees, 'V');
  }

  function colsToTree(cols) {
    const colTrees = [];
    for (let j = 0; j < cols.length; j++) {
      const colLeaves = cols[j].map(makeLeaf);
      colTrees.push(buildChainTree(colLeaves, 'V'));
    }
    return buildChainTree(colTrees, 'H');
  }

  /**
   * Partitions ordered items sequentially into <= k groups minimizing max group weight.
   */
  function sequentialBottleneckPartition(items, k, weightFn) {
    const n = items.length;
    if (k >= n) return items.map((it) => [it]);
    if (k <= 1) return [items.slice()];

    let lo = 0;
    let hi = 0;
    const weights = new Array(n);
    for (let i = 0; i < n; i++) {
      const w = weightFn(items[i]);
      weights[i] = w;
      if (w > lo) lo = w;
      hi += w;
    }

    function canSplit(limit) {
      let count = 1;
      let acc = 0;
      for (let i = 0; i < n; i++) {
        if (acc + weights[i] > limit + 1e-12) {
          count++;
          acc = weights[i];
          if (count > k) return false;
        } else {
          acc += weights[i];
        }
      }
      return true;
    }

    for (let iter = 0; iter < 32; iter++) {
      const mid = (lo + hi) * 0.5;
      if (canSplit(mid)) hi = mid;
      else lo = mid;
    }

    const groups = [[]];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      if (acc + weights[i] > hi + 1e-9 && groups[groups.length - 1].length > 0 && groups.length < k) {
        groups.push([]);
        acc = 0;
      }
      groups[groups.length - 1].push(items[i]);
      acc += weights[i];
    }
    return groups;
  }

  function sequentialEvenCountPartition(items, k) {
    const n = items.length;
    const groups = [];
    const base = Math.floor(n / k);
    const rem = n % k;
    let idx = 0;
    for (let j = 0; j < k; j++) {
      const size = base + (j < rem ? 1 : 0);
      if (size > 0) {
        groups.push(items.slice(idx, idx + size));
        idx += size;
      }
    }
    return groups;
  }

  function lptPartition(items, k, weightFn) {
    const sorted = items.slice().sort((a, b) => weightFn(b) - weightFn(a));
    const groups = Array.from({ length: k }, () => []);
    const sums = new Float64Array(k);

    for (let i = 0; i < sorted.length; i++) {
      let bestIdx = 0;
      for (let j = 1; j < k; j++) {
        if (sums[j] < sums[bestIdx]) bestIdx = j;
      }
      groups[bestIdx].push(sorted[i]);
      sums[bestIdx] += weightFn(sorted[i]);
    }
    return groups.filter((g) => g.length > 0);
  }

  function snakeCountPartition(items, k, weightFn) {
    const n = items.length;
    const sorted = items.slice().sort((a, b) => weightFn(b) - weightFn(a));
    const groups = Array.from({ length: k }, () => []);
    let idx = 0;
    let dir = 1;
    let row = 0;
    while (idx < n) {
      groups[row].push(sorted[idx++]);
      if (dir === 1) {
        if (row === k - 1) dir = -1;
        else row++;
      } else {
        if (row === 0) dir = 1;
        else row--;
      }
    }
    return groups.filter((g) => g.length > 0);
  }

  function generateGroupCounts(n, meanR, targetR) {
    if (n <= 28) {
      const arr = [];
      for (let k = 1; k <= n; k++) arr.push(k);
      return { rowCounts: arr, colCounts: arr };
    }

    const rowSet = new Set();
    const colSet = new Set();
    const kRowEst = Math.round(Math.sqrt((n * meanR) / targetR));
    const kColEst = Math.round(Math.sqrt(n / (meanR * targetR)));

    for (let k = 1; k <= Math.min(n, 8); k++) {
      rowSet.add(k);
      colSet.add(k);
    }
    for (let d = -12; d <= 12; d++) {
      const kr = kRowEst + d;
      if (kr >= 1 && kr <= n) rowSet.add(kr);
      const kc = kColEst + d;
      if (kc >= 1 && kc <= n) colSet.add(kc);
    }
    rowSet.add(n);
    colSet.add(n);

    return {
      rowCounts: Array.from(rowSet).sort((a, b) => a - b),
      colCounts: Array.from(colSet).sort((a, b) => a - b)
    };
  }

  /**
   * Strategy A: Multi-Row & Multi-Column Partitioning (both Equal-Height/Width and Tight Slicing Trees).
   */
  function runStrategyA(items, usableW, usableH, padX, padY, usableArea, containerArea, options, registerCandidate) {
    const n = items.length;
    const targetR = usableW / usableH;
    let sumR = 0;
    for (let i = 0; i < n; i++) sumR += items[i].r;
    const meanR = sumR / n;

    const { rowCounts, colCounts } = generateGroupCounts(n, meanR, targetR);
    const weightR = (it) => it.r;
    const weightInvR = (it) => 1 / it.r;

    const sortedDescR = options.autoReorder ? items.slice().sort((a, b) => b.r - a.r) : null;
    const sortedAscR = options.autoReorder ? items.slice().sort((a, b) => a.r - b.r) : null;

    function evalRows(rows, label) {
      const eq = solveEqualHeightRows(rows, usableW, usableH, padX, padY, options.gap);
      if (eq) registerCandidate(eq, null, 'rows-equal-' + label, false);

      const tree = rowsToTree(rows);
      const tight = solveTreeWithGap(tree, usableW, usableH, padX, padY, options.gap);
      if (tight) registerCandidate(tight, tree, 'rows-tight-' + label, false);
    }

    function evalCols(cols, label) {
      const eq = solveEqualWidthCols(cols, usableW, usableH, padX, padY, options.gap);
      if (eq) registerCandidate(eq, null, 'cols-equal-' + label, false);

      const tree = colsToTree(cols);
      const tight = solveTreeWithGap(tree, usableW, usableH, padX, padY, options.gap);
      if (tight) registerCandidate(tight, tree, 'cols-tight-' + label, false);
    }

    for (let ki = 0; ki < rowCounts.length; ki++) {
      const k = rowCounts[ki];
      evalRows(sequentialEvenCountPartition(items, k), 'seq-even');
      evalRows(sequentialBottleneckPartition(items, k, weightR), 'seq-bal');

      if (options.autoReorder) {
        evalRows(lptPartition(items, k, weightR), 'lpt');
        evalRows(snakeCountPartition(items, k, weightR), 'snake');
        evalRows(sequentialEvenCountPartition(sortedDescR, k), 'desc-even');
        evalRows(sequentialBottleneckPartition(sortedAscR, k, weightR), 'asc-bal');
      }
    }

    for (let ki = 0; ki < colCounts.length; ki++) {
      const k = colCounts[ki];
      evalCols(sequentialEvenCountPartition(items, k), 'seq-even');
      evalCols(sequentialBottleneckPartition(items, k, weightInvR), 'seq-bal');

      if (options.autoReorder) {
        evalCols(lptPartition(items, k, weightInvR), 'lpt');
        evalCols(snakeCountPartition(items, k, weightInvR), 'snake');
        evalCols(sequentialEvenCountPartition(sortedAscR, k), 'asc-even');
      }
    }
  }

  /**
   * Groups items by rounded aspect ratio so identical/near-identical ratios collapse
   * to compact mixed-radix multisets.
   */
  function buildRatioGroups(items, decimals) {
    const map = new Map();
    for (let i = 0; i < items.length; i++) {
      const key = items[i].r.toFixed(decimals);
      let grp = map.get(key);
      if (!grp) {
        grp = { key, items: [], sumR: 0 };
        map.set(key, grp);
      }
      grp.items.push(items[i]);
      grp.sumR += items[i].r;
    }
    const groups = Array.from(map.values()).sort((a, b) => a.sumR / a.items.length - b.sumR / b.items.length);
    for (let g = 0; g < groups.length; g++) {
      groups[g].repR = groups[g].sumR / groups[g].items.length;
    }
    return groups;
  }

  function countMultisets(groups) {
    let total = 1;
    for (let i = 0; i < groups.length; i++) {
      total *= groups[i].items.length + 1;
      if (total > 10000) return total;
    }
    return total - 1;
  }

  function runSubsetDP(groups, targetR, minBalanceFloor) {
    const K = groups.length;
    const maxC = new Int32Array(K);
    const strides = new Int32Array(K);
    let totalStates = 1;
    for (let k = K - 1; k >= 0; k--) {
      maxC[k] = groups[k].items.length;
      strides[k] = totalStates;
      totalStates *= maxC[k] + 1;
    }

    const dp = new Array(totalStates);
    for (let idx = 1; idx < totalStates; idx++) {
      dp[idx] = new Map();
    }

    const bucketStep = 0.05;
    const minKeepBalance = Math.max(0.22, minBalanceFloor);

    // Base singletons
    for (let k = 0; k < K; k++) {
      const r = groups[k].repR;
      const bucket = Math.round(Math.log(r) / bucketStep);
      dp[strides[k]].set(bucket, {
        r,
        minA: 1,
        maxA: 1,
        balance: 1,
        op: 'L',
        groupIdx: k
      });
    }

    const counts = new Int32Array(K);
    const subA = new Int32Array(K);

    function insertEntry(map, entry) {
      const bucket = Math.round(Math.log(entry.r) / bucketStep);
      const prev = map.get(bucket);
      if (!prev || entry.balance > prev.balance) {
        map.set(bucket, entry);
      }
    }

    // Iterate all non-empty sub-multisets in ascending mixed-radix index order
    for (let idx = 1; idx < totalStates; idx++) {
      let rem = idx;
      let totalSize = 0;
      for (let k = 0; k < K; k++) {
        const c = Math.floor(rem / strides[k]);
        counts[k] = c;
        totalSize += c;
        rem -= c * strides[k];
      }
      if (totalSize <= 1) continue;

      const targetMap = dp[idx];

      // Enumerate sub-multisets A of idx via recursive helper over dimensions 0..K-1
      function enumPairs(dim, idxA) {
        if (dim === K) {
          if (idxA === 0 || idxA === idx) return;
          const idxB = idx - idxA;
          if (idxA > idxB) return;

          const mapA = dp[idxA];
          const mapB = dp[idxB];
          if (mapA.size === 0 || mapB.size === 0) return;

          const entriesA = Array.from(mapA.values());
          const entriesB = Array.from(mapB.values());

          for (let ia = 0; ia < entriesA.length; ia++) {
            const eA = entriesA[ia];
            for (let ib = 0; ib < entriesB.length; ib++) {
              const eB = entriesB[ib];

              // H-split
              const rH = eA.r + eB.r;
              if (rH <= 60 && rH >= 0.015) {
                const fA = eA.r / rH;
                const fB = eB.r / rH;
                const minA = Math.min(eA.minA * fA, eB.minA * fB);
                const maxA = Math.max(eA.maxA * fA, eB.maxA * fB);
                const bal = Math.sqrt(minA / maxA);
                if (bal >= minKeepBalance) {
                  insertEntry(targetMap, {
                    r: rH,
                    minA,
                    maxA,
                    balance: bal,
                    op: 'H',
                    idxA,
                    idxB,
                    eA,
                    eB
                  });
                }
              }

              // V-split
              const rV = (eA.r * eB.r) / (eA.r + eB.r);
              if (rV <= 60 && rV >= 0.015) {
                const fA = eB.r / (eA.r + eB.r);
                const fB = eA.r / (eA.r + eB.r);
                const minA = Math.min(eA.minA * fA, eB.minA * fB);
                const maxA = Math.max(eA.maxA * fA, eB.maxA * fB);
                const bal = Math.sqrt(minA / maxA);
                if (bal >= minKeepBalance) {
                  insertEntry(targetMap, {
                    r: rV,
                    minA,
                    maxA,
                    balance: bal,
                    op: 'V',
                    idxA,
                    idxB,
                    eA,
                    eB
                  });
                }
              }
            }
          }
          return;
        }

        const lim = counts[dim];
        const st = strides[dim];
        for (let a = 0; a <= lim; a++) {
          subA[dim] = a;
          enumPairs(dim + 1, idxA + a * st);
        }
      }

      enumPairs(0, 0);
    }

    const rootEntries = Array.from(dp[totalStates - 1].values());
    if (rootEntries.length === 0) return [];

    // Select top closest-to-targetR plus top high-balance candidates
    const byTarget = rootEntries
      .slice()
      .sort((a, b) => Math.min(b.r / targetR, targetR / b.r) - Math.min(a.r / targetR, targetR / a.r))
      .slice(0, 14);

    const byBalanced = rootEntries
      .slice()
      .sort(
        (a, b) =>
          Math.min(b.r / targetR, targetR / b.r) * Math.pow(b.balance, 0.7) -
          Math.min(a.r / targetR, targetR / a.r) * Math.pow(a.balance, 0.7)
      )
      .slice(0, 8);

    const picked = new Set([...byTarget, ...byBalanced]);

    // Reconstruct trees and assign concrete video items per group
    const trees = [];
    let leafCounter = 0;

    function buildAbstractTree(entry) {
      if (entry.op === 'L') {
        return { type: 'leaf', groupIdx: entry.groupIdx, tag: leafCounter++ };
      }
      return {
        type: entry.op,
        left: buildAbstractTree(entry.eA),
        right: buildAbstractTree(entry.eB)
      };
    }

    function materializeTree(absNode, groupQueues) {
      if (absNode.type === 'leaf') {
        const item = groupQueues[absNode.groupIdx].pop();
        return {
          type: 'leaf',
          id: item.id,
          r: item.r,
          isSpacer: Boolean(item.isSpacer)
        };
      }
      return {
        type: absNode.type,
        left: materializeTree(absNode.left, groupQueues),
        right: materializeTree(absNode.right, groupQueues)
      };
    }

    for (const entry of picked) {
      leafCounter = 0;
      const absTree = buildAbstractTree(entry);
      const queues = groups.map((g) => g.items.slice());
      trees.push(materializeTree(absTree, queues));
    }

    return trees;
  }

  /**
   * Assigns a single virtual spacer to the smallest-area matching leaf in a tree
   * so real videos occupy the largest slots.
   */
  function assignSpacerToSmallestLeaf(tree, spacerGroupItems, usableW, usableH, padX, padY, gap) {
    // Solve once with spacer marker still present on one arbitrary matching item to measure leaf areas
    const leafMap = new Map();
    const targetIds = new Set(spacerGroupItems.map((it) => it.id));

    function collectAndUnmark(node) {
      if (node.type === 'leaf') {
        leafMap.set(node.id, node);
        if (node.isSpacer) {
          node.isSpacer = false;
          return node;
        }
        return null;
      }
      const a = collectAndUnmark(node.left);
      const b = collectAndUnmark(node.right);
      return a || b;
    }

    const oldSpacerNode = collectAndUnmark(tree);
    if (!oldSpacerNode) return tree;

    const solved = solveTreeWithGap(tree, usableW, usableH, padX, padY, gap);
    if (!solved) {
      oldSpacerNode.isSpacer = true;
      return tree;
    }

    let smallestId = null;
    let smallestArea = Infinity;
    for (let i = 0; i < solved.rects.length; i++) {
      const rc = solved.rects[i];
      if (targetIds.has(rc.id)) {
        const area = rc.width * rc.height;
        if (area < smallestArea) {
          smallestArea = area;
          smallestId = rc.id;
        }
      }
    }

    const chosenNode = smallestId ? leafMap.get(smallestId) : oldSpacerNode;
    if (chosenNode && chosenNode !== oldSpacerNode) {
      // Swap IDs/r between oldSpacerNode and chosenNode so real video gets the bigger box
      const tmpId = chosenNode.id;
      const tmpR = chosenNode.r;
      chosenNode.id = oldSpacerNode.id;
      chosenNode.r = oldSpacerNode.r;
      oldSpacerNode.id = tmpId;
      oldSpacerNode.r = tmpR;
      chosenNode.isSpacer = true;
    } else {
      oldSpacerNode.isSpacer = true;
    }

    return tree;
  }

  /**
   * Order-preserving Interval DP for autoReorder === false and N <= 16.
   */
  function runIntervalDP(items, targetR) {
    const n = items.length;
    if (n <= 1 || n > 16) return [];

    const dp = Array.from({ length: n }, () => Array.from({ length: n }, () => new Map()));
    const bucketStep = 0.05;

    function insertEntry(map, entry) {
      const bucket = Math.round(Math.log(entry.r) / bucketStep);
      const prev = map.get(bucket);
      if (!prev || entry.balance > prev.balance) {
        map.set(bucket, entry);
      }
    }

    for (let i = 0; i < n; i++) {
      const r = items[i].r;
      insertEntry(dp[i][i], {
        r,
        minA: 1,
        maxA: 1,
        balance: 1,
        tree: makeLeaf(items[i])
      });
    }

    for (let len = 2; len <= n; len++) {
      for (let l = 0; l + len - 1 < n; l++) {
        const rIdx = l + len - 1;
        const targetMap = dp[l][rIdx];

        for (let m = l; m < rIdx; m++) {
          const leftEntries = Array.from(dp[l][m].values());
          const rightEntries = Array.from(dp[m + 1][rIdx].values());

          for (let ia = 0; ia < leftEntries.length; ia++) {
            const eA = leftEntries[ia];
            for (let ib = 0; ib < rightEntries.length; ib++) {
              const eB = rightEntries[ib];

              // H-split
              const rH = eA.r + eB.r;
              if (rH <= 60 && rH >= 0.015) {
                const fA = eA.r / rH;
                const fB = eB.r / rH;
                const minA = Math.min(eA.minA * fA, eB.minA * fB);
                const maxA = Math.max(eA.maxA * fA, eB.maxA * fB);
                const bal = Math.sqrt(minA / maxA);
                if (bal >= 0.22) {
                  insertEntry(targetMap, {
                    r: rH,
                    minA,
                    maxA,
                    balance: bal,
                    op: 'H',
                    eA,
                    eB
                  });
                }
              }

              // V-split
              const rV = (eA.r * eB.r) / (eA.r + eB.r);
              if (rV <= 60 && rV >= 0.015) {
                const fA = eB.r / (eA.r + eB.r);
                const fB = eA.r / (eA.r + eB.r);
                const minA = Math.min(eA.minA * fA, eB.minA * fB);
                const maxA = Math.max(eA.maxA * fA, eB.maxA * fB);
                const bal = Math.sqrt(minA / maxA);
                if (bal >= 0.22) {
                  insertEntry(targetMap, {
                    r: rV,
                    minA,
                    maxA,
                    balance: bal,
                    op: 'V',
                    eA,
                    eB
                  });
                }
              }
            }
          }
        }
      }
    }

    const rootEntries = Array.from(dp[0][n - 1].values());
    if (rootEntries.length === 0) return [];

    rootEntries.sort((a, b) => Math.min(b.r / targetR, targetR / b.r) - Math.min(a.r / targetR, targetR / a.r));
    const top = rootEntries.slice(0, 12);

    function toTree(entry) {
      if (entry.tree) return entry.tree;
      return { type: entry.op, left: toTree(entry.eA), right: toTree(entry.eB) };
    }
    return top.map(toTree);
  }

  /**
   * Strategy B: Exact Subset DP (for autoReorder=true) and Interval DP (for autoReorder=false).
   */
  function runStrategyB(items, usableW, usableH, padX, padY, options, registerCandidate, getBestCoverage) {
    const n = items.length;
    const targetR = usableW / usableH;
    const minBalanceFloor = options.mode === 'balanced' ? 0.5 : 0.22;

    if (!options.autoReorder) {
      if (n <= 16) {
        const trees = runIntervalDP(items, targetR);
        for (let i = 0; i < trees.length; i++) {
          const solved = solveTreeWithGap(trees[i], usableW, usableH, padX, padY, options.gap);
          if (solved) registerCandidate(solved, trees[i], 'interval-dp', false);
        }
      }
      return;
    }

    let groups = buildRatioGroups(items, 3);
    let msCount = countMultisets(groups);
    if (msCount > 210) {
      groups = buildRatioGroups(items, 2);
      msCount = countMultisets(groups);
    }

    if (n <= 16 && msCount <= 210) {
      const trees = runSubsetDP(groups, targetR, minBalanceFloor);
      for (let i = 0; i < trees.length; i++) {
        const solved = solveTreeWithGap(trees[i], usableW, usableH, padX, padY, options.gap);
        if (solved) registerCandidate(solved, trees[i], 'subset-dp', false);
      }

      // 1-Virtual-Spacer Enhancement in max-fill mode when tight coverage < 0.94
      if (options.mode === 'max-fill' && n >= 3 && n <= 12 && getBestCoverage() < 0.94) {
        // Pick candidate spacer ratio(s): largest group ratio (and median if diverse)
        const sortedByCount = groups.slice().sort((a, b) => b.items.length - a.items.length);
        const spacerRatios = [sortedByCount[0].repR];
        if (sortedByCount.length > 1) {
          const medianItem = items.slice().sort((a, b) => a.r - b.r)[Math.floor(n / 2)];
          if (Math.abs(medianItem.r - spacerRatios[0]) > 0.05) {
            spacerRatios.push(medianItem.r);
          }
        }

        for (let si = 0; si < spacerRatios.length; si++) {
          const spR = spacerRatios[si];
          const withSpacer = items.concat([{ id: '__spacer__', r: spR, isSpacer: true }]);
          let spGroups = buildRatioGroups(withSpacer, 2);
          if (countMultisets(spGroups) > 220) continue;

          const spTrees = runSubsetDP(spGroups, targetR, minBalanceFloor);
          for (let ti = 0; ti < spTrees.length; ti++) {
            const matchedGrp = spGroups.find((g) => g.items.some((it) => it.isSpacer));
            const fixedTree = matchedGrp
              ? assignSpacerToSmallestLeaf(spTrees[ti], matchedGrp.items, usableW, usableH, padX, padY, options.gap)
              : spTrees[ti];
            const solved = solveTreeWithGap(fixedTree, usableW, usableH, padX, padY, options.gap);
            if (solved) registerCandidate(solved, fixedTree, 'subset-dp-spacer', true);
          }
        }
      }
    }
  }

  /**
   * Recursive Target-Ratio BSP solver (scales cleanly to N=100+).
   */
  const smallDpMemo = new Map();

  function solveSmallWithMemo(slice, targetR) {
    if (slice.length === 1) {
      return { tree: makeLeaf(slice[0]), r: slice[0].r, minA: 1, maxA: 1, balance: 1 };
    }
    if (slice.length === 2) {
      const a = slice[0];
      const b = slice[1];
      const rH = a.r + b.r;
      const rV = (a.r * b.r) / (a.r + b.r);
      const errH = Math.min(rH / targetR, targetR / rH);
      const errV = Math.min(rV / targetR, targetR / rV);
      if (errH >= errV) {
        const fA = a.r / rH;
        const fB = b.r / rH;
        const minA = Math.min(fA, fB);
        const maxA = Math.max(fA, fB);
        return {
          tree: { type: 'H', left: makeLeaf(a), right: makeLeaf(b) },
          r: rH,
          minA,
          maxA,
          balance: Math.sqrt(minA / maxA)
        };
      }
      const fA = b.r / (a.r + b.r);
      const fB = a.r / (a.r + b.r);
      const minA = Math.min(fA, fB);
      const maxA = Math.max(fA, fB);
      return {
        tree: { type: 'V', left: makeLeaf(a), right: makeLeaf(b) },
        r: rV,
        minA,
        maxA,
        balance: Math.sqrt(minA / maxA)
      };
    }

    const groups = buildRatioGroups(slice, 2);
    const sig = groups.map((g) => g.repR.toFixed(2) + 'x' + g.items.length).join('|');
    let rootEntries = smallDpMemo.get(sig);
    if (!rootEntries) {
      if (smallDpMemo.size > 400) smallDpMemo.clear();
      // Run compact DP and cache root entries as abstract trees
      const K = groups.length;
      const maxC = new Int32Array(K);
      const strides = new Int32Array(K);
      let totalStates = 1;
      for (let k = K - 1; k >= 0; k--) {
        maxC[k] = groups[k].items.length;
        strides[k] = totalStates;
        totalStates *= maxC[k] + 1;
      }
      const dp = Array.from({ length: totalStates }, () => new Map());
      for (let k = 0; k < K; k++) {
        const r = groups[k].repR;
        dp[strides[k]].set(Math.round(Math.log(r) / 0.06), { r, minA: 1, maxA: 1, balance: 1, op: 'L', k });
      }
      const counts = new Int32Array(K);
      const subA = new Int32Array(K);
      for (let idx = 1; idx < totalStates; idx++) {
        let rem = idx;
        let sz = 0;
        for (let k = 0; k < K; k++) {
          const c = Math.floor(rem / strides[k]);
          counts[k] = c;
          sz += c;
          rem -= c * strides[k];
        }
        if (sz <= 1) continue;
        const map = dp[idx];
        function enumP(d, idxA) {
          if (d === K) {
            if (idxA === 0 || idxA === idx) return;
            const idxB = idx - idxA;
            if (idxA > idxB) return;
            const eAs = Array.from(dp[idxA].values());
            const eBs = Array.from(dp[idxB].values());
            for (let ia = 0; ia < eAs.length; ia++) {
              const eA = eAs[ia];
              for (let ib = 0; ib < eBs.length; ib++) {
                const eB = eBs[ib];
                const rH = eA.r + eB.r;
                if (rH <= 50 && rH >= 0.02) {
                  const minA = Math.min(eA.minA * (eA.r / rH), eB.minA * (eB.r / rH));
                  const maxA = Math.max(eA.maxA * (eA.r / rH), eB.maxA * (eB.r / rH));
                  const bal = Math.sqrt(minA / maxA);
                  if (bal >= 0.25) {
                    const bk = Math.round(Math.log(rH) / 0.06);
                    const p = map.get(bk);
                    if (!p || bal > p.balance) map.set(bk, { r: rH, minA, maxA, balance: bal, op: 'H', eA, eB });
                  }
                }
                const rV = (eA.r * eB.r) / (eA.r + eB.r);
                if (rV <= 50 && rV >= 0.02) {
                  const minA = Math.min(eA.minA * (eB.r / (eA.r + eB.r)), eB.minA * (eA.r / (eA.r + eB.r)));
                  const maxA = Math.max(eA.maxA * (eB.r / (eA.r + eB.r)), eB.maxA * (eA.r / (eA.r + eB.r)));
                  const bal = Math.sqrt(minA / maxA);
                  if (bal >= 0.25) {
                    const bk = Math.round(Math.log(rV) / 0.06);
                    const p = map.get(bk);
                    if (!p || bal > p.balance) map.set(bk, { r: rV, minA, maxA, balance: bal, op: 'V', eA, eB });
                  }
                }
              }
            }
            return;
          }
          const lim = counts[d];
          const st = strides[d];
          for (let a = 0; a <= lim; a++) {
            subA[d] = a;
            enumP(d + 1, idxA + a * st);
          }
        }
        enumP(0, 0);
      }
      rootEntries = Array.from(dp[totalStates - 1].values());
      smallDpMemo.set(sig, rootEntries);
    }

    if (!rootEntries || rootEntries.length === 0) {
      return { tree: buildChainTree(slice.map(makeLeaf), targetR >= 1 ? 'H' : 'V'), r: slice[0].r, minA: 1 / slice.length, maxA: 1 / slice.length, balance: 1 };
    }

    let best = rootEntries[0];
    let bestFit = -Infinity;
    for (let i = 0; i < rootEntries.length; i++) {
      const e = rootEntries[i];
      const fit = Math.min(e.r / targetR, targetR / e.r) * (0.88 + 0.12 * e.balance);
      if (fit > bestFit) {
        bestFit = fit;
        best = e;
      }
    }

    const queues = groups.map((g) => g.items.slice());
    function mat(e) {
      if (e.op === 'L') {
        const item = queues[e.k].pop();
        return makeLeaf(item);
      }
      return { type: e.op, left: mat(e.eA), right: mat(e.eB) };
    }

    return {
      tree: mat(best),
      r: best.r,
      minA: best.minA,
      maxA: best.maxA,
      balance: best.balance
    };
  }

  function buildBSPTree(slice, targetR, autoReorder, depth = 0) {
    const n = slice.length;
    if (n === 1) {
      return { tree: makeLeaf(slice[0]), r: slice[0].r, minA: 1, maxA: 1, balance: 1 };
    }
    if (autoReorder && n <= 5) {
      return solveSmallWithMemo(slice, targetR);
    }
    if (!autoReorder && n <= 6) {
      const trees = runIntervalDP(slice, targetR);
      if (trees.length > 0) {
        const aff = computeAffineTree(trees[0], 0);
        return { tree: trees[0], r: aff.a, minA: 1 / n, maxA: 1 / n, balance: 1 };
      }
    }

    const splitFracs = depth === 0 ? [0.5, 0.35, 0.65] : [0.5];
    const candidateSplits = [];

    for (let fi = 0; fi < splitFracs.length; fi++) {
      const p = splitFracs[fi];
      const cut = clamp(Math.round(n * p), 1, n - 1);
      candidateSplits.push({
        left: slice.slice(0, cut),
        right: slice.slice(cut),
        p: cut / n
      });
    }

    if (autoReorder && depth === 0) {
      // Also test splitting portrait (<1) from landscape (>=1) when mixed
      const portrait = [];
      const landscape = [];
      for (let i = 0; i < n; i++) {
        if (slice[i].r < 0.98) portrait.push(slice[i]);
        else landscape.push(slice[i]);
      }
      if (portrait.length > 0 && landscape.length > 0) {
        candidateSplits.push({
          left: portrait,
          right: landscape,
          p: portrait.length / n
        });
      }
    }

    let bestResult = null;
    let bestScore = -Infinity;

    const tryH = depth <= 1 || targetR >= 0.85;
    const tryV = depth <= 1 || targetR <= 1.18;

    for (let si = 0; si < candidateSplits.length; si++) {
      const sp = candidateSplits[si];
      const p = sp.p;

      // H-split
      if (tryH) {
        const resHL = buildBSPTree(sp.left, p * targetR, autoReorder, depth + 1);
        const resHR = buildBSPTree(sp.right, (1 - p) * targetR, autoReorder, depth + 1);
        const rH = resHL.r + resHR.r;
        const fHL = resHL.r / rH;
        const fHR = resHR.r / rH;
        const minAH = Math.min(resHL.minA * fHL, resHR.minA * fHR);
        const maxAH = Math.max(resHL.maxA * fHL, resHR.maxA * fHR);
        const balH = Math.sqrt(minAH / maxAH);
        const fitH = Math.min(rH / targetR, targetR / rH) * (balH < 0.35 ? Math.pow(balH / 0.35, 2) : 1);

        if (fitH > bestScore) {
          bestScore = fitH;
          bestResult = {
            tree: { type: 'H', left: resHL.tree, right: resHR.tree },
            r: rH,
            minA: minAH,
            maxA: maxAH,
            balance: balH
          };
        }
      }

      // V-split
      if (tryV) {
        const resVL = buildBSPTree(sp.left, targetR / p, autoReorder, depth + 1);
        const resVR = buildBSPTree(sp.right, targetR / (1 - p), autoReorder, depth + 1);
        const rV = (resVL.r * resVR.r) / (resVL.r + resVR.r);
        const fVL = resVR.r / (resVL.r + resVR.r);
        const fVR = resVL.r / (resVL.r + resVR.r);
        const minAV = Math.min(resVL.minA * fVL, resVR.minA * fVR);
        const maxAV = Math.max(resVL.maxA * fVL, resVR.maxA * fVR);
        const balV = Math.sqrt(minAV / maxAV);
        const fitV = Math.min(rV / targetR, targetR / rV) * (balV < 0.35 ? Math.pow(balV / 0.35, 2) : 1);

        if (fitV > bestScore) {
          bestScore = fitV;
          bestResult = {
            tree: { type: 'V', left: resVL.tree, right: resVR.tree },
            r: rV,
            minA: minAV,
            maxA: maxAV,
            balance: balV
          };
        }
      }
    }

    return bestResult;
  }

  /**
   * Strategy C: Recursive Target-Ratio BSP across multiple item orderings.
   */
  function runStrategyC(items, usableW, usableH, padX, padY, options, registerCandidate) {
    const targetR = usableW / usableH;
    const orderings = [{ name: 'orig', list: items }];

    if (options.autoReorder && items.length > 2) {
      const asc = items.slice().sort((a, b) => a.r - b.r);
      const desc = asc.slice().reverse();
      const interleaved = [];
      let l = 0;
      let r = asc.length - 1;
      while (l <= r) {
        interleaved.push(desc[l]);
        if (l !== r) interleaved.push(desc[r]);
        l++;
        r--;
      }
      orderings.push({ name: 'asc', list: asc });
      orderings.push({ name: 'desc', list: desc });
      orderings.push({ name: 'interleave', list: interleaved });
    }

    for (let oi = 0; oi < orderings.length; oi++) {
      const ord = orderings[oi];
      const res = buildBSPTree(ord.list, targetR, options.autoReorder);
      if (res && res.tree) {
        const solved = solveTreeWithGap(res.tree, usableW, usableH, padX, padY, options.gap);
        if (solved) registerCandidate(solved, res.tree, 'bsp-' + ord.name, false);
      }
    }
  }

  function cloneTree(node) {
    if (node.type === 'leaf') {
      return { type: 'leaf', id: node.id, r: node.r, isSpacer: node.isSpacer };
    }
    return {
      type: node.type,
      left: cloneTree(node.left),
      right: cloneTree(node.right)
    };
  }

  function collectTreeNodes(node, internals, leaves) {
    if (node.type === 'leaf') {
      leaves.push(node);
      return;
    }
    internals.push(node);
    collectTreeNodes(node.left, internals, leaves);
    collectTreeNodes(node.right, internals, leaves);
  }

  /**
   * Strategy D: Deterministic local tree refinement on top slicing trees.
   */
  function runStrategyD(topTreeCandidates, usableW, usableH, padX, padY, usableArea, containerArea, options, registerCandidate) {
    const maxIters = topTreeCandidates.length > 0 && topTreeCandidates[0].rects.length > 30 ? 30 : 100;

    for (let ci = 0; ci < topTreeCandidates.length; ci++) {
      const base = topTreeCandidates[ci];
      if (!base.tree) continue;

      let curTree = cloneTree(base.tree);
      let curScore = base.score;
      let evals = 0;

      const internals = [];
      const leaves = [];
      collectTreeNodes(curTree, internals, leaves);

      // Deterministic flip H <-> V pass
      for (let i = 0; i < internals.length && evals < maxIters; i++) {
        const node = internals[i];
        const oldType = node.type;
        node.type = oldType === 'H' ? 'V' : 'H';
        evals++;
        const solved = solveTreeWithGap(curTree, usableW, usableH, padX, padY, options.gap);
        if (solved) {
          const scored = scoreCandidate(solved, usableArea, containerArea, options, { hasSpacer: base.hasSpacer });
          if (scored.score > curScore + 1e-7) {
            curScore = scored.score;
            registerCandidate(solved, cloneTree(curTree), base.strategy + '+flip', base.hasSpacer);
          } else {
            node.type = oldType;
          }
        } else {
          node.type = oldType;
        }
      }

      // Deterministic leaf swap pass when autoReorder is ON and ratios differ
      if (options.autoReorder && leaves.length >= 2 && leaves.length <= 30) {
        let swapped = true;
        let pass = 0;
        while (swapped && pass < 2 && evals < maxIters) {
          swapped = false;
          pass++;
          for (let i = 0; i < leaves.length && evals < maxIters; i++) {
            for (let j = i + 1; j < leaves.length && evals < maxIters; j++) {
              const a = leaves[i];
              const b = leaves[j];
              if (Math.abs(a.r - b.r) < 1e-4 && Boolean(a.isSpacer) === Boolean(b.isSpacer)) continue;

              const tmpId = a.id;
              const tmpR = a.r;
              const tmpSp = a.isSpacer;
              a.id = b.id;
              a.r = b.r;
              a.isSpacer = b.isSpacer;
              b.id = tmpId;
              b.r = tmpR;
              b.isSpacer = tmpSp;

              evals++;
              const solved = solveTreeWithGap(curTree, usableW, usableH, padX, padY, options.gap);
              if (solved) {
                const scored = scoreCandidate(solved, usableArea, containerArea, options, { hasSpacer: base.hasSpacer });
                if (scored.score > curScore + 1e-7) {
                  curScore = scored.score;
                  swapped = true;
                  registerCandidate(solved, cloneTree(curTree), base.strategy + '+swap', base.hasSpacer);
                  continue;
                }
              }

              // Revert
              b.id = a.id;
              b.r = a.r;
              b.isSpacer = a.isSpacer;
              a.id = tmpId;
              a.r = tmpR;
              a.isSpacer = tmpSp;
            }
          }
        }
      }
    }
  }

  /**
   * Strategy E: Focus / Spotlight Mode.
   */
  function runStrategyE(items, usableW, usableH, padX, padY, options, registerCandidate) {
    const focusIdx = items.findIndex((it) => it.id === options.focusId);
    const focusItem = focusIdx >= 0 ? items[focusIdx] : items[0];
    const rest = items.filter((it) => it.id !== focusItem.id);
    const focusLeaf = makeLeaf(focusItem);
    const targetR = usableW / usableH;

    if (rest.length === 0) {
      const solved = solveTreeWithGap(focusLeaf, usableW, usableH, padX, padY, options.gap);
      if (solved) registerCandidate(solved, focusLeaf, 'focus-single', false);
      return;
    }

    const focusOptions = { ...options, focusId: focusItem.id };

    function packSlice(slice, sliceTargetR) {
      if (slice.length === 1) return makeLeaf(slice[0]);
      if (slice.length <= 5 && options.autoReorder) {
        return solveSmallWithMemo(slice, sliceTargetR).tree;
      }
      return buildBSPTree(slice, sliceTargetR, options.autoReorder).tree;
    }

    // 1. Right / Left strip: focus | pack(rest)
    const sideTargets = [0.25, 0.4, 0.6, 0.85, 1.2];
    for (let i = 0; i < sideTargets.length; i++) {
      const stripTree = packSlice(rest, sideTargets[i] * targetR);
      const tRight = { type: 'H', left: makeLeaf(focusItem), right: stripTree };
      const sRight = solveTreeWithGap(tRight, usableW, usableH, padX, padY, options.gap);
      if (sRight) registerCandidate(sRight, tRight, 'focus-right', false, focusOptions);

      if (options.autoReorder) {
        const tLeft = { type: 'H', left: stripTree, right: makeLeaf(focusItem) };
        const sLeft = solveTreeWithGap(tLeft, usableW, usableH, padX, padY, options.gap);
        if (sLeft) registerCandidate(sLeft, tLeft, 'focus-left', false, focusOptions);
      }
    }

    // 2. Bottom / Top strip: focus / pack(rest)
    const bottomTargets = [1.2, 1.8, 2.6, 3.8, 5.5];
    for (let i = 0; i < bottomTargets.length; i++) {
      const stripTree = packSlice(rest, bottomTargets[i] * targetR);
      const tBottom = { type: 'V', left: makeLeaf(focusItem), right: stripTree };
      const sBottom = solveTreeWithGap(tBottom, usableW, usableH, padX, padY, options.gap);
      if (sBottom) registerCandidate(sBottom, tBottom, 'focus-bottom', false, focusOptions);
    }

    // 3. L-wrap when rest.length >= 3
    if (rest.length >= 3) {
      const orderedRest = options.autoReorder ? rest.slice().sort((a, b) => a.r - b.r) : rest;
      const fracs = [0.35, 0.5, 0.65];
      for (let fi = 0; fi < fracs.length; fi++) {
        const cut = clamp(Math.round(orderedRest.length * fracs[fi]), 1, orderedRest.length - 1);
        const partA = orderedRest.slice(0, cut);
        const partB = orderedRest.slice(cut);

        const rightSub = packSlice(partA, 0.55 * targetR);
        const bottomSub = packSlice(partB, 2.5 * targetR);
        const lTree1 = {
          type: 'V',
          left: { type: 'H', left: makeLeaf(focusItem), right: rightSub },
          right: bottomSub
        };
        const sL1 = solveTreeWithGap(lTree1, usableW, usableH, padX, padY, options.gap);
        if (sL1) registerCandidate(sL1, lTree1, 'focus-L1', false, focusOptions);

        const bottomSub2 = packSlice(partA, 1.8 * targetR);
        const rightSub2 = packSlice(partB, 0.55 * targetR);
        const lTree2 = {
          type: 'H',
          left: { type: 'V', left: makeLeaf(focusItem), right: bottomSub2 },
          right: rightSub2
        };
        const sL2 = solveTreeWithGap(lTree2, usableW, usableH, padX, padY, options.gap);
        if (sL2) registerCandidate(sL2, lTree2, 'focus-L2', false, focusOptions);
      }
    }
  }

  /**
   * Main entry point: computeLayout(videos, container, options)
   */
  function computeLayout(videos, container, rawOptions) {
    const startMs = typeof performance !== 'undefined' ? performance.now() : Date.now();

    const containerW = Math.max(0, Number(container && container.width) || 0);
    const containerH = Math.max(0, Number(container && container.height) || 0);
    const containerArea = containerW * containerH;

    const opts = Object.assign(
      {
        mode: 'max-fill',
        gap: 4,
        padding: 8,
        balance: 0.25,
        autoReorder: true,
        focusId: null
      },
      rawOptions || {}
    );

    if (!Array.isArray(videos) || videos.length === 0 || containerW <= 0 || containerH <= 0) {
      const endMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return {
        rects: [],
        stats: {
          coverage: 0,
          usableCoverage: 0,
          totalVideoArea: 0,
          containerArea,
          usableArea: 0,
          minLinearRatio: 1,
          strategy: 'empty',
          computeMs: endMs - startMs,
          effectiveGap: 0
        }
      };
    }

    const padX = Math.min(Math.max(0, opts.padding), Math.max(0, (containerW - 4) * 0.5));
    const padY = Math.min(Math.max(0, opts.padding), Math.max(0, (containerH - 4) * 0.5));
    const usableW = Math.max(1, containerW - 2 * padX);
    const usableH = Math.max(1, containerH - 2 * padY);
    const usableArea = usableW * usableH;

    const items = videos.map((v, i) => ({
      id: v && v.id !== undefined ? v.id : 'video-' + i,
      r: sanitizeAspectRatio(v ? v.aspectRatio : 16 / 9),
      isSpacer: false
    }));

    // Fast path for N === 1
    if (items.length === 1) {
      const item = items[0];
      const h = Math.min(usableH, usableW / item.r);
      const w = item.r * h;
      const x = padX + Math.max(0, (usableW - w) * 0.5);
      const y = padY + Math.max(0, (usableH - h) * 0.5);
      const area = w * h;
      const endMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return {
        rects: [
          {
            id: item.id,
            x,
            y,
            width: w,
            height: h,
            aspectRatio: item.r,
            area,
            areaShare: 1
          }
        ],
        stats: {
          coverage: containerArea > 0 ? area / containerArea : 0,
          usableCoverage: usableArea > 0 ? area / usableArea : 0,
          totalVideoArea: area,
          containerArea,
          usableArea,
          minLinearRatio: 1,
          strategy: 'single',
          computeMs: endMs - startMs,
          effectiveGap: 0
        }
      };
    }

    let bestCandidate = null;
    const topTreeCandidates = [];

    function registerCandidate(solved, tree, strategy, hasSpacer, overrideOpts) {
      if (!solved || !solved.rects || solved.rects.length !== items.length) return;
      const evalOpts = overrideOpts || opts;
      const scored = scoreCandidate(solved, usableArea, containerArea, evalOpts, { hasSpacer });
      const candidate = {
        rects: solved.rects,
        effectiveGap: solved.effectiveGap,
        tree,
        strategy,
        hasSpacer: Boolean(hasSpacer),
        score: scored.score,
        coverage: scored.coverage,
        usableCoverage: scored.usableCoverage,
        totalVideoArea: scored.totalVideoArea,
        minLinearRatio: scored.minLinearRatio
      };

      if (!bestCandidate || candidate.score > bestCandidate.score) {
        bestCandidate = candidate;
      }

      if (tree) {
        topTreeCandidates.push(candidate);
        if (topTreeCandidates.length > 12) {
          topTreeCandidates.sort((a, b) => b.score - a.score);
          topTreeCandidates.length = 3;
        }
      }
    }

    if (opts.mode === 'focus') {
      const focusTargetId =
        opts.focusId !== null && items.some((it) => it.id === opts.focusId) ? opts.focusId : items[0].id;
      const focusOpts = Object.assign({}, opts, { focusId: focusTargetId });
      runStrategyE(items, usableW, usableH, padX, padY, focusOpts, registerCandidate);
    } else {
      runStrategyA(items, usableW, usableH, padX, padY, usableArea, containerArea, opts, registerCandidate);
      runStrategyB(
        items,
        usableW,
        usableH,
        padX,
        padY,
        opts,
        registerCandidate,
        () => (bestCandidate ? bestCandidate.usableCoverage : 0)
      );
      runStrategyC(items, usableW, usableH, padX, padY, opts, registerCandidate);

      topTreeCandidates.sort((a, b) => b.score - a.score);
      runStrategyD(
        topTreeCandidates.slice(0, 3),
        usableW,
        usableH,
        padX,
        padY,
        usableArea,
        containerArea,
        opts,
        registerCandidate
      );
    }

    // Fallback safety: if nothing registered yet, build single balanced row/col chain
    if (!bestCandidate) {
      const fallbackTree = buildChainTree(items.map(makeLeaf), usableW >= usableH ? 'H' : 'V');
      const solved = solveTreeWithGap(fallbackTree, usableW, usableH, padX, padY, 0);
      if (solved) {
        registerCandidate(solved, fallbackTree, 'fallback-chain', false);
      }
    }

    const totalArea = bestCandidate ? bestCandidate.totalVideoArea : 0;
    const outRects = bestCandidate
      ? bestCandidate.rects.map((rc) => {
          const area = rc.width * rc.height;
          return {
            id: rc.id,
            x: rc.x,
            y: rc.y,
            width: rc.width,
            height: rc.height,
            aspectRatio: rc.aspectRatio,
            area,
            areaShare: totalArea > 0 ? area / totalArea : 0
          };
        })
      : [];

    const endMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      rects: outRects,
      stats: {
        coverage: bestCandidate ? bestCandidate.coverage : 0,
        usableCoverage: bestCandidate ? bestCandidate.usableCoverage : 0,
        totalVideoArea: totalArea,
        containerArea,
        usableArea,
        minLinearRatio: bestCandidate ? bestCandidate.minLinearRatio : 1,
        strategy: bestCandidate ? bestCandidate.strategy : 'none',
        computeMs: endMs - startMs,
        effectiveGap: bestCandidate ? bestCandidate.effectiveGap : 0
      }
    };
  }

  const LayoutEngine = {
    computeLayout,
    solveTreeWithGap,
    solveEqualHeightRows,
    solveEqualWidthCols,
    scoreCandidate,
    sanitizeAspectRatio
  };

  root.LayoutEngine = LayoutEngine;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LayoutEngine;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
