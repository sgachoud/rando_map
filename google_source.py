from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import requests

from config import CACHE_DIR, GOOGLE_API_KEY, GOOGLE_DRIVE_ROOT_FOLDER_ID

DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files"
SHEETS_VALUES_URL = "https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}/values/{sheet_range}"

SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet"
FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"


@dataclass
class Hike:
    name: str
    website: str
    region: str
    duration: str
    date: str
    gpx_filename: str


def _list_folder(folder_id: str) -> list[dict]:
    resp = requests.get(
        DRIVE_FILES_URL,
        params={
            "q": f"'{folder_id}' in parents",
            "key": GOOGLE_API_KEY,
            "fields": "files(id,name,mimeType)",
        },
    )
    resp.raise_for_status()
    return resp.json()["files"]


@lru_cache
def _find_root_resources() -> tuple[str, str]:
    files = _list_folder(GOOGLE_DRIVE_ROOT_FOLDER_ID)
    sheet = next(f for f in files if f["mimeType"] == SHEET_MIME_TYPE)
    gpx_folder = next(f for f in files if f["mimeType"] == FOLDER_MIME_TYPE)
    return sheet["id"], gpx_folder["id"]


def list_hikes() -> list[Hike]:
    sheet_id, _ = _find_root_resources()
    resp = requests.get(
        SHEETS_VALUES_URL.format(sheet_id=sheet_id, sheet_range="rando"),
        params={"key": GOOGLE_API_KEY},
    )
    resp.raise_for_status()
    rows = resp.json().get("values", [])

    hikes = []
    for row in rows[1:]:  # skip header row
        row = row + [""] * (6 - len(row))
        name, website, region, duration, date, gpx_filename = row[:6]
        if not name.strip():
            continue
        hikes.append(Hike(name.strip(), website.strip(), region.strip(), duration.strip(), date.strip(), gpx_filename.strip()))
    return hikes


def get_gpx_path(gpx_filename: str) -> Path:
    cache_path = CACHE_DIR / gpx_filename
    if cache_path.exists():
        return cache_path

    _, gpx_folder_id = _find_root_resources()
    files = _list_folder(gpx_folder_id)
    match = next((f for f in files if f["name"] == gpx_filename), None)
    if match is None:
        raise FileNotFoundError(f"GPX file not found in Drive folder: {gpx_filename}")

    resp = requests.get(f"{DRIVE_FILES_URL}/{match['id']}", params={"alt": "media", "key": GOOGLE_API_KEY})
    resp.raise_for_status()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path.write_bytes(resp.content)
    return cache_path
