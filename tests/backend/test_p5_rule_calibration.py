"""P5 Rule Calibration v2 回归测试。

覆盖内容规则层（backend/services/ai_service.py）的教育语境识别、否定语义、
风险提示包装与诈骗行为组合。测试只依赖标准库与 AIService 本身，不连接
数据库，也不依赖模型产物。
"""

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[2]
AI_SERVICE_PATH = PROJECT_ROOT / 'backend' / 'services' / 'ai_service.py'
AI_SERVICE_SPEC = importlib.util.spec_from_file_location(
    'p5_rule_calibration_ai_service',
    AI_SERVICE_PATH,
)
AI_SERVICE_MODULE = importlib.util.module_from_spec(AI_SERVICE_SPEC)
AI_SERVICE_SPEC.loader.exec_module(AI_SERVICE_MODULE)
AIService = AI_SERVICE_MODULE.AIService


class P5RuleCalibrationTestCase(unittest.TestCase):
    """教育语境不得误报，真实诈骗行为不得漏报。"""

    def setUp(self):
        with patch.object(AIService, 'load_model'):
            self.service = AIService()

    def analyze(self, text):
        return self.service.analyze_text(text)

    def assert_not_high(self, text):
        result = self.analyze(text)
        self.assertNotEqual(
            result['risk'],
            'high',
            msg=f'{text} 不应判定为高风险 -> {result}',
        )
        self.assertLess(result['score'], 0.95)

    def assert_high(self, text):
        result = self.analyze(text)
        self.assertEqual(
            result['risk'],
            'high',
            msg=f'{text} 应判定为高风险 -> {result}',
        )
        self.assertEqual(result['score'], 0.95)

    def assert_medium(self, text, reason=None):
        result = self.analyze(text)
        self.assertEqual(
            result['risk'],
            'medium',
            msg=f'{text} 应判定为中风险 -> {result}',
        )
        self.assertEqual(result['score'], 0.65)
        if reason is not None:
            self.assertEqual(result['reason'], reason)

    def assert_not_safe(self, text):
        result = self.analyze(text)
        self.assertNotEqual(
            result['risk'],
            'safe',
            msg=f'{text} 不应判定为安全 -> {result}',
        )
        self.assertIn(result['risk'], ('medium', 'high'))
        self.assertGreaterEqual(result['score'], 0.65)

    # 1. 反诈知识自然表达 → 非 high
    def test_anti_fraud_knowledge_is_not_high(self):
        cases = (
            '学习反诈知识，了解诈骗案例，提高防骗意识',
            '本页面用于展示网络安全知识和防诈骗宣传内容',
            '警方提醒谨防钓鱼网站和诈骗短信，请通过官方渠道核实信息',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_not_high(text)

    # 2. 诈骗案例自然表达 → 非 high
    def test_scam_case_narration_is_not_high(self):
        cases = (
            '本文介绍一起典型的电信网络诈骗案例，提醒大家提高警惕',
            '学校开展防范电信网络诈骗主题讲座，介绍常见钓鱼网站案例',
            '网络安全课程介绍常见诈骗类型，包括刷单、退款和冒充客服',
            '反诈宣传提示如果有人要求转账到安全账户应立即停止操作并报警',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_not_high(text)

    # 3. 中奖诈骗案例分析 → 非 high
    def test_prize_scam_case_analysis_is_not_high(self):
        cases = (
            '中奖诈骗案例分析',
            '本文介绍中奖诈骗案例',
            '中奖诈骗案例分析：识别骗局，谨防受骗',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_not_high(text)

    # 4. 正常退款 → medium
    def test_normal_refund_business_is_medium(self):
        cases = (
            '联系客服申请商品退款',
            '售后退款流程',
            '联系客服申请退款',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_medium(
                    text,
                    reason='检测到客服相关内容，需谨慎',
                )

    # 5. 退款诈骗组合 → high
    def test_refund_scam_combinations_are_high(self):
        cases = (
            '客服要求提供验证码才能退款',
            '客服称您的订单退款失败，需要立即填写银行卡号和短信验证码',
            '退款需要先支付手续费',
            '退款需要屏幕共享',
            '退款失败需要解冻账户',
            '客服称您的订单退款失败，需要立即填写银行卡号、支付密码和短信验证码，才能完成退款到账。',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_high(text)

    # 6. 否定语义不得删除风险证据 → high
    def test_coercive_negation_is_high(self):
        cases = (
            '不提供验证码就无法退款',
            '不提供银行卡就无法完成退款',
            '如果不转账就无法解冻账户',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_high(text)

    # 7. 风险提示包装不得降低风险 → high
    def test_risk_warning_wrapper_is_high(self):
        cases = (
            '风险提示：恭喜中奖，点击领取大奖',
            '安全提示：恭喜您中奖，请点击链接领取奖金',
            '温馨提示：您的账户异常，请立即转账至安全账户',
            '风险提示：客服要求提供验证码完成退款',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_high(text)

    # 8. 正常安全提示 → 非 high
    def test_safe_guidance_is_not_high(self):
        cases = (
            '银行安全提示：请勿向陌生人提供验证码和银行卡信息',
            '请不要提供验证码给陌生人',
            '银行安全中心提醒不要向任何人透露短信验证码',
            '请勿轻信陌生人的转账要求并注意保护个人信息',
            '警方提醒：不要向陌生账户转账，如有疑问请核实官方渠道',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_not_high(text)

    # 附加：真实诈骗行为必须保持 high（防止校准过度导致漏报）
    def test_real_scams_stay_high(self):
        cases = (
            '验证码已发送，请输入验证码',
            '请转账到银行卡：6222888812345678',
            '刷单兼职，轻松日入300元',
            '高收益投资，稳赚不赔',
            '恭喜您中奖了！点击领取奖品',
            '请立即转账至安全账户，否则账户将被冻结',
            '恭喜您获得高额中奖奖励，请立即点击陌生链接领取奖金，并填写银行卡信息和短信验证码完成领取。',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_high(text)

    # 附加：普通内容与诱导点击不得升级为 high
    def test_neutral_content_is_not_high(self):
        cases = (
            '这是一段正常的内容，不包含风险',
            '海南大学计算机学院发布本周课程安排和实验室开放时间',
            '净网护航能够检测诈骗钓鱼恶意链接和危险转账诱导信息',
            '点击查看详情',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_not_high(text)

    # 附加：单个风险名词不足以判定 high
    def test_single_topic_keyword_is_not_high(self):
        cases = (
            '诈骗',
            '中奖',
            '退款',
            '验证码',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_not_high(text)

    # 9. 教育语境只能降低风险话题误报，不得把词表级非法内容降为 safe
    def test_education_context_does_not_lower_illegal_content_to_safe(self):
        cases = (
            '反诈宣传：赌博平台 真人娱乐 投注 返水',
            '反诈宣传：色情直播 裸聊 成人视频',
            '反诈宣传：稳赚不赔 保本保息 内幕消息',
            '反诈宣传：木马病毒 钓鱼网站 洗钱',
            '学习防骗知识：赌博网站 百家乐 老虎机 真人娱乐',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_not_safe(text)

    # 9b. 词表级非法内容在教育语境下封顶 medium（不升级、不落 safe）
    def test_illegal_content_with_education_context_is_medium(self):
        self.assert_medium('反诈宣传：赌博平台 真人娱乐 投注 返水')

    # 9c. 同一非法内容去掉教育语境后仍判 high（防止校准过度造成漏报）
    def test_illegal_content_without_education_context_stays_high(self):
        cases = (
            '赌博平台 真人娱乐 投注 返水',
            '色情直播 裸聊 成人视频',
            '稳赚不赔 保本保息 内幕消息',
            '木马病毒 钓鱼网站 洗钱',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_high(text)

    # 10. 教育 / 新闻 / 案例语境“描述”诈骗行为 → 非 high
    def test_narrative_description_of_scam_is_not_high(self):
        cases = (
            '诈骗分子可能冒充客服，以订单异常或退款为由，要求提供银行卡号和验证码',
            '本文介绍诈骗案例，骗子要求受害者提供验证码',
            '警方提醒，诈骗人员会诱导用户转账',
            '反诈宣传：诈骗分子会要求受害者提供银行卡号和验证码',
            '新闻报道：诈骗团伙诱导用户转账到安全账户，客服要求提供验证码',
            (
                '反诈教育 常见诈骗手法 诈骗分子可能冒充客服，以订单异常或退款为由，'
                '要求提供银行卡号和验证码。遇到此类情况应立即挂断并拨打官方电话核实。'
            ),
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_not_high(text)

    # 10b. 描述之外的“真实指令”不得被叙事识别削弱 → high
    def test_imperative_requests_stay_high_with_narrative_support(self):
        cases = (
            '客服要求提供验证码完成退款',
            '请提供银行卡号完成退款',
            '立即转账到安全账户',
            '客服要求提供验证码，骗子常这样做',
            '诈骗团伙要求转账验证码',
            '您的账户异常，如有疑问请联系客服，否则账户将被冻结',
            '如果不转账就无法解冻账户',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_high(text)

    # 11. 安全否定句（不会要求 / 不会索要 …）→ 非 high
    def test_safety_negation_phrases_are_not_high(self):
        cases = (
            '正规平台不会索要短信验证码，也不会要求向所谓“安全账户”转账。',
            '银行不会要求客户提供短信验证码',
            '请勿向陌生人转账或提供验证码',
            '我们不会要求您向任何账户转账',
            '平台不会索要您的验证码',
            '不应提供验证码',
            '不得转账',
            '无需提供银行卡',
            '切勿泄露密码',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_not_high(text)

    # 11b. 否定句中的真实索取 / 胁迫式诈骗必须仍为 high
    def test_negation_context_keeps_real_requests_high(self):
        cases = (
            '客服要求提供验证码完成退款',
            '请立即转账到安全账户',
            '不提供验证码就无法退款',
            '不会退款，除非先提供验证码',
            '不转账账户就会被冻结',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_high(text)

    # 11c. 上一轮 narrative 行为锁定
    def test_narrative_context_behaviour_is_locked(self):
        self.assert_not_high(
            '诈骗分子可能冒充客服，以订单异常或退款为由，'
            '要求提供银行卡号和验证码'
        )
        self.assert_high('客服要求提供验证码完成退款')

    # 12. Stage 4 冒充官方组合：场景词必须处于 active context
    #     （被否定 / 叙事中的“安全账户”不再构成有效 scene）
    def test_impostor_scene_requires_active_context(self):
        page = (
            '这是安全教育页面，以下内容用于提醒公众防范诈骗。\n'
            '常见骗局特征\n'
            '诈骗分子可能冒充客服，以订单异常或退款为由，'
            '要求提供银行卡号和验证码。\n'
            '正规平台不会索要短信验证码，也不会要求向所谓“安全账户”转账。'
            '遇到此类情况应立即停止操作，通过官方渠道核实并报警。\n'
            '安全建议\n'
            '不要泄露银行卡和验证码。不要点击陌生客服发送的退款链接。'
            '保留证据并联系警方。\n'
            '预期：AI 理解反诈教育语境，Fusion 不应产生高风险强提醒。\n'
            '返回场景列表'
        )
        with self.subTest(case='完整反诈教育页正文'):
            self.assert_not_high(page)
        with self.subTest(case='精确残留组合'):
            self.assert_not_high(
                '正规平台不会要求向所谓“安全账户”转账。'
                '遇到此类情况应立即停止操作。'
            )

    # 12b. 真实冒充官方 / 账户异常诈骗仍必须 high
    def test_active_impostor_scams_stay_high(self):
        cases = (
            '请立即转账到安全账户',
            '客服要求向安全账户转账',
            '您的账户异常，请立即提供验证码',
            '您的账户异常，否则账户将被冻结',
        )
        for text in cases:
            with self.subTest(text=text):
                self.assert_high(text)


if __name__ == '__main__':
    unittest.main()
