import {
    createFormatters,
    computeSummary,
    buildKpiTiles,
    buildMonthlyOption,
    buildGaugeOption,
    buildFunnelOption,
    buildSankeyOption,
    buildTreemapOption,
    buildScatterOption,
    buildCalendarOption,
    filterDeals,
    toTableRows,
    sortRows,
    escapeHtml
} from '../chartOptions';

// 배포하는 Static Resource 원본으로 option을 실제 렌더링해 "그려지는지"까지 검증
const echarts = require('../../../staticresources/echarts.js');
const DATA = require('./data/dashboardData.json');

const fmt = createFormatters('en-US', 'USD');
const TARGET = 6000000;

function renderSvg(option) {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 400 });
    chart.setOption(option);
    const svg = chart.renderToSVGString();
    chart.dispose();
    return svg;
}

// 그려진 도형 수 (차트마다 SVG 요소가 다름: 퍼널 polygon, 히트맵 rect/path 등)
function countShapes(svg) {
    return (svg.match(/<(path|polygon|rect|polyline|circle)[ >]/g) || []).length;
}

// 같은 option에서 데이터만 비운 버전 → 축·배경 등 "빈 차트" 기준선
function withoutData(option) {
    return { ...option, series: option.series.map((s) => ({ ...s, data: [], links: [] })) };
}

// tooltip formatter를 직접 호출하기 위한 헬퍼
function tooltip(option) {
    return option.tooltip.formatter;
}

describe('chartOptions', () => {
    const summary = computeSummary(DATA);

    it('요약 지표를 월 집계와 진행 중 딜 기준으로 계산한다', () => {
        expect(summary.wonCount).toBe(76);
        expect(summary.lostCount).toBe(27);
        expect(summary.winRate).toBeCloseTo(76 / 103);
        // 가중 파이프라인 = 40,000×10% + 75,000×75%
        expect(summary.weightedPipeline).toBeCloseTo(4000 + 56250);
        const tiles = buildKpiTiles(summary, TARGET, fmt);
        expect(tiles).toHaveLength(5);
        expect(tiles[1].value).toBe(fmt.pct(summary.wonAmount / TARGET));
        expect(buildKpiTiles(summary, 0, fmt)[1].value).toBe('-');
    });

    it.each([
        ['monthly', () => buildMonthlyOption(DATA.months, TARGET, fmt)],
        ['monthly(목표 없음)', () => buildMonthlyOption(DATA.months, 0, fmt)],
        ['gauge', () => buildGaugeOption(summary, TARGET, fmt)],
        ['funnel', () => buildFunnelOption(DATA.stages, fmt)],
        ['sankey', () => buildSankeyOption(DATA.leadSources, fmt)],
        ['treemap', () => buildTreemapOption(DATA.accounts, fmt)],
        ['scatter', () => buildScatterOption(DATA.deals, fmt, '2026-10-19')],
        ['calendar', () => buildCalendarOption(2026, DATA.daily, fmt)]
    ])('%s option이 실제 ECharts로 데이터 도형까지 그려진다', (name, build) => {
        const option = build();
        const drawn = countShapes(renderSvg(option));
        const baseline = countShapes(renderSvg(withoutData(option)));
        // option 구조가 잘못돼 시리즈가 무시되면 drawn == baseline 이 됨
        expect(drawn).toBeGreaterThan(baseline);
    });

    it('데이터가 없는 캘린더도 오류 없이 그려진다', () => {
        expect(renderSvg(buildCalendarOption(2026, [], fmt))).toContain('<svg');
    });

    it('월별 차트: 목표가 있으면 달성률 보조축 시리즈를 추가한다', () => {
        const withTarget = buildMonthlyOption(DATA.months, TARGET, fmt);
        expect(withTarget.series.map((s) => s.id)).toEqual(['won', 'open', 'target', 'rate']);
        expect(withTarget.series[3].data[0]).toBeCloseTo(300000 / (TARGET / 12));
        expect(buildMonthlyOption(DATA.months, 0, fmt).series.map((s) => s.id)).toEqual(['won', 'open']);
    });

    it('Sankey: 0 흐름은 제외하고 미지정 Lead Source를 노드로 만든다', () => {
        const option = buildSankeyOption(DATA.leadSources, fmt);
        const { data, links } = option.series[0];
        expect(links).toHaveLength(5);
        expect(data.map((n) => n.name)).toContain('(미지정)');
        expect(data.find((n) => n.name === '(미지정)').sourceKey).toBe('');
    });

    it('Treemap: 산업별로 묶고 금액 큰 순으로 정렬한다', () => {
        const { data } = buildTreemapOption(DATA.accounts, fmt).series[0];
        expect(data.map((n) => n.name)).toEqual(['Technology', 'Manufacturing', '(미지정)']);
        expect(data[0].children[0].accountId).toBe('001000000000001AAA');
    });

    it('Scatter: 금액 없는 딜은 제외하고 결과별로 나눈다', () => {
        const { series } = buildScatterOption(DATA.deals, fmt, '2026-10-19');
        expect(series.map((s) => s.data.length)).toEqual([2, 1, 2]);
    });

    it('tooltip은 사용자 데이터를 HTML 이스케이프한다 (XSS 방지)', () => {
        const option = buildScatterOption(DATA.deals, fmt, '2026-10-19');
        const point = option.series[0].data[0];
        const html = tooltip(option)({ data: point, value: point.value });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('Acme &lt;Corp&gt;');
        expect(escapeHtml(`a"b'c&`)).toBe('a&quot;b&#39;c&amp;');
    });

    it('filterDeals: 조건 조합과 미지정 값을 처리한다', () => {
        expect(filterDeals(DATA.deals, null)).toHaveLength(6);
        expect(filterDeals(DATA.deals, { month: 3 })).toHaveLength(2);
        expect(filterDeals(DATA.deals, { month: 3, status: 'WON' })).toHaveLength(1);
        expect(filterDeals(DATA.deals, { leadSource: '' })).toHaveLength(2);
        expect(filterDeals(DATA.deals, { industry: 'Technology', status: 'WON' })).toHaveLength(1);
        expect(filterDeals(DATA.deals, { day: '2026-07-01' })).toHaveLength(1);
    });

    it('목록 행 변환과 정렬: 빈 값은 항상 뒤로 보낸다', () => {
        const rows = toTableRows(DATA.deals);
        expect(rows[0].recordUrl).toBe('/lightning/r/Opportunity/006000000000001AAA/view');
        expect(rows[5].accountName).toBe('(미지정)');
        const desc = sortRows(rows, 'amount', 'desc').map((r) => r.amount);
        expect(desc).toEqual([150000, 90000, 75000, 60000, 40000, null]);
        const asc = sortRows(rows, 'amount', 'asc').map((r) => r.amount);
        expect(asc[asc.length - 1]).toBeNull();
    });
});
