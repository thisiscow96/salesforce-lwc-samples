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

const CARRY_LANES = new Set(['MID', 'ADC']);
// 후반 지수 라인 가중치: 캐리 라인(미드·원딜) 중심
const LATE_WEIGHTS = { TOP: 0.15, JUNGLE: 0.1, MID: 0.3, ADC: 0.4, SUPPORT: 0.05 };
// 실력 적합도 라인 가중치
const SKILL_WEIGHTS = { TOP: 0.15, JUNGLE: 0.2, MID: 0.25, ADC: 0.25, SUPPORT: 0.15 };
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

const isTank = (c) => c.cls === 'Tank';
const isBruiser = (c) => c.cls === 'Bruiser' || c.cls === 'Skirmisher';
const label = (c) => `${c.name}(${CLASS_LABELS[c.cls] || c.cls})`;

/** 탑·정글 앞라인 구조: 1탱 + 1브루저가 목표 */
export function structureOf(top, jungle) {
    const pair = [top, jungle];
    const tanks = pair.filter(isTank).length;
    const bruisers = pair.filter(isBruiser).length;
    const desc = `탑 ${label(top)} + 정글 ${label(jungle)}`;
    if (tanks === 1 && bruisers === 1) return { ratio: 1, ok: true, detail: `${desc} → 1탱 1브루저 구조 충족` };
    if (tanks === 2) return { ratio: 0.5, ok: false, detail: `${desc} → 2탱 구조 (딜·스플릿 압박 부족)` };
    if (tanks === 1) return { ratio: 0.4, ok: false, detail: `${desc} → 탱커 1명, 브루저 없음` };
    if (bruisers === 2) return { ratio: 0.3, ok: false, detail: `${desc} → 탱커 없는 2브루저 (앞라인·CC 부족 위험)` };
    return { ratio: 0, ok: false, detail: `${desc} → 탱커·브루저 없음` };
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

/** 카테고리별 비율(0~1)과 설명 */
function ratios(team, skills, ctx) {
    const members = LANES.map((lane) => team[lane]);
    const sum = (fn) => members.reduce((acc, c) => acc + fn(c), 0);
    const top = team.TOP;
    const jungle = team.JUNGLE;

    const metaAvg = sum((c) => c.meta) / members.length;
    const late = LANES.reduce((acc, lane) => acc + LATE_WEIGHTS[lane] * team[lane].late, 0);
    const ccTopJg = top.cc + jungle.cc;
    const ccTeam = sum((c) => c.cc);
    const structure = structureOf(top, jungle);
    const damageTotal = sum((c) => c.damage) || 1;
    const apShare = sum((c) => c.damage * (AP_FACTOR[c.dmgType] ?? 0.5)) / damageTotal;
    const apDev = Math.abs(apShare - 0.45);
    const bestEngage = members.reduce((best, c) => (c.engage > best.engage ? c : best), members[0]);
    const peel = top.peel + jungle.peel + team.SUPPORT.peel;
    const synergies = synergiesOf(team, ctx);
    const synergyRaw = synergies.reduce((acc, s) => acc + s.score, 0);

    const laneFits = LANES.map((lane) => {
        const c = team[lane];
        const skill = skills[lane] ?? 5;
        const diffFit = clamp(1 - Math.max(0, c.diff - (skill + 1)) / 4);
        const roleFit = CARRY_LANES.has(lane) ? c.carry / 10 : (c.cc + c.peel + Math.max(c.front, c.engage)) / 30;
        return { lane, champion: c, skill, diffFit, roleFit, ratio: diffFit * (0.4 + 0.6 * roleFit) };
    });
    const skillRatio = laneFits.reduce((acc, f) => acc + SKILL_WEIGHTS[f.lane] * f.ratio, 0);

    return {
        META: { ratio: clamp((metaAvg - 4) / 6), detail: `메타 점수 평균 ${round1(metaAvg)} / 10`, metaAvg },
        LATE: { ratio: clamp(late / 10), detail: `후반 지수 ${round1(late)} / 10 (미드 ${team.MID.late}, 원딜 ${team.ADC.late})` },
        CC: {
            ratio: clamp((ccTopJg / 20) * (2 / 3) + clamp(ccTeam / 40) / 3),
            detail: `탑·정글 CC ${ccTopJg} / 20, 팀 전체 CC ${ccTeam}`,
            ccTopJg
        },
        STRUCTURE: { ratio: structure.ratio, detail: structure.detail, ok: structure.ok },
        BALANCE: {
            ratio: apDev <= 0.15 ? 1 : clamp(1 - (apDev - 0.15) / 0.3),
            detail: `딜 기준 AP ${Math.round(apShare * 100)}% / AD ${100 - Math.round(apShare * 100)}%`,
            apShare
        },
        TEAMFIGHT: {
            ratio: clamp((bestEngage.engage / 10) * 0.5 + (peel / 30) * 0.5),
            detail: `메인 이니시 ${bestEngage.name}(${bestEngage.engage}), 탑·정글·서폿 보호 ${peel} / 30`,
            engage: bestEngage.engage,
            peel
        },
        SYNERGY: {
            ratio: clamp(0.4 + synergyRaw * 0.05), // 중립 0.4, +1당 +0.05 (상위 조합끼리도 구분되도록 완만하게)
            detail: synergies.length ? `시너지 ${synergies.length}쌍, 합계 ${synergyRaw > 0 ? '+' : ''}${synergyRaw}` : '등록된 시너지 쌍 없음 (중립)',
            synergies,
            raw: synergyRaw
        },
        SKILL: {
            ratio: clamp(skillRatio),
            detail: laneFits.some((f) => f.diffFit < 1) ? '실력 대비 난이도가 높은 픽 있음' : '모든 라인이 실력에 맞는 난이도',
            laneFits
        }
    };
}

/** team: { TOP: champion, ... }, skills: { TOP: 6, ... } */
export function scoreTeam(team, skills, ctx) {
    const r = ratios(team, skills, ctx);
    const categories = ctx.weights.map((w) => {
        const item = r[w.key] || { ratio: 0, detail: '계산식 없음' };
        return { key: w.key, label: w.label, max: w.max, ratio: item.ratio, points: round1(item.ratio * w.max), detail: item.detail, description: w.description };
    });
    const total = round1(categories.reduce((acc, c) => acc + c.points, 0));
    return { team, total, grade: gradeOf(total), categories, raw: r, synergies: r.SYNERGY.synergies, structureOk: r.STRUCTURE.ok };
}

/** 강점 / 약점 / 운영 포인트 (규칙 기반 설명) */
export function explain(result) {
    const { team, raw, categories } = result;
    const strengths = [];
    const weaknesses = [];
    const byKey = Object.fromEntries(categories.map((c) => [c.key, c]));
    const members = LANES.map((lane) => team[lane]);

    if (raw.STRUCTURE.ok) strengths.push(`앞라인 구조: ${raw.STRUCTURE.detail}`);
    else weaknesses.push(`앞라인 구조: ${raw.STRUCTURE.detail}`);

    if (byKey.CC?.ratio >= 0.75) strengths.push(`CC: ${raw.CC.detail} → 탑·정글이 CC를 충분히 담당`);
    else if (byKey.CC?.ratio < 0.55) weaknesses.push(`CC: ${raw.CC.detail} → 이니시 후 묶어 둘 수단 부족`);

    if (byKey.LATE?.ratio >= 0.75) strengths.push(`후반: ${raw.LATE.detail} → 시간이 갈수록 유리`);
    else if (byKey.LATE?.ratio < 0.55) {
        const weak = members.filter((c) => c.late <= 5).map((c) => c.name);
        weaknesses.push(`후반: ${raw.LATE.detail}${weak.length ? ` → 후반 약한 픽: ${weak.join(', ')}` : ''}`);
    }

    if (byKey.BALANCE?.ratio >= 0.9) strengths.push(`딜 구성: ${raw.BALANCE.detail} → 상대가 한 종류 방어템으로 대응하기 어려움`);
    else if (byKey.BALANCE?.ratio < 0.6) weaknesses.push(`딜 구성: ${raw.BALANCE.detail} → 상대가 ${raw.BALANCE.apShare > 0.5 ? '마법 저항력' : '방어력'}만 올려도 딜 효율 하락`);

    if (byKey.TEAMFIGHT?.ratio >= 0.75) strengths.push(`한타: ${raw.TEAMFIGHT.detail}`);
    else if (raw.TEAMFIGHT.engage < 7) weaknesses.push(`한타: 확실한 이니시 수단 부족 (${raw.TEAMFIGHT.detail})`);
    else if (raw.TEAMFIGHT.peel < 15) weaknesses.push(`한타: 캐리 보호 부족 (${raw.TEAMFIGHT.detail}) → 다이브 조합에 취약`);

    raw.SYNERGY.synergies.filter((s) => s.score > 0).forEach((s) => strengths.push(`시너지 +${s.score}: ${s.nameA} + ${s.nameB} — ${s.reason}`));
    raw.SYNERGY.synergies.filter((s) => s.score < 0).forEach((s) => weaknesses.push(`상성 ${s.score}: ${s.nameA} + ${s.nameB} — ${s.reason}`));

    const lowMeta = members.filter((c) => c.meta <= 6);
    if (lowMeta.length) weaknesses.push(`메타: ${lowMeta.map((c) => `${c.name}(${c.tier === '-' ? '미집계' : c.tier})`).join(', ')} — 현재 패치 통계상 약세`);

    raw.SKILL.laneFits
        .filter((f) => f.diffFit < 1)
        .forEach((f) => weaknesses.push(`실력: ${LANE_LABELS[f.lane]} ${f.champion.name} 난이도 ${f.champion.diff} — 현재 숙련도(${f.skill}) 대비 어려운 픽`));

    const earlyAvg = members.reduce((acc, c) => acc + c.early, 0) / members.length;
    if (earlyAvg < 5) weaknesses.push(`초반: 초반 지수 ${round1(earlyAvg)} / 10 → 상대 초반 조합(인베·다이브)에 스노우볼을 허용할 위험`);
    const plan =
        earlyAvg < 5.5
            ? `초반 지수 ${round1(earlyAvg)} → 라인전은 버티고, 15분 이후 오브젝트(용·전령) 한타 중심으로 운영`
            : `초반 지수 ${round1(earlyAvg)} → 초반 주도권으로 정글 동선·오브젝트 선점, 스노우볼`;
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
 * locked: { lane: champion } 고정 라인, requireStructure: 탑·정글 1탱+1브루저만, poolMode: searchPool 참고
 */
export function findBestTeams(ctx, skills, { locked = {}, requireStructure = true, limit = 30, poolMode = 'preferred' } = {}) {
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
            // 탑·정글이 정해지면 바로 구조 검사 → 불필요한 하위 탐색 생략
            if (requireStructure && lane === 'JUNGLE' && !structureOf(team.TOP, c).ok) continue;
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
