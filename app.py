"""Walking distance to waste-sorting containers – application launcher.

Usage:  python app.py                    (opens the browser)
        python app.py --offline          (blocks all network access – tests the offline mode)
        python app.py --bez-prohlizece --port 8800 --data other_folder

The command-line options stay Czech (they are part of the Czech user interface).
"""

from __future__ import annotations

import argparse
import logging
import socket
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))


def free_port(preferred: int) -> int:
    for port in [preferred] + list(range(preferred + 1, preferred + 50)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("Nenašel jsem volný port – zavři jiné spuštěné kopie aplikace.")


def running_instance(port: int) -> bool:
    """Is this app already running on the port? (so that two copies do not overwrite the same data)"""
    import json
    import urllib.request

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/api/config", timeout=1.5) as r:
            return "summary_key" in json.load(r)
    except Exception:  # noqa: BLE001
        return False


def main():
    parser = argparse.ArgumentParser(description="Pěší dostupnost kontejnerů na tříděný odpad")
    parser.add_argument("--port", type=int, default=None, help="port serveru (výchozí z config.json)")
    parser.add_argument("--bez-prohlizece", dest="no_browser", action="store_true", help="neotvírat prohlížeč")
    parser.add_argument("--offline", action="store_true",
                        help="zablokovat veškerý síťový přístup aplikace (ověření offline režimu)")
    parser.add_argument("--data", default=None, help="složka s daty (výchozí: data/ vedle app.py)")
    parser.add_argument("--config", default=None, help="jiný konfigurační soubor (výchozí: config.json vedle app.py)")
    args = parser.parse_args()

    if args.offline:
        from container_access.connectivity import block_network

        block_network()

    try:
        import uvicorn

        from container_access.config import ConfigError, load_config
        from container_access.server import create_app
    except ImportError as e:
        raise SystemExit(
            f"Chybí knihovna ({e.name}). Spusť aplikaci přes spustit.bat / spustit.sh, "
            "nebo nainstaluj závislosti: pip install -r requirements.txt"
        ) from e

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        cfg = load_config(Path(args.config).resolve() if args.config else None)
    except ConfigError as e:
        raise SystemExit(f"Chyba v config.json: {e}") from e

    preferred = args.port or int(cfg.get("port", 8765))
    if running_instance(preferred):
        url = f"http://127.0.0.1:{preferred}/"
        if args.offline or args.data or args.config:
            raise SystemExit(
                f"Aplikace už běží na {url}. Než ji spustíš s --offline, --data nebo --config, "
                "ukonči běžící kopii (zavři její okno nebo Ctrl+C)."
            )
        print(f"Aplikace už běží na {url} – jen otevírám prohlížeč.")
        if not args.no_browser:
            webbrowser.open(url)
        return
    port = free_port(preferred)
    url = f"http://127.0.0.1:{port}/"
    data_dir = Path(args.data).resolve() if args.data else ROOT / "data"
    app = create_app(data_dir, cfg, forced_offline=args.offline)
    mode = "  OFFLINE (síť zablokovaná)\n" if args.offline else ""
    print(f"\n  Aplikace běží na {url}\n{mode}  Data: {data_dir}\n  Ukončení: Ctrl+C (nebo zavři toto okno)\n")
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
