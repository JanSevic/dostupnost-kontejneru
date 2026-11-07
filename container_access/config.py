"""Loading the configuration (config.json) and paths to data folders."""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DEFAULTS = {
    "territory_name": "",
    "default_view": {"label": "Dřínov, okres Mělník", "lat": 50.2736, "lon": 14.3975, "zoom": 15},
    "types": [
        {"key": "plast", "name": "Plast", "color": "#f2c200", "abbr": "Pl"},
        {"key": "papir", "name": "Papír", "color": "#1f63c6", "abbr": "Pa"},
        {"key": "sklo", "name": "Sklo", "color": "#1b8a3a", "abbr": "Sk"},
        {"key": "kovy", "name": "Kovy", "color": "#7d8590", "abbr": "Ko"},
        {"key": "textil", "name": "Textil", "color": "#8e44ad", "abbr": "Tx"},
        {"key": "kartony", "name": "Nápojové kartony", "color": "#f76707", "abbr": "NK"},
        {"key": "oleje", "name": "Jedlé oleje", "color": "#5c3d1e", "abbr": "Ol"},
    ],
    "bands_m": [100, 200],
    "band_colors": ["#1a9850", "#f08c00", "#d7301f"],
    "unreachable_color": "#9e9e9e",
    "continuous_max_m": 400,
    "network_margin_m": 300,
    "max_area_km2": 30,
    "segment_length_m": 10,
    "connection_warning_m": 30,
    "port": 8765,
    "default_area": {"name": "Dřínov (okres Mělník)", "extent": [14.3862, 50.2664, 14.4088, 50.2808]},
    "tiles": {
        "url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        "attribution": "© přispěvatelé OpenStreetMap",
        "max_zoom": 19,
        "offline_allowed": False,
        "offline_max_tiles": 250,
        "offline_min_zoom": 13,
        "offline_max_zoom": 18,
        "offline_overview_zooms": [10, 11, 12],
    },
    "overpass_url": [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
    ],
    "connectivity_check_url": "https://overpass-api.de/api/status",
    "user_agent": "DostupnostKontejneru/1.1 (lokalni aplikace; Python)",
    "contact": "",
}

OSM_ATTRIBUTION = "© přispěvatelé OpenStreetMap"

# Tile servers whose terms forbid offline use (pre-downloading tiles).
SERVERS_WITHOUT_OFFLINE = ("tile.openstreetmap.org", "tile.osm.org")

# Key of the "all types" summary layer – must not collide with a type key.
SUMMARY_KEY = "vse"

_KEY_RE = re.compile(r"^[a-z0-9_]+$")


class ConfigError(ValueError):
    pass


@dataclass
class Paths:
    """Data folders. ``data`` can be changed (python app.py --data FOLDER)."""

    data: Path
    areas: Path = field(init=False)
    settings: Path = field(init=False)
    static: Path = field(init=False)

    def __post_init__(self):
        self.data = Path(self.data)
        self.areas = self.data / "areas"
        self.settings = self.data / "settings.json"
        self.static = ROOT / "static"

    def create(self):
        self.areas.mkdir(parents=True, exist_ok=True)


def user_agent(cfg: dict) -> str:
    """User-Agent for all requests of the app (identifies the app, optionally a contact)."""
    ua = str(cfg.get("user_agent") or "DostupnostKontejneru/1.1")
    contact = str(cfg.get("contact") or "").strip()
    if contact:
        ua = ua[:-1] + f"; {contact})" if ua.endswith(")") else f"{ua} ({contact})"
    return ua.encode("ascii", "ignore").decode()


def offline_tiles_allowed(cfg: dict) -> tuple[bool, str]:
    """May tiles be pre-downloaded from the configured tile server for offline use? Returns (yes/no, reason)."""
    from urllib.parse import urlparse

    t = cfg["tiles"]
    host = (urlparse(str(t.get("url", "")).replace("{s}", "a")).hostname or "").lower().rstrip(".")
    if any(host == h or host.endswith("." + h) for h in SERVERS_WITHOUT_OFFLINE):
        return False, ("Podmínky tile.openstreetmap.org offline použití a předstahování dlaždic zakazují – "
                       "offline se použije vektorový podklad.")
    if not t.get("offline_allowed"):
        return False, "Předstahování dlaždic je v config.json vypnuté (tiles.offline_allowed)."
    return True, ""


def normalise_key(text: str) -> str:
    """Turns any text into a type key (lower case without diacritics)."""
    import unicodedata

    t = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-z0-9_]+", "_", t.lower()).strip("_")
    return t or "typ"


def check_types(types: list[dict]) -> list[dict]:
    if not isinstance(types, list) or not types:
        raise ConfigError("V konfiguraci musí být aspoň jeden typ odpadu.")
    result, seen = [], set()
    for t in types:
        if not isinstance(t, dict) or "key" not in t:
            raise ConfigError(f"Typ odpadu bez klíče (key): {t!r}")
        key = str(t["key"])
        if not _KEY_RE.match(key):
            raise ConfigError(f"Klíč typu „{key}“ smí obsahovat jen malá písmena bez diakritiky, číslice a _.")
        if key == SUMMARY_KEY:
            raise ConfigError(f"Klíč „{SUMMARY_KEY}“ je vyhrazený pro souhrnnou vrstvu.")
        if key in seen:
            raise ConfigError(f"Klíč typu „{key}“ je v konfiguraci dvakrát.")
        seen.add(key)
        name = str(t.get("name") or key)
        result.append({
            "key": key,
            "name": name,
            "color": str(t.get("color") or "#555555"),
            "abbr": str(t.get("abbr") or name[:2]),
        })
    return result


def load_config(file: Path | None = None) -> dict:
    """Loads config.json and fills in missing values with defaults."""
    file = file or (ROOT / "config.json")
    cfg = copy.deepcopy(DEFAULTS)
    if file.exists():
        try:
            user = json.loads(file.read_text(encoding="utf-8-sig"))
        except UnicodeDecodeError as e:
            raise ConfigError(f"Soubor {file.name} není v kódování UTF-8 – ulož ho v editoru jako UTF-8.") from e
        except json.JSONDecodeError as e:
            raise ConfigError(f"Soubor {file.name} není platný JSON: {e}") from e
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    cfg["types"] = check_types(cfg["types"])
    bands = sorted(float(x) for x in cfg["bands_m"])
    if not bands or any(b <= 0 for b in bands):
        raise ConfigError("Hranice pásem (bands_m) musí být kladná čísla.")
    cfg["bands_m"] = bands
    if not isinstance(cfg.get("tiles"), dict) or "{z}" not in str(cfg["tiles"].get("url", "")):
        raise ConfigError("tiles.url musí obsahovat {z}, {x} a {y}.")
    if len(cfg["band_colors"]) != len(bands) + 1:
        raise ConfigError("Počet barev pásem (band_colors) musí být o 1 větší než počet hranic (bands_m).")
    return cfg
