const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/pdf.worker.min.js";

const pdfUpload = document.getElementById("pdfUpload");
const newBlankBtn = document.getElementById("newBlankBtn");
const pdfList = document.getElementById("pdfList");
const documentArea = document.getElementById("documentArea");
const statusEl = document.getElementById("status");
const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebarToggle");
const sidebarExpand = document.getElementById("sidebarExpand");
const penColor = document.getElementById("penColor");
const penThickness = document.getElementById("penThickness");
const thicknessValue = document.getElementById("thicknessValue");
const lassoMoveBackground = document.getElementById("lassoMoveBackground");

const buttons = {
  pen: document.getElementById("penBtn"),
  eraser: document.getElementById("eraserBtn"),
  lasso: document.getElementById("lassoBtn"),
  space: document.getElementById("spaceBtn"),
  undo: document.getElementById("undoBtn"),
  redo: document.getElementById("redoBtn"),
  copySelection: document.getElementById("copySelectionBtn"),
  deleteSelection: document.getElementById("deleteSelectionBtn"),
  save: document.getElementById("saveBtn"),
  export: document.getElementById("exportBtn"),
  deleteNotes: document.getElementById("deleteNotesBtn"),
};

let currentTool = "pen";
let currentColor = "#000000";
let currentWidth = 3;
let includeLassoBackground = false;
let currentDocument = null;
let currentDocumentType = null;
let currentMeta = {};
let currentPdf = null;
let pdfDoc = null;
let strokes = [];
let spaces = [];
let snips = [];
let masks = [];
let undoStack = [];
let redoStack = [];
let activeStroke = null;
let activeLasso = null;
let activeEraser = null;
let activeMove = null;
let selectedStrokeIds = new Set();
let selectedSnipId = null;
let currentSelection = null;
let pageCanvases = new Map();
let pageMetrics = new Map();

function setStatus(message) {
  statusEl.textContent = message;
  if (message) {
    window.clearTimeout(setStatus.timer);
    setStatus.timer = window.setTimeout(() => (statusEl.textContent = ""), 2500);
  }
}

function setTool(tool) {
  currentTool = tool;
  document.querySelectorAll(".tool").forEach((btn) => btn.classList.remove("active"));
  buttons[tool].classList.add("active");
}

function updateSelectionControls() {
  const hasSelection = selectedStrokeIds.size > 0 || Boolean(selectedSnipId || currentSelection);
  buttons.copySelection.disabled = !hasSelection;
  buttons.deleteSelection.disabled = !hasSelection;
}

function clearSelection() {
  const selectedPages = new Set(
    strokes.filter((stroke) => selectedStrokeIds.has(stroke.id)).map((stroke) => stroke.page)
  );
  if (selectedSnipId) {
    const snip = snips.find((item) => item.id === selectedSnipId);
    if (snip) selectedPages.add(snip.page);
  }
  if (currentSelection) selectedPages.add(currentSelection.page);
  selectedStrokeIds.clear();
  selectedSnipId = null;
  currentSelection = null;
  selectedPages.forEach((page) => redrawPage(page));
  updateSelectionControls();
}

function remember(action) {
  undoStack.push(action);
  redoStack = [];
}

async function loadPdfList() {
  const res = await fetch("/documents");
  const data = await res.json();
  pdfList.innerHTML = "";

  data.documents.forEach((doc) => {
    const btn = document.createElement("button");
    btn.className = "pdf-item";
    btn.type = "button";
    btn.textContent = doc.title;
    btn.title = doc.title;
    btn.dataset.type = doc.type;
    btn.addEventListener("click", () => openDocument(doc));
    if (doc.name === currentDocument && doc.type === currentDocumentType) btn.classList.add("active");
    pdfList.appendChild(btn);
  });
}

async function openDocument(doc) {
  if (doc.type === "blank") {
    await openBlankDocument(doc);
    return;
  }

  await openPdf(doc.name);
}

function resetDocumentState(docName, docType) {
  currentDocument = docName;
  currentDocumentType = docType;
  currentPdf = docType === "pdf" ? docName : null;
  currentMeta = {};
  strokes = [];
  spaces = [];
  snips = [];
  masks = [];
  undoStack = [];
  redoStack = [];
  activeStroke = null;
  activeLasso = null;
  activeEraser = null;
  activeMove = null;
  selectedStrokeIds.clear();
  selectedSnipId = null;
  currentSelection = null;
  updateSelectionControls();
  pageCanvases = new Map();
  pageMetrics = new Map();
  documentArea.innerHTML = "";
}

async function openPdf(filename) {
  resetDocumentState(filename, "pdf");
  setStatus("Loading PDF...");
  await loadPdfList();

  const annotationRes = await fetch(`/annotations/${encodeURIComponent(filename)}`);
  const annotationData = await annotationRes.json();
  currentMeta = annotationData.meta || {};
  strokes = annotationData.strokes || [];
  spaces = annotationData.spaces || [];
  snips = annotationData.snips || [];
  masks = annotationData.masks || [];

  pdfDoc = await pdfjsLib.getDocument(`/pdf/${encodeURIComponent(filename)}`).promise;
  await renderPdf();
  setStatus("Ready");
}

async function openBlankDocument(doc) {
  resetDocumentState(doc.name, "blank");
  pdfDoc = null;
  setStatus("Loading lined notes...");
  await loadPdfList();

  const annotationRes = await fetch(`/annotations/${encodeURIComponent(doc.name)}`);
  const annotationData = await annotationRes.json();
  currentMeta = {
    type: "blank",
    title: doc.title || doc.name,
    pageCount: 1,
    lineSpacing: 34,
    ...(annotationData.meta || {}),
  };
  strokes = annotationData.strokes || [];
  spaces = annotationData.spaces || [];
  snips = annotationData.snips || [];
  masks = annotationData.masks || [];

  renderBlankDocument();
  setStatus("Ready");
}

async function renderPdf() {
  const fragment = document.createDocumentFragment();
  pageCanvases = new Map();
  pageMetrics = new Map();

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
    const page = await pdfDoc.getPage(pageNumber);
    const naturalViewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(320, documentArea.clientWidth - 72);
    const scale = Math.min(1.35, availableWidth / naturalViewport.width);
    const viewport = page.getViewport({ scale });
    const pageSpaces = getPageSpaces(pageNumber);
    const baseWidth = Math.floor(viewport.width);
    const baseHeight = Math.floor(viewport.height);
    const extraHeight = pageSpaces.reduce((sum, space) => sum + (space.height || 180), 0);
    const pageHeight = baseHeight + extraHeight;

    const wrap = document.createElement("div");
    wrap.className = "page-wrap";
    wrap.dataset.page = String(pageNumber);

    const pdfCanvas = document.createElement("canvas");
    pdfCanvas.className = "pdf-canvas";
    pdfCanvas.width = baseWidth;
    pdfCanvas.height = pageHeight;

    const drawCanvas = document.createElement("canvas");
    drawCanvas.className = "draw-canvas";
    drawCanvas.width = pdfCanvas.width;
    drawCanvas.height = pdfCanvas.height;

    wrap.style.width = `${pdfCanvas.width}px`;
    wrap.style.height = `${pdfCanvas.height}px`;
    wrap.append(pdfCanvas, drawCanvas);
    fragment.appendChild(wrap);

    drawCanvas.addEventListener("pointerdown", onPointerDown);
    drawCanvas.addEventListener("pointermove", onPointerMove);
    drawCanvas.addEventListener("pointerup", onPointerUp);
    drawCanvas.addEventListener("pointercancel", onPointerUp);

    pageCanvases.set(pageNumber, drawCanvas);
    pageMetrics.set(pageNumber, {
      baseHeight,
      height: pageHeight,
      width: baseWidth,
      spaces: pageSpaces,
    });

    await renderPageWithSpaces(page, viewport, pdfCanvas, pageSpaces);
    drawSavedPageEdits(pdfCanvas, pageNumber);
    redrawPage(pageNumber);
  }

  documentArea.replaceChildren(fragment);
}

async function renderPdfKeepingScroll(scrollTop = documentArea.scrollTop) {
  await renderPdf();
  documentArea.scrollTop = scrollTop;
}

function renderBlankDocument() {
  const fragment = document.createDocumentFragment();
  pageCanvases = new Map();
  pageMetrics = new Map();

  const pageCount = currentMeta.pageCount || 1;
  const availableWidth = Math.max(320, documentArea.clientWidth - 72);
  const baseWidth = Math.min(816, availableWidth);
  const baseHeight = Math.round(baseWidth * (11 / 8.5));

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const pageSpaces = getPageSpaces(pageNumber);
    const extraHeight = pageSpaces.reduce((sum, space) => sum + (space.height || 180), 0);
    const pageHeight = baseHeight + extraHeight;

    const wrap = document.createElement("div");
    wrap.className = "page-wrap lined-page-wrap";
    wrap.dataset.page = String(pageNumber);

    const paperCanvas = document.createElement("canvas");
    paperCanvas.className = "pdf-canvas";
    paperCanvas.width = baseWidth;
    paperCanvas.height = pageHeight;

    const drawCanvas = document.createElement("canvas");
    drawCanvas.className = "draw-canvas";
    drawCanvas.width = paperCanvas.width;
    drawCanvas.height = paperCanvas.height;

    wrap.style.width = `${paperCanvas.width}px`;
    wrap.style.height = `${paperCanvas.height}px`;
    wrap.append(paperCanvas, drawCanvas);
    fragment.appendChild(wrap);

    drawCanvas.addEventListener("pointerdown", onPointerDown);
    drawCanvas.addEventListener("pointermove", onPointerMove);
    drawCanvas.addEventListener("pointerup", onPointerUp);
    drawCanvas.addEventListener("pointercancel", onPointerUp);

    pageCanvases.set(pageNumber, drawCanvas);
    pageMetrics.set(pageNumber, {
      baseHeight,
      height: pageHeight,
      width: baseWidth,
      spaces: pageSpaces,
    });

    renderLinedPageWithSpaces(paperCanvas, pageSpaces, baseHeight);
    drawSavedPageEdits(paperCanvas, pageNumber);
    redrawPage(pageNumber);
  }

  documentArea.replaceChildren(fragment);
}

async function renderDocumentKeepingScroll(scrollTop = documentArea.scrollTop) {
  if (currentDocumentType === "blank") {
    renderBlankDocument();
  } else {
    await renderPdf();
  }
  documentArea.scrollTop = scrollTop;
}

function renderLinedPageWithSpaces(canvas, pageSpaces, baseHeight) {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fffdf8";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let sourceY = 0;
  let destY = 0;

  pageSpaces.forEach((space) => {
    const insertY = Math.round(space.y * baseHeight);
    const segmentHeight = Math.max(0, insertY - sourceY);
    drawLinedSegment(ctx, destY, segmentHeight, canvas.width, sourceY);
    destY += segmentHeight;
    drawSpaceBand(ctx, destY, canvas.width, space.height || 180);
    drawLinedSegment(ctx, destY, space.height || 180, canvas.width, 0);
    destY += space.height || 180;
    sourceY = insertY;
  });

  if (sourceY < baseHeight) {
    drawLinedSegment(ctx, destY, baseHeight - sourceY, canvas.width, sourceY);
  }
}

function drawLinedSegment(ctx, y, height, width, sourceOffset) {
  const lineSpacing = currentMeta.lineSpacing || 34;
  const margin = Math.round(width * 0.11);
  ctx.fillStyle = "#fffdf8";
  ctx.fillRect(0, y, width, height);

  ctx.save();
  ctx.strokeStyle = "#c7d8f0";
  ctx.lineWidth = 1;
  for (let lineY = y + lineSpacing - (sourceOffset % lineSpacing); lineY < y + height; lineY += lineSpacing) {
    ctx.beginPath();
    ctx.moveTo(margin, Math.round(lineY) + 0.5);
    ctx.lineTo(width - 36, Math.round(lineY) + 0.5);
    ctx.stroke();
  }

  ctx.strokeStyle = "#f0a5a1";
  ctx.beginPath();
  ctx.moveTo(margin - 18.5, y + 24);
  ctx.lineTo(margin - 18.5, y + height - 24);
  ctx.stroke();
  ctx.restore();
}

function drawSavedPageEdits(canvas, page) {
  const ctx = canvas.getContext("2d");

  masks
    .filter((mask) => mask.page === page)
    .forEach((mask) => {
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(mask.x * canvas.width, mask.y * canvas.height, mask.width * canvas.width, mask.height * canvas.height);
      ctx.restore();
    });

  snips
    .filter((snip) => snip.page === page)
    .forEach((snip) => {
      const image = new Image();
      image.addEventListener("load", () => {
        ctx.drawImage(
          image,
          snip.x * canvas.width,
          snip.y * canvas.height,
          snip.width * canvas.width,
          snip.height * canvas.height
        );
      }, { once: true });
      image.src = snip.image;
    });
}

async function renderPageWithSpaces(page, viewport, pdfCanvas, pageSpaces) {
  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = Math.floor(viewport.width);
  baseCanvas.height = Math.floor(viewport.height);

  await page.render({
    canvasContext: baseCanvas.getContext("2d"),
    viewport,
  }).promise;

  const ctx = pdfCanvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, pdfCanvas.width, pdfCanvas.height);

  let sourceY = 0;
  let destY = 0;

  pageSpaces.forEach((space) => {
    const insertY = Math.round(space.y * baseCanvas.height);
    const segmentHeight = Math.max(0, insertY - sourceY);

    if (segmentHeight > 0) {
      ctx.drawImage(
        baseCanvas,
        0,
        sourceY,
        baseCanvas.width,
        segmentHeight,
        0,
        destY,
        pdfCanvas.width,
        segmentHeight
      );
    }

    destY += segmentHeight;
    drawSpaceBand(ctx, destY, pdfCanvas.width, space.height || 180);
    destY += space.height || 180;
    sourceY = insertY;
  });

  if (sourceY < baseCanvas.height) {
    ctx.drawImage(
      baseCanvas,
      0,
      sourceY,
      baseCanvas.width,
      baseCanvas.height - sourceY,
      0,
      destY,
      pdfCanvas.width,
      baseCanvas.height - sourceY
    );
  }
}

function drawSpaceBand(ctx, y, width, height) {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, y, width, height);
  ctx.strokeStyle = "#c5ccd8";
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  ctx.moveTo(24, y + 0.5);
  ctx.lineTo(width - 24, y + 0.5);
  ctx.moveTo(24, y + height - 0.5);
  ctx.lineTo(width - 24, y + height - 0.5);
  ctx.stroke();
  ctx.restore();
}

function getPageSpaces(page) {
  return spaces
    .filter((space) => space.page === page)
    .sort((a, b) => a.y - b.y);
}

function getPoint(event, canvas) {
  const point = getCanvasPoint(event, canvas);
  return {
    x: point.x / canvas.width,
    y: point.y / canvas.height,
    pressure: event.pressure || (event.pointerType === "pen" ? 0.7 : 0.5),
  };
}

function getCanvasPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return {
    x: (x / rect.width) * canvas.width,
    y: (y / rect.height) * canvas.height,
  };
}

function onPointerDown(event) {
  if (!currentDocument) return;
  const canvas = event.currentTarget;
  const page = Number(canvas.parentElement.dataset.page);
  const point = getPoint(event, canvas);

  if (currentTool === "space") {
    addSpace(page, getCanvasPoint(event, canvas).y);
    return;
  }

  canvas.setPointerCapture(event.pointerId);

  if (currentTool === "eraser") {
    activeEraser = {
      page,
      erased: [],
      erasedIds: new Set(),
    };
    eraseAtPoint(page, point, canvas, activeEraser);
    return;
  }

  if (currentTool === "lasso") {
    const moveTarget = getMoveTarget(page, point);
    if (moveTarget) {
      activeMove = {
        ...moveTarget,
        start: point,
        originalX: moveTarget.target.x,
        originalY: moveTarget.target.y,
      };
      return;
    }

    clearSelection();
    activeLasso = { page, points: [point] };
    return;
  }

  clearSelection();
  activeStroke = {
    id: crypto.randomUUID(),
    page,
    color: currentColor,
    width: currentWidth,
    points: [point],
  };
}

function onPointerMove(event) {
  const canvas = event.currentTarget;
  if (activeStroke && currentTool === "pen") {
    activeStroke.points.push(getPoint(event, canvas));
    redrawPage(activeStroke.page, activeStroke);
  }

  if (activeLasso && currentTool === "lasso") {
    activeLasso.points.push(getPoint(event, canvas));
    redrawPage(activeLasso.page, null, activeLasso);
  }

  if (activeEraser && currentTool === "eraser") {
    eraseAtPoint(activeEraser.page, getPoint(event, canvas), canvas, activeEraser);
  }

  if (activeMove && currentTool === "lasso") {
    const point = getPoint(event, canvas);
    const target = activeMove.target;
    target.x = Math.max(0, Math.min(1 - target.width, activeMove.originalX + point.x - activeMove.start.x));
    target.y = Math.max(0, Math.min(1 - target.height, activeMove.originalY + point.y - activeMove.start.y));
    redrawPage(activeMove.page);
  }
}

function onPointerUp() {
  if (activeStroke) {
    if (activeStroke.points.length > 1) {
      strokes.push(activeStroke);
      remember({ type: "addStroke", stroke: activeStroke });
    }
    redrawPage(activeStroke.page);
    activeStroke = null;
  }

  if (activeLasso) {
    finishLasso(activeLasso);
    activeLasso = null;
  }

  if (activeEraser) {
    if (activeEraser.erased.length) {
      remember({ type: "eraseStrokes", strokes: activeEraser.erased });
      setStatus(`${activeEraser.erased.length} stroke(s) erased`);
    }
    activeEraser = null;
  }

  if (activeMove) {
    finishMoveSelection(activeMove);
    activeMove = null;
  }
}

function drawStroke(ctx, stroke, canvas, selected = false) {
  if (!stroke.points.length) return;
  if (selected) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255, 190, 40, 0.85)";
    ctx.lineWidth = stroke.width + 8;
    drawStrokePath(ctx, stroke, canvas);
    ctx.stroke();
    ctx.restore();
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  drawStrokePath(ctx, stroke, canvas);
  ctx.stroke();
}

function drawStrokePath(ctx, stroke, canvas) {
  ctx.beginPath();

  stroke.points.forEach((point, index) => {
    const x = point.x * canvas.width;
    const y = point.y * canvas.height;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      const prev = stroke.points[index - 1];
      const midX = ((prev.x + point.x) / 2) * canvas.width;
      const midY = ((prev.y + point.y) / 2) * canvas.height;
      ctx.quadraticCurveTo(prev.x * canvas.width, prev.y * canvas.height, midX, midY);
    }
  });
}

function drawLasso(ctx, lasso, canvas) {
  if (!lasso.points.length) return;
  ctx.save();
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  lasso.points.forEach((point, index) => {
    const x = point.x * canvas.width;
    const y = point.y * canvas.height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  if (lasso.points.length > 2) ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function redrawPage(page, previewStroke = null, previewLasso = null) {
  const canvas = pageCanvases.get(page);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  strokes
    .filter((stroke) => stroke.page === page)
    .forEach((stroke) => drawStroke(ctx, stroke, canvas, selectedStrokeIds.has(stroke.id)));
  if (previewStroke) drawStroke(ctx, previewStroke, canvas);
  if (previewLasso) drawLasso(ctx, previewLasso, canvas);
  drawSelectionBox(ctx, canvas, page);
}

function drawSelectionBox(ctx, canvas, page) {
  const selection = currentSelection?.page === page ? currentSelection : null;
  const snip = selectedSnipId ? snips.find((item) => item.id === selectedSnipId && item.page === page) : null;
  const target = selection || snip;
  if (!target) return;

  ctx.save();
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 5]);
  ctx.strokeRect(
    target.x * canvas.width,
    target.y * canvas.height,
    target.width * canvas.width,
    target.height * canvas.height
  );
  ctx.restore();
}

function eraseAtPoint(page, point, canvas, eraserState = null) {
  const radius = Math.max(14, currentWidth + 8);
  const erasedNow = [];

  strokes
    .filter((stroke) => stroke.page === page)
    .forEach((stroke) => {
      const alreadyErased = eraserState?.erasedIds.has(stroke.id);
      const hit = !alreadyErased && stroke.points.some((p, index) => {
        if (index === 0) return distance(point, p, canvas) < radius;
        return segmentDistance(point, stroke.points[index - 1], p, canvas) < radius;
      });
      if (hit) erasedNow.push(stroke);
    });

  if (!erasedNow.length) return;

  erasedNow.forEach((stroke) => selectedStrokeIds.delete(stroke.id));
  updateSelectionControls();
  const erasedIds = new Set(erasedNow.map((stroke) => stroke.id));
  strokes = strokes.filter((stroke) => !erasedIds.has(stroke.id));

  if (eraserState) {
    eraserState.erased.push(...erasedNow);
    erasedNow.forEach((stroke) => eraserState.erasedIds.add(stroke.id));
  } else {
    remember({ type: "eraseStrokes", strokes: erasedNow });
  }
  redrawPage(page);
}

function distance(a, b, canvas) {
  return Math.hypot((a.x - b.x) * canvas.width, (a.y - b.y) * canvas.height);
}

function segmentDistance(p, a, b, canvas) {
  const px = p.x * canvas.width;
  const py = p.y * canvas.height;
  const ax = a.x * canvas.width;
  const ay = a.y * canvas.height;
  const bx = b.x * canvas.width;
  const by = b.y * canvas.height;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = a.y > point.y !== b.y > point.y;
    if (crosses && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function getLassoBounds(points) {
  const minX = Math.max(0, Math.min(...points.map((point) => point.x)));
  const minY = Math.max(0, Math.min(...points.map((point) => point.y)));
  const maxX = Math.min(1, Math.max(...points.map((point) => point.x)));
  const maxY = Math.min(1, Math.max(...points.map((point) => point.y)));
  return {
    x: minX,
    y: minY,
    width: Math.max(0.01, maxX - minX),
    height: Math.max(0.01, maxY - minY),
  };
}

function captureSelection(page, bounds, strokeIds, includeBackground = false) {
  const drawCanvas = pageCanvases.get(page);
  if (!drawCanvas) return null;
  const baseCanvas = drawCanvas.parentElement.querySelector(".pdf-canvas");
  const cropX = Math.round(bounds.x * drawCanvas.width);
  const cropY = Math.round(bounds.y * drawCanvas.height);
  const cropWidth = Math.max(1, Math.round(bounds.width * drawCanvas.width));
  const cropHeight = Math.max(1, Math.round(bounds.height * drawCanvas.height));

  const composite = document.createElement("canvas");
  composite.width = drawCanvas.width;
  composite.height = drawCanvas.height;
  const compositeCtx = composite.getContext("2d");
  if (includeBackground) compositeCtx.drawImage(baseCanvas, 0, 0);
  strokes
    .filter((stroke) => stroke.page === page && strokeIds.includes(stroke.id))
    .forEach((stroke) => drawStroke(compositeCtx, stroke, drawCanvas));

  const crop = document.createElement("canvas");
  crop.width = cropWidth;
  crop.height = cropHeight;
  crop.getContext("2d").drawImage(composite, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  return crop.toDataURL("image/png");
}

function translateStrokes(strokeIds, dx, dy) {
  const ids = new Set(strokeIds);
  strokes
    .filter((stroke) => ids.has(stroke.id))
    .forEach((stroke) => {
      stroke.points.forEach((point) => {
        point.x = Math.max(0, Math.min(1, point.x + dx));
        point.y = Math.max(0, Math.min(1, point.y + dy));
      });
    });
}

function cloneTranslatedStrokes(sourceStrokes, dx, dy) {
  return sourceStrokes.map((stroke) => ({
    ...stroke,
    id: crypto.randomUUID(),
    points: stroke.points.map((point) => ({
      x: Math.max(0, Math.min(1, point.x + dx)),
      y: Math.max(0, Math.min(1, point.y + dy)),
    })),
  }));
}

function hitBox(point, box) {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

function getMoveTarget(page, point) {
  if (currentSelection?.page === page && hitBox(point, currentSelection)) {
    return { type: "selection", page, target: currentSelection };
  }

  const hitSnip = [...snips].reverse().find((snip) => snip.page === page && hitBox(point, snip));
  if (!hitSnip) return null;

  clearSelection();
  selectedSnipId = hitSnip.id;
  updateSelectionControls();
  redrawPage(page);
  return { type: "snip", page, target: hitSnip };
}

function finishLasso(lasso) {
  selectedStrokeIds.clear();
  currentSelection = null;
  selectedSnipId = null;

  if (lasso.points.length > 2) {
    strokes
      .filter((stroke) => stroke.page === lasso.page)
      .forEach((stroke) => {
        const selected = stroke.points.some((point) => pointInPolygon(point, lasso.points));
        if (selected) selectedStrokeIds.add(stroke.id);
      });

    if (selectedStrokeIds.size) {
      const bounds = getLassoBounds(lasso.points);
      currentSelection = {
        id: crypto.randomUUID(),
        page: lasso.page,
        ...bounds,
        originalX: bounds.x,
        originalY: bounds.y,
        originalWidth: bounds.width,
        originalHeight: bounds.height,
        strokeIds: [...selectedStrokeIds],
        includeBackground: includeLassoBackground,
        image: includeLassoBackground ? captureSelection(lasso.page, bounds, [...selectedStrokeIds], true) : null,
      };
    }
  }

  redrawPage(lasso.page);
  updateSelectionControls();
  setStatus(currentSelection ? "Selection ready to move or copy" : "No selection");
}

function finishMoveSelection(move) {
  const moved = Math.abs(move.target.x - move.originalX) > 0.001 || Math.abs(move.target.y - move.originalY) > 0.001;
  if (!moved) {
    redrawPage(move.page);
    return;
  }

  if (move.type === "snip") {
    remember({
      type: "moveSnip",
      snipId: move.target.id,
      from: { x: move.originalX, y: move.originalY },
      to: { x: move.target.x, y: move.target.y },
    });
    renderDocumentKeepingScroll();
    return;
  }

  const selection = move.target;
  if (!selection.includeBackground) {
    const dx = selection.x - selection.originalX;
    const dy = selection.y - selection.originalY;
    translateStrokes(selection.strokeIds, dx, dy);
    selectedStrokeIds = new Set(selection.strokeIds);
    currentSelection = null;
    remember({ type: "moveStrokes", strokeIds: selection.strokeIds, page: selection.page, dx, dy });
    updateSelectionControls();
    redrawPage(selection.page);
    setStatus("Writing moved");
    return;
  }

  if (!selection.image) return;

  const snip = {
    id: crypto.randomUUID(),
    page: selection.page,
    image: selection.image,
    x: selection.x,
    y: selection.y,
    width: selection.width,
    height: selection.height,
  };
  const mask = {
    id: crypto.randomUUID(),
    page: selection.page,
    x: selection.originalX,
    y: selection.originalY,
    width: selection.originalWidth,
    height: selection.originalHeight,
  };
  const movedStrokeIds = new Set(selection.strokeIds);
  const movedStrokes = strokes.filter((stroke) => movedStrokeIds.has(stroke.id));

  snips.push(snip);
  masks.push(mask);
  strokes = strokes.filter((stroke) => !movedStrokeIds.has(stroke.id));
  selectedStrokeIds.clear();
  selectedSnipId = snip.id;
  currentSelection = null;
  remember({ type: "moveSelection", snip, mask, strokes: movedStrokes });
  updateSelectionControls();
  renderDocumentKeepingScroll();
  setStatus("Selection moved");
}

function copySelection() {
  if (currentSelection && !currentSelection.includeBackground) {
    const copiedFrom = strokes.filter((stroke) => currentSelection.strokeIds.includes(stroke.id));
    const copied = cloneTranslatedStrokes(copiedFrom, 0.03, 0.03);
    if (!copied.length) return;
    strokes.push(...copied);
    selectedStrokeIds = new Set(copied.map((stroke) => stroke.id));
    currentSelection = null;
    remember({ type: "addStrokes", strokes: copied });
    updateSelectionControls();
    copied.forEach((stroke) => redrawPage(stroke.page));
    setStatus("Writing copied");
    return;
  }

  if (currentSelection?.image) {
    const snip = {
      id: crypto.randomUUID(),
      page: currentSelection.page,
      image: currentSelection.image,
      x: Math.min(1 - currentSelection.width, currentSelection.x + 0.03),
      y: Math.min(1 - currentSelection.height, currentSelection.y + 0.03),
      width: currentSelection.width,
      height: currentSelection.height,
    };
    snips.push(snip);
    selectedStrokeIds.clear();
    selectedSnipId = snip.id;
    currentSelection = null;
    remember({ type: "addSnip", snip });
    updateSelectionControls();
    renderDocumentKeepingScroll();
    setStatus("Selection copied");
    return;
  }

  const snip = snips.find((item) => item.id === selectedSnipId);
  if (!snip) return;
  const copy = {
    ...snip,
    id: crypto.randomUUID(),
    x: Math.min(1 - snip.width, snip.x + 0.03),
    y: Math.min(1 - snip.height, snip.y + 0.03),
  };
  snips.push(copy);
  selectedSnipId = copy.id;
  remember({ type: "addSnip", snip: copy });
  updateSelectionControls();
  renderDocumentKeepingScroll();
  setStatus("Selection copied");
}

function deleteSelectedStrokes() {
  if (currentSelection) {
    if (!currentSelection.includeBackground) {
      const page = currentSelection.page;
      const deletedIds = new Set(currentSelection.strokeIds);
      const removed = strokes.filter((stroke) => deletedIds.has(stroke.id));
      strokes = strokes.filter((stroke) => !deletedIds.has(stroke.id));
      remember({ type: "deleteSelection", strokes: removed });
      selectedStrokeIds.clear();
      currentSelection = null;
      updateSelectionControls();
      redrawPage(page);
      setStatus("Writing deleted");
      return;
    }

    const mask = {
      id: crypto.randomUUID(),
      page: currentSelection.page,
      x: currentSelection.originalX,
      y: currentSelection.originalY,
      width: currentSelection.originalWidth,
      height: currentSelection.originalHeight,
    };
    const deletedIds = new Set(currentSelection.strokeIds);
    const removed = strokes.filter((stroke) => deletedIds.has(stroke.id));
    masks.push(mask);
    strokes = strokes.filter((stroke) => !deletedIds.has(stroke.id));
    remember({ type: "deleteSelectionArea", mask, strokes: removed });
    selectedStrokeIds.clear();
    currentSelection = null;
    updateSelectionControls();
    renderDocumentKeepingScroll();
    setStatus("Selection deleted");
    return;
  }

  if (selectedSnipId) {
    const removed = snips.find((snip) => snip.id === selectedSnipId);
    if (!removed) return;
    snips = snips.filter((snip) => snip.id !== selectedSnipId);
    selectedSnipId = null;
    remember({ type: "deleteSnip", snip: removed });
    updateSelectionControls();
    renderDocumentKeepingScroll();
    setStatus("Selection deleted");
    return;
  }

  if (!selectedStrokeIds.size) return;
  const removed = strokes.filter((stroke) => selectedStrokeIds.has(stroke.id));
  const pages = new Set(removed.map((stroke) => stroke.page));

  strokes = strokes.filter((stroke) => !selectedStrokeIds.has(stroke.id));
  remember({ type: "deleteSelection", strokes: removed });
  selectedStrokeIds.clear();
  pages.forEach((page) => redrawPage(page));
  updateSelectionControls();
  setStatus("Selection deleted");
}

function visualYToPdfRatio(page, visualY) {
  const metrics = pageMetrics.get(page);
  if (!metrics) return 0;

  let offset = 0;
  metrics.spaces.forEach((space) => {
    const insertY = space.y * metrics.baseHeight + offset;
    if (visualY > insertY) offset += space.height || 180;
  });

  return Math.max(0, Math.min(1, (visualY - offset) / metrics.baseHeight));
}

function pdfRatioToVisualY(page, targetSpace) {
  const metrics = pageMetrics.get(page);
  if (!metrics) return 0;

  const priorSpaceHeight = metrics.spaces
    .filter((space) => space.id !== targetSpace.id && space.y <= targetSpace.y)
    .reduce((sum, space) => sum + (space.height || 180), 0);

  return targetSpace.y * metrics.baseHeight + priorSpaceHeight;
}

function rescalePageItemsForHeight(page, oldHeight, newHeight) {
  if (!oldHeight || !newHeight) return;

  const canvas = pageCanvases.get(page);
  const width = canvas?.width || pageMetrics.get(page)?.width || 1;

  strokes
    .filter((stroke) => stroke.page === page)
    .forEach((stroke) => {
      stroke.points.forEach((point) => {
        point.y = Math.max(0, Math.min(1, (point.y * oldHeight) / newHeight));
      });
    });

  [...snips, ...masks]
    .filter((item) => item.page === page)
    .forEach((item) => {
      item.y = Math.max(0, Math.min(1, (item.y * oldHeight) / newHeight));
      item.height = Math.max(0.01, Math.min(1, (item.height * oldHeight) / newHeight));
      item.x = Math.max(0, Math.min(1, (item.x * width) / width));
    });
}

function addSpace(page, insertY) {
  const scrollTop = documentArea.scrollTop;
  const height = 180;
  const oldHeight = pageCanvases.get(page)?.height || pageMetrics.get(page)?.height;
  const space = {
    id: crypto.randomUUID(),
    page,
    y: visualYToPdfRatio(page, insertY),
    height,
  };

  rescalePageItemsForHeight(page, oldHeight, oldHeight + height);
  spaces.push(space);
  remember({ type: "addSpace", space });
  renderDocumentKeepingScroll(scrollTop);
}

function undo() {
  const action = undoStack.pop();
  if (!action) return;

  if (action.type === "addStroke") {
    strokes = strokes.filter((stroke) => stroke.id !== action.stroke.id);
    redrawPage(action.stroke.page);
  }

  if (action.type === "addStrokes") {
    const addedIds = new Set(action.strokes.map((stroke) => stroke.id));
    strokes = strokes.filter((stroke) => !addedIds.has(stroke.id));
    action.strokes.forEach((stroke) => redrawPage(stroke.page));
  }

  if (action.type === "eraseStroke") {
    strokes.push(action.stroke);
    redrawPage(action.stroke.page);
  }

  if (action.type === "eraseStrokes") {
    strokes.push(...action.strokes);
    action.strokes.forEach((stroke) => redrawPage(stroke.page));
  }

  if (action.type === "deleteSelection") {
    strokes.push(...action.strokes);
    action.strokes.forEach((stroke) => redrawPage(stroke.page));
  }

  if (action.type === "addSnip") {
    snips = snips.filter((snip) => snip.id !== action.snip.id);
    renderDocumentKeepingScroll();
  }

  if (action.type === "deleteSnip") {
    snips.push(action.snip);
    renderDocumentKeepingScroll();
  }

  if (action.type === "moveSnip") {
    const snip = snips.find((item) => item.id === action.snipId);
    if (snip) {
      snip.x = action.from.x;
      snip.y = action.from.y;
      renderDocumentKeepingScroll();
    }
  }

  if (action.type === "moveStrokes") {
    translateStrokes(action.strokeIds, -action.dx, -action.dy);
    redrawPage(action.page);
  }

  if (action.type === "moveSelection") {
    snips = snips.filter((snip) => snip.id !== action.snip.id);
    masks = masks.filter((mask) => mask.id !== action.mask.id);
    strokes.push(...action.strokes);
    renderDocumentKeepingScroll();
  }

  if (action.type === "deleteSelectionArea") {
    masks = masks.filter((mask) => mask.id !== action.mask.id);
    strokes.push(...action.strokes);
    renderDocumentKeepingScroll();
  }

  if (action.type === "addSpace") {
    const scrollTop = documentArea.scrollTop;
    const oldHeight = pageCanvases.get(action.space.page)?.height || pageMetrics.get(action.space.page)?.height;
    rescalePageItemsForHeight(action.space.page, oldHeight, oldHeight - (action.space.height || 180));
    spaces = spaces.filter((space) => space.id !== action.space.id);
    renderDocumentKeepingScroll(scrollTop);
  }

  redoStack.push(action);
}

function redo() {
  const action = redoStack.pop();
  if (!action) return;

  if (action.type === "addStroke") {
    strokes.push(action.stroke);
    redrawPage(action.stroke.page);
  }

  if (action.type === "addStrokes") {
    strokes.push(...action.strokes);
    action.strokes.forEach((stroke) => redrawPage(stroke.page));
  }

  if (action.type === "eraseStroke") {
    strokes = strokes.filter((stroke) => stroke.id !== action.stroke.id);
    redrawPage(action.stroke.page);
  }

  if (action.type === "eraseStrokes") {
    const erasedIds = new Set(action.strokes.map((stroke) => stroke.id));
    strokes = strokes.filter((stroke) => !erasedIds.has(stroke.id));
    action.strokes.forEach((stroke) => redrawPage(stroke.page));
  }

  if (action.type === "deleteSelection") {
    const deletedIds = new Set(action.strokes.map((stroke) => stroke.id));
    strokes = strokes.filter((stroke) => !deletedIds.has(stroke.id));
    action.strokes.forEach((stroke) => redrawPage(stroke.page));
  }

  if (action.type === "addSnip") {
    snips.push(action.snip);
    renderDocumentKeepingScroll();
  }

  if (action.type === "deleteSnip") {
    snips = snips.filter((snip) => snip.id !== action.snip.id);
    renderDocumentKeepingScroll();
  }

  if (action.type === "moveSnip") {
    const snip = snips.find((item) => item.id === action.snipId);
    if (snip) {
      snip.x = action.to.x;
      snip.y = action.to.y;
      renderDocumentKeepingScroll();
    }
  }

  if (action.type === "moveStrokes") {
    translateStrokes(action.strokeIds, action.dx, action.dy);
    redrawPage(action.page);
  }

  if (action.type === "moveSelection") {
    const movedIds = new Set(action.strokes.map((stroke) => stroke.id));
    strokes = strokes.filter((stroke) => !movedIds.has(stroke.id));
    masks.push(action.mask);
    snips.push(action.snip);
    renderDocumentKeepingScroll();
  }

  if (action.type === "deleteSelectionArea") {
    const deletedIds = new Set(action.strokes.map((stroke) => stroke.id));
    strokes = strokes.filter((stroke) => !deletedIds.has(stroke.id));
    masks.push(action.mask);
    renderDocumentKeepingScroll();
  }

  if (action.type === "addSpace") {
    const scrollTop = documentArea.scrollTop;
    const oldHeight = pageCanvases.get(action.space.page)?.height || pageMetrics.get(action.space.page)?.height;
    rescalePageItemsForHeight(action.space.page, oldHeight, oldHeight + (action.space.height || 180));
    spaces.push(action.space);
    renderDocumentKeepingScroll(scrollTop);
  }

  undoStack.push(action);
}

async function saveAnnotations() {
  if (!currentDocument) return;
  const res = await fetch(`/annotations/${encodeURIComponent(currentDocument)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: currentMeta, strokes, spaces, snips, masks }),
  });

  setStatus(res.ok ? "Notes saved" : "Save failed");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function getExportPages() {
  return [...document.querySelectorAll(".page-wrap")].map((pageWrap) => {
    const baseCanvas = pageWrap.querySelector(".pdf-canvas");
    const drawCanvas = pageWrap.querySelector(".draw-canvas");
    const composite = document.createElement("canvas");
    composite.width = baseCanvas.width;
    composite.height = baseCanvas.height;

    const ctx = composite.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, composite.width, composite.height);
    ctx.drawImage(baseCanvas, 0, 0);
    ctx.drawImage(drawCanvas, 0, 0);

    return {
      width: composite.width,
      height: composite.height,
      image: composite.toDataURL("image/png"),
    };
  });
}

function exportAnnotations() {
  if (!currentDocument) return;
  const pages = getExportPages();
  if (!pages.length) {
    setStatus("Nothing to export");
    return;
  }

  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    setStatus("Allow popups to export PDF");
    return;
  }

  const title = currentMeta.title || currentDocument.replace(/\.pdf$/i, "");
  const pageHtml = pages.map((page) => `
    <section class="page" style="aspect-ratio: ${page.width} / ${page.height};">
      <img src="${page.image}" alt="">
    </section>
  `).join("");

  printWindow.document.write(`
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${escapeHtml(title)} notes</title>
      <style>
        * { box-sizing: border-box; }
        html, body { margin: 0; background: #f2f4f7; }
        body { font-family: Arial, sans-serif; }
        .page {
          width: min(100vw, 8.5in);
          margin: 0 auto 16px;
          background: #fff;
          page-break-after: always;
        }
        .page img {
          display: block;
          width: 100%;
          height: 100%;
        }
        @media print {
          @page { margin: 0.25in; }
          html, body { background: #fff; }
          .page {
            width: 100%;
            margin: 0;
            box-shadow: none;
            break-after: page;
            page-break-after: always;
          }
          .page:last-child {
            break-after: auto;
            page-break-after: auto;
          }
        }
      </style>
    </head>
    <body>${pageHtml}</body>
    </html>
  `);
  printWindow.document.close();
  printWindow.addEventListener("load", () => {
    printWindow.focus();
    printWindow.print();
  }, { once: true });
  setStatus("Choose Save as PDF in the print dialog");
}

async function deleteAnnotations() {
  if (!currentDocument) return;
  const confirmed = window.confirm(`Delete "${currentMeta.title || currentDocument}" and all saved notes? This cannot be undone.`);
  if (!confirmed) return;

  const res = await fetch(`/annotations/${encodeURIComponent(currentDocument)}`, { method: "DELETE" });
  if (!res.ok) {
    setStatus("Delete failed");
    return;
  }

  strokes = [];
  spaces = [];
  snips = [];
  masks = [];
  undoStack = [];
  redoStack = [];
  selectedStrokeIds.clear();
  selectedSnipId = null;
  currentSelection = null;
  updateSelectionControls();
  documentArea.innerHTML = '<div class="empty-state">Import a PDF, select a document, or start lined notes.</div>';
  currentDocument = null;
  currentDocumentType = null;
  currentMeta = {};
  currentPdf = null;
  pdfDoc = null;
  await loadPdfList();
  setStatus("Document deleted");
}

pdfUpload.addEventListener("change", async () => {
  const file = pdfUpload.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("pdf", file);

  const res = await fetch("/upload", { method: "POST", body: formData });
  const data = await res.json();
  pdfUpload.value = "";

  if (!res.ok) {
    setStatus(data.error || "Upload failed");
    return;
  }

  await loadPdfList();
  await openPdf(data.filename);
});

newBlankBtn.addEventListener("click", async () => {
  const title = window.prompt("Name this lined document", "Lined notes");
  if (title === null) return;

  const res = await fetch("/blank-documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const doc = await res.json();

  if (!res.ok) {
    setStatus(doc.error || "Could not create notes");
    return;
  }

  await loadPdfList();
  await openBlankDocument(doc);
});

buttons.pen.addEventListener("click", () => setTool("pen"));
buttons.eraser.addEventListener("click", () => setTool("eraser"));
buttons.lasso.addEventListener("click", () => setTool("lasso"));
buttons.space.addEventListener("click", () => setTool("space"));
buttons.undo.addEventListener("click", undo);
buttons.redo.addEventListener("click", redo);
buttons.copySelection.addEventListener("click", copySelection);
buttons.deleteSelection.addEventListener("click", deleteSelectedStrokes);
buttons.save.addEventListener("click", saveAnnotations);
buttons.export.addEventListener("click", exportAnnotations);
buttons.deleteNotes.addEventListener("click", deleteAnnotations);

penColor.addEventListener("change", () => {
  currentColor = penColor.value;
});

penThickness.addEventListener("input", () => {
  currentWidth = Number(penThickness.value);
  thicknessValue.textContent = penThickness.value;
});

lassoMoveBackground.addEventListener("change", () => {
  includeLassoBackground = lassoMoveBackground.checked;
  setStatus(includeLassoBackground ? "Lasso will move background" : "Lasso will move writing only");
});

sidebarToggle.addEventListener("click", () => {
  document.body.classList.add("sidebar-collapsed");
});

sidebarExpand.addEventListener("click", () => {
  document.body.classList.remove("sidebar-collapsed");
});

window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && !buttons.copySelection.disabled) {
    event.preventDefault();
    copySelection();
  }

  if ((event.key === "Delete" || event.key === "Backspace") && !buttons.deleteSelection.disabled) {
    event.preventDefault();
    deleteSelectedStrokes();
  }
});

window.addEventListener("resize", () => {
  if (currentDocumentType === "blank") renderBlankDocument();
  if (pdfDoc) renderPdf();
});

loadPdfList();
