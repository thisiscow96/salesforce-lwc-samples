/*
 * 라인별 전체 챔피언 통계 수집 → scripts/lol/mt-stats.json
 *   - MOBA Trainer 티어 리스트(Emerald+, u.gg·op.gg 병합): 티어·승률·픽률·밴률
 *   - Riot Data Dragon ko_KR: 한국어 챔피언명
 * 사용: node scripts/lol/fetch-stats.js  → node scripts/lol/build-metadata.js → 배포
 * 페이지 구조가 바뀌면 rows 수가 크게 줄어드므로 결과 건수를 확인할 것 (2026-10 기준 약 267건)
 */
const fs = require('fs');
const path = require('path');

const TIER_URL = 'https://www.mobatrainer.com/lol/tier-list';
const ROLE_TO_LANE = { top: 'TOP', jungle: 'JUNGLE', mid: 'MID', adc: 'ADC', support: 'SUPPORT' };

async function get(url, asJson) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return asJson ? res.json() : res.text();
}

// 페이지에 이스케이프된 JSON으로 들어 있는 rows를 항목 단위로 추출 (필드 순서·null 값에 영향받지 않게 개별 추출)
function parseRows(html) {
    const text = html.replace(/\\"/g, '"');
    const field = (chunk, name) => {
        const m = new RegExp(`"${name}":(?:"([^"]*)"|([-\\d.]+|null))`).exec(chunk);
        if (!m) return undefined;
        if (m[1] !== undefined) return m[1];
        return m[2] === 'null' ? null : Number(m[2]);
    };
    const rows = new Map();
    let i = text.indexOf('{"championId":"');
    while (i >= 0) {
        const end = text.indexOf('"bestAgainst"', i);
        const chunk = text.slice(i, end > i ? end : i + 600);
        const id = field(chunk, 'championId');
        const lane = ROLE_TO_LANE[field(chunk, 'role')];
        if (id && lane && typeof field(chunk, 'winRate') === 'number' && !rows.has(`${id}|${lane}`)) {
            rows.set(`${id}|${lane}`, {
                id,
                en: field(chunk, 'championName'),
                lane,
                tier: field(chunk, 'tier'),
                tierScore: field(chunk, 'tierScore'),
                winRate: field(chunk, 'winRate'),
                pickRate: field(chunk, 'pickRate'),
                banRate: field(chunk, 'banRate')
            });
        }
        i = text.indexOf('{"championId":"', i + 1);
    }
    return [...rows.values()];
}

(async () => {
    const html = await get(TIER_URL);
    const patch = (/Patch (\d+\.\d+)/.exec(html) || [])[1];
    const rows = parseRows(html);
    const version = (await get('https://ddragon.leagueoflegends.com/api/versions.json', true))[0];
    const dd = (await get(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/champion.json`, true)).data;
    rows.forEach((r) => {
        r.ko = dd[r.id] ? dd[r.id].name : r.en;
    });
    rows.sort((a, b) => a.lane.localeCompare(b.lane) || b.tierScore - a.tierScore);
    const out = { source: 'MOBA Trainer Emerald+ (u.gg·op.gg 병합)', url: TIER_URL, patch, ddragon: version, fetchedAt: new Date().toISOString().slice(0, 10), rows };
    fs.writeFileSync(path.join(__dirname, 'mt-stats.json'), JSON.stringify(out, null, 1));
    console.log(`Patch ${patch}, Data Dragon ${version}: ${rows.length}건, 챔피언 ${new Set(rows.map((r) => r.id)).size}명`);
})().catch((e) => {
    console.error('수집 실패:', e.message);
    process.exit(1);
});
