import { LANES, normalizeData, scoreTeam, synergiesOf, explain, suggestSwaps, findBestTeams, gradeOf } from '../lolScoring';

const { builderData } = require('./data/fixtures');

const ctx = normalizeData(builderData());
const SKILLS = { TOP: 6, JUNGLE: 7, MID: 8.7, ADC: 8.7, SUPPORT: 8 };
const pick = (id) => {
    const c = ctx.byId.get(id);
    if (!c) throw new Error(`없는 챔피언 ${id}`);
    return c;
};
const team = (top, jungle, mid, adc, sup) => ({
    TOP: pick(`${top}_Top`),
    JUNGLE: pick(`${jungle}_Jungle`),
    MID: pick(`${mid}_Mid`),
    ADC: pick(`${adc}_Adc`),
    SUPPORT: pick(`${sup}_Support`)
});
const points = (result, key) => result.categories.find((c) => c.key === key).points;

describe('lolScoring (객관 기준: 실제 통계 40 + 조합 기본기 60)', () => {
    it('배점 합계는 100, 실제 통계(개인 성능) 40점이고 모든 카테고리에 계산식이 있다', () => {
        expect(ctx.weights.reduce((acc, w) => acc + w.max, 0)).toBe(100);
        expect(ctx.weights.map((w) => w.key)).toEqual(['PICK_STRENGTH', 'FRONTLINE', 'CC', 'ENGAGE', 'PEEL', 'BALANCE', 'DAMAGE']);
        expect(ctx.weights[0].max).toBe(40);
        const r = scoreTeam(team('Ornn', 'Wukong', 'Yone', 'Jinx', 'Lulu'), SKILLS, ctx);
        r.categories.forEach((c) => {
            expect(c.detail).not.toBe('계산식 없음');
            expect(c.points).toBeGreaterThanOrEqual(0);
            expect(c.points).toBeLessThanOrEqual(c.max);
        });
        expect(r.total).toBeCloseTo(r.categories.reduce((acc, c) => acc + c.points, 0), 0);
        expect(r.grade).toBe(gradeOf(r.total));
    });

    it('팀 선호 규칙이 없다: 탑·정글 2탱/2브루저 여부, 플레이어 실력은 점수에 영향이 없다', () => {
        const comp = team('Mordekaiser', 'Wukong', 'Irelia', 'Jinx', 'Lulu'); // 예전 기준의 "2브루저" 감점 조합
        const skilled = scoreTeam(comp, SKILLS, ctx).total;
        const lowSkill = scoreTeam(comp, { TOP: 1, JUNGLE: 1, MID: 1, ADC: 1, SUPPORT: 1 }, ctx).total;
        expect(lowSkill).toBe(skilled);
        // 같은 앞라인 능력이면 탑에 있든 서폿에 있든 앞라인 점수가 같다 (라인별 역할 분담 규칙 없음)
        const r = scoreTeam(comp, SKILLS, ctx);
        expect(r.raw.FRONTLINE.detail).toMatch(/앞라인 상위 2명/);
    });

    it('개인 성능은 lol.ps 승률·PS 점수로 계산하고, 통계가 강한 픽일수록 높다', () => {
        const strong = scoreTeam(team('Malphite', 'Wukong', 'Yone', 'Jinx', 'Lulu'), SKILLS, ctx);
        const weakTop = ctx.byLane.TOP.filter((c) => c.winRate != null && c.psScore != null).sort((a, b) => a.psScore - b.psScore)[0];
        const weak = scoreTeam({ ...strong.team, TOP: weakTop }, SKILLS, ctx);
        expect(points(strong, 'PICK_STRENGTH')).toBeGreaterThan(points(weak, 'PICK_STRENGTH'));
        expect(strong.raw.PICK_STRENGTH.detail).toContain('lol.ps');
    });

    it('시너지는 점수에 넣지 않고 참고 정보로만 설명한다', () => {
        const good = synergiesOf(team('Shen', 'Sejuani', 'Yone', 'Jinx', 'Lulu'), ctx);
        expect(good.map((s) => [s.nameA, s.nameB].sort().join('+'))).toEqual(expect.arrayContaining(['쉔+징크스', '세주아니+요네', '룰루+징크스']));
        const bad = scoreTeam(team('Sion', 'Poppy', 'Ahri', 'Kalista', 'Yuumi'), SKILLS, ctx);
        expect(bad.categories.some((c) => c.key === 'SYNERGY')).toBe(false);
        expect(explain(bad).weaknesses.some((w) => w.startsWith('참고 상성') && w.includes('칼리스타') && w.includes('유미'))).toBe(true);
    });

    it('AD 편중 조합은 밸런스 감점 + 약점에 방어력 대응 위험을 설명한다', () => {
        const allAd = scoreTeam(team('Renekton', 'Vi', 'Irelia', 'Lucian', 'Karma'), SKILLS, ctx);
        expect(points(allAd, 'BALANCE')).toBeLessThan(10);
        expect(explain(allAd).weaknesses.join('\n')).toContain('방어력');
    });

    it('앞라인·이니시가 약한 조합은 해당 항목이 낮고 약점으로 설명된다', () => {
        const squishy = scoreTeam(team('Teemo', 'Kindred', 'Zoe', 'Jinx', 'Soraka'), SKILLS, ctx);
        const solid = scoreTeam(team('Ornn', 'Sejuani', 'Yone', 'Jinx', 'Lulu'), SKILLS, ctx);
        expect(points(squishy, 'FRONTLINE')).toBeLessThan(points(solid, 'FRONTLINE'));
        expect(points(squishy, 'ENGAGE')).toBeLessThan(points(solid, 'ENGAGE'));
        expect(explain(squishy).weaknesses.some((w) => w.startsWith('앞라인') || w.startsWith('이니시'))).toBe(true);
    });

    it('교체 추천은 실제로 점수를 올리고, 이미 쓴 챔피언은 추천하지 않는다', () => {
        const comp = team('Renekton', 'Vi', 'LeBlanc', 'Lucian', 'Yuumi');
        const base = scoreTeam(comp, SKILLS, ctx).total;
        const swaps = suggestSwaps(comp, SKILLS, ctx);
        expect(swaps.length).toBeGreaterThan(0);
        swaps.forEach((s) => {
            const after = scoreTeam({ ...comp, [s.lane]: s.to }, SKILLS, ctx).total;
            expect(after).toBeCloseTo(base + s.delta, 1);
            expect(LANES.filter((l) => l !== s.lane).map((l) => comp[l].key)).not.toContain(s.to.key);
        });
    });

    it('전체 탐색: 상위 결과는 정렬돼 있고 중복 금지·고정 라인을 지킨다', () => {
        const { teams, evaluated } = findBestTeams(ctx, SKILLS, { limit: 20 });
        expect(evaluated).toBeGreaterThan(1000);
        expect(teams).toHaveLength(20);
        const totals = teams.map((t) => t.total);
        expect(totals).toEqual([...totals].sort((x, y) => y - x));
        teams.forEach((t) => expect(new Set(LANES.map((l) => t.team[l].key)).size).toBe(5));

        // 무작위 표본보다 1위 점수가 높아야 함 (탐색이 실제로 최댓값을 찾는지)
        const sample = scoreTeam(team('Sion', 'Poppy', 'Ahri', 'Kalista', 'Yuumi'), SKILLS, ctx);
        expect(teams[0].total).toBeGreaterThan(sample.total);

        const locked = findBestTeams(ctx, SKILLS, { locked: { ADC: pick('Caitlyn_Adc'), SUPPORT: pick('Lux_Support') }, limit: 5 });
        locked.teams.forEach((t) => {
            expect(t.team.ADC.id).toBe('Caitlyn_Adc');
            expect(t.team.SUPPORT.id).toBe('Lux_Support');
        });
    });
});
