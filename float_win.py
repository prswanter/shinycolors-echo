#!/usr/bin/env python3
"""复读浮窗 —— 一个没有标题栏、永远置顶、整窗半透明的小窗口。

浏览器里做不到三件事：去掉窗口标题栏、压在别的窗口上面、让窗口本身半透明。
（Document Picture-in-Picture 能置顶，但标题栏是浏览器强制的防伪标识，删不掉。）

所以这里换了个壳：界面仍然是 public/float.html 那套 HTML/CSS/JS，
外面用一个本地窗口（WebView2）装起来，窗口属性由这个文件管：

    frameless       去掉标题栏
    on_top          压在游戏上面
    WS_EX_LAYERED   整窗半透明（Windows 层叠窗口，逐窗口一个 alpha）
    SetWindowRgn    圆角

    python float_win.py --url http://127.0.0.1:8766/float.html --alpha 0.65

通常不用手敲：在复读页点输入框右边那个小窗图标，服务端会把这个进程拉起来。
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import json
import os
import sys
import threading
import time
import urllib.request
from pathlib import Path

# 日志是父进程用 UTF-8 开的文件，但子进程默认按系统代码页（简中 GBK / 日文 cp932 …）
# 编码 stdout，一 print 中文就 UnicodeEncodeError——热键线程就是这么整条炸掉的。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# WebView2 的两个开关：
#   autoplay-policy             敲回车就该出声，不该再等一次点击授权
#   use-fake-ui-for-media-stream 让页面看得见「所有」播放设备。
#     不开这个，enumerateDevices 只给一个空的默认设备，setSinkId 根本选不了 CABLE Input，
#     浮窗的声音就只能跟着系统默认走（网页里却是对的，因为浏览器早就拿过麦克风权限）。
os.environ.setdefault(
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    "--autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream",
)

def say(text: str) -> None:
    """往 .float.log 写一行；写不出去也绝不能把线程带死。"""
    try:
        print(text, flush=True)
    except Exception:
        pass


WIDTH, HEIGHT = 366, 68          # 逻辑像素；实际尺寸按系统缩放换算
RADIUS = 15
POS_FILE = Path(__file__).with_name(".float.pos")
SPI_GETWORKAREA = 0x0030

GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
WS_EX_TOOLWINDOW = 0x00000080    # 任务栏和 Alt+Tab 里都不出现
WS_EX_APPWINDOW = 0x00040000     # 它的存在会把任务栏按钮加回来，得摘掉
LWA_ALPHA = 0x2
SWP_NOSIZE, SWP_NOMOVE, SWP_NOZORDER, SWP_NOACTIVATE = 0x0001, 0x0002, 0x0004, 0x0010
SWP_FRAMECHANGED = 0x0020

# 回到输入框的那个系统级快捷键。
# 页面里监听 keydown 是不够的：正在玩游戏时按键先去了游戏窗口，浮窗根本收不到，
# 所以必须走 RegisterHotKey——它由系统在别人前面截走，跟谁在前台无关。
DEFAULT_HOTKEY = "alt+w"
MOD_BITS = {"alt": 0x0001, "ctrl": 0x0002, "control": 0x0002, "shift": 0x0004, "win": 0x0008, "meta": 0x0008}
MOD_NOREPEAT = 0x4000            # 按住不放只触发一次
WM_HOTKEY = 0x0312
WM_APP_RELOAD = 0x8000 + 1       # 自己发给热键线程：换一个快捷键
HOTKEY_ID = 0x5E01
VK_CODES = {
    **{chr(c): c - 32 for c in range(ord("a"), ord("z") + 1)},   # a-z → 0x41-0x5A
    **{str(d): 0x30 + d for d in range(10)},                      # 0-9 → 0x30-0x39
    **{f"f{i}": 0x6F + i for i in range(1, 25)},                  # f1-f24 → 0x70-0x87
    "space": 0x20, "tab": 0x09, "enter": 0x0D, "esc": 0x1B, "escape": 0x1B,
    "backspace": 0x08, "insert": 0x2D, "delete": 0x2E, "home": 0x24, "end": 0x23,
    "pageup": 0x21, "pagedown": 0x22, "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
}


def dpi_scale(hwnd: int) -> float:
    dpi = ctypes.windll.user32.GetDpiForWindow(wintypes.HWND(hwnd))
    return (dpi / 96.0) if dpi else 1.0


def work_area() -> tuple[int, int, int, int]:
    rect = wintypes.RECT()
    ctypes.windll.user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(rect), 0)
    return rect.left, rect.top, rect.right, rect.bottom


def saved_position() -> tuple[int, int] | None:
    """上次拖到哪儿就还在哪儿；换了显示器、跑出屏幕了就不认。"""
    try:
        x, y = (int(v) for v in POS_FILE.read_text(encoding="utf-8").split(","))
    except (OSError, ValueError):
        return None
    left, top, right, bottom = work_area()
    if not (left - 40 <= x <= right - 80 and top - 10 <= y <= bottom - 40):
        return None
    return x, y


def place_window(hwnd: int) -> None:
    """按 DPI 定死尺寸和位置。

    尺寸交给 pywebview 算会被系统缩放和 WinForms 自动缩放叠加两次，差了十几像素，
    页面就得多留一圈空白；位置也一样，干脆这里一次摆好。
    """
    scale = dpi_scale(hwnd)
    width, height = int(round(WIDTH * scale)), int(round(HEIGHT * scale))
    pos = saved_position()
    if pos is None:
        left, top, right, _ = work_area()
        pos = (left + max(0, (right - left - width) // 2), top + int(round(72 * scale)))
    ctypes.windll.user32.SetWindowPos(
        wintypes.HWND(hwnd), 0, pos[0], pos[1], width, height,
        SWP_NOZORDER | SWP_NOACTIVATE,
    )


def set_alpha(hwnd: int, alpha: float) -> None:
    value = max(0.2, min(1.0, float(alpha)))
    try:
        ctypes.windll.user32.SetLayeredWindowAttributes(
            wintypes.HWND(hwnd), 0, int(round(value * 255)), LWA_ALPHA
        )
    except Exception:
        pass


def make_frameless_layered(hwnd: int, width: int, height: int, alpha: float, scale: float) -> None:
    """给窗口挂上「层叠 + 圆角 + 工具窗口」：这三样浏览器窗口自己给不了。

    WS_EX_TOOLWINDOW 是关键的一笔：任务栏和 Alt+Tab 里都不再有它，
    屏幕上就只剩那一条小窗，不再占着一个碍眼的按钮。
    代价是不能从任务栏 / Alt+Tab 切回来——所以那个全局快捷键才是唯一入口。
    """
    user32 = ctypes.windll.user32
    ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    # 只加 TOOLWINDOW 不够：窗口若带着 APPWINDOW，任务栏按钮会照样回来
    want = (ex | WS_EX_LAYERED | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW
    user32.SetWindowLongW(hwnd, GWL_EXSTYLE, want)
    # 只改扩展样式时系统不一定重算外壳，补一次 FRAMECHANGED 才算数
    user32.SetWindowPos(
        wintypes.HWND(hwnd), None, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
    )
    set_alpha(hwnd, alpha)

    radius = max(2, int(round(RADIUS * scale)))
    region = ctypes.windll.gdi32.CreateRoundRectRgn(
        0, 0, width + 1, height + 1, radius * 2, radius * 2
    )
    user32.SetWindowRgn(wintypes.HWND(hwnd), region, True)


def read_state(url: str) -> dict:
    if not url:
        return {}
    try:
        with urllib.request.urlopen(url, timeout=1.5) as res:
            return json.loads(res.read().decode("utf-8") or "{}")
    except Exception:
        return {}


def push_state(url: str, patch: dict) -> None:
    """把「快捷键注册失败」这类消息塞回服务端，页面那边读得到。"""
    if not url:
        return
    try:
        body = json.dumps(patch).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=1.5):
            pass
    except Exception:
        pass


def parse_hotkey(spec: str) -> tuple[int, int] | None:
    """'alt+w' → (MOD_ALT, VK_W)；看不懂就 None。"""
    parts = [p.strip().lower() for p in str(spec or "").split("+") if p.strip()]
    if not parts:
        return None
    mods, key = 0, ""
    for index, part in enumerate(parts):
        if part in MOD_BITS and index < len(parts) - 1:
            mods |= MOD_BITS[part]
        else:
            key = part
    vk = VK_CODES.get(key)
    if vk is None:
        return None
    # 不带修饰键的普通键会把那个键从所有程序手里抢走，只放行 F1–F24。
    if not mods and not 0x70 <= vk <= 0x87:
        return None
    return mods, vk


def activate_window(hwnd: int, quiet: bool = False) -> bool:
    """把浮窗叫到前台，并把键盘焦点交给它。

    后台进程抢前台会被 Windows 静默拒绝（游戏正占着焦点时就是这样），
    所以按「先好好说，不行再硬来」三级往下试：
      1. 直接 SetForegroundWindow
      2. 敲一下 Alt 解开「前台锁」再叫
      3. 把本线程挂到浮窗的输入队列上（AttachThreadInput）再叫 + 抢焦点
    """
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    if not hwnd or not user32.IsWindow(wintypes.HWND(hwnd)):
        return False
    target = wintypes.HWND(hwnd)
    if user32.IsIconic(target):
        user32.ShowWindow(target, 9)                # SW_RESTORE

    def check(tries: int = 8) -> bool:
        for _ in range(tries):
            if user32.GetForegroundWindow() == hwnd:
                return True
            time.sleep(0.02)
        return False

    if check(1):
        return True

    user32.SetForegroundWindow(target)
    if check():
        if not quiet:
            say("[hotkey] 切前台：直接成功")
        return True

    # 前台锁（Windows 只允许「刚有输入」的进程抢前台）：先假装敲一下 Alt
    user32.keybd_event(0x12, 0, 0, 0)
    user32.keybd_event(0x12, 0, 2, 0)
    user32.SetForegroundWindow(target)
    if check():
        if not quiet:
            say("[hotkey] 切前台：敲 Alt 解锁后成功")
        return True

    # 最后一招：挂到目标窗口的输入队列上，这样 SetFocus 才会被认
    tid_target = user32.GetWindowThreadProcessId(target, None)
    tid_me = kernel32.GetCurrentThreadId()
    attached = False
    if tid_target and tid_target != tid_me:
        attached = bool(user32.AttachThreadInput(tid_me, tid_target, True))
    try:
        user32.BringWindowToTop(target)
        user32.SetForegroundWindow(target)
        user32.SetFocus(target)
        user32.SetWindowPos(target, -1, 0, 0, 0, 0, SWP_NOMOVE | 0x0001)   # 顺手压回最上层
    finally:
        if attached:
            user32.AttachThreadInput(tid_me, tid_target, False)
    ok = check(10)
    if not quiet:
        say(f"[hotkey] 切前台：挂输入队列后{'成功' if ok else '失败'}")
    return ok


class HotkeyListener(threading.Thread):
    """系统级快捷键线程：注册、收 WM_HOTKEY、按需换一个组合。

    RegisterHotKey(None, ...) 把消息投到「调用它的那个线程」的队列，
    所以必须自己起线程 + 自己跑消息循环，不能借 WebView2 的窗口。
    """

    def __init__(self, on_fire, spec: str = DEFAULT_HOTKEY) -> None:
        super().__init__(daemon=True, name="hotkey")
        self._on_fire = on_fire
        self._want = (spec or DEFAULT_HOTKEY).strip().lower()
        self._tid = 0
        self._ready = threading.Event()
        self.error = ""            # 非空 = 这个组合没能注册上

    def wait_ready(self, timeout: float = 3.0) -> None:
        self._ready.wait(timeout)

    def change(self, spec: str) -> None:
        """换快捷键；线程还活着就让它自己重注册（页面改完 1 秒内生效）。"""
        spec = (spec or "").strip().lower()
        if not spec or spec == self._want:
            return
        self._want = spec
        if self._tid:
            ctypes.windll.user32.PostThreadMessageW(self._tid, WM_APP_RELOAD, 0, 0)

    def run(self) -> None:
        user32 = ctypes.windll.user32
        self._tid = ctypes.windll.kernel32.GetCurrentThreadId()
        msg = wintypes.MSG()
        user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 0)   # 先把消息队列建出来
        try:
            self._apply()
        except Exception:
            pass                    # 注册失败也不能让线程死掉，否则快捷键彻底没反应
        self._ready.set()
        while True:
            got = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if not got or got == -1:
                return
            try:
                if msg.message == WM_HOTKEY:
                    self._on_fire()
                elif msg.message == WM_APP_RELOAD:
                    self._apply()
            except Exception:
                pass

    def _apply(self) -> None:
        user32 = ctypes.windll.user32
        user32.UnregisterHotKey(None, HOTKEY_ID)
        combo = parse_hotkey(self._want)
        if combo is None:
            self.error = f"快捷键写法不认：{self._want}"
        else:
            mods, vk = combo
            if user32.RegisterHotKey(None, HOTKEY_ID, mods | MOD_NOREPEAT, vk):
                self.error = ""
                say(f"[hotkey] {self._want} 已就绪")
            else:
                self.error = f"{self._want} 被别的程序占着，换一个试试"
        if self.error:
            say(f"[hotkey] {self.error}")


_WINDOW = None       # 页面通过 js_api 关窗时要用；不能挂在 Api 上，
                     # pywebview 会遍历 api 的属性来找可调用的方法，指针一绕就递归炸了
_HWND = 0            # 热键线程要拿它把窗口叫到前台
_JS_LOCK = threading.Lock()


def focus_input() -> None:
    """让页面自己把光标放回输入框。

    窗口被激活时页面会收到 focus，一般就够了；但「浮窗本来就前台、只是焦点
    跑到下拉框去了」这种情况不会有 focus 事件，所以再喊一嗓子。
    """
    if _WINDOW is None or not _JS_LOCK.acquire(blocking=False):
        return
    try:
        _WINDOW.evaluate_js("window.echoFocus && window.echoFocus()")
    except Exception:
        pass
    finally:
        _JS_LOCK.release()


def hold_foreground(hwnd: int, tries: int = 3) -> None:
    """刚叫到前台的头半秒里再看一眼，被抢回去就再叫一次。

    只补几次、不长时间较劲：有的游戏（尤其独占全屏）丢了激活会立刻自己抢回来，
    一直跟它拔河的话，键盘会在两边来回跳，你打的字就漏进游戏里了。
    抢不回来就算了，页面那边会照常显示状态，用户点一下窗口也能接着用。
    """
    deadline = time.time() + 0.6
    while tries > 0 and time.time() < deadline:
        time.sleep(0.12)
        if ctypes.windll.user32.GetForegroundWindow() == hwnd:
            focus_input()
            return
        tries -= 1
        activate_window(hwnd, quiet=True)


def on_hotkey() -> None:
    hwnd = _HWND
    if not hwnd:
        return
    say("[hotkey] 按下，叫浮窗回来")
    if activate_window(hwnd):
        # evaluate_js 会切到 UI 线程再等结果，别把热键线程堵在这儿
        threading.Thread(target=focus_input, daemon=True).start()
        threading.Thread(target=hold_foreground, args=(hwnd,), daemon=True).start()

class Api:
    """页面能调到的唯一一件事：关掉自己。"""

    def close(self) -> bool:
        if _WINDOW is not None:
            _WINDOW.destroy()
        return True


def main() -> int:
    parser = argparse.ArgumentParser(description="复读浮窗")
    parser.add_argument("--url", required=True, help="要装进来的页面地址")
    parser.add_argument("--alpha", type=float, default=0.65, help="1 = 不透明，0.3 = 很透")
    parser.add_argument("--state-url", default="", help="读了会返回 {alpha, hotkey} 的接口")
    parser.add_argument("--hotkey", default=DEFAULT_HOTKEY, help="把光标叫回输入框的快捷键")
    parser.add_argument("--pid-file", default="", help="把进程号写在这里，方便复用一个窗口")
    args = parser.parse_args()

    try:
        import webview
    except ImportError:
        print(
            "  浮窗需要 pywebview：python -m pip install pywebview\n"
            "  （它只是拿来装网页，界面和声音都在 server.py 那一套里）",
            file=sys.stderr,
        )
        return 2

    pid_file = Path(args.pid_file) if args.pid_file else None
    if pid_file:
        try:
            pid_file.write_text(str(os.getpid()), encoding="utf-8")
        except OSError:
            pid_file = None

    api = Api()
    window = webview.create_window(
        "复读浮窗",
        args.url,
        width=WIDTH,
        height=HEIGHT,
        frameless=True,          # 没有标题栏
        easy_drag=False,         # 别让点输入框也变成拖窗口
        draggable=True,          # 只让 .pywebview-drag-region 那一条能拖
        on_top=True,
        resizable=False,
        min_size=(120, 40),
        shadow=False,            # 有阴影的话 DWM 会在圆角外面多画一圈
        transparent=False,       # 逐像素透明在 Windows 上靠不住，改用整窗 alpha
        background_color="#f7f2fa",   # 和页面同色，起窗那一下不闪白
        text_select=False,
        zoomable=False,
        js_api=api,
    )
    global _WINDOW
    _WINDOW = window

    # 快捷键先挂上：窗口还没起来时按到也没关系，回调会自己看 hwnd 有没有
    hotkey = HotkeyListener(on_hotkey, args.hotkey)
    hotkey.start()

    closed = threading.Event()
    window.events.closed += lambda: closed.set()

    def pump() -> None:
        """窗口起来之后再改窗口属性：太早拿不到 HWND，也拿不到真实尺寸。"""
        global _HWND
        window.events.shown.wait()
        form = window.native
        hwnd = form.Handle.ToInt32()
        _HWND = hwnd
        place_window(hwnd)
        width, height = form.ClientSize.Width, form.ClientSize.Height
        make_frameless_layered(hwnd, width, height, args.alpha, dpi_scale(hwnd))

        # 设置里的透明度滑杆改的是服务端状态，这里跟着它走
        last = args.alpha
        reported = ""            # 上次报给页面的快捷键错误（一样就不再重复发）
        spot = None
        while not closed.wait(0.9):
            rect = wintypes.RECT()
            if ctypes.windll.user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect)):
                spot = (rect.left, rect.top)
            snapshot = read_state(args.state_url)
            alpha = snapshot.get("alpha")
            if isinstance(alpha, (int, float)) and abs(float(alpha) - last) > 0.004:
                last = float(alpha)
                set_alpha(hwnd, last)

            # 设置里改了快捷键：这里跟着重注册（改完一秒内生效）
            want = snapshot.get("hotkey")
            if isinstance(want, str) and want:
                hotkey.change(want)
            if hotkey.error != reported:
                reported = hotkey.error
                push_state(args.state_url, {"hotkey_error": reported})

        if spot:
            try:
                POS_FILE.write_text(f"{spot[0]},{spot[1]}", encoding="utf-8")
            except OSError:
                pass

    try:
        webview.start(pump, gui="edgechromium")
    finally:
        if pid_file:
            try:
                pid_file.unlink()
            except OSError:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
