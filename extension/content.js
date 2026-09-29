(async function () {
    'use strict';

    console.log('🚀 [Content Script] 已注入页面:', window.location.href);

    // ==================== 统一扩展API兼容 ====================
    // 优先使用统一封装的extensionAPI，fallback到原生API
    let extensionAPI = window.extensionAPI;
    
    // 如果未加载extension-api.js，则创建基础兼容层
    if (!extensionAPI) {
        extensionAPI = {
            storage: {
                local: {
                    get: function(keys, callback) {
                        const api = window.browser || window.chrome;
                        if (api && api.storage && api.storage.local) {
                            try {
                                api.storage.local.get(keys, callback);
                            } catch (e) {
                                console.warn('[存储API] 读取失败:', e);
                                callback && callback({});
                            }
                        } else {
                            console.warn('[存储API] storage.local不可用');
                            callback && callback({});
                        }
                    },
                    set: function(items, callback) {
                        const api = window.browser || window.chrome;
                        if (api && api.storage && api.storage.local) {
                            try {
                                api.storage.local.set(items, callback);
                            } catch (e) {
                                console.warn('[存储API] 写入失败:', e);
                                callback && callback();
                            }
                        } else {
                            console.warn('[存储API] storage.local不可用');
                            callback && callback();
                        }
                    }
                },
                get onChanged() {
                    const api = window.browser || window.chrome;
                    return api?.storage?.onChanged || null;
                }
            },
            runtime: {
                sendMessage: function(msg, callback) {
                    const api = window.browser || window.chrome;
                    if (api && api.runtime && api.runtime.sendMessage) {
                        try {
                            api.runtime.sendMessage(msg, callback);
                        } catch (e) {
                            console.warn('[运行时API] 发送消息失败:', e);
                            callback && callback(null);
                        }
                    } else {
                        console.warn('[运行时API] sendMessage不可用');
                        callback && callback(null);
                    }
                },
                getURL: function(path) {
                    const api = window.browser || window.chrome;
                    if (api && api.runtime && api.runtime.getURL) {
                        try {
                            return api.runtime.getURL(path);
                        } catch (e) {
                            console.warn('[运行时API] 获取URL失败:', e);
                            return path;
                        }
                    }
                    console.warn('[运行时API] getURL不可用');
                    return path;
                },
                get onMessage() {
                    const api = window.browser || window.chrome;
                    return api?.runtime?.onMessage || null;
                }
            }
        };
    }
    
    // 将extensionAPI暴露到全局作用域，供页面脚本使用
    window.extensionAPI = extensionAPI;

    // ==================== 广告拦截模式管理 ====================
    let adBlockMode = 'normal'; // normal, strict
    let protectionPaused = false;
    let siteWhitelist = [];
    let childWhitelist = [];
    let elderModeEnabled = false;
    let childModeEnabled = false;
    let isChildMode = false;
    let childModeSettings = null;
    let childBrowsingLimitState = null;
    let activeChildPolicyKey = null;
    let currentMode = 'normal';
    let riskObserver = null;
    let riskHighlightTimer = null;
    let elderDemoTimer = null;
    let childBrowsingReminderTimer = null;
    const elderRiskOriginalTitles = new Map();
    const elderRiskLoggedElements = new WeakSet();
    const CHILD_POLICY_DEFAULTS = Object.freeze({
        dangerousFilter: true,
        entertainmentLimit: true,
        learningMode: false
    });
    const IS_TOP_FRAME = window.top === window;
    const COMPAT_SCORE_FIELD = ['risk', 'score'].join('_');
    const RUNTIME_SETTINGS_KEYS = [
        'netguardSettings', 'modeSettings', 'adMode', 'adBlockMode',
        'elderMode', 'childMode', 'elderSettings', 'childSettings',
        'protectionPaused', 'paused', 'whitelist', 'siteWhitelist',
        'childBrowsingReminderState',
    ];

    function unifiedSettingChanged(changes, key) {
        const change = changes.netguardSettings || changes.modeSettings;
        if (!change) return false;
        return change.oldValue?.[key] !== change.newValue?.[key];
    }

    function storageValueChanged(change) {
        if (!change) return false;
        try {
            return JSON.stringify(change.oldValue) !== JSON.stringify(change.newValue);
        } catch (_) {
            return change.oldValue !== change.newValue;
        }
    }

    function normalizeHost(value) {
        try {
            const raw = String(value || '').trim().toLowerCase();
            if (!raw) return '';
            const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
            return parsed.hostname.replace(/^www\./, '');
        } catch (_) {
            return String(value || '').trim().toLowerCase()
                .replace(/^https?:\/\//, '')
                .split('/')[0]
                .replace(/^www\./, '');
        }
    }

    function isCurrentSiteWhitelisted() {
        const currentHost = normalizeHost(window.location.href);
        return Boolean(currentHost) && siteWhitelist.some(item => {
            const allowedHost = normalizeHost(item);
            return allowedHost && (currentHost === allowedHost || currentHost.endsWith(`.${allowedHost}`));
        });
    }

    function shouldSkipProtection() {
        return protectionPaused || isCurrentSiteWhitelisted();
    }

    function isCurrentSiteChildWhitelisted() {
        const currentHost = normalizeHost(window.location.href);
        return Boolean(currentHost) && childWhitelist.some(item => {
            const allowedHost = normalizeHost(item);
            return allowedHost && (
                currentHost === allowedHost ||
                currentHost.endsWith(`.${allowedHost}`)
            );
        });
    }

    function shouldSkipChildProtection() {
        return shouldSkipProtection() || isCurrentSiteChildWhitelisted();
    }

    function isChildPolicyEnabled(settingName) {
        return Boolean(
            childModeSettings?.[settingName] ??
            CHILD_POLICY_DEFAULTS[settingName]
        );
    }

    function clearChildModeUi() {
        [
            'netguard-child-overlay',
            'netguard-child-popup',
            'netguard-child-banner'
        ].forEach(id => document.getElementById(id)?.remove());
        removeChildBrowsingReminder(true);
        activeChildPolicyKey = null;
    }

    function clearProtectionWarnings() {
        if (!document) return;

        activeChildPolicyKey = null;

        [
            'netguard-risk-banner',
            'netguard-high-risk-overlay',
            'netguard-high-risk-popup',
            'netguard-child-overlay',
            'netguard-child-popup',
            'netguard-child-banner'
        ].forEach(id => document.getElementById(id)?.remove());
        removeChildBrowsingReminder(true);

        document.querySelectorAll('.netguard-risk-popup').forEach(element => {
            element.remove();
        });
        clearElderModeState();
    }

    function resolveProtectionPaused(result = {}) {
        if (extensionAPI.protection?.resolvePausedState) {
            return extensionAPI.protection.resolvePausedState(result);
        }

        const unified = result.netguardSettings || result.modeSettings || {};
        return Boolean(
            result.protectionPaused ??
            unified.protectionPaused ??
            result.paused ??
            unified.paused ??
            false
        );
    }

    function updateRuntimeSettings(result = {}) {
        const unified = result.netguardSettings || result.modeSettings || {};
        adBlockMode = unified.adMode || result.adMode || result.adBlockMode || 'normal';
        protectionPaused = resolveProtectionPaused(result);
        elderModeEnabled = Boolean(
            unified.elderMode ?? result.elderMode ?? result.elderSettings?.enabled ?? false
        );
        childModeEnabled = Boolean(
            unified.childMode ?? result.childMode ?? false
        );
        if (childModeEnabled) elderModeEnabled = false;
        currentMode = adBlockMode;
        isChildMode = childModeEnabled;
        childModeSettings = {
            ...(result.childSettings || childModeSettings || {}),
            childModeEnabled
        };
        const storedChildWhitelist = childModeSettings.childWhitelist;
        childWhitelist = Array.isArray(storedChildWhitelist)
            ? storedChildWhitelist
            : Array.isArray(childModeSettings.learningWhitelist)
                ? childModeSettings.learningWhitelist
                : [];
        childBrowsingLimitState =
            result.childBrowsingReminderState ||
            childBrowsingLimitState;
        siteWhitelist = unified.whitelist || result.whitelist || result.siteWhitelist || [];
        if (!Array.isArray(siteWhitelist)) siteWhitelist = [];

        if (shouldSkipProtection()) clearProtectionWarnings();
    }

    function refreshRuntimeSettings() {
        return new Promise(resolve => {
            extensionAPI.storage.local.get(RUNTIME_SETTINGS_KEYS, (result) => {
                updateRuntimeSettings(result);
                resolve(result);
            });
        });
    }

    const runtimeSettingsReady = refreshRuntimeSettings().then(result => {
        console.log(`📊 [广告拦截] 已恢复模式: ${adBlockMode}`);
        console.log(`📊 [Storage] 当前模式: ${result.adBlockMode}`);
        sendPluginActiveMessage();
    });

    async function shouldSkipProtectionNow() {
        await runtimeSettingsReady;
        await refreshRuntimeSettings();
        return shouldSkipProtection();
    }

    // 按配置字段路由变化，避免老人设置重启广告或儿童策略。
    extensionAPI.storage.onChanged?.addListener((changes, area) => {
        if (area !== 'local' || !RUNTIME_SETTINGS_KEYS.some(key => changes[key])) {
            return;
        }

        const adSettingsChanged = Boolean(
            storageValueChanged(changes.adMode) ||
            storageValueChanged(changes.adBlockMode) ||
            unifiedSettingChanged(changes, 'adMode')
        );
        const protectionScopeChanged = Boolean(
            storageValueChanged(changes.protectionPaused) ||
            storageValueChanged(changes.paused) ||
            storageValueChanged(changes.whitelist) ||
            storageValueChanged(changes.siteWhitelist) ||
            unifiedSettingChanged(changes, 'paused') ||
            unifiedSettingChanged(changes, 'protectionPaused')
        );
        const childSettingsChanged = Boolean(
            storageValueChanged(changes.childMode) ||
            storageValueChanged(changes.childSettings) ||
            storageValueChanged(changes.childBrowsingReminderState) ||
            unifiedSettingChanged(changes, 'childMode')
        );
        const elderSettingsChanged = Boolean(
            storageValueChanged(changes.elderMode) ||
            storageValueChanged(changes.elderSettings) ||
            unifiedSettingChanged(changes, 'elderMode')
        );

        refreshRuntimeSettings().then(async result => {
            await runtimeSettingsReady;
            if (adSettingsChanged || protectionScopeChanged) {
                await applyAllSettings();
                if (
                    protectionScopeChanged &&
                    typeof checkChildModeSite === 'function'
                ) {
                    await checkChildModeSite();
                }
                return;
            }

            if (elderSettingsChanged || childSettingsChanged) {
                await applyCurrentElderMode(result);
            }
        });
    });

    // 后续任何保护逻辑都必须等待暂停状态完成首次读取。
    await runtimeSettingsReady;

    // 向页面发送插件激活消息
    function sendPluginActiveMessage() {
        try {
            window.postMessage({
                type: "NETGUARD_PLUGIN_ACTIVE",
                mode: adBlockMode,
                timestamp: Date.now()
            }, '*');
            console.log(`📡 [广告拦截] 已发送插件激活通知，模式: ${adBlockMode}`);
        } catch (e) {
            console.error('❌ [广告拦截] 发送消息失败:', e);
        }
    }

    // ==================== Edge演示兼容 - 跳过系统页面检测 ====================
    const currentUrl = window.location.href.toLowerCase();

    function isOfficialTrustedUiPage() {
        try {
            if (window.location.protocol !== 'file:') {
                return false;
            }

            const normalizedPath = decodeURIComponent(
                window.location.pathname || ''
            )
                .replace(/\\/g, '/')
                .replace(/\/+/g, '/');
            const hasOfficialMarker =
                document.documentElement?.getAttribute(
                    'data-netguard-page'
                ) === 'official-ui';

            return (
                hasOfficialMarker &&
                /\/UI\/index\.html$/i.test(normalizedPath)
            );
        } catch (_) {
            return false;
        }
    }
    
    // 本地文件协议（file://）允许检测
    const isLocalFile = currentUrl.startsWith('file://');
    
    // 系统页面检测（跳过内置浏览器页面）
    const isSystemPage = !isLocalFile && [
        currentUrl.startsWith('edge://'),
        currentUrl.startsWith('chrome://'),
        currentUrl.startsWith('about:'),
        currentUrl.includes('localhost'),
        currentUrl.includes('127.0.0.1')
    ].some(Boolean);

    const DEMO_ENVIRONMENT_PATHS = [
        '/demos/',
        'ads_demo.html',
        'ai_demo',
        'url_demo'
    ];
    const isDemoEnvironmentPage = DEMO_ENVIRONMENT_PATHS.some(path =>
        currentUrl.includes(path)
    );
    const isLocalDemoHost = (() => {
        try {
            const hostname = new URL(currentUrl).hostname.toLowerCase();
            return hostname === 'localhost' || hostname === '127.0.0.1';
        } catch (_) {
            return false;
        }
    })();
    
    // 演示页面白名单 - 通过URL检测
    const DEMO_PAGES = [
        'dashboard_demo.html',
        'child_demo_home.html',
        'elder_demo.html',
        'ads_demo.html',
        'demo_center.html',
        'ai_demo_home.html',
        'safe.html',
        'low.html',
        'medium.html',
        'high.html',
        'url_demo.html',
        'child_demo.html',
        'strict_demo.html',
        'gambling-demo.html',
        'porn-demo.html',
        'phishing-demo.html'
    ];
    
    // 检查是否是演示页面
    const isDemoPage = DEMO_PAGES.some(page => currentUrl.includes(page));
    
    // 检查页面是否有 data-demo-mode 属性
    const htmlElement = document.querySelector('html');
    const hasDemoModeAttribute = htmlElement && htmlElement.getAttribute('data-demo-mode') !== null;
    
    // 演示页面标识
    const isDashboardPage = currentUrl.includes('dashboard_demo.html');
    const isChildDemoHome = currentUrl.includes('child_demo_home.html');
    
    // 系统页面完全跳过（不执行任何操作）
    if (isSystemPage) {
        if (isLocalDemoHost && isDemoEnvironmentPage) {
            console.log('[DemoPage] bypass system page check', currentUrl);
        } else {
            console.log(`[系统页面] 浏览器系统页面，已跳过检测`);
            return;
        }
    }
    
    // 儿童模式首页完全跳过所有检测（避免AI检测和风险横幅影响演示）
    if (isChildDemoHome) {
        console.log(`[儿童模式首页] child_demo_home.html，已跳过所有检测`);
        return;
    }
    
    // 游戏网站快速入口（复用娱乐限制或学习模式的统一 game 策略）
    const CHILD_GAME_BLOCK_LIST = [
        '4399.com',
        '7k7k.com',
        '4399.com.cn',
        '7k7k.com.cn',
        'game.com'
    ];
    
    console.log('🔍 [游戏检测] 当前URL:', currentUrl);
    console.log('🔍 [游戏检测] 拦截列表:', CHILD_GAME_BLOCK_LIST);
    
    const matchedGameSite = CHILD_GAME_BLOCK_LIST.find(domain => {
        const found = currentUrl.includes(domain);
        console.log('🔍 [游戏检测] 检查域名:', domain, '- 匹配:', found);
        return found;
    });
    const isGameSite = Boolean(matchedGameSite);
    
    console.log('🔍 [游戏检测] isGameSite:', isGameSite);
    
    if (
        childModeEnabled &&
        resolveChildPolicyType({ type: 'game' }) === 'game' &&
        isGameSite &&
        !shouldSkipChildProtection()
    ) {
        // 检测到游戏网站，等待DOM就绪后应用统一 game 策略。
        console.log(`[儿童模式] 检测到游戏网站: ${currentUrl}`);
        const applyFastGamePolicy = () => {
            if (
                !childModeEnabled ||
                resolveChildPolicyType({ type: 'game' }) !== 'game' ||
                shouldSkipChildProtection()
            ) {
                clearChildModeUi();
                return;
            }
            void applyChildModePolicy(
                { type: 'game', site: matchedGameSite },
                window.location.href
            );
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', applyFastGamePolicy);
        } else {
            setTimeout(applyFastGamePolicy, 0);
        }
    }
    
    // 本地文件页面正常执行检测
    if (isLocalFile) {
        console.log(`[本地文件] 开始执行检测`);
    }
    
    // 演示页面配置
    // 只有 dashboard_demo.html 需要跳过所有功能（后台统计页面）
    // 其他演示页面（high.html, medium.html, ads_demo.html等）需要正常显示风险提示
    let skipAIDetection = isDashboardPage;                     // 仅dashboard跳过AI检测
    let skipAdBlocking = isDashboardPage;                      // 仅dashboard跳过广告拦截
    let skipRiskBanner = isDashboardPage;                      // 仅dashboard跳过横幅
    let skipRiskModal = isDashboardPage;                       // 仅dashboard跳过弹窗
    
    if (isDemoPage || hasDemoModeAttribute) {
        console.log(`[演示页面] ${currentUrl}，已跳过AI检测和风险提示`);
    }

    // ==================== 统一日志中心架构 ====================
    
    /**
     * 统一安全事件日志函数
     * @param {Object} eventData - 日志数据
     * @param {string} eventData.type - 事件类型: ai_check, url_check, ad_block, child_mode, elder_mode, strict_mode, entertainment_block, game_block, dangerous_block
     * @param {string} eventData.risk_level - 风险等级: safe, low, medium, high
     * @param {number} eventData.score - 风险评分
     * @param {string} eventData.url - 当前URL
     * @param {string} eventData.reason - 事件原因
     */
    function generateSecurityEventUuid() {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
            return globalThis.crypto.randomUUID();
        }

        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
            const random = Math.floor(Math.random() * 16);
            const value = character === 'x' ? random : (random & 0x3) | 0x8;
            return value.toString(16);
        });
    }

    function isValidSecurityEventUuid(value) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            .test(String(value || ''));
    }

    function normalizeSecurityEventScore(value, riskLevel) {
        const defaults = {
            safe: 0.05,
            low: 0.25,
            medium: 0.65,
            high: 0.95
        };
        const score = (
            typeof value === 'boolean' ||
            value === null ||
            value === ''
        ) ? Number.NaN : Number(value);

        return Number.isFinite(score) && score >= 0 && score <= 1
            ? score
            : defaults[riskLevel] ?? 0.5;
    }

    async function logSecurityEvent(eventData) {
        if (await shouldSkipProtectionNow()) return;
        // 验证必填字段
        if (!eventData.type || !eventData.risk_level || !eventData.url) {
            console.warn('[日志中心] 缺少必填字段:', eventData);
            return;
        }
        
        // 验证类型合法性
        const validTypes = ['ai_check', 'url_check', 'ad_block', 'child_mode', 'elder_mode', 'strict_mode', 'entertainment_block', 'game_block', 'dangerous_block'];
        if (!validTypes.includes(eventData.type)) {
            console.warn('[日志中心] 无效的事件类型:', eventData.type);
            return;
        }
        
        // 验证风险等级合法性
        const validRiskLevels = ['safe', 'low', 'medium', 'high'];
        if (!validRiskLevels.includes(eventData.risk_level)) {
            console.warn('[日志中心] 无效的风险等级:', eventData.risk_level);
            return;
        }
        
        try {
            await new Promise(resolve => {
                extensionAPI.runtime.sendMessage({
                    type: 'NETGUARD_SECURITY_EVENT',
                    event: {
                        type: eventData.type,
                        event_uuid: isValidSecurityEventUuid(eventData.event_uuid)
                            ? eventData.event_uuid
                            : isValidSecurityEventUuid(eventData.id)
                                ? eventData.id
                                : generateSecurityEventUuid(),
                        url: String(eventData.url).trim().slice(0, 4096),
                        risk_level: eventData.risk_level,
                        score: normalizeSecurityEventScore(
                            eventData.score ?? eventData[COMPAT_SCORE_FIELD],
                            eventData.risk_level
                        ),
                        reason: String(eventData.reason || '').slice(0, 1000),
                        source: 'extension'
                    }
                }, () => resolve());
            });
            console.log(`[日志中心] 事件已加入批量队列: type=${eventData.type}`);
        } catch (e) {
            console.warn('[日志中心] 事件入队失败:', e);
        }
    }
    
    // 便捷方法 - AI检测
    async function logAICheck(riskLevel, url, reason, riskScore = 0, eventUuid = null) {
        await logSecurityEvent({
            type: 'ai_check',
            risk_level: riskLevel,
            score: riskScore,
            url: url,
            reason: reason,
            event_uuid: eventUuid
        });
    }
    
    // 便捷方法 - URL检测
    async function logURLCheck(riskLevel, url, reason) {
        await logSecurityEvent({ type: 'url_check', risk_level: riskLevel, url: url, reason: reason });
    }
    
    // 便捷方法 - 广告拦截
    async function logAdBlock(url, reason) {
        await logSecurityEvent({ type: 'ad_block', risk_level: 'high', url: url, reason: reason });
    }
    
    // 便捷方法 - 儿童模式
    async function logChildMode(url, reason) {
        await logSecurityEvent({ type: 'child_mode', risk_level: 'medium', url: url, reason: reason });
    }
    
    // 便捷方法 - 老人模式
    async function logElderMode(url, reason) {
        await logSecurityEvent({ type: 'elder_mode', risk_level: 'low', url: url, reason: reason });
    }
    
    // 便捷方法 - Strict模式
    async function logStrictMode(url, reason) {
        await logSecurityEvent({ type: 'strict_mode', risk_level: 'high', url: url, reason: reason });
    }
    
    // 便捷方法 - 娱乐网站限制
    async function logEntertainmentBlock(url, reason) {
        await logSecurityEvent({ type: 'entertainment_block', risk_level: 'medium', url: url, reason: reason });
    }
    
    // 便捷方法 - 游戏网站限制
    async function logGameBlock(url, reason) {
        await logSecurityEvent({ type: 'game_block', risk_level: 'medium', url: url, reason: reason });
    }
    
    // 便捷方法 - 危险网站拦截
    async function logDangerousBlock(url, reason) {
        await logSecurityEvent({ type: 'dangerous_block', risk_level: 'high', url: url, reason: reason });
    }
    
    // ==================== 统计数据管理 ====================

    function getEffectiveAdMode(mode = adBlockMode) {
        if (childModeEnabled) return 'child';
        if (elderModeEnabled) return 'elder';
        return mode === 'strict' ? 'strict' : 'normal';
    }

    function getAdEventPageUrl() {
        try {
            const topUrl = window.top.location.href;
            if (topUrl) return topUrl;
        } catch (_) {
            // 跨域子框架无法读取 top.location，使用 referrer 归属主页面。
        }

        return document.referrer || window.location.href;
    }

    function getAdResourceType(el) {
        return ({
            IFRAME: 'iframe',
            SCRIPT: 'script',
            IMG: 'image',
            VIDEO: 'media',
            AUDIO: 'media'
        })[el?.tagName] || 'element';
    }
    
    // 更新统计数据到 storage
    async function updateStorageStats(type, increment = 1, adContext = {}) {
        console.log('[AD_STAT_UPDATE]', {
            type,
            increment,
            page_url: window.location.href
        });
        try {
            if (!extensionAPI || !extensionAPI.storage || !extensionAPI.storage.local) {
                console.warn('📊 [统计系统] storage API不可用');
                return;
            }
            
            const result = await new Promise((resolve) => {
                extensionAPI.storage.local.get('netguardStats', (res) => {
                    resolve(res || {});
                });
            });
            
            const defaultStats = {
                aiDetectCount: 0,
                urlDetectCount: 0,
                adBlockCount: 0,
                highRiskCount: 0,
                mediumRiskCount: 0,
                lowRiskCount: 0,
                childBlockCount: 0,
                elderWarnCount: 0,
                todayRiskCount: 0,
                dailyStats: [],
                lastUpdateTime: new Date().toISOString()
            };

            const stats = {
                ...defaultStats,
                ...(result.netguardStats || {})
            };
            const numericStatFields = [
                'aiDetectCount',
                'urlDetectCount',
                'adBlockCount',
                'highRiskCount',
                'mediumRiskCount',
                'lowRiskCount',
                'childBlockCount',
                'elderWarnCount',
                'todayRiskCount'
            ];

            numericStatFields.forEach((field) => {
                if (
                    typeof stats[field] !== 'number' ||
                    !Number.isFinite(stats[field])
                ) {
                    stats[field] = 0;
                }
            });
            
            switch (type) {
                case 'aiDetect':
                    stats.aiDetectCount += increment;
                    break;
                case 'adBlock':
                    stats.adBlockCount += increment;
                    break;
                case 'highRisk':
                    stats.highRiskCount += increment;
                    stats.todayRiskCount += increment;
                    break;
                case 'mediumRisk':
                    stats.mediumRiskCount += increment;
                    stats.todayRiskCount += increment;
                    break;
                case 'lowRisk':
                    stats.lowRiskCount += increment;
                    stats.todayRiskCount += increment;
                    break;
                case 'elderWarn':
                    stats.elderWarnCount += increment;
                    break;
                default:
                    console.warn(`📊 [统计系统] 未知统计类型: ${type}`);
                    return;
            }
            
            stats.lastUpdateTime = new Date().toISOString();
            
            const storageUpdate = { netguardStats: stats };
            if (type === 'adBlock') {
                const pageUrl = adContext.page_url || getAdEventPageUrl();
                const mode = getEffectiveAdMode(adContext.mode);
                const resourceType = String(
                    adContext.resource_type || 'element'
                ).slice(0, 32);

                storageUpdate.lastAdBlockContext = {
                    page_url: pageUrl,
                    mode,
                    resource_type: resourceType
                };
            }
            await new Promise((resolve) => {
                extensionAPI.storage.local.set(storageUpdate, resolve);
            });

            if (type === 'adBlock') {
                const context = storageUpdate.lastAdBlockContext;
                const response = await new Promise((resolve) => {
                    extensionAPI.runtime.sendMessage({
                        type: 'NETGUARD_AD_BLOCKED',
                        event: {
                            page_url: context.page_url,
                            increment,
                            mode: context.mode,
                            resource_type: context.resource_type,
                            page_complete: document.readyState === 'complete'
                        }
                    }, result => resolve(result || null));
                });

                // 兼容尚未更新的后台脚本；新版后台会聚合本页计数。
                if (!response?.success) {
                    await new Promise((resolve) => {
                        extensionAPI.runtime.sendMessage({
                            type: 'NETGUARD_AD_STAT_UPDATED'
                        }, resolve);
                    });
                }
            }
            
            console.log(`📊 [统计系统] 更新统计: ${type} +${increment}`);
        } catch (e) {
            console.error('📊 [统计系统] 更新失败:', e);
        }
    }

    function notifyAdPageComplete(force = false) {
        if (shouldSkipProtection()) return;

        extensionAPI.runtime.sendMessage({
            type: 'NETGUARD_AD_PAGE_COMPLETE',
            force,
            event: {
                page_url: getAdEventPageUrl(),
                mode: getEffectiveAdMode(),
                page_complete: true
            }
        }, () => {
            // Service Worker 可能正在重启；已聚合数据仍会由定时任务归并。
            void extensionAPI.runtime.lastError;
        });
    }

    if (document.readyState === 'complete') {
        setTimeout(() => notifyAdPageComplete(false), 0);
    } else {
        window.addEventListener(
            'load',
            () => notifyAdPageComplete(false),
            { once: true }
        );
    }

    window.addEventListener(
        'pagehide',
        () => notifyAdPageComplete(true),
        { once: true }
    );

    // 添加风险日志到 storage
    async function addStorageRiskLog(log) {
        try {
            if (!extensionAPI || !extensionAPI.storage || !extensionAPI.storage.local) {
                console.warn('📝 [风险日志] storage API不可用');
                return;
            }
            
            const result = await new Promise((resolve) => {
                extensionAPI.storage.local.get('netguardRiskLogs', (res) => {
                    resolve(res || {});
                });
            });
            
            const logs = result.netguardRiskLogs || [];
            
            const newLog = {
                id: Date.now(),
                type: log.type || 'unknown',
                level: log.level || 'low',
                url: log.url || window.location.href,
                reason: log.reason || '未知风险',
                time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
                date: new Date().toISOString()
            };
            
            logs.unshift(newLog);
            
            // 只保留最近100条日志
            if (logs.length > 100) {
                logs.pop();
            }
            
            await new Promise((resolve) => {
                extensionAPI.storage.local.set({ netguardRiskLogs: logs }, resolve);
            });
            
            console.log(`📝 [风险日志] 添加日志: ${log.type} - ${log.level}`);
        } catch (e) {
            console.error('📝 [风险日志] 添加失败:', e);
        }
    }

    // ==================== 安全模式配置 ====================
    // 获取当前安全模式
    async function loadCurrentMode() {
        try {
            if (!extensionAPI || !extensionAPI.storage || !extensionAPI.storage.local) {
                console.warn('🔒 [安全模式] storage API不可用，使用默认配置');
                currentMode = 'normal';
                return;
            }
            
            const res = await new Promise((resolve) => {
                extensionAPI.storage.local.get([
                    'netguardSettings', 'adMode', 'adBlockMode'
                ], (result) => {
                    resolve(result || {});
                });
            });

            currentMode =
                res.netguardSettings?.adMode ||
                res.adMode ||
                res.adBlockMode ||
                'normal';
            adBlockMode = currentMode;
            console.log(`🔒 [安全模式] 当前模式: ${currentMode}`);
            console.log(`📊 [Storage] 读取 adBlockMode: ${res.adBlockMode}`);
        } catch (e) {
            console.warn('🔒 [安全模式] 加载模式失败，使用默认配置:', e);
            currentMode = 'normal';
        }
    }

    // ==================== AI文本检测配置 ====================
    const AI_REQUEST_TIMEOUT = 5000; // 5秒超时

    async function getApiUrl(path) {
        return globalThis.NetGuardApiConfig.getApiUrl(
            path,
            extensionAPI.storage.local
        );
    }
    const MAX_TEXT_LENGTH = 3000;
    const AI_DEBUG = true;
    
    // AI服务状态（缓存）
    let aiServiceStatus = null; // 'online' | 'offline' | null
    let aiServiceChecked = false;

    // ==================== 广告拦截核心配置 ====================
    const NOOP_GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";
    const DEBUG = false;
    
    // 演示页面URL白名单 - 这些页面不进行广告拦截
    // ads_demo.html 不在此列表中，因为它是广告拦截演示页面，需要实际拦截广告
    const DEMO_WHITELIST_URLS = [
        'demo_center.html',
        'ai_demo_home.html',
        'safe.html',
        'low.html',
        'medium.html',
        'high.html',
        'url_demo.html',
        'elder_demo.html',
        'child_demo.html',
        'strict_demo.html',
        'dashboard_demo.html',
        'gambling-demo.html',
        'porn-demo.html',
        'phishing-demo.html'
    ];

    // ==================== 儿童模式网站配置 ====================
    const CHILD_MODE_CONFIG = {
        // 学习网站白名单 - 允许正常访问
        learningWhitelist: [
            'icourse163.org',      // 中国大学MOOC
            'xuexi.cn',            // 学习强国
            'hjenglish.com',       // 沪江英语
            'khanacademy.org',     // Khan Academy
            'coursera.org',        // Coursera
            'edx.org',             // edX
            'udemy.com',           // Udemy
            'duolingo.com',        // Duolingo
            'code.org',            // Code.org
            'scratch.mit.edu',     // Scratch
            'w3schools.com',       // W3Schools
            'geeksforgeeks.org',   // GeeksforGeeks
            'pbskids.org'          // PBS Kids
        ],
        
        // 娱乐网站限制 - 需要申请访问
        entertainmentSites: [
            'bilibili.com',        // B站
            'douyin.com',          // 抖音
            'youtube.com',         // YouTube
            'twitch.tv',           // Twitch
            'netflix.com',         // Netflix
            'hulu.com',            // Hulu
            'disneyplus.com',      // Disney+
            'tiktok.com',          // TikTok
            'instagram.com',       // Instagram
            'facebook.com',        // Facebook
            'twitter.com',         // Twitter
            'roblox.com',          // Roblox
            'minecraft.net'        // Minecraft
        ],
        
        // 游戏网站限制 - 直接拦截
        gameSites: [
            '4399.com',            // 4399小游戏
            '7k7k.com',            // 7k7k小游戏
            'game.com',            // 游戏网
            'steamcommunity.com',  // Steam社区
            'epicgames.com'        // Epic Games
        ],
        
        // 危险网站关键词 - 高风险拦截
        dangerousKeywords: [
            'gambling',            // 赌博
            'porn',                // 色情
            'xxx',                 // 色情
            'adult',               // 成人内容
            'violence',            // 暴力
            'phishing',            // 钓鱼
            'scam',                // 诈骗
            'malware',             // 恶意软件
            'hack',                // 黑客
            'torrent'              // 种子下载
        ]
    };

    // 加载儿童模式配置
    async function loadChildModeSettings() {
        console.log('👶 [儿童模式] 加载配置...');
        try {
            if (!extensionAPI || !extensionAPI.storage || !extensionAPI.storage.local) {
                console.warn('👶 [儿童模式] storage API不可用，儿童模式已禁用');
                isChildMode = false;
                childModeSettings = null;
                return;
            }
            
            const res = await new Promise((resolve) => {
                extensionAPI.storage.local.get([
                    'netguardSettings', 'childMode', 'childSettings',
                    'childBrowsingReminderState'
                ], (result) => {
                    console.log('👶 [儿童模式] storage返回:', result);
                    resolve(result || {});
                });
            });

            const unified = res.netguardSettings || {};
            isChildMode = Boolean(
                unified.childMode ?? res.childMode ?? false
            );
            childModeEnabled = isChildMode;
            childModeSettings = {
                ...(res.childSettings || {}),
                childModeEnabled: isChildMode
            };
            const storedChildWhitelist = childModeSettings.childWhitelist;
            childWhitelist = Array.isArray(storedChildWhitelist)
                ? storedChildWhitelist
                : Array.isArray(childModeSettings.learningWhitelist)
                    ? childModeSettings.learningWhitelist
                    : [];
            childBrowsingLimitState =
                res.childBrowsingReminderState || null;
            console.log(`👶 [儿童模式] 加载完成 - childSettings:`, childModeSettings);
            console.log(`👶 [儿童模式] 加载完成 - isChildMode:`, isChildMode);
            if (AI_DEBUG) console.log(`👶 [儿童模式] 当前状态: ${isChildMode ? '已启用' : '已关闭'}`);
        } catch (e) {
            console.warn('👶 [儿童模式] 加载配置失败:', e);
            isChildMode = false;
            childModeSettings = null;
        }
    }

    // 监听儿童模式变化
    function setupChildModeChangeListener() {
        try {
            if (extensionAPI && extensionAPI.storage && extensionAPI.storage.onChanged) {
                extensionAPI.storage.onChanged.addListener((changes, area) => {
                    if (area !== 'local') return;
                    
                    if (
                        unifiedSettingChanged(changes, 'childMode') ||
                        storageValueChanged(changes.childMode) ||
                        storageValueChanged(changes.childSettings) ||
                        storageValueChanged(changes.childBrowsingReminderState)
                    ) {
                        const unified = (
                            changes.netguardSettings || changes.modeSettings
                        )?.newValue || {};
                        isChildMode = Boolean(
                            unified.childMode ??
                            changes.childMode?.newValue ??
                            childModeEnabled ??
                            false
                        );
                        childModeEnabled = isChildMode;
                        childModeSettings = {
                            ...(changes.childSettings?.newValue || childModeSettings || {}),
                            childModeEnabled: isChildMode
                        };
                        const storedChildWhitelist = childModeSettings.childWhitelist;
                        childWhitelist = Array.isArray(storedChildWhitelist)
                            ? storedChildWhitelist
                            : Array.isArray(childModeSettings.learningWhitelist)
                                ? childModeSettings.learningWhitelist
                                : [];
                        if (changes.childBrowsingReminderState) {
                            childBrowsingLimitState =
                                changes.childBrowsingReminderState.newValue || null;
                        }
                        if (AI_DEBUG) console.log(`👶 [儿童模式] 切换至: ${isChildMode ? '已启用' : '已关闭'}`);
                        
                        if (isChildMode) {
                            checkChildModeSite();
                        } else {
                            clearChildModeUi();
                        }
                    }
                });
            } else {
                console.warn('👶 [儿童模式] storage.onChanged不可用');
            }
        } catch (e) {
            console.warn('👶 [儿童模式] 设置监听器失败:', e);
        }
    }
    
    // 检查当前页面是否在演示白名单中
    function checkIfDemoPage() {
        const url = window.location.href.toLowerCase();
        return DEMO_WHITELIST_URLS.some(page => url.includes(page));
    }

    const AD_TOKENS = new Set([
        'adsbygoogle', 'googleads', 'ad-container', 'ad-wrapper',
        'ad-unit', 'ad-slot', 'ad-zone', 'ad-overlay', 'ad-banner',
        'ad-placeholder', 'advertisement', 'sponsored-ad',
        'iframe-ad', 'video-ad', 'native-ad'
    ]);

    const SAFE_TOKENS = new Set([
        'adapter', 'header', 'footer', 'download', 'upload', 'avatar',
        'breadcrumb', 'loader', 'loading', 'login', 'signin', 'signup',
        'captcha', 'recaptcha', 'verify', 'verification', 'map', 'maps',
        'video', 'player', 'media', 'navigation', 'navbar', 'content',
        'article', 'profile', 'dashboard', 'button', 'form',
        'demo-card', 'module-card', 'card-icon', 'card-title', 'card-desc'
    ]);

    const AD_HOST_PATTERN = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.[a-z.]+|adnxs\.com|adsrvr\.org|taboola\.com|outbrain\.com)$/i;

    function getElementTokens(el) {
        const className = typeof el.className === 'string' ? el.className : '';
        const id = typeof el.id === 'string' ? el.id : '';
        return `${className} ${id}`.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean);
    }

    function hasKnownAdUrl(value) {
        if (!value) return false;
        try {
            const parsed = new URL(value, window.location.href);
            return AD_HOST_PATTERN.test(parsed.hostname);
        } catch (_) {
            return false;
        }
    }

    function hasProtectedContext(el, ignoreLargeAncestor = false) {
        if (['BODY', 'MAIN', 'HEADER', 'NAV', 'ARTICLE', 'SECTION', 'FORM'].includes(el.tagName)) {
            return true;
        }
        const explicitAdAttribute = [
            'data-ad', 'data-ad-slot', 'data-ad-unit', 'data-ad-client',
            'data-ad-demo', 'data-sponsor'
        ]
            .some(attr => el.hasAttribute(attr));
        const explicitAdToken = Boolean(
            window.NetGuardAdDetector?.hasStrongAdMarker?.(el.className) ||
            window.NetGuardAdDetector?.hasStrongAdMarker?.(el.id) ||
            getElementTokens(el).some(token => AD_TOKENS.has(token))
        );
        const explicitIframeTitle = el.tagName === 'IFRAME' &&
            /^(advertisement|sponsored ad|广告)$/i.test((el.getAttribute('title') || '').trim());
        const resourceUrl = el.getAttribute('src') || el.getAttribute('data-src') ||
            el.getAttribute('href') || '';
        const explicitNetworkResource = hasKnownAdUrl(resourceUrl) || Boolean(
            window.NetGuardAdDetector?.isAdResourceUrl?.(resourceUrl, window.location.href)
        );
        const authoritativeAdEvidence = explicitAdAttribute ||
            explicitIframeTitle || explicitNetworkResource;
        const authenticationContext = Boolean(
            window.NetGuardAdDetector?.isAuthenticationContext?.(el) ||
            window.NetGuardAdDetector?.containsAuthenticationContext?.(el)
        );
        // 认证区域只覆盖 class/promotion 等非权威证据；明确属性、标题和广告网络仍需检测。
        if (!authoritativeAdEvidence && authenticationContext) return true;
        if (authoritativeAdEvidence) return false;
        if (!ignoreLargeAncestor && !explicitAdAttribute && !explicitIframeTitle && !explicitNetworkResource &&
            window.NetGuardAdDetector?.isInsideLargeContentContainer?.(el)) {
            return true;
        }
        const explicitResourceAd = ['A', 'IMG', 'PICTURE', 'VIDEO', 'SOURCE', 'IFRAME'].includes(el.tagName) &&
            (explicitAdAttribute || explicitAdToken || explicitIframeTitle);
        // 明确广告证据必须先交给检测器判定，不能被同站、媒体或 player 等保护词覆盖。
        if (explicitResourceAd) return false;
        if (['VIDEO', 'AUDIO', 'SOURCE'].includes(el.tagName)) {
            return true;
        }
        if (window.NetGuardAdDetector?.isLargeContentContainer?.(el)) return true;
        const tokens = getElementTokens(el);
        if (tokens.some(token => SAFE_TOKENS.has(token))) return true;
        if (el.tagName === 'IFRAME' && window.NetGuardAdDetector?.isProtectedFrame(el)) {
            const frameUrl = el.getAttribute('src') || el.getAttribute('data-src') || '';
            if (!hasKnownAdUrl(frameUrl)) return true;
        }
        return Boolean(el.closest(
            'form, [role="dialog"], [aria-modal="true"], ' +
            '[class~="captcha"], [class~="recaptcha"], [class~="login"], ' +
            '[class~="signin"], [class~="map"], [class~="player"], ' +
            '[id~="captcha"], [id~="login"], [id~="map"], [id~="player"]'
        ));
    }

    // ==================== 广告检测引擎 ====================
    function getAdDecision(el, mode = currentMode) {
        const noMatch = { isAd: false, confidence: 'none', reason: '' };
        if (!el || el.nodeType !== Node.ELEMENT_NODE || el.__adBlocked || shouldSkipProtection()) return noMatch;
        if (hasProtectedContext(el) || el.closest?.('.ad-hidden-normal, .ad-hidden-strict')) return noMatch;
        // 隐藏已插入的 script 不能阻止执行，也不应计入 DOM 拦截。
        if (el.tagName === 'SCRIPT') return noMatch;

        // 独立检测器提供高/中置信度和命中原因；中置信度只在 strict 生效。
        const detectorDecision = window.NetGuardAdDetector?.inspectAdElement?.(el, mode);
        // 检测器明确保护的同站业务资源不得再被后续兼容规则重新判为广告。
        if (detectorDecision?.protected) return noMatch;
        if (detectorDecision?.isAd) {
            return detectorDecision;
        }
        if (window.NetGuardAdDetector?.isAdElement?.(el, mode)) {
            return { isAd: true, confidence: 'high', reason: 'detector-rule' };
        }

        const explicitAdAttribute = ['data-ad', 'data-ad-slot', 'data-ad-unit', 'data-ad-client', 'data-ad-demo']
            .some(attr => el.hasAttribute(attr));
        if (explicitAdAttribute) return { isAd: true, confidence: 'high', reason: 'explicit-ad-attribute' };

        const resourceUrl = el.getAttribute('src') || el.getAttribute('data-src') || '';
        const linkUrl = el.getAttribute('href') || '';
        const knownAdResource = hasKnownAdUrl(resourceUrl) || hasKnownAdUrl(linkUrl);

        if (el.tagName === 'IFRAME') {
            const title = (el.getAttribute('title') || '').trim();
            if (knownAdResource) return { isAd: true, confidence: 'high', reason: 'known-ad-resource' };
            if (/^(advertisement|sponsored ad|广告)$/i.test(title)) {
                return { isAd: true, confidence: 'high', reason: 'explicit-ad-title' };
            }
            return noMatch;
        }

        if (el.tagName === 'IMG') {
            return knownAdResource
                ? { isAd: true, confidence: 'high', reason: 'known-ad-resource' }
                : noMatch;
        }
        if (knownAdResource) return { isAd: true, confidence: 'high', reason: 'known-ad-resource' };
        if (getElementTokens(el).some(token => AD_TOKENS.has(token))) {
            return { isAd: true, confidence: 'high', reason: 'high-confidence-token' };
        }
        return noMatch;
    }

    function isAdElement(el, mode = currentMode) {
        return getAdDecision(el, mode).isAd;
    }

    function describeAdElement(el) {
        if (!el) return '';
        const id = el.id ? `#${String(el.id).slice(0, 80)}` : '';
        const classes = typeof el.className === 'string'
            ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map(name => `.${name}`).join('')
            : '';
        return `${String(el.tagName || '').toLowerCase()}${id}${classes}`;
    }

    // ==================== 广告处理（普通/严格模式） ====================
    const countedAdElements = new WeakSet();
    const countedAdRegionKeys = new Set();

    function ensureAdElementHidden(mode, el) {
        if (!el) return;
        if (mode === 'strict') {
            if (!el.classList.contains('ad-hidden-strict')) el.classList.add('ad-hidden-strict');
            if (el.style.getPropertyValue('display') !== 'none' ||
                el.style.getPropertyPriority('display') !== 'important') {
                el.style.setProperty('display', 'none', 'important');
            }
            return;
        }

        if (!el.classList.contains('ad-hidden-normal')) el.classList.add('ad-hidden-normal');
        for (const [property, value] of [
            ['visibility', 'hidden'],
            ['opacity', '0'],
            ['pointer-events', 'none']
        ]) {
            if (el.style.getPropertyValue(property) !== value ||
                el.style.getPropertyPriority(property) !== 'important') {
                el.style.setProperty(property, value, 'important');
            }
        }
    }

    function getAdRegionKey(el) {
        if (!el) return '';
        for (const attribute of ['data-ad-slot', 'data-ad-unit', 'data-ad-client', 'data-sponsor']) {
            const value = (el.getAttribute?.(attribute) || '').trim();
            if (value) return `${attribute}:${value}`;
        }
        if (el.id) return `id:${el.id}`;

        const path = [];
        let current = el;
        for (let depth = 0; current && current !== document.body && depth < 6; depth++) {
            const tagName = String(current.tagName || '').toLowerCase();
            if (!tagName) break;
            const siblings = current.parentElement
                ? [...current.parentElement.children].filter(child => child.tagName === current.tagName)
                : [];
            const position = siblings.length > 1 ? `:${siblings.indexOf(current) + 1}` : '';
            path.push(`${tagName}${position}`);
            current = current.parentElement;
        }
        return path.reverse().join('>');
    }

    function findCollapsibleStrictAdShell(el, decision) {
        if (!el?.parentElement || decision?.confidence !== 'high') return null;
        if (window.NetGuardAdDetector?.isAuthenticationContext?.(el)) return null;
        let current = el.parentElement;
        let bestMatch = null;
        for (let depth = 0; current && current !== document.body && depth < 4; depth++) {
            if (!['DIV', 'ASIDE', 'LI', 'INS'].includes(current.tagName)) break;
            if (window.NetGuardAdDetector?.isAuthenticationContext?.(current) ||
                window.NetGuardAdDetector?.containsAuthenticationContext?.(current)) break;
            if (current.querySelector?.('main,article,section,form,[role="main"]')) break;

            const textLength = normalizeAdLabelText(current.textContent).length;
            const descendantCount = current.querySelectorAll?.('*').length || 0;
            const interactiveCount = current.querySelectorAll?.(
                'input,textarea,select,button,a,[contenteditable],video,audio'
            ).length || 0;
            if (textLength > 200 || descendantCount > 50 || interactiveCount > 3) break;

            const rect = current.getBoundingClientRect?.();
            if (rect?.width && rect?.height && (
                rect.width > 900 || rect.height > 800 || rect.width * rect.height > 500000
            )) break;

            bestMatch = current;
            current = current.parentElement;
        }
        return bestMatch;
    }

    async function handleAdElement(mode, el, decisionOverride = null) {
        if (!el || el.__adBlocked || shouldSkipProtection()) return;
        if (el.closest?.('.ad-hidden-normal, .ad-hidden-strict')) return;
        // 已经拦截了更具体的广告位时，不再扩大到父容器并重复计数。
        if (el.querySelector?.('.ad-hidden-normal, .ad-hidden-strict')) return;
        const decision = decisionOverride || getAdDecision(el, mode);
        if (!decision.isAd) return;
        const sourceElement = el;
        const strictShell = mode === 'strict' ? findCollapsibleStrictAdShell(el, decision) : null;
        if (strictShell) {
            el = strictShell;
            if (el.__adBlocked || el.closest?.('.ad-hidden-normal, .ad-hidden-strict') ||
                el.querySelector?.('.ad-hidden-normal, .ad-hidden-strict')) return;
        }
        console.log('[AD_DETECTED]', {
            mode,
            tag: el.tagName,
            class: typeof el.className === 'string' ? el.className : '',
            selector: describeAdElement(el),
            confidence: decision.confidence,
            reason: decision.reason,
            page_url: window.location.href
        });
        el.__adBlocked = true;
        el.__adMode = mode;
        if (!el.__netguardOriginalStyleSaved) {
            el.__netguardOriginalStyle = el.getAttribute('style');
            el.__netguardOriginalStyleSaved = true;
        }
        ensureAdElementHidden(mode, el);
        const statisticElements = new Set([el, sourceElement]);
        if (decision.reason === 'explicit-ad-label-shell') {
            const nestedAdResource = el.querySelector?.(
                '[data-ad],[data-ad-slot],[data-ad-unit],[data-ad-client],[data-sponsor],iframe[src],img[src]'
            );
            if (nestedAdResource) statisticElements.add(nestedAdResource);
        }
        const regionKeys = new Set(
            [...statisticElements].map(getAdRegionKey).filter(Boolean)
        );
        const alreadyCounted = [...statisticElements].some(element => countedAdElements.has(element)) ||
            [...regionKeys].some(key => countedAdRegionKeys.has(key));
        // strict 可能隐藏父级广告壳、normal 隐藏内部资源；二者必须绑定为同一统计区域。
        statisticElements.forEach(element => countedAdElements.add(element));
        regionKeys.forEach(key => countedAdRegionKeys.add(key));
        if (!alreadyCounted) {
            await updateStorageStats('adBlock', 1, {
                page_url: getAdEventPageUrl(),
                mode,
                resource_type: getAdResourceType(sourceElement),
                rule_reason: decision.reason
            });
        }
    }

    function restoreAdElement(el) {
        if (!el) return;
        el.classList.remove('ad-hidden-normal', 'ad-hidden-strict');
        if (el.__netguardOriginalStyleSaved) {
            if (el.__netguardOriginalStyle === null) el.removeAttribute('style');
            else el.setAttribute('style', el.__netguardOriginalStyle);
        }
        delete el.__adBlocked;
        delete el.__adMode;
        delete el.__strictCleaned;
        delete el.__strictAdHidden;
        delete el.__netguardOriginalStyle;
        delete el.__netguardOriginalStyleSaved;
    }

    const HIGH_CONFIDENCE_AD_SELECTOR = [
        '[data-ad]', '[data-ad-slot]', '[data-ad-unit]', '[data-ad-client]',
        '[data-ad-demo]', '[data-sponsor]', 'ins.adsbygoogle', 'iframe[src]',
        'img[src]', '[style*="background-image"]',
        'a[href*="doubleclick.net"]', 'a[href*="googlesyndication.com"]',
        'a[href*="googleadservices.com"]',
        '.ad', '.ads', '.advert', '.advertisement', '.sponsor', '.sponsored',
        '.ad-container', '.ad-wrapper', '.ad-unit', '.ad-slot', '.ad-zone',
        '.ad-overlay', '.ad-banner', '.sponsored-ad', '.iframe-ad',
        '.video-ad', '.native-ad', '.ad-box', '.ad-sense', '.ad-popup',
        '.ads-iframe', '.sponsor-box', '.sponsor-container', '.fake-ad',
        '.adsbygoogle', '.adchoice', '.adchoices',
        '[id="ad"]', '[id="ads"]', '[id="advert"]', '[id="advertisement"]',
        '[id="sponsor"]', '[id="sponsored"]',
        '[class^="ad-"]', '[class*=" ad-"]', '[id^="ad-"]',
        '[class^="advert-"]', '[class*=" advert-"]', '[id^="advert-"]',
        '[class^="sponsor-"]', '[class*=" sponsor-"]', '[id^="sponsor-"]',
        '[class$="-ad"]', '[class*="-ad "]', '[id$="-ad"]',
        '[class$="-ads"]', '[class*="-ads "]', '[id$="-ads"]',
        '[class$="-sponsor"]', '[class*="-sponsor "]', '[id$="-sponsor"]'
    ].join(',');
    const STRICT_PROMOTION_SELECTOR = [
        '[data-promo]', '[class~="promo"]', '[class~="promotion"]',
        '[class^="promo-"]', '[class*=" promo-"]',
        '[class^="promotion-"]', '[class*=" promotion-"]',
        '[id="promo"]', '[id="promotion"]', '[id^="promo-"]', '[id^="promotion-"]'
    ].join(',');

    function getAdCandidateSelector(mode) {
        return mode === 'strict'
            ? `${HIGH_CONFIDENCE_AD_SELECTOR},${STRICT_PROMOTION_SELECTOR}`
            : HIGH_CONFIDENCE_AD_SELECTOR;
    }

    const STRICT_AD_LABEL_PATTERN = /^(?:广告(?:[×xX])?|关闭广告|advertisement|sponsored ad)$/i;

    function normalizeAdLabelText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function isSafeStrictAdShell(element, labelElement, labelText) {
        if (!element || !labelElement || !['DIV', 'ASIDE'].includes(element.tagName)) return false;
        if (window.NetGuardAdDetector?.isAuthenticationContext?.(element) ||
            window.NetGuardAdDetector?.containsAuthenticationContext?.(element)) {
            return false;
        }
        // “广告/广告×”标签已经提供明确壳层证据；只忽略祖先尺寸保护，
        // 壳层自身的核心结构、内容量、交互量和尺寸检查仍然保留。
        if (hasProtectedContext(element, true) || window.NetGuardAdDetector?.isLargeContentContainer?.(element)) {
            return false;
        }

        const textLength = normalizeAdLabelText(element.textContent).length;
        const descendantCount = element.querySelectorAll('*').length;
        const interactiveCount = element.querySelectorAll(
            'input,textarea,select,button,a,[contenteditable],video,audio'
        ).length;
        if (textLength > 400 || descendantCount > 120 || interactiveCount > 6) return false;

        const markerText = `${element.className || ''} ${element.id || ''} ` +
            `${labelElement.className || ''} ${labelElement.id || ''}`;
        const hasMarker = Boolean(window.NetGuardAdDetector?.hasAdMarker?.(markerText));
        const hasCloseAffordance = /[×xX]/.test(labelText) || Boolean(labelElement.querySelector(
            'button,[class*="close"],[aria-label*="关闭"]'
        ));
        const hasAdContent = Boolean(element.querySelector(
            '[data-ad],[data-ad-slot],iframe,img,a[href*="ads."],a[href*="adservice"]'
        ));
        if (!hasMarker && !hasCloseAffordance && !hasAdContent) return false;

        const shellRect = element.getBoundingClientRect?.();
        const labelRect = labelElement.getBoundingClientRect?.();
        if (shellRect?.width && shellRect?.height && labelRect?.width && labelRect?.height) {
            const area = shellRect.width * shellRect.height;
            if (shellRect.width < 100 || shellRect.height < 60 ||
                shellRect.width > 900 || shellRect.height > 800 || area > 600000 ||
                labelRect.width > 160 || labelRect.height > 60) {
                return false;
            }
            const nearTop = labelRect.top - shellRect.top <= 80;
            const nearLeft = labelRect.left - shellRect.left <= 90;
            const nearRight = shellRect.right - labelRect.right <= 90;
            if (!nearTop || (!nearLeft && !nearRight)) return false;
        }
        return true;
    }

    function findStrictAdShellFromLabel(labelElement, labelText) {
        let current = labelElement?.parentElement;
        let bestMatch = null;
        for (let depth = 0; current && current !== document.body && depth < 6; depth++) {
            if (['BODY', 'MAIN', 'HEADER', 'NAV', 'ARTICLE', 'SECTION', 'FORM'].includes(current.tagName)) {
                break;
            }
            if (window.NetGuardAdDetector?.isAuthenticationContext?.(current) ||
                window.NetGuardAdDetector?.containsAuthenticationContext?.(current)) break;
            if (isSafeStrictAdShell(current, labelElement, labelText)) bestMatch = current;
            current = current.parentElement;
        }
        return bestMatch;
    }

    function findStrictLabeledAdShells(root, maxTextNodes = 3000) {
        const shells = new Set();
        if (!root || !document.createTreeWalker) return shells;
        const walker = document.createTreeWalker(root, window.NodeFilter?.SHOW_TEXT || 4);
        let textNode = walker.nextNode();
        let visited = 0;
        while (textNode && visited < maxTextNodes) {
            const labelText = normalizeAdLabelText(textNode.nodeValue);
            if (STRICT_AD_LABEL_PATTERN.test(labelText)) {
                const shell = findStrictAdShellFromLabel(textNode.parentElement, labelText);
                if (shell) shells.add(shell);
            }
            textNode = walker.nextNode();
            visited++;
        }
        return shells;
    }

    // ==================== 广告清理与监听 ====================
    async function purgeAllAds(mode, isCurrent = () => true) {
        console.log('[DEBUG_PURGE_ENTER]', { mode });
        if (!isCurrent() || !mode || mode === 'off' || shouldSkipProtection()) return;
        
        // 检查是否为广告演示页面
        const isAdsDemoPage = window.location.href.toLowerCase().includes('ads_demo.html');
        
        if (isAdsDemoPage) {
            // 广告演示页面：拦截 data-ad-demo 属性的元素
            blockDemoAds(mode);
            return;
        }
        
        // 演示页面跳过广告拦截
        if (checkIfDemoPage()) {
            if (AI_DEBUG) console.log('🔔 [广告拦截] 演示页面，跳过广告清理');
            return;
        }
        
        const candidates = new Set(document.querySelectorAll(getAdCandidateSelector(mode)));
        const labeledAdShells = mode === 'strict'
            ? findStrictLabeledAdShells(document)
            : new Set();
        labeledAdShells.forEach(element => candidates.add(element));
        let count = 0;
        for (const el of candidates) {
            if (!isCurrent()) return;
            if (!el.__adBlocked && (labeledAdShells.has(el) || isAdElement(el, mode))) {
                const decision = labeledAdShells.has(el)
                    ? { isAd: true, confidence: 'high', reason: 'explicit-ad-label-shell' }
                    : null;
                await handleAdElement(mode, el, decision);
                if (!isCurrent()) return;
                count++;
            }
        }
        if (DEBUG && count > 0) console.log(`本次扫描清理了 ${count} 个广告（模式：${mode}）`);
    }
    
    // 广告演示页面专用拦截函数
    function blockDemoAds(mode) {
        console.log('[DEBUG_DEMO_AD_ENTER]', { mode });
        console.log(`🔥 [广告拦截] 演示页面开始拦截，当前模式: ${mode}`);
        
        const adElements = document.querySelectorAll('[data-ad-demo]');
        let count = 0;
        
        adElements.forEach((el, index) => {
            if (el.__adBlocked) return;
            
            // 延迟执行，展示逐个拦截效果
            setTimeout(async () => {
                if (el.__adBlocked) return;
                console.log('[AD_DETECTED]', {
                    mode,
                    tag: el.tagName,
                    ad_type: el.getAttribute('data-ad-demo'),
                    page_url: window.location.href
                });
                el.__adBlocked = true;
                const adType = el.getAttribute('data-ad-demo');
                const originalHeight = el.offsetHeight;
                
                if (mode === 'normal') {
                    // 普通模式：仅隐藏，保留占位，页面布局不变
                    console.log(`✨ [普通模式] 隐藏广告: ${adType}`);
                    el.classList.add('ad-hidden-normal');
                    
                    // 添加占位提示
                    setTimeout(() => {
                        el.style.setProperty('opacity', '1', 'important');
                        el.style.setProperty('visibility', 'visible', 'important');
                        el.style.setProperty('height', originalHeight + 'px', 'important');
                        el.innerHTML = `
                            <div class="ad-placeholder">
                                <div class="ad-placeholder-content">
                                    <div class="ad-placeholder-icon">🛡️</div>
                                    <div class="ad-placeholder-title">广告已拦截</div>
                                    <div class="ad-placeholder-desc">类型: ${getAdTypeName(adType)} | 模式: 温和过滤</div>
                                </div>
                            </div>
                        `;
                    }, 600);
                } else if (mode === 'strict') {
                    // Strict模式：快速缩小+淡出+删除DOM，页面布局自动调整
                    console.log(`🔥 [Strict模式] 删除广告DOM: ${adType}`);
                    el.classList.add('ad-hidden-strict');
                    
                    setTimeout(async () => {
                        el.remove();
                        console.log(`🗑️ [Strict模式] 已删除广告节点: ${adType}`);
                    }, 400);
                }
                
                count++;
                await updateStats(el, mode);
            }, index * 500); // 每个广告间隔500ms，更明显的逐个效果
        });
        
        // 更新状态显示
        const statusBadge = document.getElementById('statusBadge');
        if (statusBadge) {
            statusBadge.textContent = mode === 'strict' ? 'Strict模式' : '普通模式';
            statusBadge.classList.remove('disabled', 'active', 'strict');
            statusBadge.classList.add(mode === 'strict' ? 'strict' : 'active');
            console.log(`📊 [广告拦截] 状态徽章已更新: ${mode}`);
        }
    }
    
    // 获取广告类型名称
    function getAdTypeName(type) {
        const names = {
            'banner': '横幅广告',
            'sidebar1': '侧边栏广告',
            'sidebar2': '侧边栏广告',
            'sponsor': '赞助广告',
            'iframe': '内嵌广告',
            'popup': '弹窗广告'
        };
        return names[type] || type;
    }
    
    // 更新统计数据
    async function updateStats(el = null, mode = adBlockMode) {
        const blockedCount = document.getElementById('blockedCount');
        const savedTime = document.getElementById('savedTime');
        const dataSaved = document.getElementById('dataSaved');
        
        if (blockedCount) {
            const current = parseInt(blockedCount.textContent) || 0;
            blockedCount.textContent = current + 1;
        }
        if (savedTime) {
            const current = parseInt(savedTime.textContent) || 0;
            savedTime.textContent = (current + 2) + 's';
        }
        if (dataSaved) {
            const current = parseInt(dataSaved.textContent) || 0;
            dataSaved.textContent = (current + 50) + 'KB';
        }
        
        // 只累计本地统计；由 background.js 定时批量上传。
        await updateStorageStats('adBlock', 1, {
            page_url: getAdEventPageUrl(),
            mode,
            resource_type: getAdResourceType(el)
        });
    }

    let observer = null;
    let debounceTimer = null;
    let observerGeneration = 0;
    let reconcileGeneration = 0;
    let reconcileTask = Promise.resolve();

    // 严格模式：只隐藏明确识别为广告的 iframe
    async function hideAllIframes(hide) {
        for (const iframe of document.querySelectorAll('iframe[src]')) {
            if (hide && isAdElement(iframe, 'strict')) {
                await handleAdElement('strict', iframe);
            } else if (!hide && iframe.__adMode === 'strict') {
                restoreAdElement(iframe);
            }
        }
    }

    function startObserver(mode) {
        const generation = ++observerGeneration;
        if (observer) observer.disconnect();
        if (debounceTimer) clearTimeout(debounceTimer);
        if (!mode || mode === 'off' || shouldSkipProtection()) return;
        
        // 演示页面跳过广告监听（保留AI检测功能）
        const isAdsDemoPage = window.location.href.toLowerCase().includes('ads_demo.html');
        if (isAdsDemoPage || checkIfDemoPage()) {
            if (AI_DEBUG) console.log('🔔 [广告拦截] 演示页面，跳过广告监听');
            return;
        }

        const pendingRoots = new Set();
        const flushPendingRoots = async () => {
            if (generation !== observerGeneration) return;
            const queuedRoots = [...pendingRoots];
            const roots = queuedRoots.filter(root =>
                !queuedRoots.some(parent =>
                    parent !== root && parent?.contains?.(root)
                )
            );
            pendingRoots.clear();
            const candidates = new Set();
            const labeledAdShells = new Set();
            const selector = getAdCandidateSelector(mode);
            for (const root of roots) {
                if (generation !== observerGeneration) return;
                if (!root || root.nodeType !== Node.ELEMENT_NODE || root.__adBlocked) continue;
                if (root.matches?.(selector)) candidates.add(root);
                root.querySelectorAll?.(selector).forEach(el => candidates.add(el));
                if (mode === 'strict') {
                    findStrictLabeledAdShells(root, 800).forEach(el => {
                        labeledAdShells.add(el);
                        candidates.add(el);
                    });
                }
            }
            for (const el of candidates) {
                if (generation !== observerGeneration) return;
                if (!el.__adBlocked && (labeledAdShells.has(el) || isAdElement(el, mode))) {
                    const decision = labeledAdShells.has(el)
                        ? { isAd: true, confidence: 'high', reason: 'explicit-ad-label-shell' }
                        : null;
                    await handleAdElement(mode, el, decision);
                    if (generation !== observerGeneration) return;
                }
            }
        };

        observer = new MutationObserver(mutations => {
            if (generation !== observerGeneration) return;
            for (const mutation of mutations) {
                if (mutation.type === 'attributes') {
                    if (mutation.target.__adBlocked) {
                        if (['src', 'data-src', 'href'].includes(mutation.attributeName)) {
                            // Resource identity changed: remove our old presentation state and
                            // classify the new URL again. Region keys still prevent recounting.
                            restoreAdElement(mutation.target);
                            pendingRoots.add(mutation.target);
                            continue;
                        }
                        ensureAdElementHidden(mutation.target.__adMode, mutation.target);
                        continue;
                    }
                    pendingRoots.add(mutation.target);
                    continue;
                }
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) pendingRoots.add(node);
                });
            }
            if (pendingRoots.size === 0) return;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(flushPendingRoots, 50);
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [
                'src', 'href', 'class', 'id', 'style', 'data-src',
                'data-ad', 'data-ad-slot', 'data-ad-unit', 'data-ad-client',
                'data-sponsor', 'data-promo', 'title'
            ]
        });
    }

    // ==================== 老人模式：风险关键词 ====================
    const RISK_KEYWORDS = [
        '中奖', '免费', '红包', '转账', '密码', '验证码', '银行卡', '身份证',
        '钓鱼', '诈骗', '虚假', '假冒', '客服', '退款', '刷单', '兼职', '投资',
        '理财', '高收益', '稳赚', '彩票', '博彩', '赌博', '色情', '违法',
        '紧急通知', '账户异常', '安全验证', '点击领取', '立即提现',
        '扫码', '二维码', '付款', '支付', '充值', '提现', '会员', 'VIP',
        '优惠', '折扣', '返利', '返现', '赠送', '领取', '活动', '限时'
    ];
    const ELDER_MODE_DEFAULTS = Object.freeze({
        enabled: false,
        fontScale: 1.35,
        riskHighlight: true,
        pageSimplify: false
    });
    const ELDER_RISK_TITLE = '⚠️ 风险提示：此链接可能涉及诈骗或危险内容';
    const ELDER_RISK_ENABLED_CLASS = 'elder-risk-highlight-enabled';
    const ELDER_DEMO_OWNERSHIP_ATTRIBUTE = 'data-netguard-elder-demo';

    function normalizeElderScale(value) {
        const numericScale = Number(value);
        if (!Number.isFinite(numericScale)) {
            return ELDER_MODE_DEFAULTS.fontScale;
        }
        return Math.min(2, Math.max(1, numericScale));
    }

    function resolveElderModeSettings(settings = {}) {
        return {
            ...ELDER_MODE_DEFAULTS,
            ...settings,
            // 统一总开关是唯一权威状态；儿童模式始终优先。
            enabled: Boolean(elderModeEnabled && !childModeEnabled),
            fontScale: normalizeElderScale(settings.fontScale)
        };
    }

    // 检查元素是否包含风险关键词
    function isRiskElement(el) {
        if (!el) return false;
        const text = (el.innerText || el.textContent || '').toLowerCase();
        if (text.length === 0) return false;
        const tag = el.tagName.toLowerCase();
        // 只检查链接、按钮，不影响输入框
        if (['input', 'textarea', 'select'].includes(tag)) return false;
        if (tag !== 'a' && tag !== 'button' && !el.hasAttribute('role')) return false;
        return RISK_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
    }

    function applyRiskHighlight(el) {
        if (!elderRiskOriginalTitles.has(el)) {
            elderRiskOriginalTitles.set(el, {
                hadTitle: el.hasAttribute('title'),
                title: el.getAttribute('title')
            });
        }

        el.classList.add('risk-highlight');
        el.setAttribute('data-risk-warning', 'true');
        el.setAttribute('title', ELDER_RISK_TITLE);
    }

    function restoreRiskHighlight(el) {
        const originalTitle = elderRiskOriginalTitles.get(el);
        if (!originalTitle) return;

        el.classList.remove('risk-highlight');
        el.removeAttribute('data-risk-warning');
        if (originalTitle.hadTitle) {
            el.setAttribute('title', originalTitle.title);
        } else {
            el.removeAttribute('title');
        }
        elderRiskOriginalTitles.delete(el);
    }

    // 高亮风险元素
    async function highlightRisks() {
        // 不影响视频播放区域
        const videoSelectors = 'video, .video-container, .player-container, [data-video]';
        const videoElements = new Set(
            Array.from(document.querySelectorAll(videoSelectors)).flatMap(v => 
                Array.from(v.querySelectorAll('*'))
            )
        );

        let foundNewRisks = false;

        document.querySelectorAll('a, button, [role="button"], [onclick]').forEach(el => {
            // 跳过视频区域内的元素
            if (videoElements.has(el)) return;
            
            if (isRiskElement(el)) {
                if (!elderRiskLoggedElements.has(el)) {
                    foundNewRisks = true;
                    elderRiskLoggedElements.add(el);
                }
                applyRiskHighlight(el);
            } else if (elderRiskOriginalTitles.has(el)) {
                restoreRiskHighlight(el);
            }
        });

        [...elderRiskOriginalTitles.keys()].forEach(el => {
            if (el.isConnected === false) restoreRiskHighlight(el);
        });

        // 如果发现新的风险元素，使用统一日志函数上报
        if (foundNewRisks) {
            await logElderMode(window.location.href, '检测到风险关键词');
        }
    }

    async function startRiskObserver() {
        if (riskObserver) riskObserver.disconnect();
        if (riskHighlightTimer) clearTimeout(riskHighlightTimer);

        riskObserver = new MutationObserver(() => {
            // 防抖：避免频繁触发
            if (riskHighlightTimer) clearTimeout(riskHighlightTimer);
            riskHighlightTimer = setTimeout(async () => await highlightRisks(), 500);
        });
        riskObserver.observe(document.body, { 
            childList: true, 
            subtree: true,
            characterData: true
        });
        
        // 初始高亮
        await highlightRisks();
    }

    function clearRiskHighlights() {
        document.documentElement?.classList.remove(ELDER_RISK_ENABLED_CLASS);
        [...elderRiskOriginalTitles.keys()].forEach(restoreRiskHighlight);
        if (riskObserver) {
            riskObserver.disconnect();
            riskObserver = null;
        }
        if (riskHighlightTimer) {
            clearTimeout(riskHighlightTimer);
            riskHighlightTimer = null;
        }
    }

    // ==================== 老人模式：加载外部CSS ====================
    function getElderStyleHost() {
        return document.head || document.documentElement || null;
    }

    function loadElderCSS() {
        // 如果已加载则返回
        if (document.getElementById('elder-mode-style-link')) {
            return;
        }
        
        const link = document.createElement('link');
        link.id = 'elder-mode-style-link';
        link.rel = 'stylesheet';
        try {
            link.href = extensionAPI.runtime.getURL('elder-mode.css');
        } catch (e) {
            console.warn('[老人模式] 获取CSS文件失败:', e);
            return;
        }
        const styleHost = getElderStyleHost();
        if (!styleHost) {
            console.warn('[老人模式] 页面样式容器尚未创建');
            return;
        }
        styleHost.appendChild(link);
    }

    function removeElderCSS() {
        const link = document.getElementById('elder-mode-style-link');
        if (link) {
            link.remove();
        }
    }

    function clearElderDemoTimer() {
        if (elderDemoTimer) {
            clearTimeout(elderDemoTimer);
            elderDemoTimer = null;
        }
    }

    function clearElderModeState() {
        clearElderDemoTimer();
        document.documentElement?.classList.remove(
            'elder-mode',
            'simplify',
            ELDER_RISK_ENABLED_CLASS
        );
        document.documentElement?.removeAttribute(ELDER_DEMO_OWNERSHIP_ATTRIBUTE);
        removeElderCSS();
        document.getElementById('elder-mode-dynamic-css')?.remove();
        clearRiskHighlights();
        document.getElementById('elderRiskModal')?.classList.remove('active');
    }

    // ==================== 老人模式：应用样式 ====================
    async function applyElderMode(settings) {
        clearElderDemoTimer();
        if (!settings.enabled) {
            clearElderModeState();
            if (AI_DEBUG) console.log('👴 [老人模式] 已关闭');
            return;
        }

        // 添加老人模式类
        document.documentElement.classList.add('elder-mode');
        
        // 页面简化模式
        if (settings.pageSimplify) {
            document.documentElement.classList.add('simplify');
        } else {
            document.documentElement.classList.remove('simplify');
        }

        // 加载外部CSS
        loadElderCSS();

        if (isLocalElderDemoPage()) {
            document.documentElement.setAttribute(
                ELDER_DEMO_OWNERSHIP_ATTRIBUTE,
                'true'
            );
        } else {
            document.documentElement.removeAttribute(
                ELDER_DEMO_OWNERSHIP_ATTRIBUTE
            );
        }

        // 动态设置缩放比例（覆盖CSS默认值）
        const scale = normalizeElderScale(settings.fontScale);
        const styleEl = document.getElementById('elder-mode-dynamic-css');
        if (styleEl) {
            styleEl.textContent = `:root { --elder-zoom: ${scale}; } .elder-mode body { zoom: ${scale} !important; }`;
        } else {
            const dynamicStyle = document.createElement('style');
            dynamicStyle.id = 'elder-mode-dynamic-css';
            dynamicStyle.textContent = `:root { --elder-zoom: ${scale}; } .elder-mode body { zoom: ${scale} !important; }`;
            const styleHost = getElderStyleHost();
            if (styleHost) styleHost.appendChild(dynamicStyle);
        }

        // 处理风险高亮
        if (settings.riskHighlight) {
            document.documentElement.classList.add(ELDER_RISK_ENABLED_CLASS);
            await startRiskObserver();
        } else {
            clearRiskHighlights();
        }

        // 专门处理老人模式演示页面
        handleElderDemoPage();

        if (AI_DEBUG) console.log(`👴 [老人模式] 已启用 (缩放: ${scale}, 简化: ${settings.pageSimplify}, 风险高亮: ${settings.riskHighlight})`);
    }

    // ==================== 老人模式演示页面专门处理 ====================
    function isLocalElderDemoPage(url = window.location.href) {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'file:') return false;

            const pathParts = decodeURIComponent(parsed.pathname)
                .replace(/\\/g, '/')
                .split('/')
                .filter(Boolean);
            if (pathParts.length < 3) return false;

            return (
                pathParts[pathParts.length - 3] === 'demos' &&
                pathParts[pathParts.length - 2] === 'elder' &&
                pathParts[pathParts.length - 1] === 'elder_demo.html'
            );
        } catch (_) {
            return false;
        }
    }

    function handleElderDemoPage() {
        if (!IS_TOP_FRAME || !isLocalElderDemoPage()) return;

        if (AI_DEBUG) console.log('👴 [老人模式] 检测到演示页面，触发增强效果');

        // 延迟显示风险弹窗（给页面加载时间）
        elderDemoTimer = setTimeout(async () => {
            elderDemoTimer = null;
            await refreshRuntimeSettings();
            if (
                !elderModeEnabled ||
                childModeEnabled ||
                shouldSkipProtection() ||
                !isLocalElderDemoPage()
            ) {
                return;
            }
            const riskModal = document.getElementById('elderRiskModal');
            if (riskModal) {
                riskModal.classList.add('active');
                if (AI_DEBUG) console.log('👴 [老人模式] 显示风险弹窗');
            }
        }, 2000);
    }

    async function applyCurrentElderMode(result = null) {
        const currentSettings = result || await refreshRuntimeSettings();
        if (result) updateRuntimeSettings(result);
        const elderSettings = resolveElderModeSettings(
            currentSettings.elderSettings || {}
        );
        await applyElderMode({
            ...elderSettings,
            enabled: elderSettings.enabled && !shouldSkipProtection()
        });
    }

    async function reconcileAdElements(mode) {
        const requestGeneration = ++reconcileGeneration;
        // 请求到达时立即使旧 Observer 批次失效；DOM 重算本身按请求顺序串行执行。
        observerGeneration++;
        const runReconcile = async () => {
            const isCurrent = () => requestGeneration === reconcileGeneration;
            if (!isCurrent()) return;
            if (observer) observer.disconnect();
            if (debounceTimer) clearTimeout(debounceTimer);

            const previouslyBlocked = [
                ...document.querySelectorAll('.ad-hidden-normal, .ad-hidden-strict')
            ];
            previouslyBlocked.forEach(restoreAdElement);
            if (!isCurrent() || shouldSkipProtection()) return;

            // 模式切换只重算样式和分类；WeakSet 保证同一节点不会再次累计。
            for (const el of previouslyBlocked) {
                if (!isCurrent()) return;
                if (isAdElement(el, mode)) await handleAdElement(mode, el);
            }
            if (!isCurrent()) return;
            await purgeAllAds(mode, isCurrent);
            if (!isCurrent()) return;
            startObserver(mode);
        };

        const task = reconcileTask.then(runReconcile, runReconcile);
        reconcileTask = task.catch(() => {});
        return task;
    }

    // ==================== 主控函数 ====================
    async function applyAllSettings() {
        console.log('[DEBUG_SETTINGS_START]', {
            adBlockMode,
            protectionPaused,
            siteWhitelist,
            childSettings: childModeSettings
        });
        const res = await new Promise(resolve => extensionAPI.storage.local.get([
            'netguardSettings', 'modeSettings', 'adMode', 'adBlockMode',
            'protectionPaused', 'paused',
            'whitelist', 'siteWhitelist', 'elderSettings', 'childSettings'
        ], result => resolve(result || {})));
        updateRuntimeSettings(res);
        console.log(`📊 [applyAllSettings] adBlockMode: ${adBlockMode}`);

        console.log('[DEBUG_PROTECTION_CHECK]', {
            isChildModeActive: childModeEnabled,
            shouldSkipProtection: shouldSkipProtection()
        });
        await reconcileAdElements(adBlockMode);
        if (!shouldSkipProtection()) {
            console.log(`🔍 [广告拦截] 已启动，模式: ${getEffectiveAdMode(adBlockMode)}`);
        } else {
            console.log('⏸️ [广告拦截] 已因暂停或白名单关闭');
        }

        // 应用老人模式（无高对比度颜色）
        await applyCurrentElderMode(res);
    }

    // ==================== 儿童模式核心功能 ====================

    const CHILD_DEMO_SITE_TYPE_MAP = Object.freeze({
        'child_learning_demo.html': 'learning',
        'child_entertainment_demo.html': 'entertainment',
        'child_game_demo.html': 'game',
        'child_danger_demo.html': 'dangerous',
        'fake_gambling.html': 'dangerous',
        'fake_violence.html': 'dangerous'
    });

    function getChildDemoSiteType(url) {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'file:') return null;

            const pathParts = decodeURIComponent(parsed.pathname)
                .replace(/\\/g, '/')
                .split('/')
                .filter(Boolean);
            if (pathParts.length < 3) return null;

            const fileName = pathParts[pathParts.length - 1];
            const parentDirectory = pathParts[pathParts.length - 2];
            const demoDirectory = pathParts[pathParts.length - 3];
            if (demoDirectory !== 'demos' || parentDirectory !== 'child') {
                return null;
            }

            return CHILD_DEMO_SITE_TYPE_MAP[fileName] || null;
        } catch (_) {
            return null;
        }
    }

    // 检查当前页面是否为演示页面（有 data-demo-mode 属性）
    function isDemoModePage() {
        const meta = document.querySelector('meta[name="data-demo-mode"]');
        return meta !== null;
    }

    // 检查当前页面是否为危险演示页面
    function getDangerType() {
        const meta = document.querySelector('meta[name="data-danger-type"]');
        if (meta) {
            const dangerType = meta.getAttribute('content');
            if (dangerType && ['gambling', 'porn', 'violence'].includes(dangerType)) {
                return dangerType;
            }
        }
        return null;
    }

    function getChildRuleList(settingName, fallbackRules) {
        const configuredRules = childModeSettings?.[settingName];
        const sourceRules = Array.isArray(configuredRules)
            ? configuredRules
            : fallbackRules;

        return [...new Set(
            sourceRules
                .map(rule => String(rule || '').trim().toLowerCase())
                .filter(Boolean)
        )];
    }

    function getDecodedChildRuleUrl(url) {
        const lowerUrl = String(url || '').toLowerCase();
        try {
            return decodeURIComponent(lowerUrl);
        } catch (_) {
            return lowerUrl;
        }
    }

    function normalizeChildRuleHost(value) {
        try {
            const raw = String(value || '').trim().toLowerCase();
            if (!raw) return '';
            const parsed = new URL(
                raw.includes('://') ? raw : `https://${raw}`
            );
            return parsed.hostname.replace(/^www\./, '');
        } catch (_) {
            return '';
        }
    }

    function childRuleMatchesDomain(url, rule) {
        const currentHost = normalizeChildRuleHost(url);
        const ruleHost = normalizeChildRuleHost(rule);
        return Boolean(
            currentHost &&
            ruleHost &&
            (currentHost === ruleHost || currentHost.endsWith(`.${ruleHost}`))
        );
    }

    // Child 正文只在现有门控通过后本地读取，不使用整页 innerText 或远程检测。
    function extractChildBodyText() {
        const root = document.body;
        if (!root) return '';
        const maxChars = 12000;
        const maxNodes = 1500;
        const ignoredTags = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|IFRAME|OBJECT|INPUT|TEXTAREA|SELECT)$/;
        const blockTags = /^(P|DIV|ARTICLE|SECTION|MAIN|HEADER|FOOTER|LI|TR|H[1-6]|BR)$/;
        const parts = [];
        let length = 0;
        let visited = 0;
        let node = root;
        const tagNameOf = current => String(current?.tagName || '').toUpperCase();
        const append = value => {
            const part = value.slice(0, maxChars - length);
            parts.push(part);
            length += part.length;
        };

        // 逐节点遍历并跳过不可见子树，节点数和字符数均有硬上限。
        while (node && visited < maxNodes && length < maxChars) {
            visited += 1;
            let skipChildren = false;
            if (node.nodeType === 1) {
                const tagName = tagNameOf(node);
                skipChildren = ignoredTags.test(tagName) ||
                    node.hidden || node.getAttribute('aria-hidden') === 'true' ||
                    String(node.id || '').startsWith('netguard-');
                if (!skipChildren) {
                    const style = window.getComputedStyle(node);
                    skipChildren = style.display === 'none' ||
                        style.visibility === 'hidden' || style.visibility === 'collapse' ||
                        style.opacity === '0';
                }
                if (blockTags.test(tagName)) append('\n');
            } else if (node.nodeType === 3) {
                append(node.data);
            }

            if (!skipChildren && node.firstChild) {
                node = node.firstChild;
                continue;
            }
            while (node && node !== root && !node.nextSibling) {
                node = node.parentNode;
                if (node && blockTags.test(tagNameOf(node))) append('\n');
            }
            node = node === root ? null : node?.nextSibling;
        }

        return parts.join('').replace(/[\t\r\f\v \u00a0]+/g, ' ').trim().toLowerCase();
    }

    function getChildBodyDangerKeyword(text) {
        // 仅用户配置的词扩展到正文；默认 URL 单词不作为正文单词拦截规则。
        if (getChildRuleList('dangerousSites', []).some(keyword => text.includes(keyword))) {
            return '自定义危险关键词';
        }

        // 只在同一硬句的最多四个相邻短分句中组合主体、动作和对象，避免把长文章中的
        // 无关词拼成风险。安全提示只保护它所否定的动作或紧随其后的安全结论，不能
        // 作为整句前缀绕过后续诱导内容。
        const safetyFollowUp = /^(?:(?:请|应当|应该|务必)?(?:提高警惕|保持警惕|注意防范)|(?:应当|应该|必须|请)?(?:立即|直接|坚决)?拒绝|(?:及时|立即)报警|告知(?:家长|老师|警方)|寻求帮助)/;
        const safetyLead = /^(?:请)?(?:警惕|谨防|防范)(?:陌生人|陌生网友|网友|诈骗|骗局|风险)?$/;
        const descriptiveLead = /^(?:警方|媒体|学校|平台|记者|新闻机构)(?:通报|调查|报道|公布|提醒|介绍|分析)?$/;
        const descriptiveActor = /(?:新闻(?:机构)?|媒体|记者|警方|公安|学校|老师|课堂|课程|案件|案例|研究报告)/;
        const descriptiveAction = /(?:报道|通报|调查|公布|分析|讲解|介绍|复盘|教育|揭露|曝光|记录|提醒(?:公众|学生|家长)?|防范|预防)/;
        const descriptiveSubject = /(?:诈骗分子|嫌疑人|骗子|受害者|某(?:个)?(?:平台|网站|账号)|案件|案例|骗局|套路|问题|风险|手法|行为|经过)/;
        const hasDescriptiveContext = value => {
            const normalized = value.trim();
            return (descriptiveActor.test(normalized) && descriptiveAction.test(normalized)) ||
                (descriptiveAction.test(normalized) && descriptiveSubject.test(normalized));
        };
        const hasDirectDangerAction = value => {
            const directAudience = /(?:要求|让|叫)(?:你|您)(?:们)?|(?:给|发给|发送给|告诉|转给|付给)我|不要让(?:父母|家长|老师|监护人)[^。！？!?；;\r\n]{0,6}知道/;
            const directClause = /(?:^|[，,：:、])\s*(?:(?:请|现在|马上|立即|赶快|务必|千万|先|再|最后|然后|接着|注册后|不要犹豫)?\s*(?:把|将|给|向|点击|注册|填写|输入|充值|充钱|参与|参加|加入|下注|投注|转账|转钱|打钱|汇款|付款|转给|付给|发送|提供|提交|私发|绕过|偷偷|私下|瞒着|不要告诉|别告诉|不要让))/;
            return directAudience.test(value) || directClause.test(value);
        };
        const candidates = [];
        const seenCandidates = new Set();
        const privacyListClause = /^(?:(?:把|填写|输入|提供|提交)?(?:家庭)?(?:住址|地址|手机号|手机号码|电话号码|验证码|密码|家庭信息))$/;
        const addCandidate = (
            value,
            hasSafetyFollowUp = false,
            hasSafetyLead = false,
            hasDescriptiveLead = false,
            isDescriptiveContext = false
        ) => {
            const candidate = value.trim();
            if (!candidate) return;
            const key = `${hasSafetyFollowUp ? 'follow' : 'plain'}:${hasSafetyLead ? 'lead' : 'plain'}:${hasDescriptiveLead ? 'report' : 'plain'}:${isDescriptiveContext ? 'description' : 'direct'}:${candidate}`;
            if (seenCandidates.has(key)) return;
            seenCandidates.add(key);
            candidates.push({
                text: candidate,
                hasSafetyFollowUp,
                hasSafetyLead,
                hasDescriptiveLead,
                isDescriptiveContext
            });
        };

        for (const rawSentence of text.split(/[。！？!?；;\r\n]+/)) {
            const sentenceIsDescriptive = hasDescriptiveContext(rawSentence);
            const splitClauses = rawSentence.split(/[，,：:、]+/)
                .map(clause => clause.trim())
                .filter(Boolean);
            const clauses = [];
            for (const clause of splitClauses) {
                const previous = clauses[clauses.length - 1];
                if (previous && privacyListClause.test(previous) &&
                    privacyListClause.test(clause) &&
                    previous.length + clause.length <= 120) {
                    clauses[clauses.length - 1] = `${previous}、${clause}`;
                    continue;
                }
                // “然后/接着”延续前一动作，不把主体介绍和后续要求机械拆开。
                // “随后”保留独立 clause，避免前句的安全否定错误支配后续动作。
                if (previous && /^(?:然后|接着)/.test(clause) &&
                    previous.length + clause.length <= 120) {
                    clauses[clauses.length - 1] = `${previous}，${clause}`;
                } else {
                    clauses.push(clause);
                }
            }
            for (let index = 0; index < clauses.length; index += 1) {
                const clause = clauses[index];
                const previousClause = clauses[index - 1] || '';
                const nextClause = clauses[index + 1] || '';
                const thirdClause = clauses[index + 2] || '';
                const fourthClause = clauses[index + 3] || '';
                const afterFourthClause = clauses[index + 4] || '';
                const followedBySafety = safetyFollowUp.test(nextClause);
                const precededBySafety = safetyLead.test(previousClause);
                const precededByDescription = descriptiveLead.test(previousClause);

                if (clause.length <= 120) {
                    addCandidate(
                        clause,
                        followedBySafety,
                        precededBySafety,
                        precededByDescription,
                        sentenceIsDescriptive
                    );
                } else {
                    // 长分句使用重叠窗口，仍保持轻量并覆盖窗口边界上的短语。
                    for (let offset = 0; offset < clause.length; offset += 80) {
                        addCandidate(
                            clause.slice(offset, offset + 120),
                            followedBySafety,
                            precededBySafety,
                            precededByDescription,
                            sentenceIsDescriptive
                        );
                    }
                }

                if (nextClause && clause.length + nextClause.length <= 160) {
                    addCandidate(
                        `${clause}，${nextClause}`,
                        safetyFollowUp.test(nextClause) || safetyFollowUp.test(thirdClause),
                        precededBySafety,
                        precededByDescription,
                        sentenceIsDescriptive
                    );
                }

                if (nextClause && thirdClause &&
                    clause.length + nextClause.length + thirdClause.length <= 190) {
                    addCandidate(
                        `${clause}，${nextClause}，${thirdClause}`,
                        safetyFollowUp.test(nextClause) ||
                            safetyFollowUp.test(thirdClause) ||
                            safetyFollowUp.test(fourthClause),
                        precededBySafety,
                        precededByDescription,
                        sentenceIsDescriptive
                    );
                }

                if (nextClause && thirdClause && fourthClause &&
                    clause.length + nextClause.length + thirdClause.length +
                        fourthClause.length <= 220) {
                    addCandidate(
                        `${clause}，${nextClause}，${thirdClause}，${fourthClause}`,
                        safetyFollowUp.test(nextClause) ||
                            safetyFollowUp.test(thirdClause) ||
                            safetyFollowUp.test(fourthClause) ||
                            safetyFollowUp.test(afterFourthClause),
                        precededBySafety,
                        precededByDescription,
                        sentenceIsDescriptive
                    );
                }
            }
        }

        const strangerSubject = /(?:陌生人|陌生网友|网友|不认识的人|陌生账号|这个账号|该账号|某账号|陌生客服|客服冒充|冒充(?:客服|平台|老师|银行)(?:的)?(?:陌生人|账号)?)/;
        const sensitiveData = /(?:家庭住址|家庭地址|住址|地址|手机号|手机号码|电话号码|验证码|密码|家庭信息)/;
        const privacySolicitation = /(?:索取|骗取|套取|诱导|哄骗|要求|让|叫)|(?:催|催促)(?:你|您|孩子|儿童)|(?:发给|告诉)(?:我|他|她|对方|这个账号|该账号|某账号)/;
        const privacyOutboundAction = /(?:发给|发送给|提供给|提交给|传给)(?:我|他|她|对方|这个账号|该账号|某账号|陌生账号)?|私发(?:给(?:我|他|她|对方))?(?:过去)?|(?:发送|提供|告诉|提交|传)(?:过去)?|把[^。！？!?；;\r\n]{0,32}(?:发|发送|提供|提交|传)(?:给|过去)?/;
        const privacyPrevention = /(?:请勿|切勿|不要|不得|不应|禁止|拒绝|避免|防止)[^。！？!?；;\r\n]{0,24}(?:向|给)(?:陌生人|陌生网友|网友|不认识的人|陌生账号)[^。！？!?；;\r\n]{0,18}(?:发送|提供|告诉|发给|透露|私发|提交|传)/;
        const privacyWarningDescription = /(?:陌生人|陌生网友|网友)[^。！？!?；;\r\n]{0,8}会(?:要求|索取)[^。！？!?；;\r\n]{0,32}(?:发送|提供|告诉|私发|发给|交给|透露)|(?:可能是|可能属于|是|属于)[^。！？!?；;\r\n]{0,8}(?:诈骗|骗局)/;

        const gamblingSubject = /(?:赌博|博彩|下注|赌场)/;
        const gamblingDirection = /(?:高额返利|充值返利|稳赚|赚取|送彩金)|(?:诱导|邀请|招揽|要求|让)[^。！？!?；;\r\n]{0,20}(?:充值|参与|参加|加入|下注|投注)|(?:马上|立即|点击|注册)?(?:充值(?:后|即可)?)?(?:马上|立即)?(?:参与|参加|加入|下注|投注)/;
        const gamblingPrevention = /(?:(?:请勿|切勿)(?!错过)|不要(?!错过|犹豫|告诉|告知)|不得|不应|禁止|避免|防止|远离|预防)[^，,。！？!?；;\n]{0,24}(?:参与|加入|下注|投注|充值)|(?:赌博|博彩)[^，,。！？!?；;\n]{0,30}(?:会|可能|容易)?(?:危害|伤害)|(?:赌博|博彩|返利)[^，,。！？!?；;\n]{0,20}(?:是|属于)[^，,。！？!?；;\n]{0,8}(?:骗局|诈骗|违法)/;
        const gamblingWarningDescription = /(?:常以|经常以|往往以|可能以|会以)[^，,。！？!?；;\n]{0,24}(?:返利|奖励|诱导|充值|下注)/;
        const gamblingDescriptiveContext = /(?:警方|媒体|学校|记者|新闻机构|研究报告)[^。！？!?；;\r\n]{0,36}(?:通报|调查|报道|公布|分析|介绍|记录|典型案例|提醒|教育)/;

        const paymentAction = /(?:转账|转钱|打钱|汇款|付款|转给|付给)/;
        const secrecyDirection = /(?:私下|偷偷|瞒着|不要告诉|别告诉|不告诉|不要让(?:父母|家长|老师|监护人)[^。！？!?；;\r\n]{0,6}知道)/;
        const guardianTarget = /(?:父母|家长|老师|监护人)/;
        const transferTarget = /(?:给|转给|付给)(?:我|他|她|这个账号|该账号|某账号|陌生账号)|(?:汇到|汇款到|转到|打到|付到|向)(?:这个|该|某|陌生)?(?:账号|账户)/;
        const transferInstruction = /(?:要求|让|叫|请|马上|立即|先|随后|不要犹豫)[^。！？!?；;\r\n]{0,24}(?:转账|转钱|打钱|汇款|付款|转给)|(?:把钱|将钱)[^。！？!?；;\r\n]{0,20}(?:转账|转钱|打钱|汇款|付款)/;
        const concealmentInstruction = /(?:不要告诉|别告诉|不告诉|不要让(?:父母|家长|老师|监护人)[^。！？!?；;\r\n]{0,6}知道)/;
        const transferPrevention = /(?:请勿|切勿|禁止|避免|不得|不应|不要(?!告诉|告知|让(?:父母|家长|老师|监护人)[^。！？!?；;\r\n]{0,6}知道|错过|犹豫))[^。！？!?；;\r\n]{0,28}(?:私下|偷偷)?(?:转账|转钱|打钱|汇款|付款|转给)/;

        const gameSubject = /(?:网络游戏|手游|游戏账号|游戏充值|游戏)/;
        const gamePaymentAction = /(?:充值|充钱|付费|购买(?:道具|点券)|充(?:几百|几千|上千|上万)(?:元)?)/;
        const gamePrevention = /(?:请勿|切勿|禁止|避免|防止|预防|不得|不应|无需|不需要|不要(?!告诉|告知|让(?:父母|家长|老师|监护人)[^。！？!?；;\r\n]{0,6}知道|错过|犹豫))[^。！？!?；;\r\n]{0,40}(?:充值|充钱|付费|购买(?:道具|点券)|充(?:几百|几千|上千|上万)(?:元)?)/;
        const highGamePayment = /(?:高额|大量|巨额)(?:游戏|手游)?(?:充值|充钱|付费|购买(?:道具|点券))|(?:充值|充钱|充)(?:几百|几千|上千|上万)(?:元)?/;
        const covertGameDirection = /(?:偷偷|私下|瞒着(?:父母|家长|老师|监护人|家里)|不要告诉(?:父母|家长|老师|监护人)|别告诉(?:父母|家长|老师|监护人)|不要让(?:父母|家长|老师|监护人)[^。！？!?；;\r\n]{0,6}知道)/;
        const bypassGameControl = /绕过(?:家长|父母|家庭)?(?:监管|限制)/;
        const induceMinorPayment = /(?:诱导|要求|鼓动)(?:未成年人|儿童|孩子)[^。！？!?；;\r\n]{0,24}(?:充值|充钱|付费|购买(?:道具|点券))/;
        const gameDescriptiveContext = /(?:警方|媒体|学校|记者|新闻机构|新闻|研究报告)[^。！？!?；;\r\n]{0,40}(?:通报|调查|报道|公布|分析|介绍|记录|案例|纠纷|提醒|教育)/;

        for (const candidate of candidates) {
            const part = candidate.text;
            const isDirectDangerAction = hasDirectDangerAction(part);
            const hasPrivacyWarningContext = candidate.hasSafetyLead ||
                candidate.hasSafetyFollowUp ||
                /^(?:请)?(?:警惕|谨防|防范)[，,]/.test(part);

            if (strangerSubject.test(part) && sensitiveData.test(part) &&
                (privacySolicitation.test(part) || isDirectDangerAction) &&
                privacyOutboundAction.test(part) &&
                !privacyPrevention.test(part) &&
                !(candidate.isDescriptiveContext && !isDirectDangerAction) &&
                !(hasPrivacyWarningContext && privacyWarningDescription.test(part))) {
                return '索取隐私或验证信息';
            }
            if (gamblingSubject.test(part) && gamblingDirection.test(part) &&
                !gamblingPrevention.test(part) &&
                !((candidate.isDescriptiveContext || candidate.hasDescriptiveLead ||
                    gamblingDescriptiveContext.test(part)) &&
                    !isDirectDangerAction) &&
                !(candidate.hasSafetyFollowUp && gamblingWarningDescription.test(part))) {
                return '博彩赌博诱导';
            }
            if (paymentAction.test(part) && secrecyDirection.test(part) &&
                guardianTarget.test(part) &&
                (transferTarget.test(part) || transferInstruction.test(part) ||
                    concealmentInstruction.test(part)) &&
                !(candidate.isDescriptiveContext && !isDirectDangerAction) &&
                !transferPrevention.test(part)) {
                return '隐瞒或私下资金诱导';
            }
            const hasGamePaymentTopic = gameSubject.test(part) ||
                /(?:充值|充钱|充(?:几百|几千|上千|上万)(?:元)?|购买(?:道具|点券))/.test(part);
            if (hasGamePaymentTopic && gamePaymentAction.test(part) &&
                (highGamePayment.test(part) || covertGameDirection.test(part) ||
                    bypassGameControl.test(part) || induceMinorPayment.test(part)) &&
                !((candidate.isDescriptiveContext || candidate.hasDescriptiveLead ||
                    gameDescriptiveContext.test(part)) &&
                    !isDirectDangerAction) &&
                !gamePrevention.test(part)) {
                return '高额充值或绕过监管';
            }
        }
        return '';
    }

    // 检查当前页面的网站类型
    function getSiteType(url) {
        const lowerUrl = url.toLowerCase();
        const decodedUrl = getDecodedChildRuleUrl(url);
        console.log('👶 [getSiteType] URL:', lowerUrl);
        console.log('👶 [getSiteType] 游戏网站列表:', CHILD_MODE_CONFIG.gameSites);

        const childDemoType = getChildDemoSiteType(url);
        if (childDemoType) {
            return childDemoType === 'dangerous'
                ? {
                    type: 'dangerous',
                    keyword: '本地危险内容演示',
                    isChildDemo: true
                }
                : {
                    type: childDemoType,
                    site: '本地儿童模式演示页',
                    isChildDemo: true
                };
        }
        
        // 首先检查危险演示页面
        const dangerType = getDangerType();
        if (dangerType) {
            return { type: 'dangerous', keyword: dangerType };
        }
        
        // 检查危险关键词
        const dangerousKeywords = getChildRuleList(
            'dangerousSites',
            CHILD_MODE_CONFIG.dangerousKeywords
        );
        for (const keyword of dangerousKeywords) {
            if (decodedUrl.includes(keyword)) {
                return { type: 'dangerous', keyword: keyword };
            }
        }
        
        // 检查游戏网站
        for (const site of CHILD_MODE_CONFIG.gameSites) {
            if (lowerUrl.includes(site)) {
                console.log('👶 [getSiteType] 检测到游戏网站:', site);
                return { type: 'game', site: site };
            }
        }
        
        // 检查娱乐网站
        const entertainmentSites = getChildRuleList(
            'entertainmentSites',
            CHILD_MODE_CONFIG.entertainmentSites
        );
        for (const site of entertainmentSites) {
            if (childRuleMatchesDomain(url, site)) {
                return { type: 'entertainment', site: site };
            }
        }
        
        // 检查学习网站（优先使用用户保存的白名单）
        const learningWhitelist = getChildRuleList(
            'learningWhitelist',
            CHILD_MODE_CONFIG.learningWhitelist
        );
        for (const site of learningWhitelist) {
            if (childRuleMatchesDomain(url, site)) {
                return { type: 'learning', site: site };
            }
        }
        
        return { type: 'normal' };
    }

    // 显示儿童模式顶部横幅
    function showChildModeBanner(type) {
        // 如果已经存在，先移除
        removeChildModeBanner();
        
        const banner = document.createElement('div');
        banner.id = 'netguard-child-banner';
        
        let bannerContent = '';
        let bannerStyle = '';
        
        switch (type) {
            case 'learning':
                bannerContent = `
                    <div class="netguard-child-banner-icon">✅</div>
                    <div class="netguard-child-banner-text">
                        <div class="netguard-child-banner-title">儿童模式</div>
                        <div class="netguard-child-banner-subtitle">已允许学习网站访问</div>
                    </div>
                    <button class="netguard-child-banner-close" id="netguard-child-banner-close-btn">×</button>
                `;
                bannerStyle = 'bg-green';
                break;
            case 'entertainment':
                bannerContent = `
                    <div class="netguard-child-banner-icon">⏳</div>
                    <div class="netguard-child-banner-text">
                        <div class="netguard-child-banner-title">儿童模式</div>
                        <div class="netguard-child-banner-subtitle">娱乐网站已限制访问</div>
                    </div>
                    <button class="netguard-child-banner-close" id="netguard-child-banner-close-btn">×</button>
                `;
                bannerStyle = 'bg-yellow';
                break;
            case 'game':
            case 'dangerous':
                return; // 这些类型显示全屏拦截，不需要横幅
            default:
                bannerContent = `
                    <div class="netguard-child-banner-icon">👶</div>
                    <div class="netguard-child-banner-text">
                        <div class="netguard-child-banner-title">儿童保护模式</div>
                        <div class="netguard-child-banner-subtitle">守护孩子的网络安全</div>
                    </div>
                    <button class="netguard-child-banner-close" id="netguard-child-banner-close-btn">×</button>
                `;
                bannerStyle = 'bg-blue';
        }
        
        banner.className = `netguard-child-banner ${bannerStyle}`;
        banner.innerHTML = bannerContent;
        
        // 添加样式
        const style = document.createElement('style');
        style.textContent = `
            .netguard-child-banner {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                z-index: 999999;
                padding: 10px 20px;
                display: flex;
                align-items: center;
                gap: 12px;
                box-shadow: 0 2px 15px rgba(0,0,0,0.15);
                animation: slideDownBanner 0.4s ease;
            }
            .netguard-child-banner.bg-green {
                background: linear-gradient(135deg, #10b981, #059669);
            }
            .netguard-child-banner.bg-yellow {
                background: linear-gradient(135deg, #f59e0b, #d97706);
            }
            .netguard-child-banner.bg-blue {
                background: linear-gradient(135deg, #3b82f6, #2563eb);
            }
            .netguard-child-banner-icon {
                font-size: 24px;
            }
            .netguard-child-banner-text {
                flex: 1;
            }
            .netguard-child-banner-title {
                color: white;
                font-weight: 700;
                font-size: 14px;
            }
            .netguard-child-banner-subtitle {
                color: rgba(255,255,255,0.9);
                font-size: 12px;
                margin-top: 2px;
            }
            .netguard-child-banner-close {
                background: rgba(255,255,255,0.2);
                border: none;
                border-radius: 50%;
                width: 28px;
                height: 28px;
                color: white;
                font-size: 18px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s;
            }
            .netguard-child-banner-close:hover {
                background: rgba(255,255,255,0.3);
            }
            @keyframes slideDownBanner {
                from { transform: translateY(-100%); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }
            body {
                padding-top: 50px !important;
            }
        `;
        document.head.appendChild(style);
        
        document.body.insertBefore(banner, document.body.firstChild);
        
        // 添加关闭事件
        document.getElementById('netguard-child-banner-close-btn').addEventListener('click', () => {
            removeChildModeBanner();
        });
        
        if (AI_DEBUG) console.log(`👶 [儿童模式] 显示${type}类型横幅`);
    }

    // 移除儿童模式横幅
    function removeChildModeBanner() {
        const banner = document.getElementById('netguard-child-banner');
        if (banner) {
            banner.style.animation = 'slideUpBanner 0.3s ease';
            setTimeout(() => banner.remove(), 300);
        }
    }

    const CHILD_BROWSING_REMINDER_ID = 'netguard-child-browsing-reminder';
    const CHILD_BROWSING_REMINDER_STYLE_ID = 'netguard-child-browsing-reminder-style';

    function removeChildBrowsingReminder(immediate = false) {
        if (childBrowsingReminderTimer) {
            clearTimeout(childBrowsingReminderTimer);
            childBrowsingReminderTimer = null;
        }
        const reminder = document.getElementById(CHILD_BROWSING_REMINDER_ID);
        const removeReminderResources = () => {
            reminder?.remove();
            document.getElementById(CHILD_BROWSING_REMINDER_STYLE_ID)?.remove();
        };
        if (!reminder) {
            if (immediate) removeReminderResources();
            return;
        }
        if (immediate) {
            removeReminderResources();
            return;
        }
        reminder.style.opacity = '0';
        reminder.style.transform = 'translateY(-10px)';
        setTimeout(removeReminderResources, 300);
    }

    function ensureChildBrowsingReminderStyle() {
        if (document.getElementById(CHILD_BROWSING_REMINDER_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = CHILD_BROWSING_REMINDER_STYLE_ID;
        style.textContent = `
            #${CHILD_BROWSING_REMINDER_ID} {
                position: fixed !important;
                top: 18px !important;
                right: 18px !important;
                z-index: 2147483646 !important;
                width: min(360px, calc(100vw - 36px)) !important;
                box-sizing: border-box !important;
                padding: 14px 44px 14px 16px !important;
                border: 1px solid #fbbf24 !important;
                border-radius: 12px !important;
                background: #fffbeb !important;
                color: #78350f !important;
                box-shadow: 0 10px 30px rgba(0,0,0,.18) !important;
                font: 14px/1.6 "Microsoft YaHei", sans-serif !important;
                transition: opacity .3s ease, transform .3s ease !important;
            }
            #${CHILD_BROWSING_REMINDER_ID} strong {
                display: block !important;
                margin-bottom: 2px !important;
                font-size: 15px !important;
            }
            #${CHILD_BROWSING_REMINDER_ID} button {
                position: absolute !important;
                top: 8px !important;
                right: 8px !important;
                width: 28px !important;
                height: 28px !important;
                padding: 0 !important;
                border: 0 !important;
                border-radius: 50% !important;
                background: transparent !important;
                color: #92400e !important;
                font-size: 20px !important;
                cursor: pointer !important;
            }
        `;
        (document.head || document.documentElement)?.appendChild(style);
    }

    function showChildBrowsingReminder(cycleId) {
        if (!IS_TOP_FRAME || !document.body) return false;
        const existing = document.getElementById(CHILD_BROWSING_REMINDER_ID);
        if (existing) return true;

        ensureChildBrowsingReminderStyle();
        const reminder = document.createElement('div');
        reminder.id = CHILD_BROWSING_REMINDER_ID;
        reminder.setAttribute('role', 'status');
        reminder.setAttribute('aria-live', 'polite');
        reminder.dataset.cycleId = String(cycleId || '');
        reminder.innerHTML = `
            <strong>休息提醒</strong>
            <span>你已经连续浏览一段时间啦，建议休息一下眼睛，活动几分钟再继续。</span>
            <button type="button" aria-label="关闭休息提醒">×</button>
        `;
        reminder.querySelector('button')?.addEventListener('click', () => {
            removeChildBrowsingReminder();
        });
        document.body.appendChild(reminder);
        childBrowsingReminderTimer = setTimeout(() => {
            removeChildBrowsingReminder();
        }, 8000);
        return true;
    }

    function getChildBrowsingDateKey(timestamp = Date.now()) {
        const date = new Date(timestamp);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function isChildBrowsingLimitReachedToday() {
        return Boolean(
            childBrowsingLimitState?.limitReached &&
            childBrowsingLimitState.dateKey === getChildBrowsingDateKey()
        );
    }

    function applyChildBrowsingLimitState() {
        if (
            !IS_TOP_FRAME ||
            !isChildMode ||
            !childModeEnabled ||
            shouldSkipChildProtection() ||
            !isChildBrowsingLimitReachedToday()
        ) {
            return false;
        }

        return showChildBrowsingLimitBlocker();
    }

    extensionAPI.runtime.onMessage?.addListener((message, sender, sendResponse) => {
        if (
            ![
                'NETGUARD_CHILD_BROWSING_REMINDER',
                'NETGUARD_CHILD_BROWSING_LIMIT_REACHED'
            ].includes(message?.type)
        ) {
            return false;
        }
        try {
            let shown;
            if (message.type === 'NETGUARD_CHILD_BROWSING_LIMIT_REACHED') {
                childBrowsingLimitState = {
                    ...(childBrowsingLimitState || {}),
                    dateKey: message.dateKey || getChildBrowsingDateKey(),
                    limitReached: true
                };
                shown = applyChildBrowsingLimitState();
            } else {
                shown = showChildBrowsingReminder(message.cycleId);
            }
            sendResponse?.({ shown });
        } catch (error) {
            console.warn('[儿童浏览提醒] 显示失败:', error.message);
            sendResponse?.({ shown: false });
        }
        return false;
    });

    function ensureChildModeBlockerStyles() {
        if (document.getElementById('netguard-child-blocker-styles')) return;

        const style = document.createElement('style');
        style.id = 'netguard-child-blocker-styles';
        style.textContent = `
            .netguard-child-overlay {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0,0,0,0.6);
                z-index: 999999;
                display: flex;
                align-items: center;
                justify-content: center;
                animation: fadeInOverlay 0.3s ease;
            }
            .netguard-child-popup {
                background: white;
                border-radius: 24px;
                padding: 40px;
                max-width: 420px;
                width: 90%;
                text-align: center;
                animation: scaleInPopup 0.4s ease;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            }
            .netguard-child-popup.entertainment {
                border-top: 6px solid #f59e0b;
            }
            .netguard-child-popup.game {
                border-top: 6px solid #ef4444;
            }
            .netguard-child-popup.dangerous {
                border-top: 6px solid #dc2626;
            }
            .netguard-child-popup-icon {
                font-size: 64px;
                margin-bottom: 20px;
            }
            .netguard-child-popup-title {
                font-size: 24px;
                font-weight: 700;
                color: #1f2937;
                margin-bottom: 8px;
            }
            .netguard-child-popup-subtitle {
                font-size: 16px;
                color: #f59e0b;
                font-weight: 600;
                margin-bottom: 16px;
            }
            .netguard-child-popup-desc {
                font-size: 14px;
                color: #6b7280;
                line-height: 1.6;
                margin-bottom: 24px;
            }
            .netguard-child-popup-desc strong {
                color: #374151;
            }
            .netguard-child-popup-actions {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .netguard-child-btn {
                padding: 14px 28px;
                border-radius: 12px;
                font-size: 15px;
                font-weight: 600;
                cursor: pointer;
                border: none;
                transition: all 0.3s;
            }
            .netguard-child-btn-primary {
                background: linear-gradient(135deg, #f59e0b, #d97706);
                color: white;
            }
            .netguard-child-btn-primary:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 25px rgba(245, 158, 11, 0.4);
            }
            .netguard-child-btn-secondary {
                background: rgba(156, 163, 175, 0.2);
                color: #6b7280;
            }
            .netguard-child-btn-secondary:hover {
                background: rgba(156, 163, 175, 0.3);
            }
            .netguard-child-popup-footer {
                margin-top: 20px;
                font-size: 12px;
                color: #9ca3af;
            }
            @keyframes fadeInOverlay {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes scaleInPopup {
                from { transform: scale(0.9); opacity: 0; }
                to { transform: scale(1); opacity: 1; }
            }
        `;
        document.head.appendChild(style);
    }

    function showChildBrowsingLimitBlocker() {
        if (!IS_TOP_FRAME || !document.body) return false;
        const existingPopup = document.getElementById('netguard-child-popup');
        if (existingPopup?.dataset.childBrowsingLimit === 'true') {
            return true;
        }

        clearChildModeUi();
        ensureChildModeBlockerStyles();

        const overlay = document.createElement('div');
        overlay.id = 'netguard-child-overlay';
        overlay.className = 'netguard-child-overlay';
        overlay.style.zIndex = '2147483646';

        const popup = document.createElement('div');
        popup.id = 'netguard-child-popup';
        popup.className = 'netguard-child-popup dangerous';
        popup.dataset.childBrowsingLimit = 'true';
        popup.innerHTML = `
            <div class="netguard-child-popup-icon">⏰</div>
            <div class="netguard-child-popup-title">今日浏览时间已达到上限</div>
            <div class="netguard-child-popup-subtitle" style="color: #dc2626;">儿童模式已暂停继续浏览</div>
            <div class="netguard-child-popup-desc">
                请休息眼睛并离开当前页面。新的日期开始后，浏览时间会自动重新计算。
            </div>
            <div class="netguard-child-popup-footer">
                如需处理设置，请由监护人在扩展面板中切换模式。
            </div>
        `;

        overlay.appendChild(popup);
        document.body.appendChild(overlay);
        activeChildPolicyKey = `browsing-limit:${childBrowsingLimitState?.dateKey || ''}`;
        return true;
    }

    // 显示娱乐网站限制弹窗
    function showEntertainmentBlocker(site) {
        // 如果已经存在，先移除
        removeChildModeOverlay();
        ensureChildModeBlockerStyles();

        const overlay = document.createElement('div');
        overlay.id = 'netguard-child-overlay';
        overlay.className = 'netguard-child-overlay';

        const popup = document.createElement('div');
        popup.id = 'netguard-child-popup';
        popup.className = 'netguard-child-popup entertainment';

        popup.innerHTML = `
            <div class="netguard-child-popup-icon">🎮</div>
            <div class="netguard-child-popup-title">娱乐时间限制</div>
            <div class="netguard-child-popup-subtitle">当前为学习模式</div>
            <div class="netguard-child-popup-desc">
                您正在访问的网站 <strong>${site}</strong> 属于娱乐类网站。
                在学习模式下，娱乐网站已被限制访问。
            </div>
            <div class="netguard-child-popup-actions">
                <button class="netguard-child-btn netguard-child-btn-primary" id="netguard-child-request-btn">
                    📝 申请继续访问
                </button>
                <button class="netguard-child-btn netguard-child-btn-secondary" id="netguard-child-back-btn">
                    ← 返回学习页面
                </button>
            </div>
            <div class="netguard-child-popup-footer">
                建议完成学习后再进行娱乐活动哦~
            </div>
        `;
        
        document.body.appendChild(overlay);
        document.body.appendChild(popup);
        
        // 添加事件
        document.getElementById('netguard-child-request-btn').addEventListener('click', () => {
            showAccessRequestDialog();
        });
        
        document.getElementById('netguard-child-back-btn').addEventListener('click', () => {
            window.history.back();
            removeChildModeOverlay();
        });
        
        if (AI_DEBUG) console.log(`👶 [儿童模式] 显示娱乐网站限制弹窗: ${site}`);
    }

    // 显示访问申请对话框
    function showAccessRequestDialog() {
        removeChildModeOverlay();
        
        const overlay = document.createElement('div');
        overlay.id = 'netguard-child-overlay';
        overlay.className = 'netguard-child-overlay';
        
        const popup = document.createElement('div');
        popup.id = 'netguard-child-popup';
        popup.className = 'netguard-child-popup';
        
        popup.innerHTML = `
            <div class="netguard-child-popup-icon">📝</div>
            <div class="netguard-child-popup-title">申请访问权限</div>
            <div class="netguard-child-popup-subtitle">请输入申请原因</div>
            <textarea class="netguard-child-request-textarea" id="netguard-child-request-reason" placeholder="请说明您为什么需要访问此网站..."></textarea>
            <div class="netguard-child-popup-actions">
                <button class="netguard-child-btn netguard-child-btn-primary" id="netguard-child-submit-btn">
                    提交申请
                </button>
                <button class="netguard-child-btn netguard-child-btn-secondary" id="netguard-child-cancel-btn">
                    取消
                </button>
            </div>
        `;
        
        document.body.appendChild(overlay);
        document.body.appendChild(popup);
        
        document.getElementById('netguard-child-submit-btn').addEventListener('click', () => {
            showRequestSubmitted();
        });
        
        document.getElementById('netguard-child-cancel-btn').addEventListener('click', () => {
            removeChildModeOverlay();
            showEntertainmentBlocker('娱乐网站');
        });
        
        if (AI_DEBUG) console.log('👶 [儿童模式] 显示访问申请对话框');
    }

    // 显示申请提交成功
    function showRequestSubmitted() {
        removeChildModeOverlay();
        
        const overlay = document.createElement('div');
        overlay.id = 'netguard-child-overlay';
        overlay.className = 'netguard-child-overlay';
        
        const popup = document.createElement('div');
        popup.id = 'netguard-child-popup';
        popup.className = 'netguard-child-popup';
        
        popup.innerHTML = `
            <div class="netguard-child-popup-icon">✅</div>
            <div class="netguard-child-popup-title">申请已提交</div>
            <div class="netguard-child-popup-desc" style="margin-top: 16px;">
                您的访问申请已提交给家长，<br>
                请等待家长审批后再访问。
            </div>
            <div class="netguard-child-popup-actions">
                <button class="netguard-child-btn netguard-child-btn-primary" id="netguard-child-ok-btn">
                    好的，我知道了
                </button>
            </div>
        `;
        
        document.body.appendChild(overlay);
        document.body.appendChild(popup);
        
        document.getElementById('netguard-child-ok-btn').addEventListener('click', () => {
            window.history.back();
            removeChildModeOverlay();
        });
        
        if (AI_DEBUG) console.log('👶 [儿童模式] 显示申请提交成功');
    }

    function getGameBlockerExitAction(url) {
        try {
            const parsed = new URL(url);
            if (getChildDemoSiteType(parsed.href) === 'game') {
                return {
                    label: '← 返回演示主页',
                    target: new URL('child_demo_home.html', parsed).href
                };
            }
        } catch (_) {
            // 非法 URL 统一使用安全空白页退出。
        }

        return {
            label: '← 离开此网站',
            target: 'about:blank'
        };
    }

    // 显示游戏网站拦截页面
    function showGameBlocker(site) {
        // 如果已经存在，先移除
        removeChildModeOverlay();
        ensureChildModeBlockerStyles();
        const exitAction = getGameBlockerExitAction(window.location.href);
        
        const overlay = document.createElement('div');
        overlay.id = 'netguard-child-overlay';
        overlay.className = 'netguard-child-overlay';
        
        const popup = document.createElement('div');
        popup.id = 'netguard-child-popup';
        popup.className = 'netguard-child-popup game';
        
        popup.innerHTML = `
            <div class="netguard-child-popup-icon">🚫</div>
            <div class="netguard-child-popup-title">游戏网站拦截</div>
            <div class="netguard-child-popup-subtitle" style="color: #ef4444;">当前为学习模式</div>
            <div class="netguard-child-popup-desc">
                您正在访问的网站 <strong>${site}</strong> 属于游戏类网站。
                在学习模式下，游戏网站已被禁止访问。
            </div>
            <div class="netguard-child-tips">
                <div class="netguard-child-tip">📚 建议先完成今日学习任务</div>
                <div class="netguard-child-tip">⏰ 学习30分钟后可休息娱乐</div>
                <div class="netguard-child-tip">👨‍👩‍👧 如需访问请联系家长</div>
            </div>
            <div class="netguard-child-popup-actions">
                <button class="netguard-child-btn netguard-child-btn-secondary" id="netguard-child-back-btn">
                    ${exitAction.label}
                </button>
            </div>
            <div class="netguard-child-popup-footer">
                学习时间，专注成长 💪
            </div>
        `;
        
        // 添加样式
        const style = document.createElement('style');
        style.textContent = `
            .netguard-child-tips {
                background: rgba(239, 68, 68, 0.05);
                border-radius: 12px;
                padding: 16px;
                margin-bottom: 20px;
            }
            .netguard-child-tip {
                font-size: 13px;
                color: #374151;
                padding: 6px 0;
            }
        `;
        document.head.appendChild(style);
        
        overlay.appendChild(popup);
        document.body.appendChild(overlay);
        
        document.getElementById('netguard-child-back-btn').addEventListener('click', () => {
            window.location.replace(exitAction.target);
        });
        
        if (AI_DEBUG) console.log(`👶 [儿童模式] 显示游戏网站拦截: ${site}`);
    }

    // 显示危险网站拦截页面
    function showDangerousBlocker(keyword) {
        // 如果已经存在，先移除
        removeChildModeOverlay();
        
        const overlay = document.createElement('div');
        overlay.id = 'netguard-child-overlay';
        overlay.className = 'netguard-child-overlay';
        
        const popup = document.createElement('div');
        popup.id = 'netguard-child-popup';
        popup.className = 'netguard-child-popup dangerous';
        
        popup.innerHTML = `
            <div class="netguard-child-popup-icon">⚠️</div>
            <div class="netguard-child-popup-title">危险网站拦截</div>
            <div class="netguard-child-popup-subtitle" style="color: #dc2626;">检测到高风险内容</div>
            <div class="netguard-child-popup-desc">
                此网站检测到危险关键词: <strong>${keyword}</strong>
                <br><br>
                该网站可能包含不良信息，已被自动拦截。
            </div>
            <div class="netguard-child-warning">
                <div class="netguard-child-warning-item">🔴 可能包含色情内容</div>
                <div class="netguard-child-warning-item">🔴 可能涉及赌博诈骗</div>
                <div class="netguard-child-warning-item">🔴 可能存在恶意软件</div>
            </div>
            <div class="netguard-child-popup-actions">
                <button class="netguard-child-btn netguard-child-btn-danger" id="netguard-child-leave-btn">
                    🚪 立即离开
                </button>
            </div>
            <div class="netguard-child-popup-footer">
                保护儿童上网安全，人人有责 🛡️
            </div>
        `;
        
        // 添加样式
        const style = document.createElement('style');
        style.textContent = `
            .netguard-child-warning {
                background: rgba(220, 38, 38, 0.08);
                border-radius: 12px;
                padding: 16px;
                margin-bottom: 20px;
            }
            .netguard-child-warning-item {
                font-size: 13px;
                color: #dc2626;
                padding: 6px 0;
            }
            .netguard-child-btn-danger {
                background: linear-gradient(135deg, #dc2626, #ef4444);
                color: white;
            }
            .netguard-child-btn-danger:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 25px rgba(220, 38, 38, 0.4);
            }
        `;
        document.head.appendChild(style);
        
        document.body.appendChild(overlay);
        document.body.appendChild(popup);
        
        document.getElementById('netguard-child-leave-btn').addEventListener('click', () => {
            window.history.back();
            removeChildModeOverlay();
        });
        
        if (AI_DEBUG) console.log(`👶 [儿童模式] 显示危险网站拦截: ${keyword}`);
    }

    // 移除儿童模式弹窗
    function removeChildModeOverlay() {
        const overlay = document.getElementById('netguard-child-overlay');
        const popup = document.getElementById('netguard-child-popup');
        
        if (overlay) {
            overlay.style.animation = 'fadeInOverlay 0.3s ease reverse';
            setTimeout(() => overlay.remove(), 300);
        }
        if (popup) {
            popup.style.animation = 'scaleInPopup 0.3s ease reverse';
            setTimeout(() => popup.remove(), 300);
        }
    }

    // 检查是否为系统页面
    function checkSystemPage(url) {
        const lowerUrl = url.toLowerCase();
        // 跳过 localhost 页面
        if (lowerUrl.includes('localhost') || lowerUrl.startsWith('http://127.0.0.1')) {
            return true;
        }
        // 跳过 Edge 内置页面
        if (lowerUrl.startsWith('edge://') || lowerUrl.startsWith('chrome://')) {
            return true;
        }
        // 跳过扩展页面
        if (lowerUrl.startsWith('chrome-extension://') || lowerUrl.startsWith('moz-extension://')) {
            return true;
        }
        return false;
    }

    function resolveChildPolicyType(siteInfo) {
        switch (siteInfo.type) {
            case 'dangerous':
                return isChildPolicyEnabled('dangerousFilter')
                    ? 'dangerous'
                    : 'none';
            case 'entertainment':
                return isChildPolicyEnabled('entertainmentLimit')
                    ? 'entertainment'
                    : 'none';
            case 'game':
                return (isChildPolicyEnabled('entertainmentLimit') ||
                    isChildPolicyEnabled('learningMode'))
                    ? 'game'
                    : 'none';
            case 'learning':
                return 'learning';
            default:
                return 'normal';
        }
    }

    async function applyChildModePolicy(siteInfo, url) {
        if (
            !IS_TOP_FRAME ||
            shouldSkipChildProtection() ||
            !isChildMode ||
            !childModeEnabled
        ) {
            if (IS_TOP_FRAME) clearChildModeUi();
            return;
        }

        if (applyChildBrowsingLimitState()) {
            return;
        }

        const policyType = resolveChildPolicyType(siteInfo);
        const policyKey = `${url}|${siteInfo.type}|${policyType}`;

        // 同一 document、同一策略重复保存时不重复创建 UI 或写事件。
        if (activeChildPolicyKey === policyKey) {
            return;
        }

        clearChildModeUi();
        activeChildPolicyKey = policyKey;

        switch (policyType) {
            case 'learning':
                showChildModeBanner('learning');
                if (AI_DEBUG) console.log(`👶 [儿童模式] 学习网站: ${siteInfo.site}`);
                break;
            case 'entertainment':
                showChildModeBanner('entertainment');
                showEntertainmentBlocker(siteInfo.site);
                await logEntertainmentBlock(url, `娱乐网站限制: ${siteInfo.site}`);
                if (AI_DEBUG) console.log(`👶 [儿童模式] 娱乐网站: ${siteInfo.site}`);
                break;
            case 'game':
                showGameBlocker(siteInfo.site);
                await logGameBlock(url, `游戏网站拦截: ${siteInfo.site}`);
                if (AI_DEBUG) console.log(`👶 [儿童模式] 游戏网站: ${siteInfo.site}`);
                break;
            case 'dangerous':
                showDangerousBlocker(siteInfo.keyword);
                await logDangerousBlock(url, `危险网站拦截: ${siteInfo.keyword}`);
                if (AI_DEBUG) console.log(`👶 [儿童模式] 危险网站: ${siteInfo.keyword}`);
                break;
            case 'normal':
                showChildModeBanner('normal');
                if (AI_DEBUG) console.log('👶 [儿童模式] 普通网站');
                break;
            default:
                if (AI_DEBUG) {
                    console.log(`👶 [儿童模式] ${siteInfo.type} 高级策略已关闭`);
                }
        }
    }

    // 检查当前网站并应用儿童模式规则
    async function checkChildModeSite() {
        console.log('👶 [儿童模式] 检查网站:', window.location.href);
        console.log('👶 [儿童模式] isChildMode:', isChildMode);
        
        if (!IS_TOP_FRAME || shouldSkipChildProtection() || !isChildMode || !childModeEnabled) {
            console.log('👶 [儿童模式] 未启用，跳过检查');
            if (IS_TOP_FRAME) clearChildModeUi();
            return;
        }


        if (applyChildBrowsingLimitState()) {
            return;
        }
        
        const url = window.location.href;
        
        // 跳过系统页面
        if (checkSystemPage(url)) {
            if (AI_DEBUG) console.log('👶 [儿童模式] 已跳过系统页面');
            return;
        }
        
        let siteInfo = getSiteType(url);
        console.log('👶 [儿童模式] 网站类型:', siteInfo);
        
        // 跳过演示页面（有 data-demo-mode 属性的页面只由插件控制效果）
        if (isDemoModePage() && !siteInfo.isChildDemo) {
            if (AI_DEBUG) console.log('👶 [儿童模式] 跳过演示页面（data-demo-mode）');
            return;
        }
        
        // 跳过演示白名单页面
        if (checkIfDemoPage()) {
            if (AI_DEBUG) console.log('👶 [儿童模式] 跳过演示页面（demo whitelist）');
            return;
        }

        if (siteInfo.type !== 'dangerous' && isChildPolicyEnabled('dangerousFilter')) {
            const keyword = getChildBodyDangerKeyword(extractChildBodyText());
            if (keyword) siteInfo = { type: 'dangerous', keyword };
        }
        
        await applyChildModePolicy(siteInfo, url);
    }

    // ==================== 启动 ====================
    async function initExtension() {
        // 先加载安全模式配置和儿童模式配置
        await loadCurrentMode();
        await loadChildModeSettings();
        
        // 设置监听器
        setupChildModeChangeListener();
        
        // 等待页面加载完成
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', async () => {
                await applyAllSettings();
                // 严格模式也只处理有明确广告证据的 iframe。
                if (currentMode === 'strict') {
                    await hideAllIframes(true);
                    if (AI_DEBUG) console.log('🔒 [严格模式] 已处理明确广告 iframe');
                }
                
                // 儿童模式：检查当前网站
                if (isChildMode) {
                    checkChildModeSite();
                }
            });
        } else {
            await applyAllSettings();
            // 严格模式也不会隐藏视频、登录、验证码或地图 iframe。
            if (currentMode === 'strict') {
                await hideAllIframes(true);
                if (AI_DEBUG) console.log('🔒 [严格模式] 已处理明确广告 iframe');
            }
            
            // 儿童模式：检查当前网站
            if (isChildMode) {
                checkChildModeSite();
            }
        }
    }

    // 启动扩展
    initExtension();

    // ==================== AI文本检测功能 ====================
    function createTimeoutController(timeoutMs) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, timeoutMs);
        return { controller, timeoutId };
    }

    // 本地AI检测规则（作为备用方案）
    const LOCAL_RISK_RULES = {
        high: [
            { words: ['赌博', '赌球', '博彩', 'casino', 'bet', 'gambling'], reason: '检测到赌博相关内容' },
            { words: ['刷单', '刷信誉', '兼职刷单', '网络刷单'], reason: '检测到刷单诈骗内容' },
            { words: ['诈骗', '欺骗', '欺诈', '骗钱', '骗局'], reason: '检测到诈骗相关内容' },
            { words: ['中奖', '免费领取', '幸运抽奖', '大奖', '特等奖'], reason: '检测到虚假中奖内容' },
            { words: ['裸聊', '色情', '性服务'], reason: '检测到色情相关内容' },
            { words: ['转账', '汇款', '打钱', '支付', '银行卡'], reason: '检测到可疑转账请求' },
            { words: ['验证码', '密码', '账号密码', '登录密码'], reason: '检测到敏感信息请求' },
            { words: ['钓鱼', '假冒', '冒充客服', '假冒网站'], reason: '检测到钓鱼攻击特征' },
            { words: ['高收益', '稳赚不赔', '投资返利', '传销'], reason: '检测到非法集资内容' },
            { words: ['紧急通知', '账户异常', '安全中心', '冻结'], reason: '检测到冒充官方诈骗' }
        ],
        medium: [
            { words: ['客服', '退款', '退货', '售后'], reason: '检测到客服相关内容，需谨慎' },
            { words: ['理财', '投资', '股票', '基金'], reason: '检测到金融投资内容' },
            { words: ['红包', '优惠券', '折扣', '特价', '推广', '优惠'], reason: '检测到促销优惠内容' },
            { words: ['兼职', '副业', '赚钱', '日结'], reason: '检测到兼职招聘内容' }
        ],
        low: [
            { words: ['点击', '领取', '查看', '详情', '点击领取'], reason: '检测到诱导点击内容' },
            { words: ['广告', '营销'], reason: '检测到广告营销内容' }
        ]
    };

    // 演示页面风险等级映射
    const DEMO_PAGE_RISK_MAP = {
        'safe.html': { risk: 'safe', score: 0.05, reason: '安全内容，无风险因素' },
        'low.html': { risk: 'low', score: 0.25, reason: '检测到轻微营销推广内容' },
        'medium.html': { risk: 'medium', score: 0.55, reason: '检测到金融投资相关内容，需谨慎' },
        'high.html': { risk: 'high', score: 0.90, reason: '检测到诈骗风险内容' },
        'demo_center.html': { risk: 'safe', score: 0.05, reason: '净网护航功能演示中心' },
        'ai_demo_home.html': { risk: 'safe', score: 0.05, reason: 'AI风险检测演示大厅' },
        'child_demo.html': { risk: 'safe', score: 0.01, reason: '儿童保护模式演示大厅' },
        'child_learning_demo.html': { risk: 'safe', score: 0.01, reason: '学习网站演示页面' },
        'child_entertainment_demo.html': { risk: 'safe', score: 0.01, reason: '娱乐限制演示页面' },
        'child_danger_demo.html': { risk: 'safe', score: 0.01, reason: '危险网站演示页面' },
        'child_blocked.html': { risk: 'safe', score: 0.01, reason: '网站拦截页面' },
        'gambling-demo.html': { risk: 'safe', score: 0.01, reason: 'URL检测演示页面' },
        'porn-demo.html': { risk: 'safe', score: 0.01, reason: 'URL检测演示页面' },
        'phishing-demo.html': { risk: 'safe', score: 0.01, reason: 'URL检测演示页面' }
    };
    
    // 获取演示页面预设的风险等级
    function getDemoPageRisk() {
        const url = window.location.href.toLowerCase();
        
        // 检查页面是否有 data-safe-demo 属性
        const safeDemoElement = document.querySelector('[data-safe-demo="true"]');
        if (safeDemoElement) {
            return { risk: 'safe', score: 0.01, reason: '安全演示页面' };
        }
        
        for (const [page, riskInfo] of Object.entries(DEMO_PAGE_RISK_MAP)) {
            if (url.includes(page)) {
                return riskInfo;
            }
        }
        return null;
    }
    
    // 本地检测函数
    function localAIDetect(text) {
        // 演示页面：直接返回预设风险等级
        const demoRisk = getDemoPageRisk();
        if (demoRisk) {
            if (AI_DEBUG) console.log(`🤖 [本地检测] 演示页面，返回预设风险: ${demoRisk.risk}`);
            return demoRisk;
        }
        
        const textLower = text.toLowerCase();
        
        for (const rule of LOCAL_RISK_RULES.high) {
            if (rule.words.some(word => textLower.includes(word.toLowerCase()))) {
                return { risk: 'high', score: 0.95, reason: rule.reason };
            }
        }
        
        for (const rule of LOCAL_RISK_RULES.medium) {
            if (rule.words.some(word => textLower.includes(word.toLowerCase()))) {
                return { risk: 'medium', score: 0.65, reason: rule.reason };
            }
        }
        
        for (const rule of LOCAL_RISK_RULES.low) {
            if (rule.words.some(word => textLower.includes(word.toLowerCase()))) {
                return { risk: 'low', score: 0.35, reason: rule.reason };
            }
        }
        
        return { risk: 'safe', score: 0.05, reason: '未发现风险内容' };
    }

    // ==================== AI服务健康检查 ====================
    async function isAIServiceOnline() {
        // 如果已经检查过，直接返回缓存状态
        if (aiServiceChecked) {
            return aiServiceStatus === 'online';
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);

            const response = await fetch(await getApiUrl('/health'), {
                method: 'GET',
                signal: controller.signal,
                cache: 'no-cache'
            });

            clearTimeout(timeoutId);

            if (response.ok) {
                const data = await response.json();
                if (data.status === 'healthy') {
                    aiServiceStatus = 'online';
                    aiServiceChecked = true;
                    console.log('🤖 [AI检测] 当前模式：Flask AI服务');
                    return true;
                }
            }
        } catch (error) {
            // 健康检查失败，不报错，直接降级
        }

        aiServiceStatus = 'offline';
        aiServiceChecked = true;
        console.warn('🤖 [AI检测] 当前模式：本地降级检测');
        return false;
    }

    async function checkTextWithAI(text) {
        if (await shouldSkipProtectionNow()) {
            if (AI_DEBUG) console.log('⏸️ [AI检测] 保护已暂停，直接返回');
            return null;
        }

        const isPageContext = Boolean(
            text &&
            typeof text === 'object' &&
            !Array.isArray(text)
        );
        const pageContext = isPageContext
            ? {
                url: normalizePageContextField(text.url, 4096),
                title: normalizePageContextField(
                    text.title,
                    PAGE_CONTEXT_TITLE_MAX_LENGTH
                ),
                meta_description: normalizePageContextField(
                    text.meta_description,
                    PAGE_CONTEXT_META_MAX_LENGTH
                ),
                content: truncatePageContextContent(
                    normalizePageContextText(text.content)
                )
            }
            : {
                url: normalizePageContextField(window.location.href, 4096),
                title: '',
                meta_description: '',
                content: truncatePageContextContent(
                    normalizePageContextText(text)
                )
            };

        if (!pageContext.content) {
            if (AI_DEBUG) console.log('🤖 [AI检测] 文本为空，跳过检测');
            return null;
        }

        const trimmedText = pageContext.content;
        
        if (AI_DEBUG) console.log(`🤖 [AI检测] 开始检测，文本长度: ${trimmedText.length}`);

        // 先检查AI服务是否在线
        const isOnline = await isAIServiceOnline();

        if (await shouldSkipProtectionNow()) return null;

        // 如果服务离线，直接使用本地检测
        if (!isOnline) {
            const localResult = localAIDetect(trimmedText);
            if (AI_DEBUG) console.log(`🤖 [AI检测] 本地检测结果:`, localResult);
            return localResult;
        }

        // 服务在线，使用Flask AI检测
        const eventUuid = generateSecurityEventUuid();
        try {
            if (await shouldSkipProtectionNow()) return null;

            const { controller, timeoutId } = createTimeoutController(AI_REQUEST_TIMEOUT);

            const response = await fetch(await getApiUrl('/api/risk/check'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    url: pageContext.url,
                    title: pageContext.title,
                    meta_description: pageContext.meta_description,
                    content: trimmedText,
                    source: 'extension',
                    event_uuid: eventUuid
                }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (await shouldSkipProtectionNow()) return null;

            if (!response.ok) {
                // HTTP错误，静默降级
                console.warn(`🤖 [AI检测] HTTP错误: ${response.status}，切换本地检测`);
                const localResult = localAIDetect(trimmedText);
                if (AI_DEBUG) console.log(`🤖 [AI检测] 本地检测结果:`, localResult);
                return { ...localResult, event_uuid: eventUuid };
            }

            const responseBody = await response.json();
            if (await shouldSkipProtectionNow()) return null;
            if (responseBody.code !== 0 || !responseBody.data) {
                throw new Error(responseBody.message || '风险检测业务失败');
            }

            const result = {
                risk: responseBody.data.risk_level,
                score: Number(responseBody.data.score || 0),
                reason: responseBody.data.reason || '',
                persisted_by_backend: true
            };
            if (AI_DEBUG) console.log(`🤖 [AI检测] Flask检测结果:`, result);
            return result;

        } catch (error) {
            if (await shouldSkipProtectionNow()) return null;

            // 请求失败（网络错误、超时等），静默降级到本地检测
            // 不输出错误详情，避免控制台红色报错
            console.warn(`🤖 [AI检测] 后端不可用，已降级为本地检测`);
            
            // 使用本地检测作为备用方案
            const localResult = localAIDetect(trimmedText);
            if (AI_DEBUG) console.log(`🤖 [AI检测] 本地检测结果:`, localResult);
            return { ...localResult, event_uuid: eventUuid };
        }
    }

    const PAGE_CONTEXT_TITLE_MAX_LENGTH = 200;
    const PAGE_CONTEXT_META_MAX_LENGTH = 300;
    const PAGE_CONTEXT_EXCLUDED_SELECTOR = [
        'script',
        'style',
        'noscript',
        'svg',
        'canvas',
        'template',
        'nav',
        'header',
        'footer',
        'aside',
        'input[type="password"]',
        'textarea',
        '[contenteditable]:not([contenteditable="false"])',
        '[data-netguard-owned]',
        '[data-netguard-ui]',
        '[id^="netguard-"]',
        '[class*="netguard-"]'
    ].join(',');

    function normalizePageContextField(value, maxLength) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, maxLength);
    }

    function normalizePageContextText(value) {
        const seenLines = new Set();
        return String(value || '')
            .split(/\r\n?|\n/)
            .map(line => line.replace(/\s+/g, ' ').trim())
            .filter(line => {
                if (
                    !line ||
                    !/[\p{L}\p{N}]/u.test(line) ||
                    seenLines.has(line)
                ) return false;
                seenLines.add(line);
                return true;
            })
            .join('\n');
    }

    function truncatePageContextContent(content) {
        if (content.length <= MAX_TEXT_LENGTH) return content;
        const headLength = Math.floor(MAX_TEXT_LENGTH * 0.6);
        const tailLength = MAX_TEXT_LENGTH - headLength;
        return content.slice(0, headLength) + content.slice(-tailLength);
    }

    function extractTextFromPageRoot(root) {
        if (!root) return '';
        try {
            if (
                typeof root.matches === 'function' &&
                root.matches(PAGE_CONTEXT_EXCLUDED_SELECTOR)
            ) return '';
            const cleanRoot = root.cloneNode(true);
            cleanRoot.querySelectorAll(PAGE_CONTEXT_EXCLUDED_SELECTOR)
                .forEach(element => element.remove());
            return normalizePageContextText(
                cleanRoot.innerText || cleanRoot.textContent || ''
            );
        } catch (_) {
            return '';
        }
    }

    function extractPageContext() {
        try {
            let content = '';
            for (const selector of ['main', 'article', '[role="main"]']) {
                content = extractTextFromPageRoot(document.querySelector(selector));
                if (content) break;
            }
            if (!content) content = extractTextFromPageRoot(document.body);

            const descriptionElement = document.querySelector(
                'meta[name="description" i]'
            );
            return {
                url: normalizePageContextField(window.location.href, 4096),
                title: normalizePageContextField(
                    document.title,
                    PAGE_CONTEXT_TITLE_MAX_LENGTH
                ),
                meta_description: normalizePageContextField(
                    descriptionElement?.getAttribute('content'),
                    PAGE_CONTEXT_META_MAX_LENGTH
                ),
                content: truncatePageContextContent(content)
            };
        } catch (error) {
            console.warn('⚠️ [PageContext] 页面上下文提取失败');
            return {
                url: normalizePageContextField(window.location.href, 4096),
                title: '',
                meta_description: '',
                content: ''
            };
        }
    }

    function getPageText() {
        return extractPageContext().content;
    }

    // ==================== 统一风险弹窗系统 ====================
    // 弹窗常量定义
    const NETGUARD_POPUP_ID = 'netguard-risk-popup';
    const NETGUARD_BANNER_ID = 'netguard-risk-banner';
    
    // 弹窗关闭定时器
    let popupCloseTimer = null;
    
    // 加载弹窗CSS样式
    function loadPopupStyles() {
        if (document.getElementById('netguard-popup-styles')) return;
        
        const styleSheet = document.createElement('style');
        styleSheet.id = 'netguard-popup-styles';
        styleSheet.textContent = `
            /* 弹窗主容器 */
            .netguard-risk-popup {
                position: fixed !important;
                top: 20px !important;
                right: 20px !important;
                width: 380px !important;
                background: linear-gradient(135deg, rgba(30, 41, 59, 0.98) 0%, rgba(15, 23, 42, 0.99) 100%) !important;
                border-radius: 16px !important;
                padding: 20px !important;
                z-index: 999999999 !important;
                display: block !important;
                visibility: visible !important;
                opacity: 1 !important;
                pointer-events: auto !important;
                box-shadow: 0 0 30px rgba(59, 130, 246, 0.5) !important;
                border: 2px solid #3b82f6 !important;
                animation: netguardFadeIn 0.3s ease !important;
                transform: translateX(0) !important;
                margin: 0 !important;
            }
            
            /* 淡入动画 */
            @keyframes netguardFadeIn {
                from {
                    opacity: 0;
                    transform: translateX(20px);
                }
                to {
                    opacity: 1;
                    transform: translateX(0);
                }
            }
            
            /* 关闭动画 */
            .netguard-risk-popup.closing {
                animation: netguardFadeOut 0.3s ease forwards !important;
            }
            
            @keyframes netguardFadeOut {
                from {
                    opacity: 1;
                    transform: translateX(0);
                }
                to {
                    opacity: 0;
                    transform: translateX(20px);
                }
            }
            
            /* 缩小状态 */
            .netguard-risk-popup.netguard-minimized {
                transform: scale(0.9) !important;
                opacity: 0.9 !important;
            }
            
            /* 关闭按钮 */
            .netguard-popup-close {
                position: absolute !important;
                top: 12px !important;
                right: 12px !important;
                width: 28px !important;
                height: 28px !important;
                border: none !important;
                border-radius: 50% !important;
                background: rgba(255, 255, 255, 0.1) !important;
                color: #fff !important;
                font-size: 18px !important;
                cursor: pointer !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                z-index: 10 !important;
                transition: all 0.2s ease !important;
                padding: 0 !important;
                margin: 0 !important;
            }
            
            .netguard-popup-close:hover {
                background: rgba(255, 255, 255, 0.2) !important;
                transform: scale(1.1) !important;
            }
            
            /* 弹窗头部 */
            .netguard-popup-header {
                display: flex !important;
                align-items: center !important;
                gap: 15px !important;
                margin-bottom: 15px !important;
                padding-bottom: 15px !important;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1) !important;
            }
            
            /* 风险图标 */
            .netguard-risk-icon {
                width: 48px !important;
                height: 48px !important;
                border-radius: 12px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                font-size: 24px !important;
                flex-shrink: 0 !important;
            }
            
            .netguard-risk-icon.high {
                background: linear-gradient(135deg, #dc2626, #ef4444) !important;
                box-shadow: 0 0 20px rgba(239, 68, 68, 0.5) !important;
            }
            
            .netguard-risk-icon.medium {
                background: linear-gradient(135deg, #f59e0b, #fbbf24) !important;
                box-shadow: 0 0 20px rgba(245, 158, 11, 0.5) !important;
            }
            
            .netguard-risk-icon.low {
                background: linear-gradient(135deg, #3b82f6, #60a5fa) !important;
                box-shadow: 0 0 20px rgba(59, 130, 246, 0.5) !important;
            }
            
            .netguard-risk-icon.safe {
                background: linear-gradient(135deg, #22c55e, #4ade80) !important;
                box-shadow: 0 0 20px rgba(34, 197, 94, 0.5) !important;
            }
            
            /* 标题区域 */
            .netguard-title-area {
                flex: 1 !important;
                min-width: 0 !important;
            }
            
            .netguard-popup-title {
                font-size: 16px !important;
                font-weight: 600 !important;
                color: #fff !important;
                margin: 0 !important;
                padding: 0 !important;
                display: flex !important;
                align-items: center !important;
                gap: 8px !important;
                line-height: 1.4 !important;
            }
            
            .netguard-risk-badge {
                font-size: 10px !important;
                font-weight: 700 !important;
                padding: 3px 8px !important;
                border-radius: 4px !important;
                text-transform: uppercase !important;
            }
            
            .netguard-risk-badge.high {
                background: #dc2626 !important;
                color: #fff !important;
            }
            
            .netguard-risk-badge.medium {
                background: #f59e0b !important;
                color: #1f2937 !important;
            }
            
            .netguard-risk-badge.low {
                background: #3b82f6 !important;
                color: #fff !important;
            }
            
            .netguard-risk-badge.safe {
                background: #22c55e !important;
                color: #fff !important;
            }
            
            .netguard-source-tag {
                font-size: 12px !important;
                color: rgba(255, 255, 255, 0.6) !important;
                margin-top: 4px !important;
                display: block !important;
            }
            
            /* 弹窗内容 */
            .netguard-popup-content {
                margin-bottom: 15px !important;
            }
            
            .netguard-risk-reason {
                font-size: 14px !important;
                color: rgba(255, 255, 255, 0.9) !important;
                line-height: 1.5 !important;
                margin: 0 !important;
                padding: 0 !important;
            }
            
            /* 详情卡片 */
            .netguard-details-card {
                background: rgba(255, 255, 255, 0.05) !important;
                border-radius: 10px !important;
                padding: 12px !important;
                margin-bottom: 15px !important;
            }
            
            .netguard-detail-row {
                display: flex !important;
                justify-content: space-between !important;
                align-items: center !important;
                margin-bottom: 8px !important;
            }
            
            .netguard-detail-label {
                font-size: 12px !important;
                color: rgba(255, 255, 255, 0.6) !important;
            }
            
            .netguard-detail-value {
                font-size: 14px !important;
                font-weight: 600 !important;
                color: #fff !important;
            }
            
            .netguard-score-bar {
                height: 6px !important;
                background: rgba(255, 255, 255, 0.1) !important;
                border-radius: 3px !important;
                overflow: hidden !important;
            }
            
            .netguard-score-fill {
                height: 100% !important;
                border-radius: 3px !important;
                transition: width 0.3s ease !important;
            }
            
            .netguard-score-fill.high {
                background: linear-gradient(90deg, #dc2626, #ef4444) !important;
            }
            
            .netguard-score-fill.medium {
                background: linear-gradient(90deg, #f59e0b, #fbbf24) !important;
            }
            
            .netguard-score-fill.low {
                background: linear-gradient(90deg, #3b82f6, #60a5fa) !important;
            }
            
            .netguard-score-fill.safe {
                background: linear-gradient(90deg, #22c55e, #4ade80) !important;
            }
            
            /* 操作按钮 */
            .netguard-popup-actions {
                display: flex !important;
                gap: 10px !important;
                margin-bottom: 15px !important;
            }
            
            .netguard-btn {
                flex: 1 !important;
                padding: 10px !important;
                border: none !important;
                border-radius: 8px !important;
                font-size: 13px !important;
                font-weight: 500 !important;
                cursor: pointer !important;
                transition: all 0.2s ease !important;
                text-align: center !important;
            }
            
            .netguard-btn-primary {
                background: linear-gradient(135deg, #3b82f6, #60a5fa) !important;
                color: #fff !important;
            }
            
            .netguard-btn-primary:hover {
                transform: translateY(-2px) !important;
                box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4) !important;
            }
            
            .netguard-btn-secondary {
                background: rgba(255, 255, 255, 0.1) !important;
                color: rgba(255, 255, 255, 0.8) !important;
            }
            
            .netguard-btn-secondary:hover {
                background: rgba(255, 255, 255, 0.15) !important;
            }
            
            /* 弹窗底部 */
            .netguard-popup-footer {
                text-align: center !important;
                font-size: 11px !important;
                color: rgba(255, 255, 255, 0.4) !important;
                padding-top: 15px !important;
                border-top: 1px solid rgba(255, 255, 255, 0.1) !important;
            }
        `;
        
        document.head.appendChild(styleSheet);
        
        if (AI_DEBUG) console.log('🔔 [弹窗系统] CSS样式已加载');
    }
    
    // 创建小型风险提示横幅
    async function showRiskBanner(options) {
        if (!IS_TOP_FRAME || await shouldSkipProtectionNow()) return;
        // 检查是否需要跳过显示横幅（演示页面）
        if (skipRiskBanner) {
            if (AI_DEBUG) console.log(`[安全横幅] 演示页面，跳过显示`);
            return;
        }
        
        const { risk, score, reason, source } = options;
        
        // 移除已存在的横幅
        const existingBanner = document.getElementById(NETGUARD_BANNER_ID);
        if (existingBanner) {
            existingBanner.remove();
        }
        
        // 创建横幅
        const banner = document.createElement('div');
        banner.id = NETGUARD_BANNER_ID;
        banner.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            height: 50px !important;
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            padding: 0 20px !important;
            z-index: 999999999 !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
            animation: slideDown 0.3s ease !important;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4) !important;
            margin: 0 !important;
            border: none !important;
        `;
        
        // 根据风险等级设置颜色
        const riskStyles = {
            high: {
                bg: 'linear-gradient(90deg, #dc2626, #ef4444)',
                icon: '🛡️',
                label: '高风险',
                textColor: '#fff'
            },
            medium: {
                bg: 'linear-gradient(90deg, #d97706, #f59e0b)',
                icon: '⚠️',
                label: '中风险',
                textColor: '#fff'
            },
            low: {
                bg: 'linear-gradient(90deg, #2563eb, #3b82f6)',
                icon: 'ℹ️',
                label: '低风险',
                textColor: '#fff'
            },
            safe: {
                bg: 'linear-gradient(90deg, #16a34a, #22c55e)',
                icon: '✅',
                label: '安全',
                textColor: '#fff'
            }
        };
        
        const style = riskStyles[risk] || riskStyles.low;
        banner.style.background = style.bg;
        banner.style.color = style.textColor;
        
        // 创建内容
        banner.innerHTML = `
            <div style="display: flex; align-items: center; gap: 12px;">
                <span style="font-size: 20px;">${style.icon}</span>
                <div>
                    <div style="font-weight: 600; font-size: 14px;">${style.label} · ${source}</div>
                    <div style="font-size: 12px; opacity: 0.9;">${reason}</div>
                </div>
            </div>
            <div style="display: flex; align-items: center; gap: 15px;">
                <span style="font-size: 12px;">风险评分: ${Math.round(score * 100)}%</span>
                <button id="netguard-banner-close" style="
                    background: rgba(255,255,255,0.2);
                    border: none;
                    border-radius: 4px;
                    padding: 6px 12px;
                    color: white;
                    font-size: 12px;
                    cursor: pointer;
                ">关闭</button>
            </div>
        `;
        
        // 添加到页面
        document.body.insertBefore(banner, document.body.firstChild);
        
        // 添加关闭事件
        document.getElementById('netguard-banner-close').addEventListener('click', () => {
            banner.style.animation = 'slideUp 0.3s ease forwards';
            setTimeout(() => banner.remove(), 300);
        });
        
        // 5秒后自动关闭
        setTimeout(() => {
            if (banner.parentNode) {
                banner.style.animation = 'slideUp 0.3s ease forwards';
                setTimeout(() => banner.remove(), 300);
            }
        }, 8000);
        
        // 添加动画样式
        if (!document.getElementById('netguard-banner-animation')) {
            const styleEl = document.createElement('style');
            styleEl.id = 'netguard-banner-animation';
            styleEl.textContent = `
                @keyframes slideDown {
                    from { transform: translateY(-100%); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
                @keyframes slideUp {
                    from { transform: translateY(0); opacity: 1; }
                    to { transform: translateY(-100%); opacity: 0; }
                }
            `;
            document.head.appendChild(styleEl);
        }
        
        console.log(`🔔 [风险提示] 显示${style.label}横幅: ${reason}`);
    }

    // 弹窗计数器，用于多个弹窗
    let popupCounter = 0;
    
    async function showRiskPopup(options) {
        if (!IS_TOP_FRAME || await shouldSkipProtectionNow()) return;
        const { risk, score, reason, source, elementId } = options;
        
        // 清除之前的自动关闭定时器
        if (popupCloseTimer) {
            clearTimeout(popupCloseTimer);
            popupCloseTimer = null;
        }

        // 加载样式
        loadPopupStyles();

        // 生成唯一弹窗ID
        popupCounter++;
        const uniquePopupId = `${NETGUARD_POPUP_ID}-${popupCounter}-${risk}`;
        
        // 创建新弹窗
        const popup = document.createElement('div');
        popup.id = uniquePopupId;
        popup.className = 'netguard-risk-popup';
        
        // 设置位置（多个弹窗时偏移）
        popup.style.top = `${20 + (popupCounter - 1) * 70}px`;

        // 根据风险等级选择图标
        const riskIcons = {
            high: '🛡️',
            medium: '⚠️',
            low: 'ℹ️',
            safe: '✅'
        };
        const riskIcon = riskIcons[risk] || 'ℹ️';
        
        const scorePercent = Math.round(score * 100);

        popup.innerHTML = `
            <button class="netguard-popup-close" id="netguard-popup-close-btn-${uniquePopupId}">&times;</button>
            
            <div class="netguard-popup-header">
                <div class="netguard-risk-icon ${risk}">${riskIcon}</div>
                <div class="netguard-title-area">
                    <h3 class="netguard-popup-title">
                        ${risk === 'safe' ? '安全提示' : risk === 'low' ? '风险提示' : '风险警告'}
                        <span class="netguard-risk-badge ${risk}">${risk.toUpperCase()}</span>
                    </h3>
                    <span class="netguard-source-tag">检测来源: ${source}</span>
                </div>
            </div>

            <div class="netguard-popup-content">
                <p class="netguard-risk-reason">${reason}</p>
            </div>

            <div class="netguard-details-card">
                <div class="netguard-detail-row">
                    <span class="netguard-detail-label">风险评分</span>
                    <span class="netguard-detail-value">${scorePercent}%</span>
                </div>
                <div class="netguard-score-bar">
                    <div class="netguard-score-fill ${risk}" style="width: ${scorePercent}%"></div>
                </div>
            </div>

            <div class="netguard-popup-actions">
                <button class="netguard-btn netguard-btn-primary" id="netguard-btn-report-${uniquePopupId}">
                    举报此网站
                </button>
                <button class="netguard-btn netguard-btn-secondary" id="netguard-btn-ignore-${uniquePopupId}">
                    忽略
                </button>
            </div>

            <div class="netguard-popup-footer">
                净网护航 · AI安全检测
            </div>
        `;

        document.body.appendChild(popup);

        // 强制设置样式确保弹窗显示
        popup.style.setProperty('position', 'fixed', 'important');
        popup.style.setProperty('top', `${20 + (popupCounter - 1) * 60}px`, 'important');
        popup.style.setProperty('right', '20px', 'important');
        popup.style.setProperty('width', '380px', 'important');
        popup.style.setProperty('background', 'linear-gradient(135deg, rgba(30, 41, 59, 0.98) 0%, rgba(15, 23, 42, 0.99) 100%)', 'important');
        popup.style.setProperty('border', '2px solid #3b82f6', 'important');
        popup.style.setProperty('border-radius', '16px', 'important');
        popup.style.setProperty('padding', '20px', 'important');
        popup.style.setProperty('z-index', '99999999', 'important');
        popup.style.setProperty('display', 'block', 'important');
        popup.style.setProperty('visibility', 'visible', 'important');
        popup.style.setProperty('opacity', '1', 'important');
        popup.style.setProperty('pointer-events', 'auto', 'important');
        popup.style.setProperty('box-shadow', '0 0 30px rgba(59, 130, 246, 0.5)', 'important');
        popup.style.setProperty('animation', 'none', 'important');
        popup.style.setProperty('transform', 'translateX(0)', 'important');

        // 调试日志
        if (AI_DEBUG) {
            console.log(`🔔 [弹窗系统] 弹窗已添加到页面，位置: ${popup.style.top}, ${popup.style.right}`);
            console.log(`🔔 [弹窗系统] 弹窗样式:`, getComputedStyle(popup));
        }

        // 添加事件监听
        document.getElementById(`netguard-popup-close-btn-${uniquePopupId}`).addEventListener('click', () => {
            closePopup(uniquePopupId);
        });

        document.getElementById(`netguard-btn-ignore-${uniquePopupId}`).addEventListener('click', () => {
            closePopup(uniquePopupId);
        });

        document.getElementById(`netguard-btn-report-${uniquePopupId}`).addEventListener('click', () => {
            if (AI_DEBUG) console.log(`🔔 [弹窗系统] 用户举报网站`);
            alert('感谢您的举报，我们会进行核查。');
            closePopup(uniquePopupId);
        });

        // 3秒后自动缩小，10秒后自动关闭
        const minimizeTimer = setTimeout(() => {
            popup.classList.add('netguard-minimized');
        }, 3000);
        
        popupCloseTimer = setTimeout(() => {
            closePopup(uniquePopupId);
            clearTimeout(minimizeTimer);
        }, 15000);

        if (AI_DEBUG) console.log(`🔔 [弹窗系统] 风险弹窗已显示 [${risk}] - ID: ${uniquePopupId}`);
    }
    
    function closePopup(popupId = NETGUARD_POPUP_ID) {
        const popup = document.getElementById(popupId);
        if (popup) {
            popup.classList.add('closing');
            setTimeout(() => {
                if (popup.parentNode) {
                    popup.remove();
                }
            }, 300);
        }
        if (popupCloseTimer) {
            clearTimeout(popupCloseTimer);
            popupCloseTimer = null;
        }
        if (AI_DEBUG) console.log('🔔 [弹窗系统] 风险弹窗已关闭');
    }

    function updatePopupContent(popup, options) {
        const { risk, score, reason, source } = options;
        
        popup.querySelector('.netguard-risk-icon').className = `netguard-risk-icon ${risk}`;
        popup.querySelector('.netguard-risk-icon').textContent = risk === 'high' ? '🛡️' : '⚠️';
        
        const badge = popup.querySelector('.netguard-risk-badge');
        badge.className = `netguard-risk-badge ${risk}`;
        badge.textContent = risk.toUpperCase();
        
        popup.querySelector('.netguard-source-tag').textContent = `检测来源: ${source}`;
        popup.querySelector('.netguard-risk-reason').textContent = reason;
        
        const scorePercent = Math.round(score * 100);
        popup.querySelector('.netguard-detail-value').textContent = `${scorePercent}%`;
        
        const scoreBar = popup.querySelector('.netguard-score-fill');
        scoreBar.className = `netguard-score-fill ${risk}`;
        scoreBar.style.width = `${scorePercent}%`;
    }

    function closePopup() {
        const popup = document.getElementById(NETGUARD_POPUP_ID);
        if (popup) {
            popup.classList.add('closing');
            setTimeout(() => {
                if (popup.parentNode) {
                    popup.remove();
                }
            }, 300);
        }
        if (popupCloseTimer) {
            clearTimeout(popupCloseTimer);
            popupCloseTimer = null;
        }
        if (AI_DEBUG) console.log('🔔 [弹窗系统] 风险弹窗已关闭');
    }

    // ==================== 启动AI检测 ====================
    async function startAIDetection() {
        if (isOfficialTrustedUiPage()) return;
        if (!IS_TOP_FRAME || await shouldSkipProtectionNow()) return;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', async () => {
                if (isOfficialTrustedUiPage()) return;
                if (await shouldSkipProtectionNow()) return;
                await runAIDetection();
            });
        } else {
            await runAIDetection();
        }
    }

    // 比赛演示模式：检测演示页面中的每个案例卡片
    async function detectDemoCards(filterRisk = null) {
        if (await shouldSkipProtectionNow()) return;

        // 查找所有演示案例卡片
        const demoCards = document.querySelectorAll('.demo-card');
        
        if (demoCards.length === 0) {
            if (AI_DEBUG) console.log('🤖 [AI检测] 未找到演示案例卡片');
            return;
        }
        
        // 获取卡片的风险等级（从卡片类名获取）
        const cardsWithRisk = [];
        demoCards.forEach((card) => {
            let cardRisk = null;
            const className = card.className.toLowerCase();
            
            // 检查卡片本身的类名
            if (className.includes('high')) {
                cardRisk = 'high';
            } else if (className.includes('medium')) {
                cardRisk = 'medium';
            } else if (className.includes('low')) {
                cardRisk = 'low';
            } else if (className.includes('safe')) {
                cardRisk = 'safe';
            }
            
            // 应用过滤
            if ((!filterRisk || cardRisk === filterRisk) && card.textContent.length > 5) {
                cardsWithRisk.push({ element: card, expectedRisk: cardRisk });
            }
        });
        
        if (AI_DEBUG) console.log(`🤖 [AI检测] 过滤条件: ${filterRisk || '全部'}, 找到 ${cardsWithRisk.length} 个案例`);
        
        // 如果没有找到符合条件的卡片，提示用户
        if (cardsWithRisk.length === 0) {
            alert(`❌ 未找到${filterRisk === 'high' ? '高风险' : filterRisk === 'medium' ? '中风险' : filterRisk === 'low' ? '低风险' : '安全'}案例！`);
            return;
        }

        // 逐个检测每个卡片
        let delay = 800; // 每个卡片检测间隔0.8秒
        for (let i = 0; i < cardsWithRisk.length; i++) {
            const { element, expectedRisk } = cardsWithRisk[i];
            const cardText = element.textContent || '';
            
            // 延迟检测，让效果更明显
            setTimeout(async () => {
                if (await shouldSkipProtectionNow()) return;
                const result = await checkTextWithAI(cardText);
                if (result && result.risk) {
                    if (AI_DEBUG) console.log(`🤖 [AI检测] 案例 ${i+1} 检测结果:`, result);
                    
                    // 显示小型风险提示横幅（所有风险等级都显示）
                    showRiskBanner({
                        risk: result.risk,
                        score: result.score,
                        reason: result.reason,
                        source: `案例 ${i+1}`
                    });
                }
            }, delay * (i + 1));
        }
    }
    
    // 初始化手动检测按钮
    function initDetectionButtons() {
        setTimeout(() => {
            const detectAllBtn = document.getElementById('detect-all-btn');
            const detectHighBtn = document.getElementById('detect-high-btn');
            const detectMediumBtn = document.getElementById('detect-medium-btn');
            const clearBtn = document.getElementById('clear-alerts-btn');
            
            if (detectAllBtn) {
                detectAllBtn.addEventListener('click', () => {
                    alert('🔍 开始检测全部内容...');
                    detectDemoCards(null);
                });
            }
            
            if (detectHighBtn) {
                detectHighBtn.addEventListener('click', () => {
                    alert('🚨 开始检测高风险内容...');
                    detectDemoCards('high');
                });
            }
            
            if (detectMediumBtn) {
                detectMediumBtn.addEventListener('click', () => {
                    alert('⚠️ 开始检测中风险内容...');
                    detectDemoCards('medium');
                });
            }
            
            if (clearBtn) {
                clearBtn.addEventListener('click', () => {
                    const banner = document.getElementById(NETGUARD_BANNER_ID);
                    if (banner) banner.remove();
                    alert('✅ 已清除所有风险提示');
                });
            }
            
            if (AI_DEBUG) console.log('🤖 [AI检测] 手动检测按钮已初始化');
        }, 1000);
    }

    // 获取当前页面文件名
    function getCurrentPageName() {
        const url = window.location.href.toLowerCase();
        const parts = url.split('/');
        return parts[parts.length - 1] || '';
    }
    
    // AI检测白名单页面（跳过检测）
    const AI_DETECTION_WHITELIST = ['demo_center.html', 'ai_demo_home.html', 'url_demo.html', 'warning.html', 'safe-demo.html', 'ads_demo.html', 'elder_demo.html', 'dashboard_demo.html', 'child_demo_home.html'];
    
    // 风险测试页面列表（自动检测并显示弹窗）
    const RISK_TEST_PAGES = ['safe.html', 'low.html', 'medium.html', 'high.html'];

    async function shouldSkipContinuedNavigation() {
        return new Promise(resolve => {
            try {
                extensionAPI.runtime.sendMessage({
                    type: 'NETGUARD_QUERY_CONTINUE_BYPASS',
                    url: window.location.href
                }, response => resolve(Boolean(response?.bypass)));
            } catch (_) {
                resolve(false);
            }
        });
    }
    
    async function runAIDetection() {
        if (isOfficialTrustedUiPage()) {
            if (AI_DEBUG) console.log('🤖 [AI检测] 正式 trusted UI，跳过自动页面文本扫描');
            return;
        }

        if (!IS_TOP_FRAME || await shouldSkipProtectionNow()) {
            if (AI_DEBUG) console.log('🤖 [AI检测] 子框架、暂停或白名单页面，跳过检测');
            return;
        }

        if (await shouldSkipContinuedNavigation()) {
            if (AI_DEBUG) console.log('➡️ [AI检测] 本次继续访问已放行，跳过检测');
            return;
        }

        // 检查是否在AI检测白名单中（导航页面跳过检测）
        const currentPage = getCurrentPageName();
        if (AI_DETECTION_WHITELIST.includes(currentPage)) {
            if (AI_DEBUG) console.log(`🤖 [AI检测] 导航页面 ${currentPage}，跳过AI检测`);
            return;
        }
        
        // 儿童模式下跳过AI检测（避免影响学习网站演示效果）
        if (isChildMode) {
            if (AI_DEBUG) console.log(`🤖 [AI检测] 儿童模式已启用，跳过AI检测`);
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 1500));

        if (await shouldSkipProtectionNow()) return;
        
        const pageContext = extractPageContext();
        const pageText = pageContext.content;
        
        // 检查是否是演示页面（带demo-card的页面）
        const isDemoPage = document.querySelector('.demo-card') !== null;
        
        if (isDemoPage) {
            // 比赛演示模式：初始化手动检测按钮，不自动检测
            if (AI_DEBUG) console.log('🤖 [AI检测] 检测到演示页面，等待手动触发');
            initDetectionButtons();
            return;
        }
        
        if (!pageText || pageText.length < 5) {
            if (AI_DEBUG) console.log('🤖 [AI检测] 页面文本过短，跳过检测');
            return;
        }

        if (AI_DEBUG) console.log(`🤖 [AI检测] 页面文本长度: ${pageText.length} 字符`);

        const result = await checkTextWithAI(pageContext);

        // 请求期间切换暂停时，结果、日志和所有提示都必须被丢弃。
        if (await shouldSkipProtectionNow()) return;
        
        if (result && ['medium', 'high', 'low', 'safe'].includes(result.risk)) {
            // 使用统一日志函数上报AI检测结果
            // /api/risk/check 成功时后端已写入 risk_events，不能重复上报。
            if (!result.persisted_by_backend) {
                await logAICheck(
                    result.risk,
                    window.location.href,
                    result.reason,
                    result.score,
                    result.event_uuid
                );
            }
            
            // 根据风险等级选择显示方式
            if (result.risk === 'high') {
                // 高风险：显示居中弹窗（有遮罩）
                if (AI_DEBUG) console.log(`🤖 [AI检测] 检测到高风险，显示风险弹窗`);
                
                showHighRiskPopup({
                    risk: result.risk,
                    score: result.score,
                    reason: result.reason,
                    source: 'AI检测'
                });
            } else if (result.risk === 'medium') {
                // 中风险：显示顶部横幅
                if (AI_DEBUG) console.log(`🤖 [AI检测] 检测到中风险，显示横幅`);
                
                showRiskBanner({
                    risk: result.risk,
                    score: result.score,
                    reason: result.reason,
                    source: 'AI检测'
                });
            } else if (result.risk === 'low') {
                // 低风险：显示顶部横幅
                if (AI_DEBUG) console.log(`🤖 [AI检测] 检测到低风险，显示横幅`);
                
                // 更新统计和日志
                await updateStorageStats('lowRisk', 1);
                await addStorageRiskLog({ type: 'AI检测', level: 'low', url: window.location.href, reason: result.reason });
                
                showRiskBanner({
                    risk: result.risk,
                    score: result.score,
                    reason: result.reason,
                    source: 'AI检测'
                });
            } else if (result.risk === 'safe') {
                // safe：显示顶部横幅（安全提示）
                if (AI_DEBUG) console.log(`🤖 [AI检测] 内容安全，显示安全横幅`);
                
                showRiskBanner({
                    risk: 'safe',
                    score: result.score || 0,
                    reason: result.reason || '内容安全，可放心浏览',
                    source: 'AI检测'
                });
            }
        } else if (result) {
            if (AI_DEBUG) console.log(`🤖 [AI检测] 内容安全 [${result.risk}]: ${result.reason}`);
        }
    }

    // 高风险居中弹窗（带遮罩层）
    async function showHighRiskPopup(options) {
        if (!IS_TOP_FRAME || await shouldSkipProtectionNow()) return;

        const { risk, score, reason, source } = options;
        
        // 移除已存在的高风险弹窗和遮罩
        const existingOverlay = document.getElementById('netguard-high-risk-overlay');
        const existingPopup = document.getElementById('netguard-high-risk-popup');
        if (existingOverlay) existingOverlay.remove();
        if (existingPopup) existingPopup.remove();
        
        // 创建遮罩层
        const overlay = document.createElement('div');
        overlay.id = 'netguard-high-risk-overlay';
        overlay.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            background: rgba(0, 0, 0, 0.7) !important;
            z-index: 999999998 !important;
            animation: fadeIn 0.3s ease !important;
            backdrop-filter: blur(4px) !important;
        `;
        
        // 创建弹窗容器
        const popup = document.createElement('div');
        popup.id = 'netguard-high-risk-popup';
        popup.style.cssText = `
            position: fixed !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            width: 420px !important;
            max-width: 90% !important;
            background: linear-gradient(145deg, #1f2937, #111827) !important;
            border-radius: 16px !important;
            padding: 28px !important;
            z-index: 999999999 !important;
            animation: popupScaleIn 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) !important;
            box-shadow: 0 25px 50px -12px rgba(220, 38, 38, 0.5), 0 0 0 1px rgba(220, 38, 38, 0.3) !important;
            border: 2px solid rgba(220, 38, 38, 0.6) !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
        `;
        
        // 弹窗内容
        popup.innerHTML = `
            <style>
                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                @keyframes popupScaleIn {
                    from { transform: translate(-50%, -50%) scale(0.8); opacity: 0; }
                    to { transform: translate(-50%, -50%) scale(1); opacity: 1; }
                }
                @keyframes pulseGlow {
                    0%, 100% { box-shadow: 0 25px 50px -12px rgba(220, 38, 38, 0.5), 0 0 0 1px rgba(220, 38, 38, 0.3); }
                    50% { box-shadow: 0 25px 60px -12px rgba(220, 38, 38, 0.7), 0 0 30px rgba(220, 38, 38, 0.3); }
                }
                .netguard-high-risk-icon {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 64px;
                    height: 64px;
                    background: linear-gradient(135deg, #dc2626, #ef4444);
                    border-radius: 50%;
                    margin: 0 auto 20px;
                    font-size: 32px;
                    animation: pulseGlow 2s ease-in-out infinite;
                }
                .netguard-high-risk-title {
                    color: #ef4444;
                    font-size: 20px;
                    font-weight: 700;
                    text-align: center;
                    margin-bottom: 8px;
                }
                .netguard-high-risk-subtitle {
                    color: rgba(255, 255, 255, 0.7);
                    font-size: 14px;
                    text-align: center;
                    margin-bottom: 20px;
                }
                .netguard-high-risk-score {
                    background: rgba(220, 38, 38, 0.15);
                    border-radius: 8px;
                    padding: 12px;
                    margin-bottom: 16px;
                }
                .netguard-high-risk-score-label {
                    color: rgba(255, 255, 255, 0.6);
                    font-size: 12px;
                    margin-bottom: 4px;
                }
                .netguard-high-risk-score-bar {
                    height: 8px;
                    background: rgba(255, 255, 255, 0.1);
                    border-radius: 4px;
                    overflow: hidden;
                }
                .netguard-high-risk-score-fill {
                    height: 100%;
                    background: linear-gradient(90deg, #dc2626, #ef4444);
                    border-radius: 4px;
                    animation: scoreFill 0.8s ease-out;
                }
                @keyframes scoreFill {
                    from { width: 0; }
                    to { width: ${score * 100}%; }
                }
                .netguard-high-risk-score-value {
                    color: #ef4444;
                    font-size: 24px;
                    font-weight: 700;
                    margin-top: 8px;
                }
                .netguard-high-risk-reason {
                    background: rgba(255, 255, 255, 0.05);
                    border-radius: 8px;
                    padding: 12px;
                    margin-bottom: 16px;
                    color: rgba(255, 255, 255, 0.8);
                    font-size: 13px;
                    line-height: 1.5;
                }
                .netguard-high-risk-keywords {
                    background: rgba(255, 255, 255, 0.05);
                    border-radius: 8px;
                    padding: 12px;
                    margin-bottom: 20px;
                }
                .netguard-high-risk-keywords-label {
                    color: rgba(255, 255, 255, 0.6);
                    font-size: 12px;
                    margin-bottom: 8px;
                }
                .netguard-high-risk-keyword {
                    display: inline-block;
                    background: rgba(220, 38, 38, 0.2);
                    color: #fca5a5;
                    padding: 4px 10px;
                    border-radius: 12px;
                    font-size: 12px;
                    margin: 3px;
                }
                .netguard-high-risk-btn {
                    width: 100%;
                    padding: 12px;
                    border-radius: 8px;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: pointer;
                    border: none;
                    transition: all 0.2s;
                }
                .netguard-high-risk-btn-danger {
                    background: linear-gradient(135deg, #dc2626, #ef4444);
                    color: white;
                }
                .netguard-high-risk-btn-danger:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 8px 20px rgba(220, 38, 38, 0.4);
                }
                .netguard-high-risk-btn-safe {
                    background: rgba(255, 255, 255, 0.1);
                    color: rgba(255, 255, 255, 0.8);
                    margin-top: 8px;
                }
                .netguard-high-risk-btn-safe:hover {
                    background: rgba(255, 255, 255, 0.15);
                }
            </style>
            
            <div class="netguard-high-risk-icon">🚨</div>
            <div class="netguard-high-risk-title">高风险警告</div>
            <div class="netguard-high-risk-subtitle">检测到可疑内容，请谨慎浏览</div>
            
            <div class="netguard-high-risk-score">
                <div class="netguard-high-risk-score-label">风险评分</div>
                <div class="netguard-high-risk-score-bar">
                    <div class="netguard-high-risk-score-fill"></div>
                </div>
                <div class="netguard-high-risk-score-value">${Math.round(score * 100)}%</div>
            </div>
            
            <div class="netguard-high-risk-reason">
                <strong style="color: #ef4444;">风险原因：</strong>${reason}
            </div>
            
            <div class="netguard-high-risk-keywords">
                <div class="netguard-high-risk-keywords-label">命中关键词</div>
                <div>
                    <span class="netguard-high-risk-keyword">欺诈</span>
                    <span class="netguard-high-risk-keyword">中奖</span>
                    <span class="netguard-high-risk-keyword">敏感信息</span>
                    <span class="netguard-high-risk-keyword">虚假信息</span>
                </div>
            </div>
            
            <button class="netguard-high-risk-btn netguard-high-risk-btn-danger" id="netguard-high-risk-close">
                我已知晓风险，继续访问
            </button>
            <button class="netguard-high-risk-btn netguard-high-risk-btn-safe" id="netguard-high-risk-leave">
                立即离开此页面
            </button>
        `;
        
        // 添加到页面
        document.body.appendChild(overlay);
        document.body.appendChild(popup);
        
        // 添加关闭事件
        document.getElementById('netguard-high-risk-close').addEventListener('click', () => {
            popup.style.animation = 'popupScaleIn 0.3s ease reverse';
            overlay.style.animation = 'fadeIn 0.3s ease reverse';
            setTimeout(() => {
                popup.remove();
                overlay.remove();
            }, 300);
        });
        
        // 添加离开事件
        document.getElementById('netguard-high-risk-leave').addEventListener('click', () => {
            window.history.back();
            setTimeout(() => {
                popup.remove();
                overlay.remove();
            }, 100);
        });
        
        if (AI_DEBUG) console.log('🔔 [高风险弹窗] 已显示');
    }

    // 启动AI检测
    (async () => {
        await startAIDetection();
    })();

    // 暴露给 background.js 调用的接口
    window.netguardShowRiskPopup = showRiskPopup;
    
    // 触发AI检测（由background.js调用）
    window.netguardStartAICheck = async function(urlRiskResult) {
        if (isOfficialTrustedUiPage()) return;
        if (!IS_TOP_FRAME || await shouldSkipProtectionNow()) return;
        // 检查是否在白名单页面
        const currentPage = getCurrentPageName();
        if (AI_DETECTION_WHITELIST.includes(currentPage)) {
            if (AI_DEBUG) console.log(`🤖 [AI检测] 白名单页面 ${currentPage}，跳过检测`);
            return;
        }
        
        if (AI_DEBUG) console.log(`🤖 [AI检测] 收到触发信号，URL检测结果:`, urlRiskResult);
        
        const pageContext = extractPageContext();
        const pageText = pageContext.content;
        if (!pageText || pageText.length < 10) {
            if (AI_DEBUG) console.log(`🤖 [AI检测] 页面文本过短，跳过检测`);
            return;
        }
        
        const aiResult = await checkTextWithAI(pageContext);
        if (await shouldSkipProtectionNow()) return;
        if (aiResult && aiResult.risk) {
            if (AI_DEBUG) console.log(`🤖 [AI检测] 检测完成，风险等级: ${aiResult.risk}`);
            
            // 记录AI检测日志
            if (!aiResult.persisted_by_backend) {
                await logAICheck(
                    aiResult.risk,
                    window.location.href,
                    aiResult.reason || 'AI语义检测完成',
                    aiResult.score,
                    aiResult.event_uuid
                );
            }
            
            // 根据风险等级显示对应提示
            if (aiResult.risk === 'high') {
                showHighRiskPopup({
                    risk: aiResult.risk,
                    score: aiResult.score || 0.9,
                    reason: aiResult.reason || 'AI检测到高风险内容',
                    source: 'AI语义检测'
                });
            } else if (aiResult.risk === 'medium') {
                showRiskBanner({
                    risk: aiResult.risk,
                    score: aiResult.score || 0.5,
                    reason: aiResult.reason || 'AI检测到中等风险内容',
                    source: 'AI语义检测'
                });
            }
        }
    };

})();
