// Scout — Popup v3.4.1
// Rendering + message passing. Extraction runs in background.js.

const COLORS = ['#6c72ff', '#54a0ff', '#2ed573', '#ff9f43', '#ff5c5c', '#a55eea', '#ffc048'];

let courses = {};
let ignoredDeadlines = new Set();
let searchQuery = '';

// --- Helpers (keep in sync with background.js) ---
// Deterministic color from course ID — same ID always gets same color
function courseColor(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash) + id.charCodeAt(i);
    return COLORS[Math.abs(hash) % COLORS.length];
}
function shortName(info) {
    if (!info?.displayId) return '?';
    const stripped = info.displayId.replace(/^\d{2}[a-z]+(?:qst|cas|eng|met|smg|cgs|sar|sph|sha|gms|law|sed|wheel)/i, '');
    const m = stripped.match(/(?:[a-z]{2})?([a-z]{2,4})(\d{2,3})/i);
    return m ? (m[1] + m[2]).toUpperCase() : info.displayId.slice(-12);
}
function daysUntil(s) {
    if (!s) return null;
    const d = new Date(s), now = new Date();
    d.setHours(0,0,0,0); now.setHours(0,0,0,0);
    return Math.ceil((d - now) / 86400000);
}

// --- File bundling (path-based matching) ---
function getTopFolder(path) {
    if (!path) return null;
    return path.split(' / ')[0]?.trim() || null;
}
function flattenFiles(items, parentPath) {
    const flat = [];
    for (const item of items) {
        if (item.type === 'file') {
            flat.push({ ...item, parentFolder: getTopFolder(item.path || parentPath) });
        }
        if (item.children?.length) {
            flat.push(...flattenFiles(item.children, item.path || parentPath));
        }
    }
    return flat;
}
function bundleFilesForDeadline(deadline, courseFiles) {
    if (!courseFiles?.length) return [];
    const flat = flattenFiles(courseFiles);
    const dlTitle = (deadline.title || '').toLowerCase();
    const dlWords = dlTitle.split(/\s+/).filter(w => w.length > 3);
    const matched = [];
    const seen = new Set();

    for (const file of flat) {
        if (seen.has(file.name)) continue;
        const fname = (file.name || '').toLowerCase();
        const fpath = (file.path || '').toLowerCase();
        const ffolder = (file.parentFolder || '').toLowerCase();
        let hit = false;

        // Strategy 1: Deadline title substring in file path (most reliable)
        if (dlTitle.length > 3 && fpath.includes(dlTitle)) hit = true;
        // Strategy 2: Deadline title substring in parent folder name
        if (!hit && dlTitle.length > 3 && ffolder.includes(dlTitle)) hit = true;
        // Strategy 3: Folder name matches significant deadline words (>=2 words)
        if (!hit && dlWords.length >= 2) {
            const folderWords = ffolder.split(/[\s\-_/]+/).filter(w => w.length > 2);
            const overlap = dlWords.filter(w => folderWords.some(fw => fw.includes(w) || w.includes(fw)));
            if (overlap.length >= 2) hit = true;
        }

        if (hit) {
            seen.add(file.name);
            matched.push(file);
        }
    }
    return matched.slice(0, 5);
}

// --- Greeting ---
function updateGreeting() {
    const el = document.getElementById('greeting');
    if (!el) return;
    const h = new Date().getHours();
    if (h < 12) el.textContent = "good morning, here's your week";
    else if (h < 17) el.textContent = "afternoon \u2014 let's see what's due";
    else if (h < 21) el.textContent = "evening check-in";
    else el.textContent = "still up? here's what's left";
}

// --- Main render ---
function renderDashboard() {
    const courseCount = Object.keys(courses).length;
    const stored = document.getElementById('meta')?.dataset?.extractedAt;
    let freshness = '';
    if (stored) {
        const ageMin = Math.floor((Date.now() - parseInt(stored)) / 60000);
        if (ageMin < 1) freshness = ' \u00b7 just now';
        else if (ageMin < 60) freshness = ` \u00b7 ${ageMin}m ago`;
        else freshness = ` \u00b7 ${Math.floor(ageMin/60)}h ago`;
    }
    document.getElementById('meta').textContent = `${courseCount} courses${freshness}`;

    const allItems = [];
    const courseNames = {};
    for (const [id, c] of Object.entries(courses)) {
        const name = shortName(c), color = courseColor(id);
        courseNames[id] = { name, color };
        for (const d of (c.deadlines || [])) {
            const days = daysUntil(d.dueDate);
            // Skip deadlines older than 14 days (both upcoming and completed)
            if (days !== null && days < -14) continue;
            const dlKey = `${id}-${d.title}-${d.dueDate}`;
            if (ignoredDeadlines.has(dlKey)) continue;
            const st = (d.status || '').toUpperCase();
            const isDone = st === 'GRADED' || st === 'SUBMITTED';
            const entry = { ...d, shortName: name, color, courseId: id, isDone, dlKey };
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                if (!(d.title || '').toLowerCase().includes(q) && !name.toLowerCase().includes(q)) continue;
            }
            allItems.push(entry);
        }
    }

    renderUpcoming(allItems, courseNames);
    renderLog(allItems);
    updateGreeting();

    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    document.getElementById('startScreen').classList.add('hidden');
}


// --- Upcoming ---
const TYPE_ORDER = ['homework', 'exam', 'in-class'];
const TYPE_LABELS = { homework: 'Homework', assignment: 'Homework', exam: 'Exams', 'in-class': 'In-Class' };

function renderUpcoming(allItems, courseNames) {
    const el = document.getElementById('upcoming');
    // Bug #16 fix: filter out items with no dueDate (they have no place in "upcoming")
    // and exclude overdue items (days < 0) so they only appear in the completed/overdue tab.
    const upcoming = allItems.filter(d => {
        if (d.isDone) return false;
        if (!d.dueDate) return false; // Bug #16: exclude null/undefined dueDate items
        const days = daysUntil(d.dueDate);
        return days !== null && days >= 0; // only truly upcoming (not overdue) items
    });

    // Group upcoming items by course, then by type
    const grouped = {};
    for (const d of upcoming) {
        const key = d.courseId;
        if (!grouped[key]) grouped[key] = {};
        const tp = (d.type === 'assignment') ? 'homework' : (d.type || 'homework');
        if (!grouped[key][tp]) grouped[key][tp] = [];
        grouped[key][tp].push(d);
    }

    // Render all courses (even those with nothing due)
    const courseIds = Object.keys(courseNames);
    let html = '';
    for (const id of courseIds) {
        const info = courseNames[id];
        const types = grouped[id] || {};
        const hasItems = Object.values(types).some(arr => arr.length > 0);

        html += `<div class="course-group"><div class="course-name" style="color:${info.color}">${info.name}</div>`;

        if (!hasItems) {
            html += `<p class="empty-msg">nothing due</p>`;
        } else {
            for (const tp of TYPE_ORDER) {
                const items = types[tp];
                if (!items?.length) continue;
                items.sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
                html += `<div class="type-group"><div class="type-label">${TYPE_LABELS[tp] || tp}</div>`;
                for (const d of items) html += renderUpcomingCard(d);
                html += `</div>`;
            }
        }
        html += `</div>`;
    }
    el.innerHTML = html;
    attachExpandListeners(el);
}

function renderUpcomingCard(entry) {
    const days = daysUntil(entry.dueDate);
    let dayText = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days > 1 ? `${days}d` : `${Math.abs(days)}d ago`;
    const isUrgent = days !== null && days <= 1;
    const isOverdue = days !== null && days < 0;
    const course = courses[entry.courseId];
    const bundled = bundleFilesForDeadline(entry, course?.files);
    let html = `<div class="task${isOverdue ? ' overdue' : ''}">`;
    html += `<div class="task-title">${entry.title}</div>`;
    html += `<div class="task-meta"><span class="task-due${isUrgent ? ' urgent' : ''}">${dayText}</span>`;
    html += `<span class="task-type">${TYPE_LABELS[entry.type] || 'Task'}</span></div>`;
    html += `<div class="task-expand"><div class="task-expand-inner">`;
    html += renderExpandContent(entry, bundled);
    html += `</div></div></div>`;
    return html;
}

// --- Shared expand content ---
function renderExpandContent(entry, bundled) {
    let html = '';
    if (bundled.length > 0) {
        html += `<div class="expand-label">Materials</div><div class="expand-files">`;
        for (const file of bundled) {
            const href = file.downloadUrl
                ? (file.downloadUrl.startsWith('http') ? file.downloadUrl : `https://learn.bu.edu${file.downloadUrl}`)
                : '#';
            html += `<a class="expand-file" href="${href}" target="_blank">${file.name}</a>`;
        }
        html += `</div><div class="expand-file-note">Files open in Blackboard</div>`;
    }
    if (entry.instructions) {
        html += `<div class="expand-label">Instructions</div><div class="expand-instructions">${entry.instructions}</div>`;
    }
    html += `<div class="expand-actions"><button class="btn primary ai-prompt-btn" data-title="${entry.title.replace(/"/g, '&quot;')}" data-course="${entry.shortName}" data-instructions="${(entry.instructions || '').replace(/"/g, '&quot;').replace(/\n/g, ' ').slice(0, 500)}" data-files="${bundled.map(f => f.name).join(', ')}">Ask AI</button></div>`;
    html += `<div class="ai-prompt-preview hidden"><textarea class="ai-prompt-text" rows="6"></textarea>`;
    html += `<div class="ai-prompt-actions"><button class="ai-copy-btn">Copy</button><button class="ai-close-btn">&times;</button></div></div>`;
    return html;
}

// --- Log ---
function renderLog(allItems) {
    const el = document.getElementById('log');
    const done = allItems.filter(d => d.isDone).slice(0, 10);
    const overdue = allItems.filter(d => !d.isDone && daysUntil(d.dueDate) !== null && daysUntil(d.dueDate) < 0);
    if (!done.length && !overdue.length) { el.innerHTML = '<p class="empty-msg">Nothing to report</p>'; return; }
    let html = '';
    if (done.length) {
        html += '<div class="section-label">submitted</div>';
        for (const d of done) {
            const gradeText = (d.status || '').toUpperCase() === 'GRADED'
                ? `graded \u00b7 ${d.score != null ? (d.pointsPossible ? Math.round(d.score / d.pointsPossible * 100) : d.score) : ''}`
                : 'submitted';
            html += `<div class="log-row"><span class="log-title">${d.title}</span><span class="log-course" style="color:${d.color}">${d.shortName}</span><span class="log-badge">${gradeText}</span></div>`;
        }
    }
    if (overdue.length) {
        if (done.length) html += '<div class="divider"></div>';
        html += '<div class="section-label">overdue</div>';
        for (const d of overdue) {
            const days = daysUntil(d.dueDate);
            html += `<div class="log-row"><span class="log-title overdue">${d.title}</span><span class="log-course" style="color:${d.color}">${d.shortName}</span><span class="log-overdue">${Math.abs(days)}d ago</span><button class="log-ignore" data-key="${d.dlKey}" title="Dismiss">&times;</button></div>`;
        }
    }
    el.innerHTML = html;
    attachExpandListeners(el);
}

// --- Event listeners ---
function attachExpandListeners(el) {
    el.querySelectorAll('.row').forEach(row => {
        row.querySelector('.row-head')?.addEventListener('click', () => row.classList.toggle('open'));
    });
    el.querySelectorAll('.task').forEach(task => {
        task.addEventListener('click', () => task.classList.toggle('expanded'));
    });
    el.querySelectorAll('.ai-prompt-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            let prompt = `Help me with this assignment for ${btn.dataset.course}:\n\n"${btn.dataset.title}"`;
            if (btn.dataset.instructions) prompt += `\n\nInstructions:\n${btn.dataset.instructions}`;
            if (btn.dataset.files) prompt += `\n\nRelevant files: ${btn.dataset.files}`;
            prompt += `\n\nPlease help me understand what's required and how to approach this.`;
            const preview = btn.closest('.expand-actions').nextElementSibling;
            const textarea = preview.querySelector('.ai-prompt-text');
            textarea.value = prompt;
            preview.classList.remove('hidden');
            textarea.focus(); textarea.select();
        });
    });
    el.querySelectorAll('.ai-copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const textarea = btn.closest('.ai-prompt-preview').querySelector('.ai-prompt-text');
            navigator.clipboard.writeText(textarea.value).then(() => {
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
            });
        });
    });
    el.querySelectorAll('.ai-close-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.closest('.ai-prompt-preview').classList.add('hidden');
        });
    });
    el.querySelectorAll('.log-ignore').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            ignoredDeadlines.add(btn.dataset.key);
            chrome.storage.local.set({ scout_ignored: [...ignoredDeadlines] });
            renderDashboard();
        });
    });
}

// --- Start extraction (message to background) ---
function startExtraction() {
    document.getElementById('loadingState').classList.remove('hidden');
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('startScreen').classList.add('hidden');
    chrome.runtime.sendMessage({ type: 'START_EXTRACTION' });
}

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
    const startScreen = document.getElementById('startScreen');
    const dashboard = document.getElementById('dashboard');
    const loading = document.getElementById('loadingState');

    // Tab switching (bind once)
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.views').forEach(v => v.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.view).classList.add('active');
        });
    });

    // Refresh button (bind once)
    document.getElementById('refreshBtn').addEventListener('click', () => startExtraction());

    // Search input (bind once)
    document.getElementById('searchInput').addEventListener('input', (e) => {
        searchQuery = e.target.value.trim();
        renderDashboard();
    });

    // Listen for background messages
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'EXTRACTION_DONE') {
            loadAndRender();
        }
        if (msg.type === 'EXTRACTION_LOG') {
            const el = document.getElementById('loadingSub');
            if (el) el.textContent = msg.msg;
        }
        if (msg.type === 'EXTRACTION_ERROR') {
            const el = document.getElementById('loadingSub');
            if (el) el.textContent = `Error: ${msg.error}`;
        }
    });

    // 1. Check cached data first
    const stored = await chrome.storage.local.get(['scout_data', 'scout_extracting', 'scout_ignored']);
    const data = stored?.scout_data;
    const wasExtracting = stored?.scout_extracting;

    if (data?.courses && data?.extractedAt) {
        const ageMin = (Date.now() - data.extractedAt) / 60000;
        if (ageMin < 120) {
            courses = data.courses;
            ignoredDeadlines = new Set(stored?.scout_ignored || []);
            const metaEl = document.getElementById('meta');
            if (metaEl) metaEl.dataset.extractedAt = data.extractedAt;
            startScreen.classList.add('hidden');
            renderDashboard();
            // Still check if extraction is running
            try {
                const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
                if (status?.extracting) {
                    loading.classList.remove('hidden');
                }
            } catch(e) {}
            return;
        }
    }

    // 2. Check if background is extracting
    let bgExtracting = false;
    try {
        const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
        bgExtracting = status?.extracting;
    } catch(e) { /* service worker may be idle */ }

    // 3. Stale extraction flag cleanup:
    // If storage says extracting but background says no — the service worker restarted.
    // Clear the stale flag so we don't show a stuck spinner.
    if (wasExtracting && !bgExtracting) {
        chrome.storage.local.remove('scout_extracting');
    }

    if (bgExtracting) {
        loading.classList.remove('hidden');
        startScreen.classList.add('hidden');
        return;
    }

    // 4. No data, not extracting — show onboarding
    startScreen.classList.remove('hidden');
    document.getElementById('startBtn').addEventListener('click', () => startExtraction());
});

// --- Load data from storage and render ---
async function loadAndRender() {
    const stored = await chrome.storage.local.get(['scout_data', 'scout_ignored']);
    const data = stored?.scout_data;
    if (data?.courses) {
        courses = data.courses;
        ignoredDeadlines = new Set(stored?.scout_ignored || []);
        const metaEl = document.getElementById('meta');
        if (metaEl) metaEl.dataset.extractedAt = data.extractedAt;
        renderDashboard();
    }
}
