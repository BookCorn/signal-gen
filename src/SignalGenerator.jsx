import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  Play, Pause, Plus, Trash2, Download, Activity, Zap, Waves,
  Sun, Moon, RotateCcw, Eye, EyeOff, Sigma, LayoutGrid, Gauge,
  Table, AlertTriangle
} from "lucide-react";

/* =====================================================================
   教学级信号发生器 App —— 前端实现 (对标 Keysight 33500B)
   功能点对照: #1 三相预设 #2 FFT #3 李萨如 #4 波形运算 #5 时域标注
   #6 输入验证 #7 单位切换 #8 参数表 #9 颜色自定义 #10 动态播放
   #11 暗色主题 #12 数据导出
   ===================================================================== */

const N = 2048; // 采样点数 (FFT 用, 2 的幂)
const TWO_PI = Math.PI * 2;

const WAVE_TYPES = [
  { id: "sine", label: "正弦" },
  { id: "cosine", label: "余弦" },
  { id: "tangent", label: "正切" },
  { id: "cotangent", label: "余切" },
];

const PALETTE = ["#2DE2E6", "#F5D90A", "#FF5CA8", "#7CFF6B", "#FF8A3D", "#9B8CFF"];

const OPS = [
  { id: "add", label: "叠加 Σ", sym: "+" },
  { id: "multiply", label: "调幅 ×", sym: "×" },
  { id: "subtract", label: "差值 −", sym: "−" },
];

/* ---------------- 信号生成 ---------------- */
const TAN_CLAMP = 10;
function waveValue(type, frac) {
  const angle = TWO_PI * frac;
  switch (type) {
    case "cosine": return Math.cos(angle);
    case "tangent": return Math.max(-TAN_CLAMP, Math.min(TAN_CLAMP, Math.tan(angle)));
    case "cotangent": {
      const s = Math.sin(angle);
      return Math.abs(s) < 1e-9 ? TAN_CLAMP : Math.max(-TAN_CLAMP, Math.min(TAN_CLAMP, Math.cos(angle) / s));
    }
    case "sine":
    default: return Math.sin(angle);
  }
}

function genSamples(channels, op, T) {
  const t = new Float64Array(N);
  const dt = T / N;
  const traces = channels.map((c) => ({
    ...c, data: new Float64Array(N),
  }));
  const sum = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const time = i * dt;
    t[i] = time;
    let acc = op === "multiply" ? 1 : 0;
    let first = true;
    for (let k = 0; k < traces.length; k++) {
      const c = traces[k];
      const frac = c.freq * time + c.phase / 360;
      const v = c.amp * waveValue(c.type, frac);
      c.data[i] = v;
      if (!c.visible) continue;
      if (op === "multiply") acc *= v;
      else if (op === "subtract") { acc = first ? v : acc - v; first = false; }
      else acc += v;
    }
    sum[i] = acc;
  }
  return { t, traces, sum, dt };
}

/* 迭代式 Cooley–Tukey FFT (原地, N 为 2 的幂) */
function fftMag(signal, fs) {
  const n = signal.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  // 汉宁窗, 抑制频谱泄漏
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((TWO_PI * i) / (n - 1));
    re[i] = signal[i] * w;
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -TWO_PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len >> 1; k++) {
        const a = i + k, b = a + (len >> 1);
        const vr = re[b] * cwr - im[b] * cwi;
        const vi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = ncwr;
      }
    }
  }
  const half = n >> 1;
  const freqs = new Float64Array(half);
  const mags = new Float64Array(half);
  let peakFreq = 0, peakMag = 0;
  for (let i = 0; i < half; i++) {
    freqs[i] = (i * fs) / n;
    const m = (2 * Math.hypot(re[i], im[i])) / n / 0.5; // 窗修正
    mags[i] = m;
    if (i > 0 && m > peakMag) { peakMag = m; peakFreq = freqs[i]; }
  }
  return { freqs, mags, peakFreq, peakMag };
}

function signalStats(sum) {
  let max = -Infinity, min = Infinity, sq = 0;
  for (let i = 0; i < sum.length; i++) {
    const v = sum[i];
    if (v > max) max = v;
    if (v < min) min = v;
    sq += v * v;
  }
  return { vpp: max - min, max, min, rms: Math.sqrt(sq / sum.length) };
}

/* ---------------- 主题 ---------------- */
const THEMES = {
  dark: {
    name: "dark",
    chassis: "linear-gradient(160deg,#1a1f27 0%,#0e1116 60%,#0a0c10 100%)",
    panel: "#161b22", panelBorder: "#272e38", panelInset: "#10141a",
    screen: "#050a07", screenBorder: "#0c1a12",
    grid: "rgba(60,255,170,0.10)", gridMajor: "rgba(60,255,170,0.22)",
    text: "#cdd6df", dim: "#6c7785", faint: "#41505f",
    accent: "#36e29a", accentGlow: "rgba(54,226,154,0.55)",
    danger: "#ff5a5a", sumColor: "#ffffff",
    knobTrack: "#0c1117", knobFill: "#36e29a",
    tabActive: "#0f1620", led: "#36e29a",
  },
  light: {
    name: "light",
    chassis: "linear-gradient(160deg,#eceae2 0%,#dcdad1 100%)",
    panel: "#f5f3ec", panelBorder: "#cfccc0", panelInset: "#e7e4da",
    screen: "#f4f8f2", screenBorder: "#c9d6cd",
    grid: "rgba(20,90,60,0.12)", gridMajor: "rgba(20,90,60,0.28)",
    text: "#1f262c", dim: "#5d6770", faint: "#9aa3ab",
    accent: "#0f9d63", accentGlow: "rgba(15,157,99,0.35)",
    danger: "#cc3333", sumColor: "#101418",
    knobTrack: "#d8d5cb", knobFill: "#0f9d63",
    tabActive: "#ffffff", led: "#0f9d63",
  },
};

let _id = 0;
const uid = () => `ch${++_id}`;
function makeChannel(i, over = {}) {
  return {
    id: uid(), name: `CH${i}`, type: "sine",
    amp: 2, freq: 5, phase: 0,
    color: PALETTE[(i - 1) % PALETTE.length], visible: true, ...over,
  };
}

/* ===================================================================== */
export default function SignalGenerator() {
  const [channels, setChannels] = useState(() => [makeChannel(1)]);
  const [op, setOp] = useState("add");
  const [mode, setMode] = useState("time"); // time | fft | xy
  const [freqUnit, setFreqUnit] = useState("Hz"); // Hz | rad/s
  const [phaseUnit, setPhaseUnit] = useState("deg"); // deg | rad
  const [themeName, setThemeName] = useState("dark");
  const [playing, setPlaying] = useState(false);
  const [annot, setAnnot] = useState(true);
  const [selected, setSelected] = useState(channels[0]?.id);
  const [toast, setToast] = useState(null);

  const T = THEMES[themeName];

  // 自适应时间窗口: 显示约 6 个最低频周期
  const tWin = useMemo(() => {
    const active = channels.filter((c) => c.visible);
    const minF = active.length ? Math.min(...active.map((c) => c.freq)) : 5;
    return Math.min(Math.max(6 / minF, 0.004), 4);
  }, [channels]);

  const data = useMemo(() => genSamples(channels, op, tWin), [channels, op, tWin]);
  const fs = N / tWin;
  const fft = useMemo(() => fftMag(data.sum, fs), [data, fs]);
  const st = useMemo(() => signalStats(data.sum), [data]);

  /* ---------- 输入验证 (#6) ---------- */
  const flash = useCallback((msg, kind = "warn") => {
    setToast({ msg, kind });
    clearTimeout(flash._t);
    flash._t = setTimeout(() => setToast(null), 2600);
  }, []);

  const updateChannel = useCallback((id, patch) => {
    setChannels((prev) => prev.map((c) => {
      if (c.id !== id) return c;
      const next = { ...c, ...patch };
      if ("amp" in patch) {
        if (isNaN(next.amp)) { flash("幅值必须为数字"); return c; }
        if (next.amp < 0) { flash("幅值不能为负, 已置 0"); next.amp = 0; }
        if (next.amp > 10) { flash("幅值上限 10 V, 已限制"); next.amp = 10; }
      }
      if ("freq" in patch) {
        if (isNaN(next.freq)) { flash("频率必须为数字"); return c; }
        if (next.freq <= 0) { flash("频率必须 > 0, 已置 0.1"); next.freq = 0.1; }
        if (next.freq > 500) { flash("频率上限 500 Hz, 已限制"); next.freq = 500; }
      }
      if ("phase" in patch) {
        if (isNaN(next.phase)) { flash("相位必须为数字"); return c; }
        next.phase = ((next.phase % 360) + 360) % 360; // 归化 0~360
      }
      return next;
    }));
  }, [flash]);

  const addChannel = () => {
    setChannels((prev) => {
      if (prev.length >= 6) { flash("最多 6 路通道"); return prev; }
      const ch = makeChannel(prev.length + 1, {
        freq: 5 + prev.length * 2, phase: 0,
        color: PALETTE[prev.length % PALETTE.length],
      });
      setSelected(ch.id);
      return [...prev, ch];
    });
  };

  const removeChannel = (id) => {
    setChannels((prev) => {
      if (prev.length <= 1) { flash("至少保留 1 路通道"); return prev; }
      const next = prev.filter((c) => c.id !== id);
      if (selected === id) setSelected(next[0]?.id);
      return next;
    });
  };

  /* ---------- 三相交流电预设 (#1) ---------- */
  const preset3phase = () => {
    _id = 0;
    const phases = [0, 120, 240];
    const cols = ["#F5D90A", "#2DE2E6", "#FF5CA8"];
    const names = ["A 相", "B 相", "C 相"];
    const chs = phases.map((ph, i) => makeChannel(i + 1, {
      type: "sine", amp: 3, freq: 50, phase: ph, color: cols[i], name: names[i],
    }));
    setChannels(chs);
    setSelected(chs[0].id);
    setOp("add");
    setMode("time");
    flash("已载入三相交流电预设 (50 Hz · 相差 120°)", "ok");
  };

  const reset = () => {
    _id = 0;
    setChannels([makeChannel(1)]);
    setOp("add"); setMode("time"); setPlaying(false);
    flash("已复位", "ok");
  };

  /* ---------- 单位换算 (#7) ---------- */
  const dispFreq = (hz) => freqUnit === "Hz" ? hz : hz * TWO_PI;
  const fromFreq = (val) => freqUnit === "Hz" ? val : val / TWO_PI;
  const dispPhase = (deg) => phaseUnit === "deg" ? deg : (deg * Math.PI) / 180;
  const fromPhase = (val) => phaseUnit === "deg" ? val : (val * 180) / Math.PI;

  /* ---------- 数据导出 (#12) ---------- */
  const canvasRef = useRef(null);
  const exportPNG = () => {
    const c = canvasRef.current; if (!c) return;
    const a = document.createElement("a");
    a.download = `signal_${mode}_${Date.now()}.png`;
    a.href = c.toDataURL("image/png");
    a.click();
    flash("已导出波形 PNG", "ok");
  };
  const exportCSV = () => {
    const header = ["t(s)", ...data.traces.map((c) => c.name), "合成"].join(",");
    const rows = [header];
    for (let i = 0; i < N; i += 2) {
      const r = [data.t[i].toFixed(6),
        ...data.traces.map((c) => c.data[i].toFixed(4)),
        data.sum[i].toFixed(4)];
      rows.push(r.join(","));
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.download = `signal_data_${Date.now()}.csv`;
    a.href = URL.createObjectURL(blob);
    a.click();
    URL.revokeObjectURL(a.href);
    flash("已导出数据 CSV", "ok");
  };

  /* ---------- 绘图 ---------- */
  const sweepRef = useRef(1);
  const dataRef = useRef(data);
  const drawRef = useRef(() => {});
  dataRef.current = data;

  const drawScene = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth, h = parent.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 屏幕底色
    ctx.fillStyle = T.screen;
    ctx.fillRect(0, 0, w, h);
    const padL = 8, padR = 8, padT = 8, padB = 8;
    const gx = padL, gy = padT, gw = w - padL - padR, gh = h - padT - padB;

    // 网格
    const cols = 12, rows = 8;
    ctx.lineWidth = 1;
    for (let i = 0; i <= cols; i++) {
      const x = gx + (gw * i) / cols;
      ctx.strokeStyle = i === cols / 2 ? T.gridMajor : T.grid;
      ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x, gy + gh); ctx.stroke();
    }
    for (let j = 0; j <= rows; j++) {
      const y = gy + (gh * j) / rows;
      ctx.strokeStyle = j === rows / 2 ? T.gridMajor : T.grid;
      ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx + gw, y); ctx.stroke();
    }

    const d = dataRef.current;
    if (mode === "xy") return drawXY(ctx, d, gx, gy, gw, gh);
    if (mode === "fft") return drawFFT(ctx, gx, gy, gw, gh);

    // ---- 时域 ----
    const amax = Math.max(0.5, st.vpp / 2, ...d.traces.filter(c => c.visible).map(c => c.amp));
    const yScale = (gh / 2) / (amax * 1.15);
    const ymid = gy + gh / 2;
    const toY = (v) => ymid - v * yScale;
    const toX = (i) => gx + (gw * i) / (N - 1);
    const sweep = sweepRef.current;
    const lastIdx = Math.floor((N - 1) * sweep);

    // 各通道
    for (const c of d.traces) {
      if (!c.visible) continue;
      ctx.save();
      ctx.lineWidth = 1.6; ctx.strokeStyle = c.color;
      ctx.shadowColor = c.color; ctx.shadowBlur = themeName === "dark" ? 6 : 0;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      for (let i = 0; i <= lastIdx; i++) {
        const x = toX(i), y = toY(c.data[i]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.restore();
    }
    // 合成波 (加粗虚线 #9)
    ctx.save();
    ctx.lineWidth = 2.4; ctx.strokeStyle = T.sumColor;
    ctx.setLineDash([7, 4]);
    ctx.shadowColor = T.sumColor; ctx.shadowBlur = themeName === "dark" ? 7 : 0;
    ctx.beginPath();
    for (let i = 0; i <= lastIdx; i++) {
      const x = toX(i), y = toY(d.sum[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.restore();

    // 扫描光点
    if (sweep < 1) {
      const x = toX(lastIdx), y = toY(d.sum[lastIdx]);
      ctx.fillStyle = T.accent;
      ctx.shadowColor = T.accent; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, TWO_PI); ctx.fill();
      ctx.shadowBlur = 0;
    }

    // 时域标注 (#5)
    if (annot && sweep >= 1) {
      ctx.font = "11px 'Share Tech Mono', monospace";
      // RMS 线
      ctx.strokeStyle = T.accent; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.globalAlpha = 0.8;
      [st.rms, -st.rms].forEach((v) => {
        const y = toY(v);
        ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx + gw, y); ctx.stroke();
      });
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.fillStyle = T.accent;
      ctx.fillText(`RMS ${st.rms.toFixed(2)}V`, gx + 6, toY(st.rms) - 5);
      // Vpp 标尺
      const bx = gx + gw - 14;
      ctx.strokeStyle = T.text; ctx.lineWidth = 1; ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(bx, toY(st.max)); ctx.lineTo(bx, toY(st.min));
      ctx.moveTo(bx - 4, toY(st.max)); ctx.lineTo(bx + 4, toY(st.max));
      ctx.moveTo(bx - 4, toY(st.min)); ctx.lineTo(bx + 4, toY(st.min));
      ctx.stroke();
      ctx.fillStyle = T.text;
      ctx.save();
      ctx.translate(bx - 8, (toY(st.max) + toY(st.min)) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(`Vpp ${st.vpp.toFixed(2)}V`, 0, 0);
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // 角标
    ctx.fillStyle = T.dim; ctx.font = "10px 'Share Tech Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillText(`时基 ${(tWin * 1000 / 12).toFixed(1)} ms/格`, gx + 4, gy + gh - 6);
    ctx.fillText(`${(amax * 1.15 / 4).toFixed(2)} V/格`, gx + 4, gy + 12);

    function drawFFT(ctx, gx, gy, gw, gh) {
      const f = fft;
      const fmaxShow = Math.min(fs / 2, Math.max(f.peakFreq * 4, 60));
      const nShow = Math.max(2, Math.floor((fmaxShow / (fs / 2)) * f.freqs.length));
      let mmax = 1e-6;
      for (let i = 1; i < nShow; i++) mmax = Math.max(mmax, f.mags[i]);
      const bw = gw / nShow;
      for (let i = 1; i < nShow; i++) {
        const bh = (f.mags[i] / mmax) * (gh - 20);
        const x = gx + (gw * i) / nShow;
        const grad = ctx.createLinearGradient(0, gy + gh, 0, gy + gh - bh);
        grad.addColorStop(0, T.accent + "30");
        grad.addColorStop(1, T.accent);
        ctx.fillStyle = grad;
        ctx.fillRect(x, gy + gh - bh, Math.max(1, bw * 0.7), bh);
      }
      // 峰值标注
      if (themeName === "dark") { ctx.shadowColor = T.accent; ctx.shadowBlur = 8; }
      const peakX = gx + gw * (f.peakFreq / fmaxShow);
      ctx.shadowBlur = 0;
      ctx.fillStyle = T.text; ctx.font = "11px 'Share Tech Mono', monospace";
      ctx.textAlign = "center";
      if (peakX < gx + gw) ctx.fillText(`主频 ${f.peakFreq.toFixed(1)} Hz`, Math.min(peakX, gx + gw - 40), gy + 16);
      ctx.fillStyle = T.dim; ctx.font = "10px 'Share Tech Mono', monospace";
      ctx.textAlign = "left";
      ctx.fillText("0 Hz", gx + 2, gy + gh - 4);
      ctx.textAlign = "right";
      ctx.fillText(`${fmaxShow.toFixed(0)} Hz`, gx + gw - 2, gy + gh - 4);
      ctx.textAlign = "left";
      ctx.fillText("幅值谱 |FFT|", gx + 4, gy + 12);
    }

    function drawXY(ctx, d, gx, gy, gw, gh) {
      const vis = d.traces.filter((c) => c.visible);
      ctx.textAlign = "center";
      if (vis.length < 2) {
        ctx.fillStyle = T.dim; ctx.font = "13px 'Rajdhani', sans-serif";
        ctx.fillText("李萨如图形需要至少 2 路可见波形", gx + gw / 2, gy + gh / 2);
        ctx.textAlign = "left"; return;
      }
      const cx = vis[0], cy = vis[1];
      const ax = Math.max(0.5, cx.amp), ay = Math.max(0.5, cy.amp);
      const sx = (gw / 2) / (ax * 1.15), sy = (gh / 2) / (ay * 1.15);
      const ox = gx + gw / 2, oy = gy + gh / 2;
      ctx.save();
      ctx.lineWidth = 1.8; ctx.strokeStyle = T.accent;
      ctx.shadowColor = T.accent; ctx.shadowBlur = themeName === "dark" ? 8 : 0;
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const x = ox + cx.data[i] * sx, y = oy - cy.data[i] * sy;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.restore();
      ctx.fillStyle = T.dim; ctx.font = "10px 'Share Tech Mono', monospace";
      ctx.textAlign = "right"; ctx.fillText(`X: ${cx.name}`, gx + gw - 4, gy + gh - 6);
      ctx.textAlign = "left"; ctx.fillText(`Y: ${cy.name}`, gx + 4, gy + 12);
      const ratio = (cy.freq / cx.freq).toFixed(2);
      ctx.fillStyle = T.text; ctx.textAlign = "center";
      ctx.fillText(`频率比 ${ratio} : 1`, gx + gw / 2, gy + 14);
      ctx.textAlign = "left";
    }
  }, [T, mode, themeName, annot, st, fft, fs, tWin]);

  drawRef.current = drawScene;

  // 静态重绘
  useEffect(() => { sweepRef.current = playing ? sweepRef.current : 1; drawScene(); }, [drawScene]);

  // 动态播放 (#10)
  useEffect(() => {
    if (!playing) { sweepRef.current = 1; drawRef.current(); return; }
    let raf; sweepRef.current = 0;
    const loop = () => {
      sweepRef.current += 0.012;
      if (sweepRef.current >= 1) sweepRef.current = 0;
      drawRef.current();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // 窗口尺寸变化重绘
  useEffect(() => {
    const ro = new ResizeObserver(() => drawRef.current());
    if (canvasRef.current?.parentElement) ro.observe(canvasRef.current.parentElement);
    return () => ro.disconnect();
  }, []);

  /* =================== 渲染 =================== */
  const css = stylesheet(T);

  return (
    <div style={{ ...sx.root, background: T.chassis, color: T.text }}>
      <style>{css}</style>

      {/* 顶部仪器横条 */}
      <header style={{ ...sx.header, borderColor: T.panelBorder }}>
        <div style={sx.brand}>
          <div style={{ ...sx.logoBox, borderColor: T.accent, color: T.accent }}>
            <Waves size={20} strokeWidth={2.4} />
          </div>
          <div>
            <div style={{ ...sx.model, color: T.text }}>SIGGEN&nbsp;<span style={{ color: T.accent }}>·30A</span></div>
            <div style={{ ...sx.subtitle, color: T.dim }}>多通道函数信号发生器 / 教学级软件实现</div>
          </div>
        </div>
        <div style={sx.headerRight}>
          <span style={{ ...sx.ledRow, color: T.dim }}>
            <i style={{ ...sx.led, background: playing ? T.led : T.faint, boxShadow: playing ? `0 0 8px ${T.accentGlow}` : "none" }} />
            {playing ? "RUN" : "STOP"}
          </span>
          <button onClick={() => setThemeName(themeName === "dark" ? "light" : "dark")}
            style={{ ...sx.iconBtn, borderColor: T.panelBorder, color: T.text }} title="切换主题 (#11)">
            {themeName === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button onClick={reset} style={{ ...sx.iconBtn, borderColor: T.panelBorder, color: T.text }} title="复位">
            <RotateCcw size={16} />
          </button>
        </div>
      </header>

      <div style={sx.body}>
        {/* 左侧: 通道控制 */}
        <aside style={{ ...sx.side, background: T.panel, borderColor: T.panelBorder }}>
          <div style={sx.sideHead}>
            <span style={sx.sectionTitle}><Activity size={14} /> 通道控制</span>
            <button onClick={addChannel} style={{ ...sx.addBtn, background: T.accent }}>
              <Plus size={14} /> 添加
            </button>
          </div>

          <div style={sx.chList}>
            {channels.map((c) => (
              <ChannelCard key={c.id} c={c} T={T} selected={c.id === selected}
                freqUnit={freqUnit} phaseUnit={phaseUnit}
                dispFreq={dispFreq} fromFreq={fromFreq}
                dispPhase={dispPhase} fromPhase={fromPhase}
                onSelect={() => setSelected(c.id)}
                onChange={(p) => updateChannel(c.id, p)}
                onRemove={() => removeChannel(c.id)}
                canRemove={channels.length > 1} />
            ))}
          </div>

          {/* 全局控制 */}
          <div style={{ ...sx.globalBox, borderColor: T.panelBorder }}>
            <div style={sx.fieldRow}>
              <label style={{ ...sx.miniLabel, color: T.dim }}>合成运算 (#4)</label>
              <div style={sx.segGroup}>
                {OPS.map((o) => (
                  <button key={o.id} onClick={() => setOp(o.id)}
                    style={{ ...sx.seg, ...(op === o.id ? { background: T.accent, color: "#06120c", fontWeight: 700 } : { color: T.dim }) }}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={sx.unitRow}>
              <div style={sx.fieldRow}>
                <label style={{ ...sx.miniLabel, color: T.dim }}>频率单位</label>
                <div style={sx.segGroup}>
                  {["Hz", "rad/s"].map((u) => (
                    <button key={u} onClick={() => setFreqUnit(u)}
                      style={{ ...sx.seg, ...(freqUnit === u ? { background: T.accent, color: "#06120c", fontWeight: 700 } : { color: T.dim }) }}>{u}</button>
                  ))}
                </div>
              </div>
              <div style={sx.fieldRow}>
                <label style={{ ...sx.miniLabel, color: T.dim }}>相位单位</label>
                <div style={sx.segGroup}>
                  {[["deg", "°"], ["rad", "rad"]].map(([u, l]) => (
                    <button key={u} onClick={() => setPhaseUnit(u)}
                      style={{ ...sx.seg, ...(phaseUnit === u ? { background: T.accent, color: "#06120c", fontWeight: 700 } : { color: T.dim }) }}>{l}</button>
                  ))}
                </div>
              </div>
            </div>
            <button onClick={preset3phase} style={{ ...sx.presetBtn, borderColor: T.accent, color: T.accent }}>
              <Zap size={15} /> 三相交流电预设 (#1)
            </button>
          </div>
        </aside>

        {/* 中部: 示波屏 + 读数 */}
        <main style={sx.main}>
          <div style={{ ...sx.tabsRow }}>
            <div style={sx.tabs}>
              {[
                { id: "time", label: "时域波形", icon: <Waves size={14} /> },
                { id: "fft", label: "频谱 FFT", icon: <Sigma size={14} /> },
                { id: "xy", label: "李萨如 XY", icon: <LayoutGrid size={14} /> },
              ].map((t) => (
                <button key={t.id} onClick={() => setMode(t.id)}
                  style={{
                    ...sx.tab,
                    background: mode === t.id ? T.tabActive : "transparent",
                    color: mode === t.id ? T.accent : T.dim,
                    borderColor: mode === t.id ? T.accent : "transparent",
                  }}>
                  {t.icon}{t.label}
                </button>
              ))}
            </div>
            <div style={sx.scopeTools}>
              <button onClick={() => setAnnot((a) => !a)} title="时域参数标注 (#5)"
                style={{ ...sx.iconBtn, borderColor: T.panelBorder, color: annot ? T.accent : T.dim }}>
                <Gauge size={16} />
              </button>
              <button onClick={() => setPlaying((p) => !p)}
                style={{ ...sx.playBtn, background: playing ? T.danger : T.accent }}>
                {playing ? <Pause size={15} /> : <Play size={15} />}
                {playing ? "暂停" : "播放"}
              </button>
            </div>
          </div>

          <div style={{ ...sx.screenWrap, background: T.screen, borderColor: T.screenBorder }}>
            <canvas ref={canvasRef} style={sx.canvas} />
            <div style={sx.scanlines} />
          </div>

          {/* 读数面板 (#5) */}
          <div style={sx.readouts}>
            <Readout T={T} label="峰峰值 Vpp" value={st.vpp.toFixed(2)} unit="V" />
            <Readout T={T} label="有效值 RMS" value={st.rms.toFixed(2)} unit="V" />
            <Readout T={T} label="主频 f₀" value={fft.peakFreq.toFixed(1)} unit="Hz" />
            <Readout T={T} label="周期 T" value={fft.peakFreq > 0 ? (1000 / fft.peakFreq).toFixed(2) : "—"} unit="ms" />
          </div>

          <div style={sx.exportRow}>
            <button onClick={exportPNG} style={{ ...sx.exportBtn, borderColor: T.panelBorder, color: T.text }}>
              <Download size={15} /> 导出 PNG
            </button>
            <button onClick={exportCSV} style={{ ...sx.exportBtn, borderColor: T.panelBorder, color: T.text }}>
              <Table size={15} /> 导出 CSV
            </button>
            <span style={{ ...sx.tag, color: T.dim, borderColor: T.panelBorder }}>对标 Keysight 33500B</span>
          </div>
        </main>
      </div>

      {/* 输入验证提示 (#6) */}
      {toast && (
        <div style={{
          ...sx.toast,
          background: toast.kind === "ok" ? T.accent : T.danger,
          color: toast.kind === "ok" ? "#06120c" : "#fff",
        }}>
          {toast.kind === "ok" ? <Zap size={15} /> : <AlertTriangle size={15} />}
          {toast.msg}
        </div>
      )}
    </div>
  );
}

/* ---------------- 通道卡片 ---------------- */
function ChannelCard({ c, T, selected, freqUnit, phaseUnit, dispFreq, fromFreq, dispPhase, fromPhase, onSelect, onChange, onRemove, canRemove }) {
  return (
    <div onClick={onSelect}
      style={{
        ...sx.card,
        background: T.panelInset,
        borderColor: selected ? c.color : T.panelBorder,
        boxShadow: selected ? `0 0 0 1px ${c.color}55, 0 4px 14px rgba(0,0,0,0.25)` : "none",
      }}>
      <div style={sx.cardHead}>
        <span style={{ ...sx.dot, background: c.color, boxShadow: `0 0 8px ${c.color}` }} />
        <span style={{ fontWeight: 700, color: c.color, fontFamily: "'Share Tech Mono',monospace" }}>{c.name}</span>
        <div style={{ flex: 1 }} />
        {/* 颜色自定义 (#9) */}
        <label style={{ ...sx.colorWrap, borderColor: T.panelBorder }} title="自定义颜色 (#9)">
          <input type="color" value={c.color} onChange={(e) => onChange({ color: e.target.value })}
            style={sx.colorInput} onClick={(e) => e.stopPropagation()} />
          <span style={{ ...sx.colorSwatch, background: c.color }} />
        </label>
        {canRemove && (
          <button onClick={(e) => { e.stopPropagation(); onRemove(); }}
            style={{ ...sx.miniIcon, color: T.danger }}><Trash2 size={14} /></button>
        )}
      </div>

      <div style={sx.typeRow}>
        {WAVE_TYPES.map((w) => (
          <button key={w.id} onClick={(e) => { e.stopPropagation(); onChange({ type: w.id }); }}
            style={{
              ...sx.typeBtn,
              borderColor: c.type === w.id ? c.color : T.panelBorder,
              color: c.type === w.id ? c.color : T.dim,
              background: c.type === w.id ? c.color + "1a" : "transparent",
            }}>{w.label}</button>
        ))}
      </div>

      <Knob T={T} color={c.color} label="幅值" unit="V" min={0} max={10} step={0.1}
        value={c.amp} display={c.amp.toFixed(1)} onChange={(v) => onChange({ amp: v })} />
      <Knob T={T} color={c.color} label="频率" unit={freqUnit} min={0.1} max={500} step={0.1}
        value={c.freq} display={dispFreq(c.freq).toFixed(freqUnit === "Hz" ? 1 : 1)}
        onChange={(v) => onChange({ freq: v })} />
      <Knob T={T} color={c.color} label="初相" unit={phaseUnit === "deg" ? "°" : "rad"} min={0} max={360} step={1}
        value={c.phase} display={dispPhase(c.phase).toFixed(phaseUnit === "deg" ? 0 : 2)}
        onChange={(v) => onChange({ phase: v })} />
    </div>
  );
}

/* 滑块 (点击数值可直接编辑) */
function Knob({ T, color, label, unit, min, max, step, value, display, onChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(display);
  const commit = () => {
    setEditing(false);
    const n = parseFloat(draft);
    if (!isNaN(n)) onChange(Math.max(min, Math.min(max, n)));
  };
  return (
    <div style={sx.knobRow}>
      <div style={sx.knobTop}>
        <span style={{ ...sx.knobLabel, color: T.dim }}>{label}</span>
        {editing ? (
          <input autoFocus value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
            onClick={(e) => e.stopPropagation()}
            style={{ ...sx.knobInput, color: T.text, borderColor: color }} />
        ) : (
          <span onClick={(e) => { e.stopPropagation(); setDraft(display); setEditing(true); }}
            style={{ ...sx.knobVal, color: T.text, cursor: "text", borderBottom: `1px dotted ${T.faint}` }}>
            {display}<small style={{ color: T.dim, marginLeft: 2 }}>{unit}</small>
          </span>
        )}
      </div>
      <input type="range" className="sg-range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onClick={(e) => e.stopPropagation()}
        style={{ accentColor: color, "--c": color }} />
    </div>
  );
}

/* 读数器件 */
function Readout({ T, label, value, unit }) {
  return (
    <div style={{ ...sx.readout, borderColor: T.panelBorder, background: T.panelInset }}>
      <div style={{ ...sx.readLabel, color: T.dim }}>{label}</div>
      <div style={{ ...sx.readValue, color: T.accent, textShadow: T.name === "dark" ? `0 0 10px ${T.accentGlow}` : "none" }}>
        {value}<span style={{ ...sx.readUnit, color: T.dim }}>{unit}</span>
      </div>
    </div>
  );
}


/* ---------------- 样式 ---------------- */
function stylesheet(T) {
  return `
  * { box-sizing: border-box; }
  .sg-range { -webkit-appearance:none; appearance:none; width:100%; height:4px; border-radius:4px;
    background:${T.knobTrack}; outline:none; cursor:pointer; }
  .sg-range::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:15px; height:15px;
    border-radius:50%; background:var(--c, ${T.accent}); border:2px solid ${T.panel};
    box-shadow:0 0 6px var(--c, ${T.accent}); cursor:pointer; }
  .sg-range::-moz-range-thumb { width:15px; height:15px; border-radius:50%; background:var(--c, ${T.accent});
    border:2px solid ${T.panel}; box-shadow:0 0 6px var(--c, ${T.accent}); cursor:pointer; }
  ::-webkit-scrollbar { width:8px; height:8px; }
  ::-webkit-scrollbar-thumb { background:${T.panelBorder}; border-radius:8px; }
  ::-webkit-scrollbar-track { background:transparent; }
  `;
}

const FONT_DISPLAY = "'Rajdhani','Segoe UI',system-ui,sans-serif";
const FONT_MONO = "'Share Tech Mono','IBM Plex Mono',ui-monospace,monospace";

const sx = {
  root: { fontFamily: FONT_DISPLAY, minHeight: "100%", padding: 16, display: "flex", flexDirection: "column", gap: 14, letterSpacing: "0.01em" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 12, borderBottom: "1px solid" },
  brand: { display: "flex", alignItems: "center", gap: 12 },
  logoBox: { width: 40, height: 40, borderRadius: 10, border: "1.5px solid", display: "grid", placeItems: "center" },
  model: { fontSize: 20, fontWeight: 700, letterSpacing: "0.08em", lineHeight: 1, fontFamily: FONT_MONO },
  subtitle: { fontSize: 11.5, marginTop: 3, letterSpacing: "0.04em" },
  headerRight: { display: "flex", alignItems: "center", gap: 10 },
  ledRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: FONT_MONO, letterSpacing: "0.1em" },
  led: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
  iconBtn: { width: 32, height: 32, borderRadius: 8, border: "1px solid", background: "transparent", display: "grid", placeItems: "center", cursor: "pointer" },

  body: { display: "flex", gap: 14, alignItems: "stretch", flexWrap: "wrap" },
  side: { width: 320, flexShrink: 0, borderRadius: 14, border: "1px solid", padding: 14, display: "flex", flexDirection: "column", gap: 12 },
  sideHead: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" },
  addBtn: { display: "flex", alignItems: "center", gap: 4, border: "none", borderRadius: 8, padding: "6px 11px", color: "#06120c", fontWeight: 700, fontSize: 12.5, cursor: "pointer", fontFamily: FONT_DISPLAY },
  chList: { display: "flex", flexDirection: "column", gap: 10, maxHeight: 470, overflowY: "auto", paddingRight: 2 },

  card: { borderRadius: 12, border: "1px solid", padding: 11, display: "flex", flexDirection: "column", gap: 9, cursor: "pointer", transition: "border-color .15s,box-shadow .15s" },
  cardHead: { display: "flex", alignItems: "center", gap: 8 },
  dot: { width: 9, height: 9, borderRadius: "50%" },
  colorWrap: { position: "relative", width: 26, height: 22, borderRadius: 6, border: "1px solid", overflow: "hidden", display: "grid", placeItems: "center", cursor: "pointer" },
  colorInput: { position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" },
  colorSwatch: { width: 16, height: 12, borderRadius: 3 },
  miniIcon: { background: "transparent", border: "none", cursor: "pointer", display: "grid", placeItems: "center", padding: 2 },
  typeRow: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5 },
  typeBtn: { border: "1px solid", borderRadius: 7, padding: "5px 0", fontSize: 11.5, cursor: "pointer", fontFamily: FONT_DISPLAY, fontWeight: 600 },

  knobRow: { display: "flex", flexDirection: "column", gap: 4 },
  knobTop: { display: "flex", justifyContent: "space-between", alignItems: "baseline" },
  knobLabel: { fontSize: 11.5, letterSpacing: "0.04em" },
  knobVal: { fontSize: 13, fontFamily: FONT_MONO, fontWeight: 700, padding: "1px 4px", borderRadius: 4 },
  knobInput: { width: 64, background: "transparent", border: "1px solid", borderRadius: 6, padding: "2px 6px", fontFamily: FONT_MONO, fontSize: 13, fontWeight: 700, outline: "none" },

  globalBox: { borderTop: "1px dashed", paddingTop: 12, display: "flex", flexDirection: "column", gap: 11, marginTop: "auto" },
  fieldRow: { display: "flex", flexDirection: "column", gap: 5, flex: 1 },
  miniLabel: { fontSize: 11, letterSpacing: "0.04em" },
  segGroup: { display: "flex", gap: 4, background: "rgba(127,127,127,0.08)", padding: 3, borderRadius: 8 },
  seg: { flex: 1, border: "none", background: "transparent", borderRadius: 6, padding: "5px 4px", fontSize: 11.5, cursor: "pointer", fontFamily: FONT_DISPLAY },
  unitRow: { display: "flex", gap: 10 },
  presetBtn: { display: "flex", alignItems: "center", justifyContent: "center", gap: 7, border: "1.5px solid", background: "transparent", borderRadius: 9, padding: "9px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT_DISPLAY, letterSpacing: "0.03em" },

  main: { flex: 1, minWidth: 380, display: "flex", flexDirection: "column", gap: 11 },
  tabsRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" },
  tabs: { display: "flex", gap: 4 },
  tab: { display: "flex", alignItems: "center", gap: 6, border: "1px solid", borderRadius: 9, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FONT_DISPLAY },
  scopeTools: { display: "flex", alignItems: "center", gap: 8 },
  playBtn: { display: "flex", alignItems: "center", gap: 6, border: "none", borderRadius: 9, padding: "8px 16px", color: "#06120c", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: FONT_DISPLAY },

  screenWrap: { position: "relative", borderRadius: 14, border: "2px solid", height: 380, overflow: "hidden", boxShadow: "inset 0 0 50px rgba(0,0,0,0.55)" },
  canvas: { width: "100%", height: "100%", display: "block" },
  scanlines: { position: "absolute", inset: 0, pointerEvents: "none", background: "repeating-linear-gradient(0deg,rgba(0,0,0,0) 0px,rgba(0,0,0,0) 2px,rgba(0,0,0,0.05) 3px)" },

  readouts: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 },
  readout: { borderRadius: 11, border: "1px solid", padding: "9px 12px" },
  readLabel: { fontSize: 11, letterSpacing: "0.05em", marginBottom: 3 },
  readValue: { fontSize: 24, fontWeight: 700, fontFamily: FONT_MONO, lineHeight: 1 },
  readUnit: { fontSize: 12, marginLeft: 4, fontWeight: 400 },

  exportRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  exportBtn: { display: "flex", alignItems: "center", gap: 6, border: "1px solid", background: "transparent", borderRadius: 9, padding: "8px 14px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: FONT_DISPLAY },
  tag: { marginLeft: "auto", fontSize: 11, border: "1px dashed", borderRadius: 20, padding: "4px 12px", letterSpacing: "0.05em", fontFamily: FONT_MONO },

  toast: { position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 8, padding: "11px 18px", borderRadius: 10, fontWeight: 600, fontSize: 13, boxShadow: "0 8px 30px rgba(0,0,0,0.4)", zIndex: 50, fontFamily: FONT_DISPLAY },
};
