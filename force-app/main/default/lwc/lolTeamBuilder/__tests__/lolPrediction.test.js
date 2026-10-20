import { normalizeData, searchPool, LANES, EXTENDED_POOL_SIZE } from '../lolScoring';
import {
    teamProfile,
    laneIndex,
    objectiveIndex,
    powerCurve,
    realStats,
    damageSplit,
    championIcon,
    profileOption,
    indexBarOption,
    powerOption,
    damageOption,
    metaScatterOption,
    MINUTES
} from '../lolPrediction';

const { builderData } = require('./data/fixtures');

const ctx = normalizeData(builderData());
const pick = (id) => ctx.byId.get(id);
const team = (ids) => Object.fromEntries(LANES.map((lane, i) => [lane, pick(ids[i])]));

// 모든 능력치가 5인 가상 챔피언 (지수 기준점 검증용)
const average = (lane) => ({ id: `Avg_${lane}`, key: `Avg${lane}`, name: '평균', lane, dmgType: 'Mixed', solo: 5, prio: 5, obj: 5, early: 5, late: 5, engage: 5, peel: 5, damage: 5, cc: 5, front: 5, carry: 5 });

describe('전체 픽 데이터', () => {
    it('라인별 전체 픽(280건 이상, lol.ps 우선)과 팀 선호 픽 44개, 새 지표가 들어 있다', () => {
        expect(ctx.champions.length).toBeGreaterThanOrEqual(280);
        expect(ctx.champions.filter((c) => c.preferred)).toHaveLength(44);
        const malphiteMid = pick('Malphite_Mid');
        expect(malphiteMid).toMatchObject({ preferred: false, riotKey: 54, ddId: 'Malphite' });
        expect(malphiteMid.source).toContain('lol.ps'); // 1순위 출처: 프로관전러 lol.ps
        expect(malphiteMid.psScore).toBeGreaterThan(0);
        expect(pick('Malphite_Top').honey).toBe(true);
        expect(pick('Wukong_Jungle').ddId).toBe('MonkeyKing'); // 아이콘 주소는 Data Dragon id 사용
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

describe('조합 대시보드 지수 (확률이 아닌 0~10 지수)', () => {
    it('능력치가 모두 5면 모든 지수가 5이고, 근거에 챔피언·능력치·반영 비율이 들어간다', () => {
        const avgTeam = Object.fromEntries(LANES.map((lane) => [lane, average(lane)]));
        [...teamProfile(avgTeam), ...laneIndex(avgTeam), ...objectiveIndex(avgTeam)].forEach((x) => expect(x.value).toBe(5));
        expect(powerCurve(avgTeam).points.map((p) => p.value)).toEqual(MINUTES.map(() => 5));
        const dragon = objectiveIndex(team(['Malphite_Top', 'Wukong_Jungle', 'Hwei_Mid', 'Jinx_Adc', 'Lulu_Support'])).find((o) => o.key === 'DRAGON');
        expect(dragon.basis.join(' ')).toMatch(/징크스 주도권 \d+ × \d+%/);
        expect(dragon.value).toBeGreaterThanOrEqual(0);
        expect(dragon.value).toBeLessThanOrEqual(10);
    });

    it('초반 조합은 초반 지수·라인 압박이 높고, 후반 조합은 후반형으로 분류된다', () => {
        const early = team(['Renekton_Top', 'JarvanIV_Jungle', 'LeBlanc_Mid', 'Lucian_Adc', 'Karma_Support']);
        const late = team(['Nasus_Top', 'Sejuani_Jungle', 'Aurora_Mid', 'Jinx_Adc', 'Lulu_Support']);
        const axis = (t, key) => teamProfile(t).find((a) => a.key === key).value;
        expect(axis(early, 'early')).toBeGreaterThan(axis(late, 'early'));
        expect(axis(late, 'late')).toBeGreaterThan(axis(early, 'late'));
        expect(laneIndex(early)[0].value).toBeGreaterThan(laneIndex(late)[0].value); // 레넥톤 > 나서스
        expect(powerCurve(early).style).toBe('초반형');
        expect(powerCurve(late).style).toBe('후반형');
    });

    it('실제 통계는 lol.ps 값을 그대로 쓴다 (5픽 평균 승률, 꿀챔, 최고 PS 점수)', () => {
        const t = team(['Malphite_Top', 'Wukong_Jungle', 'Hwei_Mid', 'Jinx_Adc', 'Lulu_Support']);
        const s = realStats(t);
        const expected = Math.round((LANES.reduce((acc, lane) => acc + t[lane].winRate, 0) / 5) * 10) / 10;
        expect(s.avgWin).toBe(expected);
        expect(s.honey).toContain('말파이트');
        expect(s.bestPs.psScore).toBe(Math.max(...LANES.map((lane) => t[lane].psScore ?? 0)));
        const dmg = damageSplit(t);
        expect(dmg.ad + dmg.ap).toBe(100);
        expect(championIcon('16.20.1', 'MonkeyKing')).toBe('https://ddragon.leagueoflegends.com/cdn/16.20.1/img/champion/MonkeyKing.png');
        expect(championIcon(null, 'Jinx')).toBeNull();
    });
});

// 배포하는 Static Resource 원본으로 option을 실제 렌더링해 "그려지는지"까지 검증
const echarts = require('../../../staticresources/echarts.js');
function renderSvg(option, width = 900, height = 300) {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
    chart.setOption(option);
    const svg = chart.renderToSVGString();
    chart.dispose();
    return svg;
}

describe('조합 대시보드 차트 실제 렌더링', () => {
    const t = team(['Malphite_Top', 'Wukong_Jungle', 'Hwei_Mid', 'Jinx_Adc', 'Lulu_Support']);

    it('승률·픽률 분포: 전체 픽 점 + 우리 5픽 아이콘(이름 라벨)이 그려지고, 축이 실제 승률 범위를 덮는다', () => {
        const option = metaScatterOption(ctx, t, '16.20.1');
        const rates = ctx.champions.filter((c) => c.winRate != null).map((c) => c.winRate);
        expect(option.yAxis.min).toBeLessThanOrEqual(Math.min(...rates));
        expect(option.yAxis.max).toBeGreaterThanOrEqual(Math.max(...rates));
        expect(option.series[1].data[0].symbol).toBe('image://https://ddragon.leagueoflegends.com/cdn/16.20.1/img/champion/Malphite.png');
        const svg = renderSvg(option);
        ['말파이트', '오공', '흐웨이', '징크스', '룰루'].forEach((name) => expect(svg).toContain(name));
        expect(svg).toContain('ddragon.leagueoflegends.com');
        // 버전이 없으면 아이콘 대신 원
        expect(metaScatterOption(ctx, t, null).series[1].data[0].symbol).toBe('circle');
    });

    it('성향 레이더·지수 막대·전투력 곡선·딜 도넛이 그려진다 (확률 % 표기 없음)', () => {
        const profile = renderSvg(profileOption(teamProfile(t)), 500, 300);
        expect(profile).toContain('오브젝트 장악');
        const objectives = renderSvg(indexBarOption(objectiveIndex(t)), 600, 200);
        expect(objectives).toContain('공허 유충');
        expect(objectives).toContain('5 평균'); // 축 눈금에 평균 표시
        const power = renderSvg(powerOption(powerCurve(t)), 600, 220);
        expect(power).toContain('40분');
        expect(power).toContain('정점');
        expect(power).toContain('후반');
        expect(renderSvg(damageOption(damageSplit(t)), 400, 220)).toContain('딜 비중');
        // 지수 차트의 화면 글자(<text>)에는 % 표기가 없어야 함 (확률로 오해하지 않게)
        const visibleText = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join(' ');
        [profile, objectives, power].forEach((svg) => expect(visibleText(svg)).not.toContain('%'));
        expect(visibleText(objectives)).toContain('5 평균');
    });
});
