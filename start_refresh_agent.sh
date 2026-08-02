#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ -x .venv/bin/python ]; then
  exec .venv/bin/python refresh_agent.py
fi
exec python3 refresh_agent.py
