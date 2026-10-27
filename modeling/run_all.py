# -*- coding: utf-8 -*-
"""批量运行全部模型并汇总产物。

    cd modeling
    python run_all.py
"""
from __future__ import annotations

import importlib
import os
import sys
import time

MODULES = ["movement", "economy", "mining", "logistics",
           "growth", "defense", "optimize", "audit",
           # 2026-10-27 依据 MECHANICS.md 新增的五个专题
           "lifecycle", "upkeep", "combat", "market", "systems"]


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)

    produced, failed = [], []
    t0 = time.time()
    for name in MODULES:
        print("\n" + "=" * 62)
        print(">>> models.%s" % name)
        print("=" * 62)
        try:
            mod = importlib.import_module("models." + name)
            paths = mod.main() or []
            produced.extend(paths)
        except Exception as exc:                      # noqa: BLE001
            failed.append((name, exc))
            print("[FAIL] %s: %s" % (name, exc))

    print("\n" + "=" * 62)
    print("汇总：%d 个模型，%d 张图，%.1f 秒"
          % (len(MODULES), len(produced), time.time() - t0))
    for p in produced:
        print("  ", os.path.relpath(p, here))
    if failed:
        print("\n失败 %d 个：" % len(failed))
        for n, e in failed:
            print("  %s: %s" % (n, e))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
