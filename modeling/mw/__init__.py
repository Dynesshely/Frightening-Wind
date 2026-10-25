# -*- coding: utf-8 -*-
"""mw —— Morandi-Wind 建模公共包。

    from mw import params as P
    from mw import style as S

    S.setup()
    fig, ax = S.figure()
    ...
    S.save(fig, "fig01_speed")
"""
from . import params, style

__all__ = ["params", "style"]
