/*
 * LoL_Champion__mdt 레코드 조립 (build-metadata.js와 Jest 테스트 데이터가 함께 사용)
 *   팀 선호 픽(lol-data.js CHAMPIONS) + 전체 통계(lane-stats.json: lol.ps 우선, MOBA Trainer 보충) + 능력치 프로필(champion-profiles.js)
 * 반환: [{ developerName, label, fields: { Champion_Key__c: ..., ... } }] (표시 순서대로)
 */
const { CHAMPIONS, TIER_SCORE } = require('./lol-data');
const { PROFILES } = require('./champion-profiles');
const STATS = require('./lane-stats.json');

const LANE_SUFFIX = { TOP: 'Top', JUNGLE: 'Jungle', MID: 'Mid', ADC: 'Adc', SUPPORT: 'Support' };
// Data Dragon id → 기존 Champion Key (시너지·DeveloperName 호환)
const KEY_ALIAS = { MonkeyKing: 'Wukong', Leblanc: 'LeBlanc' };
const ddIdOf = (key) => Object.keys(KEY_ALIAS).find((id) => KEY_ALIAS[id] === key) || key;

function championRecords() {
    // 행마다 실제 출처를 기록 (lol.ps 한국 에메랄드+ / MOBA Trainer 보충)
    const sourceOf = (s) => (s.source === 'lol.ps' ? `lol.ps ${STATS.primary.patch} 한국 에메랄드+` : `MOBA Trainer ${STATS.secondary.patch} Emerald+`);
    // 라인 안 정렬 점수: lol.ps PS 점수가 있는 항목이 먼저, 보충 항목은 그 뒤 티어 순
    const rankOf = (s) => (s.psScore != null ? 1000 + s.psScore : s.mtRank || 0);
    const statsOf = new Map(STATS.rows.map((r) => [`${KEY_ALIAS[r.id] || r.id}|${r.lane}`, r]));
    const koName = new Map(CHAMPIONS.map((c) => [c[0], c[1]])); // 선호 픽의 기존 한글 표기 유지 (예: 문도, 자르반)
    const enName = new Map(CHAMPIONS.map((c) => [c[0], c[2]]));

    const entries = [];
    CHAMPIONS.forEach((c) => {
        const [key, ko, en, lane, cls, dmg, tier, wr, cc, front, damage, late, early, engage, peel, carry, diff, note, source] = c;
        const p = PROFILES[ddIdOf(key)];
        if (!p) throw new Error(`프로필 없음: ${key}`);
        const s = statsOf.get(`${key}|${lane}`);
        entries.push({
            key, ko, en, lane, cls, dmg, cc, front, damage, late, early, engage, peel, carry, diff, note,
            solo: p[11], prio: p[12], obj: p[13], preferred: true,
            // 같은 출처의 최신 통계가 있으면 갱신, 없으면(표본 부족) 기존 값 유지
            tier: s ? s.tier : tier, wr: s ? s.winRate : wr, pick: s ? s.pickRate : null, ban: s ? s.banRate : null,
            ps: s ? s.psScore : null, honey: s ? s.honey : false, riotKey: s ? s.riotKey : null,
            source: s ? sourceOf(s) : source, rank: s ? rankOf(s) : -1
        });
    });
    const preferredIds = new Set(entries.map((e) => `${e.key}|${e.lane}`));
    STATS.rows.forEach((s) => {
        const key = KEY_ALIAS[s.id] || s.id;
        if (preferredIds.has(`${key}|${s.lane}`)) return;
        const p = PROFILES[s.id];
        if (!p) throw new Error(`프로필 없음: ${s.id} (champion-profiles.js에 추가)`);
        const [cls, dmg, cc, front, damage, late, early, engage, peel, carry, diff, solo, prio, obj, note] = p;
        entries.push({
            key, ko: koName.get(key) || s.ko, en: enName.get(key) || s.en, lane: s.lane, cls, dmg, cc, front, damage, late, early, engage, peel, carry, diff, note,
            solo, prio, obj, preferred: false, tier: s.tier, wr: s.winRate, pick: s.pickRate, ban: s.banRate,
            ps: s.psScore, honey: s.honey, riotKey: s.riotKey, source: sourceOf(s), rank: rankOf(s)
        });
    });
    // 표시 순서: 라인별로 팀 선호 픽(기존 순서) → 나머지는 PS 점수 높은 순
    const laneOrder = Object.keys(LANE_SUFFIX);
    const preferredOrder = new Map(CHAMPIONS.map((c, i) => [`${c[0]}|${c[3]}`, i]));
    entries.sort(
        (a, b) =>
            laneOrder.indexOf(a.lane) - laneOrder.indexOf(b.lane) ||
            Number(b.preferred) - Number(a.preferred) ||
            (a.preferred ? preferredOrder.get(`${a.key}|${a.lane}`) - preferredOrder.get(`${b.key}|${b.lane}`) : b.rank - a.rank)
    );

    return entries.map((e, i) => ({
        developerName: `${e.key}_${LANE_SUFFIX[e.lane]}`,
        label: e.ko,
        fields: {
            Champion_Key__c: e.key,
            English_Name__c: e.en,
            Lane__c: e.lane,
            Role_Class__c: e.cls,
            Damage_Type__c: e.dmg,
            Meta_Tier__c: e.tier,
            Win_Rate__c: e.wr == null ? null : Math.round(e.wr * 10) / 10, // 필드 scale 1
            Meta_Score__c: TIER_SCORE[e.tier],
            CC__c: e.cc,
            Frontline__c: e.front,
            Damage__c: e.damage,
            Late_Game__c: e.late,
            Early_Game__c: e.early,
            Engage__c: e.engage,
            Peel__c: e.peel,
            Carry__c: e.carry,
            Difficulty__c: e.diff,
            Solo_Kill__c: e.solo,
            Lane_Priority__c: e.prio,
            Objective__c: e.obj,
            Pick_Rate__c: e.pick,
            Ban_Rate__c: e.ban,
            Preferred__c: e.preferred,
            PS_Score__c: e.ps,
            Honey__c: e.honey === true,
            Riot_Key__c: e.riotKey,
            Ddragon_Id__c: ddIdOf(e.key), // 챔피언 아이콘: ddragon.leagueoflegends.com/cdn/<버전>/img/champion/<id>.png
            Note__c: e.note,
            Source__c: e.source,
            Sort_Order__c: i + 1
        }
    }));
}

module.exports = { championRecords, STATS };
