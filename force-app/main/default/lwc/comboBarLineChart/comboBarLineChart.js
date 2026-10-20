import { LightningElement } from 'lwc';
import { loadScript } from 'lightning/platformResourceLoader';
import CHARTJS from '@salesforce/resourceUrl/chartjs';

// Chart.js 샘플 사이트의 Utils(months, numbers, CHART_COLORS, transparentize)를 대체하는 최소 구현
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

const CHART_COLORS = {
    red: 'rgb(255, 99, 132)',
    orange: 'rgb(255, 159, 64)',
    yellow: 'rgb(255, 205, 86)',
    green: 'rgb(75, 192, 192)',
    blue: 'rgb(54, 162, 235)',
    purple: 'rgb(153, 102, 255)',
    grey: 'rgb(201, 203, 207)'
};
const NAMED_COLORS = Object.values(CHART_COLORS);

const DATA_COUNT = 7;
const NUMBER_CFG = { count: DATA_COUNT, min: -100, max: 100 };

const EASINGS = ['linear', 'easeOutQuart', 'easeInOutCubic', 'easeOutBounce', 'easeOutElastic', 'easeInOutBack', 'easeInQuad'];

function months(count) {
    return Array.from({ length: count }, (_, i) => MONTHS[i % MONTHS.length]);
}

function numbers({ count, min, max }) {
    return Array.from({ length: count }, () => Math.round(min + Math.random() * (max - min)));
}

// 'rgb(r, g, b)' → 'rgba(r, g, b, alpha)'. 샘플과 동일하게 opacity 0.5 = 알파 0.5
function transparentize(color, opacity = 0.5) {
    return color.replace('rgb(', 'rgba(').replace(')', `, ${1 - opacity})`);
}

export default class ComboBarLineChart extends LightningElement {
    chart;
    chartjsLoaded = false;
    errorMessage;

    // 애니메이션 설정 (Chart.js options.animation / options.animations)
    animationEnabled = true;
    easing = 'easeOutQuart'; // Chart.js 기본값
    duration = 1000; // Chart.js 기본값(ms)
    progressive = false;
    loopLine = false;

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
        // renderedCallback은 재렌더링마다 호출되므로 라이브러리 로드는 한 번만 수행
        if (this.chartjsLoaded) {
            return;
        }
        this.chartjsLoaded = true;

        loadScript(this, CHARTJS)
            .then(() => this.initializeChart())
            .catch((error) => {
                // 사용자에게는 짧은 메시지, 상세 원인은 콘솔 로그로 분리
                this.errorMessage = 'Chart.js를 불러오지 못했습니다. Static Resource(chartjs) 배포 여부를 확인하세요.';
                console.error('Chart.js load error', error);
            });
    }

    disconnectedCallback() {
        // 컴포넌트가 사라질 때 Chart 인스턴스를 정리해 메모리 누수 방지
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }

    initializeChart() {
        const canvas = this.template.querySelector('canvas.chart');
        const data = {
            labels: months(DATA_COUNT),
            datasets: [
                {
                    label: 'Dataset 1',
                    data: numbers(NUMBER_CFG),
                    borderColor: CHART_COLORS.red,
                    backgroundColor: transparentize(CHART_COLORS.red, 0.5),
                    order: 1
                },
                {
                    label: 'Dataset 2',
                    data: numbers(NUMBER_CFG),
                    borderColor: CHART_COLORS.blue,
                    backgroundColor: transparentize(CHART_COLORS.blue, 0.5),
                    type: 'line',
                    order: 0
                }
            ]
        };

        // loadScript로 불러온 UMD 번들은 window.Chart로 노출됨
        this.chart = new window.Chart(canvas.getContext('2d'), {
            type: 'bar',
            data,
            options: {
                responsive: true,
                maintainAspectRatio: false, // 컨테이너(CSS) 높이에 맞춤
                plugins: {
                    legend: { position: 'top' },
                    title: { display: true, text: 'Chart.js Combined Line/Bar Chart' }
                },
                ...this.buildAnimationOptions()
            }
        });
    }

    // 화면의 애니메이션 설정을 Chart.js 옵션 형태로 변환
    buildAnimationOptions() {
        if (!this.animationEnabled) {
            return { animation: false, animations: {} };
        }
        const animation = { duration: this.duration, easing: this.easing };

        if (this.progressive) {
            // 데이터 포인트마다 지연을 줘서 순서대로 등장 (Chart.js 'Delay' 샘플 방식)
            animation.delay = (ctx) => (ctx.type === 'data' && ctx.mode === 'default'
                ? ctx.dataIndex * 150 + ctx.datasetIndex * 100
                : 0);
        }

        // 선(Line)의 곡률(tension)을 무한 반복 (Chart.js 'Looping tension' 샘플 방식)
        const animations = this.loopLine
            ? { tension: { duration: 1000, easing: 'linear', from: 1, to: 0, loop: true } }
            : {};

        return { animation, animations };
    }

    applyAnimationOptions(replay = false) {
        if (!this.chart) {
            return;
        }
        const { animation, animations } = this.buildAnimationOptions();
        // 실행 중인 애니메이션(특히 loop)을 먼저 멈춰야 옵션 변경이 즉시 반영됨
        this.chart.stop();
        this.chart.options.animation = animation;
        this.chart.options.animations = animations;
        if (replay) {
            // reset 후 update하면 처음부터 다시 애니메이션 재생
            this.chart.reset();
        }
        this.chart.update();
    }

    // ===== 샘플 사이트 Actions =====
    handleRandomize() {
        this.chart.data.datasets.forEach((dataset) => {
            dataset.data = numbers({ count: this.chart.data.labels.length, min: -100, max: 100 });
        });
        this.chart.update();
    }

    handleAddDataset() {
        const data = this.chart.data;
        const color = NAMED_COLORS[data.datasets.length % NAMED_COLORS.length];
        data.datasets.push({
            label: `Dataset ${data.datasets.length + 1}`,
            backgroundColor: transparentize(color, 0.5),
            borderColor: color,
            borderWidth: 1,
            data: numbers({ count: data.labels.length, min: -100, max: 100 })
        });
        this.chart.update();
    }

    handleAddData() {
        const data = this.chart.data;
        if (data.datasets.length > 0) {
            data.labels = months(data.labels.length + 1);
            data.datasets.forEach((dataset) => {
                dataset.data.push(numbers({ count: 1, min: -100, max: 100 })[0]);
            });
            this.chart.update();
        }
    }

    handleRemoveDataset() {
        this.chart.data.datasets.pop();
        this.chart.update();
    }

    handleRemoveData() {
        const data = this.chart.data;
        data.labels.splice(-1, 1);
        data.datasets.forEach((dataset) => dataset.data.pop());
        this.chart.update();
    }

    // ===== 애니메이션 설정 =====
    handleAnimationToggle(event) {
        this.animationEnabled = event.target.checked;
        this.applyAnimationOptions();
    }

    handleEasingChange(event) {
        this.easing = event.detail.value;
        this.applyAnimationOptions(true);
    }

    handleDurationChange(event) {
        this.duration = Number(event.detail.value);
        this.applyAnimationOptions(true);
    }

    handleProgressiveToggle(event) {
        this.progressive = event.target.checked;
        this.applyAnimationOptions(true);
    }

    handleLoopToggle(event) {
        this.loopLine = event.target.checked;
        this.applyAnimationOptions();
    }

    handleReplay() {
        this.applyAnimationOptions(true);
    }
}
