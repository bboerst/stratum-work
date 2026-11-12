"""The live-ingest code this tool must agree with, loaded from the repository rather than copied.

* collector/coinbase.py   parse_bip34_height (the fixed parser, #108)
* collector/pgsink.py     route(), TIP_BEHIND / TIP_AHEAD, COLUMNS (the live routing rules, #116)
* backend/integrations/store.py  PostgresStore (block row shape, pools upsert, #117)

Loading the very same files means the backfill can't drift from live ingest. The modules are loaded by path, so
this works from a plain checkout of the repository (no install step) and without importing the collector's or
backend's other dependencies. Override the repository root with M2P_REPO_ROOT if the tool is copied elsewhere.
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

REPO_ROOT = Path(os.environ.get("M2P_REPO_ROOT") or Path(__file__).resolve().parents[3])


def _load(name: str, relpath: str):
    if name in sys.modules:
        return sys.modules[name]
    path = REPO_ROOT / relpath
    if not path.is_file():
        raise ImportError(f"{path} not found: run the tool from a stratum-work checkout or set M2P_REPO_ROOT")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


coinbase = _load("m2p_collector_coinbase", "collector/coinbase.py")
pgsink = _load("m2p_collector_pgsink", "collector/pgsink.py")
store = _load("m2p_backend_store", "backend/integrations/store.py")

parse_bip34_height = coinbase.parse_bip34_height
route = pgsink.route
BTC = pgsink.BTC
TIP_BEHIND = pgsink.TIP_BEHIND
TIP_AHEAD = pgsink.TIP_AHEAD
COLUMNS = pgsink.COLUMNS
