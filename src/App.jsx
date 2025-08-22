import React, { useRef, useState, useEffect } from "react";

/**
 * Land Subdivision Web App (single-file React component)
 * - Draw boundary polygon (click to add points → Close shape)
 * - Add PUBLIC road entry points (points that touch the boundary)
 * - Draw INTERNAL road polygons
 * - Draw LOT polygons
 * - Snap & Merge: clicking near an existing point will snap to it (tolerance adjustable)
 * - Shift+Click axis-lock: 水平 / 垂直 against the previous point
 * - Line snapping: clicking near an existing segment projects the point onto that segment
 * - Export JSON in your required schema (matches the example you provided)
 * - Export PNG snapshot of the drawing (same viewBox)
 * - Zoom In / Zoom Out (toolbar buttons + mouse wheel), Fit to geometry
 * - Global uniform scaling by percent or to a target boundary area
 * - Auto-scale newly created shapes to a target area (default 200 m² for LOTs)
 * - Live segment length while drawing (preview line + length label)
 * - Length labels for ALL finished segments (boundary/internal roads/lots)
 * - Constant-size strokes (2px), markers and labels regardless of zoom
 * - 100% zoom equals 5× magnification over the old baseline
 *
 * Integrate:
 *  - Create a React app (Vite/Next/CRA), paste this file, and render <LandSubdivisionApp />
 *  - Uses Tailwind classes for nicer UI; remove classes if you don't use Tailwind
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

// ----- Segments helper for length labels -----
function segmentsForLabels(points, closed) {
  const segs = [];
  if (!points || points.length < 2) return segs;
  for (let i = 0; i < points.length - 1; i++) segs.push([points[i], points[i + 1]]);
  if (closed && points.length >= 3) segs.push([points[points.length - 1], points[0]]);
  return segs;
}

// ---------- Snap / merge helpers ----------
function dist2(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function snapToPools(p, pools, tolUnits) {
  // pools: array of arrays of points [[x,y], ...]
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
  if (best && Math.sqrt(bestD2) <= tolUnits) return best; // snap/merge
  return p;
}

function dedupPush(list, p) {
  if (list.length === 0) return [...list, p];
  const last = list[list.length - 1];
  if (Math.sqrt(dist2(last, p)) <= 1e-6) return list; // avoid duplicate consecutive vertex
  return [...list, p];
}

// ----- Line snapping (project to nearest segment) -----
function pointSegProjection(p, a, b) {
  // returns {proj:[x,y], d2, t} where t in [0,1] is segment param
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const vv = vx * vx + vy * vy;
  if (vv <= 1e-12) return { proj: a, d2: dist2(p, a), t: 0 };
  let t = (wx * vx + wy * vy) / vv;
  t = Math.max(0, Math.min(1, t));
  const proj = [a[0] + t * vx, a[1] + t * vy];
  const d2 = dist2(p, proj);
  return { proj, d2, t };
}

function collectSegments(boundary, boundaryClosed, current, internalRoads, lots) {
  const segs = [];
  const addSegs = (poly, closed) => {
    if (!poly || poly.length < 2) return;
    for (let i = 0; i < poly.length - 1; i++) segs.push([poly[i], poly[i + 1]]);
    if (closed && poly.length >= 3) segs.push([poly[poly.length - 1], poly[0]]);
  };
  addSegs(boundary, boundaryClosed);
  addSegs(current, false);
  for (const r of internalRoads) addSegs(r.polygon, true);
  for (const l of lots) addSegs(l.polygon, true);
  return segs;
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

// Axis alignment helper: lock to horizontal/vertical relative to prev when Shift is held
function axisAlign(prev, p) {
  if (!prev) return p;
  const dx = Math.abs(p[0] - prev[0]);
  const dy = Math.abs(p[1] - prev[1]);
  // If horizontal move is bigger, keep y the same (水平). Else keep x the same (垂直).
  if (dx >= dy) return [p[0], prev[1]];
  return [prev[0], p[1]];
}

// Scale helpers
function polygonCentroid(points) {
  if (!points || points.length < 3) {
    if (!points || !points.length) return [0, 0];
    const sx = points.reduce((a, p) => a + p[0], 0);
    const sy = points.reduce((a, p) => a + p[1], 0);
    return [sx / points.length, sy / points.length];
  }
  let a = 0, cx = 0, cy = 0;
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
  return poly.map(pt => transformPoint(pt, s, cx, cy));
}

// ---------- Frontage helpers (pure) ----------
function orient(a, b, c) {
  const v1x = b[0] - a[0], v1y = b[1] - a[1];
  const v2x = c[0] - a[0], v2y = c[1] - a[1];
  const cross = v1x * v2y - v1y * v2x;
  return Math.abs(cross) < 1e-9 ? 0 : (cross > 0 ? 1 : -1);
}
function onSegment(a, b, p) {
  const minx = Math.min(a[0], b[0]) - 1e-9, maxx = Math.max(a[0], b[0]) + 1e-9;
  const miny = Math.min(a[1], b[1]) - 1e-9, maxy = Math.max(a[1], b[1]) + 1e-9;
  if (p[0] < minx || p[0] > maxx || p[1] < miny || p[1] > maxy) return false;
  return Math.abs((b[0]-a[0])*(p[1]-a[1]) - (b[1]-a[1])*(p[0]-a[0])) < 1e-9;
}
function segmentsIntersectOrTouch(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true; // proper intersection
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}
function edgesFromPolygon(poly, closed=true) {
  const segs = [];
  if (!poly || poly.length < 2) return segs;
  for (let i=0;i<poly.length-1;i++) segs.push([poly[i], poly[i+1]]);
  if (closed && poly.length>=3) segs.push([poly[poly.length-1], poly[0]]);
  return segs;
}
function pathSegsBetweenIndices(boundary, iFrom, iTo) {
  const segs=[]; let i=iFrom;
  while (i !== iTo) {
    const j = (i+1) % boundary.length;
    segs.push([boundary[i], boundary[j]]);
    i = j;
  }
  return segs;
}
function nearestBoundaryIndex(pt, boundary) {
  let bestI = -1, bestD = Infinity;
  for (let i=0;i<boundary.length;i++) {
    const d = distance(pt, boundary[i]);
    if (d < bestD) { bestD = d; bestI = i; }
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
function polyMinDistance(polyA, polyB) {
  if (!polyA || !polyB || polyA.length < 2 || polyB.length < 2) return Infinity;
  let best = Infinity;
  const nA = polyA.length, nB = polyB.length;
  for (let i = 0; i < nA; i++) {
    const a1 = polyA[i], a2 = polyA[(i + 1) % nA];
    for (let j = 0; j < nB; j++) {
      const b1 = polyB[j], b2 = polyB[(j + 1) % nB];
      const d = segmentDistance(a1, a2, b1, b2);
      if (d < best) best = d;
    }
  }
  return best;
}
/**
 * Compute which road a lot fronts.
 * Priority: internal roads > public road segment along boundary between the first two public entry points.
 * If there's no intersection/touch, use distance threshold `tolUnits` to consider as touching.
 * @param {number[][]} lotPoly
 * @param {object} ctx - { boundary, boundaryClosed, publicEntryPoints, internalRoads }
 * @param {number} tolUnits - tolerance in SVG units (use ~3px converted by caller)
 * @returns {string|null}
 */
function computeFrontRoadForLot(lotPoly, ctx, tolUnits = 0) {
  const { boundary, boundaryClosed, publicEntryPoints, internalRoads } = ctx || {};
  if (!lotPoly || lotPoly.length < 3) return null;
  const lotEdges = edgesFromPolygon(lotPoly, true);

  // 1) Internal roads first: intersect/touch or within tolUnits
  if (Array.isArray(internalRoads)) {
    for (const r of internalRoads) {
      const roadEdges = edgesFromPolygon(r.polygon, true);
      let touch = false;
      for (const [a,b] of lotEdges) {
        for (const [c,d] of roadEdges) {
          if (segmentsIntersectOrTouch(a,b,c,d)) { touch = true; break; }
          if (tolUnits > 0 && segmentDistance(a,b,c,d) <= tolUnits) { touch = true; break; }
        }
        if (touch) break;
      }
      if (touch) return r.road_id;
    }
  }

  // 2) Public boundary segment (between first two entry points) if available
  if (boundaryClosed && Array.isArray(boundary) && boundary.length>=3 && Array.isArray(publicEntryPoints) && publicEntryPoints.length>=2) {
    const iA = nearestBoundaryIndex(publicEntryPoints[0], boundary);
    const iB = nearestBoundaryIndex(publicEntryPoints[1], boundary);
    if (iA !== -1 && iB !== -1 && iA !== iB) {
      const segsAB = pathSegsBetweenIndices(boundary, iA, iB);
      const segsBA = pathSegsBetweenIndices(boundary, iB, iA);
      const len = (ss)=>ss.reduce((s,[[x1,y1],[x2,y2]])=>s+Math.hypot(x2-x1,y2-y1),0);
      const pubSegs = len(segsAB) <= len(segsBA) ? segsAB : segsBA;
      for (const [a,b] of lotEdges) {
        for (const [c,d] of pubSegs) {
          if (segmentsIntersectOrTouch(a,b,c,d)) return "R003";
          if (tolUnits > 0 && segmentDistance(a,b,c,d) <= tolUnits) return "R003";
        }
      }
    }
  }
  return null;
}

// ---------- Main Component ----------
export default function LandSubdivisionApp() {
  const [landId, setLandId] = useState("L001");
  const [mode, setMode] = useState("boundary"); // boundary | publicRoad | internalRoad | lot | select

  const svgRef = useRef(null);
  const [current, setCurrent] = useState([]); // points under construction
  const [hover, setHover] = useState(null);   // preview point under cursor (after snapping/alignment)

  const [boundary, setBoundary] = useState([]); // [[x,y], ...]
  const [boundaryClosed, setBoundaryClosed] = useState(false);

  // Public road (single) with entry_points list
  const [publicRoadWidth, setPublicRoadWidth] = useState(12);
  const [publicEntryPoints, setPublicEntryPoints] = useState([]); // [[x,y], ...]

  // Internal roads (multiple polygons)
  const [internalWidthDefault, setInternalWidthDefault] = useState(6);
  const [internalRoads, setInternalRoads] = useState([]); // [{road_id, polygon:[[x,y]], width}]

  // Lots (multiple polygons)
  const [lots, setLots] = useState([]); // [{lot_id, polygon:[[x,y]], front_road}]

  // Snap tolerance (pixels on canvas)
  const [snapTol, setSnapTol] = useState(4);
  const [lineTol, setLineTol] = useState(4);

  // --- Grid snap ---
  const [gridSnap, setGridSnap] = useState(true);
  const [gridStep, setGridStep] = useState(2);   // kích thước ô lưới (đơn vị SVG, ví dụ: mét)
  const [gridTol, setGridTol] = useState(8);      // bán kính hút theo px
  const [gridStrict, setGridStrict] = useState(false); // bật = luôn dính lưới
  const [gridOrigin, setGridOrigin] = useState({ x: 0, y: 0 }); // gốc lưới

  function snapToGrid(p, step, origin, tolUnits, always=false) {
    if (!step || step <= 0) return p;
    const gx = Math.round((p[0] - origin.x) / step) * step + origin.x;
    const gy = Math.round((p[1] - origin.y) / step) * step + origin.y;
    const g = [Number(gx.toFixed(2)), Number(gy.toFixed(2))];
    if (always) return g;
    return distance(p, g) <= tolUnits ? g : p;
  }


  // --- Global scale / area controls ---
  const [scalePct, setScalePct] = useState(100);
  const [targetArea, setTargetArea] = useState(0);
  const [anchorType, setAnchorType] = useState("centroid"); // centroid | origin | custom
  const [anchorX, setAnchorX] = useState(0);
  const [anchorY, setAnchorY] = useState(0);

  // --- Auto-scale new shapes ---
  const [autoScaleNew, setAutoScaleNew] = useState(false);
  const [autoTargetArea, setAutoTargetArea] = useState(200); // m²
  const [autoApplyTo, setAutoApplyTo] = useState({ lot: false, boundary: false, internalRoad: false });

  // --- ViewBox-based zoom/pan ---
  const canvasW = 1000, canvasH = 640;
  const ZOOM_BASE = 8; // 100% equals 5x magnification
  const baseView = { x: 0, y: 0, w: canvasW / ZOOM_BASE, h: canvasH / ZOOM_BASE };
  const [viewBox, setViewBox] = useState(baseView);
  const zoomPercent = Math.round((canvasW / viewBox.w) * (100 / ZOOM_BASE));

  // ----- Keep markers & labels constant-size in screen pixels -----
  const [unitsPerPx, setUnitsPerPx] = useState({ x: viewBox.w / canvasW, y: viewBox.h / canvasH });

  // Recalculate when resized
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

  // Also update when viewBox (zoom) changes
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const w = rect.width || canvasW;
    const h = rect.height || canvasH;
    setUnitsPerPx({ x: viewBox.w / w, y: viewBox.h / h });
  }, [viewBox]);

  // Convert desired pixel sizes to SVG user units using current units-per-pixel
  const __avgUP = Math.max((unitsPerPx.x + unitsPerPx.y) / 2, 1e-6);
  const R_POINT = 4 * __avgUP;   // ~4px on screen
  const R_EP = 6 * __avgUP;      // ~6px on screen
  const FONT_UNIT = 12 * unitsPerPx.y; // ~12px on screen (uses Y scale)
  const DX_LABEL = 8 * unitsPerPx.x;   // ~8px right
  const DY_LABEL = 8 * unitsPerPx.y;   // ~8px up

  // Helpers to create incremental IDs
  const nextRoadId = () => `R${String(internalRoads.length + 1).padStart(3, "0")}`;
  const nextLotId  = () => `${landId}-${String(lots.length + 1).padStart(2, "0")}`;

  // --------- Scale/Area helpers ---------
  function getAnchor() {
    if (anchorType === "origin") return [0, 0];
    if (anchorType === "custom") return [Number(anchorX) || 0, Number(anchorY) || 0];
    // centroid (default) → use boundary centroid if available, else average of all points
    if (boundary && boundary.length >= 1) return polygonCentroid(boundary);
    const all = [
      ...boundary,
      ...publicEntryPoints,
      ...internalRoads.flatMap(r => r.polygon),
      ...lots.flatMap(l => l.polygon),
    ];
    if (!all.length) return [0, 0];
    const sx = all.reduce((a, p) => a + p[0], 0);
    const sy = all.reduce((a, p) => a + p[1], 0);
    return [sx / all.length, sy / all.length];
  }

  function applyScaleFactor(s) {
    if (!isFinite(s) || s <= 0) return;
    const [cx, cy] = getAnchor();
    setBoundary(b => b.map(pt => transformPoint(pt, s, cx, cy)));
    setCurrent(cur => cur.map(pt => transformPoint(pt, s, cx, cy)));
    setPublicEntryPoints(pts => pts.map(pt => transformPoint(pt, s, cx, cy)));
    setInternalRoads(rs => rs.map(r => ({ ...r, polygon: r.polygon.map(pt => transformPoint(pt, s, cx, cy)) })));
    setLots(ls => ls.map(l => ({ ...l, polygon: l.polygon.map(pt => transformPoint(pt, s, cx, cy)) })));
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

  // --------- ViewBox zoom helpers ---------
  function zoomAt(ux, uy, factor) {
    // factor > 1 zoom in, < 1 zoom out
    setViewBox(vb => {
      const w2 = vb.w / factor;
      const h2 = vb.h / factor;
      const ax = (ux - vb.x) / vb.w;
      const ay = (uy - vb.y) / vb.h;
      const x2 = ux - ax * w2;
      const y2 = uy - ay * h2;
      return { x: x2, y: y2, w: w2, h: h2 };
    });
  }

  function zoomInCenter() {
    setViewBox(vb => {
      const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
      const factor = 1.2;
      const w2 = vb.w / factor, h2 = vb.h / factor;
      return { x: cx - w2 / 2, y: cy - h2 / 2, w: w2, h: h2 };
    });
  }

  function zoomOutCenter() {
    setViewBox(vb => {
      const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
      const factor = 1.2;
      const w2 = vb.w * factor, h2 = vb.h * factor;
      return { x: cx - w2 / 2, y: cy - h2 / 2, w: w2, h: h2 };
    });
  }

  function resetView() { setViewBox(baseView); }

  function getAllPoints() {
    return [
      ...boundary,
      ...publicEntryPoints,
      ...internalRoads.flatMap(r => r.polygon),
      ...lots.flatMap(l => l.polygon),
      ...current,
    ];
  }

  function fitView() {
    const pts = getAllPoints();
    if (!pts.length) { resetView(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const margin = 0.1; // 10%
    const mw = w * margin, mh = h * margin;
    setViewBox({ x: minX - mw, y: minY - mh, w: w + 2 * mw, h: h + 2 * mh });
  }

  // -------------- Pointer → SVG coords --------------
  function clientToSvg(e) {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const { x, y } = pt.matrixTransform(svg.getScreenCTM().inverse());
    return [parseFloat(x.toFixed(2)), parseFloat(y.toFixed(2))];
  }

  function computePreviewPoint(e) {
  const raw0 = clientToSvg(e);
  if (!raw0) return null;

  // Xác định điểm trước đó để khóa trục nếu giữ Shift
  let prev = null;
  if (mode === "boundary" && !boundaryClosed && current.length) prev = current[current.length - 1];
  else if ((mode === "internalRoad" || mode === "lot") && current.length) prev = current[current.length - 1];
  else if (mode === "publicRoad" && publicEntryPoints.length) prev = publicEntryPoints[publicEntryPoints.length - 1];

  // 1) Khóa trục nếu giữ Shift
  const aligned = (e.shiftKey && prev) ? axisAlign(prev, raw0) : raw0;

  // 2) Snap vào GRID (theo px → đơn vị SVG)
  const tolUnitsGrid = gridTol * __avgUP;
  let p1 = gridSnap ? snapToGrid(aligned, gridStep, gridOrigin, tolUnitsGrid, gridStrict) : aligned;

  // 3) Snap vào LINE (chọn cái nào gần con trỏ hơn: grid hay line)
  const segments = collectSegments(boundary, boundaryClosed, current, internalRoads, lots);
  let p2 = p1;
  if (segments && segments.length) {
    const proj = snapToNearestSegment(aligned, segments, lineTol * __avgUP);
    if (proj) {
      const dGrid = distance(aligned, p1);
      const dLine = distance(aligned, proj);
      p2 = dLine <= dGrid ? [Number(proj[0].toFixed(2)), Number(proj[1].toFixed(2))] : p1;
    }
  }

  // 4) Snap/Merge vào VERTEX (nếu trong tolerance)
  const pools = [];
  if (boundary.length) pools.push(boundary);
  if (publicEntryPoints.length) pools.push(publicEntryPoints);
  if (current.length) {
    const poolExceptLast = current.slice(0, -1);
    if (poolExceptLast.length) pools.push(poolExceptLast);
  }
  for (const r of internalRoads) pools.push(r.polygon);
  for (const l of lots) pools.push(l.polygon);

  return snapToPools(p2, pools, snapTol * __avgUP);}

  function onCanvasClick(e) {
    const p = computePreviewPoint(e);
    if (!p) return;

    if (mode === "boundary") {
      if (boundaryClosed) return;
      setCurrent((cur) => dedupPush(cur, p));
    } else if (mode === "publicRoad") {
      // Project onto boundary if close to it so entry point stays on boundary
      let point = p;
      if (boundaryClosed && boundary.length >= 2) {
        const segs = collectSegments(boundary, true, [], [], []);
        const proj = snapToNearestSegment(p, segs, lineTol * __avgUP);
        if (proj) point = proj;
      }
      setPublicEntryPoints((list) => {
        const snapped = snapToPools(point, [boundary, list], snapTol * __avgUP);
        if (list.some((q) => Math.sqrt(dist2(q, snapped)) <= 1e-6)) return list; // de-dup
        return [...list, snapped];
      });
    } else if (mode === "internalRoad" || mode === "lot") {
      setCurrent((cur) => dedupPush(cur, p));
    }
  }

  function onMouseMove(e) {
    const p = computePreviewPoint(e);
    setHover(p);
  }

  function onMouseLeave() {
    setHover(null);
  }

  function closeShape() {
    if (mode === "boundary" && current.length >= 3) {
      let poly = current;
      if (autoScaleNew && autoApplyTo.boundary) poly = scalePolygonToArea(poly, Number(autoTargetArea));
      setBoundary(poly);
      setBoundaryClosed(true);
      setCurrent([]);
      setHover(null);
    } else if (mode === "internalRoad" && current.length >= 3) {
      let poly = current;
      if (autoScaleNew && autoApplyTo.internalRoad) poly = scalePolygonToArea(poly, Number(autoTargetArea));
      const id = nextRoadId();
      setInternalRoads((rs) => [
        ...rs,
        { road_id: id, polygon: poly, is_public: false, width: internalWidthDefault, connected_to_public_road: true, road_to_lot_mapping: [] },
      ]);
      setCurrent([]);
      setHover(null);
    } else if (mode === "lot" && current.length >= 3) {
      let poly = current;
      if (autoScaleNew && autoApplyTo.lot) poly = scalePolygonToArea(poly, Number(autoTargetArea));
      const id = nextLotId();
      // front_road is computed on demand during export or panel rendering
      setLots((ls) => [...ls, { lot_id: id, polygon: poly, front_road: null }]);
      setCurrent([]);
      setHover(null);
    }
  }

  function undo() {
    if (current.length) {
      setCurrent((cur) => cur.slice(0, -1));
      return;
    }
    if (mode === "publicRoad" && publicEntryPoints.length) {
      setPublicEntryPoints((ps) => ps.slice(0, -1));
      return;
    }
    if (mode === "internalRoad" && internalRoads.length) {
      setInternalRoads((rs) => rs.slice(0, -1));
      return;
    }
    if (mode === "lot" && lots.length) {
      setLots((ls) => ls.slice(0, -1));
      return;
    }
    if (mode === "boundary" && boundaryClosed) {
      setBoundaryClosed(false);
      setCurrent(boundary);
      setBoundary([]);
    }
  }

  function clearAll() {
    setCurrent([]);
    setBoundary([]);
    setBoundaryClosed(false);
    setPublicEntryPoints([]);
    setInternalRoads([]);
    setLots([]);
    setHover(null);
  }

  // Export PNG from the current SVG (uses current viewBox)
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

    // Ensure white background under everything
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
    const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
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
      canvas.toBlob((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
        URL.revokeObjectURL(url);
      }, "image/png", 1.0);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  // Export JSON in requested schema
function exportJSON() {
  const boundaryClosedLoop =
    boundaryClosed && boundary.length >= 3 ? [...boundary, boundary[0]] : boundary;

  const ctx = { boundary, boundaryClosed, publicEntryPoints, internalRoads };
  const tolUnits = 3 * __avgUP; // ~3px tolerance in SVG units

  // 1) Chuẩn hoá lot_id và tính front_road 1 lần
  const lotInfos = lots.map((l, idx) => {
    const id = l.lot_id ?? `${landId}-${String(idx + 1).padStart(2, "0")}`;
    const poly = l.polygon;
    const area = Number(shoelaceArea(poly).toFixed(1));
    const front = computeFrontRoadForLot(poly, ctx, tolUnits) ?? null;
    return { id, polygon: poly, area, front };
  });

  // 2) Gom mapping cho public road ("R003")
  const publicLotIds = lotInfos
    .filter(li => li.front === "R003")
    .map(li => li.id);

  // 3) Gom mapping cho từng internal road
  const internalRoadsOut = internalRoads.map(r => {
    const lotIds = lotInfos
      .filter(li => li.front === r.road_id)
      .map(li => li.id);
    return {
      road_id: r.road_id,
      polygon: r.polygon,
      is_public: false,
      width: Number(r.width ?? internalWidthDefault),
      connected_to_public_road: true,
      // >>> mảng chuỗi lot_id
      road_to_lot_mapping: lotIds,
    };
  });

  const out = {
    input: {
      land_id: landId,
      boundary: boundaryClosedLoop,
      roads: [
        {
          road_id: "R003", // public road cố định như sample
          is_public: true,
          width: Number(publicRoadWidth),
          entry_points: publicEntryPoints,
          connected_to_public_road: null,
          // >>> mảng chuỗi lot_id
          road_to_lot_mapping: publicLotIds,
        },
      ],
    },
    output: {
      internal_roads: internalRoadsOut,
      lots: lotInfos.map(li => ({
        lot_id: li.id,
        polygon: li.polygon,
        area: li.area,
        front_road: li.front,
      })),
    },
  };

  download(`${landId}_subdivision.json`, JSON.stringify(out, null, 2));
  // cũng xuất PNG snapshot
  exportPNG();
}


  // -------------- Render --------------
  // For live length label
  let previewPrev = null;
  if (hover) {
    if (mode === "boundary" && !boundaryClosed && current.length) previewPrev = current[current.length - 1];
    else if ((mode === "internalRoad" || mode === "lot") && current.length) previewPrev = current[current.length - 1];
  }
  const showPreview = !!(hover && previewPrev);
  const previewMid = showPreview ? [(previewPrev[0] + hover[0]) / 2, (previewPrev[1] + hover[1]) / 2] : null;
  const previewLen = showPreview ? distance(previewPrev, hover) : 0;

  return (
    <div className="w-full min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-screen-2xl 2xl:max-w-[1600px] mx-auto p-3 md:p-5 xl:p-6 space-y-3 xl:space-y-4">
        <header className="flex flex-wrap items-center gap-2 justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-xl md:text-2xl font-bold">Land Subdivision App</h1>
            <label className="flex items-center gap-2 text-sm">
              Land ID
              <input value={landId} onChange={(e) => setLandId(e.target.value)} className="border rounded px-1.5 py-0.5 h-7 text-xs w-20" />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={undo} className="px-2 py-0.5 text-xs rounded bg-gray-200 hover:bg-gray-300">Undo</button>
            <button onClick={clearAll} className="px-2 py-0.5 text-xs rounded bg-gray-200 hover:bg-gray-300">Clear All</button>
            <button onClick={closeShape} className="px-2 py-0.5 text-xs rounded bg-gray-800 text-white hover:bg-gray-700">Close shape</button>
            <button onClick={exportJSON} className="px-2 py-0.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-500">Export JSON + PNG</button>
          </div>
        </header>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-xs">MODE</span>
            <select value={mode} onChange={(e) => setMode(e.target.value)} className="border rounded px-1.5 py-0.5 h-7 text-xs w-28">
              <option value="boundary">Boundary</option>
              <option value="publicRoad">Public Road entry points</option>
              <option value="internalRoad">Internal Road (polygon)</option>
              <option value="lot">Lot (polygon)</option>
            </select>
          </div>

          <div className="flex items-center gap-2" hidden={mode !== "publicRoad"}>
            <span className="text-xs">Public width</span>
            <input type="number" value={publicRoadWidth} onChange={(e) => setPublicRoadWidth(e.target.value)} className="border rounded px-1.5 py-0.5 h-7 text-xs w-16" />
          </div>

          <div className="flex items-center gap-2" hidden={mode !== "internalRoad"}>
            <span className="text-xs">Internal width</span>
            <input type="number" value={internalWidthDefault} onChange={(e) => setInternalWidthDefault(e.target.value)} className="border rounded px-1.5 py-0.5 h-7 text-xs w-16" />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs">Snap tol (px)</span>
            <input type="number" value={snapTol} onChange={(e) => setSnapTol(Number(e.target.value) || 0)} className="border rounded px-1.5 py-0.5 h-7 text-xs w-14" />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs">Line tol (px)</span>
            <input type="number" value={lineTol} onChange={(e) => setLineTol(Number(e.target.value) || 0)} className="border rounded px-1.5 py-0.5 h-7 text-xs w-14" />
          </div>

          <div className="flex items-center gap-2">
  <label className="flex items-center gap-1">
    <input type="checkbox" checked={gridSnap} onChange={e=>setGridSnap(e.target.checked)} />
    Grid snap
  </label>
</div>

<div className="flex items-center gap-2">
  <span className="text-xs">Grid step</span>
  <input
    type="number"
    value={gridStep}
    onChange={e=>setGridStep(Number(e.target.value) || 1)}
    className="border rounded px-1.5 py-0.5 h-7 text-xs w-16"
  />
</div>

<div className="flex items-center gap-2">
  <span className="text-xs">Grid tol (px)</span>
  <input
    type="number"
    value={gridTol}
    onChange={e=>setGridTol(Number(e.target.value) || 0)}
    className="border rounded px-1.5 py-0.5 h-7 text-xs w-16"
  />
</div>

<div className="flex items-center gap-2">
  <label className="flex items-center gap-1">
    <input type="checkbox" checked={gridStrict} onChange={e=>setGridStrict(e.target.checked)} />
    Always to grid
  </label>
</div>


          {/* Zoom controls */}
          <div className="flex items-center gap-2">
            <span className="text-xs">Zoom</span>
            <button onClick={zoomOutCenter} className="px-1.5 py-0.5 text-xs rounded bg-gray-200 hover:bg-gray-300">-</button>
            <div className="w-12 text-center text-xs">{zoomPercent}%</div>
            <button onClick={() => {
              const svg = svgRef.current; if (!svg) return; const rect = svg.getBoundingClientRect();
              const cx = viewBox.x + viewBox.w/2; const cy = viewBox.y + viewBox.h/2;
              zoomAt(cx, cy, 1.2);
            }} className="px-1.5 py-0.5 text-xs rounded bg-gray-200 hover:bg-gray-300">+</button>
            <button onClick={fitView} className="px-1.5 py-0.5 text-xs rounded bg-gray-200 hover:bg-gray-300">Fit</button>
            <button onClick={resetView} className="px-1.5 py-0.5 text-xs rounded bg-gray-200 hover:bg-gray-300">Reset</button>
          </div>
        </div>

        {/* Auto-scale new shapes */}
        <div className="bg-white rounded-xl shadow p-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={autoScaleNew} onChange={e=>setAutoScaleNew(e.target.checked)} />
            <span className="text-xs">Auto-scale new shapes</span>
          </label>
          <div className="flex items-center gap-2">
            <span className="text-xs">Target area</span>
            <input type="number" value={autoTargetArea} onChange={e=>setAutoTargetArea(Number(e.target.value)||0)} className="border rounded px-1.5 py-0.5 h-7 text-xs w-16" />
            <span className="text-xs">m²</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span>Apply to:</span>
            <label className="flex items-center gap-1"><input type="checkbox" checked={autoApplyTo.lot} onChange={e=>setAutoApplyTo(v=>({...v, lot:e.target.checked}))} /> Lot</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={autoApplyTo.boundary} onChange={e=>setAutoApplyTo(v=>({...v, boundary:e.target.checked}))} /> Boundary</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={autoApplyTo.internalRoad} onChange={e=>setAutoApplyTo(v=>({...v, internalRoad:e.target.checked}))} /> Internal road</label>
          </div>
        </div>

        {/* Scale & Area Panel */}
        <div className="bg-white rounded-xl shadow p-2 flex flex-wrap items-end gap-4">
          <div>
            <div className="text-xs text-gray-600">Boundary area (current)</div>
            <div className="font-mono">{boundaryArea.toFixed(1)} m²</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs">Scale (%)</span>
            <button onClick={() => applyScaleFactor(0.9)} className="px-1.5 py-0.5 text-xs rounded bg-gray-200 hover:bg-gray-300">-10%</button>
            <input type="number" value={scalePct} onChange={e=>setScalePct(e.target.value)} className="border rounded px-1.5 py-0.5 h-7 text-xs w-16" />
            <button onClick={onApplyScalePct} className="px-2 py-0.5 text-xs rounded bg-gray-800 text-white hover:bg-gray-700">Apply</button>
            <button onClick={() => applyScaleFactor(1.1)} className="px-1.5 py-0.5 text-xs rounded bg-gray-200 hover:bg-gray-300">+10%</button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs">Target area</span>
            <input type="number" value={targetArea} onChange={e=>setTargetArea(e.target.value)} className="border rounded px-1.5 py-0.5 h-7 text-xs w-20" />
            <button onClick={onScaleToArea} disabled={boundaryArea<=0} className="px-2 py-0.5 text-xs rounded bg-blue-600 text-white disabled:opacity-50">Scale to area</button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs">Anchor</span>
            <select value={anchorType} onChange={e=>setAnchorType(e.target.value)} className="border rounded px-1.5 py-0.5 h-7 text-xs w-28">
              <option value="centroid">Boundary centroid</option>
              <option value="origin">(0,0)</option>
              <option value="custom">Custom</option>
            </select>
            <input type="number" value={anchorX} onChange={e=>setAnchorX(e.target.value)} className="border rounded px-1.5 py-0.5 h-7 text-xs w-16" disabled={anchorType!=="custom"} placeholder="cx" />
            <input type="number" value={anchorY} onChange={e=>setAnchorY(e.target.value)} className="border rounded px-1.5 py-0.5 h-7 text-xs w-16" disabled={anchorType!=="custom"} placeholder="cy" />
          </div>
        </div>

        <div className="rounded-2xl overflow-hidden bg-white shadow">
          <svg
            ref={svgRef}
            onClick={onCanvasClick}
            onWheel={(e)=>{ e.preventDefault(); const svg = svgRef.current; if (!svg) return; const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const { x, y } = pt.matrixTransform(svg.getScreenCTM().inverse()); const factor = e.deltaY < 0 ? 1.1 : 1/1.1; zoomAt(x, y, factor); }}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
            className="block mx-auto w-full h-[60vh] md:h-[70vh] xl:h-[78vh] 2xl:h-[82vh] cursor-crosshair"
          >
            {/* Grid */}
            <defs>
  {/* Lưới ô nhỏ */}
  <pattern id="grid" width={gridStep} height={gridStep} patternUnits="userSpaceOnUse">
    <path
      d={`M ${gridStep} 0 L 0 0 0 ${gridStep}`}
      fill="none"
      stroke="#e5e7eb"
      strokeWidth="1"
      vectorEffect="non-scaling-stroke"
      shapeRendering="crispEdges"
    />
  </pattern>

  {/* Lưới ô lớn (mỗi 5 ô nhỏ) cho dễ canh tổng thể */}
  <pattern id="gridMajor" width={gridStep * 5} height={gridStep * 5} patternUnits="userSpaceOnUse">
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
{/* vẽ phủ 2 lớp lưới */}
<rect width="2000%" height="2000%" fill="url(#grid)" pointerEvents="none" />
<rect width="2000%" height="2000%" fill="url(#gridMajor)" pointerEvents="none" />

            {/* Boundary */}
            {boundary.length >= 2 && !boundaryClosed && (
              <polyline points={boundary.map((p) => p.join(",")).join(" ")} fill="none" stroke="#111827" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            )}
            {boundaryClosed && (
              <polygon points={boundary.map((p) => p.join(",")).join(" ")} fill="none" stroke="#111827" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            )}
            {boundaryClosed && boundary.length >= 2 && (
              <g pointerEvents="none">
                {segmentsForLabels(boundary, true).map(([a,b], i) => {
                  const mid = [(a[0]+b[0])/2, (a[1]+b[1])/2];
                  return (
                    <text key={`b-l${i}`} x={mid[0] + DX_LABEL} y={mid[1] - DY_LABEL} fontSize={FONT_UNIT} fill="#111827">{distance(a,b).toFixed(2)} m</text>
                  );
                })}
              </g>
            )}
            {/* Current drawing path */}
            {current.length >= 2 && (
              <>
                <polyline points={current.map((p) => p.join(",")).join(" ")} fill="none" stroke="#fa0202" strokeDasharray="6 6" strokeWidth="4" vectorEffect="non-scaling-stroke" />
                <g pointerEvents="none">
                  {segmentsForLabels(current, false).map(([a,b], i) => {
                    const mid = [(a[0]+b[0])/2, (a[1]+b[1])/2];
                    return (
                      <text key={`cur-l${i}`} x={mid[0] + DX_LABEL} y={mid[1] - DY_LABEL} fontSize={FONT_UNIT} fill="#111827">{distance(a,b).toFixed(2)} m</text>
                    );
                  })}
                </g>
              </>
            )}

            {/* Live preview segment + length label */}
            {showPreview && (
              <g>
                <line x1={previewPrev[0]} y1={previewPrev[1]} x2={hover[0]} y2={hover[1]} stroke="#ef4444" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray="4 4" />
                <text x={previewMid[0] + DX_LABEL} y={previewMid[1] - DY_LABEL} fontSize={FONT_UNIT} fill="#111827">{previewLen.toFixed(2)} m</text>
              </g>
            )}

            {/* Public road entry points */}
            {publicEntryPoints.map((p, i) => (
              <g key={`pub-${i}`}>
                <circle cx={p[0]} cy={p[1]} r={R_EP} fill="#059669" />
                <text x={p[0] + DX_LABEL} y={p[1] - DY_LABEL} fontSize={FONT_UNIT} fill="#065f46">EP{i + 1}</text>
              </g>
            ))}

            {/* Internal roads polygons */}
            {internalRoads.map((r) => (
              <g key={r.road_id}>
                <polygon points={r.polygon.map((p) => p.join(",")).join(" ")} fill="#f59e0b55" stroke="#fadf5a" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                {r.polygon.length > 0 && (
                  <text x={r.polygon[0][0]} y={r.polygon[0][1]} fontSize={FONT_UNIT} fill="#92400e">{r.road_id}</text>
                )}
              </g>
            ))}

            {/* Lots polygons */}
            {lots.map((l) => (
              <g key={l.lot_id}>
                <polygon points={l.polygon.map((p) => p.join(",")).join(" ")} fill="#3b82f655" stroke="#1d4ed8" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                {l.polygon.length > 0 && (
                  <text x={l.polygon[0][0]} y={l.polygon[0][1]} fontSize={FONT_UNIT} fill="#1e40af">{l.lot_id} – {shoelaceArea(l.polygon).toFixed(0)} m²</text>
                )}
              </g>
            ))}

            {/* Current points markers */}
            {current.map((p, i) => (
              <circle key={`c-${i}`} cx={p[0]} cy={p[1]} r={R_POINT} fill="#fa0202" />
            ))}
          </svg>
        </div>

        <section className="grid md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3 xl:gap-5">
          <div className="bg-white rounded-xl shadow p-2">
            <h2 className="text-xs font-semibold mb-1">Boundary vertices</h2>
            <div className="text-xs text-gray-600">{boundaryClosed ? "Closed" : "Open"} • {boundary.length} points</div>
            <ol className="text-xs mt-2 max-h-48 overflow-auto space-y-1">
              {boundary.map((p, i) => (
                <li key={i} className="font-mono">[{p[0]}, {p[1]}]</li>
              ))}
            </ol>
          </div>

          <div className="bg-white rounded-xl shadow p-2">
            <h2 className="text-xs font-semibold mb-1">Public road entry points</h2>
            <div className="text-xs text-gray-600">width = {publicRoadWidth}</div>
            <ol className="text-xs mt-2 max-h-48 overflow-auto space-y-1">
              {publicEntryPoints.map((p, i) => (
                <li key={i} className="font-mono">EP{i + 1}: [{p[0]}, {p[1]}]</li>
              ))}
            </ol>
          </div>

          <div className="bg-white rounded-xl shadow p-2">
            <h2 className="text-xs font-semibold mb-1">Internal roads</h2>
            <ol className="text-xs mt-2 max-h-48 overflow-auto space-y-2">
              {internalRoads.map((r) => (
                <li key={r.road_id}>
                  <div className="font-medium">{r.road_id} • w={r.width} • {r.polygon.length} pts</div>
                </li>
              ))}
            </ol>
          </div>

          <div className="bg-white rounded-xl shadow p-2">
            <h2 className="text-xs font-semibold mb-1">Lots</h2>
            <ol className="text-xs mt-2 max-h-48 overflow-auto space-y-2">
              {lots.map((l) => {
                const ctx = { boundary, boundaryClosed, publicEntryPoints, internalRoads };
                const tolUnits = 3 * __avgUP;
                return (
                  <li key={l.lot_id}>
                    <div className="font-medium">{l.lot_id} • area={shoelaceArea(l.polygon).toFixed(1)} • front={computeFrontRoadForLot(l.polygon, ctx, tolUnits) ?? "-"}</div>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        <footer className="text-[11px] text-gray-500 pt-1">
          Tips: Click to add vertices → <b>Close shape</b> to finish the polygon. Use <b>Undo</b> to remove the last vertex or the last item in the current mode. Snap tolerance can be adjusted in the toolbar. Hold <b>Shift</b> while moving the mouse or clicking to lock the next segment to <b>水平 (horizontal)</b> or <b>垂直 (vertical)</b>. Click near a line to place the point onto that line. Use the Zoom controls (<b>buttons</b> or <b>mouse wheel</b>) and <b>Fit</b>/<b>Reset</b> for view navigation. Use <b>Auto-scale new shapes</b> to keep new polygons around your target area (default 200 m² for lots). The <b>Scale & Area</b> panel scales existing geometry uniformly around an anchor. While drawing, the <b>red dashed segment</b> shows realtime length (m).
        </footer>
      </div>
    </div>
  );
}

// --------------------------
// Inline smoke tests (run once in browser console)
// --------------------------
if (typeof window !== "undefined" && !window.__lsapp_tests_ran__) {
  window.__lsapp_tests_ran__ = true;
  (function runTests() {
    try {
      // Area test: 10x10 square
      console.assert(
        Math.abs(shoelaceArea([[0, 0], [10, 0], [10, 10], [0, 10]]) - 100) < 1e-9,
        "shoelaceArea square=100"
      );
      // Axis align tests
      const hor = axisAlign([0, 0], [5, 2]);
      console.assert(hor[1] === 0, "axisAlign horizontal keeps y");
      const ver = axisAlign([0, 0], [2, 5]);
      console.assert(ver[0] === 0, "axisAlign vertical keeps x");
      // Axis align tie-break (dx==dy → horizontal per implementation)
      const tie = axisAlign([0,0],[3,3]);
      console.assert(tie[1] === 0, "axisAlign tie goes horizontal");

      // Projection test
      const pr = pointSegProjection([5, 5], [0, 0], [10, 0]);
      console.assert(Math.abs(pr.proj[0] - 5) < 1e-6 && Math.abs(pr.proj[1] - 0) < 1e-6, "projection mid");
      // Segment snap test
      const segs = [[[0, 0], [10, 0]]];
      const proj2 = snapToNearestSegment([5, 2], segs, 5);
      console.assert(proj2 && Math.abs(proj2[1]) < 1e-6, "snap to segment within tol");

      // Vertex snap tests
      const pSnap = snapToPools([10.4, 0.3], [[[0, 0], [10, 0]]], 1);
      console.assert(Math.abs(pSnap[0] - 10) < 1e-6 && Math.abs(pSnap[1] - 0) < 1e-6, "vertex snap within 1px");
      const pNoSnap = snapToPools([10.9, 0.3], [[[0, 0], [10, 0]]], 0.5);
      console.assert(!(Math.abs(pNoSnap[0] - 10) < 1e-6 && Math.abs(pNoSnap[1] - 0) < 1e-6), "no snap if out of tol");

      // Scale tests
      const square = [[0,0],[10,0],[10,10],[0,10]];
      const s = 2; const scaled = square.map(p => [s*p[0], s*p[1]]);
      console.assert(Math.abs(shoelaceArea(scaled) - 400) < 1e-9, "scale area factor s^2");
      // Auto-scale test: scale 10x10 square (area=100) to 200
      const auto = scalePolygonToArea([[0,0],[10,0],[10,10],[0,10]], 200);
      console.assert(Math.abs(shoelaceArea(auto) - 200) < 1e-6, "auto-scale to target area");

      // Distance test
      console.assert(Math.abs(distance([0,0],[3,4]) - 5) < 1e-9, "distance 3-4-5");

      // Centroid test for a square (should be at 5,5)
      const cen = polygonCentroid([[0,0],[10,0],[10,10],[0,10]]);
      console.assert(Math.abs(cen[0]-5)<1e-9 && Math.abs(cen[1]-5)<1e-9, "centroid square at (5,5)");

      // Transform identity (scale 1 around origin)
      const tp = transformPoint([3,4], 1, 0, 0);
      console.assert(Math.abs(tp[0]-3)<1e-9 && Math.abs(tp[1]-4)<1e-9, "transformPoint s=1 is identity");

      // === NEW TESTS ===
      // Front-road selection: internal road touch
      const lotPoly = [[11,1],[19,1],[19,9],[11,9]]; // right square
      const roadPoly = [[9,3],[11,3],[11,7],[9,7]];  // touches lot at x=11
      const ctx1 = { boundary: [[0,0],[20,0],[20,10],[0,10]], boundaryClosed: true, publicEntryPoints: [], internalRoads: [{road_id:"R001", polygon: roadPoly}] };
      console.assert(computeFrontRoadForLot(lotPoly, ctx1, 0.1) === "R001", "front road = internal R001");

      // Front-road selection: public boundary between EP1 and EP2
      const boundary2 = [[0,0],[20,0],[20,10],[0,10]];
      const lot2 = [[2,-1],[6,-1],[6,1],[2,1]]; // touches bottom edge between x=0..20
      const ctx2 = { boundary: boundary2, boundaryClosed: true, publicEntryPoints: [[0,0],[20,0]], internalRoads: [] };
      console.assert(computeFrontRoadForLot(lot2, ctx2, 0.5) === "R003", "front road = public R003");

      console.log("All smoke tests passed ✔");
    } catch (e) {
      console.error("Smoke tests failed:", e);
    }
  })();
}
