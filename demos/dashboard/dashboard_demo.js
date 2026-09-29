// 净网护航后台统计演示系统 - JavaScript
// 从 Flask API 读取真实数据库数据

let currentPage = 1;
let currentFilter = 'all';
let riskTrendChart = null;
let riskDistributionChart = null;
let currentStats = {};
let currentLogs = [];
let dailyStatsData = [];

const API_BASE_URL = 'http://127.0.0.1:5000';

// 初始化页面
document.addEventListener('DOMContentLoaded', function() {
    console.log('📊 [后台统计] 页面加载完成');
    
    // 加载数据
    loadRealData();
    
    // 设置定时刷新（每5秒刷新一次，实现实时同步）
    setInterval(loadRealData, 5000);
    console.log('📊 [后台统计] 实时刷新已启用，每5秒自动更新');
});

// 从 Flask API 加载真实数据
async function loadRealData() {
    try {
        console.log('📊 [统计系统] 开始从API加载数据...');
        
        // 并行请求统计数据和日志
        const [statsResponse, logsResponse] = await Promise.all([
            fetch(`${API_BASE_URL}/api/stats`),
            fetch(`${API_BASE_URL}/api/logs`)
        ]);
        
        const statsData = await statsResponse.json();
        const logsData = await logsResponse.json();
        
        if (statsData.status === 'success') {
            currentStats = statsData.data;
            dailyStatsData = statsData.data.trend_data || [];
            console.log('📊 [统计系统] 统计数据:', currentStats);
        }
        
        if (logsData.status === 'success') {
            currentLogs = logsData.data;
            console.log('📊 [统计系统] 日志数量:', currentLogs.length);
        }
        
        updateStatsDisplay();
        updateCharts();
        renderLogs();
        
        console.log('📊 [统计系统] 数据加载完成');
    } catch (e) {
        // 后端未启动时静默降级，使用模拟数据
        console.warn('📊 [统计系统] API不可用，使用模拟数据:', e);
        loadDefaultData();
    }
}

// 加载默认数据（降级模式）
function loadDefaultData() {
    currentStats = {
        ai_count: 0,
        url_count: 0,
        high_risk: 0,
        medium_risk: 0,
        low_risk: 0,
        today_count: 0,
        ad_block_count: 0,
        child_mode_count: 0,
        elder_mode_count: 0,
        trend_data: generateInitialDailyStats()
    };
    
    currentLogs = [];
    dailyStatsData = currentStats.trend_data;
    
    updateStatsDisplay();
    updateCharts();
    renderLogs();
}

// 生成初始每日统计数据
function generateInitialDailyStats() {
    const data = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        data.push({
            date: `${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`,
            count: 0
        });
    }
    return data;
}

// 更新统计显示
function updateStatsDisplay() {
    // AI检测次数
    animateNumber('ai-count', currentStats.ai_count || 0);
    // URL检测次数
    animateNumber('url-count', currentStats.url_count || 0);
    // 高风险拦截
    animateNumber('high-risk-count', currentStats.high_risk || 0);
    // 广告拦截次数
    animateNumber('ad-count', currentStats.ad_block_count || 0);
    // 儿童模式拦截
    animateNumber('child-block-count', currentStats.child_mode_count || 0);
    // 老人模式提醒
    animateNumber('elder-warn-count', currentStats.elder_mode_count || 0);
    // 今日风险总数
    animateNumber('today-risk-count', currentStats.today_count || 0);
    // 中风险检测
    animateNumber('medium-risk-count', currentStats.medium_risk || 0);
}

// 数字动画
function animateNumber(elementId, targetValue) {
    const element = document.getElementById(elementId);
    if (!element) return;
    
    const currentValue = parseInt(element.textContent.replace(/,/g, '')) || 0;
    const duration = 1000;
    const startTime = Date.now();
    
    function update() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // 使用缓动函数
        const easeOutQuart = 1 - Math.pow(1 - progress, 4);
        const current = Math.floor(currentValue + (targetValue - currentValue) * easeOutQuart);
        
        element.textContent = current.toLocaleString();
        
        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }
    
    update();
}

// 更新图表
function updateCharts() {
    updateRiskTrendChart();
    updateRiskDistributionChart();
}

// 更新风险趋势图
function updateRiskTrendChart() {
    const ctx = document.getElementById('riskTrendChart');
    if (!ctx) return;
    
    const labels = dailyStatsData.map(item => item.date);
    const data = dailyStatsData.map(item => item.count);
    
    if (riskTrendChart) {
        riskTrendChart.destroy();
    }
    
    riskTrendChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: '检测次数',
                data: data,
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointBackgroundColor: '#3b82f6',
                pointBorderColor: '#fff',
                pointBorderWidth: 2,
                pointRadius: 5,
                pointHoverRadius: 8
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(17, 24, 39, 0.9)',
                    titleColor: '#fff',
                    bodyColor: '#9ca3af',
                    borderColor: '#3b82f6',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: false,
                    callbacks: {
                        label: function(context) {
                            return `检测次数: ${context.parsed.y}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#9ca3af',
                        font: {
                            size: 11
                        }
                    }
                },
                y: {
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#9ca3af',
                        font: {
                            size: 11
                        },
                        stepSize: 5
                    }
                }
            }
        }
    });
}

// 更新风险分布图
function updateRiskDistributionChart() {
    const ctx = document.getElementById('riskDistributionChart');
    if (!ctx) return;
    
    const highRisk = currentStats.high_risk || 0;
    const mediumRisk = currentStats.medium_risk || 0;
    const lowRisk = currentStats.low_risk || 0;
    const safeCount = (currentStats.ai_count || 0) - highRisk - mediumRisk - lowRisk;
    
    if (riskDistributionChart) {
        riskDistributionChart.destroy();
    }
    
    riskDistributionChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['高风险', '中风险', '低风险', '安全'],
            datasets: [{
                data: [highRisk, mediumRisk, lowRisk, Math.max(0, safeCount)],
                backgroundColor: [
                    'rgba(239, 68, 68, 0.8)',
                    'rgba(251, 191, 36, 0.8)',
                    'rgba(59, 130, 246, 0.8)',
                    'rgba(34, 197, 94, 0.8)'
                ],
                borderColor: [
                    'rgba(239, 68, 68, 1)',
                    'rgba(251, 191, 36, 1)',
                    'rgba(59, 130, 246, 1)',
                    'rgba(34, 197, 94, 1)'
                ],
                borderWidth: 2,
                hoverOffset: 10
            }]
        },
        options: {
            responsive: true,
            cutout: '65%',
            plugins: {
                legend: {
                    position: 'right',
                    labels: {
                        color: '#9ca3af',
                        padding: 15,
                        usePointStyle: true,
                        pointStyle: 'circle',
                        font: {
                            size: 12
                        }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(17, 24, 39, 0.9)',
                    titleColor: '#fff',
                    bodyColor: '#9ca3af',
                    borderColor: '#1f2937',
                    borderWidth: 1,
                    padding: 12,
                    callbacks: {
                        label: function(context) {
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = total > 0 ? ((context.parsed / total) * 100).toFixed(1) : 0;
                            return `${context.label}: ${context.parsed} (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });
}

// 渲染日志列表
function renderLogs() {
    const logsBody = document.getElementById('logs-body');
    const emptyLogs = document.getElementById('empty-logs');
    const totalLogs = document.getElementById('total-logs');
    
    if (!logsBody) return;
    
    if (currentLogs.length === 0) {
        logsBody.style.display = 'none';
        if (emptyLogs) emptyLogs.style.display = 'block';
        if (totalLogs) totalLogs.textContent = '0';
        return;
    }
    
    // 显示表格，隐藏空状态
    logsBody.style.display = 'table-row-group';
    if (emptyLogs) emptyLogs.style.display = 'none';
    if (totalLogs) totalLogs.textContent = currentLogs.length.toString();
    
    const logsHtml = currentLogs.slice(0, 10).map(log => `
        <tr class="log-item" data-risk="${log.risk_level}">
            <td>${formatTime(log.created_at)}</td>
            <td>${getLogTypeLabel(log.type)}</td>
            <td><span class="risk-badge ${log.risk_level}">${getRiskLevelLabel(log.risk_level)}</span></td>
            <td>${truncateUrl(log.url)}</td>
            <td>${log.reason || '无'}</td>
        </tr>
    `).join('');
    
    logsBody.innerHTML = logsHtml;
}

// 获取日志类型标签
function getLogTypeLabel(type) {
    const labels = {
        'ai_check': 'AI检测',
        'url_check': 'URL检测',
        'ad_block': '广告拦截',
        'child_mode': '儿童模式',
        'elder_mode': '老人模式'
    };
    return labels[type] || type;
}

// 获取风险等级标签
function getRiskLevelLabel(level) {
    const labels = {
        'safe': '安全',
        'low': '低风险',
        'medium': '中风险',
        'high': '高风险'
    };
    return labels[level] || level;
}

// 截断URL
function truncateUrl(url, maxLength = 30) {
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength) + '...';
}

// 格式化时间
function formatTime(timestamp) {
    if (!timestamp || timestamp === 'N/A') {
        return '刚刚';
    }
    
    try {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        
        if (diff < 60000) {
            return '刚刚';
        } else if (diff < 3600000) {
            return `${Math.floor(diff / 60000)}分钟前`;
        } else if (diff < 86400000) {
            return `${Math.floor(diff / 3600000)}小时前`;
        } else {
            return date.toLocaleDateString('zh-CN');
        }
    } catch {
        return timestamp;
    }
}

// 搜索日志
function searchLogs() {
    const searchTerm = document.getElementById('log-search-input').value.toLowerCase();
    const logItems = document.querySelectorAll('.log-item');
    
    logItems.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(searchTerm) ? 'flex' : 'none';
    });
}

// 过滤日志
function filterLogs(filter) {
    currentFilter = filter;
    const logItems = document.querySelectorAll('.log-item');
    
    logItems.forEach(item => {
        const riskLevel = item.dataset.risk;
        if (filter === 'all' || riskLevel === filter) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
    
    // 更新按钮状态
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
}

// 刷新数据
function refreshData() {
    console.log('📊 [统计系统] 手动刷新数据...');
    loadRealData();
}

// 改变时间范围
function changeTimeRange(range) {
    console.log(`📊 [统计系统] 切换时间范围: ${range}`);
    // 更新按钮状态
    document.querySelectorAll('.time-filter button').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('onclick')?.includes(range));
    });
    // 当前只支持7天数据，其他范围暂时使用相同数据
    loadRealData();
}