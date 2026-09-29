// ==================== 扩展API兼容层 ====================
// 统一处理 Chrome / Edge / Firefox 扩展API差异

(function() {
    'use strict';

    // 优先使用 browser API (Firefox/Edge标准)， fallback到 chrome API
    const rawAPI = window.browser || window.chrome;

    // ==================== 安全封装 ====================
    
    // 安全获取存储API
    function getStorageAPI() {
        if (!rawAPI || !rawAPI.storage) {
            console.warn('[扩展API] storage API不可用');
            return null;
        }
        return rawAPI.storage;
    }

    // 安全获取运行时API
    function getRuntimeAPI() {
        if (!rawAPI || !rawAPI.runtime) {
            console.warn('[扩展API] runtime API不可用');
            return null;
        }
        return rawAPI.runtime;
    }

    // 安全获取标签页API
    function getTabsAPI() {
        if (!rawAPI || !rawAPI.tabs) {
            console.warn('[扩展API] tabs API不可用');
            return null;
        }
        return rawAPI.tabs;
    }

    // ==================== 封装存储操作 ====================
    
    const storage = {
        local: {
            // 安全读取存储
            get: function(keys, callback) {
                const storageAPI = getStorageAPI();
                if (!storageAPI || !storageAPI.local) {
                    console.warn('[存储API] storage.local不可用，返回默认值');
                    if (typeof callback === 'function') {
                        callback({});
                    }
                    return;
                }
                
                try {
                    storageAPI.local.get(keys, function(result) {
                        if (typeof callback === 'function') {
                            callback(result || {});
                        }
                    });
                } catch (e) {
                    console.warn('[存储API] 读取失败:', e);
                    if (typeof callback === 'function') {
                        callback({});
                    }
                }
            },
            
            // 安全写入存储
            set: function(items, callback) {
                const storageAPI = getStorageAPI();
                if (!storageAPI || !storageAPI.local) {
                    console.warn('[存储API] storage.local不可用，跳过写入');
                    if (typeof callback === 'function') {
                        callback();
                    }
                    return;
                }
                
                try {
                    storageAPI.local.set(items, function() {
                        if (typeof callback === 'function') {
                            callback();
                        }
                    });
                } catch (e) {
                    console.warn('[存储API] 写入失败:', e);
                    if (typeof callback === 'function') {
                        callback();
                    }
                }
            },
            
            // 安全移除存储
            remove: function(keys, callback) {
                const storageAPI = getStorageAPI();
                if (!storageAPI || !storageAPI.local) {
                    console.warn('[存储API] storage.local不可用，跳过移除');
                    if (typeof callback === 'function') {
                        callback();
                    }
                    return;
                }
                
                try {
                    storageAPI.local.remove(keys, function() {
                        if (typeof callback === 'function') {
                            callback();
                        }
                    });
                } catch (e) {
                    console.warn('[存储API] 移除失败:', e);
                    if (typeof callback === 'function') {
                        callback();
                    }
                }
            },
            
            // 安全清除存储
            clear: function(callback) {
                const storageAPI = getStorageAPI();
                if (!storageAPI || !storageAPI.local) {
                    console.warn('[存储API] storage.local不可用，跳过清除');
                    if (typeof callback === 'function') {
                        callback();
                    }
                    return;
                }
                
                try {
                    storageAPI.local.clear(function() {
                        if (typeof callback === 'function') {
                            callback();
                        }
                    });
                } catch (e) {
                    console.warn('[存储API] 清除失败:', e);
                    if (typeof callback === 'function') {
                        callback();
                    }
                }
            }
        },
        
        // 安全获取onChanged事件
        get onChanged() {
            const storageAPI = getStorageAPI();
            if (storageAPI && storageAPI.onChanged) {
                return storageAPI.onChanged;
            }
            console.warn('[存储API] storage.onChanged不可用');
            return null;
        }
    };

    // ==================== 封装运行时API ====================
    
    const runtime = {
        // 安全发送消息
        sendMessage: function(message, callback) {
            const runtimeAPI = getRuntimeAPI();
            if (!runtimeAPI || typeof runtimeAPI.sendMessage !== 'function') {
                console.warn('[运行时API] sendMessage不可用');
                if (typeof callback === 'function') {
                    callback(null);
                }
                return;
            }
            
            try {
                runtimeAPI.sendMessage(message, function(response) {
                    if (typeof callback === 'function') {
                        callback(response);
                    }
                });
            } catch (e) {
                console.warn('[运行时API] 发送消息失败:', e);
                if (typeof callback === 'function') {
                    callback(null);
                }
            }
        },
        
        // 安全获取URL
        getURL: function(path) {
            const runtimeAPI = getRuntimeAPI();
            if (!runtimeAPI || typeof runtimeAPI.getURL !== 'function') {
                console.warn('[运行时API] getURL不可用');
                return path;
            }
            
            try {
                return runtimeAPI.getURL(path);
            } catch (e) {
                console.warn('[运行时API] 获取URL失败:', e);
                return path;
            }
        },
        
        // 安全获取扩展ID
        get id() {
            const runtimeAPI = getRuntimeAPI();
            if (runtimeAPI && runtimeAPI.id) {
                return runtimeAPI.id;
            }
            console.warn('[运行时API] runtime.id不可用');
            return null;
        },
        
        // 安全获取onMessage事件
        get onMessage() {
            const runtimeAPI = getRuntimeAPI();
            if (runtimeAPI && runtimeAPI.onMessage) {
                return runtimeAPI.onMessage;
            }
            console.warn('[运行时API] runtime.onMessage不可用');
            return null;
        },
        
        // 安全获取onInstalled事件
        get onInstalled() {
            const runtimeAPI = getRuntimeAPI();
            if (runtimeAPI && runtimeAPI.onInstalled) {
                return runtimeAPI.onInstalled;
            }
            console.warn('[运行时API] runtime.onInstalled不可用');
            return null;
        }
    };

    // ==================== 封装标签页API ====================
    
    const tabs = {
        // 安全查询标签页
        query: function(queryInfo, callback) {
            const tabsAPI = getTabsAPI();
            if (!tabsAPI || typeof tabsAPI.query !== 'function') {
                console.warn('[标签页API] query不可用');
                if (typeof callback === 'function') {
                    callback([]);
                }
                return;
            }
            
            try {
                tabsAPI.query(queryInfo, function(tabs) {
                    if (typeof callback === 'function') {
                        callback(tabs || []);
                    }
                });
            } catch (e) {
                console.warn('[标签页API] 查询失败:', e);
                if (typeof callback === 'function') {
                    callback([]);
                }
            }
        },
        
        // 安全更新标签页
        update: function(tabId, updateProperties, callback) {
            const tabsAPI = getTabsAPI();
            if (!tabsAPI || typeof tabsAPI.update !== 'function') {
                console.warn('[标签页API] update不可用');
                if (typeof callback === 'function') {
                    callback();
                }
                return;
            }
            
            try {
                tabsAPI.update(tabId, updateProperties, function() {
                    if (typeof callback === 'function') {
                        callback();
                    }
                });
            } catch (e) {
                console.warn('[标签页API] 更新失败:', e);
                if (typeof callback === 'function') {
                    callback();
                }
            }
        },
        
        // 安全获取当前标签页
        getCurrent: function(callback) {
            const tabsAPI = getTabsAPI();
            if (!tabsAPI || typeof tabsAPI.getCurrent !== 'function') {
                console.warn('[标签页API] getCurrent不可用');
                if (typeof callback === 'function') {
                    callback(null);
                }
                return;
            }
            
            try {
                tabsAPI.getCurrent(function(tab) {
                    if (typeof callback === 'function') {
                        callback(tab);
                    }
                });
            } catch (e) {
                console.warn('[标签页API] 获取当前标签页失败:', e);
                if (typeof callback === 'function') {
                    callback(null);
                }
            }
        },
        
        // 安全创建标签页
        create: function(createProperties, callback) {
            const tabsAPI = getTabsAPI();
            if (!tabsAPI || typeof tabsAPI.create !== 'function') {
                console.warn('[标签页API] create不可用');
                if (typeof callback === 'function') {
                    callback(null);
                }
                return;
            }
            
            try {
                tabsAPI.create(createProperties, function(tab) {
                    if (typeof callback === 'function') {
                        callback(tab);
                    }
                });
            } catch (e) {
                console.warn('[标签页API] 创建失败:', e);
                if (typeof callback === 'function') {
                    callback(null);
                }
            }
        },
        
        // 安全获取onUpdated事件
        get onUpdated() {
            const tabsAPI = getTabsAPI();
            if (tabsAPI && tabsAPI.onUpdated) {
                return tabsAPI.onUpdated;
            }
            console.warn('[标签页API] tabs.onUpdated不可用');
            return null;
        }
    };

    // ==================== 最高优先级保护开关 ====================

    const PROTECTION_SETTINGS_KEYS = [
        'netguardSettings',
        'modeSettings',
        'protectionPaused',
        'paused'
    ];

    function resolveProtectionPaused(result) {
        const source = result || {};
        const unified = source.netguardSettings || source.modeSettings || {};

        return Boolean(
            source.protectionPaused ??
            unified.protectionPaused ??
            source.paused ??
            unified.paused ??
            false
        );
    }

    const protection = {
        resolvePausedState: resolveProtectionPaused,

        isPaused: function(callback) {
            storage.local.get(PROTECTION_SETTINGS_KEYS, function(result) {
                const paused = resolveProtectionPaused(result);
                if (typeof callback === 'function') callback(paused);
            });
        }
    };

    // ==================== 导出API ====================
    
    const extensionAPI = {
        storage: storage,
        runtime: runtime,
        tabs: tabs,
        protection: protection,
        
        // 检测是否为扩展环境
        isExtensionAvailable: function() {
            return !!rawAPI && 
                   !!rawAPI.storage && 
                   !!rawAPI.storage.local &&
                   !!rawAPI.runtime;
        },
        
        // 安全检测插件是否安装
        checkExtensionInstalled: function(callback) {
            if (!this.isExtensionAvailable()) {
                console.warn('[扩展检测] 扩展API不可用');
                if (typeof callback === 'function') {
                    callback(false);
                }
                return;
            }
            
            // 通过尝试读取存储来检测插件是否安装
            this.storage.local.get('netguardStats', function(result) {
                const installed = result !== undefined;
                if (typeof callback === 'function') {
                    callback(installed);
                }
            });
        }
    };

    // 全局暴露
    window.extensionAPI = extensionAPI;

    // 支持模块化导出
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = extensionAPI;
    }

})();
