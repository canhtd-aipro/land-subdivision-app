import React, { useRef, useState, useEffect } from "react";

/**
 * Land Subdivision App — with Select/Edit/Delete & Edge-Extend
 * - Vẽ Boundary, nhiều Public Roads (entry points), Internal roads (polygon), Lots (polygon)
 * - Snap grid / vertex / line, axis-lock (Shift trong lúc vẽ)
 * - Chế độ Select/Edit: chọn vertex/cạnh, kéo chỉnh; kéo cạnh giữ Shift = tịnh tiến theo pháp tuyến (extend)
 * - Xoá: nút Delete / phím Delete/Backspace
 * - Export JSON + PNG
 *
 * Lưu ý: phần “extend cạnh” thực hiện bằng cách tịnh tiến 2 đỉnh của cạnh theo pháp tuyến.
 * Các cạnh kề sẽ “kéo dài theo” vì điểm đầu/cuối cạnh đó thay đổi → polygon vẫn khép kín.
 */

// ---------- Geometry helpers ----------
function shoelaceArea(points) {
  if (!points || points.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}
function download(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function distance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy);
}
function dist2(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}
function dedupPush(list, p) {
  if (list.length === 0) return [...list, p];
  const last = list[list.length - 1];
  if (Math.sqrt(dist2(last, p)) <= 1e-6) return list;
  return [...list, p];
}
function segmentsForLabels(points, closed) {
  const segs = [];
  if (!points || points.length < 2) return segs;
  for (let i = 0; i < points.length - 1; i++)
    segs.push([points[i], points[i + 1]]);
  if (closed && points.length >= 3)
    segs.push([points[points.length - 1], points[0]]);
  return segs;
}
function pointSegProjection(p, a, b) {
  const vx = b[0] - a[0],
    vy = b[1] - a[1];
  const wx = p[0] - a[0],
    wy = p[1] - a[1];
  const vv = vx * vx + vy * vy;
  if (vv <= 1e-12) return { proj: a, d2: dist2(p, a), t: 0 };
  let t = (wx * vx + wy * vy) / vv;
  t = Math.max(0, Math.min(1, t));
  const proj = [a[0] + t * vx, a[1] + t * vy];
  const d2 = dist2(p, proj);
  return { proj, d2, t };
}
function snapToNearestSegment(p, segments, tolUnits) {
  if (!segments || !segments.length) return null;
  let best = null;
  let bestD2 = Infinity;
  for (const [a, b] of segments) {
    const info = pointSegProjection(p, a, b);
    if (info.d2 < bestD2) {
      bestD2 = info.d2;
      best = info;
    }
  }
  if (best && Math.sqrt(best.d2) <= tolUnits) return best.proj;
  return null;
}
function snapToPools(p, pools, tolUnits) {
  let best = null;
  let bestD2 = Infinity;
  for (const pool of pools) {
    for (const q of pool) {
      const d2 = dist2(p, q);
      if (d2 < bestD2) {
        bestD2 = d2;
        best = q;
      }
    }
  }
  if (best && Math.sqrt(bestD2) <= tolUnits) return best;
  return p;
}
function axisAlign(prev, p) {
  if (!prev) return p;
  const dx = Math.abs(p[0] - prev[0]);
  const dy = Math.abs(p[1] - prev[1]);
  return dx >= dy ? [p[0], prev[1]] : [prev[0], p[1]];
}
function polygonCentroid(points) {
  if (!points || points.length < 3) {
    if (!points || !points.length) return [0, 0];
    const sx = points.reduce((a, p) => a + p[0], 0);
    const sy = points.reduce((a, p) => a + p[1], 0);
    return [sx / points.length, sy / points.length];
  }
  let a = 0,
    cx = 0,
    cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-12) {
    const sx = points.reduce((acc, p) => acc + p[0], 0);
    const sy = points.reduce((acc, p) => acc + p[1], 0);
    return [sx / points.length, sy / points.length];
  }
  cx = cx / (6 * a);
  cy = cy / (6 * a);
  return [cx, cy];
}
function transformPoint(p, s, cx, cy) {
  const x = cx + s * (p[0] - cx);
  const y = cy + s * (p[1] - cy);
  return [Number(x.toFixed(2)), Number(y.toFixed(2))];
}
function scalePolygonToArea(poly, targetArea) {
  const A = shoelaceArea(poly);
  if (!isFinite(targetArea) || targetArea <= 0 || A <= 0) return poly;
  const s = Math.sqrt(targetArea / A);
  const [cx, cy] = polygonCentroid(poly);
  return poly.map((pt) => transformPoint(pt, s, cx, cy));
}

const EPS = 1e-9;
function ptsEqual(a, b, eps = EPS) {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
}
// Bỏ điểm cuối nếu trùng điểm đầu
function stripClosingDuplicate(poly) {
  if (!Array.isArray(poly) || poly.length < 2) return poly ?? [];
  const first = poly[0],
    last = poly[poly.length - 1];
  return ptsEqual(first, last) ? poly.slice(0, -1) : poly;
}

// ===== Minimum-Area Bounding Rectangle width on convex hull =====
function _cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}
function convexHull(points) {
  const pts = stripClosingDuplicate(points || []);
  if (pts.length <= 1) return pts.slice();
  const p = [...pts].sort((A, B) =>
    A[0] === B[0] ? A[1] - B[1] : A[0] - B[0]
  );
  const lower = [],
    upper = [];
  for (const pt of p) {
    while (
      lower.length >= 2 &&
      _cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0
    )
      lower.pop();
    lower.push(pt);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (
      upper.length >= 2 &&
      _cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0
    )
      upper.pop();
    upper.push(pt);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1];
}
function normDirFromEdge(a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  const d = [dx / L, dy / L]; // hướng cạnh (trục dài ứng viên)
  const n = [-d[1], d[0]]; // pháp tuyến
  return { d, n };
}

/**
 * Trả về: { width, length, d, n, minD, maxD, minN, maxN }
 * - d: hướng “dài” của HCN tối ưu (song song với 2 đường đỡ “dài nhất”)
 * - n: pháp tuyến của d
 * - width = cạnh ngắn (độ rộng), length = cạnh dài
 * - minN/maxN dùng để vẽ 2 đường đỡ: n·x = minN và n·x = maxN
 */
function minAreaRectInfo(poly) {
  const hull = convexHull(poly);
  const m = hull.length;
  if (m === 0)
    return {
      width: 0,
      length: 0,
      d: [1, 0],
      n: [0, 1],
      minD: 0,
      maxD: 0,
      minN: 0,
      maxN: 0,
    };
  if (m === 1)
    return {
      width: 0,
      length: 0,
      d: [1, 0],
      n: [0, 1],
      minD: 0,
      maxD: 0,
      minN: 0,
      maxN: 0,
    };
  if (m === 2) {
    const { d, n } = normDirFromEdge(hull[0], hull[1]);
    return {
      width: 0,
      length: Math.hypot(hull[1][0] - hull[0][0], hull[1][1] - hull[0][1]),
      d,
      n,
      minD: 0,
      maxD: 0,
      minN: 0,
      maxN: 0,
    };
  }

  let best = {
    area: Infinity,
    width: 0,
    length: 0,
    d: [1, 0],
    n: [0, 1],
    minD: 0,
    maxD: 0,
    minN: 0,
    maxN: 0,
  };
  for (let i = 0; i < m; i++) {
    const a = hull[i],
      b = hull[(i + 1) % m];
    const { d, n } = normDirFromEdge(a, b);

    let minD = Infinity,
      maxD = -Infinity,
      minN = Infinity,
      maxN = -Infinity;
    for (const p of hull) {
      const pd = dot(p, d);
      const pn = dot(p, n);
      if (pd < minD) minD = pd;
      if (pd > maxD) maxD = pd;
      if (pn < minN) minN = pn;
      if (pn > maxN) maxN = pn;
    }
    const len = maxD - minD;
    const wid = maxN - minN;
    const area = len * wid;

    // Tie-breaker ổn định: nếu area bằng nhau (sai số số học),
    // ưu tiên rectangle có length lớn hơn (để d là “hướng dài” dễ đoán)
    const eps = 1e-9;
    const better =
      area + eps < best.area ||
      (Math.abs(area - best.area) <= eps && Math.max(len, wid) > best.length);
    if (better) {
      best = {
        area,
        width: Math.min(len, wid),
        length: Math.max(len, wid),
        // đảm bảo d là trục dài, n là pháp tuyến của d
        d: len >= wid ? d : n,
        n: len >= wid ? n : d,
        minD,
        maxD,
        minN,
        maxN,
      };
    }
  }
  best.width = Number(best.width.toFixed(2));
  best.length = Number(best.length.toFixed(2));
  return best;
}

/**
 * Chọn hướng d sao cho độ dài chiếu (maxD - minD) là LỚN NHẤT
 * tức là "2 đường đỡ song song dài nhất" theo d.
 * Trả về: { d, n, minD, maxD, minN, maxN, length, width }
 */
function maxLengthDirInfo(poly) {
  const hull = convexHull(poly || []);
  const m = hull.length;
  if (m === 0)
    return {
      d: [1, 0],
      n: [0, 1],
      minD: 0,
      maxD: 0,
      minN: 0,
      maxN: 0,
      length: 0,
      width: 0,
    };
  if (m === 1)
    return {
      d: [1, 0],
      n: [0, 1],
      minD: 0,
      maxD: 0,
      minN: 0,
      maxN: 0,
      length: 0,
      width: 0,
    };
  if (m === 2) {
    const { d, n } = normDirFromEdge(hull[0], hull[1]);
    const len = Math.hypot(hull[1][0] - hull[0][0], hull[1][1] - hull[0][1]);
    return {
      d,
      n,
      minD: 0,
      maxD: len,
      minN: 0,
      maxN: 0,
      length: len,
      width: 0,
    };
  }

  let best = {
    length: -Infinity,
    width: Infinity,
    d: [1, 0],
    n: [0, 1],
    minD: 0,
    maxD: 0,
    minN: 0,
    maxN: 0,
  };
  for (let i = 0; i < m; i++) {
    const a = hull[i],
      b = hull[(i + 1) % m];
    const { d, n } = normDirFromEdge(a, b);

    let minD = Infinity,
      maxD = -Infinity,
      minN = Infinity,
      maxN = -Infinity;
    for (const p of hull) {
      const pd = dot(p, d);
      const pn = dot(p, n);
      if (pd < minD) minD = pd;
      if (pd > maxD) maxD = pd;
      if (pn < minN) minN = pn;
      if (pn > maxN) maxN = pn;
    }
    const len = maxD - minD;
    const wid = maxN - minN;

    // Ưu tiên LEN lớn nhất; nếu hoà, lấy WIDTH nhỏ hơn (đỡ bị lệch vì flare)
    if (
      len > best.length + 1e-9 ||
      (Math.abs(len - best.length) <= 1e-9 && wid < best.width)
    ) {
      best = { length: len, width: wid, d, n, minD, maxD, minN, maxN };
    }
  }
  best.length = Number(best.length.toFixed(2));
  best.width = Number(best.width.toFixed(2));
  return best;
}

// Chiếu điểm p lên (d, n)
function _dot(a, b) {
  return a[0] * b[0] + a[1] * b[1];
}

// Bề rộng lớn nhất của giao tuyến giữa polygon và đường thẳng "d·x = t" (đo theo n)
function crossSectionWidthAt(poly, d, n, t) {
  const loop = ensureClosedLoop(stripClosingDuplicate(poly));
  if (!loop || loop.length < 3) return 0;

  const xs = []; // các hoành độ theo n (v) của điểm cắt
  for (let i = 0; i < loop.length - 1; i++) {
    const p0 = loop[i],
      p1 = loop[i + 1];
    const u0 = _dot(p0, d),
      u1 = _dot(p1, d);
    const v0 = _dot(p0, n),
      v1 = _dot(p1, n);
    const du = u1 - u0;
    if (Math.abs(du) < 1e-9) continue; // song song mặt cắt
    const s = (t - u0) / du;
    if (s >= 0 && s <= 1) {
      xs.push(v0 + s * (v1 - v0)); // toạ độ theo n của điểm cắt
    }
  }

  xs.sort((a, b) => a - b);
  let maxSpan = 0;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const span = xs[k + 1] - xs[k]; // từng khoảng "bên trong"
    if (span > maxSpan) maxSpan = span; // lấy khoảng lớn nhất
  }
  return Math.max(0, maxSpan);
}

// percentile đơn giản (0..1)
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(p * (sortedAsc.length - 1)))
  );
  return sortedAsc[idx];
}

// Xây đoạn thẳng dài để vẽ đường đỡ: n·x = c
function supportLineSegment(n, c, vb) {
  const t = [-n[1], n[0]]; // tiếp tuyến (vuông góc với n)
  const p0 = [n[0] * c, n[1] * c]; // 1 điểm bất kỳ thỏa n·x=c (n là đơn vị)
  const L = Math.max(vb?.w || 1000, vb?.h || 1000) * 2; // đủ dài để phủ viewBox
  const p1 = [p0[0] - t[0] * L, p0[1] - t[1] * L];
  const p2 = [p0[0] + t[0] * L, p0[1] + t[1] * L];
  return [p1, p2];
}

// Diện tích có dấu (dương = CCW, âm = CW)
function signedArea(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}
function toCCW(openPoly) {
  if (!Array.isArray(openPoly) || openPoly.length < 3) return openPoly ?? [];
  // signedArea > 0 là CCW, còn lại thì đảo ngược để thành CCW
  return signedArea(openPoly) > 0 ? openPoly : [...openPoly].reverse();
}

// Đảm bảo đóng vòng (thêm điểm đầu vào cuối nếu cần)
function ensureClosedLoop(polyOpen) {
  if (!Array.isArray(polyOpen) || polyOpen.length < 3) return polyOpen ?? [];
  const first = polyOpen[0],
    last = polyOpen[polyOpen.length - 1];
  return ptsEqual(first, last) ? polyOpen : [...polyOpen, first];
}

// Sắp xếp các điểm theo góc quanh tâm → CCW, giữ ổn định cho điểm trùng
function normalizeCCW(points) {
  const poly = stripClosingDuplicate(points);
  if (!Array.isArray(poly) || poly.length < 3) return poly ?? [];

  // Tâm hình (centroid hình học)
  const [cx, cy] = polygonCentroid(poly);

  // Sắp xếp theo atan2 (góc), nếu trùng góc thì theo bán kính để ổn định
  const sorted = [...poly].sort((a, b) => {
    const angA = Math.atan2(a[1] - cy, a[0] - cx);
    const angB = Math.atan2(b[1] - cy, b[0] - cx);
    if (angA !== angB) return angA - angB;
    const ra = (a[0] - cx) * (a[0] - cx) + (a[1] - cy) * (a[1] - cy);
    const rb = (b[0] - cx) * (b[0] - cx) + (b[1] - cy) * (b[1] - cy);
    return ra - rb;
  });

  // Đảm bảo CCW: nếu diện tích không dương → đảo lại
  return signedArea(sorted) > 0 ? sorted : sorted.reverse();
}

// ---------- Frontage helpers ----------
function orient(a, b, c) {
  const v1x = b[0] - a[0],
    v1y = b[1] - a[1];
  const v2x = c[0] - a[0],
    v2y = c[1] - a[1];
  const cross = v1x * v2y - v1y * v2x;
  return Math.abs(cross) < 1e-9 ? 0 : cross > 0 ? 1 : -1;
}
function onSegment(a, b, p) {
  const minx = Math.min(a[0], b[0]) - 1e-9,
    maxx = Math.max(a[0], b[0]) + 1e-9;
  const miny = Math.min(a[1], b[1]) - 1e-9,
    maxy = Math.max(a[1], b[1]) + 1e-9;
  if (p[0] < minx || p[0] > maxx || p[1] < miny || p[1] > maxy) return false;
  return (
    Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) <
    1e-9
  );
}
function segmentsIntersectOrTouch(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

// --- Parallel-wall detection on polygon edges (no hull) ---
function _anglePi(vx, vy) {
  // góc chuẩn hoá về [0, π) để gom các hướng song song (ngược chiều coi như cùng hướng)
  let a = Math.atan2(vy, vx);
  if (a < 0) a += Math.PI; // -π..0 → 0..π
  if (a >= Math.PI) a -= Math.PI; // đề phòng tràn
  return a;
}
function _angDist(a, b) {
  let d = Math.abs(a - b);
  if (d > Math.PI / 2) d = Math.PI - d; // song song ngược chiều vẫn coi là gần
  return d;
}

/**
 * Tìm hướng d* là cụm góc có tổng độ dài cạnh lớn nhất (cụm song song chi phối).
 * Sau đó dựng 2 đường đỡ song song với d* (pháp tuyến n*), đo min/max chiếu theo n*,
 * nhưng CHỈ xét các đỉnh thuộc các cạnh gần-parallel với d* (loại loe ở lối vào).
 *
 * return {
 *   theta, d, n, minN, maxN, width, // width = maxN - minN
 *   usedEdgeIdxs // để debug nếu cần
 * }
 */
function dominantParallelWallsInfo(poly, angTolDeg = 10) {
  const edges = edgesFromPolygon(poly, true);
  if (!edges.length) return null;

  // 1) Gom cụm theo góc, trọng số = độ dài cạnh
  const tol = (angTolDeg * Math.PI) / 180;
  const items = edges
    .map(([a, b], i) => {
      const vx = b[0] - a[0],
        vy = b[1] - a[1];
      const len = Math.hypot(vx, vy);
      const th = _anglePi(vx, vy);
      return { i, a, b, len, th };
    })
    .filter((it) => it.len > 1e-9);

  if (!items.length) return null;
  items.sort((p, q) => p.th - q.th);

  let bestSum = -Infinity,
    bestTheta = 0,
    bestGroup = [];
  let start = 0;
  for (let i = 0; i < items.length; i++) {
    // cửa sổ động gom những cạnh có |Δθ| <= tol
    while (start <= i && _angDist(items[i].th, items[start].th) > tol) start++;
    let sum = 0;
    const group = [];
    for (let k = start; k <= i; k++) {
      sum += items[k].len;
      group.push(items[k]);
    }
    if (sum > bestSum) {
      bestSum = sum;
      // hướng đại diện = trung bình có trọng số theo độ dài
      let sx = 0,
        sy = 0;
      for (const it of group) {
        sx += Math.cos(it.th) * it.len;
        sy += Math.sin(it.th) * it.len;
      }
      bestTheta = Math.atan2(sy, sx);
      if (bestTheta < 0) bestTheta += Math.PI; // [0,π)
      bestGroup = group;
    }
  }

  // 2) Hướng dài d*, pháp tuyến n*
  const d = [Math.cos(bestTheta), Math.sin(bestTheta)];
  const n = [-d[1], d[0]];

  // 3) Lấy TẬP ĐỈNH chỉ từ các cạnh gần-parallel với d* (lọc flare lối vào)
  const used = [];
  const pts = [];
  for (const it of items) {
    if (_angDist(it.th, bestTheta) <= tol) {
      pts.push(it.a, it.b);
      used.push(it.i);
    }
  }
  if (!pts.length) return null;

  // 4) Hai đường đỡ song song: n·x = minN và n·x = maxN (chỉ xét pts từ nhóm song song)
  let minN = Infinity,
    maxN = -Infinity;
  for (const p of pts) {
    const pn = dot(p, n);
    if (pn < minN) minN = pn;
    if (pn > maxN) maxN = pn;
  }

  const width = Math.max(0, maxN - minN);
  // Độ dài theo trục d (dùng toàn bộ đỉnh polygon để ổn định)
  const ptsAll = stripClosingDuplicate(poly || []);
  let minD = Infinity,
    maxD = -Infinity;
  for (const p of ptsAll) {
    const pd = dot(p, d);
    if (pd < minD) minD = pd;
    if (pd > maxD) maxD = pd;
  }
  const length = Math.max(0, maxD - minD);
  return {
    theta: bestTheta,
    d,
    n,
    minN,
    maxN,
    width: Number(width.toFixed(2)),
    minD,
    maxD,
    length: Number(length.toFixed(2)),
    usedEdgeIdxs: used,
  };
}

function edgesFromPolygon(poly, closed = true) {
  const segs = [];
  if (!poly || poly.length < 2) return segs;
  for (let i = 0; i < poly.length - 1; i++) segs.push([poly[i], poly[i + 1]]);
  if (closed && poly.length >= 3) segs.push([poly[poly.length - 1], poly[0]]);
  return segs;
}
function pathSegsBetweenIndices(boundary, iFrom, iTo) {
  const segs = [];
  let i = iFrom;
  while (i !== iTo) {
    const j = (i + 1) % boundary.length;
    segs.push([boundary[i], boundary[j]]);
    i = j;
  }
  return segs;
}
function nearestBoundaryIndex(pt, boundary) {
  let bestI = -1,
    bestD = Infinity;
  for (let i = 0; i < boundary.length; i++) {
    const d = distance(pt, boundary[i]);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return bestI;
}
function segmentDistance(a, b, c, d) {
  const d1 = pointSegProjection(a, c, d).d2;
  const d2 = pointSegProjection(b, c, d).d2;
  const d3 = pointSegProjection(c, a, b).d2;
  const d4 = pointSegProjection(d, a, b).d2;
  return Math.sqrt(Math.min(d1, d2, d3, d4));
}

/** Front road for lot: internal > public-by-boundary between first two EPs of each public road */
function computeFrontRoadForLot(lotPoly, ctx, tolUnits = 0) {
  const { boundary, boundaryClosed, publicRoads, internalRoads } = ctx || {};
  if (!lotPoly || lotPoly.length < 3) return null;
  const lotEdges = edgesFromPolygon(lotPoly, true);

  if (Array.isArray(internalRoads)) {
    for (const r of internalRoads) {
      const roadEdges = edgesFromPolygon(r.polygon, true);
      let touch = false;
      for (const [a, b] of lotEdges) {
        for (const [c, d] of roadEdges) {
          if (segmentsIntersectOrTouch(a, b, c, d)) {
            touch = true;
            break;
          }
          if (tolUnits > 0 && segmentDistance(a, b, c, d) <= tolUnits) {
            touch = true;
            break;
          }
        }
        if (touch) break;
      }
      if (touch) return r.road_id;
    }
  }

  if (
    boundaryClosed &&
    Array.isArray(boundary) &&
    boundary.length >= 3 &&
    Array.isArray(publicRoads)
  ) {
    for (const pr of publicRoads) {
      if (!pr?.entry_points || pr.entry_points.length < 2) continue;
      const iA = nearestBoundaryIndex(pr.entry_points[0], boundary);
      const iB = nearestBoundaryIndex(pr.entry_points[1], boundary);
      if (iA === -1 || iB === -1 || iA === iB) continue;
      const segsAB = pathSegsBetweenIndices(boundary, iA, iB);
      const segsBA = pathSegsBetweenIndices(boundary, iB, iA);
      const len = (ss) =>
        ss.reduce(
          (s, [[x1, y1], [x2, y2]]) => s + Math.hypot(x2 - x1, y2 - y1),
          0
        );
      const pubSegs = len(segsAB) <= len(segsBA) ? segsAB : segsBA;

      for (const [a, b] of lotEdges) {
        for (const [c, d] of pubSegs) {
          if (segmentsIntersectOrTouch(a, b, c, d)) return pr.road_id;
          if (tolUnits > 0 && segmentDistance(a, b, c, d) <= tolUnits)
            return pr.road_id;
        }
      }
    }
  }
  return null;
}

// ---------- Oriented Bounding Box width for "road" ----------
function meanXY(pts) {
  const n = pts.length || 1;
  let sx = 0,
    sy = 0;
  for (const [x, y] of pts) {
    sx += x;
    sy += y;
  }
  return [sx / n, sy / n];
}
function covarianceAngle(pts) {
  if (!pts || pts.length < 2) return 0;
  const [mx, my] = meanXY(pts);
  let sxx = 0,
    syy = 0,
    sxy = 0;
  for (const [x, y] of pts) {
    const dx = x - mx,
      dy = y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // principal axis angle (radians)
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy || 1e-12);
  return theta;
}
function rotatePointAround(p, cx, cy, theta) {
  const cos = Math.cos(theta),
    sin = Math.sin(theta);
  const dx = p[0] - cx,
    dy = p[1] - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}
function orientedDims(poly) {
  // dùng PCA để xoay theo trục chính, lấy bbox trục song song
  if (!poly || poly.length < 2) return { length: 0, width: 0, angle: 0 };
  const theta = covarianceAngle(poly);
  const [cx, cy] = polygonCentroid(
    poly.length >= 3 ? poly : [poly[0], poly[poly.length - 1], poly[0]]
  );
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const p of poly) {
    const [rx, ry] = rotatePointAround(p, cx, cy, -theta);
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  }
  return { length: maxX - minX, width: maxY - minY, angle: theta };
}

function estimateRoadWidth(poly) {
  // Bước 1: đúng yêu cầu — xác định 2 đường đỡ song song của polygon trước
  const info = dominantParallelWallsInfo(poly, 10); // ±10° gom cạnh song song
  if (info && isFinite(info.width) && info.width > 0) {
    return Number(info.width.toFixed(2));
  }

  // Bước 2 (dự phòng hiếm khi cần): fallback về cross-section robust đã có,
  // nhưng vẫn cắt 2 đầu để tránh lối vào
  const inf2 = maxLengthDirInfo(poly); // hướng dài nhất toàn hình
  const d = inf2.d,
    n = inf2.n;
  const L = inf2.maxD - inf2.minD;
  if (!isFinite(L) || L <= 0) return 0;

  const TRIM_FRAC = 0.25;
  const SAMPLES = 61;
  const a = inf2.minD + TRIM_FRAC * L;
  const b = inf2.maxD - TRIM_FRAC * L;
  if (b <= a) return 0;

  let wMin = Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const t = a + ((i + 0.5) * (b - a)) / SAMPLES;
    const w = crossSectionWidthAt(poly, d, n, t);
    if (isFinite(w) && w > 0 && w < wMin) wMin = w;
  }
  if (!isFinite(wMin)) wMin = 0;
  return Number(wMin.toFixed(2));
}

// ---------- Main Component ----------
export default function LandSubdivisionApp() {
  const [showWidthDebug, setShowWidthDebug] = useState(false);

  const [landId, setLandId] = useState("L001");
  const [mode, setMode] = useState("boundary"); // boundary|publicRoad|internalRoad|lot|select

  const svgRef = useRef(null);
  const [current, setCurrent] = useState([]); // drawing points
  const [hover, setHover] = useState(null);

  const [boundary, setBoundary] = useState([]); // [[x,y], ...]
  const [boundaryClosed, setBoundaryClosed] = useState(false);

  // Public roads
  const [publicRoads, setPublicRoads] = useState([]); // [{road_id,is_public:true,width,entry_points:[[x,y],...]}]
  const [defaultPublicWidth, setDefaultPublicWidth] = useState(12);
  const [activePublicIdx, setActivePublicIdx] = useState(-1);

  // Lots
  const [lots, setLots] = useState([]); // [{lot_id, polygon:[[x,y]], front_road}]

  // Snap
  const [snapTol, setSnapTol] = useState(4);
  const [lineTol, setLineTol] = useState(4);

  // Grid
  const [gridSnap, setGridSnap] = useState(true);
  const [gridStep, setGridStep] = useState(1);
  const [gridTol, setGridTol] = useState(8);
  const [gridStrict, setGridStrict] = useState(true);
  const [gridOrigin, setGridOrigin] = useState({ x: 0, y: 0 });
  function snapToGrid(p, step, origin, tolUnits, always = false) {
    if (!step || step <= 0) return p;
    const gx = Math.round((p[0] - origin.x) / step) * step + origin.x;
    const gy = Math.round((p[1] - origin.y) / step) * step + origin.y;
    const g = [Number(gx.toFixed(2)), Number(gy.toFixed(2))];
    if (always) return g;
    return distance(p, g) <= tolUnits ? g : p;
  }

  // --- History (Undo/Redo) ---
  const [history, setHistory] = useState([]); // mảng snapshots quá khứ
  const [future, setFuture] = useState([]); // mảng snapshots tương lai (redo)

  function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function makeSnapshot() {
    return {
      boundary: deepCopy(boundary),
      boundaryClosed: !!boundaryClosed,
      publicRoads: deepCopy(publicRoads),
      internalRoads: deepCopy(internalRoads),
      lots: deepCopy(lots),
      // không lưu current/hover/selection/dragging để tránh undo “con trỏ”
    };
  }

  function restoreSnapshot(s) {
    setBoundary(s.boundary || []);
    setBoundaryClosed(!!s.boundaryClosed);
    setPublicRoads(s.publicRoads || []);
    setInternalRoads(s.internalRoads || []);
    setLots(s.lots || []);
  }

  function pushHistory() {
    // gọi TRƯỚC khi thay đổi dữ liệu
    setHistory((h) => [...h, makeSnapshot()]);
    setFuture([]); // clear redo khi có act mới
  }

  function undoHistory() {
    setHistory((h) => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      // đẩy trạng thái hiện tại sang future để có thể redo
      setFuture((f) => [makeSnapshot(), ...f]);
      restoreSnapshot(prev);
      return h.slice(0, -1);
    });
  }

  function redoHistory() {
    setFuture((f) => {
      if (!f.length) return f;
      const next = f[0];
      // đẩy hiện tại vào history để có thể undo lại
      setHistory((h) => [...h, makeSnapshot()]);
      restoreSnapshot(next);
      return f.slice(1);
    });
  }

  // Smart undo: ưu tiên “undo khi đang vẽ”, nếu không thì dùng history
  function smartUndo() {
    if (
      current.length &&
      (mode === "boundary" || mode === "internalRoad" || mode === "lot")
    ) {
      setCurrent((cur) => cur.slice(0, -1));
    } else {
      undoHistory();
    }
  }

  // Auto-scale new
  const [autoScaleNew, setAutoScaleNew] = useState(false);
  const [autoTargetArea, setAutoTargetArea] = useState(200);
  const [autoApplyTo, setAutoApplyTo] = useState({
    lot: false,
    boundary: false,
    internalRoad: false,
  });

  // Internal roads (polygons)
  const [internalWidthDefault, setInternalWidthDefault] = useState(6);
  const [internalRoads, setInternalRoads] = useState([]); // [{road_id, polygon:[[x,y]], width}]
  const [autoInternalWidth, setAutoInternalWidth] = useState(true); // NEW

  // ViewBox zoom/pan
  const canvasW = 1000,
    canvasH = 640;
  const ZOOM_BASE = 8;
  const baseView = {
    x: 0,
    y: 0,
    w: canvasW / ZOOM_BASE,
    h: canvasH / ZOOM_BASE,
  };
  const [viewBox, setViewBox] = useState(baseView);
  const zoomPercent = Math.round((canvasW / viewBox.w) * (100 / ZOOM_BASE));

  // Constant-size markers
  const [unitsPerPx, setUnitsPerPx] = useState({
    x: viewBox.w / canvasW,
    y: viewBox.h / canvasH,
  });
  const __avgUP = Math.max((unitsPerPx.x + unitsPerPx.y) / 2, 1e-6);
  const R_POINT = 4 * __avgUP;
  const R_EP = 6 * __avgUP;
  const R_HANDLE = 5 * __avgUP;
  const FONT_UNIT = 12 * unitsPerPx.y;
  const DX_LABEL = 8 * unitsPerPx.x;
  const DY_LABEL = 8 * unitsPerPx.y;

  // === Cursor badge state + label map ===
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0, show: false });

  const MODE_LABELS = {
    boundary: "Boundary",
    publicRoad: "Public EP",
    internalRoad: "Internal",
    lot: "Lot",
    select: "Select/Edit",
  };

  // Badge offset theo pixel màn hình (sẽ quy đổi sang đơn vị viewBox)
  const [badgeOffsetPx, setBadgeOffsetPx] = useState({ dx: 14, dy: -14 });

  // Màu cho từng mode (bg = nền, text = chữ)
  const MODE_COLORS = {
    boundary: { bg: "#000000ff", text: "#ffffff" }, // purple-600
    publicRoad: { bg: "#059669", text: "#ffffff" }, // emerald-600
    internalRoad: { bg: "#d97706", text: "#ffffff" }, // amber-600
    lot: { bg: "#1d4ed8", text: "#ffffff" }, // blue-700
    select: { bg: "#a21caf", text: "#ffffff" }, // fuchsia-700
  };
  // fallback khi gặp mode lạ
  const DEFAULT_MODE_COLOR = { bg: "#111827", text: "#ffffff" }; // slate-900

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const recalc = () => {
      const rect = svg.getBoundingClientRect();
      const w = rect.width || canvasW;
      const h = rect.height || canvasH;
      setUnitsPerPx({ x: viewBox.w / w, y: viewBox.h / h });
    };
    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const w = rect.width || canvasW;
    const h = rect.height || canvasH;
    setUnitsPerPx({ x: viewBox.w / w, y: viewBox.h / h });
  }, [viewBox]);

  // IDs
  function nextGlobalRoadId() {
    const ids = new Set([
      ...internalRoads.map((r) => r.road_id),
      ...publicRoads.map((r) => r.road_id),
    ]);
    let n = 1;
    while (ids.has(`R${String(n).padStart(3, "0")}`)) n++;
    return `R${String(n).padStart(3, "0")}`;
  }
  const nextInternalRoadId = () => nextGlobalRoadId();
  const nextLotId = () =>
    `${landId}-${String(lots.length + 1).padStart(2, "0")}`;

  // Scale panel
  const [scalePct, setScalePct] = useState(100);
  const [targetArea, setTargetArea] = useState(0);
  const [anchorType, setAnchorType] = useState("centroid");
  const [anchorX, setAnchorX] = useState(0);
  const [anchorY, setAnchorY] = useState(0);
  function getAnchor() {
    if (anchorType === "origin") return [0, 0];
    if (anchorType === "custom")
      return [Number(anchorX) || 0, Number(anchorY) || 0];
    if (boundary && boundary.length >= 1) return polygonCentroid(boundary);
    const all = [
      ...boundary,
      ...publicRoads.flatMap((r) => r.entry_points),
      ...internalRoads.flatMap((r) => r.polygon),
      ...lots.flatMap((l) => l.polygon),
    ];
    if (!all.length) return [0, 0];
    const sx = all.reduce((a, p) => a + p[0], 0);
    const sy = all.reduce((a, p) => a + p[1], 0);
    return [sx / all.length, sy / all.length];
  }
  function applyScaleFactor(s) {
    if (!isFinite(s) || s <= 0) return;
    const [cx, cy] = getAnchor();
    setBoundary((b) => b.map((pt) => transformPoint(pt, s, cx, cy)));
    setCurrent((cur) => cur.map((pt) => transformPoint(pt, s, cx, cy)));
    setPublicRoads((rs) =>
      rs.map((r) => ({
        ...r,
        entry_points: r.entry_points.map((pt) => transformPoint(pt, s, cx, cy)),
      }))
    );
    setInternalRoads((rs) =>
      rs.map((r) => ({
        ...r,
        polygon: r.polygon.map((pt) => transformPoint(pt, s, cx, cy)),
      }))
    );
    setLots((ls) =>
      ls.map((l) => ({
        ...l,
        polygon: l.polygon.map((pt) => transformPoint(pt, s, cx, cy)),
      }))
    );
  }
  function onApplyScalePct() {
    const s = Number(scalePct) / 100;
    applyScaleFactor(s);
  }
  const boundaryArea = boundary.length >= 3 ? shoelaceArea(boundary) : 0;
  function onScaleToArea() {
    if (boundaryArea <= 0) return;
    const t = Number(targetArea);
    if (!isFinite(t) || t <= 0) return;
    const s = Math.sqrt(t / boundaryArea);
    applyScaleFactor(s);
  }

  // ViewBox helpers
  function zoomAt(ux, uy, factor) {
    setViewBox((vb) => {
      const w2 = vb.w / factor;
      const h2 = vb.h / factor;
      const ax = (ux - vb.x) / vb.w;
      const ay = (uy - vb.y) / vb.h;
      const x2 = ux - ax * w2;
      const y2 = uy - ay * h2;
      return { x: x2, y: y2, w: w2, h: h2 };
    });
  }
  function zoomOutCenter() {
    setViewBox((vb) => {
      const cx = vb.x + vb.w / 2,
        cy = vb.y + vb.h / 2;
      const factor = 1.2;
      const w2 = vb.w * factor,
        h2 = vb.h * factor;
      return { x: cx - w2 / 2, y: cy - h2 / 2, w: w2, h: h2 };
    });
  }
  function resetView() {
    setViewBox(baseView);
  }
  function getAllPoints() {
    return [
      ...boundary,
      ...publicRoads.flatMap((r) => r.entry_points),
      ...internalRoads.flatMap((r) => r.polygon),
      ...lots.flatMap((l) => l.polygon),
      ...current,
    ];
  }

  function fitView() {
    const pts = getAllPoints();
    if (!pts.length) {
      resetView();
      return;
    }

    // Bbox của toàn bộ hình
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);

    // Tỉ lệ khung hiển thị thực tế (px) để tính viewBox đối xứng theo aspect
    const svg = svgRef.current;
    const rect = svg?.getBoundingClientRect();
    const elW = rect?.width || canvasW;
    const elH = rect?.height || canvasH;
    const aspect = elW / elH;

    // Margin 10%
    const margin = 0.1;
    const mw = w * margin;
    const mh = h * margin;

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    if (h >= w) {
      // Hình CAO hơn RỘNG → fit theo CHIỀU CAO
      const viewH = h + 2 * mh;
      const viewW = viewH * aspect; // khớp chiều cao, suy ra chiều rộng theo aspect
      const x = centerX - viewW / 2; // căn giữa theo X
      const y = minY - mh; // dính mép trên theo margin
      setViewBox({ x, y, w: viewW, h: viewH });
    } else {
      // Hình RỘNG hơn CAO → fit theo CHIỀU RỘNG
      const viewW = w + 2 * mw;
      const viewH = viewW / aspect; // khớp chiều rộng, suy ra chiều cao theo aspect
      const x = minX - mw; // dính mép trái theo margin
      const y = centerY - viewH / 2; // căn giữa theo Y
      setViewBox({ x, y, w: viewW, h: viewH });
    }
  }

  // Pointer → SVG coords
  function clientToSvg(e) {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const { x, y } = pt.matrixTransform(svg.getScreenCTM().inverse());
    return [parseFloat(x.toFixed(2)), parseFloat(y.toFixed(2))];
  }

  function collectSegments(
    boundary,
    boundaryClosed,
    current,
    internalRoads,
    lots
  ) {
    const segs = [];
    const addSegs = (poly, closed) => {
      if (!poly || poly.length < 2) return;
      for (let i = 0; i < poly.length - 1; i++)
        segs.push([poly[i], poly[i + 1]]);
      if (closed && poly.length >= 3)
        segs.push([poly[poly.length - 1], poly[0]]);
    };
    addSegs(boundary, boundaryClosed);
    addSegs(current, false);
    for (const r of internalRoads) addSegs(r.polygon, true);
    for (const l of lots) addSegs(l.polygon, true);
    return segs;
  }

  function computePreviewPoint(e) {
    const raw0 = clientToSvg(e);
    if (!raw0) return null;

    let prev = null;
    if (mode === "boundary" && !boundaryClosed && current.length)
      prev = current[current.length - 1];
    else if ((mode === "internalRoad" || mode === "lot") && current.length)
      prev = current[current.length - 1];
    else if (mode === "publicRoad" && activePublicIdx >= 0) {
      const act = publicRoads[activePublicIdx];
      if (act?.entry_points?.length)
        prev = act.entry_points[act.entry_points.length - 1];
    }

    const aligned =
      e.shiftKey && prev && mode !== "select" ? axisAlign(prev, raw0) : raw0;

    const tolUnitsGrid = gridTol * __avgUP;
    let p1 = gridSnap
      ? snapToGrid(aligned, gridStep, gridOrigin, tolUnitsGrid, gridStrict)
      : aligned;

    const segments = collectSegments(
      boundary,
      boundaryClosed,
      current,
      internalRoads,
      lots
    );
    let p2 = p1;
    if (segments && segments.length) {
      const proj = snapToNearestSegment(aligned, segments, lineTol * __avgUP);
      if (proj) {
        const dGrid = distance(aligned, p1);
        const dLine = distance(aligned, proj);
        p2 =
          dLine <= dGrid
            ? [Number(proj[0].toFixed(2)), Number(proj[1].toFixed(2))]
            : p1;
      }
    }

    const pools = [];
    if (boundary.length) pools.push(boundary);
    for (const pr of publicRoads)
      if (pr.entry_points.length) pools.push(pr.entry_points);
    if (current.length) {
      const poolExceptLast = current.slice(0, -1);
      if (poolExceptLast.length) pools.push(poolExceptLast);
    }
    for (const r of internalRoads) pools.push(r.polygon);
    for (const l of lots) pools.push(l.polygon);

    return snapToPools(p2, pools, snapTol * __avgUP);
  }

  // ------------- Drawing clicks -------------
  function onCanvasClick(e) {
    if (mode === "select") {
      // selection handled in pointer down (drag start). No action here to avoid deselect-on-click.
      return;
    }

    const p = computePreviewPoint(e);
    if (!p) return;

    if (mode === "boundary") {
      if (boundaryClosed) return;
      setCurrent((cur) => dedupPush(cur, p));
    } else if (mode === "publicRoad") {
      let point = p;
      if (boundaryClosed && boundary.length >= 2) {
        const segs = collectSegments(boundary, true, [], [], []);
        const proj = snapToNearestSegment(p, segs, lineTol * __avgUP);
        if (proj) point = proj;
      }
      setPublicRoads((roads) => {
        let idx = activePublicIdx;
        if (idx < 0) {
          const newRoad = {
            road_id: nextGlobalRoadId(),
            is_public: true,
            width: defaultPublicWidth,
            entry_points: [],
            connected_to_public_road: null,
            road_to_lot_mapping: [],
          };
          roads = [...roads, newRoad];
          idx = roads.length - 1;
          setActivePublicIdx(idx);
        }
        const r = roads[idx];
        const snapped = snapToPools(
          point,
          [boundary, r.entry_points],
          snapTol * __avgUP
        );
        if (r.entry_points.some((q) => Math.sqrt(dist2(q, snapped)) <= 1e-6))
          return roads;
        const updated = [...roads];
        updated[idx] = { ...r, entry_points: [...r.entry_points, snapped] };
        return updated;
      });
    } else if (mode === "internalRoad" || mode === "lot") {
      setCurrent((cur) => dedupPush(cur, p));
    }
  }

  function onMouseMove(e) {
    const p = computePreviewPoint(e);
    setHover(p);

    // NEW: lưu vị trí con trỏ theo toạ độ SVG
    const raw = clientToSvg(e);
    if (raw) setCursorPos({ x: raw[0], y: raw[1], show: true });

    if (dragging) onDragMove(e);
  }

  function onMouseLeave() {
    setHover(null);
    setCursorPos((cp) => ({ ...cp, show: false })); // NEW
    if (dragging) endDrag();
  }

  function closeShape() {
    if (mode === "boundary" && current.length >= 3) {
      let poly = current;
      if (autoScaleNew && autoApplyTo.boundary)
        poly = scalePolygonToArea(poly, Number(autoTargetArea));
      pushHistory();
      setBoundary(poly);
      setBoundaryClosed(true);
      setCurrent([]);
      setHover(null);
    } else if (mode === "internalRoad" && current.length >= 3) {
      let poly = current;
      if (autoScaleNew && autoApplyTo.internalRoad)
        poly = scalePolygonToArea(poly, Number(autoTargetArea));
      const id = nextInternalRoadId();

      const computedW = autoInternalWidth
        ? estimateRoadWidth(poly)
        : internalWidthDefault;

      setInternalRoads((rs) => [
        ...rs,
        {
          road_id: id,
          polygon: poly,
          is_public: false,
          width: computedW, // CHANGED
          connected_to_public_road: true,
          road_to_lot_mapping: [],
        },
      ]);
      setCurrent([]);
      setHover(null);
    } else if (mode === "lot" && current.length >= 3) {
      let poly = current;
      if (autoScaleNew && autoApplyTo.lot)
        poly = scalePolygonToArea(poly, Number(autoTargetArea));
      const id = nextLotId();
      setLots((ls) => [...ls, { lot_id: id, polygon: poly, front_road: null }]);
      setCurrent([]);
      setHover(null);
    }
  }

  function clearAll() {
    setCurrent([]);
    setBoundary([]);
    setBoundaryClosed(false);
    setPublicRoads([]);
    setActivePublicIdx(-1);
    setInternalRoads([]);
    setLots([]);
    setSelection(null);
    setDragging(null);
    setHover(null);
  }

  function drawPointLabels(poly, color = "#555") {
    return poly.map((p, i) => (
      <text
        key={`ptlabel-${i}-${p[0]}-${p[1]}`}
        x={p[0] + DX_LABEL}
        y={p[1] + DY_LABEL}
        fontSize={FONT_UNIT * 0.8}
        fill={color}
      >
        ({p[0].toFixed(1)}, {p[1].toFixed(1)})
      </text>
    ));
  }

  // Export
  function exportPNG(filename = `${landId}_subdivision.png`, opts = {}) {
    const svg = svgRef.current;
    if (!svg) return;
    const vb = viewBox;
    const aspect = vb.h / vb.w;
    const exportW = opts.width || 2000;
    const exportH = Math.round(exportW * aspect);

    const clone = svg.cloneNode(true);
    clone.removeAttribute("class");
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    clone.setAttribute("width", String(exportW));
    clone.setAttribute("height", String(exportH));
    clone.setAttribute("preserveAspectRatio", "xMidYMid meet");

    try {
      const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bg.setAttribute("x", String(vb.x));
      bg.setAttribute("y", String(vb.y));
      bg.setAttribute("width", String(vb.w));
      bg.setAttribute("height", String(vb.h));
      bg.setAttribute("fill", "#ffffff");
      const first = clone.firstElementChild;
      if (first && first.tagName && first.tagName.toLowerCase() === "defs") {
        clone.insertBefore(bg, first.nextSibling);
      } else {
        clone.insertBefore(bg, first || null);
      }
    } catch (_) {}

    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(clone);
    const svgBlob = new Blob([svgString], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = exportW;
      canvas.height = exportH;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, exportW, exportH);
      canvas.toBlob(
        (blob) => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(a.href);
          URL.revokeObjectURL(url);
        },
        "image/png",
        1.0
      );
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }
  function exportJSON() {
    // Boundary: sắp xếp CCW + đóng vòng nếu đủ điểm
    const boundaryOpen = normalizeCCW(boundary);
    const boundaryClosedLoop =
      boundaryOpen.length >= 3 ? ensureClosedLoop(boundaryOpen) : boundaryOpen;

    // Ngữ cảnh để tính front_road dùng boundary "open"
    const ctx = {
      boundary: boundaryOpen,
      boundaryClosed: boundaryOpen.length >= 3,
      publicRoads,
      internalRoads,
    };
    const tolUnits = 3 * __avgUP;

    // Lots: chuẩn hoá CCW + area + front_road
    const lotInfos = lots.map((l, idx) => {
      const id = l.lot_id ?? `${landId}-${String(idx + 1).padStart(2, "0")}`;
      const polyOpen = normalizeCCW(l.polygon);
      const area = Number(shoelaceArea(polyOpen).toFixed(1));
      const front = computeFrontRoadForLot(polyOpen, ctx, tolUnits) ?? null;
      return { id, polygonOpen: polyOpen, area, front };
    });

    // Public roads giữ nguyên EPs
    const publicRoadsOut = publicRoads.map((pr) => {
      const lotIds = lotInfos
        .filter((li) => li.front === pr.road_id)
        .map((li) => li.id);
      return {
        road_id: pr.road_id,
        is_public: true,
        width: Number(pr.width ?? defaultPublicWidth),
        entry_points: pr.entry_points,
        connected_to_public_road: null,
        road_to_lot_mapping: lotIds,
      };
    });

    // Internal roads: chuẩn hoá CCW + đóng vòng
    const internalRoadsOut = internalRoads.map((r) => {
      const polyOpen = normalizeCCW(r.polygon);
      const lotIds = lotInfos
        .filter((li) => li.front === r.road_id)
        .map((li) => li.id);
      return {
        road_id: r.road_id,
        polygon: polyOpen.length >= 3 ? ensureClosedLoop(polyOpen) : polyOpen,
        is_public: false,
        width: Number(r.width ?? internalWidthDefault),
        connected_to_public_road: true,
        road_to_lot_mapping: lotIds,
      };
    });

    const out = {
      input: {
        land_id: landId,
        boundary: boundaryClosedLoop,
        roads: publicRoadsOut,
      },
      output: {
        internal_roads: internalRoadsOut,
        lots: lotInfos.map((li) => ({
          lot_id: li.id,
          polygon:
            li.polygonOpen.length >= 3
              ? ensureClosedLoop(li.polygonOpen)
              : li.polygonOpen,
          area: li.area,
          front_road: li.front,
        })),
      },
    };

    download(`${landId}_subdivision.json`, JSON.stringify(out, null, 2));
    exportPNG();
  }

  // ------------- Select/Edit -------------
  // selection: null | { kind, index, vertexIndex?, edgeIndex? }
  // kind: 'boundary'|'internal'|'lot'|'publicEP'
  const [selection, setSelection] = useState(null);

  // dragging: null | { type:'vertex'|'edge', kind, index, vertexIndex?/edgeIndex, startMouse:[x,y], startGeom:... , shiftEdge:boolean }
  const [dragging, setDragging] = useState(null);

  function hitTestVertex(p, tol) {
    // priority: vertices of lots/internal/boundary/public EPs
    // return {kind,index,vertexIndex} or for public EP: {kind:'publicEP', index:roadIdx, vertexIndex:epIdx}
    // lots
    for (let i = 0; i < lots.length; i++) {
      const poly = lots[i].polygon;
      for (let j = 0; j < poly.length; j++)
        if (distance(poly[j], p) <= tol)
          return { kind: "lot", index: i, vertexIndex: j };
    }
    // internal
    for (let i = 0; i < internalRoads.length; i++) {
      const poly = internalRoads[i].polygon;
      for (let j = 0; j < poly.length; j++)
        if (distance(poly[j], p) <= tol)
          return { kind: "internal", index: i, vertexIndex: j };
    }
    // boundary
    if (boundaryClosed) {
      for (let j = 0; j < boundary.length; j++)
        if (distance(boundary[j], p) <= tol)
          return { kind: "boundary", index: 0, vertexIndex: j };
    }
    // public EPs
    for (let r = 0; r < publicRoads.length; r++) {
      const eps = publicRoads[r].entry_points;
      for (let j = 0; j < eps.length; j++)
        if (distance(eps[j], p) <= tol)
          return { kind: "publicEP", index: r, vertexIndex: j };
    }
    return null;
  }

  function hitTestEdge(p, tol) {
    // return {kind,index,edgeIndex} meaning edge between points[k] and points[(k+1)%n]
    function checkPoly(kind, idx, poly) {
      if (poly.length < 2) return null;
      const n = poly.length;
      for (let k = 0; k < n; k++) {
        const a = poly[k],
          b = poly[(k + 1) % n];
        const { d2 } = pointSegProjection(p, a, b);
        if (Math.sqrt(d2) <= tol) return { kind, index: idx, edgeIndex: k };
      }
      return null;
    }
    for (let i = 0; i < lots.length; i++) {
      const hit = checkPoly("lot", i, lots[i].polygon);
      if (hit) return hit;
    }
    for (let i = 0; i < internalRoads.length; i++) {
      const hit = checkPoly("internal", i, internalRoads[i].polygon);
      if (hit) return hit;
    }
    if (boundaryClosed) {
      const hit = checkPoly("boundary", 0, boundary);
      if (hit) return hit;
    }
    return null;
  }

  function onPointerDown(e) {
    const p0 = clientToSvg(e); // NEW
    if (p0) setCursorPos({ x: p0[0], y: p0[1], show: true }); // NEW

    if (mode !== "select") return;
    const p = clientToSvg(e);
    if (!p) return;
    const tol = 6 * __avgUP;

    // vertex first
    const vhit = hitTestVertex(p, tol);
    if (vhit) {
      setSelection(vhit);
      pushHistory();
      setDragging({
        type: "vertex",
        kind: vhit.kind,
        index: vhit.index,
        vertexIndex: vhit.vertexIndex,
        startMouse: p,
        startGeom: getGeomSnapshot(vhit),
        shiftEdge: false,
      });
      return;
    }
    // then edge
    const ehit = hitTestEdge(p, tol);
    if (ehit) {
      setSelection(ehit);
      pushHistory();
      setDragging({
        type: "edge",
        kind: ehit.kind,
        index: ehit.index,
        edgeIndex: ehit.edgeIndex,
        startMouse: p,
        startGeom: getGeomSnapshot(ehit),
        shiftEdge: e.shiftKey, // Shift = move along normal (extend)
      });
      return;
    }
    // none
    setSelection(null);
  }
  function onPointerUp() {
    if (dragging) endDrag();
  }
  function endDrag() {
    setDragging(null);
    // NEW: nếu vừa chỉnh polygon internal và đang bật autoInternalWidth → tính lại width
    if (
      autoInternalWidth &&
      selection?.kind === "internal" &&
      selection.index != null
    ) {
      setInternalRoads((rs) => {
        const u = [...rs];
        const poly = u[selection.index]?.polygon || [];
        const w = estimateRoadWidth(poly);
        if (isFinite(w) && w > 0) {
          u[selection.index] = { ...u[selection.index], width: w };
        }
        return u;
      });
    }
  }

  function getGeomSnapshot(sel) {
    if (!sel) return null;
    switch (sel.kind) {
      case "lot":
        return JSON.parse(JSON.stringify(lots[sel.index].polygon));
      case "internal":
        return JSON.parse(JSON.stringify(internalRoads[sel.index].polygon));
      case "boundary":
        return JSON.parse(JSON.stringify(boundary));
      case "publicEP":
        return JSON.parse(JSON.stringify(publicRoads[sel.index].entry_points));
      default:
        return null;
    }
  }

  function applyGeom(kind, index, newPolyOrEPs) {
    if (kind === "lot") {
      setLots((ls) => {
        const u = [...ls];
        u[index] = { ...u[index], polygon: newPolyOrEPs };
        return u;
      });
    } else if (kind === "internal") {
      setInternalRoads((rs) => {
        const u = [...rs];
        u[index] = { ...u[index], polygon: newPolyOrEPs };
        return u;
      });
    } else if (kind === "boundary") {
      setBoundary(newPolyOrEPs);
      setBoundaryClosed(newPolyOrEPs.length >= 3);
    } else if (kind === "publicEP") {
      setPublicRoads((prs) => {
        const u = [...prs];
        u[index] = { ...u[index], entry_points: newPolyOrEPs };
        return u;
      });
    }
  }

  function onDragMove(e) {
    const d = dragging;
    if (!d) return;
    const p = clientToSvg(e);
    if (!p) return;
    // NEW: luôn cập nhật badge khi đang drag
    setCursorPos((cp) => ({ ...cp, x: p[0], y: p[1], show: true }));

    // delta vector
    const dx = p[0] - d.startMouse[0];
    const dy = p[1] - d.startMouse[1];

    if (d.type === "vertex") {
      // move a single vertex (with grid/line/vertex snap capability via computePreviewPoint)
      const snapped = computePreviewPoint(e) ?? p;
      const polyOrEP = JSON.parse(JSON.stringify(d.startGeom));
      if (d.kind === "publicEP") {
        polyOrEP[d.vertexIndex] = snapped;
      } else {
        polyOrEP[d.vertexIndex] = snapped;
      }
      applyGeom(d.kind, d.index, polyOrEP);
    } else if (d.type === "edge") {
      // move two vertices of the edge
      if (d.kind === "publicEP") return; // edges not defined for EPs
      const startPoly = JSON.parse(JSON.stringify(d.startGeom));
      const n = startPoly.length;
      if (n < 2) return;
      const i = d.edgeIndex;
      const i2 = (i + 1) % n;

      // base edge vector
      const a0 = startPoly[i],
        b0 = startPoly[i2];
      const vx = b0[0] - a0[0];
      const vy = b0[1] - a0[1];

      let moveAx = dx,
        moveAy = dy,
        moveBx = dx,
        moveBy = dy;

      if (d.shiftEdge) {
        // Shift: move along the normal of edge (extend/offset)
        // choose a unit normal; sign determined by polygon orientation to make "outward" roughly consistent
        const len = Math.hypot(vx, vy) || 1;
        let nx = -vy / len,
          ny = vx / len; // left normal of the edge
        // keep movement only along normal: project (dx,dy) onto (nx,ny)
        const proj = dx * nx + dy * ny;
        moveAx = nx * proj;
        moveAy = ny * proj;
        moveBx = moveAx;
        moveBy = moveAy;
      }

      const newPoly = startPoly.map((pt, idx) => {
        if (idx === i) return [pt[0] + moveAx, pt[1] + moveAy];
        if (idx === i2) return [pt[0] + moveBx, pt[1] + moveBy];
        return pt;
      });

      applyGeom(d.kind, d.index, newPoly);
    }
  }

  function isTypingInEditable(ev) {
    const el = ev?.target || document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  useEffect(() => {
    function onKeyDown(ev) {
      // ⛔️ Đang gõ trong input/textarea/contentEditable → bỏ qua toàn bộ hotkey canvas
      if (isTypingInEditable(ev)) return;

      // Delete selection
      if (ev.key === "Delete" || ev.key === "Backspace") {
        ev.preventDefault();
        onDeleteSelection();
        return;
      }

      // Undo / Redo
      const ctrlOrMeta = ev.ctrlKey || ev.metaKey;
      if (ctrlOrMeta && ev.key.toLowerCase() === "z") {
        ev.preventDefault();
        if (ev.shiftKey) {
          redoHistory();
        } else {
          smartUndo();
        }
        return;
      }
      if (ctrlOrMeta && ev.key.toLowerCase() === "y") {
        ev.preventDefault();
        redoHistory();
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selection, boundary, internalRoads, lots, publicRoads, current, mode]);

  function deleteEdge(kind, index, edgeIndex) {
    pushHistory();
    // Xoá cạnh = xoá đỉnh thứ (edgeIndex+1) mod n
    if (kind === "publicEP") return; // public EP không có "cạnh"
    if (kind === "lot") {
      setLots((ls) => {
        const u = [...ls];
        const poly = [...u[index].polygon];
        const n = poly.length;
        if (n < 3) return ls;
        const rm = (edgeIndex + 1) % n;
        poly.splice(rm, 1);
        // Nếu còn <3 điểm thì xoá luôn polygon
        if (poly.length < 3) {
          return u.filter((_, i) => i !== index);
        }
        u[index] = { ...u[index], polygon: poly };
        return u;
      });
    } else if (kind === "internal") {
      setInternalRoads((rs) => {
        const u = [...rs];
        const poly = [...u[index].polygon];
        const n = poly.length;
        if (n < 3) return rs;
        const rm = (edgeIndex + 1) % n;
        poly.splice(rm, 1);
        if (poly.length < 3) {
          return u.filter((_, i) => i !== index);
        }
        u[index] = { ...u[index], polygon: poly };
        return u;
      });
    } else if (kind === "boundary") {
      const poly = [...boundary];
      const n = poly.length;
      if (n < 3) return;
      const rm = (edgeIndex + 1) % n;
      poly.splice(rm, 1);
      if (poly.length < 3) {
        setBoundary([]);
        setBoundaryClosed(false);
      } else {
        setBoundary(poly);
        setBoundaryClosed(true);
      }
    }
  }

  function onDeleteSelection() {
    const sel = selection;
    if (!sel) return;
    pushHistory();

    // Ưu tiên: nếu đang chọn cạnh → xoá cạnh
    if (sel.edgeIndex != null) {
      deleteEdge(sel.kind, sel.index ?? 0, sel.edgeIndex);
      setSelection(null);
      return;
    }

    // Nếu không phải cạnh, xử lý như cũ: xoá vertex hoặc xoá toàn bộ đối tượng
    if (sel.kind === "lot") {
      if (sel.vertexIndex != null) {
        setLots((ls) => {
          const u = [...ls];
          const poly = [...u[sel.index].polygon];
          poly.splice(sel.vertexIndex, 1);
          if (poly.length < 3) return u.filter((_, i) => i !== sel.index);
          u[sel.index] = { ...u[sel.index], polygon: poly };
          return u;
        });
      } else {
        setLots((ls) => ls.filter((_, i) => i !== sel.index));
      }
    } else if (sel.kind === "internal") {
      if (sel.vertexIndex != null) {
        setInternalRoads((rs) => {
          const u = [...rs];
          const poly = [...u[sel.index].polygon];
          poly.splice(sel.vertexIndex, 1);
          if (poly.length < 3) return u.filter((_, i) => i !== sel.index);
          u[sel.index] = { ...u[sel.index], polygon: poly };
          return u;
        });
      } else {
        setInternalRoads((rs) => rs.filter((_, i) => i !== sel.index));
      }
    } else if (sel.kind === "boundary") {
      if (sel.vertexIndex != null) {
        const poly = [...boundary];
        poly.splice(sel.vertexIndex, 1);
        if (poly.length < 3) {
          setBoundary([]);
          setBoundaryClosed(false);
        } else {
          setBoundary(poly);
          setBoundaryClosed(true);
        }
      } else {
        setBoundary([]);
        setBoundaryClosed(false);
      }
    } else if (sel.kind === "publicEP") {
      setPublicRoads((prs) => {
        const u = [...prs];
        if (sel.vertexIndex != null) {
          const eps = [...u[sel.index].entry_points];
          eps.splice(sel.vertexIndex, 1);
          u[sel.index] = { ...u[sel.index], entry_points: eps };
        } else {
          u.splice(sel.index, 1);
          setActivePublicIdx(-1);
        }
        return u;
      });
    }
    setSelection(null);
  }

  // -------------- Render / Preview --------------
  let previewPrev = null;
  if (hover) {
    if (mode === "boundary" && !boundaryClosed && current.length)
      previewPrev = current[current.length - 1];
    else if ((mode === "internalRoad" || mode === "lot") && current.length)
      previewPrev = current[current.length - 1];
  }
  const showPreview = !!(hover && previewPrev);
  const previewMid = showPreview
    ? [(previewPrev[0] + hover[0]) / 2, (previewPrev[1] + hover[1]) / 2]
    : null;
  const previewLen = showPreview ? distance(previewPrev, hover) : 0;

  // ---------- Live area for LOT while drawing ----------
  // Khi ở mode "lot", nếu đang có current và hover → xem như polygon tạm thời (current + hover)
  // Nếu không có hover mà đã ≥3 điểm → dùng current
  let liveLotPoly = null;
  if (mode === "lot") {
    if (current.length >= 2 && hover) {
      liveLotPoly = [...current, hover];
    } else if (!hover && current.length >= 3) {
      liveLotPoly = current;
    }
  }
  const liveLotArea = liveLotPoly ? shoelaceArea(liveLotPoly) : 0;
  const liveLotCentroid = liveLotPoly ? polygonCentroid(liveLotPoly) : null;

  // ---------- Live area for BOUNDARY while drawing ----------
  let liveBoundaryPoly = null;
  if (mode === "boundary" && !boundaryClosed) {
    if (current.length >= 2 && hover) {
      // có >=2 điểm + hover → đủ 3 điểm để xem như polygon tạm
      liveBoundaryPoly = [...current, hover];
    } else if (!hover && current.length >= 3) {
      // không có hover nhưng đã đủ 3 điểm
      liveBoundaryPoly = current;
    }
  }
  const liveBoundaryArea = liveBoundaryPoly
    ? shoelaceArea(liveBoundaryPoly)
    : 0;
  const liveBoundaryCentroid = liveBoundaryPoly
    ? polygonCentroid(liveBoundaryPoly)
    : null;

  // helpers to draw selection handles
  function drawVertexHandles(poly, kind, idxPrefix = "") {
    return poly.map((p, i) => (
      <circle
        key={`${idxPrefix}v-${i}`}
        cx={p[0]}
        cy={p[1]}
        r={R_HANDLE}
        fill={
          selection && selection.kind === kind && selection.vertexIndex === i
            ? "#ef4444"
            : "#10b981"
        }
        stroke="#064e3b"
        strokeWidth={1 * __avgUP}
        vectorEffect="non-scaling-stroke"
      />
    ));
  }
  function drawEdgeHighlight(poly, kind) {
    if (!selection || selection.kind !== kind || selection.edgeIndex == null)
      return null;
    const i = selection.edgeIndex,
      i2 = (i + 1) % poly.length;
    const a = poly[i],
      b = poly[i2];
    return (
      <line
        x1={a[0]}
        y1={a[1]}
        x2={b[0]}
        y2={b[1]}
        stroke="#ef4444"
        strokeWidth={4}
        vectorEffect="non-scaling-stroke"
        strokeDasharray="6 6"
      />
    );
  }

  // NEW: đổi kiểu con trỏ theo mode
  const svgCursorClass =
    mode === "select" ? "cursor-default" : "cursor-crosshair";

  // NEW: vị trí fallback cho badge nếu vì lý do nào đó cursorPos chưa bật show
  const badgePos = cursorPos.show
    ? [cursorPos.x, cursorPos.y]
    : hover
    ? [hover[0], hover[1]]
    : null;

  return (
    <div className="w-full min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-screen-2xl 2xl:max-w-[1600px] mx-auto p-3 md:p-5 xl:p-6 space-y-3 xl:space-y-4">
        {/* ── Compact Toolbar ───────────────────────────────────────── */}
        <div className="sticky top-0 z-50 bg-white/95 backdrop-blur border-b">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            {/* Left: Mode + LandID (siêu gọn) */}
            <div className="flex items-center gap-1">
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className="border rounded px-1 py-0.5 h-7 w-36"
                title="Mode"
              >
                <option value="boundary">Boundary</option>
                <option value="publicRoad">Public Road EP</option>
                <option value="internalRoad">Internal Road</option>
                <option value="lot">Lot</option>
                <option value="select">Select / Edit</option>
              </select>
              Land ID
              <input
                value={landId}
                onChange={(e) => setLandId(e.target.value)}
                className="border rounded px-1 py-0.5 h-7 w-20"
                placeholder="Land ID"
                title="Land ID"
              />
            </div>

            {/* Middle: Actions (icon-ish, tiết kiệm không gian) */}
            <div className="flex items-center gap-1">
              <button
                onClick={smartUndo}
                className="px-1.5 py-0.5 rounded bg-gray-200 hover:bg-gray-300"
                title="Undo"
              >
                ↶ Undo
              </button>
              <button
                onClick={clearAll}
                className="px-1.5 py-0.5 rounded bg-gray-200 hover:bg-gray-300"
                title="Clear"
              >
                ✕ Clear
              </button>
              <button
                onClick={closeShape}
                className="px-1.5 py-0.5 rounded bg-gray-800 text-white hover:bg-gray-700"
                title="Close shape"
              >
                ⤶ Close shape
              </button>
              <button
                onClick={exportJSON}
                className="px-1.5 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-500"
                title="Export JSON + PNG"
              >
                ⬇︎ Export JSON + PNG
              </button>
            </div>

            {/* Right: Zoom cluster */}
            <div className="flex items-center gap-1">
              <button
                onClick={zoomOutCenter}
                className="px-1.5 py-0.5 rounded bg-gray-200 hover:bg-gray-300"
                title="Zoom out"
              >
                −
              </button>
              <div className="w-12 text-center">{zoomPercent}%</div>
              <button
                onClick={() => {
                  const cx = viewBox.x + viewBox.w / 2;
                  const cy = viewBox.y + viewBox.h / 2;
                  zoomAt(cx, cy, 1.2);
                }}
                className="px-1.5 py-0.5 rounded bg-gray-200 hover:bg-gray-300"
                title="Zoom in"
              >
                ＋
              </button>
              <button
                onClick={fitView}
                className="px-1.5 py-0.5 rounded bg-gray-200 hover:bg-gray-300"
                title="Fit"
              >
                Fit
              </button>
              <button
                onClick={resetView}
                className="px-1.5 py-0.5 rounded bg-gray-200 hover:bg-gray-300"
                title="Reset"
              >
                Reset
              </button>
            </div>
          </div>
        </div>

        {/* ── Advanced (gập/mở) ────────────────────────────────────── */}
        <details className="mt-1 bg-white rounded-md border p-1 text-[11px]">
          <summary className="cursor-pointer select-none">Advanced</summary>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {/* Mode-specific */}
            <div
              className="flex items-center gap-1"
              hidden={mode !== "publicRoad"}
            >
              <span>Pub w</span>
              <input
                type="number"
                value={defaultPublicWidth}
                onChange={(e) =>
                  setDefaultPublicWidth(Number(e.target.value) || 0)
                }
                className="border rounded px-1 py-0.5 h-7 w-14"
                title="Default public width"
              />
              <button
                onClick={() => {
                  const id = nextGlobalRoadId();
                  setPublicRoads((rs) => [
                    ...rs,
                    {
                      road_id: id,
                      is_public: true,
                      width: defaultPublicWidth,
                      entry_points: [],
                      connected_to_public_road: null,
                      road_to_lot_mapping: [],
                    },
                  ]);
                  setActivePublicIdx(publicRoads.length);
                }}
                className="px-1.5 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-500"
                title="New public road"
              >
                +Road
              </button>
              <span>Active</span>
              <select
                value={activePublicIdx}
                onChange={(e) => setActivePublicIdx(Number(e.target.value))}
                className="border rounded px-1 py-0.5 h-7 w-24"
                title="Active public road"
              >
                <option value={-1}>None</option>
                {publicRoads.map((r, idx) => (
                  <option key={r.road_id} value={idx}>
                    {r.road_id}
                  </option>
                ))}
              </select>
              {activePublicIdx >= 0 && publicRoads[activePublicIdx] && (
                <>
                  <span>w</span>
                  <input
                    type="number"
                    value={publicRoads[activePublicIdx].width}
                    onChange={(e) => {
                      const w = Number(e.target.value) || 0;
                      setPublicRoads((rs) => {
                        const u = [...rs];
                        u[activePublicIdx] = {
                          ...u[activePublicIdx],
                          width: w,
                        };
                        return u;
                      });
                    }}
                    className="border rounded px-1 py-0.5 h-7 w-14"
                    title="Width of active public road"
                  />
                </>
              )}
            </div>

            {/* Snap & Line tolerances */}
            <div className="flex items-center gap-1">
              <span>Snap</span>
              <input
                type="number"
                value={snapTol}
                onChange={(e) => setSnapTol(Number(e.target.value) || 0)}
                className="border rounded px-1 py-0.5 h-7 w-14"
                title="Snap tolerance (px)"
              />
              <span>Line</span>
              <input
                type="number"
                value={lineTol}
                onChange={(e) => setLineTol(Number(e.target.value) || 0)}
                className="border rounded px-1 py-0.5 h-7 w-14"
                title="Line snapping tolerance (px)"
              />
            </div>

            {/* Grid cluster */}
            <div className="flex items-center gap-1">
              <label
                className="flex items-center gap-1"
                title="Enable grid snap"
              >
                <input
                  type="checkbox"
                  checked={gridSnap}
                  onChange={(e) => setGridSnap(e.target.checked)}
                />
                Grid
              </label>
              <span>Step</span>
              <input
                type="number"
                value={gridStep}
                onChange={(e) => setGridStep(Number(e.target.value) || 1)}
                className="border rounded px-1 py-0.5 h-7 w-16"
                title="Grid step"
              />
              <span>Tol</span>
              <input
                type="number"
                value={gridTol}
                onChange={(e) => setGridTol(Number(e.target.value) || 0)}
                className="border rounded px-1 py-0.5 h-7 w-14"
                title="Grid snap tolerance (px)"
              />
              <label
                className="flex items-center gap-1"
                title="Always snap to grid"
              >
                <input
                  type="checkbox"
                  checked={gridStrict}
                  onChange={(e) => setGridStrict(e.target.checked)}
                />
                Strict
              </label>
            </div>

            {/* (Tuỳ chọn) Nếu bạn đã thêm badgeOffsetPx / labelOffsetPx, có thể cho vào Advanced luôn để gọn */}
            <div className="flex items-center gap-1">
              <span>Badge dx</span>
              <input
                type="number"
                value={badgeOffsetPx.dx}
                onChange={(e) =>
                  setBadgeOffsetPx((o) => ({ ...o, dx: +e.target.value || 0 }))
                }
                className="border rounded px-1 py-0.5 h-7 w-14"
              />
              <span>dy</span>
              <input
                type="number"
                value={badgeOffsetPx.dy}
                onChange={(e) =>
                  setBadgeOffsetPx((o) => ({ ...o, dy: +e.target.value || 0 }))
                }
                className="border rounded px-1 py-0.5 h-7 w-14"
              />
            </div>
          </div>
          <div
            className="flex items-center gap-1"
            hidden={mode !== "internalRoad"}
          >
            <span>Int w</span>
            <input
              type="number"
              value={internalWidthDefault}
              onChange={(e) =>
                setInternalWidthDefault(Number(e.target.value) || 0)
              }
              className="border rounded px-1 py-0.5 h-7 w-14"
              title="Internal road width (default)"
            />
            <label
              className="flex items-center gap-1 ml-2"
              title="Auto-compute width from polygon shape"
            >
              <input
                type="checkbox"
                checked={autoInternalWidth}
                onChange={(e) => setAutoInternalWidth(e.target.checked)}
              />
              Auto width
            </label>
            <button
              onClick={() => {
                // Recompute width cho đường nội khu đang được chọn (nếu có)
                if (selection?.kind === "internal" && selection.index != null) {
                  setInternalRoads((rs) => {
                    const u = [...rs];
                    const idx = selection.index;
                    const poly = u[idx]?.polygon || [];
                    const w = estimateRoadWidth(poly);
                    if (isFinite(w) && w > 0) {
                      u[idx] = { ...u[idx], width: w };
                    }
                    return u;
                  });
                }
              }}
              className="px-1.5 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-500 ml-1"
              title="Recompute width for selected internal road"
            >
              Recalc
            </button>
            <label
              className="flex items-center gap-1 ml-2"
              title="Show min-width support lines"
            >
              <input
                type="checkbox"
                checked={showWidthDebug}
                onChange={(e) => setShowWidthDebug(e.target.checked)}
              />
              Width debug
            </label>
          </div>
        </details>

        {/* Scale & Area Panel */}
        <div className="bg-white rounded-xl shadow p-2 flex flex-wrap items-end gap-4">
          <div>
            <div className="text-xs text-gray-600">Boundary area (current)</div>
            <div className="font-mono">{boundaryArea.toFixed(1)} m²</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs">Scale (%)</span>
            <button
              onClick={() => applyScaleFactor(0.9)}
              className="px-1.5 py-0.5 text-xs rounded bg-gray-200 hover:bg-gray-300"
            >
              -10%
            </button>
            <input
              type="number"
              value={scalePct}
              onChange={(e) => setScalePct(e.target.value)}
              className="border rounded px-1.5 py-0.5 h-7 text-xs w-16"
            />
            <button
              onClick={onApplyScalePct}
              className="px-2 py-0.5 text-xs rounded bg-gray-800 text-white hover:bg-gray-700"
            >
              Apply
            </button>
            <button
              onClick={() => applyScaleFactor(1.1)}
              className="px-1.5 py-0.5 text-xs rounded bg-gray-200 hover:bg-gray-300"
            >
              +10%
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs">Target area</span>
            <input
              type="number"
              value={targetArea}
              onChange={(e) => setTargetArea(e.target.value)}
              className="border rounded px-1.5 py-0.5 h-7 text-xs w-20"
            />
            <button
              onClick={onScaleToArea}
              disabled={boundaryArea <= 0}
              className="px-2 py-0.5 text-xs rounded bg-blue-600 text-white disabled:opacity-50"
            >
              Scale to area
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs">Anchor</span>
            <select
              value={anchorType}
              onChange={(e) => setAnchorType(e.target.value)}
              className="border rounded px-1.5 py-0.5 h-7 text-xs w-28"
            >
              <option value="centroid">Boundary centroid</option>
              <option value="origin">(0,0)</option>
              <option value="custom">Custom</option>
            </select>
            <input
              type="number"
              value={anchorX}
              onChange={(e) => setAnchorX(e.target.value)}
              className="border rounded px-1.5 py-0.5 h-7 text-xs w-16"
              disabled={anchorType !== "custom"}
              placeholder="cx"
            />
            <input
              type="number"
              value={anchorY}
              onChange={(e) => setAnchorY(e.target.value)}
              className="border rounded px-1.5 py-0.5 h-7 text-xs w-16"
              disabled={anchorType !== "custom"}
              placeholder="cy"
            />
          </div>
        </div>

        <div className="rounded-2xl overflow-hidden bg-white shadow">
          <svg
            ref={svgRef}
            onClick={onCanvasClick}
            onMouseDown={onPointerDown}
            onMouseUp={onPointerUp}
            onWheel={(e) => {
              e.preventDefault();
              const pt = svgRef.current.createSVGPoint();
              pt.x = e.clientX;
              pt.y = e.clientY;
              const { x, y } = pt.matrixTransform(
                svgRef.current.getScreenCTM().inverse()
              );
              const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
              zoomAt(x, y, factor);
            }}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
            // className="block mx-auto w-full h-[60vh] md:h-[70vh] xl:h-[78vh] 2xl:h-[82vh] cursor-crosshair select-none"
            // className="block w-full h-full cursor-crosshair select-none"
            className={`block w-full h-full ${svgCursorClass} select-none`}
          >
            {/* Grid */}
            <defs>
              <pattern
                id="grid"
                width={gridStep}
                height={gridStep}
                patternUnits="userSpaceOnUse"
              >
                <path
                  d={`M ${gridStep} 0 L 0 0 0 ${gridStep}`}
                  fill="none"
                  stroke="#e5e7eb"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                  shapeRendering="crispEdges"
                />
              </pattern>
              <pattern
                id="gridMajor"
                width={gridStep * 5}
                height={gridStep * 5}
                patternUnits="userSpaceOnUse"
              >
                <path
                  d={`M ${gridStep * 5} 0 L 0 0 0 ${gridStep * 5}`}
                  fill="none"
                  stroke="#cbd5e1"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                  shapeRendering="crispEdges"
                />
              </pattern>
            </defs>
            <rect
              x={viewBox.x}
              y={viewBox.y}
              width={viewBox.w}
              height={viewBox.h}
              fill="url(#grid)"
              pointerEvents="none"
            />
            <rect
              x={viewBox.x}
              y={viewBox.y}
              width={viewBox.w}
              height={viewBox.h}
              fill="url(#gridMajor)"
              pointerEvents="none"
            />

            {/* Boundary */}
            {boundary.length >= 2 && !boundaryClosed && (
              <polyline
                points={boundary.map((p) => p.join(",")).join(" ")}
                fill="none"
                stroke="#111827"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {boundaryClosed && (
              <polygon
                points={boundary.map((p) => p.join(",")).join(" ")}
                fill="none"
                stroke="#111827"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {boundaryClosed && boundary.length >= 2 && (
              <g pointerEvents="none">{drawPointLabels(boundary, "#111827")}</g>
            )}

            {boundaryClosed && boundary.length >= 2 && (
              <g pointerEvents="none">
                {segmentsForLabels(boundary, true).map(([a, b], i) => {
                  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
                  return (
                    <text
                      key={`b-l${i}`}
                      x={mid[0] + DX_LABEL}
                      y={mid[1] - DY_LABEL}
                      fontSize={FONT_UNIT}
                      fill="#111827"
                    >
                      {distance(a, b).toFixed(2)} m
                    </text>
                  );
                })}
              </g>
            )}
            {selection?.kind === "boundary" &&
              boundaryClosed &&
              drawEdgeHighlight(boundary, "boundary")}
            {selection?.kind === "boundary" &&
              boundaryClosed &&
              drawVertexHandles(boundary, "boundary", "b-")}
            {/* Live BOUNDARY area overlay while drawing */}
            {liveBoundaryPoly && (
              <g pointerEvents="none">
                {/* polygon tạm: fill nhạt + viền đứt */}
                <polygon
                  points={liveBoundaryPoly.map((p) => p.join(",")).join(" ")}
                  fill="#10b98133" // emerald nhạt
                  stroke="#059669"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray="6 6"
                />
                {/* nhãn diện tích đặt tại centroid */}
                <text
                  x={liveBoundaryCentroid[0] + DX_LABEL}
                  y={liveBoundaryCentroid[1] - DY_LABEL}
                  fontSize={FONT_UNIT}
                  fill="#065f46"
                >
                  {liveBoundaryArea.toFixed(1)} m²
                </text>
              </g>
            )}

            {/* Current drawing path */}
            {current.length >= 2 && (
              <>
                <polyline
                  points={current.map((p) => p.join(",")).join(" ")}
                  fill="none"
                  stroke="#fa0202"
                  strokeDasharray="6 6"
                  strokeWidth="4"
                  vectorEffect="non-scaling-stroke"
                />
                <g pointerEvents="none">
                  {segmentsForLabels(current, false).map(([a, b], i) => {
                    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
                    return (
                      <text
                        key={`cur-l${i}`}
                        x={mid[0] + DX_LABEL}
                        y={mid[1] - DY_LABEL}
                        fontSize={FONT_UNIT}
                        fill="#111827"
                      >
                        {distance(a, b).toFixed(2)} m
                      </text>
                    );
                  })}
                </g>
              </>
            )}

            {/* Live preview segment + length label (while drawing) */}
            {showPreview && (
              <g>
                <line
                  x1={previewPrev[0]}
                  y1={previewPrev[1]}
                  x2={hover[0]}
                  y2={hover[1]}
                  stroke="#ef4444"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray="4 4"
                />
                <text
                  x={previewMid[0] + DX_LABEL}
                  y={previewMid[1] - DY_LABEL}
                  fontSize={FONT_UNIT}
                  fill="#111827"
                >
                  {previewLen.toFixed(2)} m
                </text>
              </g>
            )}

            {/* Live LOT area overlay while drawing */}
            {liveLotPoly && (
              <g pointerEvents="none">
                {/* fill nhạt + viền đứt để thấy hình tạm */}
                <polygon
                  points={liveLotPoly.map((p) => p.join(",")).join(" ")}
                  fill="#3b82f633"
                  stroke="#1d4ed8"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray="6 6"
                />
                {/* nhãn diện tích đặt ở tâm đa giác */}
                <text
                  x={liveLotCentroid[0] + DX_LABEL}
                  y={liveLotCentroid[1] - DY_LABEL}
                  fontSize={FONT_UNIT}
                  fill="#1e40af"
                >
                  {liveLotArea.toFixed(1)} m²
                </text>
              </g>
            )}

            {/* Public road entry points */}
            {publicRoads.map((pr) => (
              <g key={`pr-${pr.road_id}`}>
                {pr.entry_points.map((p, i) => (
                  <g key={`pub-${pr.road_id}-${i}`}>
                    <circle
                      cx={p[0]}
                      cy={p[1]}
                      r={R_EP}
                      fill={
                        selection &&
                        selection.kind === "publicEP" &&
                        selection.index === publicRoads.indexOf(pr) &&
                        selection.vertexIndex === i
                          ? "#ef4444"
                          : "#059669"
                      }
                    />
                    <text
                      x={p[0] + DX_LABEL}
                      y={p[1] - DY_LABEL}
                      fontSize={FONT_UNIT}
                      fill="#065f46"
                    >
                      {pr.road_id}-EP{i + 1}
                    </text>
                  </g>
                ))}
              </g>
            ))}

            {/* Internal roads polygons */}
            {internalRoads.map((r, idx) => (
              <g key={r.road_id}>
                <polygon
                  points={r.polygon.map((p) => p.join(",")).join(" ")}
                  fill="#f59e0b55"
                  stroke="#fadf5a"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
                {showWidthDebug &&
                  r.polygon.length >= 2 &&
                  (() => {
                    const inf =
                      dominantParallelWallsInfo(r.polygon, 10) ||
                      maxLengthDirInfo(r.polygon);

                    // Hai đường đỡ song song dài nhất: n·x = minN và n·x = maxN
                    const n = inf.n;
                    const t = [-n[1], n[0]]; // tiếp tuyến (song song với hướng dài d)
                    const L = Math.max(viewBox.w, viewBox.h) * 2;
                    const P = (c) => {
                      // trả về 2 điểm trên đường n·x = c để vẽ line dài
                      // chọn điểm gốc p0 thỏa n·p0 = c
                      const p0 = [n[0] * c, n[1] * c];
                      return [
                        [p0[0] - t[0] * L, p0[1] - t[1] * L],
                        [p0[0] + t[0] * L, p0[1] + t[1] * L],
                      ];
                    };
                    const [A1, A2] = P(inf.minN);
                    const [B1, B2] = P(inf.maxN);
                    const c = polygonCentroid(r.polygon);

                    return (
                      <g pointerEvents="none">
                        <line
                          x1={A1[0]}
                          y1={A1[1]}
                          x2={A2[0]}
                          y2={A2[1]}
                          stroke="#ef4444"
                          strokeWidth={1.5}
                          vectorEffect="non-scaling-stroke"
                          strokeDasharray="6 6"
                        />
                        <line
                          x1={B1[0]}
                          y1={B1[1]}
                          x2={B2[0]}
                          y2={B2[1]}
                          stroke="#ef4444"
                          strokeWidth={1.5}
                          vectorEffect="non-scaling-stroke"
                          strokeDasharray="6 6"
                        />
                        <text
                          x={c[0] + DX_LABEL}
                          y={c[1] - DY_LABEL}
                          fontSize={FONT_UNIT}
                          fill="#ef4444"
                        >
                          w={inf.width} • L={inf.length}
                        </text>
                      </g>
                    );
                  })()}

                {r.polygon.length > 0 && (
                  <text
                    x={r.polygon[0][0]}
                    y={r.polygon[0][1]}
                    fontSize={FONT_UNIT}
                    fill="#92400e"
                  >
                    {r.road_id}
                  </text>
                )}
                {/* Thêm nhãn toạ độ các điểm */}
                {drawPointLabels(r.polygon, "#92400e")}
                {selection?.kind === "internal" &&
                  selection.index === idx &&
                  drawEdgeHighlight(r.polygon, "internal")}
                {selection?.kind === "internal" &&
                  selection.index === idx &&
                  drawVertexHandles(r.polygon, "internal", `ir-${idx}-`)}
              </g>
            ))}
            {/* Lots polygons */}
            {lots.map((l, idx) => {
              const [lcx, lcy] = polygonCentroid(l.polygon);
              const lotArea = shoelaceArea(l.polygon).toFixed(1);
              return (
                <g key={l.lot_id}>
                  <polygon
                    points={l.polygon.map((p) => p.join(",")).join(" ")}
                    fill="#3b82f655"
                    stroke="#1d4ed8"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* đặt label ở centroid cho dễ đọc */}
                  {l.polygon.length > 0 && (
                    <text x={lcx} y={lcy} fontSize={FONT_UNIT} fill="#1e40af">
                      {l.lot_id} – {lotArea} m²
                    </text>
                  )}
                  {selection?.kind === "lot" &&
                    selection.index === idx &&
                    drawEdgeHighlight(l.polygon, "lot")}
                  {selection?.kind === "lot" &&
                    selection.index === idx &&
                    drawVertexHandles(l.polygon, "lot", `lt-${idx}-`)}
                  {drawPointLabels(l.polygon, "#1e40af")}
                </g>
              );
            })}

            {/* Current points markers while drawing */}
            {current.map((p, i) => (
              <circle
                key={`c-${i}`}
                cx={p[0]}
                cy={p[1]}
                r={R_POINT}
                fill="#fa0202"
              />
            ))}
            {/* Cursor mode badge (realtime) */}
            {badgePos && (
              <g
                pointerEvents="none"
                transform={`translate(${
                  badgePos[0] + badgeOffsetPx.dx * unitsPerPx.x
                }, ${badgePos[1] + badgeOffsetPx.dy * unitsPerPx.y})`}
              >
                {(() => {
                  const label = MODE_LABELS[mode] || mode;
                  const { bg, text } = MODE_COLORS[mode] || DEFAULT_MODE_COLOR; // << dùng bảng màu
                  const padX = 6 * unitsPerPx.x;
                  const padY = 4 * unitsPerPx.y;
                  const textW = label.length * (FONT_UNIT * 0.6);
                  const rectW = textW + padX * 2;
                  const rectH = FONT_UNIT + padY * 3;
                  return (
                    <>
                      <rect
                        x={-padX}
                        y={-rectH + padY}
                        width={rectW}
                        height={rectH}
                        rx={3 * unitsPerPx.x}
                        ry={3 * unitsPerPx.y}
                        fill={bg} // << màu nền theo mode
                        opacity={0.95}
                        stroke="#000000"
                        strokeOpacity={0.12}
                        vectorEffect="non-scaling-stroke"
                      />
                      <text
                        x={0}
                        y={-padY}
                        fontSize={FONT_UNIT}
                        fill={text} // << màu chữ theo mode
                      >
                        {label}
                      </text>
                    </>
                  );
                })()}
              </g>
            )}
          </svg>
        </div>

        <section className="grid md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3 xl:gap-5">
          <div className="bg-white rounded-xl shadow p-2">
            <h2 className="text-xs font-semibold mb-1">Boundary vertices</h2>
            <div className="text-xs text-gray-600">
              {boundaryClosed ? "Closed" : "Open"} • {boundary.length} points
            </div>
            <ol className="text-xs mt-2 max-h-48 overflow-auto space-y-1">
              {boundary.map((p, i) => (
                <li key={i} className="font-mono">
                  [{p[0]}, {p[1]}]
                </li>
              ))}
            </ol>
          </div>

          <div className="bg-white rounded-xl shadow p-2">
            <h2 className="text-xs font-semibold mb-1">Public roads</h2>
            <ol className="text-xs mt-2 max-h-48 overflow-auto space-y-2">
              {publicRoads.map((r, i) => (
                <li key={r.road_id}>
                  <div className="font-medium">
                    {r.road_id} • w={r.width} • EPs={r.entry_points.length}
                  </div>
                  <ol className="ml-3 space-y-1">
                    {r.entry_points.map((p, j) => (
                      <li key={j} className="font-mono">
                        {r.road_id}-EP{j + 1}: [{p[0]}, {p[1]}]
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
          </div>

          <div className="bg-white rounded-xl shadow p-2">
            <h2 className="text-xs font-semibold mb-1">Internal roads</h2>
            <ol className="text-xs mt-2 max-h-48 overflow-auto space-y-2">
              {internalRoads.map((r) => (
                <li key={r.road_id}>
                  <div className="font-medium">
                    {r.road_id} • w={r.width} • {r.polygon.length} pts
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="bg-white rounded-xl shadow p-2">
            <h2 className="text-xs font-semibold mb-1">Lots</h2>
            <ol className="text-xs mt-2 max-h-48 overflow-auto space-y-2">
              {lots.map((l) => {
                const ctx = {
                  boundary,
                  boundaryClosed,
                  publicRoads,
                  internalRoads,
                };
                const tolUnits = 3 * __avgUP;
                return (
                  <li key={l.lot_id}>
                    <div className="font-medium">
                      {l.lot_id} • area={shoelaceArea(l.polygon).toFixed(1)} •
                      front=
                      {computeFrontRoadForLot(l.polygon, ctx, tolUnits) ?? "-"}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        <footer className="text-[11px] text-gray-500 pt-1">
          Tips: Chuyển sang <b>Select/Edit</b> để chọn & kéo vertex/cạnh. Kéo
          cạnh với <b>Shift</b> để “mở rộng” theo pháp tuyến. Phím <b>Delete</b>
          /<b>Backspace</b> để xoá.
        </footer>
      </div>
    </div>
  );
}
