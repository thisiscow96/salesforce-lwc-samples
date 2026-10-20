/**
 * Sales Dashboard 차트 option 생성 (순수 함수 모음)
 * - window.echarts에 의존하지 않도록 그라데이션도 일반 객체로 표현 → Jest에서 단독 검증 가능
 * - 금액·날짜 표시는 사용자 Locale/Currency 기반 formatter(fmt)를 받아 사용 (통화 하드코딩 없음)
 * - tooltip은 HTML 문자열이므로 사용자 데이터(기회명, 거래처명 등)는 반드시 escapeHtml 처리 (XSS 방지)
 */

export const OUTCOME_LABELS = { WON: '수주', LOST: '실주', OPEN: '진행 중' };
export const NONE_LABEL = '(미지정)';

const OUTCOME_COLORS = { WON: '#2E844A', LOST: '#C23934', OPEN: '#0176D3' };
const PALETTE = ['#0176D3', '#2E844A', '#FE9339', '#9050E9', '#06A59A', '#E3066A', '#8C4B02', '#3A49DA'];
const STAGE_COLORS = ['#032D60', '#014486', '#0B5CAB', '#0176D3', '#1B96FF', '#57A3FD', '#78B0FD', '#AACBFF'];
const TARGET_COLOR = '#FE9339';
const RATE_COLOR = '#9050E9';
const TEXT_STYLE = { fontFamily: 'Salesforce Sans, Arial, sans-serif' };
// confine: tooltip이 카드 밖으로 잘리지 않게 차트 영역 안에 가둠
const TOOLTIP = { confine: true, textStyle: { fontSize: 12 } };

export function escapeHtml(value) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, (c) => map[c]);
}

function verticalGradient(top, bottom) {
    return { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: top }, { offset: 1, color: bottom }] };
}

function horizontalGradient(left, right) {
    return { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: left }, { offset: 1, color: right }] };
}

export function createFormatters(locale, currency = 'USD') {
    let safeLocale = locale;
    try {
        Intl.NumberFormat(locale);
    } catch {
        // Intl이 모르는 locale이면 기본값으로 대체
        safeLocale = 'en-US';
    }
    const compact = new Intl.NumberFormat(safeLocale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 });
    const full = new Intl.NumberFormat(safeLocale, { style: 'currency', currency, maximumFractionDigits: 0 });
    const pct = new Intl.NumberFormat(safeLocale, { style: 'percent', maximumFractionDigits: 1 });
    const num = new Intl.NumberFormat(safeLocale, { maximumFractionDigits: 0 });
    const monthName = new Intl.DateTimeFormat(safeLocale, { month: 'short' });
    return {
        compact: (v) => compact.format(v || 0),
        full: (v) => full.format(v || 0),
        pct: (v) => pct.format(v || 0),
        num: (v) => num.format(v || 0),
        month: (m) => monthName.format(new Date(2000, m - 1, 1))
    };
}

// ===== KPI =====
export function computeSummary(data) {
    const s = { wonAmount: 0, wonCount: 0, lostAmount: 0, lostCount: 0, openAmount: 0, openCount: 0, weightedPipeline: 0 };
    (data.months || []).forEach((m) => {
        s.wonAmount += m.wonAmount || 0;
        s.wonCount += m.wonCount || 0;
        s.lostAmount += m.lostAmount || 0;
        s.lostCount += m.lostCount || 0;
        s.openAmount += m.openAmount || 0;
        s.openCount += m.openCount || 0;
    });
    // 가중 파이프라인 = 진행 중 금액 × 단계 확률 (예상 착지 계산용)
    (data.deals || []).forEach((d) => {
        if (d.status === 'OPEN') {
            s.weightedPipeline += ((d.amount || 0) * (d.probability || 0)) / 100;
        }
    });
    const closed = s.wonCount + s.lostCount;
    s.winRate = closed ? s.wonCount / closed : 0;
    s.avgDeal = s.wonCount ? s.wonAmount / s.wonCount : 0;
    s.totalCount = s.wonCount + s.lostCount + s.openCount;
    return s;
}

export function buildKpiTiles(s, target, fmt) {
    const tile = (key, tone, label, value, sub) => ({ key, label, value, sub, className: `kpi-tile kpi-${tone}` });
    return [
        tile('won', 'won', '수주 금액', fmt.compact(s.wonAmount), `${fmt.num(s.wonCount)}건 수주`),
        tile('attain', 'target', '목표 달성률', target ? fmt.pct(s.wonAmount / target) : '-',
            target ? `연간 목표 ${fmt.compact(target)}` : '목표 미설정 (App Builder에서 입력)'),
        tile('winrate', 'rate', 'Win Rate', fmt.pct(s.winRate), `수주 ${fmt.num(s.wonCount)} / 실주 ${fmt.num(s.lostCount)}`),
        tile('pipeline', 'open', '진행 중 파이프라인', fmt.compact(s.openAmount),
            `가중 ${fmt.compact(s.weightedPipeline)} · ${fmt.num(s.openCount)}건`),
        tile('avg', 'neutral', '평균 수주 금액', fmt.compact(s.avgDeal), '수주 건 기준')
    ];
}

// ===== 1. 월별 수주·파이프라인 vs 목표 (Bar + Line, 보조축) =====
export function buildMonthlyOption(months, target, fmt) {
    const monthlyTarget = target > 0 ? target / 12 : 0;
    const series = [
        {
            id: 'won',
            name: OUTCOME_LABELS.WON,
            type: 'bar',
            stack: 'amount',
            barMaxWidth: 32,
            itemStyle: { color: verticalGradient('#2E844A', '#91DB8B') },
            emphasis: { focus: 'series' },
            data: months.map((m) => m.wonAmount || 0)
        },
        {
            id: 'open',
            name: '진행 중 파이프라인',
            type: 'bar',
            stack: 'amount',
            barMaxWidth: 32,
            itemStyle: { color: verticalGradient('#78B0FD', '#D8E6FE'), borderRadius: [4, 4, 0, 0] },
            emphasis: { focus: 'series' },
            data: months.map((m) => m.openAmount || 0)
        }
    ];
    if (monthlyTarget) {
        series.push({
            id: 'target',
            name: '월 목표',
            type: 'line',
            symbol: 'none',
            lineStyle: { type: 'dashed', width: 2, color: TARGET_COLOR },
            itemStyle: { color: TARGET_COLOR },
            z: 4,
            data: months.map(() => monthlyTarget)
        });
        series.push({
            id: 'rate',
            name: '달성률',
            type: 'line',
            yAxisIndex: 1,
            smooth: true,
            symbolSize: 7,
            lineStyle: { width: 3, color: RATE_COLOR },
            itemStyle: { color: RATE_COLOR },
            z: 5,
            data: months.map((m) => (m.wonAmount || 0) / monthlyTarget)
        });
    }
    return {
        textStyle: TEXT_STYLE,
        tooltip: {
            ...TOOLTIP,
            trigger: 'axis',
            axisPointer: { type: 'shadow' },
            formatter: (params) => {
                const rows = params.map((p) => {
                    const value = p.seriesId === 'rate' ? fmt.pct(p.value) : fmt.compact(p.value);
                    return `${p.marker}${escapeHtml(p.seriesName)}: <b>${value}</b>`;
                });
                return `${escapeHtml(params[0].axisValueLabel)}<br/>${rows.join('<br/>')}`;
            }
        },
        legend: { top: 0 },
        grid: { left: 64, right: monthlyTarget ? 56 : 16, top: 40, bottom: 28 },
        xAxis: { type: 'category', data: months.map((m) => fmt.month(m.month)), axisTick: { alignWithLabel: true } },
        yAxis: [
            { type: 'value', axisLabel: { formatter: (v) => fmt.compact(v) }, splitLine: { lineStyle: { type: 'dashed' } } },
            { type: 'value', show: !!monthlyTarget, axisLabel: { formatter: (v) => fmt.pct(v) }, splitLine: { show: false } }
        ],
        series
    };
}

// ===== 2. 연간 목표 달성 게이지 (수주 + 예상 착지 2겹) =====
export function buildGaugeOption(s, target, fmt) {
    const wonPct = target ? (s.wonAmount / target) * 100 : 0;
    const forecastPct = target ? ((s.wonAmount + s.weightedPipeline) / target) * 100 : 0;
    const max = Math.max(100, Math.ceil(forecastPct / 10) * 10);
    const common = {
        type: 'gauge',
        startAngle: 220,
        endAngle: -40,
        min: 0,
        max,
        radius: '90%',
        center: ['50%', '55%'],
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        anchor: { show: false }
    };
    return {
        textStyle: TEXT_STYLE,
        tooltip: { ...TOOLTIP, formatter: (p) => `${escapeHtml(p.name)}: <b>${Number(p.value).toFixed(1)}%</b>` },
        series: [
            {
                ...common,
                id: 'forecast',
                progress: { show: true, width: 22, roundCap: true, itemStyle: { color: '#AACBFF' } },
                axisLine: { roundCap: true, lineStyle: { width: 22, color: [[1, '#EEF1F6']] } },
                title: { show: false },
                detail: { show: false },
                data: [{ name: '예상 착지 (수주 + 가중 파이프라인)', value: forecastPct }]
            },
            {
                ...common,
                id: 'won',
                progress: { show: true, width: 22, roundCap: true, itemStyle: { color: horizontalGradient('#2E844A', '#45C65A') } },
                axisLine: { show: false },
                title: { offsetCenter: [0, '30%'], fontSize: 12, color: '#5C5C5C' },
                detail: {
                    valueAnimation: true,
                    offsetCenter: [0, '-2%'],
                    fontSize: 30,
                    fontWeight: 'bold',
                    color: '#181818',
                    formatter: (v) => (target ? `${v.toFixed(1)}%` : '목표 미설정')
                },
                data: [{ name: `${fmt.compact(s.wonAmount)} / ${fmt.compact(target)}`, value: wonPct }]
            }
        ],
        graphic: [
            {
                type: 'text',
                left: 'center',
                bottom: 8,
                style: { text: `예상 착지 ${forecastPct.toFixed(1)}%`, fill: '#0176D3', fontSize: 13, fontWeight: 'bold' }
            }
        ]
    };
}

// ===== 3. 파이프라인 퍼널 (단계 순서 유지) =====
export function buildFunnelOption(stages, fmt) {
    const data = stages.map((st) => ({ name: st.label, value: st.amount || 0, stage: st.apiName, count: st.count || 0 }));
    return {
        textStyle: TEXT_STYLE,
        color: STAGE_COLORS,
        tooltip: {
            ...TOOLTIP,
            trigger: 'item',
            formatter: (p) => `${escapeHtml(p.name)}<br/><b>${fmt.full(p.value)}</b> · ${fmt.num(p.data.count)}건`
        },
        series: [
            {
                id: 'funnel',
                type: 'funnel',
                // 금액 순 정렬을 하면 단계 순서가 섞여 왜곡되므로 Setup 단계 순서를 유지
                sort: 'none',
                left: '4%',
                width: '52%',
                top: 8,
                bottom: 8,
                minSize: '6%',
                gap: 3,
                label: {
                    position: 'right',
                    formatter: (p) => `${p.name}  {amt|${fmt.compact(p.value)}}`,
                    rich: { amt: { fontWeight: 'bold' } }
                },
                labelLine: { length: 14 },
                itemStyle: { borderColor: '#fff', borderWidth: 1 },
                data
            }
        ]
    };
}

// ===== 4. Lead Source → 결과 흐름 (Sankey) =====
export function buildSankeyOption(leadSources, fmt) {
    const nodes = new Map();
    const links = [];
    leadSources.forEach((row) => {
        if (!(row.amount > 0)) {
            return; // Sankey는 0 흐름을 그릴 수 없음
        }
        const sourceKey = row.source || '';
        const sourceName = row.source || NONE_LABEL;
        const targetName = OUTCOME_LABELS[row.outcome];
        if (!nodes.has(sourceName)) {
            nodes.set(sourceName, { name: sourceName, sourceKey });
        }
        if (!nodes.has(targetName)) {
            nodes.set(targetName, { name: targetName, outcome: row.outcome, itemStyle: { color: OUTCOME_COLORS[row.outcome] } });
        }
        links.push({ source: sourceName, target: targetName, value: row.amount, count: row.count, sourceKey, outcome: row.outcome });
    });
    return {
        textStyle: TEXT_STYLE,
        color: PALETTE,
        tooltip: {
            ...TOOLTIP,
            trigger: 'item',
            formatter: (p) => {
                if (p.dataType === 'edge') {
                    return `${escapeHtml(p.data.source)} → ${escapeHtml(p.data.target)}<br/><b>${fmt.full(p.value)}</b> · ${fmt.num(p.data.count)}건`;
                }
                return `${escapeHtml(p.name)}<br/><b>${fmt.full(p.value)}</b>`;
            }
        },
        series: [
            {
                id: 'sankey',
                type: 'sankey',
                left: 8,
                right: 72,
                top: 8,
                bottom: 8,
                nodeWidth: 14,
                nodeGap: 12,
                emphasis: { focus: 'adjacency' },
                lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.35 },
                label: { color: '#181818', fontSize: 12 },
                data: [...nodes.values()],
                links
            }
        ]
    };
}

// ===== 5. 산업 → 거래처 수주 구성 (Treemap, 클릭 시 하위로 확대) =====
export function buildTreemapOption(accounts, fmt) {
    const byIndustry = new Map();
    accounts.forEach((a) => {
        const industryKey = a.industry || '';
        if (!byIndustry.has(industryKey)) {
            byIndustry.set(industryKey, { name: a.industry || NONE_LABEL, industry: industryKey, value: 0, children: [] });
        }
        const node = byIndustry.get(industryKey);
        node.value += a.amount || 0;
        node.children.push({
            name: a.accountName || NONE_LABEL,
            value: a.amount || 0,
            accountId: a.accountId,
            industry: industryKey,
            count: a.count
        });
    });
    const data = [...byIndustry.values()].sort((x, y) => y.value - x.value);
    const total = data.reduce((sum, n) => sum + n.value, 0);
    return {
        textStyle: TEXT_STYLE,
        color: PALETTE,
        tooltip: {
            ...TOOLTIP,
            formatter: (p) => {
                const path = (p.treePathInfo || []).slice(1).map((n) => escapeHtml(n.name)).join(' / ');
                return `${path}<br/><b>${fmt.full(p.value)}</b> (${fmt.pct(total ? p.value / total : 0)})`;
            }
        },
        series: [
            {
                id: 'treemap',
                type: 'treemap',
                name: '전체',
                roam: false,
                leafDepth: 1,
                nodeClick: 'zoomToNode',
                top: 8,
                left: 0,
                right: 0,
                bottom: 30,
                breadcrumb: { show: true, bottom: 2, height: 20 },
                label: { formatter: (p) => `${p.name}\n${fmt.compact(p.value)}`, fontSize: 12 },
                upperLabel: { show: true, height: 22, color: '#fff' },
                levels: [
                    { itemStyle: { borderColor: '#fff', borderWidth: 2, gapWidth: 2 } },
                    { colorSaturation: [0.35, 0.65], itemStyle: { borderColorSaturation: 0.6, gapWidth: 1, borderWidth: 1 } }
                ],
                data
            }
        ]
    };
}

// ===== 6. 딜 분포 (Scatter: 마감일 × 금액, 점 크기 = 확률) =====
export function buildScatterOption(deals, fmt, todayIso) {
    const groups = { WON: [], LOST: [], OPEN: [] };
    deals.forEach((d) => {
        if (d.amount == null || !groups[d.status]) {
            return;
        }
        groups[d.status].push({
            value: [d.closeDate, d.amount, d.probability || 0],
            id: d.id,
            name: d.name,
            account: d.accountName,
            stage: d.stage
        });
    });
    const series = ['WON', 'LOST', 'OPEN'].map((status) => ({
        id: status,
        name: OUTCOME_LABELS[status],
        type: 'scatter',
        symbolSize: (v) => 6 + Math.sqrt(v[2] || 0) * 2,
        itemStyle: { color: OUTCOME_COLORS[status], opacity: 0.7, borderColor: '#fff', borderWidth: 1 },
        emphasis: { focus: 'series', itemStyle: { opacity: 1, shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.3)' } },
        data: groups[status]
    }));
    series[2].markLine = {
        symbol: 'none',
        silent: true,
        lineStyle: { color: '#706E6B', type: 'dashed' },
        label: { formatter: '오늘', position: 'end' },
        data: [{ xAxis: todayIso }]
    };
    return {
        textStyle: TEXT_STYLE,
        legend: { top: 0 },
        tooltip: {
            ...TOOLTIP,
            trigger: 'item',
            formatter: (p) =>
                `<b>${escapeHtml(p.data.name)}</b><br/>${escapeHtml(p.data.account || NONE_LABEL)} · ${escapeHtml(p.data.stage)}` +
                `<br/>${fmt.full(p.value[1])} · 확률 ${p.value[2]}%<br/>마감 ${escapeHtml(p.value[0])}<br/><i>클릭하면 레코드로 이동</i>`
        },
        grid: { left: 64, right: 24, top: 40, bottom: 56 },
        xAxis: { type: 'time', splitLine: { show: false } },
        yAxis: { type: 'value', axisLabel: { formatter: (v) => fmt.compact(v) }, splitLine: { lineStyle: { type: 'dashed' } } },
        dataZoom: [
            { type: 'inside', xAxisIndex: 0 },
            { type: 'slider', xAxisIndex: 0, height: 16, bottom: 12 }
        ],
        series
    };
}

// ===== 7. 일별 수주 캘린더 히트맵 =====
export function buildCalendarOption(year, daily, fmt) {
    const data = daily.map((d) => [d.day, d.amount || 0, d.count || 0]);
    const max = Math.max(1, ...data.map((d) => d[1]));
    return {
        textStyle: TEXT_STYLE,
        tooltip: {
            ...TOOLTIP,
            formatter: (p) => `${escapeHtml(p.value[0])}<br/><b>${fmt.full(p.value[1])}</b> · ${fmt.num(p.value[2])}건`
        },
        visualMap: {
            min: 0,
            max,
            calculable: true,
            orient: 'horizontal',
            left: 'center',
            bottom: 0,
            itemWidth: 12,
            itemHeight: 200,
            formatter: (v) => fmt.compact(v),
            // 최소값 색을 너무 연하게 두면 소액 수주일이 빈 칸처럼 보여 시작 색을 진하게 설정
            inRange: { color: ['#B8D8FF', '#57A3FD', '#0176D3', '#032D60'] }
        },
        calendar: {
            range: String(year),
            top: 28,
            left: 36,
            right: 12,
            cellSize: ['auto', 15],
            splitLine: { lineStyle: { color: '#C9C9C9' } },
            itemStyle: { borderColor: '#fff', borderWidth: 2 },
            yearLabel: { show: false },
            dayLabel: { firstDay: 1, fontSize: 10 },
            monthLabel: { fontSize: 11 }
        },
        series: [{ id: 'calendar', type: 'heatmap', coordinateSystem: 'calendar', data }]
    };
}

// ===== 드릴다운 목록 =====
// criteria의 각 키가 정의된 경우에만 조건으로 사용 (빈 문자열 = 미지정 값)
export function filterDeals(deals, c) {
    if (!c) {
        return deals;
    }
    return deals.filter(
        (d) =>
            (c.month === undefined || Number(String(d.closeDate).slice(5, 7)) === c.month) &&
            (c.status === undefined || d.status === c.status) &&
            (c.stage === undefined || d.stage === c.stage) &&
            (c.leadSource === undefined || (d.leadSource || '') === c.leadSource) &&
            (c.industry === undefined || (d.industry || '') === c.industry) &&
            (c.accountId === undefined || d.accountId === c.accountId) &&
            (c.day === undefined || d.closeDate === c.day)
    );
}

export function toTableRows(deals) {
    return deals.map((d) => ({
        ...d,
        recordUrl: `/lightning/r/Opportunity/${d.id}/view`,
        statusLabel: OUTCOME_LABELS[d.status],
        accountName: d.accountName || NONE_LABEL,
        leadSourceLabel: d.leadSource || NONE_LABEL
    }));
}

export function sortRows(rows, field, direction) {
    const factor = direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
        const x = a[field];
        const y = b[field];
        if (x === y) {
            return 0;
        }
        if (x === null || x === undefined) {
            return 1; // 빈 값은 항상 뒤로
        }
        if (y === null || y === undefined) {
            return -1;
        }
        return (x > y ? 1 : -1) * factor;
    });
}
