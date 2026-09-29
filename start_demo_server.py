#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
启动演示服务器
同时启动Flask后端和静态文件服务器
"""

import os
import sys
import subprocess
import time

def start_flask():
    """启动Flask后端服务"""
    flask_dir = os.path.join(os.path.dirname(__file__), 'backend')
    print("🚀 启动Flask后端服务...")
    flask_proc = subprocess.Popen(
        [sys.executable, 'app.py'],
        cwd=flask_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True
    )
    return flask_proc

def start_static_server():
    """启动静态文件服务器"""
    demo_dir = os.path.dirname(__file__)
    print("📦 启动静态文件服务器...")
    
    # 使用Python内置的http.server
    static_proc = subprocess.Popen(
        [sys.executable, '-m', 'http.server', '8080', '--bind', '127.0.0.1'],
        cwd=demo_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True
    )
    return static_proc

def main():
    print("=" * 50)
    print("🎯 净网护航 - AI风险检测演示环境")
    print("=" * 50)
    
    # 启动Flask后端
    flask_proc = start_flask()
    
    # 等待Flask启动
    time.sleep(3)
    
    # 启动静态文件服务器
    static_proc = start_static_server()
    
    print("\n✅ 演示环境已启动！")
    print("-" * 50)
    print("🌐 Flask后端: http://127.0.0.1:5000")
    print("📄 演示中心: http://127.0.0.1:8080/demos/demo_center.html")
    print("📊 统计后台: http://127.0.0.1:8080/UI/index.html")
    print("📢 广告演示: http://127.0.0.1:8080/demos/ads/demo_ads.html")
    print("-" * 50)
    print("按 Ctrl+C 停止服务")
    
    try:
        # 保持服务器运行
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n🛑 正在停止服务...")
        flask_proc.terminate()
        static_proc.terminate()
        print("✅ 服务已停止")

if __name__ == "__main__":
    main()
