# -*- coding: utf-8 -*-
"""资源供给能力 vs 生产单位(Spawn)供给能力 对比图 + 新建 Spawn 门槛计算（莫兰迪配色）"""
import os, math
from PIL import Image, ImageDraw, ImageFont

MORANDI = ["#A8B5A2", "#C9ADA7", "#9A8C98", "#8E9AAF", "#D4C7B0", "#B7B7A4"]
BG, INK, GRID = "#F2EFEA", "#4A4641", "#DDD8D0"
TTL, SPP = 1500, 3          # 单位寿命 / 每部件孵化 tick
SRC_RATE = 10.0             # 单个矿源：3000 / 300 tick

# 典型身体：(名称, 部件数, 造价)
BODIES = [("小型 2W2C2M", 6, 400), ("中型 3W2C3M", 8, 550), ("大型 3W3C3M", 9, 800), ("满配", 50, 5000)]


def spawn_capacity(parts):
    """单 spawn 稳态能维持的在役单位数（纯时间约束）"""
    return TTL / (SPP * parts)


def energy_capacity(supply, cost, k):
    """能量约束下能维持的在役单位数"""
    return k * supply * TTL / cost


def font(sz):
    for n in ["msyh.ttc", "simhei.ttf", "arial.ttf"]:
        try: return ImageFont.truetype("C:/Windows/Fonts/" + n, sz)
        except Exception: pass
    return ImageFont.load_default()


W_, H_ = 1560, 720
img = Image.new("RGB", (W_, H_), BG)
d = ImageDraw.Draw(img)
f_t, f_l, f_s, f_x = font(27), font(17), font(14), font(12)

PW, PH, GAP, TOP, LEFT = 620, 400, 110, 210, 120
p1 = (LEFT, TOP); p2 = (LEFT + PW + GAP, TOP)


def axes(x0, y0, title, sub, xlabel):
    d.text((x0, y0-96), title, font=f_t, fill=INK)
    d.text((x0, y0-52), sub, font=f_s, fill="#5B5651")
    d.rectangle([x0, y0, x0+PW, y0+PH], outline="#C9C4BC", fill="#F7F5F1")
    for i in range(5):
        d.line([x0, y0+PH*i/4, x0+PW, y0+PH*i/4], fill=GRID)
    d.text((x0+PW//2-80, y0+PH+38), xlabel, font=f_l, fill="#5B5651")


# ================= 左图：可维持单位数 vs 房间供给 =================
axes(*p1, "供给能力 vs 生产能力的瓶颈切换", "能量约束（供给）与时间约束（Spawn 孵化）谁先到顶", "房间总供给（E/tick）")
S_MAX, N_MAX = 120.0, 60.0
X = lambda v: p1[0] + v/S_MAX*PW
Y = lambda v: p1[1] + PH - min(v, N_MAX)/N_MAX*PH
K = 0.5   # 一半能量用于换代

# 能量约束线（大型 800）
costB = 800
pts = [(X(s), Y(energy_capacity(s, costB, K))) for s in range(0, 121, 2)]
d.line(pts, fill=MORANDI[1], width=4, joint="curve")
# 孵化时间约束线（大型 9 部件，恒定）
capB = spawn_capacity(9)
d.line([(X(0), Y(capB)), (X(S_MAX), Y(capB))], fill=MORANDI[3], width=4)
# 交点
s_cross = capB * costB / (K * TTL)
d.line([(X(s_cross), p1[1]), (X(s_cross), p1[1]+PH)], fill="#C08C7A", width=2)
d.ellipse([X(s_cross)-6, Y(capB)-6, X(s_cross)+6, Y(capB)+6], fill="#C08C7A")
d.text((X(s_cross)+10, Y(capB)+12), "门槛 %.0f E/tick" % s_cross, font=f_s, fill="#A0604E")
for i, (txt, col) in enumerate([("能量约束（供给）", MORANDI[1]), ("时间约束（单 Spawn）", MORANDI[3])]):
    lx, ly = p1[0]+18, p1[1]+18+i*26
    d.rectangle([lx-8, ly-6, lx+190, ly+18], fill="#F7F5F1")
    d.line([lx, ly+7, lx+26, ly+7], fill=col, width=4)
    d.text((lx+34, ly-4), txt, font=f_s, fill="#5B5651")
for i in range(5):
    d.text((p1[0]-56, p1[1]+PH-PH*i/4-8), "%d" % int(N_MAX*i/4), font=f_x, fill="#8B857E")
    d.text((p1[0]+PW*i/4-14, p1[1]+PH+8), "%d" % int(S_MAX*i/4), font=f_x, fill="#8B857E")

# ================= 右图：需要的 Spawn 数量 vs 供给 =================
axes(*p2, "新建 Spawn 的需求曲线", "供给越高，单 Spawn 孵化不过来时的扩编阶梯", "房间总供给（E/tick）")
need = []
for s in range(0, 121):
    n_units = energy_capacity(s, costB, K)
    need.append(max(1, math.ceil(n_units / spawn_capacity(9))))
prev = None
for s in range(0, 121):
    x, y = X(s), Y(need[s])
    if prev is not None:
        d.line([prev, (x, prev[1])], fill=MORANDI[0], width=4)
        d.line([(x, prev[1]), (x, y)], fill=MORANDI[0], width=4)
    prev = (x, y)
# 标注 RCL 对应关系
for (s_from, label) in [(0, "RCL7 ×1"), (int(s_cross), "RCL7 ×2"), (int(s_cross*2), "RCL8 ×3")]:
    pass
d.text((p2[0]+16, p2[1]+16), "单 spawn 够用", font=f_s, fill="#6E8B6B")
d.text((p2[0]+PW-190, p2[1]+PH-40), "需要新 Spawn（RCL7 起）", font=f_s, fill="#A0604E")
for i in range(5):
    d.text((p2[0]-40, p2[1]+PH-PH*i/4-8), "%d" % int(N_MAX*i/4), font=f_x, fill="#8B857E")
    d.text((p2[0]+PW*i/4-14, p2[1]+PH+8), "%d" % int(S_MAX*i/4), font=f_x, fill="#8B857E")

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "spawn_threshold.png")
img.save(out)
print("saved:", out)

print("\n=== 单 Spawn 的制造能力上限（每 tick 能把多少能量变成单位）===")
for name, parts, cost in BODIES:
    print("  %-14s %2d 部件 %5d E -> 在役上限 %5.1f 人, 制造吞吐 %5.1f E/tick"
          % (name, parts, cost, spawn_capacity(parts), cost / (SPP*parts)))
print("\n=== 新建 Spawn 门槛（k=0.5 换代能量占比）===")
for name, parts, cost in BODIES:
    s_cross = spawn_capacity(parts) * cost / (K*TTL)
    print("  %-14s 供给超过 %5.1f E/tick 时单 spawn 成为瓶颈（约 %d 个矿源房）"
          % (name, s_cross, math.ceil(s_cross/SRC_RATE)))
