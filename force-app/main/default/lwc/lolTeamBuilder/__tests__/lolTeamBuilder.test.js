import { createElement } from 'lwc';
import LolTeamBuilder from 'c/lolTeamBuilder';
import { loadScript } from 'lightning/platformResourceLoader';
import getBuilderData from '@salesforce/apex/LolTeamBuilderController.getBuilderData';
import startAnalysis from '@salesforce/apexContinuation/LolTeamBuilderController.startAnalysis';
import submitAnalysisRequest from '@salesforce/apex/LolTeamBuilderController.submitAnalysisRequest';
import getAnalysisRequest from '@salesforce/apex/LolTeamBuilderController.getAnalysisRequest';
import getRecentRequests from '@salesforce/apex/LolTeamBuilderController.getRecentRequests';

const realXlsx = require('../../../staticresources/sheetjs.js');
const { builderData } = require('./data/fixtures');

jest.mock('lightning/platformResourceLoader', () => ({ loadScript: jest.fn() }), { virtual: true });
jest.mock(
    '@salesforce/apex/LolTeamBuilderController.getBuilderData',
    () => {
        const { createApexTestWireAdapter } = require('@salesforce/sfdx-lwc-jest');
        return { default: createApexTestWireAdapter(jest.fn()) };
    },
    { virtual: true }
);
jest.mock('@salesforce/apexContinuation/LolTeamBuilderController.startAnalysis', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/LolTeamBuilderController.submitAnalysisRequest', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/LolTeamBuilderController.getAnalysisRequest', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/LolTeamBuilderController.getRecentRequests', () => ({ default: jest.fn() }), { virtual: true });

// 가짜 타이머 사용 중에도 Promise 체인만 진행시키는 헬퍼
const microtasks = async () => {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve(); // eslint-disable-line no-await-in-loop
    }
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0)); // eslint-disable-line @lwc/lwc/no-async-operation
const $ = (el, selector) => el.shadowRoot.querySelector(selector);
const $$ = (el, selector) => [...el.shadowRoot.querySelectorAll(selector)];
const pickBox = (el, lane) => $(el, `lightning-combobox.pick[data-lane="${lane}"]`);

async function mount(mode = 'CLAUDE_CODE') {
    const el = createElement('c-lol-team-builder', { is: LolTeamBuilder });
    document.body.appendChild(el);
    getBuilderData.emit(builderData(mode));
    await flush();
    await flush();
    return el;
}

describe('c-lol-team-builder', () => {
    beforeEach(() => {
        loadScript.mockResolvedValue();
        getRecentRequests.mockResolvedValue([]);
        window.echarts = { init: jest.fn(() => ({ setOption: jest.fn(), resize: jest.fn(), dispose: jest.fn(), on: jest.fn(), showLoading: jest.fn(), hideLoading: jest.fn() })) };
    });

    afterEach(() => {
        jest.useRealTimers();
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        delete window.echarts;
        delete window.XLSX;
        jest.clearAllMocks();
    });

    it('첫 화면에 탐색 1위 조합과 기본 실력(팀 설정)을 채우고 점수·근거·조합표를 보여 준다', async () => {
        const el = await mount();

        expect(pickBox(el, 'TOP').value).toBeTruthy();
        expect($(el, 'lightning-combobox.tier[data-lane="MID"]').value).toBe('MASTER_500');
        expect($(el, 'lightning-combobox.tier[data-lane="TOP"]').value).toBe('EMERALD_LOW');
        expect(Number($(el, '.total').textContent)).toBeGreaterThan(80);
        expect($$(el, '.category')).toHaveLength(8);
        expect($$(el, '.strengths li').length).toBeGreaterThan(0);
        expect($$(el, '.strengths li').map((li) => li.textContent).join('\n')).toContain('1탱 1브루저');

        const combos = $(el, '.combo-table').data;
        expect(combos).toHaveLength(30);
        expect(combos[0].rank).toBe(1);
        expect($(el, '.search-summary').textContent).toContain('1탱+1브루저만');
        expect($(el, 'c-echart.radar').option.series[0].type).toBe('radar');
        expect($$(el, 'lightning-tab')).toHaveLength(5);
    });

    it('픽을 바꾸면 점수가 다시 계산되고, 교체 추천 적용으로 점수가 오른다', async () => {
        const el = await mount();
        const best = Number($(el, '.total').textContent);

        pickBox(el, 'SUPPORT').dispatchEvent(new CustomEvent('change', { detail: { value: 'Yuumi_Support' } }));
        pickBox(el, 'ADC').dispatchEvent(new CustomEvent('change', { detail: { value: 'Kalista_Adc' } }));
        await flush();
        const worse = Number($(el, '.total').textContent);
        expect(worse).toBeLessThan(best);
        expect($$(el, '.weaknesses li').map((li) => li.textContent).join('\n')).toContain('칼리스타');

        $(el, '.swap lightning-button').click();
        await flush();
        expect(Number($(el, '.total').textContent)).toBeGreaterThan(worse);
    });

    it('라인 고정 후 탐색하면 조합표가 고정 챔피언만 사용하고, 행 적용 시 선택이 바뀐다', async () => {
        const el = await mount();
        pickBox(el, 'ADC').dispatchEvent(new CustomEvent('change', { detail: { value: 'Caitlyn_Adc' } }));
        const lock = $(el, 'lightning-input.lock[data-lane="ADC"]');
        lock.checked = true;
        lock.dispatchEvent(new CustomEvent('change'));
        $(el, '.search-button').click();
        await flush();

        const rows = $(el, '.combo-table').data;
        expect(rows.every((r) => r.ADC === '케이틀린')).toBe(true);

        $(el, '.combo-table').dispatchEvent(new CustomEvent('rowaction', { detail: { action: { name: 'apply' }, row: rows[2] } }));
        await flush();
        const selectedName = (lane) => {
            const box = pickBox(el, lane);
            return box.options.find((o) => o.value === box.value).label.split(' · ')[0];
        };
        ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'].forEach((lane) => expect(selectedName(lane)).toBe(rows[2][lane]));
    });

    it('같은 챔피언을 두 라인에 고르면 점수 대신 경고를 보여 준다', async () => {
        const el = await mount();
        pickBox(el, 'TOP').dispatchEvent(new CustomEvent('change', { detail: { value: 'Chogath_Top' } }));
        pickBox(el, 'JUNGLE').dispatchEvent(new CustomEvent('change', { detail: { value: 'Chogath_Jungle' } }));
        await flush();
        expect($(el, '.total')).toBeNull();
        expect(el.shadowRoot.textContent).toContain('초가스이(가) 두 라인에 선택되었습니다');
        expect($(el, '.analyze-button').disabled).toBe(true);
    });

    it('API 모드: 서버에는 ID·티어·점수만 보내고 결과 텍스트와 출처를 표시한다', async () => {
        startAnalysis.mockResolvedValue({
            text: '■ 한줄 평가\n- 후반 하이퍼캐리 조합',
            sources: [{ title: 'OP.GG', url: 'https://op.gg/x' }],
            searchCount: 2,
            model: 'claude-sonnet-5-5',
            truncated: false
        });
        const el = await mount('API');
        $(el, '.analyze-button').click();
        await flush();

        const request = JSON.parse(startAnalysis.mock.calls[0][0].requestJson);
        expect(Object.keys(request).sort()).toEqual(['categoryPoints', 'picks', 'tiers', 'totalScore']);
        expect(request.picks.TOP).toMatch(/_Top$/);
        expect(request.tiers.ADC).toBe('MASTER_500');
        expect(Object.keys(request.categoryPoints)).toHaveLength(8);

        expect($(el, '.analysis-text').textContent).toContain('후반 하이퍼캐리 조합');
        const link = $(el, '.sources a');
        expect(link.href).toBe('https://op.gg/x');
        expect(link.rel).toContain('noopener');
        expect($(el, '.analysis-meta').textContent).toContain('웹 검색 2회');
    });

    it('API 모드: 분석 실패 시 서버가 준 안내 문구를 보여 준다', async () => {
        startAnalysis.mockRejectedValue({ body: { message: 'Claude API Key가 없거나 올바르지 않습니다.' } });
        const el = await mount('API');
        $(el, '.analyze-button').click();
        await flush();
        expect($(el, '.analysis-error').textContent).toContain('API Key');
        expect($(el, '.analyze-button').disabled).toBe(false);
    });

    it('Excel: 실제 SheetJS로 5개 시트를 만들고 조합 점수 시트가 화면 1위와 같다', async () => {
        loadScript.mockImplementation(() => {
            window.XLSX = realXlsx;
            return Promise.resolve();
        });
        const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const el = await mount();
        const firstRow = $(el, '.combo-table').data[0];

        $(el, '.export-button').click();
        await flush();

        const link = click.mock.instances[0];
        expect(link.download).toBe('lol_team_comp.xlsx');
        const wb = realXlsx.read(link.href.split(',')[1], { type: 'base64' });
        expect(wb.SheetNames).toEqual(['라인별 픽', '조합 점수', '현재 조합 분석', '점수 기준', '시너지 표']);
        const pool = realXlsx.utils.sheet_to_json(wb.Sheets['라인별 픽'], { header: 1 });
        expect(pool).toHaveLength(builderData().champions.length + 1);
        const combos = realXlsx.utils.sheet_to_json(wb.Sheets['조합 점수'], { header: 1 });
        expect(combos[1].slice(1, 6)).toEqual(['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'].map((l) => firstRow[l]));
        expect(combos[1][6]).toBe(firstRow.total);
        expect(combos.length).toBeGreaterThan(31); // Excel은 화면(30)보다 많은 100위까지
    });

    it('Claude Code 모드: 요청을 저장하고 10초마다 상태를 확인해 완료 결과를 표시한다', async () => {
        submitAnalysisRequest.mockResolvedValue('a01REQ');
        getAnalysisRequest
            .mockResolvedValueOnce({ Id: 'a01REQ', Name: 'LAR-00001', Status__c: 'Pending', Composition__c: '말파이트 / 오공 / 요네 / 징크스 / 세라핀' })
            .mockResolvedValueOnce({ Id: 'a01REQ', Name: 'LAR-00001', Status__c: 'Processing', Processed_By__c: 'Claude Code (PC)' })
            .mockResolvedValueOnce({
                Id: 'a01REQ',
                Name: 'LAR-00001',
                Status__c: 'Completed',
                Composition__c: '말파이트 / 오공 / 요네 / 징크스 / 세라핀',
                Result__c: '■ 한줄 평가\n- 한타 연계 최상',
                Sources_JSON__c: JSON.stringify([
                    { title: 'OP.GG', url: 'https://op.gg/a' },
                    { title: '악성', url: 'javascript:alert(1)' } // eslint-disable-line no-script-url
                ]),
                Search_Count__c: 3,
                Processed_By__c: 'Claude Code (PC)'
            });
        const el = await mount();
        expect($(el, '.analyze-button').label).toBe('Claude Code 분석 요청');
        jest.useFakeTimers();

        $(el, '.analyze-button').click();
        await microtasks();
        expect(JSON.parse(submitAnalysisRequest.mock.calls[0][0].requestJson).picks.TOP).toMatch(/_Top$/);
        expect(startAnalysis).not.toHaveBeenCalled();
        expect($(el, '.waiting-text').textContent).toContain('LAR-00001 대기 중');
        expect($(el, '.analyze-button').disabled).toBe(true); // 처리 중 중복 요청 방지

        jest.advanceTimersByTime(10000);
        await microtasks();
        expect($(el, '.waiting-text').textContent).toContain('분석 중');

        jest.advanceTimersByTime(10000);
        await microtasks();
        expect(getAnalysisRequest).toHaveBeenCalledTimes(3);
        expect($(el, '.waiting-text')).toBeNull();
        expect($(el, '.analysis-text').textContent).toContain('한타 연계 최상');
        expect($(el, '.analysis-meta').textContent).toContain('LAR-00001');
        expect($$(el, '.sources a').map((a) => a.href)).toEqual(['https://op.gg/a']); // javascript: 링크 제거
        expect($(el, '.analyze-button').disabled).toBe(false);

        jest.advanceTimersByTime(60000);
        await microtasks();
        expect(getAnalysisRequest).toHaveBeenCalledTimes(3); // 완료 후 폴링 중단
    });

    it('Claude Code 모드: 실패 상태는 사유를 보여 주고, 최근 요청에서 지난 결과를 열 수 있다', async () => {
        getRecentRequests.mockResolvedValue([
            { Id: 'a01OLD', Name: 'LAR-00007', Status__c: 'Completed', Composition__c: '오른 / 세주아니 / 요네 / 징크스 / 룰루', CreatedDate: '2026-10-19T08:00:00.000Z' },
            { Id: 'a01BAD', Name: 'LAR-00008', Status__c: 'Failed', Composition__c: '사이온 / 뽀삐 / 아리 / 칼리스타 / 유미', CreatedDate: '2026-10-19T09:00:00.000Z' }
        ]);
        getAnalysisRequest.mockImplementation(({ requestId }) =>
            Promise.resolve(
                requestId === 'a01OLD'
                    ? { Id: 'a01OLD', Name: 'LAR-00007', Status__c: 'Completed', Result__c: '지난 분석', Sources_JSON__c: '[]', Composition__c: '오른 / 세주아니 / 요네 / 징크스 / 룰루' }
                    : { Id: 'a01BAD', Name: 'LAR-00008', Status__c: 'Failed', Error_Message__c: '웹 검색 실패' }
            )
        );
        const el = await mount();
        await flush();

        const items = $$(el, '.recent-item');
        expect(items).toHaveLength(2);
        expect(items[0].textContent).toContain('완료');
        expect(items[1].textContent).toContain('실패');

        $$(el, '.open-request')[0].click();
        await flush();
        expect($(el, '.analysis-text').textContent).toBe('지난 분석');

        $$(el, '.open-request')[1].click();
        await flush();
        expect($(el, '.analysis-text')).toBeNull();
        expect($(el, '.analysis-error').textContent).toContain('LAR-00008 처리 실패: 웹 검색 실패');
    });

    it('Claude Code 모드: 권한 오류 등 저장 실패는 안내하고 대기 상태로 남지 않는다', async () => {
        submitAnalysisRequest.mockRejectedValue({ body: { message: '분석 요청을 저장하지 못했습니다. 권한 집합(LoL Team Builder User)을 확인하세요.' } });
        const el = await mount();
        $(el, '.analyze-button').click();
        await flush();
        expect($(el, '.analysis-error').textContent).toContain('LoL Team Builder User');
        expect($(el, '.waiting-text')).toBeNull();
        expect($(el, '.analyze-button').disabled).toBe(false);
    });

    it('공개 사이트 분석이 꺼져 있으면: 점수·조합표는 보이고 분석 버튼과 최근 요청은 숨긴다', async () => {
        const el = createElement('c-lol-team-builder', { is: LolTeamBuilder });
        document.body.appendChild(el);
        getBuilderData.emit(builderData('CLAUDE_CODE', false, true));
        await flush();
        await flush();

        expect(Number($(el, '.total').textContent)).toBeGreaterThan(80);
        expect($(el, '.combo-table').data.length).toBeGreaterThan(0);
        expect($(el, '.export-button')).not.toBeNull();
        expect($(el, '.analyze-button')).toBeNull();
        expect($(el, '.recent')).toBeNull();
        expect($(el, '.guest-note').textContent).toContain('꺼져 있습니다');
        expect(getRecentRequests).not.toHaveBeenCalled();
    });

    it('공개 사이트 방문자: 분석 버튼은 보이고, 최근 요청 목록 대신 공유·횟수 제한 안내를 보여 준다', async () => {
        submitAnalysisRequest.mockResolvedValue('a01GUEST');
        getAnalysisRequest.mockResolvedValue({ Id: 'a01GUEST', Name: 'LAR-00100', Status__c: 'Pending', Composition__c: 'x' });
        const el = createElement('c-lol-team-builder', { is: LolTeamBuilder });
        document.body.appendChild(el);
        getBuilderData.emit(builderData('CLAUDE_CODE', true, true));
        await flush();
        await flush();

        expect($(el, '.analyze-button')).not.toBeNull();
        expect($(el, '.recent')).toBeNull();
        expect($(el, '.guest-info').textContent).toContain('시간당');
        expect(getRecentRequests).not.toHaveBeenCalled();

        $(el, '.analyze-button').click();
        await flush();
        expect(submitAnalysisRequest).toHaveBeenCalledTimes(1);
        expect($(el, '.waiting-text').textContent).toContain('LAR-00100 대기 중');
        expect(getRecentRequests).not.toHaveBeenCalled(); // 요청 후에도 목록을 불러오지 않음
    });
});
