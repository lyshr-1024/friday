#!/usr/bin/env python3
"""重新生成 Friday 的 app icon 与菜单栏图标。

图形是「环 + 中心三角」——方舟反应堆的几何抽象，Friday 是钢铁侠那个 AI。
选它是因为 16px 下只有这个形状还认得出：带缺口的环和双环内核在菜单栏尺寸
都糊成一团。

机器上没有 rsvg/inkscape/PIL，所以这里自带一个 PNG 编码器，4x 超采样做抗
锯齿。改完跑：

    python3 scripts/make-icons.py && \
    iconutil -c icns <输出目录>/Friday.iconset -o apps/desktop/src-tauri/icons/icon.icns

菜单栏图标必须是 template（纯 alpha，macOS 按明暗自己反色），所以和彩色的
app icon 是两套，不能共用——共用会在菜单栏里变成一坨黑剪影。
"""

import math, os, struct, sys, zlib

import math, struct, zlib

def write_png(path, w, h, px):
    raw = b"".join(b"\x00" + bytes(px[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    open(path, "wb").write(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )

SS = 4  # 超采样倍数

def render(size, shapes, bg=None, ss=SS):
    """shapes: [(fn(x,y)->cov, (r,g,b,a)), ...]  坐标归一化到 [-1,1]"""
    layers = ([bg] if bg else []) + shapes
    acc = [0.0] * (size * size * 4)
    n = ss * ss
    for sy in range(size * ss):
        yy = (sy + 0.5) / (size * ss) * 2 - 1
        rowbase = (sy // ss) * size
        for sx in range(size * ss):
            xx = (sx + 0.5) / (size * ss) * 2 - 1
            # 每个子采样点独立合成出一个 RGBA，再累加；混在累加器里合成会把不透明层除以 n
            r = g = b = a = 0.0
            for fn, col in layers:
                cov = fn(xx, yy)
                if cov <= 0:
                    continue
                sa = col[3] / 255 * (cov if cov < 1 else 1.0)
                r = col[0] * sa + r * (1 - sa)
                g = col[1] * sa + g * (1 - sa)
                b = col[2] * sa + b * (1 - sa)
                a = sa + a * (1 - sa)
            if a <= 0:
                continue
            i = (rowbase + sx // ss) * 4
            acc[i] += r; acc[i+1] += g; acc[i+2] += b; acc[i+3] += a * 255
    return bytearray(max(0, min(255, int(round(v / n)))) for v in acc)


# ---- 形状 ----
def ring(r_out, r_in, gap=None):
    def f(x, y):
        d = math.hypot(x, y)
        if not (r_in <= d <= r_out):
            return 0
        if gap:
            a = (math.degrees(math.atan2(-y, x)) + 360) % 360
            lo, hi = gap
            if lo <= a <= hi:
                return 0
        return 1
    return f

def tri(h, cy=0.0):
    """向上的等边三角，h 是外接半径"""
    pts = [(0, cy - h), (h * 0.866, cy + h * 0.5), (-h * 0.866, cy + h * 0.5)]
    def f(x, y):
        s = []
        for i in range(3):
            (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % 3]
            s.append((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1))
        return 1 if all(v >= 0 for v in s) or all(v <= 0 for v in s) else 0
    return f

def disc(r):
    return lambda x, y: 1 if math.hypot(x, y) <= r else 0

def squircle(r=0.92, n=4.6):
    return lambda x, y: 1 if (abs(x / r) ** n + abs(y / r) ** n) <= 1 else 0



CYAN = (76, 204, 230)
BG_OUT, BG_IN = (10, 11, 13), (26, 31, 37)

R_OUT, R_IN = 0.62, 0.505
TRI_H, TRI_CY = 0.29, 0.025          # 正三角在圆内纯居中会显得偏上，往下压一点

def radial_bg():
    """中心略亮的径向渐变，别让 1024 的图标看起来是一块死黑"""
    sq = squircle()
    def f(x, y):
        return sq(x, y)
    def col(x, y):
        t = min(1.0, math.hypot(x, y) / 1.25)
        return tuple(int(BG_IN[i] + (BG_OUT[i] - BG_IN[i]) * t) for i in range(3))
    return f, col

def app_layers(glow=True):
    L = []
    if glow:
        # 外发光：几层递减 alpha 的同心环，够用又不用做模糊
        for k, a in ((0.030, 46), (0.065, 26), (0.110, 13)):
            L.append((ring(R_OUT + k, R_IN - k * 0.5), (*CYAN, a)))
    L.append((ring(R_OUT, R_IN), (*CYAN, 255)))
    L.append((tri(TRI_H, TRI_CY), (*CYAN, 255)))
    return L

def render_app(size, ss):
    """背景是渐变，自己合成一遍，不走 render 的纯色层"""
    sq, colf = radial_bg()
    base = render(size, app_layers(), bg=None, ss=ss)
    out = bytearray(size * size * 4)
    n = ss * ss
    # 背景单独铺一遍（同样超采样求 squircle 覆盖率）
    cov = [0.0] * (size * size)
    for sy in range(size * ss):
        yy = (sy + 0.5) / (size * ss) * 2 - 1
        rb = (sy // ss) * size
        for sx in range(size * ss):
            xx = (sx + 0.5) / (size * ss) * 2 - 1
            if sq(xx, yy):
                cov[rb + sx // ss] += 1
    for i in range(size * size):
        x = ((i % size) + 0.5) / size * 2 - 1
        y = ((i // size) + 0.5) / size * 2 - 1
        ba = cov[i] / n
        br, bg_, bb = colf(x, y)
        fr, fg, fb, fa = base[i*4], base[i*4+1], base[i*4+2], base[i*4+3] / 255
        r = fr * fa + br * ba * (1 - fa)
        g = fg * fa + bg_ * ba * (1 - fa)
        b = fb * fa + bb * ba * (1 - fa)
        a = fa + ba * (1 - fa)
        out[i*4:i*4+4] = bytes((int(round(r)), int(round(g)), int(round(b)), int(round(a * 255))))
    return out

def render_tray(size, width):
    """template 图标：纯黑 alpha，macOS 自己按菜单栏明暗反色"""
    BK = (0, 0, 0, 255)
    return render(size, [(ring(0.82, 0.82 - width), BK), (tri(0.40, 0.03), BK)], ss=4)

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    for size, ss in ((16, 4), (32, 4), (64, 4), (128, 4), (256, 3), (512, 2), (1024, 2)):
        write_png(f"{out}/app-{size}.png", size, size, render_app(size, ss))
        print("app", size, flush=True)
    for size, w in ((16, 0.20), (32, 0.13)):
        write_png(f"{out}/tray-{size}.png", size, size, render_tray(size, w))
        print("tray", size, flush=True)
