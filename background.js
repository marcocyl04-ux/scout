// Scout — Background Service Worker (v3)
// Handles extraction (survives popup close) + data storage

console.log('[Scout] Service worker started');

// ====== EXTRACTION CODE ======

let courses = {};

// --- Helpers (shared with popup.js — keep in sync) ---
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
function stripHtml(h) { return (h || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim(); }
function classifyDeadline(title) {
    const t = (title || '').toLowerCase();
    if (/\b(exam|test|quiz|midterm|final)\b/.test(t)) return 'exam';
    if (/\b(in[- ]?class|classwork|participation|attendance|ic[- ])\b/.test(t)) return 'in-class';
    return 'homework';
}
function addLog(msg) {
    console.log('[Scout]', msg);
    chrome.runtime.sendMessage({ type: 'EXTRACTION_LOG', msg }).catch(() => {});
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
    addLog('Debugger attached');

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

// --- Fetch API helper ---

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
    const termCourseCounts = {};
    for (const c of courseList) {
        if (c.termId) termCourseCounts[c.termId] = (termCourseCounts[c.termId] || 0) + 1;
    }

    if (terms.length > 0) {
        const now = new Date();
        const dateMatches = terms.filter(t => {
            if (!t.startDate || !t.endDate) return false;
            return new Date(t.startDate) <= now && now <= new Date(t.endDate);
        });

        if (dateMatches.length > 0) {
            const withCourses = dateMatches
                .filter(t => termCourseCounts[t.id] > 0)
                .sort((a, b) => (termCourseCounts[b.id] || 0) - (termCourseCounts[a.id] || 0));
            if (withCourses.length > 0) return withCourses[0];
        }

        const termsWithCourses = terms.filter(t => termCourseCounts[t.id] > 0);
        if (termsWithCourses.length > 0) {
            return termsWithCourses.sort((a, b) =>
                (termCourseCounts[b.id] || 0) - (termCourseCounts[a.id] || 0)
            )[0];
        }

        const sorted = terms.filter(t => t.startDate).sort((a, b) =>
            new Date(b.startDate) - new Date(a.startDate)
        );
        if (sorted.length > 0) return sorted[0];
    }

    return null;
}

// --- Recursive file collection ---

async function collectFiles(courseId, contentId, parentPath, depth = 0) {
    if (depth > 5) return [];
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

    try {
        // Phase 1: Navigate to course list
        addLog('Loading course list...');
        await navigateAndWait('https://learn.bu.edu/ultra/course', 4000);

        // Discover courses
        const memberUrl = Object.keys(apiBodies).find(u => u.includes('memberships'));
        if (!memberUrl) {
            addLog('ERROR: No memberships API captured. Make sure you are logged into Blackboard.');
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
            if (course.isLocked || course.isNonCredit) continue;
            seen.add(cid);
            courseList.push({ id: cid, displayId: display, termId: course.termId });
        }

        // Discover terms
        let terms = discoverTerms(apiBodies);

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

        const currentTerm = findCurrentTerm(terms, courseList);
        addLog(`Term filter: ${currentTerm ? (currentTerm.name || currentTerm.id) : 'none found'}`);

        if (currentTerm) {
            const termCourses = courseList.filter(c => c.termId === currentTerm.id);
            if (termCourses.length > 0) {
                addLog(`Current term: ${currentTerm.name || currentTerm.id} (${termCourses.length} courses)`);
                courseList.length = 0;
                for (const c of termCourses) courseList.push(c);
            } else {
                addLog(`Term ${currentTerm.name || currentTerm.id} has 0 matching courses — no filter applied`);
            }
        } else {
            addLog('WARNING: Could not determine current term — processing all courses');
        }

        addLog(`Processing ${courseList.length} courses`);
        for (const c of courseList) addLog(`  ${c.displayId}`);

        if (!courseList.length) return;

        // Phase 2: Visit each course to capture content, then fetch grades/calendar directly
        courses = {};
        for (let i = 0; i < courseList.length; i++) {
            const course = courseList[i];
            addLog(`[${i+1}/${courseList.length}] Loading ${shortName(course)}...`);

            // Visit outline (triggers content tree + announcements capture via CDP)
            await navigateAndWait(`https://learn.bu.edu/ultra/courses/${course.id}/outline`, 3000);

            // Fetch grades and calendar directly via API
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
                        // Bug fix: calendar items have no status from the API; default to NOT_SUBMITTED so status comparisons work correctly.
                        data.deadlines.push({ title: item.title, dueDate: item.endDate, source: 'calendar', status: 'NOT_SUBMITTED', type: classifyDeadline(item.title) });
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

            // Also grab any grades/calendar captured via CDP
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

            // Use stream to detect class meeting days (fallback)
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

        addLog('Extraction complete!');

        await chrome.storage.local.set({
            scout_data: {
                courses,
                activityStream: activityStream || [],
                extractedAt: Date.now()
            }
        });
        addLog('Data saved locally');

        // Notify popup that extraction is done
        chrome.runtime.sendMessage({ type: 'EXTRACTION_DONE' }).catch(() => {});

    } finally {
        // Always clean up — even on error or early return
        try { await stopCapture(); } catch(e) {}
        extracting = false;
        chrome.storage.local.remove('scout_extracting');
    }
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
            if (dl.instructions) continue;
            const dlTitle = (dl.title || '').toLowerCase();

            // Bug #11 fix: prefer longest matching assessment name (most specific wins)
            let bestMatch = null;
            let bestMatchLen = 0;

            for (const a of assessments) {
                const aName = (a.name || '').toLowerCase();
                let matched = false;

                // Exact or substring match
                if (dlTitle === aName || dlTitle.includes(aName) || aName.includes(dlTitle)) {
                    matched = true;
                }
                // Word overlap (at least 2 significant words in common)
                if (!matched) {
                    const dlWords = dlTitle.split(/\s+/).filter(w => w.length > 3);
                    const aWords = aName.split(/\s+/).filter(w => w.length > 3);
                    const overlap = dlWords.filter(w => aWords.includes(w));
                    if (overlap.length >= 2) matched = true;
                }

                // Keep the longest (most specific) match
                if (matched && aName.length > bestMatchLen) {
                    bestMatch = a;
                    bestMatchLen = aName.length;
                }
            }

            if (bestMatch) dl.instructions = bestMatch.instructions;
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


// ====== MESSAGE HANDLING ======

let extracting = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_EXTRACTION') {
        if (extracting) {
            sendResponse({ status: 'already_running' });
            return true;
        }
        extracting = true;
        chrome.storage.local.set({ scout_extracting: true });

        runExtraction().then(() => {
            // cleanup is handled in the finally block
        }).catch(e => {
            console.error('[Scout] Extraction failed:', e);
            chrome.runtime.sendMessage({ type: 'EXTRACTION_ERROR', error: e.message }).catch(() => {});
        });

        sendResponse({ status: 'started' });
        return true;
    }

    if (message.type === 'GET_STATUS') {
        sendResponse({ extracting });
        return true;
    }
});

// Badge
chrome.runtime.onInstalled.addListener(() => {
    console.log('[Scout] Extension installed/updated');
});
