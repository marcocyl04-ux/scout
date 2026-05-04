// Scout — Popup v3.4.0
// Rendering + message passing. Extraction runs in background.js.

const COLORS = ['#6c72ff', '#54a0ff', '#2ed573', '#ff9f43', '#ff5c5c', '#a55eea', '#ffc048'];
const COLOR_MAP = {};

let courses = {};
let ignoredDeadlines = new Set();
let searchQuery = '';

// --- Helpers ---
function courseColor(id) {
    if (!COLOR_MAP[id]) COLOR_MAP[id] = COLORS[Object.keys(COLOR_MAP).length % COLORS.length];
    return COLOR_MAP[id];
}
function shortName(info) {
    if (!info?.displayId) return '?';
    const m = info.displayId.match(/([a-z]{2,4})(\d{2,3})/i);
    return m ? (m[1] + m[2]).toUpperCase() : info.displayId.slice(-12);
}
function daysUntil(s) {
    if (!s) return null;
    const d = new Date(s), now = new Date();
    d.setHours(0,0,0,0); now.setHours(0,0,0,0);
    return Math.ceil((d - now) / 86400000);
}

// --- File bundling ---
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
        const fname = (file.name || '').toLowerCase();
        let hit = false;
        if (dlWords.length > 0) {
            if (dlWords.filter(w => fname.includes(w)).length >= 1) hit = true;
        }
        if (hit && !seen.has(file.name)) {
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

    const assignments = [], exams = [];
    for (const [id, c] of Object.entries(courses)) {
        const name = shortName(c), color = courseColor(id);
        for (const d of (c.deadlines || [])) {
            const days = daysUntil(d.dueDate);
            if (days !== null && days < -14) continue;
            const dlKey = `${id}-${d.title}-${d.dueDate}`;
            if (ignoredDeadlines.has(dlKey)) continue;
            const isDone = d.status === 'GRADED' || d.status === 'SUBMITTED';
            const entry = { ...d, shortName: name, color, courseId: id, isDone, dlKey };
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                if (!(d.title || '').toLowerCase().includes(q) && !name.toLowerCase().includes(q)) continue;
            }
            if (d.type === 'exam') exams.push(entry);
            else assignments.push(entry);
        }
    }

    renderUpcoming(assignments, exams);
    renderLog(assignments, exams);
    updateGreeting();

    const searchInput = document.getElementById('searchInput');
    if (searchInput && !searchInput._bound) {
        searchInput._bound = true;
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.trim();
            renderDashboard();
        });
    }

    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
}



// --- Upcoming ---
function renderUpcoming(assignments, exams) {
    const el = document.getElementById('upcoming');
    const all = [...assignments, ...exams].filter(d => {
        if (d.isDone) return false;
        const days = daysUntil(d.dueDate);
        return days === null || days >= 0;
    });
    if (!all.length) { el.innerHTML = '<p class="empty-msg">Nothing upcoming</p>'; return; }
    const grouped = {};
    for (const d of all) {
        const key = d.shortName;
        if (!grouped[key]) grouped[key] = { color: d.color, items: [] };
        grouped[key].items.push(d);
    }
    const sorted = Object.entries(grouped).sort((a, b) =>
        (a[1].items[0]?.dueDate || '9999').localeCompare(b[1].items[0]?.dueDate || '9999'));
    let html = '';
    for (const [name, group] of sorted) {
        html += `<div class="course-group"><div class="course-name" style="color:${group.color}">${name}</div>`;
        for (const d of group.items) html += renderUpcomingCard(d);
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
    html += `<span class="task-type">${entry.type === 'exam' ? 'Exam' : 'Assignment'}</span></div>`;
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
function renderLog(assignments, exams) {
    const el = document.getElementById('log');
    const all = [...assignments, ...exams];
    const done = all.filter(d => d.isDone).slice(0, 10);
    const overdue = all.filter(d => !d.isDone && daysUntil(d.dueDate) !== null && daysUntil(d.dueDate) < 0);
    if (!done.length && !overdue.length) { el.innerHTML = '<p class="empty-msg">Nothing to report</p>'; return; }
    let html = '';
    if (done.length) {
        html += '<div class="section-label">submitted</div>';
        for (const d of done) {
            const gradeText = d.status === 'GRADED'
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
            chrome.storage.local.get('scout_data', (stored) => {
                const data = stored?.scout_data || {};
                data.ignoredDeadlines = [...ignoredDeadlines];
                chrome.storage.local.set({ scout_data: data });
            });
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

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.views').forEach(v => v.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.view).classList.add('active');
        });
    });

    // Refresh button
    document.getElementById('refreshBtn').addEventListener('click', () => startExtraction());

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

    // Check stored data
    const stored = await chrome.storage.local.get(['scout_data', 'scout_extracting']);
    const data = stored?.scout_data;
    const wasExtracting = stored?.scout_extracting;

    // Check if background is currently extracting
    let bgExtracting = false;
    try {
        const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
        bgExtracting = status?.extracting;
    } catch(e) {}

    if (bgExtracting || wasExtracting) {
        // Background is running extraction — show loading
        loading.classList.remove('hidden');
        startScreen.classList.add('hidden');
        return;
    }

    if (data?.courses && data?.extractedAt) {
        const ageMin = (Date.now() - data.extractedAt) / 60000;
        if (ageMin < 120) {
            courses = data.courses;
            ignoredDeadlines = new Set(data.ignoredDeadlines || []);
            const metaEl = document.getElementById('meta');
            if (metaEl) metaEl.dataset.extractedAt = data.extractedAt;
            startScreen.classList.add('hidden');
            renderDashboard();
            return;
        }
    }

    // No data — show start screen
    startScreen.classList.remove('hidden');
    document.getElementById('startBtn').addEventListener('click', () => startExtraction());
});

// --- Load data from storage and render ---
async function loadAndRender() {
    const stored = await chrome.storage.local.get('scout_data');
    const data = stored?.scout_data;
    if (data?.courses) {
        courses = data.courses;
        ignoredDeadlines = new Set(data.ignoredDeadlines || []);
        const metaEl = document.getElementById('meta');
        if (metaEl) metaEl.dataset.extractedAt = data.extractedAt;
        renderDashboard();
    }
}
