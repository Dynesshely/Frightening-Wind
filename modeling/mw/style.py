# -*- coding: utf-8 -*-
"""统一图表风格：莫兰迪色系 + 中文排版 + 一致的坐标轴与保存规则。

设计原则
--------
* 莫兰迪 = 低饱和、灰调、明度接近。避免纯黑纯白纯红。
* 同一张图最多 3 个视觉层级（底层网格 < 数据 < 标注）。
* 所有图默认 150 dpi、白底、无上/右边框。
"""
from __future__ import annotations

import os

import matplotlib
matplotlib.use("Agg")               # 无头环境下必须
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap

_HERE = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.abspath(os.path.join(_HERE, "..", "output"))

# ---------------------------------------------------------------- 莫兰迪色板
#: 主色：灰绿 / 灰粉 / 灰蓝 / 米 / 橄榄 / 灰紫 / 石灰 / 苔绿 / 灰玫 / 奶白
MORANDI = {
    "sage":  "#A8B5A2",   # 灰绿
    "rose":  "#C8A2A2",   # 灰粉
    "dust":  "#9BA7B4",   # 灰蓝
    "sand":  "#D6C9B6",   # 米
    "olive": "#B5B08A",   # 橄榄
    "lilac": "#B0A5B8",   # 灰紫
    "stone": "#8E8B86",   # 石灰
    "moss":  "#7E8B78",   # 苔绿
    "blush": "#C4A0A0",   # 灰玫
    "cream": "#E8E2D8",   # 奶白
    "slate": "#8895A3",   # 冷灰蓝
    "clay":  "#BFA48F",   # 陶土
}

#: 分类序列（按优先级排序，前几个对比度最好）
SEQ = ["#A8B5A2", "#C8A2A2", "#9BA7B4", "#D6C9B6", "#B5B08A",
       "#B0A5B8", "#8E8B86", "#7E8B78", "#C4A0A0", "#8895A3"]

#: 顺序序列（浅 → 深），用于热力图/等高线
SEQ_DARK = ["#EDE9E1", "#D8D2C6", "#C2BCAE", "#A8B5A2", "#8E9E88", "#73836D"]

#: 语义色
GOOD = "#7E8B78"      # 苔绿：收益 / 达标
WARN = "#C0A176"      # 赭：警告 / 临界
BAD = "#B08A8A"       # 暗玫：损失 / 瓶颈
NEUTRAL = "#8E8B86"

#: 背景与文字
BG = "#FBF9F6"
GRID = "#E6E1D9"
TEXT = "#4A4844"
MUTED = "#8A867F"

FONT_STACK = ["Microsoft YaHei", "Microsoft JhengHei", "SimHei",
              "Noto Sans CJK SC", "DejaVu Sans"]

CMAP_SEQ = LinearSegmentedColormap.from_list("morandi_seq", SEQ_DARK)
CMAP_DIV = LinearSegmentedColormap.from_list("morandi_div", ["#B08A8A", "#EDE9E1", "#7E8B78"])


# ---------------------------------------------------------------- 全局设置
def setup(dpi: int = 150, font_size: float = 9.0) -> None:
    """设置 rcParams。每个脚本开头调用一次。"""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    plt.rcParams.update({
        "font.sans-serif": FONT_STACK,
        "font.family": "sans-serif",
        "axes.unicode_minus": False,      # 负号用 ASCII，避免方块
        "figure.dpi": 110,
        "savefig.dpi": dpi,
        "savefig.facecolor": BG,
        "figure.facecolor": BG,
        "axes.facecolor": BG,
        "axes.edgecolor": GRID,
        "axes.labelcolor": TEXT,
        "axes.titlesize": font_size + 2,
        "axes.titleweight": "bold",
        "axes.titlepad": 12,
        "axes.labelsize": font_size,
        "axes.grid": True,
        "axes.axisbelow": True,
        "grid.color": GRID,
        "grid.linewidth": 0.8,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "xtick.labelsize": font_size - 1,
        "ytick.labelsize": font_size - 1,
        "text.color": TEXT,
        "legend.frameon": False,
        "legend.fontsize": font_size - 1,
        "lines.linewidth": 2.0,
        "lines.markersize": 5,
    })


def figure(width: float = 7.0, height: float = 4.2, **kwargs):
    """创建一张已套用风格的白底图。"""
    fig, ax = plt.subplots(figsize=(width, height), **kwargs)
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)
    tidy(ax)
    return fig, ax


def tidy(ax, grid_axis: str = "y") -> None:
    """去掉上/右框，网格只留一个方向。"""
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.grid(axis=grid_axis, color=GRID, linewidth=0.8)
    if grid_axis == "y":
        ax.grid(axis="x", visible=False)
    elif grid_axis == "x":
        ax.grid(axis="y", visible=False)


def color(key: str) -> str:
    """取某个莫兰迪色。"""
    return MORANDI.get(key, key)


def series(n: int, offset: int = 0) -> list[str]:
    """取 n 个分类色。"""
    return [SEQ[(i + offset) % len(SEQ)] for i in range(n)]


def annotate(ax, xs, ys, fmt: str = "{:.2f}", dy: float = 0.0, color_: str | None = None):
    """在点上方标注数值。"""
    for x, y in zip(xs, ys):
        ax.annotate(fmt.format(y), (x, y), textcoords="offset points",
                    xytext=(0, 6 + dy), ha="center", fontsize=8,
                    color=color_ or TEXT)


def hline(ax, y: float, label: str | None = None, color_: str | None = None):
    """参考线。"""
    ax.axhline(y, color=color_ or NEUTRAL, linewidth=1.2, linestyle=(0, (4, 3)), zorder=1)
    if label:
        ax.annotate(label, (ax.get_xlim()[1], y), xytext=(4, 3),
                    textcoords="offset points", fontsize=8, color=NEUTRAL,
                    ha="right", va="bottom")


def save(fig, name: str, note: str | None = None) -> str:
    """保存到 modeling/output/<name>.png，返回绝对路径。"""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    path = os.path.join(OUTPUT_DIR, name if name.endswith(".png") else name + ".png")
    if note:
        fig.text(0.005, 0.005, note, fontsize=7, color=MUTED, ha="left", va="bottom")
    fig.savefig(path, bbox_inches="tight", facecolor=BG)
    plt.close(fig)
    return path
