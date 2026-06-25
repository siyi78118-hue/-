#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
谪仙剧本工作台 · 本地桥接服务器
作用：
  ① 用 localhost 打开网页（这样网页才能自动读写文件）
  ② 接住网页「✨ 发给 AI」投来的请求，写成  谪仙工程/请求.txt  供 Claude 读取
这样你就不用再手动复制粘贴指令了——点按钮即可，回 Claude 说一句「继续」。
纯 Python 标准库，无需安装任何东西。
用法：在本文件夹里运行   python3 bridge.py   （Windows 双击「启动桥接.bat」，Mac 双击「启动桥接.command」）
"""
import http.server, socketserver, os, webbrowser, threading

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 8765
PAGE = "谪仙剧本工作台.html"
REQ  = os.path.join(ROOT, "谪仙工程", "请求.txt")

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        # 关掉缓存，确保网页每次读到的是最新结果
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path.split("?")[0] == "/__bridge/req":
            n = int(self.headers.get("Content-Length", "0") or 0)
            body = self.rfile.read(n).decode("utf-8", "replace")
            os.makedirs(os.path.dirname(REQ), exist_ok=True)
            with open(REQ, "w", encoding="utf-8") as f:
                f.write(body)
            self.send_response(200)
            self.send_header("Content-Type", "text/plain;charset=utf-8")
            self.end_headers()
            self.wfile.write(b"ok")
            print("📨 收到一条请求，已写入「谪仙工程/请求.txt」——回到 Claude 说「继续」即可处理。")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):
        pass  # 静默，控制台只显示我们自己的提示

def main():
    os.chdir(ROOT)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://localhost:{PORT}/{PAGE}"
        print("=" * 52)
        print(" 谪仙剧本工作台 · 桥接已启动")
        print(" 网页地址： " + url)
        print(" 用法：网页里点「✨ 发给 AI」→ 回 Claude 说「继续」→ 结果自动填回")
        print(" 关掉此窗口即停止。")
        print("=" * 52)
        try:
            threading.Timer(1.0, lambda: webbrowser.open(url)).start()
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止。")

if __name__ == "__main__":
    main()
