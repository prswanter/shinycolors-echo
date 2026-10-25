#!/usr/bin/env python3
"""闪耀色彩复读机 — 只做复读：你说一句，她用她的声音说回来。

后端只有两件事，都在这一个文件里，只用 Python 标准库：

    POST /api/tts   一段文字 → 这位角色的声音（mp3，Fish Audio）
    POST /api/stt   一段 16 kHz 单声道 WAV → 文字（阿里云百炼 Qwen3-ASR）

没有对话模型，没有记忆，没有好感度，也没有数据库：发出去的文字只变成声音，
不留在任何地方（合成过的音频按内容缓存在 .cache/tts 里，复读同一句不再花钱）。

    python server.py            # 打开 http://127.0.0.1:8765
    python server.py --open     # 顺手把浏览器打开
    python server.py --port 9000 --host 0.0.0.0

密钥写在 config.json（`python server.py` 第一次运行时会生成，界面上也能填），
也可以用环境变量 FISH_AUDIO_API_KEY / DASHSCOPE_API_KEY。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
CACHE = ROOT / ".cache" / "tts"
CONFIG = Path(os.environ.get("ECHO_CONFIG") or (ROOT / "config.json"))
CHARACTERS = ROOT / "characters.json"

FISH_TTS_URL = "https://api.fish.audio/v1/tts"
DASHSCOPE_ASR_URL = (
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
)

FISH_MODELS = ["s2.1-pro-free", "s2.1-pro", "s2-pro", "s1", "drama-3"]
DEFAULT_FISH_MODEL = "s2.1-pro-free"
DEFAULT_ASR_MODEL = "qwen3-asr-flash"

MAX_TEXT = 500  # 一次复读最长多少字：一句口语远远用不到，多了只是浪费钱
MAX_AUDIO = 12 * 1024 * 1024  # 一段录音最大 12 MB（16 kHz 单声道约 6 分钟）
TTS_TIMEOUT = 60
ASR_TIMEOUT = 60

_lock = threading.Lock()


# --------------------------------------------------------------------------- 配置

def load_config() -> dict[str, Any]:
    data: dict[str, Any] = {}
    if CONFIG.exists():
        try:
            data = json.loads(CONFIG.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            data = {}
    return {
        "fish_api_key": str(data.get("fish_api_key") or "").strip(),
        "fish_model": str(data.get("fish_model") or "").strip(),
        "dashscope_api_key": str(data.get("dashscope_api_key") or "").strip(),
        "asr_model": str(data.get("asr_model") or "").strip(),
    }


def fish_key() -> str:
    return (load_config()["fish_api_key"] or os.environ.get("FISH_AUDIO_API_KEY", "")).strip()


def fish_model() -> str:
    return (load_config()["fish_model"] or os.environ.get("FISH_AUDIO_MODEL", "")).strip() or DEFAULT_FISH_MODEL


def dashscope_key() -> str:
    return (load_config()["dashscope_api_key"] or os.environ.get("DASHSCOPE_API_KEY", "")).strip()


def asr_model() -> str:
    return (load_config()["asr_model"] or os.environ.get("ASR_MODEL", "")).strip() or DEFAULT_ASR_MODEL


def save_config(patch: dict[str, Any]) -> None:
    data = load_config()
    for key in ("fish_api_key", "fish_model", "dashscope_api_key", "asr_model"):
        if key in patch and patch[key] is not None:
            data[key] = str(patch[key]).strip()
    with _lock:
        CACHE.parent.mkdir(exist_ok=True)
        CONFIG.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def mask(secret: str) -> str:
    if not secret:
        return ""
    if len(secret) <= 10:
        return secret[:2] + "…"
    return f"{secret[:5]}…{secret[-4:]}"


# --------------------------------------------------------------------------- 角色

def characters() -> list[dict[str, Any]]:
    return json.loads(CHARACTERS.read_text(encoding="utf-8"))["characters"]


def character_by_id(character_id: str) -> dict[str, Any] | None:
    for c in characters():
        if c["id"] == character_id:
            return c
    return None


# --------------------------------------------------------------------------- 上游

class Upstream(Exception):
    """上游服务没成：消息给用户看，`status` 是回给浏览器的状态码。"""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def _system_proxy() -> dict[str, str]:
    """
    系统里设的代理（Windows「Internet 选项」那一栏，Clash / v2ray 自己写进去的那个）。

    特意不用 HTTP_PROXY 这类环境变量：有些工具（比如 WorkBuddy）会往子进程的环境里
    塞一个只给它自己用的隧道代理，那个代理不放行 api.fish.audio，跟着它走就是
    502 Tunnel connection failed。系统代理才是用户真正在用的那个。
    """
    try:
        if os.name == "nt" and hasattr(urllib.request, "getproxies_registry"):
            raw = urllib.request.getproxies_registry()
        else:
            raw = urllib.request.getproxies()
    except Exception:
        return {}
    return {s: raw[s] for s in ("http", "https") if raw.get(s)}


def _proxy_url() -> str | None:
    """这一次请求会走的代理；None 就是直连。优先级：ECHO_PROXY > 系统代理 > 直连。"""
    explicit = os.environ.get("ECHO_PROXY", "").strip()
    if explicit:
        return explicit
    if os.environ.get("ECHO_NO_PROXY"):
        return None
    return _system_proxy().get("https")


def _opener() -> urllib.request.OpenerDirector:
    """按 _proxy_url() 指的路线走；没有代理就直连。"""
    url = _proxy_url()
    if url:
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": url, "https": url})
        )
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _post_json(url: str, body: dict[str, Any], headers: dict[str, str], timeout: int) -> tuple[int, bytes]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST")
    request.add_header("Content-Type", "application/json")
    for name, value in headers.items():
        request.add_header(name, value)
    try:
        with _opener().open(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except urllib.error.URLError as e:
        reason = str(e.reason)
        proxy = _proxy_url()
        hint = ""
        if "Tunnel connection" in reason or "ProxyError" in reason:
            hint = (f"（代理 {proxy} 连不上它：换个节点，或者设 ECHO_NO_PROXY=1 直连）"
                    if proxy else "")
        elif proxy:
            hint = f"（这次走的是代理 {proxy}）"
        elif "timed out" in reason.lower() or "10060" in reason:
            hint = "（直连超时，域名可能被污染：设 ECHO_PROXY=http://127.0.0.1:7890 走代理试试）"
        raise Upstream(f"连不上 {_host(url)}：{reason}{hint}") from None
    except TimeoutError:
        proxy = _proxy_url()
        hint = f"（走的是代理 {proxy}）" if proxy else "（直连）"
        raise Upstream(f"{_host(url)}超时了{hint}，网络不太顺？") from None


def _host(url: str) -> str:
    return "Fish Audio" if "fish.audio" in url else "阿里云百炼"


def _detail(raw: bytes) -> str:
    text = raw[:400].decode("utf-8", "replace").strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return text
    for key in ("message", "error", "detail", "code"):
        value = parsed.get(key) if isinstance(parsed, dict) else None
        if isinstance(value, str) and value:
            return value
        if isinstance(value, dict):
            inner = value.get("message") or value.get("code")
            if isinstance(inner, str) and inner:
                return inner
    return text


def synthesize(text: str, voice_id: str) -> bytes:
    """`text` 用 `voice_id` 这把嗓子念出来，mp3。合成过的按内容缓存。"""
    key = fish_key()
    if not key:
        raise Upstream("还没填 Fish Audio 的密钥，点右上角设置填一下", 503)
    model = fish_model()
    digest = hashlib.sha256(f"{model}\0{voice_id}\0{text}".encode("utf-8")).hexdigest()
    path = CACHE / f"{digest}.mp3"
    if path.exists() and path.stat().st_size > 0:
        return path.read_bytes()
    status, raw = _post_json(
        FISH_TTS_URL,
        {"text": text, "reference_id": voice_id, "format": "mp3"},
        {"Authorization": f"Bearer {key}", "model": model},
        TTS_TIMEOUT,
    )
    if status >= 400:
        hint = {
            401: "密钥不对，检查一下 Fish Audio 的 key",
            402: "Fish Audio 余额不足，充值或换一个模型试试",
            403: "这把嗓子不给用：音色要设为公开",
            404: "找不到这把嗓子（音色 ID 失效了？）",
            429: "请求太频繁了，等一下再说",
        }.get(status, "Fish Audio 没能合成")
        raise Upstream(f"{hint}（{status}：{_detail(raw)}）", 502)
    if not raw:
        raise Upstream("Fish Audio 没有返回音频（这次的说法它念不出来？）", 502)
    CACHE.mkdir(parents=True, exist_ok=True)
    try:
        path.write_bytes(raw)
    except OSError:
        pass  # 缓存写不进去也照样出声
    return raw


def transcribe(wav: bytes) -> str:
    """这段 WAV（16 kHz 单声道 16 位）说的是什么。"""
    key = dashscope_key()
    if not key:
        raise Upstream("还没填阿里云百炼的密钥：要么填上，要么把识别方式换成「浏览器」", 503)
    model = asr_model()
    audio = "data:audio/wav;base64," + base64.b64encode(wav).decode("ascii")
    # Qwen3-ASR 这一代用 `audio` 字段；新一代的 qwen-audio-*-asr-flash 用 input_audio。
    bodies = [
        {
            "model": model,
            "input": {"messages": [{"role": "user", "content": [{"audio": audio}]}]},
            "parameters": {"format": "wav", "sample_rate": 16000},
        },
        {
            "model": model,
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_audio", "input_audio": {"data": audio}}
                        ],
                    }
                ]
            },
            "parameters": {"format": "wav", "sample_rate": "16000"},
        },
    ]
    last = ""
    for body in bodies:
        status, raw = _post_json(
            DASHSCOPE_ASR_URL,
            body,
            {"Authorization": f"Bearer {key}", "X-DashScope-SSE": "disable"},
            ASR_TIMEOUT,
        )
        if status < 400:
            return _spoken_text(raw)
        last = f"{status}：{_detail(raw)}"
        if status in (401, 402, 403, 429):
            break  # 密钥、余额、限流：换一种写法也没用
    raise Upstream(f"没能听清这段语音（{last}）", 502)


def _spoken_text(raw: bytes) -> str:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        raise Upstream("语音识别返回的东西看不懂", 502) from None
    output = payload.get("output") or {}
    if isinstance(output.get("text"), str):  # 老一代接口
        return output["text"].strip()
    choices = output.get("choices") or []
    if choices:
        content = (choices[0].get("message") or {}).get("content") or []
        parts = [c.get("text", "") for c in content if isinstance(c, dict)]
        return "".join(parts).strip()
    raise Upstream("语音识别没有返回结果", 502)


# --------------------------------------------------------------------------- HTTP

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "ShinyEcho/1.0"
    protocol_version = "HTTP/1.1"

    # --- 小工具 ---

    def _send(self, status: int, body: bytes, mime: str, cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, status: int, payload: Any) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _fail(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_AUDIO * 2:
            raise ValueError("太大的请求")
        return self.rfile.read(length) if length else b""

    def log_message(self, fmt: str, *args: Any) -> None:  # 安静一点
        if os.environ.get("ECHO_VERBOSE"):
            super().log_message(fmt, *args)

    # --- 路由 ---

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/characters":
            data = json.loads(CHARACTERS.read_text(encoding="utf-8"))
            return self._json(200, data)
        if path == "/api/config":
            cfg = load_config()
            return self._json(
                200,
                {
                    "fish": {
                        "configured": bool(fish_key()),
                        "masked": mask(fish_key()),
                        "model": fish_model(),
                        "models": FISH_MODELS,
                    },
                    "asr": {
                        "configured": bool(dashscope_key()),
                        "masked": mask(dashscope_key()),
                        "model": asr_model(),
                    },
                },
            )
        return self._static(path)

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/tts":
                return self._tts()
            if path == "/api/stt":
                return self._stt()
            if path == "/api/config":
                return self._save_config()
        except ValueError as e:
            return self._fail(400, str(e))
        except Upstream as e:
            return self._fail(e.status, str(e))
        except Exception as e:  # 别让一个意外把服务弄哑
            return self._fail(500, f"出错了：{e}")
        return self._fail(404, "没有这个接口")

    # --- 接口 ---

    def _tts(self) -> None:
        payload = json.loads(self._body() or b"{}")
        text = str(payload.get("text") or "").strip()
        character_id = str(payload.get("character") or "")
        if not text:
            return self._fail(422, "还没说话呢")
        if len(text) > MAX_TEXT:
            return self._fail(422, f"一句最多 {MAX_TEXT} 字")
        character = character_by_id(character_id)
        if character is None:
            return self._fail(404, "没有这位角色")
        voice_id = str(character.get("voice_id") or "").strip()
        if not voice_id:
            return self._fail(503, "她还没有音色")
        started = time.time()
        audio = synthesize(text, voice_id)
        if os.environ.get("ECHO_VERBOSE"):
            print(f"  tts {character['id']} {len(text)}字 {time.time() - started:.2f}s")
        self._send(200, audio, "audio/mpeg", "no-store")

    def _stt(self) -> None:
        raw = self._body()
        if not raw:
            return self._fail(422, "没有收到声音")
        if raw[:1] == b"{":
            payload = json.loads(raw)
            audio = base64.b64decode(str(payload.get("audio") or ""), validate=True)
        else:
            audio = raw
        if len(audio) < 2000:
            return self._fail(422, "太短了，再说一句？")
        text = transcribe(audio)
        if not text:
            return self._fail(422, "没听清，再说一次？")
        self._json(200, {"text": text})

    def _save_config(self) -> None:
        payload = json.loads(self._body() or b"{}")
        save_config(payload)
        cfg = load_config()
        self._json(
            200,
            {
                "fish": {
                    "configured": bool(fish_key()),
                    "masked": mask(fish_key()),
                    "model": fish_model(),
                    "models": FISH_MODELS,
                },
                "asr": {
                    "configured": bool(dashscope_key()),
                    "masked": mask(dashscope_key()),
                    "model": asr_model(),
                },
            },
        )

    # --- 静态文件 ---

    def _static(self, path: str) -> None:
        if path in ("/", ""):
            path = "/index.html"
        target = (PUBLIC / path.lstrip("/")).resolve()
        if not str(target).startswith(str(PUBLIC)) or not target.is_file():
            return self._fail(404, "没有这个文件")
        mime = MIME.get(target.suffix.lower(), "application/octet-stream")
        cache = "public, max-age=86400" if target.suffix.lower() in (".jpg", ".png", ".svg", ".woff2") else "no-cache"
        self._send(200, target.read_bytes(), mime, cache)


def main() -> None:
    parser = argparse.ArgumentParser(description="闪耀色彩复读机")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    args = parser.parse_args()

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:{args.port}"
    print("\n  闪耀色彩复读机 —— 29 种复读模式", flush=True)
    print(f"  {url}", flush=True)
    print(f"  Fish Audio：{'已配置' if fish_key() else '未配置（点右上角设置）'}"
          f" · 语音识别：{'百炼' if dashscope_key() else '未配置'}", flush=True)
    proxy = _proxy_url()
    source = "ECHO_PROXY" if os.environ.get("ECHO_PROXY", "").strip() else "系统代理"
    print(f"  网络：{'走' + source + ' ' + proxy if proxy else '直连（没找到系统代理）'}", flush=True)
    print("  Ctrl+C 退出\n", flush=True)
    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("  再见。", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
