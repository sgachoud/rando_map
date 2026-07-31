import sys
import tempfile
from pathlib import Path

import folium
import gpxpy
from PySide6.QtCore import QUrl
from PySide6.QtWebEngineCore import QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QAbstractItemView, QApplication, QHBoxLayout, QLabel, QListWidget, QListWidgetItem, QMainWindow, QSplitter, QWidget

from google_source import Hike, get_gpx_path, list_hikes

TRACK_COLORS = ["red", "blue", "green", "purple", "orange", "darkred", "cadetblue", "darkgreen", "black", "pink"]


def load_gpx_points(gpx_path: Path) -> list[tuple[float, float]]:
    with open(gpx_path, encoding="utf-8") as f:
        gpx = gpxpy.parse(f)

    points = []
    for track in gpx.tracks:
        for segment in track.segments:
            for point in segment.points:
                points.append((point.latitude, point.longitude))
    return points


def build_map_html(tracks: list[tuple[str, list[tuple[float, float]]]]) -> str:
    all_points = [point for _name, points in tracks for point in points]
    center = all_points[len(all_points) // 2]
    fmap = folium.Map(location=center, zoom_start=14)

    for i, (name, points) in enumerate(tracks):
        color = TRACK_COLORS[i % len(TRACK_COLORS)]
        folium.PolyLine(points, color=color, weight=3, tooltip=name).add_to(fmap)
        folium.Marker(points[0], tooltip=f"{name} - Start", icon=folium.Icon(color=color)).add_to(fmap)
        folium.Marker(points[-1], tooltip=f"{name} - End", icon=folium.Icon(color=color)).add_to(fmap)

    fmap.fit_bounds(all_points)

    tmp = tempfile.NamedTemporaryFile(suffix=".html", delete=False)
    fmap.save(tmp.name)
    return tmp.name


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Rando Map")
        self.resize(1200, 800)

        self.hike_list = QListWidget()
        self.hike_list.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.hike_list.itemSelectionChanged.connect(self._on_selection_changed)

        self.map_view = QWebEngineView()
        self.map_view.settings().setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, True)

        self.status_label = QLabel()

        right_panel = QWidget()
        right_layout = QHBoxLayout(right_panel)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.addWidget(self.map_view)

        splitter = QSplitter()
        splitter.addWidget(self.hike_list)
        splitter.addWidget(right_panel)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([300, 900])

        self.setCentralWidget(splitter)
        self.statusBar().addWidget(self.status_label)

        self._load_hikes()

    def _load_hikes(self):
        try:
            hikes = list_hikes()
        except Exception as exc:
            self.status_label.setText(f"Failed to load hikes: {exc}")
            return

        for hike in hikes:
            item = QListWidgetItem(f"{hike.name}  ({hike.date})")
            item.setData(1000, hike)
            self.hike_list.addItem(item)

        if hikes:
            self.hike_list.setCurrentRow(0)

    def _on_selection_changed(self):
        items = self.hike_list.selectedItems()
        if not items:
            return

        hikes: list[Hike] = [item.data(1000) for item in items]
        self.status_label.setText(f"Loading {len(hikes)} hike(s)...")

        tracks = []
        failed = []
        for hike in hikes:
            try:
                gpx_path = get_gpx_path(hike.gpx_filename)
                points = load_gpx_points(gpx_path)
                tracks.append((hike.name, points))
            except Exception as exc:
                failed.append(f"{hike.name} ({exc})")

        if not tracks:
            self.status_label.setText(f"Failed to load: {'; '.join(failed)}")
            return

        html_path = build_map_html(tracks)
        self.map_view.load(QUrl.fromLocalFile(html_path))

        status = ", ".join(name for name, _points in tracks)
        if failed:
            status += f" — failed: {'; '.join(failed)}"
        self.status_label.setText(status)


def main():
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
