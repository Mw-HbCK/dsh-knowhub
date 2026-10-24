# -*- coding: utf-8 -*-
"""渲染 Qoder CN「知识中心」UI 参考图（依据官方文档 + 官方截图重绘，非官方素材）。"""
import os
from PIL import Image, ImageDraw, ImageFont

S = 2
W, H = 1600, 1000
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".research", "qoder", "render")
os.makedirs(OUT, exist_ok=True)

BG_PANEL = "#1B1B1A"; BG_APP = "#1F1E1C"; BG_MAIN = "#1C1C1B"
BG_HOVER = "#262523"; BG_ACTIVE = "#2E2D2A"; BG_CARD = "#232220"
BORDER = "#302F2C"; BORDER_L = "#3C3A36"
TEXT = "#E9E8E4"; MUT = "#9C9A95"; DIM = "#75726C"
GREEN = "#30DB5F"; GREEN_DARK = "#1E8F45"; LINK = "#5BD98A"; DARK = "#14200F"
AMBER = "#E8B45A"; RED = "#FF5F57"; YELLOW = "#FEBC2E"; GREENLIGHT = "#28C840"
CODE_BG = "#191A18"

FR = r"C:\Windows\Fonts\msyh.ttc"; FB = r"C:\Windows\Fonts\msyhbd.ttc"
FONTS = {}
def F(size, bold=False):
    key = (size, bold)
    if key not in FONTS:
        FONTS[key] = ImageFont.truetype(FB if bold else FR, int(round(size * S)))
    return FONTS[key]

img = None; d = None
def sc(v): return int(round(v * S))

def rect(x, y, w, h, fill=None, outline=None, width=1, radius=0):
    d.rounded_rectangle([sc(x), sc(y), sc(x + w), sc(y + h)], radius=sc(radius),
                        fill=fill, outline=outline, width=max(1, sc(width)) if outline else 0)

def text(x, y, s, size=13, color=TEXT, bold=False, anchor="la"):
    d.text((sc(x), sc(y)), s, font=F(size, bold), fill=color, anchor=anchor)

def line(x1, y1, x2, y2, color=BORDER, width=1):
    d.line([sc(x1), sc(y1), sc(x2), sc(y2)], fill=color, width=max(1, sc(width)))

def circle(cx, cy, r, fill=None, outline=None, width=1):
    d.ellipse([sc(cx - r), sc(cy - r), sc(cx + r), sc(cy + r)], fill=fill,
              outline=outline, width=max(1, sc(width)) if outline else 0)

def wrap(x, y, w, s, size=13, color=TEXT, bold=False, lh=None, max_lines=None):
    f = F(size, bold); lh = lh or size * 1.62
    tokens, buf = [], ""
    for ch in s:
        if ch.isascii() and (ch.isalnum() or ch in "-_./:@+"):
            buf += ch
        else:
            if buf: tokens.append(buf); buf = ""
            tokens.append(ch)
    if buf: tokens.append(buf)
    lines, cur = [], ""
    for tok in tokens:
        if tok == "\n":
            lines.append(cur); cur = ""; continue
        if f.getlength(cur + tok) > w * S and cur:
            lines.append(cur); cur = tok.lstrip()
        else:
            cur += tok
    if cur: lines.append(cur)
    for i, ln in enumerate(lines):
        if max_lines and i >= max_lines: break
        text(x, y + i * lh, ln, size, color, bold)
    return y + min(len(lines), max_lines or len(lines)) * lh

def pill(x, y, label, size=10.5, fg=MUT, bg=BG_CARD, border=BORDER_L, h=20, padx=8):
    w = F(size).getlength(label) / S + padx * 2
    rect(x, y, w, h, fill=bg, outline=border, width=1, radius=h / 2)
    text(x + padx, y + h / 2, label, size, fg, anchor="lm")
    return w

def icon_lines(x, y, color=MUT, n=3, wid=13):
    for i in range(n):
        line(x, y + i * 4, x + wid - (3 if i == n - 1 else 0), y + i * 4, color, 1.2)

def icon_search(x, y, color=MUT):
    circle(x + 5, y + 5, 4.2, outline=color, width=1.2)
    line(x + 8.4, y + 8.4, x + 12, y + 12, color, 1.2)

def icon_folder(x, y, color=MUT):
    rect(x, y + 1.5, 13, 9.5, outline=color, width=1.1, radius=2)
    line(x + 1.5, y + 4.5, x + 11.5, y + 4.5, color, 1)

def icon_book(x, y, color=MUT):
    rect(x, y, 13, 13, outline=color, width=1.1, radius=2.5)
    line(x + 6.5, y + 1.5, x + 6.5, y + 11.5, color, 1)

def icon_grid(x, y, color=MUT):
    for i in range(2):
        for j in range(2):
            rect(x + i * 5, y + j * 5, 3.6, 3.6, fill=color, radius=0.8)

def icon_caret(x, y, color=MUT, up=False):
    pts = [(x, y + (3 if up else 0)), (x + 4, y + (0 if up else 3)), (x + 8, y + (3 if up else 0))]
    d.line([(sc(px), sc(py)) for px, py in pts], fill=color, width=max(1, sc(1.2)))

def icon_close(x, y, color=MUT, size=4.5):
    line(x - size, y - size, x + size, y + size, color, 1.1)
    line(x + size, y - size, x - size, y + size, color, 1.1)

def icon_kebab(x, y, color=MUT):
    for i in range(3):
        circle(x, y + i * 3.4, 0.9, fill=color)

def toggle(x, y, on=True, w=34, h=17):
    rect(x, y, w, h, fill=GREEN if on else "#3A3936", radius=h / 2)
    cx = x + w - h / 2 if on else x + h / 2
    circle(cx, y + h / 2, h / 2 - 1.6, fill="#FFFFFF")

def radio(x, y, checked=True):
    circle(x + 6, y + 6, 6, outline=GREEN if checked else "#4A4844", width=1.3)
    if checked: circle(x + 6, y + 6, 3, fill=GREEN)

def new_canvas():
    global img, d
    img = Image.new("RGB", (W * S, H * S), BG_PANEL)
    d = ImageDraw.Draw(img)

def dim():
    global img, d
    ov = Image.new("RGBA", img.size, (0, 0, 0, 150))
    img = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
    d = ImageDraw.Draw(img)

def save(name):
    img.resize((W, H), Image.LANCZOS).save(os.path.join(OUT, name), "PNG")
    print("saved", name)

NAV = ["文档中心", "agent-test-WITH-knowledge", "knowledge_base", "qbase-qoder",
       "qoderdoc", "QoderDocs", "wake0509"]

def draw_sidebar():
    rect(0, 0, 318, H, fill=BG_APP)
    line(318, 0, 318, H, BORDER, 1)
    for i, c in enumerate([RED, YELLOW, GREENLIGHT]):
        circle(18 + i * 18, 18, 5.6, fill=c)
    icon_lines(244, 12, MUT, 3, 14)
    icon_search(272, 9, MUT)
    rect(10, 48, 298, 34, fill=BG_HOVER, outline=BORDER_L, width=1, radius=8)
    text(24, 65, "+", 15, TEXT, anchor="lm")
    text(44, 65, "新建会话", 12.5, TEXT, anchor="lm")
    text(286, 65, "⌘N", 11, DIM, anchor="rm")
    text(16, 100, "会话", 11.5, MUT)
    icon_grid(252, 101, MUT)
    text(276, 100, "+", 13, MUT)
    y = 126
    for i, name in enumerate(NAV):
        icon_folder(16, y + 5, MUT)
        text(38, y, name, 12.5, TEXT)
        if i in (0, 4, 5):
            text(38, y + 18, "暂无会话", 11, DIM)
            y += 54
        else:
            y += 34
    by = H - 168
    rect(8, by, 300, 34, fill=BG_ACTIVE, radius=8)
    icon_book(18, by + 10, TEXT)
    text(40, by + 17, "知识中心", 12.5, TEXT, anchor="lm")
    icon_book(18, by + 50, MUT)
    text(40, by + 57, "市场", 12.5, MUT, anchor="lm")
    line(8, H - 92, 310, H - 92, BORDER, 1)
    circle(28, H - 62, 13, fill="#3A3936")
    text(28, H - 62, "5", 12, TEXT, True, anchor="mm")
    text(48, H - 68, "团队", 12, TEXT)
    text(48, H - 52, "5 名成员", 11, DIM)
    circle(252, H - 62, 9, outline=MUT, width=1.1)
    circle(280, H - 62, 9, outline=MUT, width=1.1)

def draw_col2_head(title, tabs, active_idx, search_ph, tabs_y=56):
    text(338, 22, title, 15, TEXT, True)
    tx = 338
    for i, t in enumerate(tabs):
        w = F(12.5).getlength(t) / S + 26
        if i == active_idx:
            rect(tx, tabs_y, w, 30, fill=BG_ACTIVE, outline=BORDER_L, width=1, radius=15)
            text(tx + 13, tabs_y + 15, t, 12.5, TEXT, anchor="lm")
        else:
            text(tx + 13, tabs_y + 15, t, 12.5, MUT, anchor="lm")
        tx += w + 6
    rect(338, 100, 300, 32, fill=BG_MAIN, outline=BORDER_L, width=1, radius=8)
    icon_search(350, 109, MUT)
    text(370, 116, search_ph, 12, DIM, anchor="lm")
    for i, wd in enumerate([14, 10, 6]):
        line(646, 108 + i * 4, 646 + wd, 108 + i * 4, MUT, 1.1)

def draw_doc_chrome(tabs, repo, updated):
    rect(676, 0, 924, 48, fill=BG_PANEL)
    line(676, 48, 1600, 48, BORDER, 1)
    x = 690
    for i, t in enumerate(tabs):
        w = F(11.5).getlength(t) / S + 44
        active = i == len(tabs) - 1
        if active:
            rect(x, 6, w, 36, fill=BG_CARD, outline=BORDER, width=1, radius=6)
            rect(x, 6, w, 2, fill=GREEN, radius=1)
        text(x + 12, 24, t, 11.5, TEXT if active else MUT, anchor="lm")
        icon_close(x + w - 12, 24, DIM, 4)
        x += w + 2
    text(700, 66, repo, 14.5, TEXT, True)
    text(700, 86, updated, 11, DIM)
    rect(1452, 60, 112, 30, fill=GREEN, radius=8)
    text(1508, 75, "重新生成", 12, DARK, True, anchor="mm")
    icon_kebab(1580, 70, MUT)
    line(676, 104, 1600, 104, BORDER, 1)

def doc_side_toggle(y=128):
    rect(1480, y, 34, 28, fill=BG_HOVER, outline=BORDER, width=1, radius=7)
    circle(1497, y + 14, 5, outline=TEXT, width=1.1)
    circle(1497, y + 14, 1.8, fill=TEXT)
    rect(1516, y, 34, 28, fill=BG_HOVER, outline=BORDER_L, width=1, radius=7)
    text(1533, y + 12, "</>", 10.5, MUT, anchor="mm")

# ---------------- 1. Repo Wiki ----------------
def scene_repo_wiki():
    new_canvas(); draw_sidebar()
    draw_col2_head("知识中心", ["Repo Wiki", "知识卡片", "记忆"], 0, "搜索 Repo Wiki")
    draw_doc_chrome(["st-WI...", "knowledge_base", "qbase-qoder", "qbase-qoder",
                     "qbase-qoder / 项目总览"], "qbase-qoder", "更新于 2026-05-20 11:33")
    text(360, 156, "qbase-qoder", 12.5, TEXT, True)
    icon_book(338, 155, TEXT)
    icon_caret(640, 156, MUT, up=True)
    y = 186
    for t in ["项目总览", "快速开始"]:
        text(360, y, t, 12, TEXT); y += 30
    groups = [
        ("架构总览", ["系统设计模式", "路由架构", "状态管理架构", "服务层架构", "布局系统架构"]),
        ("组件库", ["UI 组件", "图表组件", "表单组件", "弹窗与对话框组件", "布局与导航组件"]),
        ("状态管理", ["模型架构与模式", "用户模型", "组织模型", "订阅模型", "主题与偏好模型"]),
        ("服务层", ["API 客户端架构"]),
    ]
    for gname, items in groups:
        icon_caret(360, y + 1, MUT)
        text(372, y, gname, 12, TEXT); y += 30
        for it in items:
            sel = (gname == "组件库" and it == "UI 组件")
            if sel:
                rect(346, y - 6, 306, 27, fill=BG_ACTIVE, radius=6)
            text(382, y, it, 12, TEXT if sel else MUT)
            y += 30
    text(712, 120, "UI 组件", 11.5, DIM)
    text(712, 136, "介绍", 28, TEXT, True)
    yy = wrap(712, 190, 770,
              "本文档介绍 Qoder UI 组件库，重点说明 QoderTitle、Spinner、LoadingDot、CardTitle、DeviceIcon、Faqs、QoderTabs、QoderNotification 与 BillingAddress 等核心组件的外观、行为、交互模式与 props 接口。",
              14, "#D8D6D1", lh=23)
    yy = wrap(712, yy + 12, 770,
              "同时说明样式定制（SCSS Modules）、主题支持、响应式设计、可访问性、跨浏览器兼容性、性能与组合规范。",
              14, "#D8D6D1", lh=23)
    text(712, yy + 20, "项目结构", 20, TEXT, True)
    wrap(712, yy + 62, 770, "UI 组件位于 qoder/src/components，每个组件通常包含：", 14, "#D8D6D1", lh=23)
    by = yy + 102
    for b in ["一个实现组件逻辑的 TypeScript/TSX 文件",
              "可选的 SCSS module 文件，用于作用域样式",
              "可选子组件或相关文件，统一放在同一目录下"]:
        circle(718, by + 9, 1.8, fill="#D8D6D1")
        text(732, by, b, 14, "#D8D6D1")
        by += 27
    cy = by + 16
    rect(712, cy, 770, 184, fill=BG_CARD, outline=BORDER, width=1, radius=10)
    icon_book(726, cy + 12, MUT)
    text(744, cy + 19, "mermaid", 11, MUT, anchor="lm")
    for i in range(4):
        rect(1382 + i * 20, cy + 12, 14, 14, outline=BORDER_L, width=1, radius=3)
    labels = ["QoderTitle", "Spinner", "LoadingDot", "CardTitle", "DeviceIcon"]
    bw = 120
    for i, lb in enumerate(labels):
        bx = 742 + i * 148
        rect(bx, cy + 48, bw, 40, fill="#2B2A27", outline=BORDER_L, width=1, radius=5)
        text(bx + bw / 2, cy + 60, lb, 9.5, TEXT, anchor="mm")
        text(bx + bw / 2, cy + 76, "index.tsx", 8, DIM, anchor="mm")
        line(bx + bw / 2, cy + 88, bx + bw / 2, cy + 98, BORDER_L, 1)
        pts = [(bx + bw / 2 - 3, cy + 95), (bx + bw / 2, cy + 99), (bx + bw / 2 + 3, cy + 95)]
        d.line([(sc(px), sc(py)) for px, py in pts], fill=BORDER_L, width=max(1, sc(1)))
        text(bx + bw / 2, cy + 106, "index.module.scss", 8, DIM, anchor="mm")
    text(742, cy + 150, "Components", 8.5, DIM)
    sy = cy + 206
    text(712, sy, "图表来源", 20, TEXT, True)
    sy += 38
    for n, rng in [("QoderTitle/index.tsx", "1-58"), ("QoderTitle/index.module.scss", "1-85"),
                   ("Spinner/index.tsx", "1-54")]:
        circle(718, sy + 8, 1.8, fill=LINK)
        text(732, sy, n, 13, LINK)
        text(732 + F(13).getlength(n) / S + 6, sy, ":" + rng, 13, MUT)
        sy += 28
    doc_side_toggle()
    save("01-repo-wiki.png")

# ---------------- 2. 知识库 ----------------
def scene_kb():
    new_canvas(); draw_sidebar()
    draw_col2_head("知识中心", ["Repo Wiki", "知识库", "知识卡片", "记忆"], 1, "按名称搜索知识库")
    # scope filter + view toggle
    rect(338, 146, 128, 26, fill=BG_CARD, outline=BORDER_L, width=1, radius=6)
    text(350, 153, "全部工作区", 11, MUT)
    icon_caret(440, 157, MUT)
    icon_grid(624, 152, MUT)
    icon_lines(648, 150, MUT, 3, 12)
    rows = [
        ("支付中心设计文档", "工作区 · 支付中心", "12 个文件 · 更新于 2026-05-20", "工作区", True),
        ("前端组件规范", "用户级 · 跨工作区共享", "28 个文件 · 更新于 2026-05-18", "用户", False),
        ("发布流程与回滚手册", "工作区 · 支付中心", "6 个文件 · 更新于 2026-05-12", "工作区", False),
        ("接口评审记录", "工作区 · 网关服务", "9 个文件 · 更新于 2026-04-28", "工作区", False),
    ]
    y = 194
    for name, meta, sub, scope, sel in rows:
        if sel:
            rect(330, y - 10, 336, 74, fill=BG_ACTIVE, radius=8)
        text(346, y, name, 12.5, TEXT, True)
        pill(346 + F(12.5, True).getlength(name) / S + 8, y - 1, scope, 9.5,
             GREEN if scope == "工作区" else MUT, "#1E2A1E" if scope == "工作区" else BG_CARD)
        text(346, y + 20, meta, 10.5, DIM)
        text(346, y + 38, sub, 10.5, DIM)
        y += 78
    # main detail
    text(700, 62, "支付中心设计文档", 19, TEXT, True)
    wx = 700 + F(19, True).getlength("支付中心设计文档") / S + 12
    pill(wx, 66, "工作区", 9.5, GREEN, "#1E2A1E")
    text(700, 90, "更新于 2026-05-20 11:02 · 12 个文件 · 模型 amd/DeepSeek-V4-Flash", 10.5, DIM)
    rect(1400, 60, 66, 30, fill=BG_HOVER, outline=BORDER_L, width=1, radius=8)
    text(1433, 75, "设置", 11.5, TEXT, anchor="mm")
    rect(1474, 60, 94, 30, fill=GREEN, radius=8)
    text(1521, 75, "添加知识", 11.5, DARK, True, anchor="mm")
    line(676, 112, 1600, 112, BORDER, 1)
    # file pane
    rect(700, 132, 386, 32, fill=BG_MAIN, outline=BORDER_L, width=1, radius=8)
    icon_search(712, 141, MUT)
    text(732, 148, "搜索文件", 11.5, DIM, anchor="lm")
    files = [
        ("接口约定.md", "Markdown · 2.4 KB · 2026-05-20", True),
        ("支付流程.png", "图片 · 180 KB · 2026-05-20", False),
        ("数据库设计.docx", "Word · 46 KB · 2026-05-19", False),
        ("网关限流规则.csv", "CSV · 3 KB · 2026-05-18", False),
        ("领域术语表.md", "Markdown · 8 KB · 2026-05-15", False),
    ]
    y = 186
    for name, meta, sel in files:
        if sel:
            rect(694, y - 10, 398, 54, fill=BG_ACTIVE, radius=8)
        rect(710, y, 14, 18, fill="#2F3A33" if sel else "#2A2A27", radius=3)
        text(717, y + 9, "M", 8.5, GREEN if sel else MUT, True, anchor="mm")
        text(736, y, name, 12, TEXT if sel else MUT)
        text(736, y + 20, meta, 10, DIM)
        y += 58
    text(700, y + 8, "单个文件不超过 500 MB · 支持 PDF / Word / Excel / PPT / Markdown / TXT / CSV / HTML / 图片", 9.5, DIM)
    # preview card
    rect(1112, 128, 468, 800, fill=BG_CARD, outline=BORDER, width=1, radius=10)
    text(1132, 150, "接口约定.md", 13, TEXT, True)
    rect(1132, 176, 74, 24, fill=BG_HOVER, radius=6)
    text(1169, 192, "渲染", 10.5, TEXT, anchor="mm")
    rect(1210, 176, 74, 24, fill=None, radius=6)
    text(1247, 192, "源码", 10.5, MUT, anchor="mm")
    rect(1440, 176, 28, 24, outline=BORDER_L, width=1, radius=6)
    text(1454, 188, "⧉", 10, MUT, anchor="mm")
    rect(1474, 176, 28, 24, outline=BORDER_L, width=1, radius=6)
    text(1488, 188, "⤓", 10, MUT, anchor="mm")
    line(1112, 214, 1580, 214, BORDER, 1)
    text(1132, 232, "接口约定", 20, TEXT, True)
    py = 276
    py = wrap(1132, py, 424, "本文约定支付中心对外提供的 REST 接口：路径前缀、鉴权方式、幂等要求与错误码规范。", 12, "#D8D6D1", lh=20)
    text(1132, py + 14, "创建支付单", 15, TEXT, True)
    py += 48
    py = wrap(1132, py, 424, "POST /api/v1/payments，需要 Idempotency-Key 请求头；重复请求返回同一订单。", 12, "#D8D6D1", lh=20)
    py += 12
    rect(1132, py, 424, 92, fill=CODE_BG, outline=BORDER, width=1, radius=8)
    for i, cl in enumerate(["{", '  "amount": 1999,', '  "currency": "CNY",', '  "channel": "alipay"', "}"]):
        text(1148, py + 12 + i * 15, cl, 10.5, LINK if i == 0 or i == 4 else "#C9C7C2")
    py += 108
    text(1132, py, "错误码", 15, TEXT, True)
    py += 30
    for k, v in [("PAYMENT_DUPLICATED", "幂等键重复且内容不一致"), ("PAYMENT_LIMIT_EXCEEDED", "超出单笔限额")]:
        text(1132, py, k, 10.5, AMBER)
        text(1132, py + 16, v, 10, MUT)
        py += 40
    # dialog
    dim()
    dx, dy, dw, dh = 500, 236, 600, 470
    rect(dx, dy, dw, dh, fill="#232220", outline="#454340", width=1, radius=12)
    text(dx + 26, dy + 24, "创建知识库", 15, TEXT, True)
    icon_close(dx + dw - 26, dy + 32, MUT, 5)
    text(dx + 26, dy + 62, "名称 *", 11.5, MUT)
    rect(dx + 26, dy + 82, dw - 52, 36, fill=BG_MAIN, outline=GREEN, width=1, radius=8)
    text(dx + 40, dy + 100, "支付中心设计文档", 12.5, TEXT, anchor="lm")
    text(dx + dw - 40, dy + 100, "8/50", 10.5, DIM, anchor="rm")
    text(dx + 26, dy + 132, "生效范围 *", 11.5, MUT)
    radio(dx + 26, dy + 156, checked=False)
    text(dx + 46, dy + 152, "用户", 12.5, TEXT)
    text(dx + 46, dy + 170, "跨工作区共享的通用知识", 10, DIM)
    radio(dx + 250, dy + 156, checked=True)
    text(dx + 270, dy + 152, "工作区", 12.5, TEXT)
    text(dx + 270, dy + 170, "仅当前项目可见", 10, DIM)
    text(dx + 26, dy + 202, "选择工作区 *", 11.5, MUT)
    rect(dx + 26, dy + 222, dw - 52, 36, fill=BG_MAIN, outline=BORDER_L, width=1, radius=8)
    text(dx + 40, dy + 240, "支付中心", 12.5, TEXT, anchor="lm")
    text(dx + 40 + F(12.5).getlength("支付中心") / S + 8, dy + 241, "工作区", 9.5, DIM, anchor="lm")
    icon_caret(dx + dw - 46, dy + 236, MUT)
    text(dx + 26, dy + 272, "知识处理模型", 11.5, MUT)
    rect(dx + 26, dy + 292, dw - 52, 36, fill=BG_MAIN, outline=BORDER_L, width=1, radius=8)
    text(dx + 40, dy + 310, "amd / DeepSeek-V4-Flash（可用）", 12.5, TEXT, anchor="lm")
    icon_caret(dx + dw - 46, dy + 306, MUT)
    text(dx + 26, dy + 342, "使用策略", 11.5, MUT)
    for i, (lbl, sel) in enumerate([("经济", False), ("均衡", True), ("高质量", False)]):
        bx = dx + 26 + i * 96
        rect(bx, dy + 362, 88, 30, fill="#1E2A1E" if sel else BG_MAIN,
             outline=GREEN if sel else BORDER_L, width=1, radius=8)
        text(bx + 44, dy + 377, lbl, 11.5, GREEN if sel else MUT, sel, anchor="mm")
    line(dx, dy + dh - 68, dx + dw, dy + dh - 68, BORDER, 1)
    rect(dx + dw - 200, dy + dh - 52, 76, 32, fill=None, outline=BORDER_L, width=1, radius=8)
    text(dx + dw - 162, dy + dh - 36, "取消", 11.5, MUT, anchor="mm")
    rect(dx + dw - 112, dy + dh - 52, 86, 32, fill=GREEN, radius=8)
    text(dx + dw - 69, dy + dh - 36, "创建", 12, DARK, True, anchor="mm")
    save("02-knowledge-base.png")

# ---------------- 3. 知识卡片 ----------------
def scene_card():
    new_canvas(); draw_sidebar()
    draw_col2_head("知识中心", ["Repo Wiki", "知识卡片", "记忆"], 1, "搜索知识卡片")
    rect(334, 148, 336, 74, fill=BG_CARD, outline=BORDER, width=1, radius=8)
    icon_book(348, 162, MUT)
    text(368, 158, "知识卡片", 12, TEXT, True)
    icon_caret(640, 162, MUT)
    text(348, 182, "开启自动生成后，知识卡片会随着你的开发", 10, DIM)
    text(348, 198, "过程陆续积累。", 10, DIM)
    text(348 + F(10).getlength("过程陆续积累。") / S + 4, 198, "了解更多", 10, LINK)
    cards = [
        ("Qoder SaaS 平台编排器 - 编码约定",
         "在两个主应用与内部包中强制 TypeScript 严格模式（noImplicitAny、strictNullChecks），共享同一份 tsconfig.json。",
         "编码约定", True),
        ("Qoder SaaS 平台编排器",
         "将 Qoder Web 应用与 Notebook 库整合为统一的多租户 SaaS 体验。", "总览", False),
        ("Qoder SaaS 平台编排器 - 技术栈",
         "Ice.js（含 icestark 插件）、NPM Workspaces、TypeScript、React 17。", "技术栈", False),
        ("Qoder SaaS 平台编排器 - 启动与命令",
         "npm start 启动整个工作区，同时编译主应用与被链接的 notebook 包。", "启动与命令", False),
        ("Qoder Web 应用平台 - 架构设计",
         "app.tsx 入口初始化 Ice.js 框架，集中式路由与布局。", "架构", False),
        ("Qoder Web 应用平台 - 编码约定",
         "所有功能页面用 withErrorBoundary 包裹，保证一致的错误处理。", "编码约定", False),
    ]
    y = 252
    for i, (title, excerpt, tag, sel) in enumerate(cards):
        if i > 0:
            line(340, y - 14, 660, y - 14, BORDER, 1)
        if sel:
            rect(330, y - 10, 340, 88, fill=BG_ACTIVE, radius=8)
            rect(330, y - 10, 3, 88, fill=GREEN, radius=1.5)
        text(346, y, title, 11.5, TEXT, True)
        y2 = wrap(346, y + 20, 300, excerpt, 9.5, DIM, lh=15, max_lines=2)
        pill(346, y2 + 4, tag, 9, GREEN, "#1E2A1E", h=18)
        y += 90
    draw_doc_chrome(["agent-test-WI...", "qbase-qoder", "knowledge_base", "Qoder SaaS 平台编排器"],
                    "qbase-qoder", "更新于 2026-05-20 11:33")
    text(712, 132, "Qoder SaaS 平台编排器 - 编码约定", 27, TEXT, True)
    by = 198
    for b in ["在两个主应用与内部包中强制 TypeScript 严格模式（noImplicitAny、strictNullChecks），共享同一份 tsconfig.json。",
              "在生产环境中为主应用与组件库统一使用带哈希类名的 CSS Modules，确保样式隔离。",
              "在仓库根目录用 Yunxiao、ESLint、Prettier 统一 lint 与格式化，所有工作区成员共享。"]:
        circle(718, by + 9, 1.8, fill="#D8D6D1")
        by = wrap(732, by, 740, b, 13.5, "#D8D6D1", lh=22) + 14
    by += 12
    text(712, by, "父级知识", 20, TEXT, True)
    by += 46
    circle(718, by + 8, 1.8, fill=LINK)
    text(732, by, "Qoder SaaS 平台编排器", 13, LINK)
    line(712, by + 58, 1520, by + 58, BORDER, 1)
    text(712, by + 92, "这条内容是否有帮助？", 13, TEXT)
    rect(880, by + 78, 56, 28, fill=None, outline=BORDER_L, width=1, radius=14)
    text(908, by + 92, "是", 12, TEXT, anchor="mm")
    rect(946, by + 78, 56, 28, fill=None, outline=BORDER_L, width=1, radius=14)
    text(974, by + 92, "否", 12, TEXT, anchor="mm")
    doc_side_toggle(124)
    save("03-knowledge-card.png")

# ---------------- 4. 记忆 ----------------
def scene_memory():
    new_canvas(); draw_sidebar()
    draw_col2_head("知识中心", ["Repo Wiki", "知识卡片", "记忆"], 2, "搜索记忆")
    filt = [("成熟度", ["全部", "已成熟", "待观察"]), ("分类", ["全部", "偏好", "项目背景", "踩坑记录"]), ("项目", ["全部", "当前项目"])]
    y = 148
    for label, opts in filt:
        text(338, y, label, 10, DIM)
        x = 338 + F(10).getlength(label) / S + 10
        for i, o in enumerate(opts):
            w = F(10.5).getlength(o) / S + 18
            rect(x, y - 4, w, 22, fill="#1E2A1E" if i == 0 else BG_CARD,
                 outline=GREEN if i == 0 else BORDER_L, width=1, radius=11)
            text(x + w / 2, y + 7, o, 10.5, GREEN if i == 0 else MUT, i == 0, anchor="mm")
            x += w + 6
        y += 34
    mem = [
        ("项目统一用 pnpm workspaces 管理依赖，不要用 npm install 直接装包。", ["偏好", "当前项目"], "2026-05-20", True),
        ("支付中心的下单接口必须带 Idempotency-Key，重复请求返回同一订单。", ["踩坑记录", "支付中心"], "2026-05-19", False),
        ("提交前必须跑 pnpm -r test；CI 会对 lint 失败直接拦截。", ["偏好"], "2026-05-17", False),
        ("网关限流规则放在 config/gateway/*.yaml，改动需要值班同学复核。", ["项目背景"], "2026-05-12", False),
    ]
    y = 268
    for content, tags, when, sel in mem:
        if sel:
            rect(330, y - 12, 340, 96, fill=BG_ACTIVE, radius=8)
        ty = wrap(346, y, 300, content, 10.5, TEXT if sel else "#C9C7C2", lh=17, max_lines=2)
        x = 346
        for t in tags:
            w = pill(x, ty + 6, t, 9, MUT, BG_CARD, h=18)
            x += w + 6
        text(646, ty + 8, when, 9.5, DIM, anchor="ra")
        y += 100
    # main: 设置 · 记忆
    rect(676, 0, 924, 48, fill=BG_PANEL)
    line(676, 48, 1600, 48, BORDER, 1)
    text(700, 18, "设置 · 记忆", 13, TEXT, True, anchor="lm")
    text(712, 74, "记忆", 23, TEXT, True)
    wrap(712, 116, 780, "记忆保存跨任务仍然有用的信息：稳定偏好、项目背景与反复出现的协作约定。可以分别开关全局记忆与项目记忆。", 12, MUT, lh=20)
    cards = [
        ("全局记忆", "在所有项目中读取和更新你的个人偏好、习惯与长期上下文。", "12 个文件", "最近更新 2026-05-20 10:40", True),
        ("项目记忆", "按项目读取和更新代码库规则、经验与长期上下文。", "8 个文件", "最近更新 2026-05-19 18:12", True),
    ]
    y = 210
    for title, desc, files, updated, on in cards:
        rect(712, y, 800, 150, fill=BG_CARD, outline=BORDER, width=1, radius=10)
        text(734, y + 22, title, 14, TEXT, True)
        toggle(1470, y + 24, on)
        wrap(734, y + 50, 640, desc, 11.5, MUT, lh=19)
        text(734, y + 96, files, 11, DIM)
        text(734, y + 116, updated, 11, DIM)
        rect(1250, y + 100, 92, 30, fill=None, outline=BORDER_L, width=1, radius=8)
        text(1296, y + 115, "打开目录", 11, TEXT, anchor="mm")
        rect(1352, y + 100, 70, 30, fill=None, outline="#6A3A38", width=1, radius=8)
        text(1387, y + 115, "清空", 11, "#E28A86", anchor="mm")
        y += 172
    text(712, y + 4, "不要存储密码、验证码、API Key 和一次性任务状态；发现过期内容请及时清理。", 11, AMBER)
    save("04-memory.png")

scene_repo_wiki(); scene_kb(); scene_card(); scene_memory()
