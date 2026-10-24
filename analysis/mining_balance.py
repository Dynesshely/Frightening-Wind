# -*- coding: utf-8 -*-
"""采矿编制平衡模型（纯 PIL 绘制，莫兰迪配色）"""
import os
from PIL import Image, ImageDraw, ImageFont

MORANDI = ["#A8B5A2", "#C9ADA7", "#9A8C98", "#8E9AAF", "#D4C7B0", "#B7B7A4", "#BFA5A4", "#93A8AC"]
BG, INK, GRID = "#F2EFEA", "#4A4641", "#DDD8D0"
C_W, C_C, C_M = 100, 50, 50
TTL, SPP, SRC = 1500, 3, 10.0


def stats(W, C, M):
    cost = C_W*W + C_C*C + C_M*M
    weight = W + C
    speed = 1.0 if 2*M >= weight else max(0.15, 2*M/weight)
    return cost, speed, 50*C


def rate(W, C, M, d):
    cost, speed, carry = stats(W, C, M)
    if carry <= 0 or W <= 0: return 0.0
    return carry / (carry/(2.0*W) + 2.0*d/speed + 2.0)


def net(W, C, M, d):
    cost, speed, carry = stats(W, C, M)
    parts = W + C + M
    r = rate(W, C, M, d)
    creeps = TTL / (SPP * parts)
    return r*creeps - creeps*cost/TTL, cost, r, creeps


def best(d, cap):
    b = None
    for W in range(1, 9):
        for C in range(1, 9):
            for M in range(1, 9):
                cost, _, _ = stats(W, C, M)
                if cost > cap: continue
                n, c, r, cr = net(W, C, M, d)
                if b is None or n > b[0]: b = (n, c, r, cr, (W, C, M))
    return b


def font(sz):
    for name in ["msyh.ttc", "msyhbd.ttc", "simhei.ttf", "arial.ttf"]:
        try: return ImageFont.truetype("C:/Windows/Fonts/" + name, sz)
        except Exception: pass
    return ImageFont.load_default()


W_, H_ = 1560, 690
img = Image.new("RGB", (W_, H_), BG)
d = ImageDraw.Draw(img)
f_t, f_l, f_s = font(28), font(18), font(15)

PW, PH, GAP, TOP = 620, 400, 110, 210
LEFT = 120
panels = [(LEFT, TOP), (LEFT + PW + GAP, TOP)]


def axes_box(x0, y0, title, xlabel, ylabel):
    # 标题单独一层，y 轴标签再下一层，绝不和标题重叠
    d.text((x0, y0 - 96), title, font=f_t, fill=INK)
    d.text((x0, y0 - 52), ylabel, font=f_s, fill="#5B5651")
    d.rectangle([x0, y0, x0+PW, y0+PH], outline="#C9C4BC", fill="#F7F5F1")
    for i in range(5):
        yy = y0 + PH*i/4
        d.line([x0, yy, x0+PW, yy], fill=GRID)
    d.text((x0 + PW//2 - 70, y0 + PH + 40), xlabel, font=f_l, fill="#5B5651")


# ---- 左图：净产出 vs 身体造价，按距离分色 ----
axes_box(*panels[0], "距离越远 -> 最优身体越小", "身体造价（能量）", "净产出 E/tick")
DISTS = [12, 20, 30, 40, 50, 60]
xmin, xmax, ymax = 200, 1300, 0
series = []
for dd in DISTS:
    pts = []
    for cap in range(200, 1301, 20):
        b = best(dd, cap)
        if b: pts.append((b[1], b[0])); ymax = max(ymax, b[0])
    series.append(pts)
x0p, y0p = panels[0]
X = lambda v: x0p + (v - xmin) / (xmax - xmin) * PW
Y = lambda v: y0p + PH - (v / (ymax*1.08)) * PH
for i, pts in enumerate(series):
    xy = [(X(a), Y(b)) for a, b in pts]
    d.line(xy, fill=MORANDI[i], width=4, joint="curve")
    lx, ly = x0p + 18, y0p + 18 + i*26
    d.rectangle([lx-8, ly-6, lx+110, ly+18], fill="#F7F5F1")
    d.line([lx, ly+7, lx+26, ly+7], fill=MORANDI[i], width=4)
    d.text((lx+34, ly-4), "%d 格" % DISTS[i], font=f_s, fill="#5B5651")
d.text((x0p+8, y0p+PH-24), "200", font=f_s, fill="#8B857E")
d.text((x0p+PW-46, y0p+PH-24), "1300", font=f_s, fill="#8B857E")

# ---- 右图：最优造价 vs 距离，按容量分色 ----
axes_box(*panels[1], "最优平衡点：近处大身体 / 远处小身体", "到基地单程距离（格）", "最优身体造价")
x0q, y0q = panels[1]
CAPS = [550, 800, 1300]
X2 = lambda v: x0q + (v - 8) / (64 - 8) * PW
Y2 = lambda v: y0q + PH - (v / 1400.0) * PH
d.line([x0q, y0q+PH, x0q+PW, y0q+PH], fill="#B8B2A9", width=2)
for i, cap in enumerate(CAPS):
    pts = []
    for dd in range(8, 65, 2):
        b = best(dd, cap)
        if b: pts.append((X2(dd), Y2(b[1])))
    if len(pts) > 1:
        d.line(pts, fill=MORANDI[i], width=4, joint="curve")
        for p in pts[::4]:
            d.ellipse([p[0]-4, p[1]-4, p[0]+4, p[1]+4], fill=MORANDI[i])
    lx, ly = x0q + 18, y0q + 18 + i*26
    d.rectangle([lx-8, ly-6, lx+130, ly+18], fill="#F7F5F1")
    d.line([lx, ly+7, lx+26, ly+7], fill=MORANDI[i], width=4)
    d.text((lx+34, ly-4), "容量 %d" % cap, font=f_s, fill="#5B5651")
for i in range(5):
    d.text((x0q-34, y0q+PH - PH*i/4 - 8), "%d" % int(1400*i/4), font=f_s, fill="#8B857E")

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mining_balance.png")
img.save(out)
print("saved:", out)

print("\n距离 | 最优身体 | W/C/M | 单兵E/t | 同时役 | 净E/tick")
print("-" * 62)
for dd in DISTS:
    b = best(dd, 1300)
    n, c, r, cr, (W, C, M) = b
    print("%3d  | %6d | %d/%d/%d | %6.2f | %5.1f | %6.2f" % (dd, c, W, C, M, r, cr, n))
