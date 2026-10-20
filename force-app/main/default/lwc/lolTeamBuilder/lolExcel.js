// 조합 분석 결과 → Excel 워크북 (SheetJS 객체를 주입받아 Jest에서 실제 라이브러리로 검증)
import { LANES, LANE_LABELS, CLASS_LABELS } from './lolScoring';

const POOL_HEADER = [
    '라인', '팀 선호', '챔피언', '영문', '역할군', '딜 타입', '메타 티어', '승률(%)', '픽률(%)', '밴률(%)', 'PS 점수', '꿀챔', '메타 점수',
    'CC', '앞라인', '딜', '후반', '초반', '이니시', '보호', '캐리', '난이도', '솔킬', '주도권', '오브젝트', '특징', '통계 출처'
];

function sheet(XLSX, rows, widths) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = widths.map((wch) => ({ wch }));
    return ws;
}

function poolRows(ctx) {
    return [
        POOL_HEADER,
        ...LANES.flatMap((lane) =>
            ctx.byLane[lane].map((c) => [
                LANE_LABELS[lane], c.preferred ? '★' : '', c.name, c.en, CLASS_LABELS[c.cls] || c.cls, c.dmgType, c.tier, c.winRate ?? '', c.pickRate ?? '',
                c.banRate ?? '', c.psScore ?? '', c.honey ? '꿀챔' : '', c.meta,
                c.cc, c.front, c.damage, c.late, c.early, c.engage, c.peel, c.carry, c.diff, c.solo, c.prio, c.obj, c.note || '', c.source || ''
            ])
        )
    ];
}

function comboRows(teams, weights) {
    return [
        ['순위', ...LANES.map((l) => LANE_LABELS[l]), '총점', '등급', ...weights.map((w) => `${w.label}(${w.max})`), '주요 시너지'],
        ...teams.map((t, i) => [
            i + 1,
            ...LANES.map((l) => t.team[l].name),
            t.total,
            t.grade,
            ...t.categories.map((c) => c.points),
            t.synergies
                .filter((s) => s.score > 0)
                .slice(0, 3)
                .map((s) => `${s.nameA}+${s.nameB}`)
                .join(', ')
        ])
    ];
}

function analysisRows(current, explanation, swaps, tierLabels) {
    return [
        ['현재 조합 분석'],
        [],
        ['라인', '챔피언', '역할군', '플레이어 실력'],
        ...LANES.map((l) => [LANE_LABELS[l], current.team[l].name, CLASS_LABELS[current.team[l].cls], tierLabels[l] || '']),
        [],
        ['총점', current.total, '등급', current.grade],
        [],
        ['항목', '점수', '배점', '근거'],
        ...current.categories.map((c) => [c.label, c.points, c.max, c.detail]),
        [],
        ['강점'],
        ...explanation.strengths.map((s) => ['', s]),
        [],
        ['약점'],
        ...(explanation.weaknesses.length ? explanation.weaknesses.map((s) => ['', s]) : [['', '두드러진 약점 없음']]),
        [],
        ['운영 플랜', explanation.plan],
        [],
        ['점수를 올리는 교체 후보'],
        ...(swaps.length ? swaps.map((s) => ['', `${LANE_LABELS[s.lane]} ${s.from.name} → ${s.to.name}`, `+${s.delta}`]) : [['', '현재 후보 풀 안에서 더 높은 단일 교체 없음']])
    ];
}

function criteriaRows(ctx, teamGoal) {
    return [
        ['점수 기준 (합계 100)'],
        ['항목', '배점', '계산 방식'],
        ...ctx.weights.map((w) => [w.label, w.max, w.description || '']),
        [],
        ['등급', 'S ≥ 85, A ≥ 75, B ≥ 65, C ≥ 55, 그 외 D'],
        [],
        ['티어', '숙련도(1~10)'],
        ...ctx.tiers.map((t) => [t.label, t.skill]),
        [],
        ['팀 목표', teamGoal || ''],
        [],
        ['통계 출처', 'lol.ps (프로관전러 P.S) 한국 서버 · 에메랄드+ · Patch 26.20 (1순위) https://lol.ps/statistics / lol.ps에 없는 라인 항목만 MOBA Trainer(Emerald+, u.gg·op.gg 병합) 보충'],
        ['챔피언 정보', 'Riot Data Dragon 16.20.1 (ko_KR)'],
        ['능력치·시너지', 'CC·앞라인·솔킬·주도권·오브젝트 등 0~10은 스킬 구성 기준 정성 평가 (공식 통계 아님)'],
        ['이 자리 점수', '현재 조합에서 그 라인만 바꿨을 때의 팀 조합 총점(100점). 개인 성능은 PS 점수·티어로 판단'],
        ['수정 방법', 'Setup > Custom Metadata Types > LoL Champion / LoL Synergy / LoL Score Weight에서 값 수정 시 즉시 반영']
    ];
}

function synergyRows(ctx) {
    const nameOf = (key) => ctx.champions.find((c) => c.key === key)?.name || key;
    return [
        ['챔피언 A', '챔피언 B', '점수', '근거'],
        ...[...ctx.synergies.values()].sort((a, b) => b.score - a.score).map((s) => [nameOf(s.a), nameOf(s.b), s.score, s.reason])
    ];
}

/** 시트: 라인별 픽 / 조합 점수 / 현재 조합 분석 / 점수 기준 / 시너지 표 */
export function buildWorkbook(XLSX, { ctx, teams, current, explanation, swaps, tierLabels = {}, teamGoal }) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet(XLSX, poolRows(ctx), [6, 7, 10, 12, 10, 8, 9, 8, 8, 8, 8, 6, 9, 5, 7, 5, 5, 5, 7, 5, 5, 7, 5, 7, 8, 50, 28]), '라인별 픽');
    XLSX.utils.book_append_sheet(wb, sheet(XLSX, comboRows(teams, ctx.weights), [6, 10, 10, 10, 10, 10, 7, 6, ...ctx.weights.map(() => 12), 40]), '조합 점수');
    if (current) {
        XLSX.utils.book_append_sheet(wb, sheet(XLSX, analysisRows(current, explanation, swaps, tierLabels), [16, 70, 12, 14]), '현재 조합 분석');
    }
    XLSX.utils.book_append_sheet(wb, sheet(XLSX, criteriaRows(ctx, teamGoal), [16, 12, 80]), '점수 기준');
    XLSX.utils.book_append_sheet(wb, sheet(XLSX, synergyRows(ctx), [12, 12, 6, 60]), '시너지 표');
    return wb;
}
