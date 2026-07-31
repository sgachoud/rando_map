const ROOT_FOLDER_ID = "1Fs3k1m1BVe0FrD7ova0sePQ-8kYizOLW";
const SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const TRACK_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#9a6324", "#000075", "#808000"];

const apiKey = new URLSearchParams(location.search).get("key");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("hike-list");

const gpxCache = new Map();
const selected = new Set();
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

async function listHikes(sheetId) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/rando`);
  url.searchParams.set("key", apiKey);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Sheets read failed: ${resp.status}`);
  const data = await resp.json();
  const rows = data.values || [];

  const hikes = [];
  for (const row of rows.slice(1)) {
    const [name, website, region, duration, date, gpxFilename] = row;
    if (!name || !name.trim()) continue;
    hikes.push({ name: name.trim(), website, region, duration, date, gpxFilename: (gpxFilename || "").trim() });
  }
  return hikes;
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

function colorForIndex(i) {
  return TRACK_COLORS[i % TRACK_COLORS.length];
}

async function renderSelection() {
  layerGroup.clearLayers();
  const hikeItems = Array.from(listEl.children);
  const chosen = hikeItems.filter((li) => selected.has(li.dataset.name));

  if (chosen.length === 0) {
    setStatus("Select one or more hikes");
    return;
  }

  setStatus(`Loading ${chosen.length} hike(s)...`);
  const allPoints = [];
  const failed = [];

  for (let i = 0; i < chosen.length; i++) {
    const li = chosen[i];
    const color = colorForIndex(i);
    try {
      const points = await fetchGpxPoints(li.dataset.gpx);
      if (points.length === 0) continue;
      L.polyline(points, { color, weight: 3 }).bindTooltip(li.dataset.name).addTo(layerGroup);
      L.circleMarker(points[0], { color, radius: 5, fillOpacity: 1 }).bindTooltip(`${li.dataset.name} - Start`).addTo(layerGroup);
      L.circleMarker(points[points.length - 1], { color, radius: 5, fillOpacity: 1 }).bindTooltip(`${li.dataset.name} - End`).addTo(layerGroup);
      allPoints.push(...points);
    } catch (err) {
      failed.push(`${li.dataset.name} (${err.message})`);
    }
  }

  if (allPoints.length > 0) {
    map.fitBounds(L.latLngBounds(allPoints), { padding: [20, 20] });
  }

  let status = chosen.map((li) => li.dataset.name).join(", ");
  if (failed.length) status += ` — failed: ${failed.join("; ")}`;
  setStatus(status);
}

function buildHikeList(hikes) {
  listEl.innerHTML = "";
  hikes.forEach((hike, i) => {
    const li = document.createElement("li");
    li.dataset.name = hike.name;
    li.dataset.gpx = hike.gpxFilename;
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = colorForIndex(i);
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = hike.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = [hike.region, hike.duration, hike.date].filter(Boolean).join(" · ");
    li.appendChild(swatch);
    li.appendChild(name);
    li.appendChild(meta);
    li.addEventListener("click", () => {
      if (selected.has(hike.name)) {
        selected.delete(hike.name);
        li.classList.remove("selected");
      } else {
        selected.add(hike.name);
        li.classList.add("selected");
      }
      renderSelection();
    });
    listEl.appendChild(li);
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

  if (!apiKey) {
    setStatus("Missing API key in URL (?key=...)");
    return;
  }

  try {
    const { sheetId, gpxFolderId } = await findRootResources();
    const [hikes, gpxFiles] = await Promise.all([listHikes(sheetId), driveList(gpxFolderId)]);
    gpxFilesById = new Map(gpxFiles.map((f) => [f.name, f]));
    buildHikeList(hikes);

    if (hikes.length > 0) {
      selected.add(hikes[0].name);
      listEl.children[0].classList.add("selected");
      await renderSelection();
    } else {
      setStatus("No hikes found");
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

main();
