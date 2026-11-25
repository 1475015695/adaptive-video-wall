/**
 * Procedural Live Demo Video Stream Generator
 *
 * Generates real 30fps <video> streams via <canvas>.captureStream(30) with exact
 * aspect ratios, animated light orbs, a perfect geometric reference circle
 * (proving zero aspect-ratio distortion), and live timecode telemetry.
 */
(function (root) {
  'use strict';

  const PRESETS = {
    '16:9': { label: '16:9', w: 640, h: 360, ratio: 16 / 9 },
    '9:16': { label: '9:16', w: 360, h: 640, ratio: 9 / 16 },
    '4:3': { label: '4:3', w: 640, h: 480, ratio: 4 / 3 },
    '3:4': { label: '3:4', w: 480, h: 640, ratio: 3 / 4 },
    '1:1': { label: '1:1', w: 512, h: 512, ratio: 1 },
    '21:9': { label: '21:9', w: 756, h: 324, ratio: 21 / 9 },
    '2:3': { label: '2:3', w: 420, h: 630, ratio: 2 / 3 }
  };

  const PALETTES = [
    ['#0d1b2a', '#1b263b', '#38bdf8', '#818cf8'],
    ['#1e112a', '#2e1640', '#f472b6', '#c084fc'],
    ['#0a221d', '#11352d', '#34d399', '#22d3ee'],
    ['#27170b', '#3d210f', '#fb923c', '#facc15'],
    ['#181b2e', '#262b47', '#60a5fa', '#2dd4bf'],
    ['#250f19', '#3b1525', '#fb7185', '#f97316'],
    ['#101d2c', '#182c42', '#a78bfa', '#38bdf8'],
    ['#162013', '#22331d', '#a3e635', '#34d399']
  ];

  function formatClock(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const tenths = Math.floor((seconds * 10) % 10);
    return (
      String(mins).padStart(2, '0') +
      ':' +
      String(secs).padStart(2, '0') +
      '.' +
      String(tenths)
    );
  }

  function createDemoVideoSource(options) {
    const opts = options || {};
    const presetKey = PRESETS[opts.aspectPreset] ? opts.aspectPreset : '16:9';
    const preset = PRESETS[presetKey];
    const index = Number.isFinite(opts.index) ? opts.index : 0;
    const palette = PALETTES[Math.abs(index) % PALETTES.length];
    const title = opts.label || '演示画面 ' + (index + 1);

    const canvas = document.createElement('canvas');
    canvas.width = preset.w;
    canvas.height = preset.h;
    const ctx = canvas.getContext('2d');

    let rafId = 0;
    let lastTs = 0;
    let elapsed = (index * 1.7) % 12;
    let paused = false;
    let playbackRate = 1;
    let destroyed = false;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.loop = true;

    let stream = null;
    let usesFallbackCanvas = false;

    function drawFrame(dt) {
      if (!ctx) return;
      if (!paused) {
        elapsed += dt * playbackRate;
      }

      const w = canvas.width;
      const h = canvas.height;
      const minSide = Math.min(w, h);

      // Rich radial/linear backdrop
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, palette[0]);
      grad.addColorStop(1, palette[1]);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Orbiting soft glow orbs
      for (let i = 0; i < 3; i++) {
        const angle = elapsed * (0.45 + i * 0.22) + i * 2.1;
        const cx = w * 0.5 + Math.cos(angle) * w * 0.28;
        const cy = h * 0.5 + Math.sin(angle * 1.15) * h * 0.26;
        const radius = minSide * (0.34 - i * 0.06);
        const orbGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        orbGrad.addColorStop(0, (i % 2 === 0 ? palette[2] : palette[3]) + '44');
        orbGrad.addColorStop(1, 'transparent');
        ctx.fillStyle = orbGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      // Subtle architectural grid
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      const step = Math.max(32, Math.round(minSide / 8));
      ctx.beginPath();
      for (let gx = (w % step) / 2; gx < w; gx += step) {
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, h);
      }
      for (let gy = (h % step) / 2; gy < h; gy += step) {
        ctx.moveTo(0, gy);
        ctx.lineTo(w, gy);
      }
      ctx.stroke();

      // Perfect geometric reference circle & rotating sweep (proves 0% distortion)
      const cx = w * 0.5;
      const cy = h * 0.5;
      const ringR = minSide * 0.26;

      ctx.save();
      ctx.strokeStyle = palette[2] + 'aa';
      ctx.lineWidth = Math.max(2, minSide * 0.006);
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR * 0.68, 0, Math.PI * 2);
      ctx.moveTo(cx - ringR * 1.18, cy);
      ctx.lineTo(cx + ringR * 1.18, cy);
      ctx.moveTo(cx, cy - ringR * 1.18);
      ctx.lineTo(cx, cy + ringR * 1.18);
      ctx.stroke();

      // Orbiting dot on circle perimeter
      const sweepAngle = elapsed * 1.8;
      const dx = cx + Math.cos(sweepAngle) * ringR;
      const dy = cy + Math.sin(sweepAngle) * ringR;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(dx, dy, Math.max(4, minSide * 0.015), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Crisp corner brackets
      const pad = Math.round(minSide * 0.045);
      const arm = Math.round(minSide * 0.075);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      // Top-left
      ctx.moveTo(pad, pad + arm);
      ctx.lineTo(pad, pad);
      ctx.lineTo(pad + arm, pad);
      // Top-right
      ctx.moveTo(w - pad - arm, pad);
      ctx.lineTo(w - pad, pad);
      ctx.lineTo(w - pad, pad + arm);
      // Bottom-left
      ctx.moveTo(pad, h - pad - arm);
      ctx.lineTo(pad, h - pad);
      ctx.lineTo(pad + arm, h - pad);
      // Bottom-right
      ctx.moveTo(w - pad - arm, h - pad);
      ctx.lineTo(w - pad, h - pad);
      ctx.lineTo(w - pad, h - pad - arm);
      ctx.stroke();

      // Monospace HUD inside frame
      const fontSize = Math.max(13, Math.round(minSide * 0.048));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = '600 ' + fontSize + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(preset.label, cx, cy - fontSize * 0.55);

      ctx.fillStyle = palette[2];
      ctx.font = '500 ' + Math.round(fontSize * 0.78) + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(formatClock(elapsed), cx, cy + fontSize * 0.58);

      // Subtle footer badge
      const smallFont = Math.max(11, Math.round(minSide * 0.033));
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.68)';
      ctx.font = '500 ' + smallFont + 'px system-ui, -apple-system, sans-serif';
      ctx.fillText(title, pad + 6, h - pad - smallFont * 0.7);

      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.52)';
      ctx.font = '500 ' + smallFont + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(w + '×' + h, w - pad - 6, h - pad - smallFont * 0.7);
    }

    function tick(ts) {
      if (destroyed) return;
      const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 1 / 30;
      lastTs = ts;
      drawFrame(dt);
      rafId = requestAnimationFrame(tick);
    }

    // Draw initial frame before captureStream so dimensions & pixels are ready immediately
    drawFrame(0);
    rafId = requestAnimationFrame(tick);

    if (typeof canvas.captureStream === 'function') {
      try {
        stream = canvas.captureStream(30);
        video.srcObject = stream;
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_err) {
        usesFallbackCanvas = true;
      }
    } else {
      usesFallbackCanvas = true;
    }

    return {
      element: usesFallbackCanvas ? canvas : video,
      videoElement: usesFallbackCanvas ? null : video,
      canvas,
      usesFallbackCanvas,
      aspectRatio: preset.ratio,
      presetLabel: preset.label,
      isPaused: () => paused,
      play: () => {
        paused = false;
        if (video.srcObject && video.paused) {
          const p = video.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      },
      pause: () => {
        paused = true;
        if (video.srcObject && !video.paused) {
          video.pause();
        }
      },
      setRate: (rate) => {
        playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
      },
      restart: () => {
        elapsed = 0;
        drawFrame(0);
      },
      destroy: () => {
        destroyed = true;
        if (rafId) cancelAnimationFrame(rafId);
        if (stream) {
          stream.getTracks().forEach((t) => t.stop());
          stream = null;
        }
        video.srcObject = null;
      }
    };
  }

  root.DemoStream = {
    PRESETS,
    createDemoVideoSource
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
