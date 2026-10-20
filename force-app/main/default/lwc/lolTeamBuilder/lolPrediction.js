// 조합 예측 지표 (순수 함수: Jest로 단독 검증)
// 실제 경기 통계가 아니라 챔피언 능력치(0~10)로 계산한 자체 모델 추정치다.
// 기준: 모든 능력치가 5인 "평균 상대"와 붙었을 때 50%. 능력치 지수 x를 로지스틱 함수로 확률화한다.
import { LANES, LANE_LABELS } from './lolScoring';

const K = 0.55; // 지수 1점 차이가 확률에 주는 영향 (x=7 → 약 75%)
const MIN_P = 0.1;
const MAX_P = 0.9;
export const MINUTES = [3, 6, 9, 12, 15, 20, 25, 30, 35, 40];
const LATE_WEIGHTS = { TOP: 0.15, JUNGLE: 0.1, MID: 0.3, ADC: 0.4, SUPPORT: 0.05 };
const AP_FACTOR = { AD: 0, AP: 1, Mixed: 0.5 };

// 화면 색 (op.gg류 다크 대시보드 톤)
export const COLORS = { blue: '#5383E8', red: '#E84057', gold: '#F4C874', teal: '#00BBA3', purple: '#9E6CF2', text: '#E5E7F0', muted: '#9E9EB1', grid: '#3A3F55', card: '#1E2235' };

export function probability(x) {
    const p = 1 / (1 + Math.exp(-K * (x - 5)));
    return Math.min(MAX_P, Math.max(MIN_P, p));
}
const pct = (p) => Math.round(p * 100);
const avg = (...values) => values.reduce((a, b) => a + b, 0) / values.length;

/** team: { TOP: champion, ... } (normalizeData 결과의 챔피언) */
export function predict(team) {
    const { TOP: top, JUNGLE: jg, MID: mid, ADC: adc, SUPPORT: sup } = team;
    const members = LANES.map((lane) => team[lane]);
    const botPrio = 0.5 * adc.prio + 0.25 * adc.early + 0.25 * sup.early;
    const topPrio = 0.6 * top.prio + 0.4 * top.early;
    const maxEngage = Math.max(...members.map((c) => c.engage));
    const teamfight = 0.5 * maxEngage + 0.5 * avg(top.peel, jg.peel, sup.peel);
    const lateIndex = LANES.reduce((acc, lane) => acc + LATE_WEIGHTS[lane] * team[lane].late, 0);

    // 라인별 초반 솔킬(바텀은 2:2 킬, 정글은 초반 교전·카정) 확률
    const lanes = [
        { lane: 'TOP', label: '탑 솔킬', x: 0.55 * top.solo + 0.25 * top.early + 0.2 * top.damage, who: top.name },
        { lane: 'JUNGLE', label: '정글 초반 교전', x: 0.4 * jg.early + 0.3 * jg.solo + 0.3 * jg.engage, who: jg.name },
        { lane: 'MID', label: '미드 솔킬', x: 0.55 * mid.solo + 0.25 * mid.early + 0.2 * mid.damage, who: mid.name },
        { lane: 'BOT', label: '바텀 2:2 킬', x: 0.35 * adc.solo + 0.2 * adc.early + 0.25 * sup.engage + 0.2 * sup.early, who: `${adc.name}·${sup.name}` }
    ].map((l) => ({ ...l, prob: pct(probability(l.x)) }));

    // 오브젝트·초반 이벤트 선점 확률
    const objectives = [
        {
            key: 'FIRST_BLOOD',
            label: '퍼스트 블러드',
            x: 0.3 * jg.early + 0.2 * jg.engage + 0.2 * Math.max(top.solo, mid.solo) + 0.15 * sup.engage + 0.15 * avg(top.early, mid.early, adc.early),
            basis: '정글 초반력·갱 + 라인 솔킬 + 서폿 이니시'
        },
        { key: 'GRUBS', label: '공허 유충', x: 0.3 * topPrio + 0.15 * mid.prio + 0.35 * jg.obj + 0.2 * jg.early, basis: '탑·미드 주도권 + 정글 오브젝트 장악' },
        { key: 'DRAGON', label: '첫 드래곤', x: 0.3 * botPrio + 0.2 * mid.prio + 0.3 * jg.obj + 0.2 * jg.early, basis: '바텀·미드 주도권 + 정글 오브젝트 장악' },
        {
            key: 'HERALD',
            label: '협곡의 전령',
            x: 0.2 * top.prio + 0.25 * mid.prio + 0.3 * jg.obj + 0.25 * avg(...members.map((c) => (c.early + c.late) / 2)),
            basis: '탑·미드 주도권 + 정글 + 중반 전투력'
        },
        { key: 'FIRST_TOWER', label: '첫 포탑', x: 0.3 * botPrio + 0.25 * top.prio + 0.25 * mid.prio + 0.2 * avg(adc.obj, mid.obj), basis: '라인 주도권 + 공성력' },
        { key: 'BARON', label: '첫 바론', x: 0.3 * jg.obj + 0.25 * teamfight + 0.25 * lateIndex + 0.2 * avg(...members.map((c) => c.damage)), basis: '정글 강타 싸움 + 한타 + 후반 캐리' }
    ].map((o) => ({ ...o, prob: pct(probability(o.x)) }));

    // 시간대별 한타 우위: 초반력 → 후반력으로 옮겨 가는 곡선 + 14분 이후 이니시·보호 보정
    const timeline = MINUTES.map((minute) => {
        const f = Math.min(1, Math.max(0, (minute - 8) / 24));
        const power = avg(...members.map((c) => c.early * (1 - f) + c.late * f));
        const fight = minute >= 14 ? 0.2 * (teamfight - 5) : 0.1 * (teamfight - 5);
        return { minute, prob: pct(probability(power + fight)) };
    });
    const peak = timeline.reduce((best, t) => (t.prob > best.prob ? t : best), timeline[0]);

    const damageTotal = members.reduce((acc, c) => acc + c.damage, 0) || 1;
    const apShare = members.reduce((acc, c) => acc + c.damage * (AP_FACTOR[c.dmgType] ?? 0.5), 0) / damageTotal;

    return { lanes, objectives, timeline, peak, damage: { ap: pct(apShare), ad: 100 - pct(apShare) } };
}

// ===== ECharts option (다크 카드 위에 그림) =====
const baseText = { color: COLORS.muted, fontSize: 11 };
const tooltip = { backgroundColor: '#11131F', borderColor: COLORS.grid, textStyle: { color: COLORS.text, fontSize: 12 } };
const probColor = (p) => (p >= 60 ? COLORS.blue : p >= 45 ? COLORS.gold : COLORS.red);

/** 오브젝트 선점 확률: 진행 링 게이지 6개 */
export function gaugeOption(objectives) {
    const cols = objectives.length;
    return {
        tooltip: { ...tooltip, formatter: '{a}<br/>{c}%' },
        series: objectives.map((o, i) => ({
            name: `${o.label} — ${o.basis}`,
            type: 'gauge',
            center: [`${((i + 0.5) / cols) * 100}%`, '48%'],
            radius: '62%',
            startAngle: 90,
            endAngle: -270,
            min: 0,
            max: 100,
            pointer: { show: false },
            progress: { show: true, roundCap: true, width: 9, itemStyle: { color: probColor(o.prob) } },
            axisLine: { lineStyle: { width: 9, color: [[1, COLORS.grid]] } },
            splitLine: { show: false },
            axisTick: { show: false },
            axisLabel: { show: false },
            title: { show: true, offsetCenter: [0, '128%'], color: COLORS.text, fontSize: 12, fontWeight: 600 },
            detail: { valueAnimation: true, offsetCenter: [0, 0], fontSize: 20, fontWeight: 700, color: COLORS.text, formatter: '{value}%' },
            data: [{ value: o.prob, name: o.label }]
        }))
    };
}

/** 라인별 초반 킬 확률: 가로 막대 + 50% 기준선 */
export function laneKillOption(lanes) {
    return {
        tooltip: { ...tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (items) => `${items[0].name}<br/>${lanes[items[0].dataIndex].who}: ${items[0].value}%` },
        grid: { left: 92, right: 40, top: 8, bottom: 24 },
        xAxis: { type: 'value', min: 0, max: 100, axisLabel: { ...baseText, formatter: '{value}%' }, splitLine: { lineStyle: { color: COLORS.grid } } },
        yAxis: { type: 'category', inverse: true, data: lanes.map((l) => l.label), axisLabel: { ...baseText, color: COLORS.text }, axisLine: { show: false }, axisTick: { show: false } },
        series: [
            {
                type: 'bar',
                barWidth: 14,
                data: lanes.map((l) => ({ value: l.prob, itemStyle: { color: probColor(l.prob), borderRadius: [0, 7, 7, 0] } })),
                label: { show: true, position: 'right', color: COLORS.text, formatter: '{c}%' },
                markLine: { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: COLORS.muted, type: 'dashed' }, data: [{ xAxis: 50 }] }
            }
        ]
    };
}

/** 시간대별 한타 우위 곡선 */
export function timelineOption(timeline, peak) {
    return {
        tooltip: { ...tooltip, trigger: 'axis', formatter: (items) => `${items[0].name}분<br/>한타 우위 ${items[0].value}%` },
        grid: { left: 40, right: 16, top: 16, bottom: 28 },
        xAxis: { type: 'category', boundaryGap: false, data: timeline.map((t) => t.minute), axisLabel: { ...baseText, formatter: '{value}분' }, axisLine: { lineStyle: { color: COLORS.grid } } },
        yAxis: { type: 'value', min: 0, max: 100, axisLabel: { ...baseText, formatter: '{value}%' }, splitLine: { lineStyle: { color: COLORS.grid } } },
        series: [
            {
                type: 'line',
                smooth: true,
                symbolSize: 6,
                data: timeline.map((t) => t.prob),
                lineStyle: { width: 3, color: COLORS.blue },
                itemStyle: { color: COLORS.blue },
                areaStyle: {
                    color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(83,131,232,0.45)' }, { offset: 1, color: 'rgba(83,131,232,0.02)' }] }
                },
                markLine: { symbol: 'none', silent: true, label: { color: COLORS.muted, position: 'insideStartTop', formatter: '평균 50%' }, lineStyle: { color: COLORS.muted, type: 'dashed' }, data: [{ yAxis: 50 }] },
                markPoint: {
                    symbol: 'pin',
                    symbolSize: 44,
                    itemStyle: { color: COLORS.gold },
                    label: { color: '#1E2235', fontWeight: 700, formatter: '{c}%' },
                    data: [{ name: '파워 스파이크', coord: [String(peak.minute), peak.prob], value: peak.prob }]
                }
            }
        ]
    };
}

/** 딜 구성 도넛 */
export function damageOption(damage) {
    return {
        tooltip: { ...tooltip, formatter: '{b}: {c}%' },
        series: [
            {
                type: 'pie',
                radius: ['55%', '80%'],
                center: ['50%', '50%'],
                avoidLabelOverlap: true,
                itemStyle: { borderColor: COLORS.card, borderWidth: 3 },
                label: { color: COLORS.text, formatter: '{b}\n{c}%', fontSize: 12 },
                data: [
                    { name: '물리(AD)', value: damage.ad, itemStyle: { color: COLORS.red } },
                    { name: '마법(AP)', value: damage.ap, itemStyle: { color: COLORS.blue } }
                ]
            }
        ]
    };
}

/** 선택한 픽의 실제 패치 통계 (승률 막대 + 픽률·밴률 점) */
export function pickStatsOption(team) {
    const members = LANES.map((lane) => team[lane]);
    const names = LANES.map((lane) => `${LANE_LABELS[lane]}\n${team[lane].name}`);
    return {
        tooltip: { ...tooltip, trigger: 'axis' },
        legend: { top: 0, textStyle: baseText, data: ['승률', '픽률', '밴률'] },
        grid: { left: 44, right: 44, top: 28, bottom: 40 },
        xAxis: { type: 'category', data: names, axisLabel: { ...baseText, color: COLORS.text, lineHeight: 15 }, axisLine: { lineStyle: { color: COLORS.grid } } },
        yAxis: [
            { type: 'value', min: 44, max: 58, interval: 2, axisLabel: { ...baseText, formatter: '{value}%' }, splitLine: { lineStyle: { color: COLORS.grid } } },
            { type: 'value', min: 0, axisLabel: { ...baseText, formatter: '{value}%' }, splitLine: { show: false } }
        ],
        series: [
            {
                name: '승률',
                type: 'bar',
                barWidth: 22,
                data: members.map((c) => ({ value: c.winRate ?? null, itemStyle: { color: (c.winRate ?? 50) >= 50 ? COLORS.blue : COLORS.red, borderRadius: [6, 6, 0, 0] } })),
                label: { show: true, position: 'top', color: COLORS.text, formatter: (p) => (p.value == null ? '미집계' : `${p.value}%`) },
                markLine: { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: COLORS.muted, type: 'dashed' }, data: [{ yAxis: 50 }] }
            },
            { name: '픽률', type: 'line', yAxisIndex: 1, symbolSize: 9, lineStyle: { opacity: 0 }, itemStyle: { color: COLORS.gold }, data: members.map((c) => c.pickRate ?? null) },
            { name: '밴률', type: 'line', yAxisIndex: 1, symbolSize: 9, symbol: 'diamond', lineStyle: { opacity: 0 }, itemStyle: { color: COLORS.purple }, data: members.map((c) => c.banRate ?? null) }
        ]
    };
}
