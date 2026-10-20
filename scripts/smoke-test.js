/*
 * 배포 후 스모크 테스트: 실제 org 화면을 headless Edge로 열어
 *  1) 브라우저 콘솔 error / 페이지 예외가 없는지
 *  2) 각 페이지에서 기대한 수의 차트(canvas)가 실제 크기로 그려졌는지, 컴포넌트 에러 문구가 없는지
 *  3) Excel 업로드 E2E: 버튼 → 모달 → 실제 .xlsx 선택 → 미리보기 검증 → 업로드 → org에 레코드 생성 확인 → 정리
 *  4) 공통 Excel 업로드 진입점: List View 버튼, URL 페이지(파라미터 누락 오류 포함), 레코드 Quick Action 업로드
 * 를 확인하고 스크린샷을 남긴다. 하나라도 실패하면 exit code 1.
 *
 * 사용: node scripts/smoke-test.js [출력폴더]
 * 로그인은 sf CLI 토큰으로 frontdoor URL을 만들어 처리 (URL에 세션이 담겨 있으므로 출력하지 않음)
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const SF = process.env.SF_CLI || 'C:\\Program Files\\sf\\bin\\sf.cmd';
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ORG = process.env.SF_ORG || 'chartjs-dev';
const OUT = process.argv[2] || path.join(__dirname, '..', '.smoke');

// 검사 대상: 탭 경로 / 컴포넌트 태그 / 그려져야 할 최소 canvas 수
const PAGES = [
    { name: 'Chart.js', path: 'lightning/n/Chartjs_Sample', tag: 'c-combo-bar-line-chart', minCanvases: 1 },
    { name: 'ECharts', path: 'lightning/n/ECharts_Sample', tag: 'c-echarts-combo-chart', minCanvases: 1 },
    { name: 'Sales Dashboard', path: 'lightning/n/Sales_Dashboard', tag: 'c-sales-dashboard', minCanvases: 7 },
    { name: 'LoL Team Builder', path: 'lightning/n/LoL_Team_Builder', tag: 'c-lol-team-builder', minCanvases: 1 }
];

// Lightning 자체가 내는 무관한 콘솔 잡음은 제외 (필요 시 추가)
const IGNORED = [/favicon/i, /Content Security Policy.*report-only/i];

function frontdoorUrl(pagePath) {
    // .cmd는 shell로 실행해야 하고, 경로에 공백이 있어 따옴표로 감쌈
    const raw = execFileSync(`"${SF}"`, ['org', 'open', '--target-org', ORG, '--path', `"${pagePath}"`, '--url-only', '--json'], {
        encoding: 'utf8',
        shell: true
    });
    return JSON.parse(raw).result.url;
}

// synthetic/native shadow 모두에서 태그 안의 canvas와 에러 표시를 전부 수집 (브라우저 안에서 실행)
function inspect(tag) {
    const findAll = (root, selector, out = []) => {
        root.querySelectorAll(selector).forEach((el) => out.push(el));
        root.querySelectorAll('*').forEach((el) => {
            if (el.shadowRoot) findAll(el.shadowRoot, selector, out);
        });
        return out;
    };
    const host = findAll(document, tag)[0];
    if (!host) return { host: false, canvases: 0, emptyCanvases: 0, errors: [] };
    const scope = host.shadowRoot || host;
    const canvases = [...new Set([...findAll(scope, 'canvas'), ...host.querySelectorAll('canvas')])];
    const errors = findAll(scope, '.slds-text-color_error, .slds-alert_error').map((e) => e.textContent.trim()).filter(Boolean);
    return {
        host: true,
        canvases: canvases.length,
        emptyCanvases: canvases.filter((c) => c.width === 0 || c.height === 0).length,
        sizes: canvases.map((c) => `${c.width}x${c.height}`),
        errors
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// shadow DOM을 모두 뒤져 selector에 맞는 첫 요소 (브라우저 안에서 실행)
// 'a >>> b' = a를 찾은 뒤 그 shadow 안에서 b (shadow 경계를 넘는 하위 선택자)
function deepFind(selector) {
    const walk = (root, sel) => {
        const found = root.querySelector(sel);
        if (found) return found;
        for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) {
                const inner = walk(el.shadowRoot, sel);
                if (inner) return inner;
            }
        }
        return null;
    };
    return selector.split('>>>').reduce((scope, part) => {
        if (!scope) return null;
        const sel = part.trim();
        return (scope.shadowRoot && walk(scope.shadowRoot, sel)) || walk(scope, sel);
    }, document);
}

// Lightning CSP가 eval을 막으므로 deepFind는 CDP로 문서 생성 시 주입 (CSP 적용 대상 아님)
async function installDeepFind(tab) {
    await tab.evaluateOnNewDocument(`window.__deepFind = ${deepFind.toString()};`);
}

async function waitDeep(tab, selector, { enabled = false, timeout = 60000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try {
            const ok = await tab.evaluate(
                (sel, mustBeEnabled) => {
                    const el = window.__deepFind && window.__deepFind(sel);
                    return Boolean(el) && (!mustBeEnabled || !el.disabled);
                },
                selector,
                enabled
            );
            if (ok) return true;
        } catch (e) {
            if (!/context was destroyed|Cannot find context/i.test(e.message)) throw e;
        }
        await sleep(500);
    }
    throw new Error(`화면에서 ${selector}${enabled ? ' (활성)' : ''} 를 찾지 못함`);
}

function deepHandle(tab, selector) {
    return tab.evaluateHandle((sel) => window.__deepFind(sel), selector);
}

function deepText(tab, selector) {
    return tab.evaluate((sel) => (window.__deepFind(sel) || {}).textContent, selector);
}

function runApexFile(file) {
    return execFileSync(`"${SF}"`, ['apex', 'run', '--file', file, '--target-org', ORG], { encoding: 'utf8', shell: true });
}

// Excel 업로드 E2E. 레코드는 '[SMOKE]' 접두어로 만들고 끝나면 삭제
async function checkExcelUpload(browser) {
    const name = 'Excel Upload';
    const problems = [];
    const cleanup = path.join(__dirname, 'apex', 'delete-smoke-data.apex');
    runApexFile(cleanup); // 이전 실행이 중간에 실패해 남은 데이터 정리

    const XLSX = require('../force-app/main/default/staticresources/sheetjs.js');
    const stamp = Date.now();
    const rows = [
        ['Account Name', 'First Name', 'Last Name', 'Email'],
        ['[SMOKE] Acme', 'Gildong', 'Hong', `hong.${stamp}@example.com`],
        ['[SMOKE] Acme', 'Younghee', 'Kim', `kim.${stamp}@example.com`],
        ['[SMOKE] Beta', '', 'Lee', ''],
        ['[SMOKE] Beta', 'Bad', 'Mail', 'not-an-email']
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Accounts');
    const file = path.join(OUT, 'smoke-upload.xlsx');
    fs.writeFileSync(file, Buffer.from(XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }))); // 브라우저용 빌드라 writeFile 대신 직접 저장

    const tab = await browser.newPage();
    await tab.setViewport({ width: 1400, height: 1000 });
    tab.on('console', (msg) => {
        if (msg.type() === 'error' && !IGNORED.some((re) => re.test(msg.text()))) problems.push(`console.error: ${msg.text()}`);
    });
    tab.on('pageerror', (err) => problems.push(`page exception: ${err.message}`));
    const shot = path.join(OUT, 'ExcelUpload.png');
    await installDeepFind(tab);
    let counts = '';
    try {
        await tab.goto(frontdoorUrl('lightning/n/Sales_Dashboard'), { waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitDeep(tab, '.upload-button >>> button', { timeout: 90000 });
        await (await deepHandle(tab, '.upload-button >>> button')).click();

        // 모달 안 파일 입력이 활성화될 때까지 (= SheetJS 로드 완료)
        await waitDeep(tab, 'c-excel-import >>> .file-input >>> input[type="file"]', { enabled: true });
        await (await deepHandle(tab, 'c-excel-import >>> .file-input >>> input[type="file"]')).uploadFile(file);

        await waitDeep(tab, '.preview-summary');
        const summary = (await deepText(tab, '.preview-summary')).replace(/\s+/g, ' ');
        if (!summary.includes('업로드 가능 3건 · 오류 1건')) problems.push(`미리보기 집계가 다름: ${summary.trim()}`);

        await (await deepHandle(tab, '.import-button >>> button')).click();
        await waitDeep(tab, '.success-count');
        const success = await deepText(tab, '.success-count');
        const failed = await deepText(tab, '.failed-count');
        if (success !== '3' || failed !== '1') problems.push(`업로드 결과가 다름: 성공 ${success}, 실패 ${failed} (기대 3 / 1)`);
        await sleep(1500);
        await tab.screenshot({ path: shot, fullPage: true });
    } catch (e) {
        problems.push(e.message);
        await tab.screenshot({ path: shot, fullPage: true }).catch(() => {});
    } finally {
        await tab.close();
        // org에 실제로 저장됐는지 확인 후 삭제
        const out = runApexFile(cleanup);
        counts = (out.match(/SMOKE_COUNTS accounts=(\d+) contacts=(\d+)/) || []).slice(1).join('/');
        if (counts !== '2/3') problems.push(`org 저장 결과가 다름: Account/Contact = ${counts || '확인 불가'} (기대 2/3)`);
    }
    return { name, ok: problems.length === 0, problems, result: { canvases: 0, sizes: [`org Account/Contact=${counts}`] }, shot };
}

// 화면 안 모든 shadow DOM의 버튼·링크 텍스트 (List View 버튼 확인용, 브라우저 안에서 실행)
function collectButtonTexts() {
    const out = [];
    const more = [];
    const walk = (root) => {
        root.querySelectorAll('button, a, [role="menuitem"]').forEach((el) => {
            const text = (el.textContent || '').trim();
            out.push(text);
            // title 예: 'Show one more action', 'Show 3 more actions' (버튼 수에 따라 문구가 바뀜)
            if (/more actions?$|작업 \d* ?개? ?더/i.test(el.title || '')) more.push(el);
        });
        root.querySelectorAll('*').forEach((el) => el.shadowRoot && walk(el.shadowRoot));
    };
    walk(document);
    // 버튼이 많으면 List View 버튼은 ▼(더보기) 메뉴 안에 있으므로 메뉴를 열어 다음 확인 때 보이게 함
    if (!out.includes('Excel 업로드') && more.length && !window.__moreOpened) {
        window.__moreOpened = true; // 반복 클릭하면 메뉴가 다시 닫힘
        more[0].click();
    }
    return out.filter(Boolean);
}

/*
 * 공통 Excel 업로드 진입점 E2E
 *  1) Account List View에 'Excel 업로드' 버튼  2) URL 페이지(파라미터 있음 → 파일 선택 / 없음 → 설정 오류)
 *  3) Account 레코드 Quick Action → Account_Related_Contact 설정으로 실제 업로드 → org에 Contact 저장 확인 → 정리
 */
async function checkExcelEntryPoints(browser) {
    const name = 'Excel 공통 진입점';
    const problems = [];
    const cleanup = path.join(__dirname, 'apex', 'delete-smoke-data.apex');
    const setup = path.join(OUT, 'smoke-parent.apex');
    fs.writeFileSync(setup, "Account a = new Account(Name = '[SMOKE] Action Parent'); insert a; System.debug(LoggingLevel.ERROR, 'SMOKE_PARENT=' + a.Id);");
    runApexFile(cleanup);
    const parentId = (runApexFile(setup).match(/SMOKE_PARENT=(\w{18})/) || [])[1];

    const XLSX = require('../force-app/main/default/staticresources/sheetjs.js');
    const stamp = Date.now();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
        ['Last Name', 'First Name', 'Email', 'Birthdate'],
        ['Kim', 'Action', `action1.${stamp}@example.com`, '1990-05-01'],
        ['Lee', 'Action', `action2.${stamp}@example.com`, ''],
        ['Bad', 'Date', '', '1990-13-01']
    ]), 'Contacts');
    const file = path.join(OUT, 'smoke-action-upload.xlsx');
    fs.writeFileSync(file, Buffer.from(XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })));

    const tab = await browser.newPage();
    await tab.setViewport({ width: 1400, height: 1000 });
    tab.on('console', (msg) => {
        if (msg.type() === 'error' && !IGNORED.some((re) => re.test(msg.text()))) problems.push(`console.error: ${msg.text()}`);
    });
    tab.on('pageerror', (err) => problems.push(`page exception: ${err.message}`));
    await installDeepFind(tab);
    const shots = [];
    const shoot = async (label) => {
        const p = path.join(OUT, `Excel${label}.png`);
        await tab.screenshot({ path: p, fullPage: true }).catch(() => {});
        shots.push(p);
    };
    let counts = '';
    try {
        // 1) List View 버튼
        await tab.goto(frontdoorUrl('lightning/o/Account/list?filterName=AllAccounts'), { waitUntil: 'domcontentloaded', timeout: 90000 });
        const deadline = Date.now() + 60000;
        let found = false;
        while (Date.now() < deadline && !found) {
            try {
                found = (await tab.evaluate(collectButtonTexts)).includes('Excel 업로드');
            } catch (e) {
                if (!/context was destroyed|Cannot find context/i.test(e.message)) throw e;
            }
            if (!found) await sleep(1000);
        }
        if (!found) problems.push('Account List View에 Excel 업로드 버튼이 없음');
        await shoot('ListView');

        // 2) URL 페이지 (List View 버튼이 여는 주소)
        await tab.goto(frontdoorUrl('lightning/cmp/c__excelImportPage?c__configName=Account_Contact'), { waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitDeep(tab, 'c-excel-import >>> .file-input >>> input[type="file"]', { enabled: true, timeout: 90000 });
        await shoot('Page');
        await tab.goto(frontdoorUrl('lightning/cmp/c__excelImportPage'), { waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitDeep(tab, 'c-excel-import >>> .config-error', { timeout: 90000 });
        const configError = await deepText(tab, 'c-excel-import >>> .config-error');
        if (!/configName/.test(configError || '')) problems.push(`파라미터 누락 오류 문구가 다름: ${configError}`);
        await shoot('NoParam');

        // 3) 레코드 Quick Action
        if (!parentId) throw new Error('테스트용 Account 생성 실패');
        const back = encodeURIComponent(`/lightning/r/Account/${parentId}/view`);
        await tab.goto(frontdoorUrl(`lightning/action/quick/Account.Excel_Upload_Contacts?objectApiName=Account&context=RECORD_DETAIL&recordId=${parentId}&backgroundContext=${back}`), { waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitDeep(tab, 'c-excel-import-action >>> c-excel-import >>> .file-input >>> input[type="file"]', { enabled: true, timeout: 90000 });
        await (await deepHandle(tab, 'c-excel-import-action >>> c-excel-import >>> .file-input >>> input[type="file"]')).uploadFile(file);
        await waitDeep(tab, 'c-excel-import-action >>> c-excel-import >>> .preview-summary');
        const summary = (await deepText(tab, 'c-excel-import-action >>> c-excel-import >>> .preview-summary')).replace(/\s+/g, ' ');
        if (!summary.includes('업로드 가능 2건 · 오류 1건')) problems.push(`Quick Action 미리보기 집계가 다름: ${summary.trim()}`);
        await (await deepHandle(tab, 'c-excel-import-action >>> c-excel-import >>> .import-button >>> button')).click();
        await waitDeep(tab, 'c-excel-import-action >>> c-excel-import >>> .success-count');
        const success = await deepText(tab, 'c-excel-import-action >>> c-excel-import >>> .success-count');
        if (success !== '2') problems.push(`Quick Action 업로드 성공 ${success}건 (기대 2)`);
        await sleep(1500);
        await shoot('QuickAction');
    } catch (e) {
        problems.push(e.message);
        await shoot('EntryFailure');
    } finally {
        await tab.close();
        const out = runApexFile(cleanup);
        counts = (out.match(/SMOKE_COUNTS accounts=(\d+) contacts=(\d+)/) || []).slice(1).join('/');
        if (counts !== '1/2') problems.push(`org 저장 결과가 다름: Account/Contact = ${counts || '확인 불가'} (기대 1/2)`);
    }
    return { name, ok: problems.length === 0, problems, state: `org Account/Contact=${counts}`, shot: shots.join(', ') };
}

async function checkPage(browser, page) {
    const tab = await browser.newPage();
    await tab.setViewport({ width: 1400, height: 1000 });
    const problems = [];
    tab.on('console', (msg) => {
        if (msg.type() === 'error' && !IGNORED.some((re) => re.test(msg.text()))) {
            problems.push(`console.error: ${msg.text()}`);
        }
    });
    tab.on('pageerror', (err) => problems.push(`page exception: ${err.message}`));

    await tab.goto(frontdoorUrl(page.path), { waitUntil: 'domcontentloaded', timeout: 90000 });

    // 기대한 수의 canvas가 그려질 때까지 최대 90초 대기 (Apex 조회 + 라이브러리 로드 포함)
    let result = { host: false, canvases: 0, errors: [] };
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
        try {
            result = await tab.evaluate(inspect, page.tag);
        } catch (e) {
            // frontdoor → Lightning 리다이렉트 중에는 실행 컨텍스트가 바뀌므로 재시도
            if (!/context was destroyed|Cannot find context/i.test(e.message)) throw e;
        }
        if (result.canvases >= page.minCanvases || result.errors.length) break;
        await sleep(1000);
    }
    await sleep(3000); // 애니메이션 종료 후 캡처
    const shot = path.join(OUT, `${page.name.replace(/\W/g, '')}.png`);
    await tab.screenshot({ path: shot, fullPage: true });
    await tab.close();

    if (!result.host) problems.push(`컴포넌트 <${page.tag}> 를 화면에서 찾지 못함`);
    else if (result.canvases < page.minCanvases) problems.push(`canvas ${result.canvases}개 (기대 ${page.minCanvases}개 이상) → 일부 차트 미표시`);
    if (result.emptyCanvases) problems.push(`크기 0인 canvas ${result.emptyCanvases}개 (컨테이너 높이 문제)`);
    result.errors.forEach((t) => problems.push(`컴포넌트 에러 메시지: ${t}`));

    return { ...page, ok: problems.length === 0, problems, result, shot };
}

/*
 * LoL 분석기: 첫 화면 점수·조합표 + 분석 버튼 확인.
 * CLAUDE_CODE 모드(기본): 요청이 저장되고 "대기 중"이 표시되면 정상 → 만든 요청은 바로 삭제.
 * API 모드: 결과가 나오거나, Key 미등록이면 "Key 확인" 안내가 나와야 정상. 그 외 오류·멈춤은 실패.
 */
async function checkLolBuilder(browser) {
    const name = 'LoL Claude 연동';
    const problems = [];
    const tab = await browser.newPage();
    await tab.setViewport({ width: 1400, height: 1000 });
    await installDeepFind(tab);
    tab.on('pageerror', (err) => problems.push(`page exception: ${err.message}`));
    const shot = path.join(OUT, 'LoLClaude.png');
    const startedAt = new Date(Date.now() - 60000).toISOString().replace(/\.\d+Z$/, 'Z'); // SOQL datetime 리터럴 (서버 시계 오차 1분 여유)
    let state = '';
    try {
        await tab.goto(frontdoorUrl('lightning/n/LoL_Team_Builder'), { waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitDeep(tab, 'c-lol-team-builder >>> .total', { timeout: 90000 });
        const total = Number(await deepText(tab, 'c-lol-team-builder >>> .total'));
        if (!(total > 0 && total <= 100)) problems.push(`총점 이상: ${total}`);
        await waitDeep(tab, '.analyze-button >>> button', { enabled: true });
        await (await deepHandle(tab, '.analyze-button >>> button')).click();
        // CLAUDE_CODE 모드: 요청이 저장돼 "대기 중"이 표시되면 성공 / API 모드: 결과 또는 Key 안내
        const deadline = Date.now() + 150000;
        while (Date.now() < deadline && !state) {
            const waiting = await deepText(tab, '.waiting-text');
            const text = await deepText(tab, '.analysis-text');
            const error = await deepText(tab, '.analysis-error');
            if (waiting && /대기 중|분석 중/.test(waiting)) state = `요청 저장됨: ${waiting.trim().split(' — ')[0]}`;
            else if (text) state = `분석 성공 (${text.trim().length}자)`;
            else if (error) {
                state = `안내: ${error.trim()}`;
                if (!/API Key|Named Credential/.test(error)) problems.push(`예상하지 못한 오류: ${error.trim()}`);
            }
            await sleep(1000);
        }
        if (!state) problems.push('150초 안에 요청 저장·분석 결과·오류가 표시되지 않음');
        await tab.screenshot({ path: shot, fullPage: true });
    } catch (e) {
        problems.push(e.message);
        await tab.screenshot({ path: shot, fullPage: true }).catch(() => {});
    } finally {
        await tab.close();
        // 스모크 테스트가 만든 대기 요청은 삭제 (워커가 처리하며 구독 사용량을 쓰지 않도록)
        try {
            const soql = `SELECT Id FROM LoL_Analysis_Request__c WHERE Status__c = 'Pending' AND CreatedDate >= ${startedAt}`;
            const rows = JSON.parse(execFileSync(`"${SF}"`, ['data', 'query', '--query', `"${soql}"`, '--target-org', ORG, '--json'], { encoding: 'utf8', shell: true })).result.records;
            rows.forEach((r) => execFileSync(`"${SF}"`, ['data', 'delete', 'record', '--sobject', 'LoL_Analysis_Request__c', '--record-id', r.Id, '--target-org', ORG], { shell: true }));
            if (rows.length) state += ` → 테스트 요청 ${rows.length}건 정리`;
        } catch (e) {
            problems.push(`테스트 요청 정리 실패: ${e.message.slice(0, 200)}`);
        }
    }
    return { name, ok: problems.length === 0, problems, state, shot };
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: true,
        userDataDir: path.join(OUT, 'edge-profile'),
        args: ['--no-first-run', '--disable-extensions']
    });
    let failed = false;
    try {
        for (const page of PAGES) {
            const r = await checkPage(browser, page);
            failed = failed || !r.ok;
            console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}  canvas ${r.result.canvases}개 (${(r.result.sizes || []).join(', ')})  screenshot=${r.shot}`);
            r.problems.forEach((p) => console.log(`    - ${p}`));
        }
        const upload = await checkExcelUpload(browser);
        failed = failed || !upload.ok;
        console.log(`[${upload.ok ? 'PASS' : 'FAIL'}] ${upload.name}  ${upload.result.sizes[0]}  screenshot=${upload.shot}`);
        upload.problems.forEach((p) => console.log(`    - ${p}`));
        const entry = await checkExcelEntryPoints(browser);
        failed = failed || !entry.ok;
        console.log(`[${entry.ok ? 'PASS' : 'FAIL'}] ${entry.name}  ${entry.state}  screenshot=${entry.shot}`);
        entry.problems.forEach((p) => console.log(`    - ${p}`));
        const lol = await checkLolBuilder(browser);
        failed = failed || !lol.ok;
        console.log(`[${lol.ok ? 'PASS' : 'FAIL'}] ${lol.name}  ${lol.state}  screenshot=${lol.shot}`);
        lol.problems.forEach((p) => console.log(`    - ${p}`));
    } finally {
        await browser.close();
    }
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error('스모크 테스트 실행 실패:', e.message);
    process.exit(2);
});
