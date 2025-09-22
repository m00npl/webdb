// Demo JavaScript functionality
let clickCount = 0;

document.addEventListener('DOMContentLoaded', function() {
    console.log('🚀 WebDB Demo loaded!');

    // Click counter functionality
    const clickBtn = document.getElementById('clickBtn');
    const counter = document.getElementById('counter');

    clickBtn.addEventListener('click', function() {
        clickCount++;
        counter.textContent = `Clicks: ${clickCount}`;

        // Add some visual feedback
        clickBtn.style.transform = 'scale(0.95)';
        setTimeout(() => {
            clickBtn.style.transform = 'scale(1)';
        }, 100);

        // Fun messages at certain milestones
        if (clickCount === 10) {
            showMessage('🎉 You reached 10 clicks!');
        } else if (clickCount === 25) {
            showMessage('🔥 25 clicks! You\'re on fire!');
        } else if (clickCount === 50) {
            showMessage('🚀 50 clicks! Amazing persistence!');
        }
    });

    // Color picker functionality
    const colorInput = document.getElementById('colorInput');
    colorInput.addEventListener('change', function() {
        const newColor = this.value;
        document.documentElement.style.setProperty('--primary-color', newColor);

        // Create a slightly darker variant for hover effects
        const darkerColor = adjustBrightness(newColor, -20);
        document.documentElement.style.setProperty('--primary-light', darkerColor);

        showMessage(`🎨 Theme color changed to ${newColor}`);
    });

    // Add some interactive animations
    addHoverEffects();

    // Show welcome message
    setTimeout(() => {
        showMessage('👋 Welcome to the WebDB demo! Try clicking the button and changing colors.');
    }, 1000);
});

function showMessage(text) {
    // Create a temporary message element
    const message = document.createElement('div');
    message.textContent = text;
    message.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: var(--primary-color);
        color: white;
        padding: 12px 16px;
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        z-index: 1000;
        font-weight: 500;
        transform: translateX(100%);
        transition: transform 0.3s ease;
    `;

    document.body.appendChild(message);

    // Animate in
    setTimeout(() => {
        message.style.transform = 'translateX(0)';
    }, 10);

    // Remove after 3 seconds
    setTimeout(() => {
        message.style.transform = 'translateX(100%)';
        setTimeout(() => {
            document.body.removeChild(message);
        }, 300);
    }, 3000);
}

function adjustBrightness(hex, amount) {
    // Remove # if present
    hex = hex.replace('#', '');

    // Parse r, g, b values
    const num = parseInt(hex, 16);
    const r = Math.max(0, Math.min(255, (num >> 16) + amount));
    const g = Math.max(0, Math.min(255, ((num >> 8) & 0x00FF) + amount));
    const b = Math.max(0, Math.min(255, (num & 0x0000FF) + amount));

    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function addHoverEffects() {
    // Add subtle animations to sections
    const sections = document.querySelectorAll('section');
    sections.forEach(section => {
        section.addEventListener('mouseenter', function() {
            this.style.transform = 'translateY(-2px)';
            this.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
        });

        section.addEventListener('mouseleave', function() {
            this.style.transform = 'translateY(0)';
            this.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.05)';
        });
    });
}

// Log some info about the demo
console.log(`
🌟 WebDB Demo Site
📡 Hosted on: Golem DB
🚀 Gateway: WebDB
📊 Performance: ${performance.now().toFixed(2)}ms load time
`);

// Demo data to show localStorage works
localStorage.setItem('webdb-demo-visit', new Date().toISOString());
console.log('💾 Demo visit saved to localStorage');