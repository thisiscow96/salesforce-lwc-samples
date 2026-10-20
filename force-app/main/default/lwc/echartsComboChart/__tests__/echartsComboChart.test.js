import { createElement } from 'lwc';
import EchartsComboChart from 'c/echartsComboChart';
import { loadScript } from 'lightning/platformResourceLoader';

// 배포하는 Static Resource 원본(echarts.js)을 그대로 사용해 실제 렌더링까지 검증
const realEcharts = require('../../../staticresources/echarts.js');

jest.mock('lightning/platformResourceLoader', () => ({ loadScript: jest.fn() }), { virtual: true });

let charts;

// jsdom에는 canvas가 없으므로 ECharts SSR(SVG) 모드로 같은 option을 실제로 그려 봄
function installEcharts() {
    charts = [];
    window.echarts = {
        graphic: realEcharts.graphic,
        init: jest.fn(() => {
            const chart = realEcharts.init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 440 });
            charts.push(chart);
            return chart;
        })
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0)); // eslint-disable-line @lwc/lwc/no-async-operation

async function mount() {
    const el = createElement('c-echarts-combo-chart', { is: EchartsComboChart });
    document.body.appendChild(el);
    await flush();
    await flush();
    return el;
}

function clickButton(el, label) {
    [...el.shadowRoot.querySelectorAll('lightning-button')].find((b) => b.label === label).click();
}

describe('c-echarts-combo-chart', () => {
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

    it('마운트 시 오류 없이 ECharts를 초기화하고 막대·선 시리즈를 그린다', async () => {
        await mount();

        expect(window.echarts.init).toHaveBeenCalledTimes(1);
        const option = charts[0].getOption();
        expect(option.series.map((s) => s.type)).toEqual(['bar', 'line']);
        expect(option.xAxis[0].data).toHaveLength(7);
        // 실제 SVG 출력에 도형이 그려졌는지 확인 (option이 잘못되면 축만 있는 빈 차트가 나옴)
        expect(charts[0].renderToSVGString()).toContain('<path');
    });

    it('Actions 버튼이 데이터셋/데이터 수를 바꾼다', async () => {
        const el = await mount();

        clickButton(el, 'Add Dataset');
        expect(charts[0].getOption().series).toHaveLength(3);
        clickButton(el, 'Add Data');
        expect(charts[0].getOption().xAxis[0].data).toHaveLength(8);
        clickButton(el, 'Remove Data');
        expect(charts[0].getOption().xAxis[0].data).toHaveLength(7);
        clickButton(el, 'Remove Dataset');
        expect(charts[0].getOption().series).toHaveLength(2);
        clickButton(el, 'Randomize');
        expect(charts[0].renderToSVGString()).toContain('<path');
    });

    it('애니메이션·dataZoom 설정이 option에 반영된다', async () => {
        const el = await mount();
        const zoom = [...el.shadowRoot.querySelectorAll('lightning-input')].find((i) => i.label.startsWith('확대'));
        zoom.checked = true;
        zoom.dispatchEvent(new CustomEvent('change'));
        expect(charts[0].getOption().dataZoom).toHaveLength(2);

        const easing = el.shadowRoot.querySelector('lightning-combobox');
        easing.dispatchEvent(new CustomEvent('change', { detail: { value: 'bounceOut' } }));
        expect(charts[0].getOption().animationEasing).toBe('bounceOut');
    });

    it('라이브러리 로드 실패 시 에러 메시지를 표시한다', async () => {
        loadScript.mockRejectedValue(new Error('404'));
        console.error.mockImplementation(() => {}); // 이 테스트는 의도된 console.error
        const el = await mount();
        expect(el.shadowRoot.querySelector('.slds-text-color_error').textContent).toContain('ECharts');
    });

    it('화면에서 제거되면 차트를 dispose 한다', async () => {
        const el = await mount();
        const spy = jest.spyOn(charts[0], 'dispose');
        document.body.removeChild(el);
        expect(spy).toHaveBeenCalled();
    });
});
