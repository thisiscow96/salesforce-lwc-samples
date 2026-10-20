import { LightningElement, api, wire } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { refreshApex } from '@salesforce/apex';
import LOCALE from '@salesforce/i18n/locale';
import CURRENCY from '@salesforce/i18n/currency';
import getDashboardData from '@salesforce/apex/SalesDashboardController.getDashboardData';
import ExcelImportModal from 'c/excelImportModal';
import {
    OUTCOME_LABELS,
    NONE_LABEL,
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
    sortRows
} from './chartOptions';

// 금액 컬럼 통화는 사용자 통화(@salesforce/i18n/currency)를 따름
const COLUMNS = [
    { label: '기회명', fieldName: 'recordUrl', type: 'url', typeAttributes: { label: { fieldName: 'name' }, target: '_self' }, initialWidth: 260 },
    { label: '거래처', fieldName: 'accountName', sortable: true },
    { label: '단계', fieldName: 'stage', sortable: true },
    { label: '결과', fieldName: 'statusLabel', sortable: true, initialWidth: 90 },
    {
        label: '금액',
        fieldName: 'amount',
        type: 'currency',
        sortable: true,
        typeAttributes: { currencyCode: CURRENCY, maximumFractionDigits: 0 },
        cellAttributes: { alignment: 'right' }
    },
    { label: '확률(%)', fieldName: 'probability', type: 'number', sortable: true, initialWidth: 90 },
    { label: '마감일', fieldName: 'closeDate', type: 'date-local', sortable: true, initialWidth: 120 },
    { label: 'Lead Source', fieldName: 'leadSourceLabel', sortable: true }
];

function toIsoDate(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function reduceError(error) {
    if (!error) {
        return '알 수 없는 오류가 발생했습니다.';
    }
    if (Array.isArray(error.body)) {
        return error.body.map((e) => e.message).join(', ');
    }
    return (error.body && error.body.message) || error.message || '알 수 없는 오류가 발생했습니다.';
}

export default class SalesDashboard extends NavigationMixin(LightningElement) {
    @api cardTitle = 'Sales Dashboard';
    // App Builder 속성. Integer 타입은 최대 약 21억이라 원화 목표를 담지 못해 String으로 받아 숫자로 변환
    @api annualTarget = '10000000';

    year = new Date().getFullYear();
    columns = COLUMNS;
    fmt = createFormatters(LOCALE, CURRENCY);

    data;
    summary;
    errorMessage;
    isLoading = true;
    wiredResult;
    options = {};
    kpis = [];
    rows = [];
    filter = null; // { criteria, label }
    sortedBy = 'amount';
    sortDirection = 'desc';

    @wire(getDashboardData, { year: '$year' })
    wiredDashboard(result) {
        this.wiredResult = result;
        const { data, error } = result;
        if (data) {
            this.data = data;
            this.errorMessage = undefined;
            this.isLoading = false;
            this.filter = null;
            this.buildDashboard();
        } else if (error) {
            this.data = undefined;
            this.errorMessage = reduceError(error);
            this.isLoading = false;
        }
    }

    get targetAmount() {
        const n = Number(this.annualTarget);
        return Number.isFinite(n) && n > 0 ? n : 0;
    }

    get yearOptions() {
        const now = new Date().getFullYear();
        return [now + 1, now, now - 1, now - 2].map((y) => ({ label: `${y}년`, value: String(y) }));
    }

    get yearValue() {
        return String(this.year);
    }

    get hasData() {
        return !!this.summary && this.summary.totalCount > 0;
    }

    get isEmpty() {
        return !!this.summary && this.summary.totalCount === 0 && !this.isLoading;
    }

    get tableTitle() {
        return `상세 기회 목록 (${this.fmt.num(this.rows.length)}건)`;
    }

    // 데이터가 바뀔 때만 option을 새로 만들어 차트 애니메이션이 불필요하게 재생되지 않게 함
    buildDashboard() {
        const target = this.targetAmount;
        const d = this.data;
        this.summary = computeSummary(d);
        this.kpis = buildKpiTiles(this.summary, target, this.fmt);
        this.options = {
            monthly: buildMonthlyOption(d.months, target, this.fmt),
            gauge: buildGaugeOption(this.summary, target, this.fmt),
            funnel: buildFunnelOption(d.stages, this.fmt),
            sankey: buildSankeyOption(d.leadSources, this.fmt),
            treemap: buildTreemapOption(d.accounts, this.fmt),
            scatter: buildScatterOption(d.deals, this.fmt, toIsoDate(new Date())),
            calendar: buildCalendarOption(d.year, d.daily, this.fmt)
        };
        this.refreshRows();
    }

    refreshRows() {
        if (!this.data) {
            this.rows = [];
            return;
        }
        const filtered = filterDeals(this.data.deals, this.filter && this.filter.criteria);
        this.rows = sortRows(toTableRows(filtered), this.sortedBy, this.sortDirection);
    }

    setFilter(criteria, label) {
        this.filter = { criteria, label };
        this.refreshRows();
    }

    // ===== 상단 컨트롤 =====
    handleYearChange(event) {
        this.year = Number(event.detail.value);
        this.isLoading = true;
        this.filter = null;
    }

    handleRefresh() {
        this.isLoading = true;
        refreshApex(this.wiredResult).finally(() => {
            this.isLoading = false;
        });
    }

    // 공통 Excel 업로드 모달에 설정(Account_Contact)만 지정. 결과는 모달 안에서 확인하므로 닫힌 뒤 추가 처리 없음
    handleOpenUpload() {
        ExcelImportModal.open({ size: 'large', configName: 'Account_Contact', label: 'Account Excel 업로드' });
    }

    handleClearFilter() {
        this.filter = null;
        this.refreshRows();
    }

    handleSort(event) {
        this.sortedBy = event.detail.fieldName;
        this.sortDirection = event.detail.sortDirection;
        this.refreshRows();
    }

    // ===== 차트 클릭 → 드릴다운 =====
    handleMonthlyClick(event) {
        const { dataIndex, seriesId } = event.detail;
        if (dataIndex === undefined) {
            return;
        }
        const month = dataIndex + 1;
        const status = seriesId === 'won' ? 'WON' : seriesId === 'open' ? 'OPEN' : undefined;
        const label = status ? `${this.fmt.month(month)} · ${OUTCOME_LABELS[status]}` : this.fmt.month(month);
        this.setFilter({ month, status }, label);
    }

    handleFunnelClick(event) {
        const data = event.detail.data;
        if (data && data.stage) {
            this.setFilter({ stage: data.stage, status: 'OPEN' }, `단계: ${data.name}`);
        }
    }

    handleSankeyClick(event) {
        const data = event.detail.data || {};
        if (event.detail.dataType === 'edge') {
            this.setFilter(
                { leadSource: data.sourceKey, status: data.outcome },
                `${data.sourceKey || NONE_LABEL} → ${OUTCOME_LABELS[data.outcome]}`
            );
        } else if (data.outcome) {
            this.setFilter({ status: data.outcome }, `결과: ${OUTCOME_LABELS[data.outcome]}`);
        } else if (data.sourceKey !== undefined) {
            this.setFilter({ leadSource: data.sourceKey }, `Lead Source: ${data.sourceKey || NONE_LABEL}`);
        }
    }

    handleTreemapClick(event) {
        const data = event.detail.data || {};
        if (data.accountId) {
            this.setFilter({ accountId: data.accountId, status: 'WON' }, `거래처: ${data.name}`);
        } else if (data.industry !== undefined) {
            this.setFilter({ industry: data.industry, status: 'WON' }, `산업: ${data.name}`);
        }
    }

    handleCalendarClick(event) {
        const value = event.detail.value;
        if (Array.isArray(value)) {
            this.setFilter({ day: value[0], status: 'WON' }, `수주일: ${value[0]}`);
        }
    }

    handleScatterClick(event) {
        const data = event.detail.data;
        if (data && data.id) {
            this[NavigationMixin.Navigate]({
                type: 'standard__recordPage',
                attributes: { recordId: data.id, objectApiName: 'Opportunity', actionName: 'view' }
            });
        }
    }
}
