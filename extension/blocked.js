// blocked.js - 拦截页面脚本

document.addEventListener('DOMContentLoaded', () => {
    // 获取URL参数
    const params = new URLSearchParams(window.location.search);
    const blockedUrl = params.get('url');
    const reason = params.get('reason') || 'danger';

    // 显示被拦截的网址
    const urlElement = document.getElementById('blocked-url');
    if (urlElement && blockedUrl) {
        urlElement.textContent = decodeURIComponent(blockedUrl);
    }

    // 根据原因设置不同的样式和文案
    updatePageByReason(reason);

    // 返回上一页按钮
    document.getElementById('go-back').addEventListener('click', () => {
        window.history.back();
    });

    // 前往首页按钮
    document.getElementById('go-home').addEventListener('click', () => {
        chrome.tabs.update({ url: 'https://www.baidu.com' });
    });
});

function updatePageByReason(reason) {
    const card = document.querySelector('.blocked-card');
    const icon = document.querySelector('.icon');
    const title = document.querySelector('.blocked-title');
    const badge = document.querySelector('.reason-badge');
    const text = document.querySelector('.reason-text');
    const hint = document.querySelector('.protection-hint p');

    switch (reason) {
        case 'entertainment':
            card.classList.add('entertainment');
            icon.textContent = '🎮';
            title.textContent = '娱乐网站访问受限';
            badge.textContent = '⏰ 娱乐限制';
            badge.classList.remove('danger');
            badge.classList.add('entertainment');
            text.textContent = '当前处于儿童安全模式，娱乐网站访问已受限。';
            hint.textContent = '学习时间，请专注于学习内容';
            break;

        case 'learning':
            card.classList.add('learning');
            icon.textContent = '📚';
            title.textContent = '非学习网站已拦截';
            badge.textContent = '📖 学习模式';
            badge.classList.remove('danger');
            badge.classList.add('learning');
            text.textContent = '学习模式已开启，仅允许访问白名单内的学习网站。';
            hint.textContent = '学习模式保护已开启，专注学习更高效';
            break;

        case 'danger':
        default:
            card.classList.add('danger');
            icon.textContent = '🛡️';
            title.textContent = '网站访问被拦截';
            badge.textContent = '⚠️ 危险网站';
            badge.classList.add('danger');
            text.textContent = '您访问的网站包含不适宜内容，已被儿童安全模式阻止。';
            hint.textContent = '儿童模式保护已开启，为孩子营造健康的上网环境';
            break;
    }
}