#!/usr/bin/env python3
"""本地开发服务器：禁用缓存 + 正确的 MIME 类型。

为什么不用 `python -m http.server`：

  1. **它不发 Cache-Control。** 浏览器会对没有缓存头的资源按"启发式规则"
     自行决定缓存时长。ES 模块一旦被缓存，你改了代码、刷新页面，跑的还是
     旧版本 —— 表现为"改了没生效"或"时好时坏"，极难排查。

  2. **它把 .mjs 当 text/plain 返回。** 浏览器加载 ES 模块时严格检查 MIME，
     会直接拒绝执行。本项目 vendor 里已经改用 .js，但这里也一并修掉，
     免得以后踩。

用法：
    python tools/serve.py            # 默认 8000 端口
    python tools/serve.py 8080
    npm run serve
"""

import http.server
import mimetypes
import os
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 补上 Python 默认不认识的类型
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("text/markdown", ".md")


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """禁止任何缓存，且总是发送正确的 charset。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # 开发期一律不缓存，杜绝"改了代码但浏览器还在用旧的"
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def guess_type(self, path):
        ctype = super().guess_type(path)
        # 文本类资源统一声明 UTF-8，中文才不会变乱码
        if isinstance(ctype, str) and ctype.startswith("text/"):
            return ctype + "; charset=utf-8"
        if isinstance(ctype, str) and ctype == "application/javascript":
            return ctype + "; charset=utf-8"
        return ctype

    def log_message(self, fmt, *args):
        # 只报错，不刷屏
        status = args[1] if len(args) > 1 else ""
        if isinstance(status, str) and status.startswith(("4", "5")):
            sys.stderr.write("  %s %s\n" % (self.address_string(), fmt % args))


class ReusableServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    port = 8000
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print("端口必须是数字")
            return 1

    os.chdir(ROOT)

    with ReusableServer(("127.0.0.1", port), NoCacheHandler) as httpd:
        url = "http://127.0.0.1:%d" % port
        print("帕尼尼 · 本地服务已启动")
        print("  %s" % url)
        print("  根目录 %s" % ROOT)
        print("  已禁用缓存（no-store）；.mjs/.js 均按 JS 类型返回")
        print("  按 Ctrl+C 停止")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())
