import { LightningElement } from 'lwc';
import { loadScript } from 'lightning/platformResourceLoader';
import ECHARTS from '@salesforce/resourceUrl/echarts';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

// Chart.js 샘플과 색을 맞춰 두 화면을 비교하기 쉽게 함
const PALETTE = ['#FF6384', '#36A2EB', '#FFCD56', '#4BC0C0', '#9966FF', '#FF9F40', '#C9CBCF'];

const DATA_COUNT = 7;

// ECharts 내장 easing 이름 (https://echarts.apache.org/examples/en/editor.html?c=line-easing)
const EASINGS = ['linear', 'cubicOut', 'quarticOut', 'exponentialOut', 'sinusoidalInOut', 'backOut', 'elasticOut', 'bounceOut'];

function months(count) {
    return Array.from({ length: count }, (_, i) => MONTHS[i % MONTHS.length]);
}

function randomNumbers(count, min = -100, max = 100) {
    return Array.from({ length: count }, () => Math.round(min + Math.random() * (max - min)));
}

// '#RRGGBB' → 'rgba(r, g, b, a)' (그라데이션 끝 색을 투명하게 만들 때 사용)
function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export default class EchartsComboChart extends LightningElement {
    chart;
    echartsLoaded = false;
    errorMessage;

    // 차트 데이터는 컴포넌트가 보관하고, 바뀔 때마다 option을 다시 만들어 setOption
    labels = months(DATA_COUNT);
    datasets = [
        { name: 'Dataset 1', type: 'bar', color: PALETTE[0], data: randomNumbers(DATA_COUNT) },
        { name: 'Dataset 2', type: 'line', color: PALETTE[1], data: randomNumbers(DATA_COUNT) }
    ];

    // 애니메이션 설정 (ECharts animation* 옵션)
    animationEnabled = true;
    easing = 'cubicOut'; // ECharts 기본값
    duration = 1000; // ECharts 기본값(ms)
    progressive = false;
    zoomEnabled = false;

    resizeHandler = () => {
        if (this.chart) {
            this.chart.resize();
        }
    };

    get easingOptions() {
        return EASINGS.map((e) => ({ label: e, value: e }));
    }

    get isNotReady() {
        return !this.chart;
    }

    get isAnimationOff() {
        return !this.animationEnabled;
    }

    get isReplayDisabled() {
        return !this.chart || !this.animationEnabled;
    }

    renderedCallback() {
        // 라이브러리 로드는 최초 1회만
        if (this.echartsLoaded) {
            return;
        }
        this.echartsLoaded = true;

        loadScript(this, ECHARTS)
            .then(() => this.initializeChart())
            .catch((error) => {
                this.errorMessage = 'ECharts를 불러오지 못했습니다. Static Resource(echarts) 배포 여부를 확인하세요.';
                console.error('ECharts load error', error);
            });
    }

    disconnectedCallback() {
        // 리스너와 차트 인스턴스를 정리해 메모리 누수 방지
        window.removeEventListener('resize', this.resizeHandler);
        if (this.chart) {
            this.chart.dispose();
            this.chart = null;
        }
    }

    initializeChart() {
        const container = this.template.querySelector('div.chart-container');
        // loadScript로 불러온 UMD 번들은 window.echarts로 노출됨
        this.chart = window.echarts.init(container, null, { renderer: 'canvas' });
        this.renderChart(true);
        // ECharts는 컨테이너 크기 변화를 자동 감지하지 않으므로 창 크기 변경 시 직접 resize
        window.addEventListener('resize', this.resizeHandler);
    }

    // 컴포넌트 상태 → ECharts option 변환
    buildOption() {
        const echarts = window.echarts;
        const series = this.datasets.map((ds, index) => {
            const common = {
                name: ds.name,
                type: ds.type,
                data: ds.data,
                // 선(Line)이 막대 위에 그려지도록 Chart.js의 order 개념을 z로 대응
                z: ds.type === 'line' ? 3 : 2,
                emphasis: { focus: 'series' }
            };
            if (ds.type === 'line') {
                return {
                    ...common,
                    smooth: true,
                    symbol: 'circle',
                    symbolSize: 8,
                    lineStyle: { width: 3, color: ds.color, shadowColor: hexToRgba(ds.color, 0.4), shadowBlur: 8 },
                    itemStyle: { color: ds.color },
                    // 선 아래를 그라데이션으로 채워 입체감 부여
                    areaStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: hexToRgba(ds.color, 0.35) },
                            { offset: 1, color: hexToRgba(ds.color, 0.02) }
                        ])
                    }
                };
            }
            return {
                ...common,
                barMaxWidth: 36,
                itemStyle: {
                    borderRadius: [6, 6, 0, 0],
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: hexToRgba(ds.color, 0.95) },
                        { offset: 1, color: hexToRgba(ds.color, 0.35) }
                    ])
                },
                // 순차 등장: 막대마다 지연 (데이터 index + 시리즈 index 기준)
                animationDelay: this.progressive ? (idx) => idx * 120 + index * 80 : 0
            };
        });

        return {
            animation: this.animationEnabled,
            animationDuration: this.duration,
            animationEasing: this.easing,
            animationDurationUpdate: this.duration,
            animationEasingUpdate: this.easing,
            animationDelay: this.progressive ? (idx) => idx * 120 : 0,
            title: { text: 'ECharts Combined Line/Bar Chart', left: 'center', textStyle: { fontSize: 14 } },
            tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
            legend: { top: 28 },
            // 툴바: 이미지 저장, 데이터 보기, 선/막대 전환, 초기화
            toolbox: {
                right: 10,
                feature: {
                    dataView: { readOnly: true },
                    magicType: { type: ['line', 'bar'] },
                    restore: {},
                    saveAsImage: {}
                }
            },
            grid: { left: 50, right: 30, top: 70, bottom: this.zoomEnabled ? 70 : 40 },
            xAxis: { type: 'category', data: this.labels, axisTick: { alignWithLabel: true } },
            yAxis: { type: 'value', splitLine: { lineStyle: { type: 'dashed' } } },
            dataZoom: this.zoomEnabled ? [{ type: 'inside' }, { type: 'slider', height: 20, bottom: 20 }] : [],
            series
        };
    }

    // replay=true면 clear 후 다시 그려 등장 애니메이션을 처음부터 재생
    renderChart(replay = false) {
        if (!this.chart) {
            return;
        }
        if (replay) {
            this.chart.clear();
        }
        // notMerge=true: 시리즈 삭제 등이 정확히 반영되도록 옵션을 통째로 교체
        this.chart.setOption(this.buildOption(), true);
    }

    // ===== Chart.js 샘플과 같은 Actions =====
    handleRandomize() {
        this.datasets = this.datasets.map((ds) => ({ ...ds, data: randomNumbers(this.labels.length) }));
        this.renderChart();
    }

    handleAddDataset() {
        const n = this.datasets.length;
        this.datasets = [...this.datasets, {
            name: `Dataset ${n + 1}`,
            type: 'bar',
            color: PALETTE[n % PALETTE.length],
            data: randomNumbers(this.labels.length)
        }];
        this.renderChart();
    }

    handleAddData() {
        if (this.datasets.length === 0) {
            return;
        }
        this.labels = months(this.labels.length + 1);
        this.datasets = this.datasets.map((ds) => ({ ...ds, data: [...ds.data, randomNumbers(1)[0]] }));
        this.renderChart();
    }

    handleRemoveDataset() {
        this.datasets = this.datasets.slice(0, -1);
        this.renderChart();
    }

    handleRemoveData() {
        this.labels = this.labels.slice(0, -1);
        this.datasets = this.datasets.map((ds) => ({ ...ds, data: ds.data.slice(0, -1) }));
        this.renderChart();
    }

    // ===== 애니메이션 · 확대 설정 =====
    handleAnimationToggle(event) {
        this.animationEnabled = event.target.checked;
        this.renderChart();
    }

    handleEasingChange(event) {
        this.easing = event.detail.value;
        this.renderChart(true);
    }

    handleDurationChange(event) {
        this.duration = Number(event.detail.value);
        this.renderChart(true);
    }

    handleProgressiveToggle(event) {
        this.progressive = event.target.checked;
        this.renderChart(true);
    }

    handleZoomToggle(event) {
        this.zoomEnabled = event.target.checked;
        this.renderChart();
    }

    handleReplay() {
        this.renderChart(true);
    }
}
