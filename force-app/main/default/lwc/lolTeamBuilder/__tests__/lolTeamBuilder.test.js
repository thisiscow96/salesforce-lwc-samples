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

jest.mock('lightning/platformResourceLoader', () => ({ loadScript: jest.fn(), loadStyle: jest.fn(() => Promise.resolve()) }), { virtual: true });
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
const pickBox = (el, lane) => $(el, `c-lol-picker.pick[data-lane="${lane}"]`);

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
        expect($(el, 'c-lol-picker.tier[data-lane="MID"]').value).toBe('MASTER_500');
        expect($(el, 'c-lol-picker.tier[data-lane="TOP"]').value).toBe('EMERALD_LOW');
        expect(Number($(el, '.total').textContent)).toBeGreaterThan(70);
        expect($$(el, '.category')).toHaveLength(7); // 실제 통계 1 + 조합 기본기 6
        expect($$(el, '.strengths li').length).toBeGreaterThan(0);
        expect($$(el, '.category-head')[0].textContent).toContain('개인 성능 (lol.ps)'); // 실제 통계 항목이 첫 줄

        const combos = $(el, '.combo-table').data;
        expect(combos).toHaveLength(30);
        expect(combos[0].rank).toBe(1);
        expect($(el, '.search-summary').textContent).not.toContain('1탱');
        expect($(el, '.structure-toggle')).toBeNull(); // 팀 목표 규칙 토글 제거
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
        const lock = $(el, 'button.lock[data-lane="ADC"]'); // 커스텀 토글 스위치
        expect(lock.getAttribute('aria-checked')).toBe('false');
        lock.click();
        await flush();
        expect($(el, 'button.lock[data-lane="ADC"]').getAttribute('aria-checked')).toBe('true');
        $(el, '.search-button').click();
        await flush();

        const rows = $(el, '.combo-table').data;
        expect(rows.every((r) => r.ADC === '케이틀린')).toBe(true);

        $(el, '.combo-table').dispatchEvent(new CustomEvent('rowaction', { detail: { action: { name: 'apply' }, row: rows[2] } }));
        await flush();
        const selectedName = (lane) => {
            const box = pickBox(el, lane);
            return box.options.find((o) => o.value === box.value).label.split(' · ')[0].replace(/^★ /, ''); // 선호 픽은 ★ 표시
        };
        ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'].forEach((lane) => expect(selectedName(lane)).toBe(rows[2][lane]));
    });

    it('라인 행: 커스텀 드롭다운(초상화·티어 배지)과 칩·미니 스탯·설명으로 챔피언 정보를 보여 주고, 웹폰트를 로드한다', async () => {
        const el = await mount();
        const { loadStyle } = require('lightning/platformResourceLoader');
        expect(loadStyle).toHaveBeenCalled();

        const picker = pickBox(el, 'MID');
        const opt = picker.options.find((o) => o.value === picker.value);
        expect(opt.icon).toContain('/img/champion/');
        expect(opt.badge).toBeTruthy();
        expect(opt.chips.length).toBeGreaterThan(0);

        // 닫힌 버튼에 선택한 챔피언 초상화·이름·배지
        const trigger = picker.shadowRoot.querySelector('.trigger');
        expect(trigger.querySelector('.icon').src).toContain('/img/champion/');
        expect(trigger.querySelector('.name').textContent).toBe(opt.name);
        expect(trigger.querySelector('.badge').textContent).toBe(opt.badge);

        // 펼치면 검색 가능한 목록, 검색어로 거르고 Enter로 선택 → change 이벤트
        const changes = [];
        picker.addEventListener('change', (e) => changes.push(e.detail.value));
        trigger.click();
        await flush();
        expect(picker.shadowRoot.querySelectorAll('.option').length).toBe(picker.options.length);
        const search = picker.shadowRoot.querySelector('.search-input');
        const target = picker.options.find((o) => o.value !== picker.value);
        search.value = target.name;
        search.dispatchEvent(new CustomEvent('input'));
        await flush();
        expect([...picker.shadowRoot.querySelectorAll('.option-name')].some((n) => n.textContent.startsWith(target.name))).toBe(true);
        search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        await flush();
        expect(changes[0]).toBeTruthy();
        expect(picker.shadowRoot.querySelector('.menu')).toBeNull(); // 선택 후 닫힘

        // 점으로 이어 붙인 문구 대신: 칩 / 승률·픽률·밴률 미니 스탯 / 설명 줄
        const row = $$(el, '.lane-row')[2];
        expect(row.querySelectorAll('.chip').length).toBeGreaterThan(0);
        expect([...row.querySelectorAll('.mini-stat-label')].map((n) => n.textContent)).toEqual(['승률', '픽률', '밴률']);
        expect(row.querySelector('.mini-stat-value').textContent).toMatch(/%$/);
        expect(row.textContent).not.toContain(' · 승률 ');
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
        expect(Object.keys(request.categoryPoints)).toHaveLength(7);

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
        expect(pool[0]).toEqual(expect.arrayContaining(['팀 선호', '픽률(%)', '밴률(%)', 'PS 점수', '꿀챔', '솔킬', '주도권', '오브젝트', '통계 출처']));
        const malphite = pool.find((r) => r[2] === '말파이트' && r[0] === '탑');
        expect(malphite[pool[0].indexOf('통계 출처')]).toContain('lol.ps');
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

    it('Claude Code 모드: 분석 이력에서 조합(라인별 아이콘)과 지난 결과를 보고, 실패 건은 사유를 보여 준다', async () => {
        getRecentRequests.mockResolvedValue([
            { Id: 'a01OLD', Name: 'LAR-00007', Status__c: 'Completed', Composition__c: '오른 / 세주아니 / 요네 / 징크스 / 룰루', Total_Score__c: 81.13, CreatedDate: '2026-10-19T08:00:00.000Z' },
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
        expect($(el, '.recent-title').textContent).toBe('분석 이력');
        // 조합: 라인 순서대로 챔피언 이름 + Data Dragon 아이콘, 점수
        const picks = [...items[0].querySelectorAll('.recent-pick')];
        expect(picks.map((p) => p.textContent)).toEqual(['탑오른', '정글세주아니', '미드요네', '원딜징크스', '서폿룰루']);
        expect(items[0].querySelector('.recent-icon').src).toContain('/img/champion/Ornn.png');
        expect(items[0].querySelector('.recent-score').textContent).toBe('81.1점');

        $$(el, '.open-request')[0].click();
        await flush();
        expect($(el, '.analysis-text').textContent).toBe('지난 분석');
        expect($$(el, '.recent-item')[0].className).toContain('recent-item_open'); // 지금 열린 이력 표시

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

        expect(Number($(el, '.total').textContent)).toBeGreaterThan(70);
        expect($(el, '.combo-table').data.length).toBeGreaterThan(0);
        expect($(el, '.export-button')).not.toBeNull();
        expect($(el, '.analyze-button')).toBeNull();
        expect($(el, '.recent')).toBeNull();
        expect($(el, '.guest-note').textContent).toContain('꺼져 있습니다');
        expect(getRecentRequests).not.toHaveBeenCalled();
    });

    it('공개 사이트 방문자: Apex REST로 요청하고(IP별 제한), 공유·횟수 제한 안내와 방문자 분석 이력을 보여 준다', async () => {
        global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'a01GUEST' }) }));
        getAnalysisRequest.mockResolvedValue({ Id: 'a01GUEST', Name: 'LAR-00100', Status__c: 'Pending', Composition__c: 'x' });
        const el = createElement('c-lol-team-builder', { is: LolTeamBuilder });
        document.body.appendChild(el);
        getBuilderData.emit(builderData('CLAUDE_CODE', true, true));
        await flush();
        await flush();

        expect($(el, '.analyze-button')).not.toBeNull();
        expect($(el, '.recent-title').textContent).toBe('분석 이력 (공개 사이트)');
        expect($(el, '.recent-hint').textContent).toContain('방문자들이 요청해 완료된 분석');
        expect($(el, '.guest-info').textContent).toContain('같은 네트워크(IP)당 10분에 5건');
        expect(getRecentRequests).toHaveBeenCalledTimes(1);

        $(el, '.analyze-button').click();
        await flush();
        await flush();
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('/lolvforcesite/services/apexrest/lol/guest/requests');
        expect(init.method).toBe('POST');
        expect(Object.keys(JSON.parse(init.body))).toEqual(['picks', 'tiers', 'totalScore', 'categoryPoints']); // ID·숫자만 전송
        expect(submitAnalysisRequest).not.toHaveBeenCalled(); // 방문자는 Aura 경로를 쓰지 않음
        expect($(el, '.waiting-text').textContent).toContain('LAR-00100 대기 중');
        expect(getRecentRequests).toHaveBeenCalledTimes(2); // 요청 후 이력 새로 고침
        delete global.fetch;
    });

    it('공개 사이트 방문자: IP별 횟수를 넘으면 서버 안내 문구를 그대로 보여 준다', async () => {
        const message = '같은 네트워크에서 10분에 5건까지 새 분석을 요청할 수 있습니다. 잠시 후 다시 시도하거나, 이미 분석된 조합을 확인하세요.';
        global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({ message }) }));
        const el = createElement('c-lol-team-builder', { is: LolTeamBuilder });
        document.body.appendChild(el);
        getBuilderData.emit(builderData('CLAUDE_CODE', true, true));
        await flush();
        await flush();

        $(el, '.analyze-button').click();
        await flush();
        await flush();
        expect($(el, '.analysis-error').textContent).toBe(message);
        expect($(el, '.waiting-text')).toBeNull();
        delete global.fetch;
    });

    it('분석 패널은 화면 맨 위에 있고, 리포트는 섹션 제목과 라인별 카드로 표시된다', async () => {
        startAnalysis.mockResolvedValue({
            text: '■ 한줄 평가\n- 후반 조합\n■ 라인별 해야 할 것 / 주의사항\n▶ 탑\n- R 각 유지\n▶ 정글\n- 첫 갱은 미드\n■ 오브젝트 운영\n- 공허 유충 (확인 필요)',
            sources: [],
            searchCount: 3,
            model: 'claude-sonnet-5-5',
            truncated: false
        });
        const el = await mount('API');
        const panels = $$(el, '.panel');
        expect(panels[0].classList.contains('analysis')).toBe(true); // 첫 패널 = Claude 분석

        $(el, '.analyze-button').click();
        await flush();

        expect($$(el, '.report-title').map((h) => h.textContent)).toEqual(['한줄 평가', '라인별 해야 할 것 / 주의사항', '오브젝트 운영']);
        expect($$(el, '.report-group .report-sub').map((h) => h.textContent)).toEqual(['탑', '정글']);
        expect($$(el, '.report-group')[1].textContent).toContain('첫 갱은 미드');
        expect($$(el, '.report-bullet').length).toBe(4);
    });

    it('조합 대시보드: 실제 통계 KPI 2개 + 자체 지수 KPI 2개, 차트 6개를 근거 배지와 함께 그린다', async () => {
        const el = await mount();
        const kpis = $$(el, '.dash .kpi');
        expect(kpis).toHaveLength(4);
        expect(kpis.map((k) => k.querySelector('.kpi-tag').textContent)).toEqual(['실제 통계', '실제 통계', '자체 지수', '자체 지수']);
        expect(kpis[0].querySelector('.kpi-value').textContent).toMatch(/^\d+(\.\d)?%$/); // 5픽 평균 승률 (lol.ps)
        expect(kpis[2].querySelector('.kpi-value').textContent).toMatch(/^(초반형|중반형|후반형)$/);

        const meta = $(el, 'c-echart.chart-meta').option;
        expect(meta.series.map((s) => s.name)).toEqual(['전체 픽', '우리 조합']);
        expect(meta.series[1].data).toHaveLength(5);
        expect(meta.series[1].data[0].symbol).toMatch(/^image:\/\/https:\/\/ddragon\.leagueoflegends\.com\/cdn\/16\.20\.1\/img\/champion\//);
        expect($(el, 'c-echart.chart-profile').option.radar.indicator.map((i) => i.max)).toEqual(Array(8).fill(10));
        expect($(el, 'c-echart.chart-objectives').option.yAxis.data).toEqual(['공허 유충', '드래곤', '협곡의 전령', '바론']);
        expect($(el, 'c-echart.chart-lanes').option.xAxis.max).toBe(10); // 확률(%)이 아닌 0~10 지수
        expect($(el, 'c-echart.chart-power').option.yAxis.max).toBe(10);
        expect($(el, 'c-echart.chart-damage').option.series[0].type).toBe('pie');

        const sub = $(el, '.dash-sub').textContent;
        expect(sub).toContain('승률·확률이 아니며');
        expect($(el, '.dash-method').textContent).toContain('실제 경기 시간대별 승률이 아닙니다');
    });

    it('전체 픽: 선택 목록에 선호(★)·비선호 픽이 모두 있고, 픽 풀 표에 이 자리 점수·픽률을 보여 주며 선호 필터가 동작한다', async () => {
        const el = await mount();
        const options = pickBox(el, 'MID').options;
        expect(options.length).toBeGreaterThan(40);
        expect(options[0].label.startsWith('★ ')).toBe(true);
        expect(options.some((o) => !o.label.startsWith('★') && o.label.includes('픽 '))).toBe(true);

        const tables = () => $$(el, 'lightning-tabset lightning-datatable');
        const topRows = tables()[0].data;
        expect(topRows.length).toBeGreaterThan(40);
        expect(topRows.filter((r) => r.star === '★').length).toBe(13); // 팀 선호 탑 픽 13명
        expect(topRows.find((r) => r.id === 'Malphite_Top').fitScore).toBeGreaterThan(0);
        expect(topRows.some((r) => r.pickRateLabel.endsWith('%'))).toBe(true);

        const filter = $(el, '.pool-filter-toggle');
        filter.checked = true;
        filter.dispatchEvent(new CustomEvent('change'));
        await flush();
        expect(tables()[0].data.every((r) => r.star === '★')).toBe(true);
    });

    it('탐색 후보 확장 토글을 켜면 선호 외 상위 픽까지 더 많은 조합을 평가한다', async () => {
        const el = await mount();
        const before = $(el, '.search-summary').textContent;
        const evaluatedOf = (text) => Number(text.split('개 조합')[0].replace(/,/g, ''));
        const toggle = $(el, '.pool-mode-toggle');
        toggle.checked = true;
        toggle.dispatchEvent(new CustomEvent('change'));
        await flush();
        const after = $(el, '.search-summary').textContent;
        expect(evaluatedOf(after)).toBeGreaterThan(evaluatedOf(before));
        expect(after).toContain('라인별 후보');
    });

    it('라인별 전체 픽: 이름(가나다)·이 자리 점수·PS 점수 기준으로 정렬하고, 점수 기준과 지표 출처를 표 아래에 표시한다', async () => {
        const el = await mount();
        const table = () => $$(el, 'lightning-tabset lightning-datatable.pool-table')[0];
        const sortBy = async (fieldName, sortDirection) => {
            table().dispatchEvent(new CustomEvent('sort', { detail: { fieldName, sortDirection } }));
            await flush();
        };

        await sortBy('name', 'asc');
        const names = table().data.map((r) => r.name);
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'ko')));
        expect(table().sortedBy).toBe('name');
        expect(table().sortedDirection).toBe('asc');

        await sortBy('fitScore', 'desc');
        const fit = table().data.map((r) => r.fitScore).filter((v) => v != null);
        expect(fit).toEqual([...fit].sort((a, b) => b - a));
        expect(table().data.at(-1).fitScore == null || fit.length === table().data.length).toBe(true); // 계산 불가 행은 맨 아래

        await sortBy('psScore', 'desc');
        const ps = table().data.map((r) => r.psScore).filter((v) => v != null);
        expect(ps).toEqual([...ps].sort((a, b) => b - a));

        await sortBy('winRateLabel', 'asc');
        const wr = table().data.map((r) => r.winRate).filter((v) => v != null);
        expect(wr).toEqual([...wr].sort((a, b) => a - b));

        // 정렬 기준은 다른 라인 탭에도 같이 적용
        const jungle = $$(el, 'lightning-tabset lightning-datatable.pool-table')[1];
        expect(jungle.sortedBy).toBe('winRateLabel');

        const basis = $(el, '.basis').textContent;
        expect(basis).toContain('객관 기준');
        expect(basis).toContain('실제 통계 40점');
        expect(basis).not.toContain('1탱 + 1브루저');
        expect(basis).toContain('lol.ps (프로관전러 P.S)');
        expect(basis).toContain('정성 평가');
        expect([...el.shadowRoot.querySelectorAll('.sources-list a')].map((a) => a.href)).toEqual(
            expect.arrayContaining(['https://lol.ps/statistics?tier=2&region=0'])
        );
    });
});
