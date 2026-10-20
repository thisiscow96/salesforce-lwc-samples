/*
 * LoL 분석 요청 큐 ↔ Claude Code 연결용 CLI (org 읽기/쓰기만 담당, 분석은 Claude Code가 수행)
 *
 *   node scripts/lol/claude-worker.js pending [N]        처리할 요청 N건(기본 3) JSON 출력 (Pending + 30분 넘게 멈춘 Processing)
 *   node scripts/lol/claude-worker.js claim <Id>         Processing으로 선점 (이미 다른 워커가 선점했으면 exit 3)
 *   node scripts/lol/claude-worker.js complete <Id> <결과.json>   결과 기록 → Completed
 *        결과.json = { "text": "분석 본문", "sources": [{ "title": "...", "url": "https://..." }], "searchCount": 3 }
 *   node scripts/lol/claude-worker.js fail <Id> "사유"    Failed로 표시
 *
 * 연결 방식 (환경 변수로 자동 선택)
 *   - 로컬 PC (기본): sf CLI 로그인(chartjs-dev)으로 REST API 호출. 토큰은 sf CLI가 처리.
 *   - 클라우드 루틴: LOL_QUEUE_URL = https://<사이트>/lolworker/services/apexrest/lol/queue
 *       큐 전용 API(LolWorkerApi). 인증 헤더 X-LoL-Worker-Key는 Anthropic 프록시가 네트워크 시크릿으로 붙인다
 *       → 이 스크립트와 Claude는 키를 모름. (로컬 시험 때만 LOL_WORKER_KEY로 직접 지정 가능)
 *       HTTP는 curl 사용: 클라우드 프록시 설정(HTTPS_PROXY 등)을 따르기 때문 (Node fetch는 무시함)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SF = process.env.SF_CLI || 'C:/Program Files/sf/bin/sf.cmd';
const ORG = process.env.SF_ORG || 'chartjs-dev';
const QUEUE_URL = (process.env.LOL_QUEUE_URL || '').replace(/\/+$/, '');
const API = 'v65.0';
const STALE_MINUTES = 30;
const MAX_RESULT = 131072;
const ID_PATTERN = /^[a-zA-Z0-9]{15,18}$/;

class ConflictError extends Error {}

function withBodyFile(body, fn) {
    if (!body) return fn(null);
    const file = path.join(os.tmpdir(), `lol-worker-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(body), 'utf8'); // 본문은 파일로 전달 → 한글·줄바꿈·따옴표가 셸 인용에 깨지지 않음
    try {
        return fn(file);
    } finally {
        fs.rmSync(file, { force: true });
    }
}

// ---------- 로컬: sf CLI ----------
function sfCall(method, resource, body) {
    return withBodyFile(body, (file) => {
        const args = ['api', 'request', 'rest', `/services/data/${API}${resource}`, '--method', method, '--target-org', ORG];
        if (file) args.push('--body', `@${file}`, '--header', 'Content-Type:application/json');
        try {
            const out = execFileSync(`"${SF}"`, args.map((a) => `"${a}"`), { encoding: 'utf8', shell: true, maxBuffer: 50 * 1024 * 1024 }).trim();
            const parsed = out ? JSON.parse(out) : null;
            if (Array.isArray(parsed) && parsed[0] && parsed[0].errorCode) {
                throw new Error(`Salesforce ${parsed[0].errorCode}: ${parsed[0].message}`);
            }
            return parsed;
        } catch (e) {
            const detail = (e.stdout || e.stderr || e.message || '').toString().slice(0, 500);
            throw new Error(detail.includes('errorCode') || detail.startsWith('Salesforce') ? detail : `sf CLI 호출 실패 (로그인 필요 시: sf org login web --alias ${ORG}): ${detail}`);
        }
    });
}

const worker = `Claude Code (${os.hostname()})`;
const sfBackend = {
    name: 'sf CLI',
    pending(limit) {
        const stale = new Date(Date.now() - STALE_MINUTES * 60000).toISOString();
        const soql =
            'SELECT Id, Name, Composition__c, Total_Score__c, Prompt__c, CreatedBy.Name, CreatedDate FROM LoL_Analysis_Request__c ' +
            `WHERE Status__c = 'Pending' OR (Status__c = 'Processing' AND Claimed_At__c < ${stale}) ORDER BY CreatedDate LIMIT ${limit}`;
        const result = sfCall('GET', `/query?q=${encodeURIComponent(soql)}`);
        const items = result.records.map((r) => ({
            id: r.Id,
            name: r.Name,
            composition: r.Composition__c,
            totalScore: r.Total_Score__c,
            requestedBy: r.CreatedBy && r.CreatedBy.Name,
            createdDate: r.CreatedDate,
            prompt: r.Prompt__c
        }));
        return { count: items.length, items };
    },
    claim(id) {
        const current = sfCall('GET', `/sobjects/LoL_Analysis_Request__c/${id}?fields=Status__c,Claimed_At__c`);
        const stale = current.Claimed_At__c && new Date(current.Claimed_At__c) < new Date(Date.now() - STALE_MINUTES * 60000);
        if (current.Status__c !== 'Pending' && !(current.Status__c === 'Processing' && stale)) throw new ConflictError(`already ${current.Status__c}`);
        sfCall('PATCH', `/sobjects/LoL_Analysis_Request__c/${id}`, { Status__c: 'Processing', Claimed_At__c: new Date().toISOString(), Processed_By__c: worker, Error_Message__c: null });
    },
    complete(id, text, sources, searchCount) {
        sfCall('PATCH', `/sobjects/LoL_Analysis_Request__c/${id}`, {
            Status__c: 'Completed',
            Result__c: text,
            Sources_JSON__c: JSON.stringify(sources),
            Search_Count__c: searchCount,
            Completed_At__c: new Date().toISOString(),
            Processed_By__c: worker,
            Error_Message__c: null
        });
    },
    fail(id, message) {
        sfCall('PATCH', `/sobjects/LoL_Analysis_Request__c/${id}`, { Status__c: 'Failed', Error_Message__c: message, Completed_At__c: new Date().toISOString(), Processed_By__c: worker });
    }
};

// ---------- 클라우드: 큐 전용 API (curl) ----------
function siteCall(method, resource, body) {
    return withBodyFile(body, (file) => {
        const args = ['-sS', '-X', method, '-w', '\n%{http_code}', '-H', 'Accept: application/json'];
        if (process.env.LOL_WORKER_KEY) args.push('-H', `X-LoL-Worker-Key: ${process.env.LOL_WORKER_KEY}`);
        if (file) args.push('-H', 'Content-Type: application/json', '--data-binary', `@${file}`);
        args.push(`${QUEUE_URL}${resource}`);
        let out;
        try {
            out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
        } catch (e) {
            throw new Error(`큐 API 연결 실패 (네트워크 허용 도메인 확인): ${(e.stderr || e.message || '').toString().slice(0, 300)}`);
        }
        const status = Number(out.slice(out.lastIndexOf('\n') + 1));
        const text = out.slice(0, out.lastIndexOf('\n'));
        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            parsed = { raw: text.slice(0, 300) };
        }
        if (status === 409) throw new ConflictError((parsed && parsed.error) || 'conflict');
        if (status === 401) throw new Error('큐 API 인증 실패(401): 클라우드 환경의 네트워크 시크릿(X-LoL-Worker-Key)과 허용 호스트를 확인하세요.');
        if (status < 200 || status >= 300) throw new Error(`큐 API ${status}: ${JSON.stringify(parsed).slice(0, 300)}`);
        return parsed;
    });
}

const siteBackend = {
    name: 'queue API',
    pending: (limit) => siteCall('GET', `/pending?limit=${limit}`),
    claim: (id) => siteCall('POST', `/${id}/claim`, {}),
    complete: (id, text, sources, searchCount) => siteCall('POST', `/${id}/complete`, { text, sources, searchCount }),
    fail: (id, message) => siteCall('POST', `/${id}/fail`, { message })
};

const backend = QUEUE_URL ? siteBackend : sfBackend;

function requireId(id) {
    if (!ID_PATTERN.test(id || '')) throw new Error(`잘못된 레코드 Id: ${id}`);
    return id;
}

// 출처는 http(s)만 허용 (화면에서 링크로 렌더링되므로 javascript: 등 차단). 서버(LolWorkerApi)에서도 한 번 더 거름
function cleanSources(sources) {
    const seen = new Set();
    return (Array.isArray(sources) ? sources : [])
        .filter((s) => s && /^https?:\/\//i.test(String(s.url || '')))
        .filter((s) => !seen.has(s.url) && seen.add(s.url))
        .slice(0, 20)
        .map((s) => ({ title: String(s.title || s.url).slice(0, 200), url: String(s.url).slice(0, 1000) }));
}

function main() {
    const [command, arg1, arg2] = process.argv.slice(2);
    if (command === 'pending') {
        const limit = Math.max(1, Math.min(Number(arg1) || 3, 10));
        console.log(JSON.stringify(backend.pending(limit), null, 2));
    } else if (command === 'claim') {
        backend.claim(requireId(arg1));
        console.log(`claimed ${arg1} (${backend.name})`);
    } else if (command === 'complete') {
        const id = requireId(arg1);
        // Windows 도구가 붙이는 UTF-8 BOM 제거 후 파싱
        const payload = JSON.parse(fs.readFileSync(arg2, 'utf8').replace(/^﻿/, ''));
        const text = String(payload.text || '').trim();
        if (!text) throw new Error('결과 text가 비어 있습니다.');
        const sources = cleanSources(payload.sources);
        backend.complete(id, text.slice(0, MAX_RESULT), sources, Number(payload.searchCount) || 0);
        console.log(`completed ${id} (본문 ${text.length}자, 출처 ${sources.length}건, ${backend.name})`);
    } else if (command === 'fail') {
        backend.fail(requireId(arg1), String(arg2 || '처리 실패').slice(0, 255));
        console.log(`failed ${arg1} (${backend.name})`);
    } else {
        console.log('사용법: pending [N] | claim <Id> | complete <Id> <결과.json> | fail <Id> "사유"');
        process.exitCode = 1;
    }
}

try {
    main();
} catch (e) {
    if (e instanceof ConflictError) {
        console.error(`건너뜀: 다른 워커가 이미 처리 중이거나 완료한 요청입니다 (${e.message})`);
        process.exit(3);
    }
    console.error(`오류: ${e.message}`);
    process.exit(1);
}
