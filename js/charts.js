/* ============================================================
   KUMANOMI Charts — 依存ゼロの SVG チャート
   仕様:2px ライン / バー幅 ≤24px・上端 4px 角丸 / ヘアライン実線グリッド
   系列 ≥2 で凡例必須 / ホバーツールチップ / テキストは ink トークン
   ============================================================ */

import { el } from "./ui.js";

const NS = "http://www.w3.org/2000/svg";

function sv(tag, attrs = {}) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) n.setAttribute(k, v);
  }
  return n;
}

/** CSS 変数から系列色を取得(テーマ追従) */
export function seriesColor(i) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--series-${(i % 8) + 1}`).trim();
  return v || "#2a78d6";
}
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

function defaultFmt(v) {
  if (Math.abs(v) >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(v * 10) / 10);
}

/* ---------------- Tooltip(チャート共通)---------------- */

function makeTip(box) {
  const tip = el("div", { class: "chart-tip" });
  box.appendChild(tip);
  return {
    show(x, y, html) {
      tip.innerHTML = html;
      tip.classList.add("show");
      const bw = box.clientWidth;
      const tw = tip.offsetWidth;
      let left = x + 14;
      if (left + tw > bw - 4) left = x - tw - 14;
      tip.style.left = Math.max(4, left) + "px";
      tip.style.top = Math.max(0, y - tip.offsetHeight / 2) + "px";
    },
    hide() { tip.classList.remove("show"); },
  };
}

function tipHTML(title, rows) {
  return `<div class="tip-title">${title}</div>` + rows.map((r) =>
    `<div class="tip-row"><span class="tip-sw" style="background:${r.color}"></span>${r.name}<span class="tip-val">${r.value}</span></div>`
  ).join("");
}

/* ---------------- Legend ---------------- */

function legend(series, type = "swatch") {
  return el("div", { class: "chart-legend" },
    series.map((s, i) => el("span", { class: "lg-item" },
      el("span", { class: type === "line" ? "lg-line" : "lg-swatch", style: { background: s.color || seriesColor(i) } }),
      s.name)));
}

/* ---------------- Sparkline ---------------- */

export function sparkline({ values, width = 110, height = 34, color, fill = true }) {
  const c = color || cssVar("--chart-deemph", "#d4dad7");
  const accent = cssVar("--brand", "#0c7489");
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const px = (i) => 2 + (i / (values.length - 1)) * (width - 4);
  const py = (v) => height - 3 - ((v - min) / span) * (height - 8);
  const pts = values.map((v, i) => `${px(i)},${py(v)}`).join(" ");
  const svg = sv("svg", { viewBox: `0 0 ${width} ${height}`, width, height });
  if (fill) {
    const area = sv("polygon", {
      points: `2,${height - 3} ${pts} ${width - 2},${height - 3}`,
      fill: c, opacity: 0.35,
    });
    svg.appendChild(area);
  }
  svg.appendChild(sv("polyline", { points: pts, fill: "none", stroke: c, "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  // 現在値のドット(アクセント)
  const lastX = px(values.length - 1), lastY = py(values[values.length - 1]);
  svg.appendChild(sv("circle", { cx: lastX, cy: lastY, r: 3.4, fill: accent, stroke: cssVar("--surface", "#fff"), "stroke-width": 2 }));
  return svg;
}

/* ---------------- Line chart ---------------- */

/**
 * lineChart({series:[{name, values, color}], labels, height, yFmt, fillFirst})
 * 系列1つなら凡例なし。ホバーで十字カーソル+ツールチップ。
 */
export function lineChart({ series, labels, height = 230, yFmt = defaultFmt, fillFirst = false, showDots = false }) {
  const W = 720, H = height;
  const padL = 46, padR = 14, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const allVals = series.flatMap((s) => s.values);
  const yMax = niceMax(Math.max(...allVals) * 1.08);
  const px = (i) => padL + (i / Math.max(labels.length - 1, 1)) * plotW;
  const py = (v) => padT + plotH - (v / yMax) * plotH;

  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  const gridC = cssVar("--chart-grid", "#e6e9e7");
  const mutedC = cssVar("--chart-muted", "#8a938f");
  const surfC = cssVar("--chart-surface", "#fff");

  // グリッド+Y軸目盛
  for (let g = 0; g <= 4; g++) {
    const y = padT + (plotH * g) / 4;
    svg.appendChild(sv("line", { x1: padL, y1: y, x2: W - padR, y2: y, stroke: gridC, "stroke-width": 1 }));
    const t = sv("text", { x: padL - 8, y: y + 4, "text-anchor": "end", "font-size": 10.5, fill: mutedC });
    t.textContent = yFmt(yMax * (1 - g / 4));
    svg.appendChild(t);
  }
  // X軸ラベル(間引き)
  const skip = Math.ceil(labels.length / 10);
  labels.forEach((lb, i) => {
    if (i % skip !== 0 && i !== labels.length - 1) return;
    const t = sv("text", { x: px(i), y: H - 8, "text-anchor": "middle", "font-size": 10.5, fill: mutedC });
    t.textContent = lb;
    svg.appendChild(t);
  });

  series.forEach((s, si) => {
    const c = s.color || seriesColor(si);
    const pts = s.values.map((v, i) => `${px(i)},${py(v)}`).join(" ");
    if (fillFirst && si === 0) {
      svg.appendChild(sv("polygon", {
        points: `${px(0)},${padT + plotH} ${pts} ${px(s.values.length - 1)},${padT + plotH}`,
        fill: c, opacity: 0.1,
      }));
    }
    svg.appendChild(sv("polyline", {
      points: pts, fill: "none", stroke: c, "stroke-width": 2,
      "stroke-linecap": "round", "stroke-linejoin": "round",
    }));
    if (showDots) {
      s.values.forEach((v, i) => svg.appendChild(sv("circle", { cx: px(i), cy: py(v), r: 3.6, fill: c, stroke: surfC, "stroke-width": 2 })));
    }
  });

  // ホバー層
  const cursor = sv("line", { y1: padT, y2: padT + plotH, stroke: cssVar("--chart-axis", "#c4cbc8"), "stroke-width": 1, opacity: 0 });
  svg.appendChild(cursor);
  const hoverDots = series.map((s, si) => {
    const d = sv("circle", { r: 4.4, fill: s.color || seriesColor(si), stroke: surfC, "stroke-width": 2, opacity: 0 });
    svg.appendChild(d);
    return d;
  });

  const box = el("div", { class: "chart-box" });
  box.appendChild(svg);
  const tip = makeTip(box);

  svg.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((sx - padL) / plotW) * (labels.length - 1));
    if (i < 0 || i >= labels.length) { tip.hide(); return; }
    const x = px(i);
    cursor.setAttribute("x1", x); cursor.setAttribute("x2", x);
    cursor.setAttribute("opacity", 1);
    series.forEach((s, si) => {
      hoverDots[si].setAttribute("cx", x);
      hoverDots[si].setAttribute("cy", py(s.values[i]));
      hoverDots[si].setAttribute("opacity", 1);
    });
    const bx = (x / W) * r.width;
    const by = (py(series[0].values[i]) / H) * r.height;
    tip.show(bx, by, tipHTML(labels[i], series.map((s, si) => ({
      name: s.name, color: s.color || seriesColor(si), value: yFmt(s.values[i]),
    }))));
  });
  svg.addEventListener("mouseleave", () => {
    cursor.setAttribute("opacity", 0);
    hoverDots.forEach((d) => d.setAttribute("opacity", 0));
    tip.hide();
  });

  if (series.length >= 2) box.appendChild(legend(series, "line"));
  return box;
}

/* ---------------- Bar chart ---------------- */

/**
 * barChart({series:[{name, values, color}], labels, height, yFmt, stacked})
 * バー幅 ≤24px、上端 4px 角丸、隣接バー/セグメント間 2px サーフェスギャップ。
 */
export function barChart({ series, labels, height = 230, yFmt = defaultFmt, stacked = false, targetLine }) {
  const W = 720, H = height;
  const padL = 46, padR = 14, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const totals = stacked
    ? labels.map((_, i) => series.reduce((a, s) => a + s.values[i], 0))
    : series.flatMap((s) => s.values);
  const yMax = niceMax(Math.max(...totals, targetLine || 0) * 1.08);
  const py = (v) => padT + plotH - (v / yMax) * plotH;

  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  const gridC = cssVar("--chart-grid", "#e6e9e7");
  const mutedC = cssVar("--chart-muted", "#8a938f");

  for (let g = 0; g <= 4; g++) {
    const y = padT + (plotH * g) / 4;
    svg.appendChild(sv("line", { x1: padL, y1: y, x2: W - padR, y2: y, stroke: gridC, "stroke-width": 1 }));
    const t = sv("text", { x: padL - 8, y: y + 4, "text-anchor": "end", "font-size": 10.5, fill: mutedC });
    t.textContent = yFmt(yMax * (1 - g / 4));
    svg.appendChild(t);
  }

  const band = plotW / labels.length;
  const nSer = stacked ? 1 : series.length;
  const barW = Math.min(24, (band * 0.62) / nSer);
  const groupW = stacked ? barW : barW * series.length + 2 * (series.length - 1);

  const hitZones = [];
  labels.forEach((lb, i) => {
    const cx = padL + band * i + band / 2;
    const t = sv("text", { x: cx, y: H - 8, "text-anchor": "middle", "font-size": 10.5, fill: mutedC });
    const skip = Math.ceil(labels.length / 12);
    if (i % skip === 0 || i === labels.length - 1) { t.textContent = lb; svg.appendChild(t); }

    let x0 = cx - groupW / 2;
    if (stacked) {
      let acc = 0;
      series.forEach((s, si) => {
        const v = s.values[i];
        if (v <= 0) return;
        const yTop = py(acc + v), yBot = py(acc);
        const hGap = acc > 0 ? 2 : 0; // セグメント間 2px サーフェスギャップ
        const isTop = acc + v >= totals[i] - 0.001;
        const r = isTop ? 4 : 0;
        const hh = Math.max(yBot - yTop - hGap, 1);
        svg.appendChild(sv("path", {
          d: roundedTopRect(x0, yTop, barW, hh, r),
          fill: s.color || seriesColor(si),
        }));
        acc += v;
      });
    } else {
      series.forEach((s, si) => {
        const v = s.values[i];
        const x = x0 + si * (barW + 2);
        const y = py(v);
        svg.appendChild(sv("path", {
          d: roundedTopRect(x, y, barW, Math.max(padT + plotH - y, 1), 4),
          fill: s.color || seriesColor(si),
        }));
      });
    }
    hitZones.push({ x: padL + band * i, w: band, i });
  });

  if (targetLine != null) {
    const y = py(targetLine);
    svg.appendChild(sv("line", { x1: padL, y1: y, x2: W - padR, y2: y, stroke: cssVar("--ink-3", "#8a938f"), "stroke-width": 1.4 }));
    const t = sv("text", { x: W - padR, y: y - 5, "text-anchor": "end", "font-size": 10, fill: mutedC });
    t.textContent = `目標 ${yFmt(targetLine)}`;
    svg.appendChild(t);
  }

  const box = el("div", { class: "chart-box" });
  box.appendChild(svg);
  const tip = makeTip(box);
  svg.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    const z = hitZones.find((z) => sx >= z.x && sx < z.x + z.w);
    if (!z) { tip.hide(); return; }
    const bx = (e.clientX - r.left);
    const by = (e.clientY - r.top);
    tip.show(bx, by, tipHTML(labels[z.i], series.map((s, si) => ({
      name: s.name, color: s.color || seriesColor(si), value: yFmt(s.values[z.i]),
    }))));
  });
  svg.addEventListener("mouseleave", () => tip.hide());

  if (series.length >= 2) box.appendChild(legend(series));
  return box;
}

/** 上端のみ角丸の矩形パス */
function roundedTopRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

/* ---------------- Horizontal bars(ランキング等)---------------- */

export function hBars({ items, height, fmt = defaultFmt, color }) {
  // items: [{label, value, color?, sub?}]
  const max = Math.max(...items.map((i) => i.value), 1);
  const wrap = el("div", { class: "stack", style: { gap: "10px" } });
  for (const it of items) {
    const c = it.color || color || cssVar("--brand", "#0c7489");
    const pct = (it.value / max) * 100;
    wrap.appendChild(el("div", {},
      el("div", { class: "flex between", style: { marginBottom: "3px" } },
        el("span", { style: { fontSize: "var(--fs-sm)", fontWeight: "600" } }, it.label, it.sub ? el("span", { class: "muted small", style: { marginLeft: "6px" } }, it.sub) : null),
        el("span", { style: { fontSize: "var(--fs-sm)", fontWeight: "800", fontVariantNumeric: "tabular-nums" } }, fmt(it.value))),
      el("div", { style: { height: "8px", borderRadius: "999px", background: "var(--surface-3)", overflow: "hidden" } },
        el("div", { style: { width: pct + "%", height: "100%", borderRadius: "999px", background: c, transition: "width 0.7s var(--ease)" } }))));
  }
  return wrap;
}

/* ---------------- Donut ---------------- */

export function donut({ items, size = 170, centerLabel, centerValue, fmt = defaultFmt }) {
  const total = items.reduce((a, i) => a + i.value, 0) || 1;
  const R = size / 2, r = R * 0.68;
  const svg = sv("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size });
  let angle = -Math.PI / 2;
  const surfC = cssVar("--chart-surface", "#fff");
  items.forEach((it, i) => {
    const frac = it.value / total;
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const p = sv("path", {
      d: `M${R + R * Math.cos(angle)},${R + R * Math.sin(angle)} A${R},${R} 0 ${large} 1 ${R + R * Math.cos(a2)},${R + R * Math.sin(a2)} L${R + r * Math.cos(a2)},${R + r * Math.sin(a2)} A${r},${r} 0 ${large} 0 ${R + r * Math.cos(angle)},${R + r * Math.sin(angle)} Z`,
      fill: it.color || seriesColor(i),
      stroke: surfC, "stroke-width": 2,
    });
    p.appendChild(sv("title")).textContent = `${it.label}: ${fmt(it.value)}`;
    svg.appendChild(p);
    angle = a2;
  });
  const box = el("div", { style: { display: "flex", alignItems: "center", gap: "18px", flexWrap: "wrap" } });
  const holder = el("div", { style: { position: "relative", width: size + "px", flex: "none" } });
  holder.appendChild(svg);
  if (centerLabel != null) {
    holder.appendChild(el("div", {
      style: { position: "absolute", inset: "0", display: "grid", placeItems: "center", textAlign: "center", pointerEvents: "none" },
    }, el("div", {},
      el("div", { style: { fontSize: "20px", fontWeight: "800" } }, centerValue),
      el("div", { class: "small muted" }, centerLabel))));
  }
  box.appendChild(holder);
  box.appendChild(el("div", { class: "stack", style: { gap: "6px" } },
    items.map((it, i) => el("span", { class: "lg-item", style: { display: "inline-flex", alignItems: "center", gap: "7px", fontSize: "var(--fs-xs)", fontWeight: "600", color: "var(--ink-2)" } },
      el("span", { class: "lg-swatch", style: { width: "10px", height: "10px", borderRadius: "3px", background: it.color || seriesColor(i), flex: "none" } }),
      `${it.label}`,
      el("span", { style: { color: "var(--ink)", fontWeight: "800", marginLeft: "2px" } }, fmt(it.value))))));
  return box;
}

/* ---------------- Radar(評価用・5軸)---------------- */

export function radar({ axes, values, size = 240, max = 5 }) {
  // values: [{name, scores:[...], color?}]
  const R = size / 2 - 30;
  const cx = size / 2, cy = size / 2 + 4;
  const svg = sv("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size });
  const gridC = cssVar("--chart-grid", "#e6e9e7");
  const mutedC = cssVar("--chart-muted", "#8a938f");
  const n = axes.length;
  const pt = (i, r) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  for (let ring = 1; ring <= 5; ring++) {
    const pts = axes.map((_, i) => pt(i, (R * ring) / 5).join(",")).join(" ");
    svg.appendChild(sv("polygon", { points: pts, fill: "none", stroke: gridC, "stroke-width": 1 }));
  }
  axes.forEach((ax, i) => {
    const [x, y] = pt(i, R);
    svg.appendChild(sv("line", { x1: cx, y1: cy, x2: x, y2: y, stroke: gridC, "stroke-width": 1 }));
    const [lx, ly] = pt(i, R + 16);
    const t = sv("text", { x: lx, y: ly + 3.5, "text-anchor": "middle", "font-size": 11, "font-weight": 700, fill: mutedC });
    t.textContent = ax;
    svg.appendChild(t);
  });
  values.forEach((v, vi) => {
    const c = v.color || seriesColor(vi);
    const pts = v.scores.map((s, i) => pt(i, (R * Math.min(s, max)) / max).join(",")).join(" ");
    svg.appendChild(sv("polygon", { points: pts, fill: c, opacity: 0.13 }));
    svg.appendChild(sv("polygon", { points: pts, fill: "none", stroke: c, "stroke-width": 2, "stroke-linejoin": "round" }));
    v.scores.forEach((s, i) => {
      const [x, y] = pt(i, (R * Math.min(s, max)) / max);
      svg.appendChild(sv("circle", { cx: x, cy: y, r: 3.4, fill: c, stroke: cssVar("--chart-surface", "#fff"), "stroke-width": 2 }));
    });
  });
  const box = el("div", { class: "chart-box", style: { display: "grid", placeItems: "center" } });
  box.appendChild(svg);
  if (values.length >= 2) box.appendChild(legend(values, "line"));
  return box;
}
