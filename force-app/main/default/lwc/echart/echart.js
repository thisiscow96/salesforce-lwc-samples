import { LightningElement, api } from 'lwc';
import { loadScript } from 'lightning/platformResourceLoader';
import ECHARTS from '@salesforce/resourceUrl/echarts';

/**
 * 재사용 ECharts 래퍼
 * - 부모는 option(@api)만 넘기면 됨: 라이브러리 로드, 초기화, 크기 변경 대응, 정리를 이 컴포넌트가 담당
 * - 차트 클릭은 'chartclick' 이벤트로 부모에 전달 (드릴다운용)
 * - lifecycle 예약어(render 등)와 겹치지 않도록 내부 메서드는 applyXxx, initializeXxx 형태로 명명
 */

// LWC가 @api로 넘긴 객체는 읽기 전용 Proxy라 ECharts가 내부에서 값을 쓰면 오류가 남
// → formatter 함수는 보존하면서 일반 객체로 깊은 복사
function deepClone(value) {
    if (Array.isArray(value)) {
        return value.map(deepClone);
    }
    if (value && typeof value === 'object') {
        const copy = {};
        Object.keys(value).forEach((key) => {
            copy[key] = deepClone(value[key]);
        });
        return copy;
    }
    return value;
}

// 클릭 이벤트에서 부모가 쓰는 값만 골라 직렬화 가능한 형태로 전달
function toClickDetail(params) {
    return {
        componentType: params.componentType,
        seriesType: params.seriesType,
        seriesId: params.seriesId,
        seriesName: params.seriesName,
        dataType: params.dataType,
        dataIndex: params.dataIndex,
        name: params.name,
        value: deepClone(params.value),
        data: deepClone(params.data)
    };
}

export default class Echart extends LightningElement {
    @api height = '320px';

    chart;
    errorMessage;
    scriptRequested = false;
    resizeObserver;
    _option;
    _loading = false;

    @api
    get option() {
        return this._option;
    }
    set option(value) {
        this._option = value;
        this.applyOption();
    }

    @api
    get loading() {
        return this._loading;
    }
    set loading(value) {
        this._loading = value;
        this.applyLoading();
    }

    get containerStyle() {
        return `height: ${this.height};`;
    }

    renderedCallback() {
        if (this.scriptRequested) {
            return;
        }
        this.scriptRequested = true;
        // 같은 리소스는 platformResourceLoader가 한 번만 내려받으므로 차트가 여러 개여도 중복 로드 없음
        loadScript(this, ECHARTS)
            .then(() => this.initializeChart())
            .catch((error) => {
                this.errorMessage = '차트 라이브러리(ECharts)를 불러오지 못했습니다.';
                console.error('ECharts load error', error);
            });
    }

    disconnectedCallback() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.chart) {
            this.chart.dispose();
            this.chart = null;
        }
        this.scriptRequested = false;
    }

    initializeChart() {
        const container = this.template.querySelector('div.chart');
        if (!container || this.chart) {
            return;
        }
        this.chart = window.echarts.init(container, null, { renderer: 'canvas' });
        this.chart.on('click', (params) => {
            this.dispatchEvent(new CustomEvent('chartclick', { detail: toClickDetail(params) }));
        });
        // 창 크기뿐 아니라 카드 폭 변화(화면 분할, 사이드바 열고 닫기)에도 맞추도록 컨테이너 자체를 감시
        if (typeof ResizeObserver === 'function') {
            this.resizeObserver = new ResizeObserver(() => {
                if (this.chart) {
                    this.chart.resize();
                }
            });
            this.resizeObserver.observe(container);
        }
        this.applyLoading();
        this.applyOption();
    }

    applyOption() {
        if (this.chart && this._option) {
            // notMerge=true: 이전 option의 시리즈가 남지 않도록 통째로 교체
            this.chart.setOption(deepClone(this._option), true);
        }
    }

    applyLoading() {
        if (!this.chart) {
            return;
        }
        if (this._loading) {
            this.chart.showLoading();
        } else {
            this.chart.hideLoading();
        }
    }
}
