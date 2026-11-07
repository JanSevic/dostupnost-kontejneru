#!/usr/bin/env bash
# Starts the app on macOS / Linux. On the first run it creates .venv and installs the libraries.
set -e
cd "$(dirname "$0")"

PY=""
for c in python3.13 python3.12 python3.11 python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
    PY="$c"
    break
  fi
done
if [ -z "$PY" ]; then
  echo "Je potřeba Python 3.11 nebo novější: https://www.python.org/downloads/"
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "Vytvářím virtuální prostředí .venv …"
  if ! "$PY" -m venv .venv; then
    echo "Nepodařilo se vytvořit .venv. Na Debianu/Ubuntu doinstaluj: sudo apt install python3-venv"
    exit 1
  fi
fi

if ! cmp -s requirements.txt .venv/requirements.installed; then
  echo "Instaluji knihovny (poprvé to trvá několik minut) …"
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/python -m pip install -r requirements.txt
  cp requirements.txt .venv/requirements.installed
fi

exec .venv/bin/python app.py "$@"
