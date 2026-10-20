import { createElement } from 'lwc';
import SalesDashboard from 'c/salesDashboard';
import { loadScript } from 'lightning/platformResourceLoader';
import getDashboardData from '@salesforce/apex/SalesDashboardController.getDashboardData';
import AccountImportModal from 'c/accountImportModal';

const realEcharts = require('../../../staticresources/echarts.js');
const DATA = require('./data/dashboardData.json');

jest.mock('lightning/platformResourceLoader', () => ({ loadScript: jest.fn() }), { virtual: true });
jest.mock(
    '@salesforce/apex/SalesDashboardController.getDashboardData',
    () => {
        const { createApexTestWireAdapter } = require('@salesforce/sfdx-lwc-jest');
        return { default: createApexTestWireAdapter(jest.fn()) };
    },
    { virtual: true }
);

let charts;

// 자식 c-echart가 실제 ECharts(SSR/SVG)로 그리도록 연결 → 부모~자식~라이브러리 통합 검증
function installEcharts() {
    charts = [];
    window.echarts = {
        init: jest.fn(() => {
            const chart = realEcharts.init(null, null, { renderer: 'svg', ssr: true, width: 900, height: 360 });
            charts.push(chart);
            return chart;
        })
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0)); // eslint-disable-line @lwc/lwc/no-async-operation

async function mountWithData(data = DATA) {
    const el = createElement('c-sales-dashboard', { is: SalesDashboard });
    el.annualTarget = '6000000';
    document.body.appendChild(el);
    getDashboardData.emit(data);
    // wire 수신 → 재렌더링 → 자식 loadScript → 차트 초기화까지 마이크로태스크가 여러 단계라 충분히 대기
    await flush();
    await flush();
    await flush();
    await flush();
    return el;
}

function chartEl(el, id) {
    return el.shadowRoot.querySelector(`c-echart[data-id="${id}"]`);
}

function tableData(el) {
    return el.shadowRoot.querySelector('lightning-datatable').data;
}

describe('c-sales-dashboard', () => {
    beforeEach(() => {
        installEcharts();
        loadScript.mockResolvedValue();
    });

    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        delete window.echarts;
    });

    it('데이터 수신 후 KPI 5개와 차트 7개를 오류 없이 실제로 그린다', async () => {
        const el = await mountWithData();

        expect(el.shadowRoot.querySelectorAll('.kpi-tile')).toHaveLength(5);
        expect(el.shadowRoot.querySelectorAll('c-echart')).toHaveLength(7);
        expect(window.echarts.init).toHaveBeenCalledTimes(7);
        charts.forEach((chart) => {
            expect(chart.getOption().series.length).toBeGreaterThan(0);
            // 부모 option이 자식을 거쳐 실제 차트 인스턴스까지 데이터째 전달됐는지 (도형 렌더링 자체는 chartOptions.test.js에서 검증)
            expect(chart.getOption().series.some((s) => (s.data || []).length > 0)).toBe(true);
        });
        expect(tableData(el)).toHaveLength(6);
    });

    it('월별 막대 클릭 → 해당 월·결과로 목록 필터, pill 제거 시 해제', async () => {
        const el = await mountWithData();

        chartEl(el, 'monthly').dispatchEvent(new CustomEvent('chartclick', { detail: { dataIndex: 2, seriesId: 'won' } }));
        await flush();
        expect(tableData(el)).toHaveLength(1);
        const pill = el.shadowRoot.querySelector('lightning-pill');
        expect(pill.label).toContain('수주');

        pill.dispatchEvent(new CustomEvent('remove'));
        await flush();
        expect(tableData(el)).toHaveLength(6);
        expect(el.shadowRoot.querySelector('lightning-pill')).toBeNull();
    });

    it('Sankey 흐름 클릭 → Lead Source + 결과로 필터 (미지정 소스 포함)', async () => {
        const el = await mountWithData();
        chartEl(el, 'sankey').dispatchEvent(
            new CustomEvent('chartclick', { detail: { dataType: 'edge', data: { sourceKey: '', outcome: 'LOST' } } })
        );
        await flush();
        expect(tableData(el).map((r) => r.name)).toEqual(['Acme Renewal']);
    });

    it('Treemap 거래처 클릭 → 해당 거래처 수주 건으로 필터', async () => {
        const el = await mountWithData();
        chartEl(el, 'treemap').dispatchEvent(
            new CustomEvent('chartclick', { detail: { data: { accountId: '001000000000002AAA', name: 'Globex' } } })
        );
        await flush();
        expect(tableData(el).map((r) => r.name)).toEqual(['Globex Expansion']);
    });

    it('목록 정렬 이벤트를 반영한다', async () => {
        const el = await mountWithData();
        const table = el.shadowRoot.querySelector('lightning-datatable');
        table.dispatchEvent(new CustomEvent('sort', { detail: { fieldName: 'closeDate', sortDirection: 'asc' } }));
        await flush();
        expect(tableData(el)[0].closeDate).toBe('2026-01-05');
    });

    it('데이터가 없는 연도는 안내 문구를 표시하고 차트를 만들지 않는다', async () => {
        const empty = {
            ...DATA,
            months: DATA.months.map((m) => ({ ...m, wonAmount: 0, lostAmount: 0, openAmount: 0, wonCount: 0, lostCount: 0, openCount: 0 })),
            deals: [],
            daily: [],
            accounts: [],
            leadSources: []
        };
        const el = await mountWithData(empty);
        expect(el.shadowRoot.querySelector('.empty')).not.toBeNull();
        expect(el.shadowRoot.querySelectorAll('c-echart')).toHaveLength(0);
    });

    it('Apex 오류 시 사용자 메시지를 표시한다', async () => {
        const el = createElement('c-sales-dashboard', { is: SalesDashboard });
        document.body.appendChild(el);
        getDashboardData.error({ message: '대시보드 데이터를 불러오지 못했습니다.' });
        await flush();
        const alert = el.shadowRoot.querySelector('.slds-alert_error');
        expect(alert).not.toBeNull();
        expect(alert.textContent).toContain('대시보드 데이터를 불러오지 못했습니다.');
    });

    it('Excel 업로드 버튼은 표준 LightningModal로 업로드 화면을 연다', async () => {
        const el = await mountWithData();
        el.shadowRoot.querySelector('.upload-button').click();
        expect(AccountImportModal.open).toHaveBeenCalledWith({ size: 'medium', label: 'Account Excel 업로드' });
    });
});
