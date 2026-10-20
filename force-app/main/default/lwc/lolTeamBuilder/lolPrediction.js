// 조합 대시보드 데이터·차트 (순수 함수: Jest로 단독 검증)
// 근거를 둘로 나눈다.
//   1) 실제 통계: lol.ps(한국 에메랄드+) 승률·픽률·밴률·PS 점수 → % 그대로 표시
//   2) 조합 성향 지수: 챔피언 능력치(0~10, 스킬 구성 기준 정성 평가)의 가중 평균 → "확률"이 아니라 평균 5 대비 지수로만 표시
//      지수마다 어떤 챔피언 값이 얼마나 들어갔는지(근거)를 함께 돌려줘 툴팁에 보여 준다.
import { LANES, LANE_LABELS } from './lolScoring';

export const COLORS = {
    blue: '#5383E8',
    blueLight: '#7FA4F4',
    red: '#E84057',
    gold: '#F4C874',
    teal: '#00BBA3',
    purple: '#9E6CF2',
    text: '#E5E7F0',
    muted: '#9E9EB1',
    grid: '#2E3350',
    card: '#1E2235',
    faint: '#4A5070'
};
export const MINUTES = [5, 10, 15, 20, 25, 30, 35, 40];
const LATE_WEIGHTS = { TOP: 0.15, JUNGLE: 0.1, MID: 0.3, ADC: 0.4, SUPPORT: 0.05 };
const AP_FACTOR = { AD: 0, AP: 1, Mixed: 0.5 };
const round1 = (v) => Math.round(v * 10) / 10;

/** 가중 평균 지수 + 근거 목록. parts: [[챔피언, 능력치 키, 가중치], ...] */
function weighted(parts, labels) {
    const totalWeight = parts.reduce((acc, [, , w]) => acc + w, 0);
    const value = parts.reduce((acc, [c, key, w]) => acc + c[key] * w, 0) / totalWeight;
    return {
        value: round1(value),
        basis: parts.map(([c, key, w]) => `${c.name} ${labels[key]} ${c[key]} × ${Math.round((w / totalWeight) * 100)}%`)
    };
}

const STAT_LABELS = {
    early: '초반',
    late: '후반',
    cc: 'CC',
    front: '앞라인',
    engage: '이니시',
    peel: '보호',
    damage: '딜',
    prio: '주도권',
    solo: '솔킬',
    obj: '오브젝트'
};

/** 조합 성향 지수 (0~10, 평균 5) */
export function teamProfile(team) {
    const { TOP: top, JUNGLE: jg, MID: mid, ADC: adc, SUPPORT: sup } = team;
    const all = LANES.map((lane) => team[lane]);
    const even = (key) => all.map((c) => [c, key, 1]);
    const axes = [
        { key: 'early', label: '초반 영향력', ...weighted(even('early'), STAT_LABELS) },
        { key: 'late', label: '후반 캐리', ...weighted(LANES.map((lane) => [team[lane], 'late', LATE_WEIGHTS[lane]]), STAT_LABELS) },
        { key: 'cc', label: 'CC', ...weighted(even('cc'), STAT_LABELS) },
        { key: 'front', label: '앞라인', ...weighted([[top, 'front', 2], [jg, 'front', 2], [sup, 'front', 1]], STAT_LABELS) },
        { key: 'engage', label: '이니시', ...weighted([[top, 'engage', 1], [jg, 'engage', 2], [mid, 'engage', 1], [sup, 'engage', 2]], STAT_LABELS) },
        { key: 'peel', label: '캐리 보호', ...weighted([[top, 'peel', 1], [jg, 'peel', 1], [sup, 'peel', 2]], STAT_LABELS) },
        { key: 'prio', label: '라인 주도권', ...weighted([[top, 'prio', 1], [mid, 'prio', 1], [adc, 'prio', 1]], STAT_LABELS) },
        { key: 'obj', label: '오브젝트 장악', ...weighted([[jg, 'obj', 3], [top, 'obj', 1], [mid, 'obj', 1], [adc, 'obj', 1]], STAT_LABELS) }
    ];
    return axes;
}

/** 라인전 킬 압박 지수 (0~10) */
export function laneIndex(team) {
    const { TOP: top, JUNGLE: jg, MID: mid, ADC: adc, SUPPORT: sup } = team;
    return [
        { key: 'TOP', label: '탑 솔킬 압박', ...weighted([[top, 'solo', 3], [top, 'early', 1]], STAT_LABELS) },
        { key: 'JUNGLE', label: '정글 초반 교전', ...weighted([[jg, 'early', 2], [jg, 'solo', 1], [jg, 'engage', 1]], STAT_LABELS) },
        { key: 'MID', label: '미드 솔킬 압박', ...weighted([[mid, 'solo', 3], [mid, 'early', 1]], STAT_LABELS) },
        { key: 'BOT', label: '바텀 2:2 압박', ...weighted([[adc, 'solo', 2], [adc, 'early', 1], [sup, 'engage', 2], [sup, 'early', 1]], STAT_LABELS) }
    ];
}

/** 오브젝트별 장악 지수 (0~10): 그 오브젝트에 영향을 주는 라인 주도권·정글 장악력 */
export function objectiveIndex(team) {
    const { TOP: top, JUNGLE: jg, MID: mid, ADC: adc, SUPPORT: sup } = team;
    return [
        { key: 'GRUBS', label: '공허 유충', ...weighted([[top, 'prio', 2], [mid, 'prio', 1], [jg, 'obj', 2], [jg, 'early', 1]], STAT_LABELS) },
        { key: 'DRAGON', label: '드래곤', ...weighted([[adc, 'prio', 2], [sup, 'engage', 1], [mid, 'prio', 1], [jg, 'obj', 2]], STAT_LABELS) },
        { key: 'HERALD', label: '협곡의 전령', ...weighted([[top, 'prio', 1], [mid, 'prio', 2], [jg, 'obj', 2]], STAT_LABELS) },
        { key: 'BARON', label: '바론', ...weighted([[jg, 'obj', 2], [top, 'engage', 1], [jg, 'engage', 1], [adc, 'late', 1], [mid, 'late', 1]], STAT_LABELS) }
    ];
}

/** 시간대별 전투력 지수: 각 챔피언의 초반력 → 후반력으로 옮겨 가는 곡선 (5분 = 초반값, 32분 이후 = 후반값) */
export function powerCurve(team) {
    const all = LANES.map((lane) => team[lane]);
    const points = MINUTES.map((minute) => {
        const f = Math.min(1, Math.max(0, (minute - 5) / 27));
        return { minute, value: round1(all.reduce((acc, c) => acc + c.early * (1 - f) + c.late * f, 0) / all.length) };
    });
    const peak = points.reduce((best, p) => (p.value > best.value ? p : best), points[0]);
    const style = peak.minute <= 15 ? '초반형' : peak.minute <= 25 ? '중반형' : '후반형';
    return { points, peak, style };
}

/** 실제 통계 요약 (lol.ps) */
export function realStats(team) {
    const picks = LANES.map((lane) => ({ lane, ...team[lane] }));
    const rated = picks.filter((c) => c.winRate != null);
    const avgWin = rated.length ? Math.round((rated.reduce((acc, c) => acc + c.winRate, 0) / rated.length) * 10) / 10 : null;
    return {
        picks,
        avgWin,
        honey: picks.filter((c) => c.honey).map((c) => c.name),
        bestPs: picks.filter((c) => c.psScore != null).sort((a, b) => b.psScore - a.psScore)[0] || null
    };
}

export function damageSplit(team) {
    const all = LANES.map((lane) => team[lane]);
    const total = all.reduce((acc, c) => acc + c.damage, 0) || 1;
    const ap = Math.round((all.reduce((acc, c) => acc + c.damage * (AP_FACTOR[c.dmgType] ?? 0.5), 0) / total) * 100);
    return { ap, ad: 100 - ap };
}

export function championIcon(version, ddId) {
    return version && ddId ? `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${ddId}.png` : null;
}

// ===================== ECharts option =====================
const text = (size = 11, color = COLORS.muted) => ({ color, fontSize: size });
const tooltip = { backgroundColor: '#11131F', borderColor: COLORS.grid, textStyle: { color: COLORS.text, fontSize: 12 }, extraCssText: 'border-radius:8px;' };
const basisHtml = (item) => `<b>${item.label} ${item.value} / 10</b><br/>${item.basis.join('<br/>')}`;
const gradient = (from, to, horizontal = false) => ({
    type: 'linear',
    x: 0,
    y: horizontal ? 0 : 1,
    x2: horizontal ? 1 : 0,
    y2: 0,
    colorStops: [
        { offset: 0, color: from },
        { offset: 1, color: to }
    ]
});
const indexColor = (v) => (v >= 6.5 ? gradient('#3B5FC0', COLORS.blueLight, true) : v >= 5 ? gradient('#8A6A2B', COLORS.gold, true) : gradient('#8E2336', COLORS.red, true));

/** 조합 성향: 레이더 (우리 조합 vs 평균 5) */
export function profileOption(axes) {
    return {
        tooltip: { ...tooltip, formatter: () => axes.map((a) => `${a.label} <b>${a.value}</b>`).join('<br/>') },
        legend: { bottom: 0, textStyle: text(11), data: ['우리 조합', '평균(5)'] },
        radar: {
            indicator: axes.map((a) => ({ name: a.label, max: 10 })),
            radius: '64%',
            center: ['50%', '48%'],
            splitNumber: 5,
            axisName: text(11, COLORS.text),
            splitLine: { lineStyle: { color: COLORS.grid } },
            splitArea: { areaStyle: { color: ['rgba(83,131,232,0.02)', 'rgba(83,131,232,0.06)'] } },
            axisLine: { lineStyle: { color: COLORS.grid } }
        },
        series: [
            {
                type: 'radar',
                data: [
                    {
                        name: '우리 조합',
                        value: axes.map((a) => a.value),
                        symbolSize: 6,
                        lineStyle: { width: 2, color: COLORS.blueLight },
                        itemStyle: { color: COLORS.blueLight },
                        areaStyle: { color: { type: 'radial', x: 0.5, y: 0.5, r: 0.6, colorStops: [{ offset: 0, color: 'rgba(127,164,244,0.15)' }, { offset: 1, color: 'rgba(83,131,232,0.55)' }] } },
                        label: { show: true, color: COLORS.text, fontSize: 10, formatter: (p) => p.value }
                    },
                    { name: '평균(5)', value: axes.map(() => 5), symbol: 'none', lineStyle: { type: 'dashed', color: COLORS.faint }, itemStyle: { color: COLORS.faint } }
                ]
            }
        ]
    };
}

/** 지수 가로 막대 (라인 압박·오브젝트 장악 공용): 둥근 막대 + 배경 트랙 + 평균 5 기준선 */
export function indexBarOption(items) {
    return {
        tooltip: { ...tooltip, trigger: 'item', formatter: (p) => basisHtml(items[p.dataIndex]) },
        grid: { left: 96, right: 44, top: 10, bottom: 22 },
        xAxis: { type: 'value', min: 0, max: 10, interval: 2.5, axisLabel: { ...text(10), formatter: (v) => (v === 5 ? '5 평균' : v) }, splitLine: { lineStyle: { color: COLORS.grid } } },
        yAxis: { type: 'category', inverse: true, data: items.map((i) => i.label), axisLabel: text(12, COLORS.text), axisLine: { show: false }, axisTick: { show: false } },
        series: [
            {
                type: 'bar',
                barWidth: 14,
                showBackground: true,
                backgroundStyle: { color: 'rgba(255,255,255,0.04)', borderRadius: 7 },
                data: items.map((i) => ({ value: i.value, itemStyle: { color: indexColor(i.value), borderRadius: 7 } })),
                label: { show: true, position: 'right', color: COLORS.text, fontWeight: 600, formatter: '{c}' },
                // 세로 기준선 라벨은 세로 글자로 돌아가 읽기 어려워 축 눈금("5 평균")으로 대신 표시
                markLine: { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: COLORS.faint, type: 'dashed' }, data: [{ xAxis: 5 }] }
            }
        ]
    };
}

/** 시간대별 전투력 지수: 구간 배경(초반·중반·후반) + 그라데이션 영역 + 정점 표시 */
export function powerOption(curve) {
    return {
        tooltip: { ...tooltip, trigger: 'axis', formatter: (items) => `${items[0].name}분 전투력 지수 <b>${items[0].value}</b> / 10<br/>(초반 능력치 → 후반 능력치로 옮겨 가는 가중 평균)` },
        grid: { left: 36, right: 16, top: 26, bottom: 26 },
        xAxis: { type: 'category', boundaryGap: false, data: curve.points.map((p) => p.minute), axisLabel: { ...text(10), formatter: '{value}분' }, axisLine: { lineStyle: { color: COLORS.grid } } },
        yAxis: { type: 'value', min: 0, max: 10, interval: 2.5, axisLabel: text(10), splitLine: { lineStyle: { color: COLORS.grid } } },
        series: [
            {
                type: 'line',
                smooth: 0.4,
                symbol: 'circle',
                symbolSize: 7,
                data: curve.points.map((p) => p.value),
                lineStyle: { width: 3, color: gradient(COLORS.gold, COLORS.blueLight, true) },
                itemStyle: { color: COLORS.blueLight, borderColor: '#11131F', borderWidth: 2 },
                areaStyle: { color: gradient('rgba(83,131,232,0.02)', 'rgba(83,131,232,0.45)') },
                markArea: {
                    silent: true,
                    label: { color: COLORS.muted, fontSize: 10, position: 'insideTop' },
                    data: [
                        [{ name: '초반', xAxis: '5', itemStyle: { color: 'rgba(244,200,116,0.05)' } }, { xAxis: '15' }],
                        [{ name: '중반', xAxis: '15', itemStyle: { color: 'rgba(255,255,255,0.02)' } }, { xAxis: '25' }],
                        [{ name: '후반', xAxis: '25', itemStyle: { color: 'rgba(83,131,232,0.06)' } }, { xAxis: '40' }]
                    ]
                },
                markLine: { symbol: 'none', silent: true, label: { color: COLORS.muted, formatter: '평균 5', position: 'insideEndBottom' }, lineStyle: { color: COLORS.faint, type: 'dashed' }, data: [{ yAxis: 5 }] },
                markPoint: {
                    symbol: 'roundRect',
                    symbolSize: [62, 22],
                    symbolOffset: [0, -18],
                    itemStyle: { color: COLORS.gold },
                    label: { color: '#1E2235', fontWeight: 700, fontSize: 11, formatter: () => `정점 ${curve.peak.value}` },
                    data: [{ coord: [String(curve.peak.minute), curve.peak.value] }]
                }
            }
        ]
    };
}

/** 딜 구성 도넛 (가운데 요약 텍스트) */
export function damageOption(damage) {
    const main = damage.ap >= damage.ad ? `마법 ${damage.ap}%` : `물리 ${damage.ad}%`;
    return {
        tooltip: { ...tooltip, formatter: '{b}: {c}%' },
        title: { text: main, subtext: '딜 비중', left: 'center', top: '40%', textStyle: { color: COLORS.text, fontSize: 18, fontWeight: 700 }, subtextStyle: text(11) },
        series: [
            {
                type: 'pie',
                radius: ['58%', '80%'],
                center: ['50%', '50%'],
                padAngle: 3,
                itemStyle: { borderRadius: 8 },
                label: { show: false },
                data: [
                    { name: '물리(AD)', value: damage.ad, itemStyle: { color: gradient('#8E2336', COLORS.red) } },
                    { name: '마법(AP)', value: damage.ap, itemStyle: { color: gradient('#3B5FC0', COLORS.blueLight) } }
                ]
            }
        ]
    };
}

/**
 * 실제 통계: 라인별 전체 픽의 승률(y)·픽률(x, 로그) 분포 위에 우리 5픽을 챔피언 아이콘으로 표시.
 * 아이콘을 못 불러오면(이미지 차단 등) 같은 위치에 원과 이름이 남도록 이름 라벨을 함께 그린다.
 */
export function metaScatterOption(ctx, team, version) {
    const ours = new Set(LANES.map((lane) => team[lane].id));
    const others = ctx.champions.filter((c) => !ours.has(c.id) && c.winRate != null && c.pickRate);
    const picks = LANES.map((lane) => team[lane]).filter((c) => c.winRate != null && c.pickRate);
    // 승률 축: 실제 데이터 범위에 맞춰 2%p 단위로 (극단값이 잘리지 않게)
    const rates = [...others, ...picks].map((c) => c.winRate);
    const yMin = Math.floor((Math.min(50, ...rates) - 0.5) / 2) * 2;
    const yMax = Math.ceil((Math.max(50, ...rates) + 0.5) / 2) * 2;
    return {
        tooltip: {
            ...tooltip,
            formatter: (p) => {
                const c = p.data.champ;
                return `<b>${c.name}</b> (${LANE_LABELS[c.lane]})<br/>승률 ${c.winRate}% · 픽률 ${c.pickRate}% · 밴률 ${c.banRate ?? '-'}%${c.psScore != null ? `<br/>PS 점수 ${c.psScore}` : ''}${c.honey ? ' · 꿀챔' : ''}`;
            }
        },
        grid: { left: 44, right: 20, top: 16, bottom: 34 },
        xAxis: { type: 'log', logBase: 10, min: 0.1, max: 40, name: '픽률(%)', nameLocation: 'middle', nameGap: 22, nameTextStyle: text(10), axisLabel: text(10), splitLine: { lineStyle: { color: COLORS.grid } } },
        yAxis: { type: 'value', min: yMin, max: yMax, interval: 2, axisLabel: { ...text(10), formatter: '{value}%' }, splitLine: { lineStyle: { color: COLORS.grid } } },
        series: [
            {
                name: '전체 픽',
                type: 'scatter',
                symbolSize: 6,
                itemStyle: { color: 'rgba(158,158,177,0.28)' },
                data: others.map((c) => ({ value: [c.pickRate, c.winRate], champ: c })),
                markLine: { symbol: 'none', silent: true, label: { color: COLORS.muted, formatter: '승률 50%', position: 'insideEndTop' }, lineStyle: { color: COLORS.faint, type: 'dashed' }, data: [{ yAxis: 50 }] }
            },
            {
                name: '우리 조합',
                type: 'scatter',
                z: 3,
                symbolSize: 34,
                data: picks.map((c, i) => {
                    const icon = championIcon(version, c.ddId);
                    // 앞선 픽과 가까우면(픽률 로그 거리·승률 차이가 작으면) 이름을 아이콘 위로 올려 겹치지 않게
                    const near = picks.slice(0, i).some((o) => Math.abs(Math.log10(o.pickRate) - Math.log10(c.pickRate)) < 0.15 && Math.abs(o.winRate - c.winRate) < 1.5);
                    return {
                        value: [c.pickRate, c.winRate],
                        champ: c,
                        symbol: icon ? `image://${icon}` : 'circle',
                        itemStyle: icon ? undefined : { color: COLORS.blue },
                        label: { show: true, position: near ? 'top' : 'bottom', distance: 4, color: COLORS.text, fontSize: 11, fontWeight: 600, formatter: c.name }
                    };
                })
            }
        ]
    };
}
