#!/usr/bin/env python3
"""NetAdmin Monitor'ni repo ildizidan ishga tushirish: server-monitor/start.py ga yo'naltiradi."""
import os
import runpy
import sys

target = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server-monitor", "start.py")
sys.argv[0] = target
runpy.run_path(target, run_name="__main__")
