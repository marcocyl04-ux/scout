// Scout — Content Script (auto-injected on every Blackboard page load)
// Installs fetch/XHR interceptor BEFORE Blackboard's own JS runs.

(function() {
    'use strict';
    if (!window.location.hostname.includes('learn.bu.edu')) return;
    
    const captures = [];
    
    // Intercept fetch
    const origFetch = window.fetch;
    window.fetch = function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        return origFetch.apply(this, args).then(response => {
            if (url && url.includes('/api/')) {
                const cloned = response.clone();
                cloned.text().then(text => {
                    try {
                        const data = JSON.parse(text);
                        captures.push({
                            url: url,
                            status: response.status,
                            keys: Object.keys(data).slice(0, 8),
                            resultCount: data?.results?.length,
                            data: data
                        });
                    } catch {}
                }).catch(() => {});
            }
            return response;
        });
    };
    
    // Intercept XHR
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._scoutUrl = url;
        return origOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
            if (this._scoutUrl && this._scoutUrl.includes('/api/')) {
                try {
                    const data = JSON.parse(this.responseText);
                    captures.push({
                        url: this._scoutUrl,
                        status: this.status,
                        keys: Object.keys(data).slice(0, 8),
                        resultCount: data?.results?.length,
                        data: data
                    });
                } catch {}
            }
        });
        return origSend.apply(this, args);
    };
    
    // Expose to popup via message passing
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === 'GET_CAPTURES') {
            sendResponse({ captures: captures });
        }
        if (msg.type === 'CLEAR_CAPTURES') {
            captures.length = 0;
            sendResponse({ ok: true });
        }
    });
    
    // Also expose on window for direct access
    window._scoutCaptures = captures;
    
    console.log('[Scout] Content script loaded — sniffing API calls');
})();
