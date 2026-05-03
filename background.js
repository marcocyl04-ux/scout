// Scout — Background Service Worker (v2)
// Minimal: storage + sync to local server. Popup handles all data fetching.

const STORAGE_KEY = 'scout_api_data';
const SYNC_URL = 'http://localhost:8080/api/extension-push';
const SYNC_ALARM_NAME = 'scout-server-sync';

console.log('[Scout] Service worker started');

// --- Store data pushed from popup ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STORE_DATA') {
        chrome.storage.local.set({ [STORAGE_KEY]: message.data }).then(() => {
            // Update badge
            const count = message.data?.responseCount || 0;
            chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
            chrome.action.setBadgeBackgroundColor({ color: '#6c72ff' });
            sendResponse({ ok: true });
        });
        return true;
    }
    
    if (message.type === 'GET_DATA') {
        chrome.storage.local.get(STORAGE_KEY).then(result => {
            sendResponse(result[STORAGE_KEY] || null);
        });
        return true;
    }
    
    if (message.type === 'SYNC_NOW') {
        syncToServer().then(sendResponse);
        return true;
    }
});

// --- Sync stored data to local server ---
async function syncToServer() {
    try {
        const result = await chrome.storage.local.get(STORAGE_KEY);
        const data = result[STORAGE_KEY];
        if (!data?.responses || Object.keys(data.responses).length === 0) {
            return { ok: false, reason: 'no_data' };
        }
        
        const resp = await fetch(SYNC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (resp.ok) {
            console.log('[Scout] Synced', data.responseCount, 'responses to server');
            return { ok: true };
        }
        return { ok: false, reason: 'http_' + resp.status };
    } catch(e) {
        return { ok: false, reason: e.message };
    }
}

// --- Periodic sync via alarms (reliable in MV3) ---
chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === SYNC_ALARM_NAME) {
        await syncToServer();
    }
});

// --- Badge on install ---
chrome.runtime.onInstalled.addListener(() => {
    console.log('[Scout] Extension installed/updated v2.0.0');
});
