/*
 * LoL 분석 요청 큐 ↔ Claude Code 연결용 CLI (org 읽기/쓰기만 담당, 분석은 Claude Code가 수행)
 *
 *   node scripts/lol/claude-worker.js pending [N]        처리할 요청 N건(기본 3) JSON 출력 (Pending + 30분 넘게 멈춘 Processing)
 *   node scripts/lol/claude-worker.js claim <Id>         Processing으로 선점 (이미 다른 워커가 선점했으면 exit 3)
 *   node scripts/lol/claude-worker.js complete <Id> <결과.json>   결과 기록 → Completed
 *        결과.json = { "text": "분석 본문", "sources": [{ "title": "...", "url": "https://..." }], "searchCount": 3 }
 *   node scripts/lol/claude-worker.js fail <Id> "사유"    Failed로 표시
 *   node scripts/lol/claude-worker.js lolps <챔피언키> <라인>   lol.ps 승률·픽률·밴률·PS 점수·상대하기 어려운/쉬운 챔피언 (JSON)
 *   node scripts/lol/claude-worker.js lolps-tier <라인> [N]    lol.ps 라인별 픽률 상위 N명 (예: JUNGLE 5 = 상대 정글러 후보)
 *        라인 = 0~4 또는 TOP/JUNGLE/MID/ADC/SUPPORT. lol.ps는 수치가 스크립트 데이터에 있어 WebFetch로는 비어 보이므로 이 명령을 쓴다
 *   node scripts/lol/claude-worker.js spells <DataDragonId>   챔피언 패시브·Q~R 공식 한국어 이름과 설명 (예: Zaahen, MonkeyKing)
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

// ---------- lol.ps (프로관전러) 수치 읽기 ----------
// lol.ps는 수치를 화면 글자가 아니라 페이지 안 스크립트 데이터(SvelteKit)에 넣는다.
// WebFetch처럼 화면 글자만 읽으면 "승률 픽률 밴율" 제목만 남고 숫자가 빠지므로, 원본 HTML을 받아 스크립트 데이터를 직접 파싱한다.
const LOLPS_LANES = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT']; // lol.ps lane 번호 0~4
const LOLPS_QUERY = 'tier=2&region=0'; // 에메랄드+ · 한국

function curlText(url) {
    try {
        return execFileSync('curl', ['-sSL', '--max-time', '30', '-A', 'Mozilla/5.0', url], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    } catch (e) {
        throw new Error(`${url} 연결 실패 (네트워크 허용 도메인 확인): ${(e.stderr || e.message || '').toString().slice(0, 200)}`);
    }
}

function laneNumber(value) {
    const n = /^\d$/.test(String(value)) ? Number(value) : LOLPS_LANES.indexOf(String(value || '').toUpperCase());
    if (n < 0 || n > 4) throw new Error(`라인은 0~4 또는 TOP/JUNGLE/MID/ADC/SUPPORT: ${value}`);
    return n;
}

// "{key:값, ...}" (따옴표 없는 키) 객체에서 숫자·문자열·숫자 배열 필드 추출
function psField(chunk, name) {
    const m = new RegExp(`[{,]${name}:(\\[[^\\]]*\\]|"[^"]*"|[-\\d.]+|true|false|null)`).exec(chunk);
    if (!m) return null;
    const raw = m[1];
    if (raw.startsWith('[')) return raw.slice(1, -1).split(',').filter(Boolean).map(Number);
    if (raw.startsWith('"')) return raw.slice(1, -1);
    if (raw === 'true' || raw === 'false') return raw === 'true';
    return raw === 'null' ? null : Number(raw);
}

// Riot 숫자 키 → 한국어 이름 (Data Dragon). 실패하면 숫자 키 그대로
function championNames() {
    try {
        const version = JSON.parse(curlText('https://ddragon.leagueoflegends.com/api/versions.json'))[0];
        const data = JSON.parse(curlText(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/champion.json`)).data;
        return Object.fromEntries(Object.values(data).map((c) => [Number(c.key), c.name]));
    } catch {
        return {};
    }
}

function lolpsChampion(riotKey, lane) {
    const key = Number(riotKey);
    if (!Number.isInteger(key) || key <= 0) throw new Error(`잘못된 챔피언 키: ${riotKey}`);
    const laneNo = laneNumber(lane);
    const url = `https://lol.ps/champ/${key}?${LOLPS_QUERY}&lane=${laneNo}`;
    const html = curlText(url);
    const start = html.indexOf('champSummary:[');
    if (start < 0) throw new Error(`lol.ps 페이지에 champSummary 데이터가 없음 (페이지 구조 변경 또는 해당 라인 표본 없음): ${url}`);
    const chunk = html.slice(start, html.indexOf('}', start) + 1);
    const names = championNames();
    const matchups = (ids, rates, counts) => (ids || []).map((id, i) => ({ champion: names[id] || String(id), myWinRate: rates[i], games: counts[i] }));
    const versionLabel = (/versionInfo:\[\{versionId:\d+,description:"([^"]+)"/.exec(html) || [])[1];
    return {
        source: 'lol.ps (프로관전러 P.S) 한국 · 에메랄드+',
        patch: versionLabel || null,
        url,
        lane: LOLPS_LANES[laneNo],
        winRate: Number(psField(chunk, 'winRate')),
        pickRate: Number(psField(chunk, 'pickRate')),
        banRate: Number(psField(chunk, 'banRate')),
        psScore: Number(psField(chunk, 'psScore')),
        ranking: psField(chunk, 'ranking'),
        // myWinRate = 이 챔피언이 그 상대를 만났을 때의 승률 (낮을수록 상대하기 어려움)
        hardMatchups: matchups(psField(chunk, 'counterChampionIdList'), psField(chunk, 'counterWinrateList') || [], psField(chunk, 'counterCountList') || []),
        easyMatchups: matchups(psField(chunk, 'counterEasyChampionIdList'), psField(chunk, 'counterEasyWinrateList') || [], psField(chunk, 'counterEasyCountList') || [])
    };
}

// 라인별 픽률 상위 N명 (상대 정글러 픽률 상위 등)
function lolpsTier(lane, limit) {
    const laneNo = laneNumber(lane);
    const url = `https://lol.ps/statistics?${LOLPS_QUERY}`;
    const html = curlText(url);
    const start = html.indexOf('tierlist:[');
    if (start < 0) throw new Error(`lol.ps 통계 페이지에 tierlist 데이터가 없음 (페이지 구조 변경): ${url}`);
    const rows = html
        .slice(start, html.indexOf(']', start))
        .split('{count:')
        .slice(1)
        .map((body) => `{count:${body}`)
        .filter((chunk) => psField(chunk, 'laneId') === laneNo)
        .map((chunk) => ({
            champion: (/nameKr:"([^"]+)"/.exec(chunk) || [])[1],
            winRate: Number(psField(chunk, 'winRate')),
            pickRate: Number(psField(chunk, 'pickRate')),
            banRate: Number(psField(chunk, 'banRate')),
            psScore: Number(psField(chunk, 'opScore')),
            honey: psField(chunk, 'isHoney') === true
        }))
        .sort((a, b) => b.pickRate - a.pickRate)
        .slice(0, limit);
    return { source: 'lol.ps (프로관전러 P.S) 한국 · 에메랄드+', url, lane: LOLPS_LANES[laneNo], orderedBy: 'pickRate', rows };
}

// 챔피언 스킬 공식 설명 (Riot Data Dragon ko_KR). 신규·리워크 챔피언 스킬을 추측해 틀리지 않도록 분석 전에 확인한다
function championSpells(ddId) {
    if (!/^[A-Za-z]+$/.test(ddId || '')) throw new Error(`잘못된 Data Dragon id: ${ddId} (예: MonkeyKing, Zaahen)`);
    const version = JSON.parse(curlText('https://ddragon.leagueoflegends.com/api/versions.json'))[0];
    const data = JSON.parse(curlText(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/champion/${ddId}.json`)).data[ddId];
    const plain = (html) => String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return {
        source: `Riot Data Dragon ${version} ko_KR`,
        champion: data.name,
        passive: { name: data.passive.name, description: plain(data.passive.description) },
        spells: data.spells.map((sp, i) => ({ key: ['Q', 'W', 'E', 'R'][i], name: sp.name, description: plain(sp.description) }))
    };
}

function main() {
    const [command, arg1, arg2] = process.argv.slice(2);
    if (command === 'spells') {
        console.log(JSON.stringify(championSpells(arg1), null, 2));
    } else if (command === 'lolps') {
        console.log(JSON.stringify(lolpsChampion(arg1, arg2), null, 2));
    } else if (command === 'lolps-tier') {
        console.log(JSON.stringify(lolpsTier(arg1, Math.max(1, Math.min(Number(arg2) || 5, 20))), null, 2));
    } else if (command === 'pending') {
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
        console.log('사용법: pending [N] | claim <Id> | complete <Id> <결과.json> | fail <Id> "사유" | lolps <챔피언키> <라인> | lolps-tier <라인> [N] | spells <DataDragonId>');
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
