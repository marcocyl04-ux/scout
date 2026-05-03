// Scout — API Interceptor
// Injected into Blackboard pages. Intercepts fetch/XHR responses and sends them to the extension.

(function() {
    'use strict';
    
    // Only run on learn.bu.edu
    if (!window.location.hostname.includes('learn.bu.edu')) return;
    
    const API_PREFIX = '/learn/api/';
    const TAG = '[Scout]';
    
    // --- Visual indicator (proves injection worked) ---
    function showBanner(msg, color) {
        try {
            const el = document.createElement('div');
            el.id = 'scout-injected-banner';
            el.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:999999;padding:6px 12px;background:${color};color:white;font:13px monospace;text-align:center;opacity:0.9;pointer-events:none;`;
            el.textContent = msg;
            document.documentElement.appendChild(el);
            setTimeout(() => el.remove(), 4000);
        } catch(e) {}
    }
    
    // Show banner when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => showBanner(TAG + ' Interceptor active — capturing API calls', '#6c72ff'));
    } else {
        showBanner(TAG + ' Interceptor active — capturing API calls', '#6c72ff');
    }
    
    console.log(TAG, 'API interceptor loaded on', window.location.href);
    
    let captureCount = 0;
    
    function shouldCapture(url) {
        return typeof url === 'string' && url.includes(API_PREFIX);
    }
    
    function sendToExtension(url, data) {
        try {
            captureCount++;
            console.log(TAG, 'Captured #' + captureCount, url.split('?')[0]);
            chrome.runtime.sendMessage({
                type: 'API_RESPONSE',
                url: url,
                data: data,
                timestamp: Date.now()
            });
        } catch(e) {
            console.warn(TAG, 'Failed to send to extension:', e.message);
        }
    }
    
    // --- Intercept fetch ---
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        
        return originalFetch.apply(this, args).then(response => {
            if (shouldCapture(url)) {
                const cloned = response.clone();
                cloned.text().then(text => {
                    try {
                        sendToExtension(url, JSON.parse(text));
                    } catch {
                        // Not JSON, skip
                    }
                }).catch(() => {});
            }
            return response;
        });
    };
    
    console.log(TAG, 'fetch interceptor installed');
    
    // --- Intercept XMLHttpRequest ---
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._scoutUrl = url;
        return originalOpen.apply(this, [method, url, ...rest]);
    };
    
    XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
            if (shouldCapture(this._scoutUrl) && this.status >= 200 && this.status < 300) {
                try {
                    sendToExtension(this._scoutUrl, JSON.parse(this.responseText));
                } catch {
                    // Not JSON, skip
                }
            }
        });
        return originalSend.apply(this, args);
    };
    
    console.log(TAG, 'XHR interceptor installed');
    console.log(TAG, 'Waiting for API calls...');
})();
