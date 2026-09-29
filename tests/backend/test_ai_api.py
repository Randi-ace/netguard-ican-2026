#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
AI风险检测API测试脚本
用于验证Flask后端AI检测功能是否正常工作
"""

import requests
import json

def test_ai_api():
    """测试AI检测API"""
    api_url = "http://127.0.0.1:5000/ai/check"
    
    test_cases = [
        {"text": "恭喜您中奖了！点击领取奖品", "expected_risk": "high"},
        {"text": "刷单兼职，轻松日入300元", "expected_risk": "high"},
        {"text": "请转账到银行卡：6222888812345678", "expected_risk": "high"},
        {"text": "验证码已发送，请输入验证码", "expected_risk": "high"},
        {"text": "高收益投资，稳赚不赔", "expected_risk": "high"},
        {"text": "客服您好，我要退款", "expected_risk": "medium"},
        {"text": "点击查看详情", "expected_risk": "low"},
        {"text": "这是一段正常的内容，不包含风险", "expected_risk": "safe"},
    ]
    
    print("🤖 开始测试AI检测API...\n")
    
    passed = 0
    failed = 0
    
    for i, test_case in enumerate(test_cases):
        try:
            response = requests.post(
                api_url,
                data=json.dumps({"text": test_case["text"]}),
                headers={"Content-Type": "application/json"},
                timeout=5
            )
            
            if response.status_code == 200:
                result = response.json()
                actual_risk = result.get("risk", "unknown")
                score = result.get("score", 0.0)
                reason = result.get("reason", "")
                
                status = "✅" if actual_risk == test_case["expected_risk"] else "❌"
                if actual_risk == test_case["expected_risk"]:
                    passed += 1
                else:
                    failed += 1
                
                print(f"{status} 测试用例 {i+1}:")
                print(f"   文本: {test_case['text']}")
                print(f"   预期风险: {test_case['expected_risk']}")
                print(f"   实际风险: {actual_risk}")
                print(f"   风险评分: {score:.2f}")
                print(f"   检测原因: {reason}")
                print()
            else:
                print(f"❌ 测试用例 {i+1}: HTTP错误 {response.status_code}")
                failed += 1
                
        except requests.exceptions.RequestException as e:
            print(f"❌ 测试用例 {i+1}: 请求失败 - {str(e)}")
            failed += 1
    
    print("=" * 50)
    print(f"测试结果: 通过 {passed} / 失败 {failed}")
    
    if failed == 0:
        print("🎉 AI检测API测试全部通过！")
    else:
        print("⚠️ 部分测试失败，请检查Flask后端服务")
    
    return failed == 0

if __name__ == "__main__":
    test_ai_api()