"""Downloading the data of an area from the Overpass API in a single query.

Both the walking network and the vector basemap come from the same .osm (XML) file, so only one
query is sent to the server. Previously these were two queries via osmnx, and osmnx waited for a
free server "slot" before each of them, which made the download needlessly long.
"""

from __future__ import annotations

import re
import threading
import time
from pathlib import Path

from .network import ConnectionFailed, NetworkError

DEFAULT_SERVERS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

_RAILWAY = "rail|light_rail|narrow_gauge|tram|subway"
_WATERWAY = "river|stream|canal|ditch|drain|riverbank"
_NATURAL = "water|wood|scrub|wetland|grassland|heath"
_LANDUSE = ("forest|grass|meadow|orchard|vineyard|recreation_ground|village_green|allotments|cemetery|"
            "reservoir|basin|plant_nursery")
_LEISURE = "park|garden|pitch|playground"
_PLACE = "city|town|village|hamlet|suburb|neighbourhood|quarter|isolated_dwelling"


def query(bbox, timeout_s: int = 180) -> str:
    """Overpass QL: all ways (the network is filtered locally) + basemap features, XML output with nodes."""
    w, s, e, n = bbox
    b = f"({s:.6f},{w:.6f},{n:.6f},{e:.6f})"
    return f"""[out:xml][timeout:{timeout_s}];
(
  way["highway"]{b};
  way["building"]{b};
  relation["building"]{b};
  way["railway"~"^({_RAILWAY})$"]{b};
  way["waterway"~"^({_WATERWAY})$"]{b};
  way["natural"~"^({_NATURAL})$"]{b};
  relation["natural"~"^({_NATURAL})$"]{b};
  way["water"]{b};
  relation["water"]{b};
  way["landuse"~"^({_LANDUSE})$"]{b};
  relation["landuse"~"^({_LANDUSE})$"]{b};
  way["leisure"~"^({_LEISURE})$"]{b};
  node["place"~"^({_PLACE})$"]{b};
);
(._;>;);
out body;"""


def servers(cfg: dict) -> list[str]:
    u = cfg.get("overpass_url") or DEFAULT_SERVERS
    return [u] if isinstance(u, str) else [str(x) for x in u if x]


def _mb(n: int) -> str:
    return f"{n / 1e6:.1f}".replace(".", ",") + " MB"


_ERROR_IN_RESPONSE = re.compile(rb'<remark>\s*(runtime error[^<]*)</remark>', re.I)


def download_osm(bbox, target: Path, cfg: dict, user_agent: str, progress=None, session=None) -> dict:
    """Downloads the area data into ``target`` (.osm XML). Tries the servers from config.json in turn.

    Returns {"server", "bytes", "seconds"}. Raises NetworkError / ConnectionFailed on failure.
    """
    import requests

    progress = progress or (lambda *a, **k: None)
    session = session or requests.Session()
    q = query(bbox)
    urls = servers(cfg)
    errors, connection_only = [], True
    for url in urls:
        host = re.sub(r"^https?://([^/]+).*$", r"\1", url)
        started = time.monotonic()
        done = threading.Event()
        state = {"bytes": 0, "data": False}

        def ticker():
            # Overpass computes for a long time before sending the first byte – show that something is happening.
            while not done.wait(1.0):
                s = int(time.monotonic() - started)
                if state["data"]:
                    progress("network", f"Stahuji data z OpenStreetMap ({host})… {_mb(state['bytes'])}, {s} s")
                else:
                    progress("network", f"Čekám na odpověď serveru {host}… {s} s")

        if errors:
            progress("network", f"{errors[-1]} – zkouším další server ({host})…")
        else:
            progress("network", f"Posílám dotaz na {host}…")
        t = threading.Thread(target=ticker, daemon=True)
        t.start()
        try:
            r = session.post(url, data={"data": q}, headers={"User-Agent": user_agent},
                             timeout=(10, 240), stream=True)
            if r.status_code != 200:
                connection_only = False
                text = {429: "příliš mnoho dotazů (429)", 504: "server je přetížený (504)"}.get(
                    r.status_code, f"HTTP {r.status_code}")
                errors.append(f"{host}: {text}")
                r.close()
                continue
            tmp = target.with_suffix(".downloading")
            with open(tmp, "wb") as f:
                state["data"] = True
                for chunk in r.iter_content(chunk_size=256 * 1024):
                    f.write(chunk)
                    state["bytes"] += len(chunk)
            # on timeout Overpass returns 200 and the error only in <remark>
            with open(tmp, "rb") as f:
                f.seek(max(0, state["bytes"] - 4096))
                tail = f.read()
            m = _ERROR_IN_RESPONSE.search(tail)
            if m:
                connection_only = False
                tmp.unlink(missing_ok=True)
                errors.append(f"{host}: {m.group(1).decode('utf-8', 'replace').strip()}")
                continue
            tmp.replace(target)
            return {"server": url, "bytes": state["bytes"], "seconds": round(time.monotonic() - started, 1)}
        except requests.exceptions.Timeout:
            connection_only = False
            errors.append(f"{host}: vypršel čas")
        except (requests.exceptions.ConnectionError, OSError) as e:
            errors.append(f"{host}: nelze se spojit ({type(e).__name__})")
        except requests.exceptions.RequestException as e:
            connection_only = False
            errors.append(f"{host}: {e}")
        finally:
            done.set()
            t.join(timeout=2)
            target.with_suffix(".downloading").unlink(missing_ok=True)
    if connection_only:
        raise ConnectionFailed("Nepodařilo se spojit se serverem Overpass. Jsi připojený k internetu? "
                               f"({'; '.join(errors)})")
    raise NetworkError("Stažení dat z OpenStreetMap se nepovedlo: " + "; ".join(errors) + ". Zkus to za pár minut.")
