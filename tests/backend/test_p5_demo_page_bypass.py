"""P5 演示页面文件名旁路回归测试。

验证 backend/services/ai_service.py 的正式内容检测（analyze_text）不再
依赖演示页文件名，同时演示展示能力通过 analyze_demo_page 显式保留。
测试只依赖标准库与 AIService 本身，不连接数据库。
"""

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[2]
AI_SERVICE_PATH = PROJECT_ROOT / 'backend' / 'services' / 'ai_service.py'
AI_SERVICE_SPEC = importlib.util.spec_from_file_location(
    'p5_demo_page_bypass_ai_service',
    AI_SERVICE_PATH,
)
AI_SERVICE_MODULE = importlib.util.module_from_spec(AI_SERVICE_SPEC)
AI_SERVICE_SPEC.loader.exec_module(AI_SERVICE_MODULE)
AIService = AI_SERVICE_MODULE.AIService


class DemoPageRiskBypassTestCase(unittest.TestCase):
    """文件名不得改变真实文本的风险判断。"""

    def setUp(self):
        with patch.object(AIService, 'load_model'):
            self.service = AIService()

    def analyze(self, text):
        with patch('builtins.print'):
            return self.service.analyze_text(text)

    def analyze_demo(self, text):
        with patch('builtins.print'):
            return self.service.analyze_demo_page(text)

    # 1. 正文安全但 filename=high.html → 不应直接 high
    def test_safe_content_with_demo_filename_is_not_high(self):
        cases = (
            '今天天气不错，适合出门散步 high.html',
            '本页面介绍产品使用说明 high.html medium.html',
            'demos/ai/high.html',
            'safe.html high.html',
        )
        for text in cases:
            with self.subTest(text=text):
                result = self.analyze(text)
                self.assertNotEqual(
                    result['risk'],
                    'high',
                    msg=f'{text} 不应因文件名判定为高风险 -> {result}',
                )
                # 不得返回演示预设值 0.90 / medium 预设 0.55
                self.assertNotIn(result['score'], (0.90, 0.55))

    # 2. 正文真实诈骗但 filename=safe.html → 仍应 high
    def test_scam_content_with_safe_filename_stays_high(self):
        cases = (
            '这是一个诈骗页面，要求转账并提供验证码 safe.html',
            '诈骗团伙要求转账验证码 safe.html high.html',
            '风险提示：恭喜中奖，点击领取大奖 safe.html',
            '不提供验证码就无法退款 safe.html',
        )
        for text in cases:
            with self.subTest(text=text):
                result = self.analyze(text)
                self.assertEqual(
                    result['risk'],
                    'high',
                    msg=f'{text} 仍应判定为高风险 -> {result}',
                )
                self.assertEqual(result['score'], 0.95)

    # 3. 演示展示能力保留：显式演示入口仍返回预设值
    def test_demo_entry_keeps_presets(self):
        presets = (
            ('safe.html', 'safe', 0.05),
            ('low.html', 'low', 0.25),
            ('medium.html', 'medium', 0.55),
            ('high.html', 'high', 0.90),
        )
        for filename, level, score in presets:
            with self.subTest(filename=filename):
                preset = self.analyze_demo(
                    f'http://127.0.0.1:8080/demos/ai/{filename}'
                )
                self.assertIsNotNone(preset)
                self.assertEqual(preset['risk'], level)
                self.assertEqual(preset['score'], score)

        self.assertIsNone(self.analyze_demo('普通正文，没有任何页面文件名'))
        self.assertIsNone(self.analyze_demo(''))
        self.assertIsNone(self.analyze_demo(None))

    # 4. 演示页正文仍按真实文本判定（等级不受文件名影响）
    def test_demo_page_body_is_judged_by_content(self):
        high_body = (
            '恭喜您中奖了！请立即填写银行卡号和验证码领取您的专属奖品 '
            'demos/ai/high.html'
        )
        result = self.analyze(high_body)
        self.assertEqual(result['risk'], 'high')
        self.assertEqual(result['score'], 0.95)

        safe_body = (
            '安全内容 学习资源中心 今日学习推荐 高等数学入门教程 '
            'demos/ai/safe.html'
        )
        result = self.analyze(safe_body)
        self.assertNotEqual(result['risk'], 'high')
        self.assertLess(result['score'], 0.95)

    # 5. 正式检测入口不再引用演示预设表
    def test_analyze_text_does_not_consult_demo_presets(self):
        presets = list(self.service.demo_page_risk.values())
        scores = {item['score'] for item in presets}
        self.assertEqual(scores, {0.05, 0.25, 0.55, 0.90})

        result = self.analyze('high.html')
        self.assertEqual(result['risk'], 'safe')
        self.assertEqual(result['score'], 0.05)


if __name__ == '__main__':
    unittest.main()
