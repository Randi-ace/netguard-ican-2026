@echo off
cd /d "%~dp0"
echo ================================================
echo 🎯 净网护航 - AI风险检测演示环境
echo ================================================
echo.

:: 检查Python是否安装
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Python未安装或未添加到PATH
    pause
    exit /b 1
)

echo 🚀 启动Flask后端服务...
start "Flask后端" cmd /k "cd backend && python app.py"

echo ⏳ 等待Flask启动...
timeout /t 3 /nobreak >nul

echo 📦 启动静态文件服务器...
start "静态文件服务器" cmd /k "python -m http.server 8080 --bind 127.0.0.1"

echo.
echo ✅ 演示环境已启动！
echo ------------------------------------------------
echo 🌐 Flask后端: http://127.0.0.1:5000
echo 📄 演示中心: http://127.0.0.1:8080/demos/demo_center.html
echo 📊 统计后台: http://127.0.0.1:8080/UI/index.html
echo 📢 广告演示: http://127.0.0.1:8080/demos/ads/demo_ads.html
echo ------------------------------------------------
echo 按任意键打开演示页面...
pause >nul
start http://127.0.0.1:8080/demos/demo_center.html
