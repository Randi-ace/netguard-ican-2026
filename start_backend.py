import sys
import os

# 添加backend目录到Python路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'backend'))

if __name__ == '__main__':
    from app import app
    app.run(host="127.0.0.1", port=5000, debug=True)