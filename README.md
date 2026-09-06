# Rando Map

View hikes on a map from a Google Sheet of routes and a Drive folder of GPX tracks.

- **Desktop app** (`rando_map.py`): PySide6 window with a hike list and an embedded
  folium/Leaflet map. Select one or more hikes to render their tracks.
- **Web app** (`docs/`): static page (deployable via GitHub Pages) that reads the
  same sheet and Drive folder client-side and renders tracks with Leaflet.

## Setup

Create a `.env` file with:

```
GOOGLE_API_KEY=your-api-key
GOOGLE_DRIVE_ROOT_FOLDER_ID=your-root-folder-id
```

The root Drive folder must contain the routes spreadsheet and a subfolder of GPX
files. The spreadsheet's `rando` sheet is parsed by header name; a `nom` and a
`gpx` column are required, and `canton`/`région`, `informations`, and `date`
columns are used when present.

## Run the desktop app

```
C:\opt\python313\python.exe rando_map.py
```

## Web app

Open `docs/index.html` served with `?key=<GOOGLE_API_KEY>` in the URL.

## Credits

This tool was developed with Claude Sonnet 5 from Anthropic.
