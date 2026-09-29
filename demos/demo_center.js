// 净网护航功能演示中心 - JavaScript 文件

document.addEventListener('DOMContentLoaded', function() {
    // 初始化页面
    initPage();
});

function initPage() {
    // 绑定卡片点击事件
    bindCardClickEvents();
    
    // 添加页面加载动画
    addPageLoadAnimation();
    
    // 添加粒子效果控制
    initParticleEffects();
    
    // 显示欢迎消息
    console.log('🎉 净网护航功能演示中心已加载');
}

// 绑定卡片点击事件
function bindCardClickEvents() {
    const cards = document.querySelectorAll('.module-card');
    
    cards.forEach(card => {
        card.addEventListener('click', function(e) {
            // 阻止默认行为
            e.preventDefault();
            
            // 获取目标URL
            const targetUrl = this.getAttribute('data-href');
            
            // 添加点击动画效果
            addClickAnimation(this);
            
            // 延迟跳转，等待动画完成
            setTimeout(() => {
                if (targetUrl) {
                    navigateToPage(targetUrl);
                }
            }, 300);
        });
    });
}

// 添加点击动画
function addClickAnimation(element) {
    // 创建涟漪效果
    const ripple = document.createElement('span');
    ripple.className = 'ripple-effect';
    
    // 获取点击位置
    const rect = element.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = event.clientX - rect.left - size / 2;
    const y = event.clientY - rect.top - size / 2;
    
    // 设置涟漪样式
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';
    
    // 添加到卡片
    element.appendChild(ripple);
    
    // 动画结束后移除涟漪
    ripple.addEventListener('animationend', function() {
        ripple.remove();
    });
}

// 页面导航
function navigateToPage(url) {
    // 检查页面是否存在
    console.log(`🔗 正在跳转至: ${url}`);
    
    // 创建一个隐藏的iframe来检查页面是否存在
    const checkFrame = document.createElement('iframe');
    checkFrame.style.display = 'none';
    checkFrame.onload = function() {
        // 页面存在，跳转
        window.location.href = url;
        checkFrame.remove();
    };
    checkFrame.onerror = function() {
        // 页面不存在，显示提示
        showPageNotFound(url);
        checkFrame.remove();
    };
    
    document.body.appendChild(checkFrame);
    checkFrame.src = url;
}

// 显示页面不存在提示
function showPageNotFound(url) {
    // 创建提示弹窗
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-icon">🔄</div>
            <h3 class="modal-title">页面开发中</h3>
            <p class="modal-desc">${url} 功能模块正在开发中，敬请期待！</p>
            <button class="modal-btn" onclick="closeModal()">确定</button>
        </div>
    `;
    
    // 添加样式
    const style = document.createElement('style');
    style.textContent = `
        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(5px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 9999;
            animation: fadeIn 0.3s ease;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        
        .modal-content {
            background: linear-gradient(135deg, #1a1f35, #252d4a);
            border-radius: 20px;
            padding: 40px;
            text-align: center;
            max-width: 400px;
            width: 90%;
            border: 1px solid rgba(66, 153, 225, 0.3);
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
            animation: slideUp 0.3s ease;
        }
        
        @keyframes slideUp {
            from { transform: translateY(20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }
        
        .modal-icon {
            font-size: 50px;
            margin-bottom: 20px;
            animation: bounce 1s infinite;
        }
        
        @keyframes bounce {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.2); }
        }
        
        .modal-title {
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 15px;
            color: #ffffff;
        }
        
        .modal-desc {
            font-size: 14px;
            color: rgba(255, 255, 255, 0.7);
            margin-bottom: 25px;
        }
        
        .modal-btn {
            padding: 12px 30px;
            background: linear-gradient(90deg, #4299e1, #63b3ed);
            border: none;
            border-radius: 30px;
            color: white;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        
        .modal-btn:hover {
            transform: scale(1.05);
            box-shadow: 0 10px 20px rgba(66, 153, 225, 0.4);
        }
        
        .ripple-effect {
            position: absolute;
            border-radius: 50%;
            background: rgba(66, 153, 225, 0.4);
            transform: scale(0);
            animation: ripple-animation 0.6s ease-out;
            pointer-events: none;
        }
        
        @keyframes ripple-animation {
            to {
                transform: scale(4);
                opacity: 0;
            }
        }
    `;
    
    document.head.appendChild(style);
    document.body.appendChild(modal);
    
    // 点击遮罩层也可关闭
    modal.addEventListener('click', function(e) {
        if (e.target === modal) {
            closeModal();
        }
    });
}

// 关闭弹窗
function closeModal() {
    const modal = document.querySelector('.modal-overlay');
    if (modal) {
        modal.style.animation = 'fadeOut 0.3s ease';
        setTimeout(() => {
            modal.remove();
        }, 300);
    }
}

// 添加页面加载动画
function addPageLoadAnimation() {
    // 为卡片添加入场动画
    const cards = document.querySelectorAll('.module-card');
    
    cards.forEach((card, index) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(30px)';
        card.style.transition = 'all 0.5s ease';
        
        setTimeout(() => {
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
        }, 100 + index * 100);
    });
}

// 初始化粒子效果
function initParticleEffects() {
    const particles = document.querySelectorAll('.particle');
    
    particles.forEach((particle, index) => {
        // 设置随机大小
        const size = Math.random() * 4 + 2;
        particle.style.width = size + 'px';
        particle.style.height = size + 'px';
        
        // 设置随机延迟
        particle.style.animationDelay = (Math.random() * 5) + 's';
        
        // 设置随机持续时间
        particle.style.animationDuration = (10 + Math.random() * 10) + 's';
        
        // 设置随机位置
        particle.style.left = (Math.random() * 100) + '%';
    });
}

// 键盘导航支持
document.addEventListener('keydown', function(e) {
    const cards = document.querySelectorAll('.module-card');
    const currentIndex = Array.from(cards).findIndex(card => card.classList.contains('focused'));
    
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        const nextIndex = (currentIndex + 1) % cards.length;
        cards.forEach(c => c.classList.remove('focused'));
        cards[nextIndex].classList.add('focused');
        cards[nextIndex].focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const prevIndex = (currentIndex - 1 + cards.length) % cards.length;
        cards.forEach(c => c.classList.remove('focused'));
        cards[prevIndex].classList.add('focused');
        cards[prevIndex].focus();
    } else if (e.key === 'Enter') {
        const focusedCard = document.querySelector('.module-card.focused');
        if (focusedCard) {
            focusedCard.click();
        }
    }
});

// 平滑滚动
function smoothScrollTo(element) {
    element.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
    });
}

// 导出函数供外部使用
window.navigateToPage = navigateToPage;
window.closeModal = closeModal;