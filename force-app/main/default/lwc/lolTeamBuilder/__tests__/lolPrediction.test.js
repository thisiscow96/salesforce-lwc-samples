import { normalizeData, searchPool, LANES, EXTENDED_POOL_SIZE } from '../lolScoring';
import { predict, probability, gaugeOption, laneKillOption, timelineOption, damageOption, pickStatsOption, MINUTES } from '../lolPrediction';

const { builderData } = require('./data/fixtures');

const ctx = normalizeData(builderData());
const pick = (id) => ctx.byId.get(id);
const team = (ids) => Object.fromEntries(LANES.map((lane, i) => [lane, pick(ids[i])]));

// 평균 상대와 같은 가상 챔피언 (모든 능력치 5)
const average = (lane) => ({ id: `Avg_${lane}`, key: `Avg${lane}`, name: '평균', lane, dmgType: 'Mixed', solo: 5, prio: 5, obj: 5, early: 5, late: 5, engage: 5, peel: 5, damage: 5, cc: 5, front: 5, carry: 5 });

describe('전체 픽 데이터', () => {
    it('라인별 전체 픽(260건 이상)과 팀 선호 픽 44개, 새 지표가 들어 있다', () => {
        expect(ctx.champions.length).toBeGreaterThanOrEqual(260);
        expect(ctx.champions.filter((c) => c.preferred)).toHaveLength(44);
        const malphiteMid = pick('Malphite_Mid');
        expect(malphiteMid).toMatchObject({ preferred: false, tier: 'S' });
        expect(malphiteMid.pickRate).toBeGreaterThan(0);
        expect(malphiteMid.banRate).toBeGreaterThan(0);
        ctx.champions.forEach((c) => {
            [c.solo, c.prio, c.obj].forEach((v) => expect(v).toBeGreaterThanOrEqual(0));
        });
        // 선택 목록·표는 라인마다 선호 픽이 먼저
        LANES.forEach((lane) => {
            const firstOther = ctx.byLane[lane].findIndex((c) => !c.preferred);
            expect(ctx.byLane[lane].slice(firstOther).every((c) => !c.preferred)).toBe(true);
        });
    });

    it('탐색 후보: 기본은 선호 픽, 확장은 메타 상위 + 선호 상위로 라인당 12명 이내', () => {
        LANES.forEach((lane) => {
            expect(searchPool(ctx, lane).every((c) => c.preferred)).toBe(true);
            const extended = searchPool(ctx, lane, 'extended');
            expect(extended.length).toBeGreaterThanOrEqual(EXTENDED_POOL_SIZE);
            expect(extended.length).toBeLessThanOrEqual(EXTENDED_POOL_SIZE + 4);
            expect(extended.some((c) => !c.preferred)).toBe(true);
        });
    });
});

// 배포하는 Static Resource 원본으로 option을 실제 렌더링해 "그려지는지"까지 검증
const echarts = require('../../../staticresources/echarts.js');
function renderSvg(option) {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 900, height: 260 });
    chart.setOption(option);
    const svg = chart.renderToSVGString();
    chart.dispose();
    return svg;
}

describe('조합 예측 차트 실제 렌더링', () => {
    const t = team(['Malphite_Top', 'Wukong_Jungle', 'Hwei_Mid', 'Jinx_Adc', 'Lulu_Support']);
    const p = predict(t);

    it('게이지 6개에 확률(%)과 이름이 그려진다', () => {
        const svg = renderSvg(gaugeOption(p.objectives));
        p.objectives.forEach((o) => {
            expect(svg).toContain(o.label);
            expect(svg).toContain(`${o.prob}%`);
        });
    });

    it('라인 킬 막대·시간대 곡선(파워 스파이크 표시)·딜 도넛·픽 통계가 그려진다', () => {
        const lanes = renderSvg(laneKillOption(p.lanes));
        p.lanes.forEach((l) => expect(lanes).toContain(l.label));
        const timeline = renderSvg(timelineOption(p.timeline, p.peak));
        expect(timeline).toContain('40분');
        expect(timeline).toContain(`${p.peak.prob}%`);
        expect(renderSvg(damageOption(p.damage))).toContain('마법(AP)');
        const picks = renderSvg(pickStatsOption(t));
        expect(picks).toContain('징크스');
        expect(picks).toContain(`${t.ADC.winRate}%`);
    });
});

describe('조합 예측', () => {
    it('평균 능력치면 50%, 높을수록 증가하고 10~90% 범위', () => {
        expect(probability(5)).toBeCloseTo(0.5);
        expect(probability(7)).toBeGreaterThan(0.7);
        expect(probability(10)).toBe(0.9);
        expect(probability(0)).toBe(0.1);
    });

    it('평균 상대와 같은 조합은 모든 지표가 50%', () => {
        const avgTeam = Object.fromEntries(LANES.map((lane) => [lane, average(lane)]));
        const p = predict(avgTeam);
        [...p.lanes, ...p.objectives].forEach((x) => expect(x.prob).toBe(50));
        expect(p.timeline.map((t) => t.prob)).toEqual(MINUTES.map(() => 50));
    });

    it('초반 조합은 초반 지표, 후반 조합은 후반 한타 우위가 높다', () => {
        const early = predict(team(['Renekton_Top', 'JarvanIV_Jungle', 'LeBlanc_Mid', 'Lucian_Adc', 'Karma_Support']));
        const late = predict(team(['Nasus_Top', 'Sejuani_Jungle', 'Aurora_Mid', 'Jinx_Adc', 'Lulu_Support']));
        const prob = (p, key) => p.objectives.find((o) => o.key === key).prob;
        expect(prob(early, 'FIRST_BLOOD')).toBeGreaterThan(prob(late, 'FIRST_BLOOD'));
        expect(early.lanes[0].prob).toBeGreaterThan(late.lanes[0].prob); // 레넥톤 > 나서스 솔킬
        expect(late.timeline.at(-1).prob).toBeGreaterThan(early.timeline.at(-1).prob);
        expect(late.peak.minute).toBeGreaterThan(early.peak.minute);
    });

    it('차트 옵션: 게이지 6개, 라인 4개, 시간축, 딜 합 100%, 실제 픽 통계', () => {
        const t = team(['Malphite_Top', 'Wukong_Jungle', 'Hwei_Mid', 'Jinx_Adc', 'Lulu_Support']);
        const p = predict(t);
        expect(gaugeOption(p.objectives).series).toHaveLength(6);
        expect(laneKillOption(p.lanes).yAxis.data).toEqual(['탑 솔킬', '정글 초반 교전', '미드 솔킬', '바텀 2:2 킬']);
        expect(timelineOption(p.timeline, p.peak).xAxis.data).toEqual(MINUTES);
        const dmg = damageOption(p.damage).series[0].data;
        expect(dmg[0].value + dmg[1].value).toBe(100);
        const picks = pickStatsOption(t);
        expect(picks.series[0].data.map((d) => d.value)).toEqual(LANES.map((lane) => t[lane].winRate));
        expect(picks.series[1].data).toEqual(LANES.map((lane) => t[lane].pickRate));
    });
});
