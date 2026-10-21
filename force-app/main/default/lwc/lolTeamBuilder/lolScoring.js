// LoL 조합 점수 계산 (순수 함수: Apex/DOM 의존 없음 → Jest로 단독 검증)
// 카테고리별로 0~1 비율을 계산하고, 배점(LoL_Score_Weight__mdt.Max_Points__c)을 곱해 점수화한다.

export const LANES = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'];
export const LANE_LABELS = { TOP: '탑', JUNGLE: '정글', MID: '미드', ADC: '원딜', SUPPORT: '서폿' };
export const CLASS_LABELS = {
    Tank: '탱커',
    Bruiser: '브루저',
    Skirmisher: '스커미셔',
    Mage: '메이지',
    Assassin: '암살자',
    Marksman: '원거리 딜러',
    Enchanter: '인챈터'
};

// 개인 성능 환산 구간 (lol.ps 한국 에메랄드+ 분포 기준: 이 구간 밖은 0 또는 1로 고정)
const WIN_RATE_RANGE = [47, 54];
const PS_RANGE = [45, 58];
const AP_FACTOR = { AD: 0, AP: 1, Mixed: 0.5 };

const clamp = (v, min = 0, max = 1) => Math.min(max, Math.max(min, v));
const round1 = (v) => Math.round(v * 10) / 10;
const pairKey = (a, b) => [a, b].sort().join('|');

/** Apex(Custom Metadata) 응답 → 계산용 구조 */
export function normalizeData(raw) {
    const champions = (raw.champions || [])
        .map((c) => ({
            id: c.DeveloperName,
            key: c.Champion_Key__c,
            name: c.MasterLabel,
            en: c.English_Name__c,
            lane: c.Lane__c,
            cls: c.Role_Class__c,
            dmgType: c.Damage_Type__c,
            tier: c.Meta_Tier__c,
            winRate: c.Win_Rate__c,
            meta: c.Meta_Score__c ?? 5,
            cc: c.CC__c ?? 0,
            front: c.Frontline__c ?? 0,
            damage: c.Damage__c ?? 0,
            late: c.Late_Game__c ?? 0,
            early: c.Early_Game__c ?? 0,
            engage: c.Engage__c ?? 0,
            peel: c.Peel__c ?? 0,
            carry: c.Carry__c ?? 0,
            diff: c.Difficulty__c ?? 5,
            solo: c.Solo_Kill__c ?? 5,
            prio: c.Lane_Priority__c ?? 5,
            obj: c.Objective__c ?? 5,
            pickRate: c.Pick_Rate__c ?? null,
            banRate: c.Ban_Rate__c ?? null,
            preferred: c.Preferred__c === true,
            psScore: c.PS_Score__c ?? null,
            honey: c.Honey__c === true,
            riotKey: c.Riot_Key__c ?? null,
            ddId: c.Ddragon_Id__c ?? null,
            note: c.Note__c,
            source: c.Source__c,
            order: c.Sort_Order__c ?? 999
        }))
        .sort((a, b) => a.order - b.order);
    const byId = new Map(champions.map((c) => [c.id, c]));
    const byLane = Object.fromEntries(LANES.map((lane) => [lane, champions.filter((c) => c.lane === lane)]));
    const synergies = new Map(
        (raw.synergies || []).map((s) => [pairKey(s.Champion_A__c, s.Champion_B__c), { a: s.Champion_A__c, b: s.Champion_B__c, score: s.Score__c ?? 0, reason: s.Reason__c }])
    );
    const weights = (raw.weights || [])
        .map((w) => ({ key: w.DeveloperName, label: w.MasterLabel, max: w.Max_Points__c ?? 0, description: w.Description__c, order: w.Sort_Order__c ?? 99 }))
        .sort((a, b) => a.order - b.order);
    const tiers = (raw.tiers || [])
        .map((t) => ({ key: t.DeveloperName, label: t.MasterLabel, skill: t.Skill__c ?? 5, order: t.Sort_Order__c ?? 99 }))
        .sort((a, b) => a.order - b.order);
    return { champions, byId, byLane, synergies, weights, tiers };
}

export function gradeOf(total) {
    if (total >= 85) return 'S';
    if (total >= 75) return 'A';
    if (total >= 65) return 'B';
    if (total >= 55) return 'C';
    return 'D';
}

export function synergiesOf(team, ctx) {
    const members = LANES.map((lane) => team[lane]);
    const found = [];
    for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
            const s = ctx.synergies.get(pairKey(members[i].key, members[j].key));
            if (s) {
                found.push({ ...s, nameA: members[i].name, nameB: members[j].name });
            }
        }
    }
    return found.sort((x, y) => y.score - x.score);
}

/**
 * 카테고리별 비율(0~1)과 설명. 객관 기준: 특정 팀의 선호(탑·정글 구조, 후반 지향, 라인별 역할 분담, 플레이어 실력)는 쓰지 않는다.
 * - PICK_STRENGTH: lol.ps 실제 통계(승률·PS 점수). 통계가 없는 픽만 티어(메타 점수)로 대체
 * - 나머지: 어느 조합에나 적용되는 기본기. 누가(어느 라인이) 맡든 팀 전체에서 상위 능력치로 판단
 */
function pickStrength(c) {
    const parts = [];
    if (c.winRate != null) parts.push(clamp((c.winRate - WIN_RATE_RANGE[0]) / (WIN_RATE_RANGE[1] - WIN_RATE_RANGE[0])));
    if (c.psScore != null) parts.push(clamp((c.psScore - PS_RANGE[0]) / (PS_RANGE[1] - PS_RANGE[0])));
    if (!parts.length) return { ratio: clamp((c.meta - 5) / 5), basis: `티어 ${c.tier}(통계 없음)` };
    return { ratio: parts.reduce((a, b) => a + b, 0) / parts.length, basis: `승률 ${c.winRate ?? '-'}% · PS ${c.psScore ?? '-'}` };
}

const topTwo = (members, key) => [...members].sort((a, b) => b[key] - a[key]).slice(0, 2);

function ratios(team, skills, ctx) {
    const members = LANES.map((lane) => team[lane]);
    const sum = (fn) => members.reduce((acc, c) => acc + fn(c), 0);

    const strengths = members.map((c) => ({ c, ...pickStrength(c) }));
    const strengthRatio = strengths.reduce((acc, s) => acc + s.ratio, 0) / members.length;
    const weakest = strengths.reduce((w, s) => (s.ratio < w.ratio ? s : w), strengths[0]);

    const front = topTwo(members, 'front');
    const frontSum = front[0].front + front[1].front;
    const ccTeam = sum((c) => c.cc);
    const engage = topTwo(members, 'engage');
    const engageValue = engage[0].engage + engage[1].engage / 2;
    const peel = topTwo(members, 'peel');
    const peelSum = peel[0].peel + peel[1].peel;
    const damageTotal = sum((c) => c.damage) || 1;
    const apShare = sum((c) => c.damage * (AP_FACTOR[c.dmgType] ?? 0.5)) / damageTotal;
    const apDev = Math.abs(apShare - 0.45);
    const damageAvg = sum((c) => c.damage) / members.length;
    const synergies = synergiesOf(team, ctx);

    return {
        PICK_STRENGTH: {
            ratio: clamp(strengthRatio),
            detail: `lol.ps 5픽 평균 ${Math.round(strengthRatio * 100)}% 수준 (가장 약한 픽: ${weakest.c.name} ${weakest.basis})`,
            weakest
        },
        FRONTLINE: { ratio: clamp(frontSum / 17), detail: `앞라인 상위 2명: ${front[0].name} ${front[0].front} + ${front[1].name} ${front[1].front} = ${frontSum} / 17`, frontSum },
        CC: { ratio: clamp(ccTeam / 32), detail: `팀 전체 CC ${ccTeam} / 32` },
        ENGAGE: { ratio: clamp(engageValue / 14), detail: `이니시: ${engage[0].name} ${engage[0].engage} + ${engage[1].name} ${engage[1].engage}의 절반`, engage: engage[0].engage, initiator: engage[0] },
        PEEL: { ratio: clamp(peelSum / 16), detail: `보호 상위 2명: ${peel[0].name} ${peel[0].peel} + ${peel[1].name} ${peel[1].peel} = ${peelSum} / 16`, peelSum },
        BALANCE: {
            ratio: apDev <= 0.15 ? 1 : clamp(1 - (apDev - 0.15) / 0.3),
            detail: `딜 기준 AP ${Math.round(apShare * 100)}% / AD ${100 - Math.round(apShare * 100)}%`,
            apShare
        },
        DAMAGE: { ratio: clamp((damageAvg - 4) / 4.5), detail: `5명 딜 능력 평균 ${round1(damageAvg)} / 10` },
        // 시너지는 점수에 넣지 않는다: 시너지 표가 일부 챔피언 쌍(정성 평가)만 있어 그 챔피언들만 유리해지기 때문 → 참고 정보로만 표시
        SYNERGY_INFO: { synergies }
    };
}

/** team: { TOP: champion, ... }, skills: 사용하지 않음(객관 기준, 호출 호환용) */
export function scoreTeam(team, skills, ctx) {
    const r = ratios(team, skills, ctx);
    const categories = ctx.weights.map((w) => {
        const item = r[w.key] || { ratio: 0, detail: '계산식 없음' };
        return { key: w.key, label: w.label, max: w.max, ratio: item.ratio, points: round1(item.ratio * w.max), detail: item.detail, description: w.description };
    });
    const total = round1(categories.reduce((acc, c) => acc + c.points, 0));
    return { team, total, grade: gradeOf(total), categories, raw: r, synergies: r.SYNERGY_INFO.synergies };
}

/** 강점 / 약점 / 운영 포인트 (규칙 기반 설명, 객관 기준) */
export function explain(result) {
    const { team, raw, categories } = result;
    const strengths = [];
    const weaknesses = [];
    const byKey = Object.fromEntries(categories.map((c) => [c.key, c]));
    const members = LANES.map((lane) => team[lane]);
    const good = (key) => byKey[key] && byKey[key].ratio >= 0.75;
    const bad = (key) => byKey[key] && byKey[key].ratio < 0.5;

    if (good('PICK_STRENGTH')) strengths.push(`개인 성능: ${raw.PICK_STRENGTH.detail}`);
    else if (bad('PICK_STRENGTH')) weaknesses.push(`개인 성능: ${raw.PICK_STRENGTH.detail} → 현재 패치 통계상 약한 픽이 많음`);
    const lowStat = members.filter((c) => c.winRate != null && c.winRate < 49);
    if (lowStat.length) weaknesses.push(`통계: ${lowStat.map((c) => `${c.name} 승률 ${c.winRate}%`).join(', ')} (lol.ps 기준 50% 미만)`);

    if (good('FRONTLINE')) strengths.push(`앞라인: ${raw.FRONTLINE.detail}`);
    else if (bad('FRONTLINE')) weaknesses.push(`앞라인: ${raw.FRONTLINE.detail} → 한타에서 버텨 줄 챔피언 부족`);
    if (good('CC')) strengths.push(`CC: ${raw.CC.detail}`);
    else if (bad('CC')) weaknesses.push(`CC: ${raw.CC.detail} → 이니시 후 묶어 둘 수단 부족`);
    if (good('ENGAGE')) strengths.push(`이니시: ${raw.ENGAGE.detail}`);
    else if (raw.ENGAGE.engage < 7) weaknesses.push(`이니시: 확실한 한타 개시 수단 부족 (${raw.ENGAGE.detail})`);
    if (good('PEEL')) strengths.push(`캐리 보호: ${raw.PEEL.detail}`);
    else if (bad('PEEL')) weaknesses.push(`캐리 보호: ${raw.PEEL.detail} → 돌진·암살 조합에 취약`);
    if (byKey.BALANCE?.ratio >= 0.9) strengths.push(`딜 구성: ${raw.BALANCE.detail} → 상대가 한 종류 방어템으로 대응하기 어려움`);
    else if (byKey.BALANCE?.ratio < 0.6) weaknesses.push(`딜 구성: ${raw.BALANCE.detail} → 상대가 ${raw.BALANCE.apShare > 0.5 ? '마법 저항력' : '방어력'}만 올려도 딜 효율 하락`);
    if (bad('DAMAGE')) weaknesses.push(`딜량: ${byKey.DAMAGE.detail} → 한타 마무리 화력 부족`);

    // 시너지: 점수와 무관한 참고 정보
    raw.SYNERGY_INFO.synergies.filter((s) => s.score > 0).forEach((s) => strengths.push(`참고 시너지: ${s.nameA} + ${s.nameB} — ${s.reason}`));
    raw.SYNERGY_INFO.synergies.filter((s) => s.score < 0).forEach((s) => weaknesses.push(`참고 상성: ${s.nameA} + ${s.nameB} — ${s.reason}`));

    const earlyAvg = members.reduce((acc, c) => acc + c.early, 0) / members.length;
    const lateAvg = members.reduce((acc, c) => acc + c.late, 0) / members.length;
    const plan =
        lateAvg - earlyAvg >= 1
            ? `초반 ${round1(earlyAvg)} < 후반 ${round1(lateAvg)} → 라인전은 버티고, 성장 후 오브젝트 한타 중심으로 운영`
            : earlyAvg - lateAvg >= 1
              ? `초반 ${round1(earlyAvg)} > 후반 ${round1(lateAvg)} → 초반 주도권으로 정글 동선·오브젝트를 선점해 일찍 끝내는 운영`
              : `초반 ${round1(earlyAvg)} · 후반 ${round1(lateAvg)}로 고른 편 → 라인 주도권이 있는 쪽 오브젝트부터 챙기는 운영`;
    return { strengths, weaknesses, plan };
}

/** 한 라인만 바꿔 점수가 가장 많이 오르는 후보 */
export function suggestSwaps(team, skills, ctx, limit = 3) {
    const base = scoreTeam(team, skills, ctx).total;
    const keys = new Set(LANES.map((lane) => team[lane].key));
    const out = [];
    LANES.forEach((lane) => {
        ctx.byLane[lane].forEach((candidate) => {
            if (candidate.id === team[lane].id || (keys.has(candidate.key) && candidate.key !== team[lane].key)) return;
            const next = { ...team, [lane]: candidate };
            const total = scoreTeam(next, skills, ctx).total;
            if (total > base) out.push({ lane, from: team[lane], to: candidate, delta: round1(total - base), total });
        });
    });
    return out.sort((a, b) => b.delta - a.delta).slice(0, limit);
}

export const EXTENDED_POOL_SIZE = 8;

/**
 * 탐색 후보: 라인별 전체 픽은 수십 명이라 모든 조합(수억 개)을 볼 수 없으므로 후보를 줄인다.
 * - preferred: 팀 선호 픽 (선호 픽이 없는 라인은 메타 상위 EXTENDED_POOL_SIZE명)
 * - extended: 선호 여부와 무관하게 메타 상위 EXTENDED_POOL_SIZE명 + 선호 픽 중 메타 상위 최대 4명
 */
export function searchPool(ctx, lane, mode = 'preferred') {
    const all = ctx.byLane[lane];
    const byMeta = [...all].sort((a, b) => b.meta - a.meta || (b.winRate ?? 0) - (a.winRate ?? 0));
    const preferred = all.filter((c) => c.preferred);
    if (mode !== 'extended') {
        return preferred.length ? preferred : byMeta.slice(0, EXTENDED_POOL_SIZE);
    }
    const picked = new Map(byMeta.slice(0, EXTENDED_POOL_SIZE).map((c) => [c.id, c]));
    preferred
        .sort((a, b) => b.meta - a.meta)
        .slice(0, Math.min(4, Math.ceil(preferred.length / 2))) // 라인당 최대 12명 → 탐색 수십만 건 이내
        .forEach((c) => picked.set(c.id, c));
    return [...picked.values()];
}

/**
 * 조합 탐색 (라인별 후보의 곱, 같은 챔피언 중복 제외).
 * locked: { lane: champion } 고정 라인, poolMode: searchPool 참고
 */
export function findBestTeams(ctx, skills, { locked = {}, limit = 30, poolMode = 'preferred' } = {}) {
    const pools = LANES.map((lane) => (locked[lane] ? [locked[lane]] : searchPool(ctx, lane, poolMode)));
    const results = [];
    let evaluated = 0;
    const team = {};
    const used = new Set();
    const walk = (index) => {
        if (index === LANES.length) {
            evaluated++;
            // 상위 limit개만 정렬 상태로 유지 (수만 개 결과를 모두 들고 있지 않도록)
            const scored = scoreTeam({ ...team }, skills, ctx);
            if (results.length < limit || scored.total > results[results.length - 1].total) {
                const at = results.findIndex((r) => scored.total > r.total);
                results.splice(at < 0 ? results.length : at, 0, scored);
                if (results.length > limit) results.pop();
            }
            return;
        }
        const lane = LANES[index];
        for (const c of pools[index]) {
            if (used.has(c.key)) continue;
            team[lane] = c;
            used.add(c.key);
            walk(index + 1);
            used.delete(c.key);
        }
    };
    walk(0);
    return { teams: results, evaluated };
}

const TIER_RANK = { 'S+': 7, S: 6, A: 5, B: 4, C: 3, D: 2, '-': 1 };
// 표시용 문자열 열(예: "52.3%")은 원래 숫자 필드로 정렬
const SORT_KEYS = { winRateLabel: 'winRate', pickRateLabel: 'pickRate', banRateLabel: 'banRate' };

/** 픽 풀 표 정렬 (이름은 한글 가나다순). 값이 없는 행(미집계·계산 불가)은 방향과 무관하게 맨 아래 */
export function sortPoolRows(rows, fieldName, direction) {
    if (!fieldName) return rows;
    const key = SORT_KEYS[fieldName] || fieldName;
    const sign = direction === 'desc' ? -1 : 1;
    const valueOf = (r) => (key === 'tier' ? TIER_RANK[r.tier] : r[key]);
    return [...rows].sort((a, b) => {
        const x = valueOf(a);
        const y = valueOf(b);
        if (x == null || y == null) return (x == null) - (y == null);
        return sign * (typeof x === 'string' ? x.localeCompare(y, 'ko') : x - y);
    });
}
