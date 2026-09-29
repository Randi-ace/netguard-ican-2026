console.log('🔒 净网护航后台服务启动');

// 危险URL关键词
const DANGEROUS_URL_KEYWORDS = [
  "gambling", "casino", "bet", "porn", "adult", "xxx",
  "phishing", "bank-login", "fake-bank", "lottery", "hack"
];

function isDangerousUrl(url) {
  const lowerUrl = url.toLowerCase();
  return DANGEROUS_URL_KEYWORDS.some(keyword => lowerUrl.includes(keyword));
}

async function checkUrlWithFlask(url) {
  try {
    const response = await fetch('http://127.0.0.1:5000/url/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    });
    return await response.json();
  } catch (error) {
    console.error('Flask请求失败:', error);
    return null;
  }
}

function getWarningPageUrl(originalUrl, risk, reason) {
  const params = new URLSearchParams({
    type: 'url_block',
    url: originalUrl,
    risk: risk || 'high',
    reason: reason || '检测到危险网站',
    source: originalUrl
  });
  return chrome.runtime.getURL('warning.html') + '?' + params.toString();
}

async function performUrlCheck(url, tabId) {
  console.log(`🔍 检测URL: ${url}`);
  
  if (isDangerousUrl(url)) {
    console.log(`⚠️ 命中危险关键词`);
    const result = await checkUrlWithFlask(url);
    
    if (result && result.risk === 'high') {
      console.log(`🚨 检测到高风险，跳转警告页面`);
      const warningUrl = getWarningPageUrl(url, result.risk, result.reason);
      chrome.tabs.update(tabId, { url: warningUrl });
    }
  }
}

// 监听标签页更新
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;
  const url = tab.url;
  if (!url || url.startsWith(chrome.runtime.getURL(''))) return;
  
  console.log(`📥 tabs.onUpdated: ${url}`);
  
  if (url.startsWith('file://')) {
    await performUrlCheck(url, tabId);
  }
});

// 监听标签页切换
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    const url = tab.url;
    console.log(`🔄 tabs.onActivated: ${url}`);
    
    if (url && url.startsWith('file://') && !url.startsWith(chrome.runtime.getURL(''))) {
      await performUrlCheck(url, activeInfo.tabId);
    }
  } catch (e) {
    console.error('获取标签页失败:', e);
  }
});

console.log('✅ 后台服务初始化完成');