import { LANES, normalizeData, scoreTeam, structureOf, synergiesOf, explain, suggestSwaps, findBestTeams, gradeOf } from '../lolScoring';

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

describe('lolScoring', () => {
    it('배점 합계는 100이고 모든 카테고리에 계산식이 있다', () => {
        expect(ctx.weights.reduce((acc, w) => acc + w.max, 0)).toBe(100);
        const r = scoreTeam(team('Ornn', 'Wukong', 'Yone', 'Jinx', 'Lulu'), SKILLS, ctx);
        r.categories.forEach((c) => {
            expect(c.detail).not.toBe('계산식 없음');
            expect(c.points).toBeGreaterThanOrEqual(0);
            expect(c.points).toBeLessThanOrEqual(c.max);
        });
        expect(r.total).toBeCloseTo(r.categories.reduce((acc, c) => acc + c.points, 0), 0);
        expect(r.grade).toBe(gradeOf(r.total));
    });

    it('앞라인 구조: 1탱+1브루저 만점, 2탱 절반, 2브루저 감점', () => {
        expect(structureOf(pick('Ornn_Top'), pick('Wukong_Jungle'))).toMatchObject({ ratio: 1, ok: true });
        expect(structureOf(pick('Mordekaiser_Top'), pick('Sejuani_Jungle'))).toMatchObject({ ratio: 1, ok: true });
        expect(structureOf(pick('Ornn_Top'), pick('Sejuani_Jungle'))).toMatchObject({ ratio: 0.5, ok: false });
        expect(structureOf(pick('Renekton_Top'), pick('Vi_Jungle'))).toMatchObject({ ratio: 0.3, ok: false });
    });

    it('2탱 조합은 같은 미드·바텀의 1탱1브루저 조합보다 구조 점수가 낮다', () => {
        const twoTanks = scoreTeam(team('Ornn', 'Sejuani', 'Yone', 'Jinx', 'Lulu'), SKILLS, ctx);
        const oneEach = scoreTeam(team('Ornn', 'Wukong', 'Yone', 'Jinx', 'Lulu'), SKILLS, ctx);
        expect(points(twoTanks, 'STRUCTURE')).toBeLessThan(points(oneEach, 'STRUCTURE'));
    });

    it('시너지는 라인과 무관하게 챔피언 키 쌍으로 찾고, 음수 시너지는 약점으로 설명한다', () => {
        const good = synergiesOf(team('Shen', 'Sejuani', 'Yone', 'Jinx', 'Lulu'), ctx);
        expect(good.map((s) => [s.nameA, s.nameB].sort().join('+'))).toEqual(expect.arrayContaining(['쉔+징크스', '세주아니+요네', '룰루+징크스']));

        const bad = scoreTeam(team('Sion', 'Poppy', 'Ahri', 'Kalista', 'Yuumi'), SKILLS, ctx);
        expect(bad.synergies.some((s) => s.score < 0)).toBe(true);
        expect(explain(bad).weaknesses.some((w) => w.includes('칼리스타') && w.includes('유미'))).toBe(true);
        expect(points(bad, 'SYNERGY')).toBeLessThan(6); // 중립(6점)보다 낮음
    });

    it('AD 편중 조합은 밸런스 감점 + 약점에 방어력 대응 위험을 설명한다', () => {
        const allAd = scoreTeam(team('Renekton', 'Vi', 'Irelia', 'Lucian', 'Karma'), SKILLS, ctx);
        expect(points(allAd, 'BALANCE')).toBeLessThan(10);
        expect(explain(allAd).weaknesses.join('\n')).toContain('방어력');
    });

    it('실력이 낮은 라인에 난이도 높은 챔피언을 두면 실력 적합도가 떨어진다', () => {
        const comp = team('Ornn', 'Wukong', 'Irelia', 'Jinx', 'Lulu');
        const skilled = scoreTeam(comp, SKILLS, ctx);
        const lowMid = scoreTeam(comp, { ...SKILLS, MID: 3 }, ctx);
        expect(points(lowMid, 'SKILL')).toBeLessThan(points(skilled, 'SKILL'));
        expect(explain(lowMid).weaknesses.some((w) => w.includes('이렐리아') && w.includes('난이도'))).toBe(true);
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

    it('전체 탐색: 상위 결과는 정렬돼 있고 구조 조건·중복 금지·고정 라인을 지킨다', () => {
        const { teams, evaluated } = findBestTeams(ctx, SKILLS, { limit: 20 });
        expect(evaluated).toBeGreaterThan(1000);
        expect(teams).toHaveLength(20);
        const totals = teams.map((t) => t.total);
        expect(totals).toEqual([...totals].sort((x, y) => y - x));
        teams.forEach((t) => {
            expect(t.structureOk).toBe(true);
            expect(new Set(LANES.map((l) => t.team[l].key)).size).toBe(5);
        });

        // 무작위 표본보다 1위 점수가 높아야 함 (탐색이 실제로 최댓값을 찾는지)
        const sample = scoreTeam(team('Sion', 'Poppy', 'Ahri', 'Kalista', 'Yuumi'), SKILLS, ctx);
        expect(teams[0].total).toBeGreaterThan(sample.total);

        const locked = findBestTeams(ctx, SKILLS, { locked: { ADC: pick('Caitlyn_Adc'), SUPPORT: pick('Lux_Support') }, limit: 5 });
        locked.teams.forEach((t) => {
            expect(t.team.ADC.id).toBe('Caitlyn_Adc');
            expect(t.team.SUPPORT.id).toBe('Lux_Support');
        });

        const free = findBestTeams(ctx, SKILLS, { requireStructure: false, limit: 1 });
        expect(free.evaluated).toBeGreaterThan(evaluated);
    });
});
