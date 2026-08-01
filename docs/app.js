const ROOT_FOLDER_ID = "1Fs3k1m1BVe0FrD7ova0sePQ-8kYizOLW";
const SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const TRACK_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#9a6324", "#000075", "#808000"];

const NAME_HEADER_PATTERN = /nom/i;
const GPX_HEADER_PATTERN = /^gpx$/i;
const REGION_HEADER_PATTERN = /canton|pays|r[ée]gion/i;
const DURATION_HEADER_PATTERN = /dur[ée]e/i;
const DATE_HEADER_PATTERN = /date/i;
const URL_PATTERN = /^https?:\/\//i;

const apiKey = new URLSearchParams(location.search).get("key");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("hike-list");
const searchEl = document.getElementById("search");
const sortEl = document.getElementById("sort");

const gpxCache = new Map();
const visible = new Set(); // hike names currently shown on the map
const expanded = new Set(); // hike names with details panel open
let allHikes = [];
let gpxFilesById = null;
let map;
let layerGroup;

function setStatus(text) {
  statusEl.textContent = text;
}

async function driveList(folderId) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", `'${folderId}' in parents`);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("fields", "files(id,name,mimeType)");
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Drive list failed: ${resp.status}`);
  const data = await resp.json();
  return data.files;
}

async function findRootResources() {
  const files = await driveList(ROOT_FOLDER_ID);
  const sheet = files.find((f) => f.mimeType === SHEET_MIME_TYPE);
  const gpxFolder = files.find((f) => f.mimeType === FOLDER_MIME_TYPE);
  if (!sheet || !gpxFolder) throw new Error("Could not find sheet or GPX folder in root folder");
  return { sheetId: sheet.id, gpxFolderId: gpxFolder.id };
}

function parseSwissDate(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((text || "").trim());
  if (!m) return null;
  const [, day, month, year] = m;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function parseHikes(rows) {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => (h || "").trim());
  const nameIdx = header.findIndex((h) => NAME_HEADER_PATTERN.test(h));
  const gpxIdx = header.findIndex((h) => GPX_HEADER_PATTERN.test(h));
  const regionIdx = header.findIndex((h) => REGION_HEADER_PATTERN.test(h));
  const durationIdx = header.findIndex((h) => DURATION_HEADER_PATTERN.test(h));
  const dateIdx = header.findIndex((h) => DATE_HEADER_PATTERN.test(h));

  if (nameIdx === -1 || gpxIdx === -1) {
    throw new Error("Sheet is missing a name or GPX column");
  }

  const hikes = [];
  for (const row of rows.slice(1)) {
    const name = (row[nameIdx] || "").trim();
    if (!name) continue;

    const details = [];
    header.forEach((label, i) => {
      if (i === nameIdx || i === gpxIdx || !label) return;
      const value = (row[i] || "").trim();
      if (value) details.push({ label, value });
    });

    hikes.push({
      name,
      gpxFilename: (row[gpxIdx] || "").trim(),
      region: regionIdx >= 0 ? (row[regionIdx] || "").trim() : "",
      duration: durationIdx >= 0 ? (row[durationIdx] || "").trim() : "",
      date: dateIdx >= 0 ? (row[dateIdx] || "").trim() : "",
      parsedDate: dateIdx >= 0 ? parseSwissDate(row[dateIdx]) : null,
      details,
    });
  }
  return hikes;
}

async function listHikes(sheetId) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/rando`);
  url.searchParams.set("key", apiKey);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Sheets read failed: ${resp.status}`);
  const data = await resp.json();
  return parseHikes(data.values || []);
}

async function fetchGpxPoints(filename) {
  if (gpxCache.has(filename)) return gpxCache.get(filename);

  const file = gpxFilesById.get(filename);
  if (!file) throw new Error(`GPX file not found in Drive: ${filename}`);

  const url = new URL(`https://www.googleapis.com/drive/v3/files/${file.id}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("key", apiKey);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`GPX download failed: ${resp.status}`);
  const text = await resp.text();

  const xml = new DOMParser().parseFromString(text, "application/xml");
  const points = Array.from(xml.getElementsByTagName("trkpt")).map((pt) => [
    parseFloat(pt.getAttribute("lat")),
    parseFloat(pt.getAttribute("lon")),
  ]);

  gpxCache.set(filename, points);
  return points;
}

function colorForName(name) {
  const hikeIndex = allHikes.findIndex((h) => h.name === name);
  return TRACK_COLORS[Math.max(hikeIndex, 0) % TRACK_COLORS.length];
}

async function renderSelection() {
  layerGroup.clearLayers();
  const chosen = allHikes.filter((h) => visible.has(h.name));

  if (chosen.length === 0) {
    setStatus("Select one or more hikes to show on the map");
    return;
  }

  setStatus(`Loading ${chosen.length} hike(s)...`);
  const allPoints = [];
  const failed = [];

  for (const hike of chosen) {
    const color = colorForName(hike.name);
    try {
      const points = await fetchGpxPoints(hike.gpxFilename);
      if (points.length === 0) continue;
      L.polyline(points, { color, weight: 3 }).bindTooltip(hike.name).addTo(layerGroup);
      L.circleMarker(points[0], { color, radius: 5, fillOpacity: 1 }).bindTooltip(`${hike.name} - Start`).addTo(layerGroup);
      L.circleMarker(points[points.length - 1], { color, radius: 5, fillOpacity: 1 }).bindTooltip(`${hike.name} - End`).addTo(layerGroup);
      allPoints.push(...points);
    } catch (err) {
      failed.push(`${hike.name} (${err.message})`);
    }
  }

  if (allPoints.length > 0) {
    map.fitBounds(L.latLngBounds(allPoints), { padding: [20, 20] });
  }

  let status = chosen.map((h) => h.name).join(", ");
  if (failed.length) status += ` — failed: ${failed.join("; ")}`;
  setStatus(status);
}

function buildDetails(hike) {
  const dl = document.createElement("dl");
  for (const { label, value } of hike.details) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    if (URL_PATTERN.test(value)) {
      const a = document.createElement("a");
      a.href = value;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = value;
      dd.appendChild(a);
    } else {
      dd.textContent = value;
    }
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  const wrapper = document.createElement("div");
  wrapper.className = "details";
  wrapper.hidden = true;
  wrapper.appendChild(dl);
  return wrapper;
}

function buildHikeItem(hike) {
  const li = document.createElement("li");
  li.dataset.name = hike.name;

  const row = document.createElement("div");
  row.className = "row";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "visibility-checkbox";
  checkbox.checked = visible.has(hike.name);
  checkbox.addEventListener("click", (e) => e.stopPropagation());
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) visible.add(hike.name);
    else visible.delete(hike.name);
    renderSelection();
  });

  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.background = colorForName(hike.name);

  const summary = document.createElement("div");
  summary.className = "summary";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = hike.name;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = [hike.region, hike.duration, hike.date].filter(Boolean).join(" · ");
  summary.appendChild(name);
  summary.appendChild(meta);

  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = "›";

  row.appendChild(checkbox);
  row.appendChild(swatch);
  row.appendChild(summary);
  row.appendChild(chevron);

  const detailsEl = buildDetails(hike);
  const isExpanded = expanded.has(hike.name);
  li.classList.toggle("expanded", isExpanded);
  detailsEl.hidden = !isExpanded;

  row.addEventListener("click", () => {
    const nowExpanded = !expanded.has(hike.name);
    if (nowExpanded) expanded.add(hike.name);
    else expanded.delete(hike.name);
    li.classList.toggle("expanded", nowExpanded);
    detailsEl.hidden = !nowExpanded;
  });

  li.appendChild(row);
  li.appendChild(detailsEl);
  return li;
}

function getFilteredSortedHikes() {
  const query = searchEl.value.trim().toLowerCase();
  let hikes = allHikes.filter((h) => {
    if (!query) return true;
    const haystack = [h.name, h.region, h.duration, h.date, ...h.details.map((d) => d.value)].join(" ").toLowerCase();
    return haystack.includes(query);
  });

  const sortBy = sortEl.value;
  hikes = hikes.slice().sort((a, b) => {
    if (sortBy === "date-asc" || sortBy === "date-desc") {
      const da = a.parsedDate ? a.parsedDate.getTime() : null;
      const db = b.parsedDate ? b.parsedDate.getTime() : null;
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return sortBy === "date-asc" ? da - db : db - da;
    }
    if (sortBy === "region") return a.region.localeCompare(b.region) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });

  return hikes;
}

function refreshList() {
  listEl.innerHTML = "";
  const hikes = getFilteredSortedHikes();
  for (const hike of hikes) {
    listEl.appendChild(buildHikeItem(hike));
  }
}

function setupToolbar() {
  searchEl.addEventListener("input", refreshList);
  sortEl.addEventListener("change", refreshList);

  document.getElementById("select-all").addEventListener("click", () => {
    for (const hike of getFilteredSortedHikes()) visible.add(hike.name);
    refreshList();
    renderSelection();
  });

  document.getElementById("select-none").addEventListener("click", () => {
    for (const hike of getFilteredSortedHikes()) visible.delete(hike.name);
    refreshList();
    renderSelection();
  });
}

function setupSidebarToggle() {
  const sidebar = document.getElementById("sidebar");
  const toggle = document.getElementById("toggle-sidebar");
  toggle.addEventListener("click", () => sidebar.classList.toggle("open"));
}

async function main() {
  map = L.map("map").setView([46.5, 6.6], 9);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  layerGroup = L.layerGroup().addTo(map);
  setupSidebarToggle();
  setupToolbar();

  if (!apiKey) {
    setStatus("Missing API key in URL (?key=...)");
    return;
  }

  try {
    const { sheetId, gpxFolderId } = await findRootResources();
    const [hikes, gpxFiles] = await Promise.all([listHikes(sheetId), driveList(gpxFolderId)]);
    gpxFilesById = new Map(gpxFiles.map((f) => [f.name, f]));
    allHikes = hikes;
    refreshList();

    if (hikes.length > 0) {
      visible.add(hikes[0].name);
      expanded.add(hikes[0].name);
      refreshList();
      await renderSelection();
    } else {
      setStatus("No hikes found");
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

main();
