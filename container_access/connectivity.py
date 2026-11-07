"""Internet connectivity status and complete network blocking (python app.py --offline)."""

from __future__ import annotations

import logging
import os
import socket
import threading
import time

log = logging.getLogger("container_access")

_LOCAL = {"localhost", "127.0.0.1", "::1", "0.0.0.0", "testserver"}
_blocked = False


def _is_local(host) -> bool:
    if host is None:
        return True
    h = str(host).strip("[]").lower()
    return h in _LOCAL or h.startswith("127.")


def block_network():
    """Forbids all network connections outside this computer (to test the offline mode).

    The server keeps listening on 127.0.0.1 and the browser can talk to it; any attempt of
    the app to connect to the internet fails with OSError.
    """
    global _blocked
    if _blocked:
        return
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_getaddrinfo = socket.getaddrinfo

    def host_of(address):
        return address[0] if isinstance(address, tuple) else address

    def connect(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6) and not _is_local(host_of(address)):
            raise OSError(f"Offline režim (--offline): síťové spojení na {host_of(address)} je zablokované.")
        return original_connect(self, address)

    def connect_ex(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6) and not _is_local(host_of(address)):
            return 111  # ECONNREFUSED
        return original_connect_ex(self, address)

    def getaddrinfo(host, *args, **kwargs):
        if not _is_local(host):
            raise socket.gaierror(f"Offline režim (--offline): překlad jména {host} je zablokovaný.")
        return original_getaddrinfo(host, *args, **kwargs)

    # PROJ (pyproj) can download transformation grids – switch it off
    os.environ["PROJ_NETWORK"] = "OFF"
    try:
        import pyproj.network

        pyproj.network.set_network_enabled(False)
    except Exception:  # noqa: BLE001
        pass
    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
    socket.getaddrinfo = getaddrinfo
    # even a proxy on this computer would lead outside – so switch it off
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        os.environ.pop(var, None)
    _blocked = True
    log.info("Network access blocked (offline mode).")


def is_blocked() -> bool:
    return _blocked


class Connectivity:
    """Is the app online? Combines forced offline (--offline), manual switching and a connection check."""

    VALIDITY_S = 60
    FALLBACK_URLS = ("https://www.openstreetmap.org/", "https://tile.openstreetmap.org/")

    def __init__(self, check_url: str, user_agent: str, forced_offline: bool = False, manual_offline: bool = False):
        self.url = check_url
        self.user_agent = user_agent
        self.forced = forced_offline
        self.manual = manual_offline
        self.reachable: bool | None = None  # None = not checked yet
        self.detail = ""
        self.time = 0.0
        self._lock = threading.Lock()

    @property
    def online(self) -> bool:
        # online only after a check – until then the browser downloads nothing
        return not self.forced and not self.manual and self.reachable is True

    @property
    def can_download(self) -> bool:
        """May the app try to download? Only forced and manual offline prevent it – a failed check
        blocks nothing (the actual download then shows the precise cause)."""
        return not self.forced and not self.manual

    def status(self) -> dict:
        if self.forced:
            reason, text = "forced", "Offline – spuštěno s přepínačem --offline (síť je zablokovaná)."
        elif self.manual:
            reason, text = "manual", "Offline – přepnuto ručně."
        elif self.reachable is False:
            reason, text = "unreachable", "Připojení se nepodařilo ověřit" + (f" ({self.detail})" if self.detail else "") + \
                ". Stahování přesto můžeš zkusit."
        elif self.reachable is None:
            reason, text = "unchecked", "Ověřuji připojení k internetu…"
        else:
            reason, text = "ok", "Online."
        return {"online": self.online, "reason": reason, "text": text, "can_toggle": not self.forced,
                "can_download": self.can_download, "detail": self.detail}

    def check(self, force: bool = False) -> dict:
        """Checks the connection: any of the servers answering is enough (the result is valid for 60 s)."""
        if self.forced or self.manual:
            return self.status()
        with self._lock:
            if not force and self.reachable is not None and time.time() - self.time < self.VALIDITY_S:
                return self.status()
            import requests

            errors = []
            self.reachable = False
            for url in dict.fromkeys([self.url, *self.FALLBACK_URLS]):
                try:
                    # GET instead of HEAD (some servers and proxies do not handle HEAD); the body is not read
                    with requests.get(url, timeout=(5, 10), stream=True, allow_redirects=True,
                                      headers={"User-Agent": self.user_agent}):
                        pass
                    self.reachable = True
                    break
                except requests.exceptions.SSLError as e:
                    errors.append("chyba certifikátu HTTPS – blokuje ho antivir nebo firemní síť?")
                    log.warning("Connectivity check %s: %s", url, e)
                except requests.exceptions.ProxyError as e:
                    errors.append("chyba proxy serveru")
                    log.warning("Connectivity check %s: %s", url, e)
                except requests.exceptions.Timeout:
                    errors.append("server neodpověděl včas")
                except requests.exceptions.RequestException as e:
                    errors.append(type(e).__name__)
                    log.warning("Connectivity check %s: %s", url, e)
            self.detail = "" if self.reachable else "; ".join(dict.fromkeys(errors))
            self.time = time.time()
        return self.status()

    def record(self, success: bool):
        """Result of a real network operation (download) – updates the status without another request."""
        if not self.forced:
            self.reachable = success
            if success:
                self.detail = ""
            self.time = time.time()
