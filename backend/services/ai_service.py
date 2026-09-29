import os
import re


class AIService:
    """内容规则层：把网页文本转换成 risk / score / reason。

    Rule Calibration v2 的四条设计原则：

    1. 行为优先
       只有出现“索取 / 胁迫 / 诱导”这类风险行为证据才会升到 high；
       单个风险名词（诈骗、中奖、退款、验证码……）不再直接判 high。
    2. 语境消解
       教育、宣传、案例讲解等语境可以降低“讲风险”的文本，
       但不能降低已经出现的风险行为，“风险提示：”不能成为绕过机制。
    3. 否定语义保留
       不再删除否定短语，而是按位置标记否定区间：
       “请不要提供验证码给陌生人”属于劝阻语义；
       “不提供验证码就无法退款”属于胁迫语义，仍然判 high。
    4. 只依赖标准库
       本层不读取模型产物，AI 模型缺失时可独立工作。
    5. 演示预设与正式检测分离
       演示页文件名的预设风险（demo_page_risk）只能通过显式演示入口
       读取，正式检测 analyze_text() 只依据正文内容判定。
    """

    # ==================== 归一化 ====================
    ZERO_WIDTH_PATTERN = re.compile('[\u200b\u200c\u200d\ufeff]')
    ATOMIC_BOUNDARIES = '。．.，,；;：:！!？?、()（） \t\r\n'
    BOUNDARY_PATTERN = re.compile('[' + ATOMIC_BOUNDARIES + ']')
    # 同一子句内的任意字符，用于限定窗口，避免跨句匹配
    GAP = '[^' + ATOMIC_BOUNDARIES + ']'

    # ==================== 语境特征 ====================
    # 宣教与叙事：说明文本在“讲风险”，而不是在“做风险”
    NARRATIVE_TERMS = (
        '反诈', '防骗', '防诈骗', '防范', '警惕', '谨防', '科普', '宣传',
        '教育', '讲座', '课程', '课堂', '培训', '知识', '指南', '手册',
        '教程', '普法', '案例', '介绍', '讲解', '分析', '剖析', '揭秘',
        '曝光', '学习', '了解', '认识', '识别', '话术', '手法', '套路',
    )
    # 提醒口吻：提醒读者防范风险
    GUIDE_TONE_TERMS = (
        '提醒', '提示', '注意', '谨记', '牢记', '建议', '务必', '请勿',
        '切勿', '不要', '避免', '防止', '小心', '谨慎', '拒绝', '意识',
        '保护', '核实', '报警', '举报', '停止',
    )
    # 权威主体：警方、银行、官方等发布方
    AUTHORITY_TERMS = (
        '警方', '公安', '警察', '银行', '官方', '政府', '国家反诈',
        '安全中心', '反诈中心', '社区', '学校', '学院', '大学',
    )
    # 旁观叙事主体（案件、新闻、教育描述“别人如何行骗”），
    # 用于区分“描述风险行为”和“实施索取行为”。
    # 说明：这里刻意不包含“如果 / 若 / 一旦”等假设连词，避免把
    # “如有疑问请联系客服，否则账户将被冻结”这类真实通知误判为描述。
    NARRATIVE_MARKERS = (
        '案例', '新闻', '报道', '通报', '讲述', '遭遇', '被骗', '受害人',
        '受害者', '骗子', '诈骗分子', '不法分子', '嫌疑人', '某人',
        '某市民', '他人', '别人', '有人', '对方',
    )

    # ==================== 行为特征 ====================
    ACTION_VERBS = (
        '提供', '输入', '填写', '告知', '发送', '转发', '上传', '上报',
        '截图', '拍照', '扫码', '扫描', '下载', '安装', '共享', '开启',
        '转账', '汇款', '打钱', '支付', '付款', '缴纳', '充值', '入金',
        '点击', '领取', '添加', '联系', '验证', '配合', '解冻', '透露',
        '泄露', '绑定', '轻信', '相信', '操作', '进行',
    )
    ACTION_VERB_PATTERN = '|'.join(ACTION_VERBS)
    # 否定前视专用：请求类动词（要求 / 索要 …）只用于建立否定区间。
    # 刻意不并入 ACTION_VERBS，避免改变 COERCION_PATTERN 等既有规则语义。
    NEGATION_REQUEST_VERBS = (
        '索要', '索取', '要求', '收取', '询问', '打听', '骗取', '诱导',
        '引导', '催促',
    )
    NEGATION_VERB_PATTERN = '|'.join(
        ACTION_VERBS + NEGATION_REQUEST_VERBS
    )
    # 指令索取只认“索取类”动作；安全动作（停止 / 报警 / 核实）不算索取
    DEMAND_VERBS = (
        '提供', '输入', '填写', '告知', '发送', '转发', '上传', '上报',
        '截图', '拍照', '扫码', '扫描', '下载', '安装', '共享', '开启',
        '转账', '汇款', '打钱', '支付', '付款', '缴纳', '充值', '入金',
        '点击', '领取', '添加', '联系', '验证', '配合', '解冻', '透露',
        '泄露', '绑定',
    )
    DEMAND_VERB_PATTERN = '|'.join(DEMAND_VERBS)
    SAFETY_ACTION_TERMS = (
        '停止', '报警', '举报', '核实', '挂断', '删除', '退出', '关闭',
        '拉黑',
    )

    NEGATION_TOKENS = (
        '不要', '请勿', '切勿', '无需', '不需要', '不必', '不会', '不用',
        '不得', '不能', '勿', '别', '避免', '防止', '拒绝', '谨防',
        '警惕', '小心', '严禁', '禁止', '不', '未', '没有',
    )
    # 否定触发：否定词后 0~6 字内必须出现行为动词（含请求类动词），
    # 避免“不同 / 不仅”误判
    NEGATION_PATTERN = re.compile(
        '(?:' + '|'.join(NEGATION_TOKENS) + ')'
        + '(?=' + GAP + '{0,6}(?:' + NEGATION_VERB_PATTERN + '))'
    )
    # 否定区间长度：同一子句内的劝阻语义覆盖其后内容；
    # 仍由 BOUNDARY_PATTERN 截断，不跨越 ，。；！？
    NEGATION_WINDOW = 24

    DEMAND_CUES = (
        '请', '立即', '马上', '尽快', '务必', '必须', '需要', '要求',
        '否则', '才能', '即可',
    )
    # 指令式索取：“请 / 立即 / 需要 …… 提供 / 转账 / 点击”
    DEMAND_PATTERN = re.compile(
        '(?:' + '|'.join(DEMAND_CUES) + ')'
        + GAP + '{0,8}'
        + '(?:' + DEMAND_VERB_PATTERN + ')'
    )
    # 直接索取凭证：“提供 / 填写 …… 验证码 / 银行卡”
    CREDENTIAL_DEMAND_PATTERN = re.compile(
        '(?:提供|输入|填写|告知|发送|转发|上传|截图|拍照|透露|泄露|验证|绑定|解冻)'
        + GAP + '{0,10}'
        + '(?:验证码|密码|银行卡|卡号|身份证|安全账户|账户信息|个人信息)'
    )
    # 资金动作：“转账 / 支付 …… 安全账户 / 手续费”
    PAYMENT_PATTERN = re.compile(
        '(?:转账|汇款|打钱|支付|付款|缴纳|充值|入金)'
        + GAP + '{0,10}'
        + '(?:安全账户|指定账户|银行卡|账户|元|手续费|保证金|解冻|资金)'
    )
    BANK_CARD_PATTERN = re.compile(r'\d[\d\s-]{11,}\d')
    # 胁迫式否定：“不提供验证码就无法退款”
    COERCION_PATTERN = re.compile(
        '(?:不|未|没有|拒绝)'
        + GAP + '{0,8}'
        + '(?:' + ACTION_VERB_PATTERN + ')'
        + GAP + '{0,6}'
        + '(?:就|否则|不然|将|会)'
        + GAP + '{0,8}'
        + '(?:无法|不能|不可以|冻结|失效|取消|拿不到|收不到|退回|永久)'
    )
    # 后果要挟：“否则账户将被冻结”
    THREAT_PATTERN = re.compile(
        '(?:否则|不然|将|会)'
        + GAP + '{0,8}'
        + '(?:冻结|注销|封号|失效|无法|不能|永久|起诉|征信|扣款|拉黑)'
    )
    # 句级边界：旁观叙事作用域从叙事标记向后传播到句末，不跨句号
    SENTENCE_BOUNDARIES = '。．！!？?；;\n\r'

    # ==================== 风险词表 ====================
    SCENE_REFUND_TERMS = (
        '退款', '退货', '售后', '理赔', '订单', '客服', '退款失败', '解冻',
    )
    EVIDENCE_REFUND_TERMS = (
        '验证码', '密码', '银行卡', '卡号', '身份证', '安全账户',
        '转账', '汇款', '打钱', '支付', '付款', '缴纳', '手续费',
        '保证金', '屏幕共享', '共享屏幕', '扫码', '下载', '解冻', '账户信息',
    )
    SCENE_PRIZE_TERMS = (
        '中奖', '大奖', '抽奖', '奖品', '奖金', '红包', '免费领取',
        '领取资格', '幸运用户', '幸运',
    )
    EVIDENCE_PRIZE_TERMS = (
        '领取', '领奖', '点击', '链接', '付款', '支付', '手续费', '税费',
        '保证金', '验证码', '银行卡', '扫码', '填写', '联系客服', '添加客服',
        '加微信', '加qq',
    )
    SCENE_IMPOSTOR_TERMS = (
        '账户异常', '账户存在异常', '异常登录', '异地登录', '安全中心',
        '身份验证', '实名认证', '账户冻结', '账号冻结', '冻结', '解冻',
        '安全账户', '资金转入',
    )
    EVIDENCE_IMPOSTOR_TERMS = (
        '转账', '汇款', '资金转入', '安全账户', '验证码', '密码', '银行卡',
        '否则', '立即', '永久', '处理',
    )
    GAMBLING_TERMS = (
        '赌博', '博彩', '赌场', '赌球', 'casino', 'gambling', 'bet',
        '六合彩', '时时彩', '娱乐城', '真人娱乐', '老虎机', '百家乐',
        '轮盘', '体育投注', '投注', '下注', '押注', '彩金', '返水',
    )
    ADULT_TERMS = (
        '色情', '裸聊', '卖淫', '嫖娼', '性服务', '成人视频', '成人电影',
        '黄色网站', '约炮',
    )
    ILLEGAL_MISC_TERMS = (
        '钓鱼网站', '钓鱼链接', '木马', '勒索病毒', '恶意软件', '假冒网站',
        '洗钱',
    )
    BRUSH_ORDER_TERMS = ('刷单', '刷信誉', '网络刷单')
    BRUSH_RECRUIT_TERMS = (
        '兼职', '日结', '日入', '返利', '垫付', '佣金', '赚钱', '轻松',
        '高薪', '加微信', '加qq', '私聊',
    )
    INVEST_CLAIM_TERMS = (
        '稳赚不赔', '保本保息', '保本保收益', '保底收益', '保证收益',
        '内部消息', '内幕消息', '原始股', '投资返利', '高额返利', '躺赚',
    )

    STRONG_CREDENTIAL_TERMS = (
        '验证码', '银行卡', '卡号', '身份证', '安全账户', '账户信息',
        '个人信息',
    )
    # “密码”单独出现（登录框等）风险不足，需要伴随其他风险信号
    WEAK_CREDENTIAL_TERMS = ('密码',)
    PASSWORD_COMPANION_TERMS = (
        '退款', '退货', '售后', '客服', '账户异常', '冻结', '解冻',
        '转账', '汇款', '安全账户', '银行卡', '验证码', '链接', '否则',
        '异地登录', '登录异常',
    )
    FUND_OBJECT_TERMS = (
        '转账', '汇款', '打钱', '支付', '付款', '缴纳', '充值', '入金',
        '手续费', '保证金', '安全账户',
    )
    # 风险话题名词：只说明文本“谈到风险”，不足以判 high
    TOPIC_TERMS = (
        '诈骗', '欺骗', '欺诈', '骗钱', '骗局', '钓鱼', '假冒', '冒充',
        '冻结', '账户异常', '紧急通知', '安全中心', '中奖', '大奖', '领取',
        '验证码', '密码', '银行卡', '转账', '汇款', '手续费', '屏幕共享',
        '解冻', '刷单', '返利', '高收益', '投资', '理财', '个人信息',
    )
    BUSINESS_RULES = (
        {
            'terms': ('客服', '退款', '退货', '售后'),
            'reason': '检测到客服相关内容，需谨慎',
        },
        {
            'terms': ('理财', '投资', '股票', '基金', '贷款', '征信'),
            'reason': '检测到金融投资内容',
        },
        {
            'terms': ('红包', '优惠券', '折扣', '特价', '促销', '限时特惠'),
            'reason': '检测到促销优惠内容',
        },
        {
            'terms': ('兼职', '副业', '赚钱', '日结', '招聘'),
            'reason': '检测到兼职招聘内容',
        },
    )
    LOW_TERMS = ('点击', '领取', '查看', '详情')

    HIGH_SCORE = 0.95
    MEDIUM_SCORE = 0.65
    LOW_SCORE = 0.35
    SAFE_SCORE = 0.05
    EMPTY_SCORE = 0.01

    def __init__(self):
        self.model_loaded = False
        self.load_model()

        # 演示页面风险等级映射（保持既有兼容行为）
        self.demo_page_risk = {
            'safe.html': {'risk': 'safe', 'score': 0.05, 'reason': '安全内容，无风险因素'},
            'low.html': {'risk': 'low', 'score': 0.25, 'reason': '检测到轻微营销推广内容'},
            'medium.html': {'risk': 'medium', 'score': 0.55, 'reason': '检测到金融投资相关内容，需谨慎'},
            'high.html': {'risk': 'high', 'score': 0.90, 'reason': '检测到诈骗风险内容'}
        }

    def load_model(self):
        model_path = "models/ai_text_classifier.ftz"
        if os.path.exists(model_path):
            self.model_loaded = True
            print("[OK] FastText 模型已加载")
        else:
            print("[INFO] 未找到模型，使用关键词规则检测")

    def analyze_text(self, text):
        if not text or len(text.strip()) == 0:
            return {
                "risk": "safe",
                "score": self.EMPTY_SCORE,
                "reason": "文本为空"
            }

        # 正式检测只依据正文内容；演示页文件名预设值必须通过
        # analyze_demo_page() 显式获取，避免文件名改变真实风险判断。
        text_lower = self._normalize(text)
        risk, score, reason = self._classify_content(text_lower)
        return {
            "risk": risk,
            "score": score,
            "reason": reason,
        }

    def analyze_demo_page(self, text):
        """显式演示入口：按页面文件名返回预设风险，未命中返回 None。

        仅用于演示展示与兼容调用方；正式检测链路（analyze_text）不调用
        本方法，因此文件名无法覆盖真实文本的风险判断。
        """
        if not text:
            return None

        text_lower = self._normalize(text)
        for page, risk_info in self.demo_page_risk.items():
            if page in text_lower:
                print(f"📋 检测到演示页面: {page}，返回预设风险: {risk_info['risk']}")
                return dict(risk_info)
        return None

    # ==================== 规则判定 ====================

    @classmethod
    def _classify_content(cls, text):
        """按“风险行为 → 语境 → 普通业务 → 话题名词 → 诱导点击”顺序判定。"""
        negation_spans = cls._negation_spans(text)
        narrative_spans = cls._narrative_spans(text)
        education_context = cls._is_education_context(text)

        # 1. 胁迫式否定：“不提供验证码就无法退款”
        if cls.COERCION_PATTERN.search(text):
            return ('high', cls.HIGH_SCORE, '检测到胁迫性索取行为')

        # 2. 退款 / 客服诈骗组合
        if (
            cls._matched(text, cls.SCENE_REFUND_TERMS)
            and cls._has_active_evidence(
                text, cls.EVIDENCE_REFUND_TERMS, negation_spans, narrative_spans
            )
        ):
            return ('high', cls.HIGH_SCORE, '检测到退款诈骗行为')

        # 3. 中奖 / 领取诈骗组合
        if (
            cls._matched(text, cls.SCENE_PRIZE_TERMS)
            and cls._has_active_evidence(
                text, cls.EVIDENCE_PRIZE_TERMS, negation_spans, narrative_spans
            )
        ):
            return ('high', cls.HIGH_SCORE, '检测到中奖诈骗行为')

        # 4. 冒充官方 / 账户异常组合
        #    场景词与行为证据都必须处于 active context：位于 negation_spans
        #    或 narrative_spans 中的场景词（如被否定的“安全账户”）不再构成
        #    当前组合的有效 scene。
        threat = cls.THREAT_PATTERN.search(text)
        if cls._has_active_evidence(
            text, cls.SCENE_IMPOSTOR_TERMS, negation_spans, narrative_spans
        ) and (
            cls._has_active_evidence(
                text, cls.EVIDENCE_IMPOSTOR_TERMS, negation_spans,
                narrative_spans
            )
            or (threat and not cls._in_spans(threat.start(), narrative_spans))
        ):
            return ('high', cls.HIGH_SCORE, '检测到冒充官方诈骗')

        # 5. 资金 / 凭证索取指令（索取对象必须与指令出现在同一子句）
        for clause in cls._active_demand_clauses(
            text, negation_spans, narrative_spans
        ):
            clause_spans = cls._negation_spans(clause)
            if cls._matched(clause, cls.FUND_OBJECT_TERMS, clause_spans):
                return ('high', cls.HIGH_SCORE, '检测到可疑转账请求')
            if cls._active_credentials(clause, clause_spans):
                return ('high', cls.HIGH_SCORE, '检测到敏感信息请求')
        if cls.BANK_CARD_PATTERN.search(text):
            return ('high', cls.HIGH_SCORE, '检测到可疑转账请求')

        # 6. 无歧义非法内容：无教育语境判 high；教育语境只能降到 medium
        illegal_reason = cls._illegal_content_reason(text)
        if illegal_reason and not education_context:
            return ('high', cls.HIGH_SCORE, illegal_reason)

        business_reason = cls._business_reason(text)
        topic_matched = cls._matched(text, cls.TOPIC_TERMS, negation_spans)

        # 7. 教育 / 宣传语境：只消解“话题名词”和词表级非法内容，
        #    不掩盖已判定的风险行为，也不允许降到 safe。
        if education_context and (
            illegal_reason or business_reason or topic_matched
        ):
            return ('medium', cls.MEDIUM_SCORE, '检测到安全宣传/教育语境')

        # 8. 普通业务场景
        if business_reason:
            return ('medium', cls.MEDIUM_SCORE, business_reason)

        # 9. 仅出现风险话题名词
        if topic_matched:
            return ('medium', cls.MEDIUM_SCORE, '检测到疑似风险话题内容')

        # 10. 诱导点击
        if cls._matched(text, cls.LOW_TERMS, negation_spans):
            return ('low', cls.LOW_SCORE, '检测到诱导点击内容')

        return ('safe', cls.SAFE_SCORE, '未发现风险内容')

    # ==================== 工具方法 ====================

    @classmethod
    def _normalize(cls, text):
        return cls.ZERO_WIDTH_PATTERN.sub('', text).lower()

    @classmethod
    def _negation_spans(cls, text):
        """返回否定区间；区间不跨子句，避免跨句误消解。"""
        spans = []
        for match in cls.NEGATION_PATTERN.finditer(text):
            end = min(len(text), match.end() + cls.NEGATION_WINDOW)
            boundary = cls.BOUNDARY_PATTERN.search(text, match.end(), end)
            if boundary:
                end = boundary.start()
            spans.append((match.start(), end))
        return spans

    @staticmethod
    def _in_spans(position, spans):
        return any(start <= position < end for start, end in spans)

    @classmethod
    def _matched(cls, text, terms, blocked_spans=()):
        """返回命中且未被否定区间覆盖的词集合（不删除原文）。"""
        matched = set()
        for term in terms:
            position = text.find(term)
            while position != -1:
                if not cls._in_spans(position, blocked_spans):
                    matched.add(term)
                    break
                position = text.find(term, position + 1)
        return matched

    @classmethod
    def _evidence_positions(cls, text, terms, blocked_spans=()):
        for term in terms:
            position = text.find(term)
            while position != -1:
                if not cls._in_spans(position, blocked_spans):
                    yield position
                    break
                position = text.find(term, position + 1)

    @classmethod
    def _clause(cls, text, position):
        start = position
        while start > 0 and text[start - 1] not in cls.ATOMIC_BOUNDARIES:
            start -= 1
        end = position
        while end < len(text) and text[end] not in cls.ATOMIC_BOUNDARIES:
            end += 1
        return text[start:end]

    @classmethod
    def _narrative_spans(cls, text):
        """旁观叙事作用域：从叙事标记起，向后覆盖到句末。

        只在句内向后传播，因此“客服要求提供验证码，骗子常这样做”中的
        真实指令不会被后面的标记消解；而“骗子要求受害者提供验证码”
        这类同句描述会被识别为旁观叙事。
        """
        spans = []
        for marker in cls.NARRATIVE_MARKERS:
            start = 0
            while True:
                index = text.find(marker, start)
                if index < 0:
                    break
                start = index + len(marker)
                end = index
                while (
                    end < len(text)
                    and text[end] not in cls.SENTENCE_BOUNDARIES
                ):
                    end += 1
                spans.append((index, end))
        return spans

    @classmethod
    def _has_active_evidence(cls, text, terms, negation_spans, narrative_spans):
        """行为证据必须出现在“索取视角”，否定区间与旁观叙事都不算证据。"""
        for position in cls._evidence_positions(text, terms, negation_spans):
            if cls._in_spans(position, narrative_spans):
                continue
            return True
        return False

    @classmethod
    def _is_education_context(cls, text):
        """多特征判断：叙事特征 ≥2，或两类以上语境特征同时出现。"""
        narrative_hits = len(cls._matched(text, cls.NARRATIVE_TERMS))
        if narrative_hits >= 2:
            return True

        groups = 1 if narrative_hits else 0
        if cls._matched(text, cls.GUIDE_TONE_TERMS):
            groups += 1
        if cls._matched(text, cls.AUTHORITY_TERMS):
            groups += 1
        return groups >= 2

    @classmethod
    def _active_demand_clauses(cls, text, negation_spans, narrative_spans):
        """未被否定、也不属于旁观叙事的指令式索取所在子句。"""
        clauses = []
        for pattern in (
            cls.DEMAND_PATTERN,
            cls.CREDENTIAL_DEMAND_PATTERN,
            cls.PAYMENT_PATTERN,
        ):
            for match in pattern.finditer(text):
                if cls._in_spans(match.start(), negation_spans):
                    continue
                if cls._in_spans(match.start(), narrative_spans):
                    continue
                clause = cls._clause(text, match.start())
                if any(term in clause for term in cls.SAFETY_ACTION_TERMS):
                    continue
                clauses.append(clause)
        return clauses

    @classmethod
    def _active_credentials(cls, text, negation_spans):
        if cls._matched(text, cls.STRONG_CREDENTIAL_TERMS, negation_spans):
            return True
        if cls._matched(text, cls.WEAK_CREDENTIAL_TERMS, negation_spans):
            return bool(
                cls._matched(text, cls.PASSWORD_COMPANION_TERMS, negation_spans)
            )
        return False

    @classmethod
    def _business_reason(cls, text):
        for rule in cls.BUSINESS_RULES:
            if cls._matched(text, rule['terms']):
                return rule['reason']
        return None

    @classmethod
    def _illegal_content_reason(cls, text):
        """返回词表级非法内容的判定原因；未命中返回 None。"""
        if cls._matched(text, cls.GAMBLING_TERMS):
            return '检测到赌博相关内容'
        if cls._matched(text, cls.ADULT_TERMS):
            return '检测到色情相关内容'
        if (
            cls._matched(text, cls.BRUSH_ORDER_TERMS)
            and cls._matched(text, cls.BRUSH_RECRUIT_TERMS)
        ):
            return '检测到刷单诈骗内容'
        if cls._matched(text, cls.INVEST_CLAIM_TERMS):
            return '检测到非法集资内容'
        if cls._matched(text, cls.ILLEGAL_MISC_TERMS):
            return '检测到钓鱼攻击特征'
        return None


ai_service = AIService()
