import { createElement } from 'lwc';
import ComboBarLineChart from 'c/comboBarLineChart';
import { loadScript } from 'lightning/platformResourceLoader';

jest.mock('lightning/platformResourceLoader', () => ({ loadScript: jest.fn() }), { virtual: true });

// jsdom에는 canvas 렌더링이 없어 Chart 생성자만 대체하고, 넘긴 config를 검증
let instances;
class FakeChart {
    constructor(ctx, config) {
        this.config = config;
        this.data = config.data;
        this.options = config.options;
        this.update = jest.fn();
        this.reset = jest.fn();
        this.stop = jest.fn();
        this.destroy = jest.fn();
        instances.push(this);
    }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0)); // eslint-disable-line @lwc/lwc/no-async-operation

async function mount() {
    const el = createElement('c-combo-bar-line-chart', { is: ComboBarLineChart });
    document.body.appendChild(el);
    await flush();
    await flush();
    return el;
}

function clickButton(el, label) {
    [...el.shadowRoot.querySelectorAll('lightning-button')].find((b) => b.label === label).click();
}

describe('c-combo-bar-line-chart', () => {
    beforeEach(() => {
        instances = [];
        window.Chart = FakeChart;
        loadScript.mockResolvedValue();
    });

    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        delete window.Chart;
    });

    it('마운트 시 오류 없이 bar + line 콤보 차트를 생성한다', async () => {
        await mount();
        expect(instances).toHaveLength(1);
        const { config } = instances[0];
        expect(config.type).toBe('bar');
        expect(config.data.datasets.map((d) => d.type || 'bar')).toEqual(['bar', 'line']);
        expect(config.options.maintainAspectRatio).toBe(false);
    });

    it('Actions 버튼이 데이터를 바꾸고 update를 호출한다', async () => {
        const el = await mount();
        const chart = instances[0];
        clickButton(el, 'Add Dataset');
        expect(chart.data.datasets).toHaveLength(3);
        clickButton(el, 'Add Data');
        expect(chart.data.labels).toHaveLength(8);
        clickButton(el, 'Remove Data');
        clickButton(el, 'Remove Dataset');
        clickButton(el, 'Randomize');
        expect(chart.data.datasets).toHaveLength(2);
        expect(chart.update).toHaveBeenCalled();
    });

    it('라이브러리 로드 실패 시 에러 메시지를 표시한다', async () => {
        loadScript.mockRejectedValue(new Error('404'));
        console.error.mockImplementation(() => {});
        const el = await mount();
        expect(el.shadowRoot.querySelector('.slds-text-color_error').textContent).toContain('Chart.js');
    });

    it('화면에서 제거되면 차트를 destroy 한다', async () => {
        const el = await mount();
        document.body.removeChild(el);
        expect(instances[0].destroy).toHaveBeenCalled();
    });
});
