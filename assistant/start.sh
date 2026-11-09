#!/usr/bin/env bash
# Linux/macOS: ./start.sh — yiqilsa 10 soniyadan keyin qayta ishga tushadi.
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi
while true; do
  .venv/bin/python -m yordamchi
  echo "Qayta ishga tushirilmoqda..."
  sleep 10
done
