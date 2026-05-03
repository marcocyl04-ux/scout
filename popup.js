// Scout — Popup (v8)
// Uses chrome.debugger (CDP) to capture API responses. Same approach as the Python extractor.
// v8: Term filter + nested file traversal

const SYNC_URL = 'http://localhost:8080/api/extension-push';
const COLORS = ['#6c72ff', '#54a0ff', '#2ed573', '#ff9f43', '#ff5c5c', '#a55eea', '#ffc048'];
const COLOR_MAP = {};

let allResponses = {};
let courses = {};
let activityStream = [];
let ignoredDeadlines = new Set();

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
function fmtScore(g) {
    if (g.score == null && g.grade) return g.grade;
    if (g.score == null) return '—';
    return g.pointsPossible ? `${g.score}/${g.pointsPossible}` : `${g.score}`;
}
function scoreClass(s, max) {
    if (s == null || max == null) return 'pending';
    return (s/max) >= 0.8 ? 'high' : (s/max) >= 0.6 ? 'mid' : 'low';
}
function stripHtml(h) { const d = document.createElement('div'); d.innerHTML = h; return d.textContent || ''; }
function setStatus(msg) { document.getElementById('statusText').textContent = msg; }
function addLog(msg) {
    const el = document.getElementById('log');
    if (!el) return;
    const line = document.createElement('div');
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
}

// --- CDP via chrome.debugger ---

let dbgTarget = null;
let msgId = 0;
let pending = {};
let apiBodies = {};
let apiRequests = {};

function sendCDP(method, params) {
    return new Promise((resolve, reject) => {
        msgId++;
        const id = msgId;
        pending[id] = { resolve, reject };
        chrome.debugger.sendCommand(dbgTarget, method, params || {}, (result) => {
            if (chrome.runtime.lastError) {
                delete pending[id];
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                delete pending[id];
                resolve(result);
            }
        });
    });
}

function onDebugEvent(source, method, params) {
    if (method === 'Network.requestWillBeSent') {
        const url = params?.request?.url || '';
        if (url.includes('/learn/api/')) {
            apiRequests[params.requestId] = url;
        }
    } else if (method === 'Network.loadingFinished') {
        const rid = params?.requestId;
        if (rid && apiRequests[rid]) {
            const url = apiRequests[rid];
            chrome.debugger.sendCommand(dbgTarget, 'Network.getResponseBody', { requestId: rid }, (result) => {
                if (result?.body) {
                    try {
                        apiBodies[url] = JSON.parse(result.body);
                    } catch {
                        apiBodies[url] = result.body;
                    }
                    addLog(`  Captured: ${url.split('/learn/api/')[1]?.split('?')[0]}`);
                }
            });
            delete apiRequests[rid];
        }
    }
}

async function startCapture() {
    dbgTarget = { tabId: (await getTabId()) };
    
    try {
        await new Promise(resolve => chrome.debugger.detach(dbgTarget, resolve));
        await new Promise(r => setTimeout(r, 500));
    } catch(e) {}
    
    let attached = false;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await new Promise((resolve, reject) => {
                chrome.debugger.attach(dbgTarget, '1.3', () => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve();
                });
            });
            attached = true;
            break;
        } catch(e) {
            if (e.message.includes('already attached')) {
                try { await new Promise(r => chrome.debugger.detach(dbgTarget, r)); } catch(_) {}
                await new Promise(r => setTimeout(r, 1000));
            } else if (e.message.includes('Cannot attach') || e.message.includes('closed')) {
                addLog('Waiting for page to reload (grant permission if prompted)...');
                await new Promise(r => setTimeout(r, 5000));
                dbgTarget = { tabId: (await getTabId()) };
            } else {
                throw e;
            }
        }
    }
    
    if (!attached) throw new Error('Could not attach debugger after 3 attempts');
    addLog('Debugger attached ✓');
    
    chrome.debugger.onEvent.addListener(onDebugEvent);
    await sendCDP('Network.enable');
    addLog('CDP attached — capturing network...');
}

async function stopCapture() {
    chrome.debugger.onEvent.removeListener(onDebugEvent);
    await new Promise(resolve => {
        chrome.debugger.detach(dbgTarget, resolve);
    });
    dbgTarget = null;
}

async function getTabId() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
}

// --- Navigate and capture ---

async function navigateAndWait(url, waitMs) {
    await sendCDP('Page.navigate', { url });
    await new Promise(r => setTimeout(r, waitMs));
}

// --- Fetch API helper (for nested content traversal) ---
// Uses host_permissions to call BB API directly from the extension

async function fetchAPI(path) {
    const url = `https://learn.bu.edu${path}`;
    try {
        const resp = await fetch(url, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
        });
        if (!resp.ok) return null;
        return await resp.json();
    } catch(e) {
        return null;
    }
}

// --- Term detection ---

function discoverTerms(apiBodies) {
    // From CDP-captured responses (loaded when navigating to course list)
    for (const [url, body] of Object.entries(apiBodies)) {
        if (url.includes('/terms') && !url.includes('courses') && body?.results) {
            return body.results.map(t => ({
                id: t.id,
                name: t.name || '',
                startDate: t.startDate,
                endDate: t.endDate,
                isAvailable: t.isAvailable
            }));
        }
    }
    return [];
}

function findCurrentTerm(terms, courseList) {
    // Strategy 1 (primary): Pick the term that contains today's date
    if (terms.length > 0) {
        const now = new Date();
        const current = terms.find(t => {
            if (!t.startDate || !t.endDate) return false;
            return new Date(t.startDate) <= now && now <= new Date(t.endDate);
        });
        if (current) return current;
        
        // Strategy 2: Pick the most recent term by start date
        const sorted = terms.filter(t => t.startDate).sort((a, b) => 
            new Date(b.startDate) - new Date(a.startDate)
        );
        if (sorted.length > 0) return sorted[0];
    }
    
    // Strategy 3 (fallback): Count courses per termId (unreliable — old courses may still be available)
    const termCounts = {};
    const alwaysSkip = ['orientation', 'integrity', 'module', 'immigration', 'global_ped'];
    
    for (const c of courseList) {
        if (alwaysSkip.some(kw => (c.displayId || '').toLowerCase().includes(kw))) continue;
        if (c.termId) termCounts[c.termId] = (termCounts[c.termId] || 0) + 1;
    }
    
    if (Object.keys(termCounts).length > 0) {
        const bestId = Object.entries(termCounts).sort((a, b) => b[1] - a[1])[0][0];
        const term = terms.find(t => t.id === bestId);
        if (term) return term;
        return { id: bestId, name: bestId };
    }
    
    return null; // No filter — show all courses
}

// --- Recursive file collection ---

async function collectFiles(courseId, contentId, parentPath, depth = 0) {
    if (depth > 5) return []; // safety limit
    const files = [];
    const path = `/learn/api/v1/courses/${courseId}/contents/${contentId}/children?limit=500`;
    const data = await fetchAPI(path);
    if (!data?.results) return files;
    
    for (const item of data.results) {
        const handler = item.contentHandler || '';
        const title = item.title || 'Untitled';
        const itemPath = parentPath ? `${parentPath} / ${title}` : title;
        
        if (handler === 'resource/x-bb-file') {
            const fileInfo = item.contentDetail?.['resource/x-bb-file']?.file;
            if (fileInfo) {
                files.push({
                    name: title,
                    fileName: fileInfo.fileName,
                    fileSize: fileInfo.fileSize,
                    downloadUrl: fileInfo.permanentUrl,
                    path: itemPath,
                    depth: depth,
                    type: 'file'
                });
            }
        } else if (handler === 'resource/x-bb-folder' || handler === 'resource/x-bb-lesson') {
            files.push({
                name: title,
                path: itemPath,
                depth: depth,
                type: handler.includes('folder') ? 'folder' : 'lesson',
                children: await collectFiles(courseId, item.id, itemPath, depth + 1)
            });
        } else if (handler === 'resource/x-bb-asmt-test-link') {
            // Assessments — grab embedded file attachments from instructions
            const detail = item.contentDetail?.[handler] || {};
            const instructions = detail.test?.assessment?.instructions?.displayText || '';
            const fileMatches = [...instructions.matchAll(/data-bbfile="([^"]+)"/g)];
            for (const m of fileMatches) {
                try {
                    const fd = JSON.parse(m[1].replace(/&quot;/g, '"'));
                    files.push({
                        name: fd.displayName || title,
                        fileName: fd.fileName,
                        path: itemPath,
                        depth: depth + 1,
                        type: 'file'
                    });
                } catch {}
            }
            // Also treat the assessment itself as an item
            files.push({
                name: title,
                path: itemPath,
                depth: depth,
                type: 'assessment'
            });
        } else if (handler === 'resource/x-bb-document') {
            files.push({
                name: title,
                path: itemPath,
                depth: depth,
                type: 'document'
            });
        }
    }
    return files;
}

// --- Main extraction ---

async function runExtraction() {
    addLog('Starting extraction...');
    apiBodies = {};
    apiRequests = {};
    
    await startCapture();
    
    // Phase 1: Navigate to course list
    addLog('Loading course list...');
    await navigateAndWait('https://learn.bu.edu/ultra/course', 4000);
    
    // Discover courses
    const memberUrl = Object.keys(apiBodies).find(u => u.includes('memberships'));
    if (!memberUrl) {
        addLog('ERROR: No memberships API captured. Try again.');
        await stopCapture();
        return;
    }
    
    const memberData = apiBodies[memberUrl];
    const alwaysSkip = ['orientation', 'integrity', 'module', 'immigration', 'global_ped'];
    const courseList = [];
    const seen = new Set();
    
    for (const r of (memberData?.results || [])) {
        const course = r.course || {};
        const cid = r.courseId;
        if (r.role !== 'S' || !course.isAvailable || course.isClosed || seen.has(cid)) continue;
        const display = course.displayId || cid;
        if (alwaysSkip.some(kw => display.toLowerCase().includes(kw))) continue;
        seen.add(cid);
        courseList.push({ id: cid, displayId: display, termId: course.termId });
    }
    
    // Debug: show what termIds we found
    const debugTerms = {};
    for (const c of courseList) {
        debugTerms[c.termId || 'null'] = (debugTerms[c.termId || 'null'] || 0) + 1;
    }
    addLog(`Term IDs from memberships: ${JSON.stringify(debugTerms)}`);
    
    // Discover terms from CDP-captured responses
    let terms = discoverTerms(apiBodies);
    
    // Fallback: if no terms captured, fetch them directly
    if (!terms.length) {
        addLog('Fetching terms API...');
        const termsData = await fetchAPI('/learn/api/v1/terms?limit=100');
        if (termsData?.results) {
            terms = termsData.results.map(t => ({
                id: t.id, name: t.name || '',
                startDate: t.startDate, endDate: t.endDate, isAvailable: t.isAvailable
            }));
        }
    }
    addLog(`Found ${terms.length} terms`);
    
    // Find and apply current term filter
    const currentTerm = findCurrentTerm(terms, courseList);
    
    if (currentTerm) {
        const termCourses = courseList.filter(c => c.termId === currentTerm.id);
        if (termCourses.length > 0) {
            addLog(`Current term: ${currentTerm.name || currentTerm.id} (${termCourses.length} courses)`);
            courseList.length = 0;
            for (const c of termCourses) courseList.push(c);
        } else {
            // termId from count strategy didn't match any courses — try date-based
            addLog(`Term ${currentTerm.name || currentTerm.id} has 0 matching courses — no filter applied`);
        }
    } else {
        addLog('WARNING: Could not determine current term — processing all courses');
    }
    
    addLog(`Processing ${courseList.length} courses`);
    for (const c of courseList) addLog(`  ${c.displayId}`);
    
    if (!courseList.length) {
        await stopCapture();
        return;
    }
    
    // Phase 2: Visit each course to capture grades, content, etc.
    courses = {};
    for (let i = 0; i < courseList.length; i++) {
        const course = courseList[i];
        addLog(`[${i+1}/${courseList.length}] Loading ${shortName(course)}...`);
        
        // Visit outline (triggers content tree)
        await navigateAndWait(`https://learn.bu.edu/ultra/courses/${course.id}/outline`, 3000);
        
        // Visit grades page (triggers gradebook API)
        addLog(`  Grades...`);
        await navigateAndWait(`https://learn.bu.edu/ultra/courses/${course.id}/grades`, 2000);
        
        // Visit announcements page (triggers announcements API)
        addLog(`  Announcements...`);
        await navigateAndWait(`https://learn.bu.edu/ultra/courses/${course.id}/announcements`, 2000);
        
        // Visit calendar page (triggers calendarItems API)
        addLog(`  Calendar...`);
        await navigateAndWait(`https://learn.bu.edu/ultra/courses/${course.id}/calendar`, 2000);
        
        const data = { grades: [], deadlines: [], announcements: [], files: [] };
        
        for (const [url, body] of Object.entries(apiBodies)) {
            if (!url.includes(course.id)) continue;
            
            // Grades
            if (url.includes('gradebook/grades') && body?.results) {
                for (const r of body.results) {
                    const col = r.column || {};
                    const display = r.displayGrade || {};
                    if (!data.grades.find(g => g.columnId === r.columnId)) {
                        data.grades.push({
                            columnId: r.columnId,
                            name: col.effectiveColumnName || 'Unknown',
                            score: display.score,
                            grade: display.grade,
                            pointsPossible: r.pointsPossible,
                            status: r.submissionStatus?.status,
                            dueDate: col.dueDate
                        });
                        if (col.effectiveColumnName && col.dueDate) {
                            data.deadlines.push({
                                title: col.effectiveColumnName,
                                dueDate: col.dueDate,
                                source: 'gradebook',
                                status: r.submissionStatus?.status
                            });
                        }
                    }
                }
            }
            
            // Announcements
            if (url.includes('announcements?') && body?.results) {
                for (const item of body.results) {
                    const b = item.body || {};
                    if (!data.announcements.find(a => a.id === item.id)) {
                        data.announcements.push({
                            id: item.id,
                            title: item.title || '',
                            body: b.displayText || b.rawText || '',
                            postedDate: item.createdDate,
                            isRead: item.readStatus?.isRead || false
                        });
                    }
                }
            }
            
            // Calendar events — capture deadlines AND detect class meeting days
            if (url.includes('calendarItems') && body?.results) {
                const existingTitles = new Set(data.deadlines.map(d => d.title));
                const dayFrequency = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat
                
                for (const item of body.results) {
                    // Capture as deadline if it has an end date
                    if (item.title && item.endDate && !existingTitles.has(item.title)) {
                        data.deadlines.push({ title: item.title, dueDate: item.endDate, source: 'calendar' });
                        existingTitles.add(item.title);
                    }
                    
                    // Detect class meeting days from recurring events
                    // Class sessions typically have a startDate, are shorter events (< 4 hours)
                    // and recur on the same day of the week
                    if (item.startDate) {
                        const start = new Date(item.startDate);
                        const end = item.endDate ? new Date(item.endDate) : null;
                        const durationHours = end ? (end - start) / 3600000 : 0;
                        
                        // Class sessions are typically 1-3 hours
                        if (durationHours > 0 && durationHours <= 4) {
                            dayFrequency[start.getDay()]++;
                        }
                    }
                }
                
                // Store detected meeting days on data
                // A day is a "meeting day" if it appears 2+ times (recurring pattern)
                const meetingDays = [];
                const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                for (let i = 0; i < 7; i++) {
                    if (dayFrequency[i] >= 2) meetingDays.push(i);
                }
                data.meetingDays = meetingDays;
                data.meetingDaysNames = meetingDays.map(d => dayNames[d]);
            }
        }
        
        // Nested file traversal via direct API fetch
        addLog(`  Scanning files...`);
        data.files = await collectFiles(course.id, 'ROOT', '', 0);
        const fileCount = countFiles(data.files);
        addLog(`  Found ${fileCount} files in ${data.files.length} items`);
        
        data.deadlines.sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
        courses[course.id] = { ...course, ...data };
        addLog(`  ${data.grades.length} grades, ${data.deadlines.length} deadlines, ${data.announcements.length} announcements${data.meetingDaysNames?.length ? ', meets: ' + data.meetingDaysNames.join('/') : ''}`);
    }
    
    // Phase 3: Process activity stream from CDP-captured data
    addLog('Processing activity stream...');
    let activityStream = [];
    const streamUrls = Object.keys(apiBodies).filter(u => u.includes('streams/ultra'));
    
    if (streamUrls.length > 0) {
        const now = Date.now();
        const seen = new Set();
        
        for (const url of streamUrls) {
            const body = apiBodies[url];
            if (!body?.results) continue;
            
            for (const entry of body.results) {
                const provider = entry.providerId || '';
                const specificData = entry.itemSpecificData || {};
                const notification = specificData.notificationDetails || {};
                const courseKey = notification.courseId || entry.courseId || '';
                const timestamp = entry.timestamp || entry.createdDate || null;
                
                // Deduplicate by timestamp + provider
                const key = `${timestamp}-${provider}-${courseKey}`;
                if (seen.has(key)) continue;
                seen.add(key);
                
                const item = {
                    provider,
                    courseId: courseKey,
                    seen: notification.seen ?? true,
                    sourceType: notification.sourceType || '',
                    timestamp,
                };
                
                if (provider === 'bb-nautilus' && notification.sourceType === 'CO') {
                    item.type = 'content';
                    item.title = notification.contentTitle || '';
                    item.courseName = notification.courseName || '';
                } else if (provider === 'bb-nautilus' && notification.sourceType === 'GB') {
                    item.type = 'grade';
                    item.title = notification.contentTitle || '';
                } else if (provider === 'bb-announcement') {
                    item.type = 'announcement';
                    item.title = specificData.title || '';
                } else if (provider === 'bb_calendar') {
                    item.type = 'calendar';
                    item.title = specificData.title || '';
                } else if (provider === 'bb_mygrades') {
                    item.type = 'grade';
                } else if (provider === 'bb_disc') {
                    item.type = 'discussion';
                    item.title = specificData.title || '';
                } else {
                    item.type = provider;
                }
                
                if (item.timestamp) {
                    const daysAgo = (now - new Date(item.timestamp).getTime()) / 86400000;
                    if (daysAgo <= 14) activityStream.push(item);
                }
            }
        }
        
        addLog(`Activity stream: ${activityStream.length} recent items from ${streamUrls.length} captures`);
        
        // Use stream to detect class meeting days (fallback if calendar didn't have enough data)
        for (const [id, c] of Object.entries(courses)) {
            if (c.meetingDays?.length) continue;
            
            const courseItems = activityStream.filter(item => {
                if (item.courseId === id) return true;
                if (item.courseName && c.displayId && 
                    item.courseName.includes(c.displayId)) return true;
                return false;
            });
            
            if (courseItems.length >= 3) {
                const dayFrequency = [0, 0, 0, 0, 0, 0, 0];
                for (const item of courseItems) {
                    if (item.timestamp) {
                        dayFrequency[new Date(item.timestamp).getDay()]++;
                    }
                }
                const meetingDays = [];
                const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                for (let d = 0; d < 7; d++) {
                    if (dayFrequency[d] >= 2) meetingDays.push(d);
                }
                if (meetingDays.length) {
                    c.meetingDays = meetingDays;
                    c.meetingDaysNames = meetingDays.map(d => dayNames[d]);
                    addLog(`  ${shortName(c)}: stream-detected meets ${c.meetingDaysNames.join('/')}`);
                }
            }
        }
    } else {
        addLog('Activity stream: no stream data captured');
    }
    
    await stopCapture();
    addLog('Extraction complete!');
    
    allResponses = {};
    for (const [url, body] of Object.entries(apiBodies)) {
        allResponses[url] = { data: body, timestamp: Date.now() };
    }
    
    await chrome.storage.local.set({
        scout_data: {
            courses,
            allResponses,
            activityStream: activityStream || [],
            ignoredDeadlines: [...ignoredDeadlines],
            extractedAt: Date.now()
        }
    });
    addLog('Data saved locally ✓');
    
    renderDashboard();
    syncToServer();
}

function countFiles(items) {
    let count = 0;
    for (const item of items) {
        if (item.type === 'file') count++;
        if (item.children) count += countFiles(item.children);
    }
    return count;
}

// --- Rendering ---

function renderDashboard() {
    const courseCount = Object.keys(courses).length;
    const totalGrades = Object.values(courses).reduce((s, c) => s + (c.grades?.length || 0), 0);
    const totalDeadlines = Object.values(courses).reduce((s, c) => s + (c.deadlines?.length || 0), 0);
    const totalFiles = Object.values(courses).reduce((s, c) => s + (c.files?.length || 0), 0);
    
    document.getElementById('meta').textContent = `${courseCount} courses · ${totalGrades} grades · ${totalDeadlines} deadlines · ${totalFiles} files · stream: ${activityStream.length}`;
    
    renderActionCenter();
    renderNewThisWeek();
    renderGrades();
    renderAnnouncements();
    
    // Debug: show deadline details
    const debugEl = document.getElementById('debugInfo');
    if (debugEl) {
        let debugHtml = '<div style="font:10px monospace;color:#666;padding:8px;border-top:1px solid #222">';
        debugHtml += `deadlines: ${totalDeadlines}, stream: ${activityStream.length}<br>`;
        for (const [id, c] of Object.entries(courses)) {
            const dl = c.deadlines || [];
            debugHtml += `${shortName(c)}: ${dl.length} deadlines, files: ${c.files?.length || 0}, meets: ${c.meetingDaysNames?.join('/') || 'none'}<br>`;
            for (const d of dl.slice(0, 3)) {
                debugHtml += `&nbsp;&nbsp;${d.title} → ${d.dueDate || 'no date'} (${d.source})<br>`;
            }
        }
        debugHtml += '</div>';
        debugEl.innerHTML = debugHtml;
    }
    
    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
}

// --- File bundling logic ---
// Matches files to deadlines by: same BB folder, or posted within 7 days

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

function bundleFilesForDeadline(deadline, courseFiles, courseDeadlines) {
    if (!courseFiles?.length) return [];
    const flat = flattenFiles(courseFiles);
    const dlTitle = (deadline.title || '').toLowerCase();
    const dlWords = dlTitle.split(/\s+/).filter(w => w.length > 3);
    const dlFolder = deadline.source === 'gradebook' ? null : getTopFolder(deadline.title);
    
    const matched = [];
    const seen = new Set();
    
    for (const file of flat) {
        const fname = (file.name || '').toLowerCase();
        let matched_ = false;
        
        // Strategy 1: Name overlap with deadline title
        if (dlWords.length > 0) {
            const overlap = dlWords.filter(w => fname.includes(w)).length;
            if (overlap >= 1) matched_ = true;
        }
        
        // Strategy 2: Same top-level folder as other files posted near the deadline
        // (We use the file's own folder as a signal — if the file shares a folder
        //  with other files that matched by name, include it too)
        
        if (matched_ && !seen.has(file.name)) {
            seen.add(file.name);
            matched.push(file);
        }
    }
    
    if (matched.length === 0) {
        // No match found — show nothing. Honest > noisy.
    }
    
    return matched.slice(0, 5);
}

// --- Action Center ---

function getNextClassDay(course) {
    if (!course?.meetingDays?.length) return null;
    const now = new Date();
    const today = now.getDay();
    
    // Find the next meeting day (today or later in the week)
    for (const day of course.meetingDays.sort((a, b) => a - b)) {
        if (day >= today) {
            const diff = day - today;
            const next = new Date(now);
            next.setDate(next.getDate() + diff);
            return next;
        }
    }
    
    // Next meeting is next week (wrap around)
    const firstDay = Math.min(...course.meetingDays);
    const diff = (7 - today) + firstDay;
    const next = new Date(now);
    next.setDate(next.getDate() + diff);
    return next;
}

function getNextWeekEnd() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
    const nextSunday = new Date(now);
    nextSunday.setDate(nextSunday.getDate() + daysUntilSunday + 7);
    nextSunday.setHours(23, 59, 59, 999);
    return nextSunday;
}

function getThisWeekEnd() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
    const sunday = new Date(now);
    sunday.setDate(sunday.getDate() + daysUntilSunday);
    sunday.setHours(23, 59, 59, 999);
    return sunday;
}

function renderActionCenter() {
    const el = document.getElementById('actionCenter');
    el.innerHTML = '';
    
    const now = new Date();
    const overdue = [];     // past due, not done
    const today = [];       // due today
    const nextClass = [];   // due on/around next class day
    const thisWeek = [];    // due this week (after next class)
    const nextWeek = [];    // due next week
    const done = [];        // submitted/graded
    
    const weekEnd = getThisWeekEnd();
    const nextWeekEnd = getNextWeekEnd();
    
    for (const [id, c] of Object.entries(courses)) {
        const name = shortName(c), color = courseColor(id);
        const nextClassDate = getNextClassDay(c);
        
        for (const d of (c.deadlines || [])) {
            const days = daysUntil(d.dueDate);
            if (days !== null && days < -14) continue;
            
            // Skip ignored
            const dlKey = `${id}-${d.title}-${d.dueDate}`;
            if (ignoredDeadlines.has(dlKey)) continue;
            
            const isDone = d.status === 'GRADED' || d.status === 'SUBMITTED';
            const entry = { ...d, shortName: name, color, courseId: id, isDone, dlKey };
            const dueDate = d.dueDate ? new Date(d.dueDate) : null;
            
            if (isDone) {
                done.push(entry);
            } else if (days !== null && days < 0) {
                overdue.push(entry);
            } else if (days === 0) {
                today.push(entry);
            } else if (nextClassDate && dueDate && 
                       dueDate <= nextClassDate && days > 0) {
                nextClass.push(entry);
            } else if (dueDate && dueDate <= weekEnd) {
                thisWeek.push(entry);
            } else if (dueDate && dueDate <= nextWeekEnd) {
                nextWeek.push(entry);
            }
        }
    }
    
    const sortByDate = (a, b) => (a.dueDate || '').localeCompare(b.dueDate || '');
    overdue.sort(sortByDate);
    today.sort(sortByDate);
    nextClass.sort(sortByDate);
    thisWeek.sort(sortByDate);
    nextWeek.sort(sortByDate);
    
    if (!overdue.length && !today.length && !nextClass.length && !thisWeek.length && !nextWeek.length && !done.length) {
        el.innerHTML = '<p style="color:var(--text-dim);font-size:12px;text-align:center;padding:16px">Nothing due — enjoy your free time 🎉</p>';
        return;
    }
    
    let html = '';
    
    if (overdue.length) {
        html += renderSection('⚠️ Overdue', 'overdue', overdue, true);
    }
    
    if (today.length) {
        html += renderSection('📌 Due Today', 'today', today, false);
    }
    
    if (nextClass.length) {
        const sampleCourse = courses[nextClass[0]?.courseId];
        const nextDate = getNextClassDay(sampleCourse);
        const dayName = nextDate ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][nextDate.getDay()] : '';
        html += renderSection(`📚 Due Next Class${dayName ? ` (${dayName})` : ''}`, 'nextclass', nextClass, false);
    }
    
    if (thisWeek.length) {
        html += renderSection('📅 Due This Week', 'thisweek', thisWeek, false);
    }
    
    if (nextWeek.length) {
        html += renderSection('📆 Due Next Week', 'nextweek', nextWeek, false);
    }
    
    if (done.length) {
        html += renderSection('✅ Completed', 'done', done.slice(0, 8), false, true);
    }
    
    el.innerHTML = html;
    
    // Attach collapse and ignore event listeners
    el.querySelectorAll('.section-header').forEach(header => {
        header.addEventListener('click', () => {
            const content = header.nextElementSibling;
            const arrow = header.querySelector('.collapse-arrow');
            if (content) content.classList.toggle('collapsed');
            if (arrow) arrow.classList.toggle('open');
        });
    });
    
    el.querySelectorAll('.ignore-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const key = btn.dataset.key;
            ignoredDeadlines.add(key);
            chrome.storage.local.get('scout_data').then(stored => {
                const data = stored?.scout_data || {};
                data.ignoredDeadlines = [...ignoredDeadlines];
                chrome.storage.local.set({ scout_data: data });
            });
            // Animate removal
            const item = btn.closest('.action-item');
            if (item) {
                item.style.opacity = '0';
                item.style.transform = 'translateX(20px)';
                item.style.transition = 'all 0.3s';
                setTimeout(() => renderActionCenter(), 300);
            }
        });
    });
}

function renderSection(title, id, items, showIgnore, isDone) {
    let html = `<div class="section-block" data-section="${id}">`;
    html += `<div class="section-header">`;
    html += `<span class="collapse-arrow open">▼</span>`;
    html += `<span>${title}</span>`;
    html += `<span class="section-count">${items.length}</span>`;
    html += `</div>`;
    html += `<div class="section-content">`;
    
    for (const d of items) {
        if (isDone) {
            html += `<div class="action-item done" style="border-left-color:${d.color}">`;
            html += `<div class="action-header">`;
            html += `<div class="action-title done">${d.title}</div>`;
            html += `<div class="action-meta"><span class="action-course" style="color:${d.color}">${d.shortName}</span>`;
            html += `<span class="action-badge done">✓ ${d.status === 'GRADED' ? 'Graded' : 'Submitted'}</span></div>`;
            html += `</div></div>`;
        } else {
            html += renderDeadlineBundle(d, showIgnore);
        }
    }
    
    html += `</div></div>`;
    return html;
}

function renderDeadlineBundle(deadline, showIgnore) {
    const days = daysUntil(deadline.dueDate);
    let dayText = '';
    if (days === 0) dayText = 'Today';
    else if (days === 1) dayText = 'Tomorrow';
    else if (days > 1) dayText = `${days}d`;
    else dayText = `${Math.abs(days)}d ago`;
    
    const course = courses[deadline.courseId];
    const bundled = bundleFilesForDeadline(deadline, course?.files, course?.deadlines);
    
    const ignoreBtn = showIgnore ? `<button class="ignore-btn" data-key="${deadline.dlKey}" title="Ignore">✕</button>` : '';
    
    let html = `<div class="action-item ${days !== null && days < 0 ? 'overdue' : ''}" style="border-left-color:${deadline.color}">`;
    html += `<div class="action-header">`;
    html += `<div class="action-title">${deadline.title}</div>`;
    html += `<div class="action-meta">`;
    html += `<span class="action-course" style="color:${deadline.color}">${deadline.shortName}</span>`;
    html += `<span class="action-days ${days !== null && days <= 0 ? 'urgent' : days !== null && days <= 3 ? 'soon' : ''}">${dayText}</span>`;
    html += ignoreBtn;
    html += `</div></div>`;
    
    if (bundled.length > 0) {
        html += `<div class="action-files">`;
        for (const file of bundled) {
            const href = file.downloadUrl
                ? (file.downloadUrl.startsWith('http') ? file.downloadUrl : `https://learn.bu.edu${file.downloadUrl}`)
                : '#';
            const icon = getFileIcon(file.name);
            html += `<a class="action-file" href="${href}" target="_blank">${icon} ${file.name}</a>`;
        }
        html += `</div>`;
    }
    
    html += `</div>`;
    return html;
}

function getFileIcon(name) {
    const ext = (name || '').split('.').pop().toLowerCase();
    if (['pptx', 'ppt', 'key'].includes(ext)) return '📊';
    if (['pdf'].includes(ext)) return '📄';
    if (['docx', 'doc', 'txt', 'rtf'].includes(ext)) return '📝';
    if (['xlsx', 'xls', 'csv'].includes(ext)) return '📊';
    if (['mp4', 'mp3', 'webm', 'mov'].includes(ext)) return '🎬';
    if (['py', 'ipynb', 'r', 'java'].includes(ext)) return '💻';
    if (['zip', 'rar', 'tar'].includes(ext)) return '📦';
    return '📄';
}

// --- New This Week ---

function renderNewThisWeek() {
    const el = document.getElementById('newThisWeek');
    el.innerHTML = '';
    
    let hasContent = false;
    const now = Date.now();
    
    for (const [id, c] of Object.entries(courses)) {
        const color = courseColor(id);
        const name = shortName(c);
        
        // Recent announcements (from course data — has dates)
        const recentAnnouncements = (c.announcements || [])
            .filter(a => {
                if (!a.postedDate) return false;
                const daysAgo = (now - new Date(a.postedDate).getTime()) / 86400000;
                return daysAgo <= 7;
            })
            .sort((a, b) => (b.postedDate || '').localeCompare(a.postedDate || ''));
        
        // Recent activity from stream (content postings with real timestamps)
        const recentActivity = activityStream
            .filter(item => {
                if (item.courseId !== id) return false;
                if (!item.timestamp) return false;
                const daysAgo = (now - new Date(item.timestamp).getTime()) / 86400000;
                return daysAgo <= 7;
            })
            .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        
        if (!recentAnnouncements.length && !recentActivity.length) continue;
        hasContent = true;
        
        let html = `<div class="new-course-block">`;
        html += `<div class="new-course-name" style="color:${color}">${name}</div>`;
        
        // Stream items (content postings — these have real dates)
        for (const item of recentActivity.slice(0, 5)) {
            const icon = item.type === 'content' ? '📄' : item.type === 'grade' ? '📊' : item.type === 'discussion' ? '💬' : '📌';
            const unseen = !item.seen ? ' unseen' : '';
            const title = item.title || item.type;
            const timeAgo = formatTimeAgo(item.timestamp);
            html += `<div class="new-item stream${unseen}">${icon} ${title}<span class="new-item-time">${timeAgo}</span></div>`;
        }
        
        // Announcements (as backup)
        for (const a of recentAnnouncements.slice(0, 2)) {
            const body = stripHtml(a.body || '').substring(0, 60);
            html += `<div class="new-item announcement">📢 ${a.title}${body ? `<span class="new-item-preview"> — ${body}...</span>` : ''}</div>`;
        }
        
        html += `</div>`;
        el.innerHTML += html;
    }
    
    if (!hasContent) {
        el.innerHTML = '<p style="color:var(--text-dim);font-size:11px;text-align:center;padding:8px">Nothing new this week</p>';
    }
}

function formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    const diff = Date.now() - new Date(timestamp).getTime();
    const hours = Math.floor(diff / 3600000);
    if (hours < 1) return 'just now';
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
}

// --- Grades ---

function renderGrades() {
    const el = document.getElementById('gradesList');
    let html = '';
    for (const [id, c] of Object.entries(courses)) {
        if (!c.grades?.length) continue;
        html += `<div class="grade-course"><div class="grade-course-name" style="color:${courseColor(id)}">${shortName(c)}</div>`;
        for (const g of c.grades.slice(0, 10)) {
            html += `<div class="grade-item"><span class="grade-name">${g.name}</span><span class="grade-score ${scoreClass(g.score, g.pointsPossible)}">${fmtScore(g)}</span></div>`;
        }
        html += '</div>';
    }
    el.innerHTML = html || '<p style="color:var(--text-dim);font-size:11px;text-align:center;padding:8px">No grades yet</p>';
}

// --- Announcements ---

function renderAnnouncements() {
    const el = document.getElementById('announcementsList');
    const all = [];
    for (const [id, c] of Object.entries(courses)) {
        for (const a of (c.announcements || [])) all.push({ ...a, shortName: shortName(c) });
    }
    all.sort((a, b) => (b.postedDate || '').localeCompare(a.postedDate || ''));
    if (!all.length) { el.innerHTML = '<p style="color:var(--text-dim);font-size:11px;text-align:center;padding:8px">No announcements</p>'; return; }
    el.innerHTML = all.slice(0, 8).map(a => {
        const body = stripHtml(a.body).substring(0, 100);
        return `<div class="announcement-item ${a.isRead ? '' : 'unread'}"><div><span class="announcement-title">${a.title}</span> <span class="announcement-course">${a.shortName}</span></div><div class="announcement-body">${body}${body.length >= 100 ? '...' : ''}</div></div>`;
    }).join('');
}

// --- Sync to server (backdoor) ---
async function syncToServer() {
    try {
        await fetch(SYNC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                timestamp: Date.now(),
                responseCount: Object.keys(allResponses).length,
                urls: Object.keys(allResponses),
                responses: allResponses
            })
        });
        addLog('Synced to server ✓');
    } catch(e) {}
}

// --- Init ---
window.addEventListener('beforeunload', () => {
    if (dbgTarget) {
        try { chrome.debugger.detach(dbgTarget, () => {}); } catch(e) {}
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    const startScreen = document.getElementById('startScreen');
    const dashboard = document.getElementById('dashboard');
    const loading = document.getElementById('loadingState');
    
    // Refresh button — always available
    document.getElementById('refreshBtn').addEventListener('click', async () => {
        document.getElementById('refreshBtn').classList.add('spinning');
        dashboard.classList.add('hidden');
        loading.classList.remove('hidden');
        document.getElementById('log').innerHTML = '';
        await runExtraction().catch(e => addLog(`ERROR: ${e.message}`));
        setTimeout(() => document.getElementById('refreshBtn').classList.remove('spinning'), 500);
    });
    
    // Check for stored data first
    const stored = await chrome.storage.local.get('scout_data');
    const data = stored?.scout_data;
    
    if (data?.courses && data?.extractedAt) {
        const ageMin = (Date.now() - data.extractedAt) / 60000;
        if (ageMin < 60) {
            courses = data.courses;
            allResponses = data.allResponses || {};
            activityStream = data.activityStream || [];
            ignoredDeadlines = new Set(data.ignoredDeadlines || []);
            startScreen.classList.add('hidden');
            renderDashboard();
            return;
        }
    }
    
    // No fresh data — show start screen
    document.getElementById('startBtn').addEventListener('click', () => {
        document.getElementById('startBtn').disabled = true;
        loading.classList.remove('hidden');
        document.getElementById('log').innerHTML = '';
        startScreen.classList.add('hidden');
        runExtraction().catch(e => {
            addLog(`ERROR: ${e.message}`);
        });
    });
});
