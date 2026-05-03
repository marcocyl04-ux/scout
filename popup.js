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
    // If pointsPossible seems wrong (score > possible, or possible is very low while score is high),
    // show as percentage instead of misleading fraction
    if (g.pointsPossible && g.score > g.pointsPossible && g.pointsPossible < 20) {
        return `${g.score}%`;
    }
    return g.pointsPossible ? `${g.score}/${g.pointsPossible}` : `${g.score}`;
}
function scoreClass(s, max) {
    if (s == null || max == null) return 'pending';
    return (s/max) >= 0.8 ? 'high' : (s/max) >= 0.6 ? 'mid' : 'low';
}
function stripHtml(h) { const d = document.createElement('div'); d.innerHTML = h; return d.textContent || ''; }
function classifyDeadline(title) {
    const t = (title || '').toLowerCase();
    if (/\b(exam|test|quiz|midterm|final)\b/.test(t)) return 'exam';
    return 'assignment';
}
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
            headers: { 
                'Accept': 'application/json',
                'x-blackboard-xsrf': document.cookie.match(/x-blackboard-xsrf=([^;]+)/)?.[1] || ''
            }
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
    // Build a map of termId → course count
    const termCourseCounts = {};
    for (const c of courseList) {
        if (c.termId) termCourseCounts[c.termId] = (termCourseCounts[c.termId] || 0) + 1;
    }
    
    // Strategy 1 (primary): Date-based, but prefer terms with actual courses
    if (terms.length > 0) {
        const now = new Date();
        const dateMatches = terms.filter(t => {
            if (!t.startDate || !t.endDate) return false;
            return new Date(t.startDate) <= now && now <= new Date(t.endDate);
        });
        
        // Among date-matching terms, pick the one with the most courses
        if (dateMatches.length > 0) {
            const withCourses = dateMatches
                .filter(t => termCourseCounts[t.id] > 0)
                .sort((a, b) => (termCourseCounts[b.id] || 0) - (termCourseCounts[a.id] || 0));
            if (withCourses.length > 0) return withCourses[0];
        }
        
        // Strategy 2: Any term with the most courses (regardless of date)
        const termsWithCourses = terms.filter(t => termCourseCounts[t.id] > 0);
        if (termsWithCourses.length > 0) {
            return termsWithCourses.sort((a, b) => 
                (termCourseCounts[b.id] || 0) - (termCourseCounts[a.id] || 0)
            )[0];
        }
        
        // Strategy 3: Most recent term by start date (last resort)
        const sorted = terms.filter(t => t.startDate).sort((a, b) => 
            new Date(b.startDate) - new Date(a.startDate)
        );
        if (sorted.length > 0) return sorted[0];
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
            // Store the assessment with its instructions text
            const cleanInstructions = stripHtml(instructions).trim();
            files.push({
                name: title,
                path: itemPath,
                depth: depth,
                type: 'assessment',
                instructions: cleanInstructions.length > 20 ? cleanInstructions : null
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
        const name = (course.name || '').toLowerCase();
        const displayLower = display.toLowerCase();
        if (alwaysSkip.some(kw => displayLower.includes(kw) || name.includes(kw))) continue;
        // Also skip locked courses and non-credit modules
        if (course.isLocked || course.isNonCredit) continue;
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
    addLog(`Term filter: ${currentTerm ? (currentTerm.name || currentTerm.id) : 'none found'}`);
    
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
    
    // Phase 2: Visit each course to capture content, then fetch grades/calendar directly
    courses = {};
    for (let i = 0; i < courseList.length; i++) {
        const course = courseList[i];
        addLog(`[${i+1}/${courseList.length}] Loading ${shortName(course)}...`);
        
        // Visit outline (triggers content tree + announcements capture via CDP)
        await navigateAndWait(`https://learn.bu.edu/ultra/courses/${course.id}/outline`, 3000);
        
        // Fetch grades and calendar directly via API (no navigation needed)
        addLog(`  Grades...`);
        const gradesData = await fetchAPI(`/learn/api/v1/courses/${course.id}/gradebook/grades?limit=100`);
        
        addLog(`  Calendar...`);
        const calendarData = await fetchAPI(`/learn/api/v1/courses/${course.id}/calendars/calendarItems?limit=100`);
        
        const data = { grades: [], deadlines: [], announcements: [], files: [] };
        
        // Process grades from direct fetch
        if (gradesData?.results) {
            for (const r of gradesData.results) {
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
                            status: r.submissionStatus?.status,
                            type: classifyDeadline(col.effectiveColumnName)
                        });
                    }
                }
            }
        }
        
        // Process calendar from direct fetch
        if (calendarData?.results) {
            const existingTitles = new Set(data.deadlines.map(d => d.title));
            const dayFrequency = [0, 0, 0, 0, 0, 0, 0];
            
            for (const item of calendarData.results) {
                if (item.title && item.endDate && !existingTitles.has(item.title)) {
                    data.deadlines.push({ title: item.title, dueDate: item.endDate, source: 'calendar', type: classifyDeadline(item.title) });
                    existingTitles.add(item.title);
                }
                if (item.startDate) {
                    const start = new Date(item.startDate);
                    const end = item.endDate ? new Date(item.endDate) : null;
                    const durationHours = end ? (end - start) / 3600000 : 0;
                    if (durationHours > 0 && durationHours <= 4) {
                        dayFrequency[start.getDay()]++;
                    }
                }
            }
            
            const meetingDays = [];
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            for (let d = 0; d < 7; d++) {
                if (dayFrequency[d] >= 2) meetingDays.push(d);
            }
            data.meetingDays = meetingDays;
            data.meetingDaysNames = meetingDays.map(d => dayNames[d]);
        }
        
        // Also grab any grades/calendar captured via CDP (may have more data)
        for (const [url, body] of Object.entries(apiBodies)) {
            if (!url.includes(course.id)) continue;
            
            // Announcements (only from CDP — not fetched directly)
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
    
    // Match assessment instructions to deadlines
    matchInstructionsToDeadlines();
    
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
    // Set freshness data attribute
    const metaEl = document.getElementById('meta');
    if (metaEl) metaEl.dataset.extractedAt = Date.now();
    addLog('Data saved locally ✓');
    
    renderDashboard();
    syncToServer();
}

// --- Match assessment instructions to deadlines ---

function findAssessmentsWithInstructions(items, results) {
    if (!items) return results;
    for (const item of items) {
        if (item.type === 'assessment' && item.instructions) {
            results.push({ name: item.name, instructions: item.instructions });
        }
        if (item.children) findAssessmentsWithInstructions(item.children, results);
    }
    return results;
}

function matchInstructionsToDeadlines() {
    for (const [id, c] of Object.entries(courses)) {
        const assessments = findAssessmentsWithInstructions(c.files || [], []);
        if (!assessments.length) continue;
        
        for (const dl of (c.deadlines || [])) {
            if (dl.instructions) continue; // already has instructions
            const dlTitle = (dl.title || '').toLowerCase();
            
            for (const a of assessments) {
                const aName = (a.name || '').toLowerCase();
                // Exact or substring match
                if (dlTitle === aName || dlTitle.includes(aName) || aName.includes(dlTitle)) {
                    dl.instructions = a.instructions;
                    break;
                }
                // Word overlap (at least 2 significant words in common)
                const dlWords = dlTitle.split(/\s+/).filter(w => w.length > 3);
                const aWords = aName.split(/\s+/).filter(w => w.length > 3);
                const overlap = dlWords.filter(w => aWords.includes(w));
                if (overlap.length >= 2) {
                    dl.instructions = a.instructions;
                    break;
                }
            }
        }
    }
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

// --- State ---
let doThisMode = 'all'; // 'nextclass', 'nextweek', 'all'
let searchQuery = '';

function renderDashboard() {
    const courseCount = Object.keys(courses).length;
    const totalDeadlines = Object.values(courses).reduce((s, c) => s + (c.deadlines?.length || 0), 0);
    
    // Show data freshness
    let freshness = '';
    // Try to get extraction time from the meta element's data attribute
    const metaEl = document.getElementById('meta');
    const extractedAt = metaEl?.dataset?.extractedAt;
    if (extractedAt) {
        const ageMin = Math.floor((Date.now() - parseInt(extractedAt)) / 60000);
        if (ageMin < 1) freshness = ' · just now';
        else if (ageMin < 60) freshness = ` · ${ageMin}m ago`;
        else freshness = ` · ${Math.floor(ageMin/60)}h ago`;
    }
    
    document.getElementById('meta').textContent = `${courseCount} courses · ${totalDeadlines} deadlines${freshness}`;
    
    // Split deadlines by type
    const assignments = [];
    const exams = [];
    
    for (const [id, c] of Object.entries(courses)) {
        const name = shortName(c), color = courseColor(id);
        for (const d of (c.deadlines || [])) {
            const days = daysUntil(d.dueDate);
            if (days !== null && days < -14) continue;
            const dlKey = `${id}-${d.title}-${d.dueDate}`;
            if (ignoredDeadlines.has(dlKey)) continue;
            const isDone = d.status === 'GRADED' || d.status === 'SUBMITTED';
            const entry = { ...d, shortName: name, color, courseId: id, isDone, dlKey };
            
            // Search filter
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                const matchTitle = (d.title || '').toLowerCase().includes(q);
                const matchCourse = name.toLowerCase().includes(q);
                if (!matchTitle && !matchCourse) continue;
            }
            
            if (d.type === 'exam') exams.push(entry);
            else assignments.push(entry);
        }
    }
    
    // Sort by class, then by date
    const sortByClassThenDate = (a, b) => {
        const classCompare = a.shortName.localeCompare(b.shortName);
        if (classCompare !== 0) return classCompare;
        return (a.dueDate || '').localeCompare(b.dueDate || '');
    };
    assignments.sort(sortByClassThenDate);
    exams.sort(sortByClassThenDate);
    
    // Render each section
    renderDoThis(assignments);
    renderDueToday(assignments, exams);
    renderPrep(exams);
    renderNow(assignments, exams);
    renderStatus(assignments, exams);
    
    // Attach search listener (once)
    const searchInput = document.getElementById('searchInput');
    if (searchInput && !searchInput._bound) {
        searchInput._bound = true;
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.trim();
            renderDashboard();
        });
    }
    
    // Attach mode toggle listeners (once)
    const modeContainer = document.getElementById('doThisModes');
    if (modeContainer && !modeContainer._bound) {
        modeContainer._bound = true;
        modeContainer.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                modeContainer.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                doThisMode = btn.dataset.mode;
                renderDashboard();
            });
        });
    }
    
    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
}

// --- DO THIS: active assignments + overdue ---

function renderDoThis(assignments) {
    const el = document.getElementById('doThis');
    const active = assignments.filter(a => !a.isDone && daysUntil(a.dueDate) > 0);
    
    // Apply mode filter
    let filtered = active;
    if (doThisMode === 'nextclass') {
        filtered = active.filter(a => {
            const days = daysUntil(a.dueDate);
            return days !== null && days <= 2;
        });
    } else if (doThisMode === 'nextweek') {
        filtered = active.filter(a => {
            const days = daysUntil(a.dueDate);
            return days !== null && days <= 7;
        });
    }
    
    if (!filtered.length) {
        el.innerHTML = '<p class="empty-msg">Nothing coming up</p>';
        return;
    }
    
    // Group by course
    const grouped = {};
    for (const a of filtered) {
        const key = a.shortName;
        if (!grouped[key]) grouped[key] = { color: a.color, courseId: a.courseId, items: [] };
        grouped[key].items.push(a);
    }
    
    // Sort groups by earliest deadline
    const sortedGroups = Object.entries(grouped).sort((a, b) => {
        const aEarliest = a[1].items[0]?.dueDate || '9999';
        const bEarliest = b[1].items[0]?.dueDate || '9999';
        return aEarliest.localeCompare(bEarliest);
    });
    
    let html = '';
    for (const [name, group] of sortedGroups) {
        html += `<div class="course-group">`;
        html += `<div class="course-group-header" style="color:${group.color}">${name} <span class="course-group-count">${group.items.length}</span></div>`;
        for (const a of group.items) {
            html += renderTaskCard(a, 'assignment');
        }
        html += `</div>`;
    }
    
    el.innerHTML = html;
    attachCardListeners(el);
}

// --- DUE TODAY: items due today ---

function renderDueToday(assignments, exams) {
    const el = document.getElementById('dueToday');
    const all = [...assignments, ...exams];
    const today = all.filter(d => !d.isDone && daysUntil(d.dueDate) === 0);
    
    if (!today.length) {
        el.innerHTML = '<p class="empty-msg">Nothing due today</p>';
        return;
    }
    
    el.innerHTML = today.map(d => renderTaskCard(d, d.type || 'assignment')).join('');
    attachCardListeners(el);
}

// --- PREP: upcoming exams ---

function renderPrep(exams) {
    const el = document.getElementById('prepForThis');
    const upcoming = exams.filter(e => !e.isDone);
    
    if (!upcoming.length) {
        el.innerHTML = '<p class="empty-msg">No exams coming up</p>';
        return;
    }
    
    el.innerHTML = upcoming.map(e => renderTaskCard(e, 'exam')).join('');
    attachCardListeners(el);
}

// --- NOW: today + next class (compact) ---

function renderNow(assignments, exams) {
    const el = document.getElementById('nowSection');
    const all = [...assignments, ...exams].filter(d => !d.isDone);
    const now = new Date();
    const today = [];
    const upcoming = [];
    
    for (const d of all) {
        const days = daysUntil(d.dueDate);
        if (days === 0) today.push(d);
        else if (days !== null && days > 0 && days <= 3) upcoming.push(d);
    }
    
    if (!today.length && !upcoming.length) {
        el.innerHTML = '<p class="empty-msg">Nothing urgent</p>';
        return;
    }
    
    let html = '';
    if (today.length) {
        html += '<div class="now-group"><div class="now-label">📌 Due Today</div>';
        for (const d of today) html += renderCompactCard(d);
        html += '</div>';
    }
    if (upcoming.length) {
        html += '<div class="now-group"><div class="now-label">⏰ Coming Up</div>';
        for (const d of upcoming) html += renderCompactCard(d);
        html += '</div>';
    }
    el.innerHTML = html;
}

// --- STATUS: completed + overdue ---

function renderStatus(assignments, exams) {
    const el = document.getElementById('statusSection');
    const all = [...assignments, ...exams];
    const done = all.filter(d => d.isDone).slice(0, 8);
    const overdue = all.filter(d => !d.isDone && daysUntil(d.dueDate) !== null && daysUntil(d.dueDate) < 0);
    
    if (!done.length && !overdue.length) {
        el.innerHTML = '<p class="empty-msg">Nothing to report</p>';
        return;
    }
    
    let html = '';
    if (overdue.length) {
        html += '<div class="status-group"><div class="status-label">⚠️ Overdue</div>';
        for (const d of overdue) html += renderStatusItem(d, true);
        html += '</div>';
    }
    if (done.length) {
        html += '<div class="status-group"><div class="status-label">✅ Completed</div>';
        for (const d of done) html += renderStatusItem(d, false);
        html += '</div>';
    }
    el.innerHTML = html;
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

// --- Task card renderer ---

function renderTaskCard(entry, taskType) {
    const days = daysUntil(entry.dueDate);
    let dayText = '';
    if (days === 0) dayText = 'Today';
    else if (days === 1) dayText = 'Tomorrow';
    else if (days > 1) dayText = `${days}d`;
    else dayText = `${Math.abs(days)}d ago`;
    
    const course = courses[entry.courseId];
    const bundled = bundleFilesForDeadline(entry, course?.files, course?.deadlines);
    const isUrgent = days !== null && days <= 1;
    const isOverdue = days !== null && days < 0;
    
    const typeIcon = taskType === 'exam' ? '📝' : '📋';
    
    let html = `<div class="task-card ${isOverdue ? 'overdue' : ''}" style="border-left-color:${entry.color}">`;
    html += `<div class="task-header" data-toggle>`;
    html += `<div class="task-title">${typeIcon} ${entry.title}</div>`;
    html += `<div class="task-meta">`;
    html += `<span class="task-course" style="color:${entry.color}">${entry.shortName}</span>`;
    html += `<span class="task-days ${isUrgent ? 'urgent' : ''}">${dayText}</span>`;
    html += `</div></div>`;
    
    // Collapsible detail section
    html += `<div class="task-detail collapsed">`;
    
    if (bundled.length > 0) {
        html += `<div class="task-files">`;
        for (const file of bundled) {
            const href = file.downloadUrl
                ? (file.downloadUrl.startsWith('http') ? file.downloadUrl : `https://learn.bu.edu${file.downloadUrl}`)
                : '#';
            const icon = getFileIcon(file.name);
            html += `<a class="task-file" href="${href}" target="_blank">${icon} ${file.name}</a>`;
        }
        html += `</div>`;
        html += `<div class="task-file-note">Files open in Blackboard — log in to download</div>`;
    } else {
        html += `<div class="task-no-files">No materials attached</div>`;
    }
    
    // Show assessment instructions if available
    if (entry.instructions) {
        html += `<div class="task-instructions"><div class="task-instructions-label">📋 Instructions</div><div class="task-instructions-text">${entry.instructions}</div></div>`;
    }
    
    // AI prompt button
    html += `<div class="task-actions">`;
    html += `<button class="ai-prompt-btn" data-title="${entry.title.replace(/"/g, '&quot;')}" data-course="${entry.shortName}" data-instructions="${(entry.instructions || '').replace(/"/g, '&quot;').replace(/\n/g, ' ').slice(0, 500)}" data-files="${bundled.map(f => f.name).join(', ')}">🤖 Ask AI</button>`;
    html += `</div>`;
    html += `<div class="ai-prompt-preview hidden">`;
    html += `<textarea class="ai-prompt-text" rows="6"></textarea>`;
    html += `<div class="ai-prompt-actions"><button class="ai-copy-btn">📋 Copy</button><button class="ai-close-btn">✕</button></div>`;
    html += `</div>`;
    
    html += `</div></div>`;
    return html;
}

function renderCompactCard(entry) {
    const days = daysUntil(entry.dueDate);
    let dayText = '';
    if (days === 0) dayText = 'Today';
    else if (days === 1) dayText = 'Tomorrow';
    else dayText = `${days}d`;
    
    const typeIcon = entry.type === 'exam' ? '📝' : '📋';
    const isUrgent = days !== null && days <= 0;
    
    return `<div class="compact-card" style="border-left-color:${entry.color}">
        <span class="compact-icon">${typeIcon}</span>
        <span class="compact-title">${entry.title}</span>
        <span class="compact-course" style="color:${entry.color}">${entry.shortName}</span>
        <span class="compact-days ${isUrgent ? 'urgent' : ''}">${dayText}</span>
    </div>`;
}

function renderStatusItem(entry, showIgnore) {
    const isDone = entry.isDone;
    const days = daysUntil(entry.dueDate);
    const dayText = days !== null ? (days < 0 ? `${Math.abs(days)}d ago` : `${days}d`) : '';
    
    let html = `<div class="status-item ${isDone ? 'done' : 'overdue'}" style="border-left-color:${entry.color}">`;
    html += `<span class="status-title">${entry.title}</span>`;
    html += `<span class="status-course" style="color:${entry.color}">${entry.shortName}</span>`;
    if (isDone) {
        html += `<span class="status-badge done">✓ ${entry.status === 'GRADED' ? 'Graded' : 'Submitted'}</span>`;
    } else {
        html += `<span class="status-days overdue">${dayText}</span>`;
        html += `<button class="ignore-btn" data-key="${entry.dlKey}" title="Ignore">✕</button>`;
    }
    html += `</div>`;
    return html;
}

function attachCardListeners(el) {
    el.querySelectorAll('.task-header').forEach(header => {
        header.addEventListener('click', () => {
            const detail = header.nextElementSibling;
            if (detail) detail.classList.toggle('collapsed');
        });
    });
    
    el.querySelectorAll('.ai-prompt-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const title = btn.dataset.title;
            const course = btn.dataset.course;
            const instructions = btn.dataset.instructions;
            const files = btn.dataset.files;
            
            let prompt = `Help me with this assignment for ${course}:\n\n"${title}"`;
            if (instructions) prompt += `\n\nInstructions:\n${instructions}`;
            if (files) prompt += `\n\nRelevant files: ${files}`;
            prompt += `\n\nPlease help me understand what's required and how to approach this.`;
            
            // Show preview
            const preview = btn.closest('.task-actions').nextElementSibling;
            const textarea = preview.querySelector('.ai-prompt-text');
            textarea.value = prompt;
            preview.classList.remove('hidden');
            textarea.focus();
            textarea.select();
        });
    });
    
    el.querySelectorAll('.ai-copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const textarea = btn.closest('.ai-prompt-preview').querySelector('.ai-prompt-text');
            navigator.clipboard.writeText(textarea.value).then(() => {
                btn.textContent = '✓ Copied!';
                setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
            });
        });
    });
    
    el.querySelectorAll('.ai-close-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.closest('.ai-prompt-preview').classList.add('hidden');
        });
    });
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
        if (ageMin < 120) {
            courses = data.courses;
            allResponses = data.allResponses || {};
            activityStream = data.activityStream || [];
            ignoredDeadlines = new Set(data.ignoredDeadlines || []);
            // Store extraction time for freshness display
            const metaEl = document.getElementById('meta');
            if (metaEl) metaEl.dataset.extractedAt = data.extractedAt;
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
