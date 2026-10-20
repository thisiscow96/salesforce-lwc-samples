import { createElement } from 'lwc';
import Echart from 'c/echart';
import { loadScript } from 'lightning/platformResourceLoader';

const realEcharts = require('../../../staticresources/echarts.js');

jest.mock('lightning/platformResourceLoader', () => ({ loadScript: jest.fn() }), { virtual: true });

let charts;

function installEcharts() {
    charts = [];
    window.echarts = {
        init: jest.fn(() => {
            const chart = realEcharts.init(null, null, { renderer: 'svg', ssr: true, width: 600, height: 300 });
            charts.push(chart);
            return chart;
        })
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0)); // eslint-disable-line @lwc/lwc/no-async-operation

const BAR = { xAxis: { type: 'category', data: ['A', 'B'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [1, 2] }] };

async function mount(props = {}) {
    const el = createElement('c-echart', { is: Echart });
    Object.assign(el, props);
    document.body.appendChild(el);
    await flush();
    await flush();
    return el;
}

describe('c-echart', () => {
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

    it('라이브러리 로드 후 option을 그리고 높이를 적용한다', async () => {
        const el = await mount({ option: BAR, height: '250px' });
        expect(charts).toHaveLength(1);
        expect(charts[0].getOption().series[0].data).toEqual([1, 2]);
        expect(el.shadowRoot.querySelector('div.chart').style.height).toBe('250px');
    });

    it('초기화 후 option이 바뀌면 이전 시리즈 없이 교체한다', async () => {
        const el = await mount({ option: BAR });
        el.option = { ...BAR, series: [{ type: 'line', data: [3, 4] }] };
        expect(charts[0].getOption().series).toHaveLength(1);
        expect(charts[0].getOption().series[0].type).toBe('line');
    });

    it('읽기 전용 option(부모가 넘긴 Proxy)도 formatter 함수를 보존해 적용한다', async () => {
        const formatter = jest.fn(() => 'x');
        const frozen = Object.freeze({ ...BAR, yAxis: Object.freeze({ type: 'value', axisLabel: { formatter } }) });
        await mount({ option: frozen });
        expect(charts[0].getOption().yAxis[0].axisLabel.formatter).toBe(formatter);
    });

    it('차트 클릭을 chartclick 이벤트로 전달한다', async () => {
        const el = await mount({ option: BAR });
        const handler = jest.fn();
        el.addEventListener('chartclick', handler);
        charts[0].trigger('click', { componentType: 'series', seriesId: 's1', dataIndex: 1, name: 'B', value: 2, data: 2 });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0][0].detail).toMatchObject({ seriesId: 's1', dataIndex: 1, name: 'B', value: 2 });
    });

    it('라이브러리 로드 실패 시 에러 문구를 표시한다', async () => {
        loadScript.mockRejectedValue(new Error('404'));
        console.error.mockImplementation(() => {});
        const el = await mount({ option: BAR });
        expect(el.shadowRoot.querySelector('.slds-text-color_error')).not.toBeNull();
    });

    it('화면에서 제거되면 dispose 한다', async () => {
        const el = await mount({ option: BAR });
        const spy = jest.spyOn(charts[0], 'dispose');
        document.body.removeChild(el);
        expect(spy).toHaveBeenCalled();
    });
});
