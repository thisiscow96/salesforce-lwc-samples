/*
 * 라인별 전체 챔피언 통계 수집 → scripts/lol/lane-stats.json
 *   1순위 lol.ps (프로관전러 P.S, 한국 서버 · 에메랄드+): 승률·픽률·밴률·PS 점수·OP 티어·꿀챔
 *   보충  MOBA Trainer (Emerald+, u.gg·op.gg 병합): lol.ps에 없는 라인 항목만
 *   Riot Data Dragon ko_KR: 한국어 챔피언명, 숫자 챔피언 키(lol.ps championId와 같음)
 * 사용: node scripts/lol/fetch-stats.js  → node scripts/lol/build-metadata.js → 배포
 * 페이지 구조가 바뀌면 건수가 크게 줄어드므로 결과를 확인할 것 (2026-10 기준 lol.ps 259건 + 보충)
 */
const fs = require('fs');
const path = require('path');

const LOLPS_TIER = 2; // 2 = 에메랄드+ (1 브실골플, 13 다이아+, 3 마스터+)
const LOLPS_REGION = 0; // 0 = 한국 (3 북미)
const LOLPS_URL = `https://lol.ps/statistics?tier=${LOLPS_TIER}&region=${LOLPS_REGION}`;
const MT_URL = 'https://www.mobatrainer.com/lol/tier-list';
const LOLPS_LANES = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT']; // lol.ps laneId 0~4
const MT_LANES = { top: 'TOP', jungle: 'JUNGLE', mid: 'MID', adc: 'ADC', support: 'SUPPORT' };
const MT_TIER_SCORE = { 'S+': 6, S: 5, A: 4, B: 3, C: 2, D: 1 };

async function get(url, asJson) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return asJson ? res.json() : res.text();
}

// "{key:값,...}" 형태(따옴표 없는 키)의 한 항목에서 필드 하나를 추출
function field(chunk, name) {
    const m = new RegExp(`[{,"]${name}"?:(?:"([^"]*)"|([-\\d.]+|true|false|null))`).exec(chunk);
    if (!m) return undefined;
    if (m[1] !== undefined) return m[1];
    if (m[2] === 'null') return null;
    if (m[2] === 'true' || m[2] === 'false') return m[2] === 'true';
    return Number(m[2]);
}

// lol.ps OP 티어(1~5)와 OP 표시 → 화면 티어 문자
function lolpsTier(opTier, isOp) {
    if (isOp) return 'S+';
    return { 1: 'S', 2: 'A', 3: 'B', 4: 'C', 5: 'D' }[opTier] || 'D';
}

function parseLolps(html, keyToId) {
    const start = html.indexOf('tierlist:[');
    if (start < 0) throw new Error('lol.ps tierlist를 찾지 못함 (페이지 구조 변경)');
    const version = (/versionInfo:\[\{versionId:\d+,description:"([^"]+)"/.exec(html) || [])[1];
    // 항목 안에는 배열이 없으므로 tierlist:[ 다음 첫 ']'가 배열 끝
    const list = html.slice(start, html.indexOf(']', start));
    const rows = [];
    list.split('{count:').slice(1).forEach((body) => {
        const chunk = `{count:${body}`;
        const id = keyToId[String(field(chunk, 'championId'))];
        const lane = LOLPS_LANES[field(chunk, 'laneId')];
        if (id && lane) {
            rows.push({
                id,
                en: field(chunk, 'nameUs'),
                lane,
                tier: lolpsTier(field(chunk, 'opTier'), field(chunk, 'isOp')),
                winRate: Number(field(chunk, 'winRate')),
                pickRate: Number(field(chunk, 'pickRate')),
                banRate: Number(field(chunk, 'banRate')),
                psScore: Number(field(chunk, 'opScore')),
                honey: field(chunk, 'isHoney') === true,
                games: field(chunk, 'count'),
                source: 'lol.ps'
            });
        }
    });
    return { version, rows };
}

function parseMobaTrainer(html) {
    const text = html.replace(/\\"/g, '"');
    const rows = new Map();
    let i = text.indexOf('{"championId":"');
    while (i >= 0) {
        const end = text.indexOf('"bestAgainst"', i);
        const chunk = text.slice(i, end > i ? end : i + 600);
        const id = field(chunk, 'championId');
        const lane = MT_LANES[field(chunk, 'role')];
        if (id && lane && typeof field(chunk, 'winRate') === 'number' && !rows.has(`${id}|${lane}`)) {
            const tier = field(chunk, 'tier');
            rows.set(`${id}|${lane}`, {
                id,
                en: field(chunk, 'championName'),
                lane,
                tier,
                winRate: field(chunk, 'winRate'),
                pickRate: field(chunk, 'pickRate'),
                banRate: field(chunk, 'banRate'),
                psScore: null,
                honey: false,
                mtRank: MT_TIER_SCORE[tier] || 0,
                source: 'MOBA Trainer'
            });
        }
        i = text.indexOf('{"championId":"', i + 1);
    }
    return { patch: (/Patch (\d+\.\d+)/.exec(html) || [])[1], rows: [...rows.values()] };
}

(async () => {
    const version = (await get('https://ddragon.leagueoflegends.com/api/versions.json', true))[0];
    const dd = (await get(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/champion.json`, true)).data;
    const keyToId = Object.fromEntries(Object.values(dd).map((c) => [c.key, c.id]));

    const lolps = parseLolps(await get(LOLPS_URL), keyToId);
    const mt = parseMobaTrainer(await get(MT_URL));
    if (lolps.version && mt.patch && lolps.version !== mt.patch) {
        console.warn(`주의: lol.ps ${lolps.version}와 MOBA Trainer ${mt.patch} 패치가 다름 (보충 데이터는 그대로 사용)`);
    }
    const seen = new Set(lolps.rows.map((r) => `${r.id}|${r.lane}`));
    const extra = mt.rows.filter((r) => !seen.has(`${r.id}|${r.lane}`));
    // riotKey: lol.ps 챔피언 페이지 주소(lol.ps/champ/<riotKey>)에 사용
    const rows = [...lolps.rows, ...extra].map((r) => ({ ...r, ko: dd[r.id].name, riotKey: Number(dd[r.id].key) }));

    const out = {
        primary: { name: 'lol.ps (프로관전러 P.S)', url: LOLPS_URL, patch: lolps.version, filter: '한국 서버 · 에메랄드+' },
        secondary: { name: 'MOBA Trainer', url: MT_URL, patch: mt.patch, filter: 'Emerald+ (u.gg·op.gg 병합), lol.ps에 없는 라인 항목만' },
        ddragon: version,
        fetchedAt: new Date().toISOString().slice(0, 10),
        rows
    };
    fs.writeFileSync(path.join(__dirname, 'lane-stats.json'), JSON.stringify(out, null, 1));
    console.log(`lol.ps ${lolps.version} ${lolps.rows.length}건 + MOBA Trainer ${mt.patch} 보충 ${extra.length}건 = ${rows.length}건, 챔피언 ${new Set(rows.map((r) => r.id)).size}명 (Data Dragon ${version})`);
})().catch((e) => {
    console.error('수집 실패:', e.message);
    process.exit(1);
});
