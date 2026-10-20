import { createElement } from 'lwc';
import ExcelImport from 'c/excelImport';
import { loadScript } from 'lightning/platformResourceLoader';
import getConfig from '@salesforce/apex/ExcelImportController.getConfig';
import importRows from '@salesforce/apex/ExcelImportController.importRows';
import { ACCOUNT_CONTACT, TYPED } from './data/configs';

// 실제 SheetJS(정적 리소스 그대로)로 .xlsx를 만들고 읽음 → 라이브러리 연동까지 검증
const realXlsx = require('../../../staticresources/sheetjs.js');

jest.mock('lightning/platformResourceLoader', () => ({ loadScript: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/ExcelImportController.getConfig', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/ExcelImportController.importRows', () => ({ default: jest.fn() }), { virtual: true });

const HEADER = ['Account Name', 'First Name', 'Last Name', 'Email'];

function xlsxFile(rows, name = 'upload.xlsx') {
    const workbook = realXlsx.utils.book_new();
    realXlsx.utils.book_append_sheet(workbook, realXlsx.utils.aoa_to_sheet(rows, { cellDates: true }), 'Sheet1');
    const bytes = realXlsx.write(workbook, { bookType: 'xlsx', type: 'array' });
    return new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0)); // eslint-disable-line @lwc/lwc/no-async-operation

async function waitFor(check) {
    for (let i = 0; i < 100; i++) {
        if (check()) {
            return;
        }
        await flush(); // eslint-disable-line no-await-in-loop
    }
    throw new Error('조건을 만족하지 못함');
}

const $ = (el, selector) => el.shadowRoot.querySelector(selector);

async function mount(props = { configName: 'Account_Contact' }) {
    const el = createElement('c-excel-import', { is: ExcelImport });
    Object.assign(el, props);
    document.body.appendChild(el);
    await waitFor(() => $(el, '.file-input, .config-error'));
    return el;
}

async function upload(el, file) {
    $(el, '.file-input').dispatchEvent(new CustomEvent('change', { detail: { files: [file] } }));
    await waitFor(() => $(el, 'lightning-datatable, .file-error'));
}

// 서버 흉내: 모든 행 성공, carryOver에 호출 횟수를 누적해 다음 청크로 넘어가는지 확인
function serverOk() {
    importRows.mockImplementation(({ requestJson }) => {
        const request = JSON.parse(requestJson);
        const calls = Number(request.carryOver.calls || 0) + 1;
        return Promise.resolve({
            results: request.rows.map((r) => ({ rowNumber: r.rowNumber, success: true, recordId: `003${r.rowNumber}` })),
            carryOver: { calls: String(calls) }
        });
    });
}

describe('c-excel-import', () => {
    beforeEach(() => {
        window.XLSX = realXlsx;
        loadScript.mockResolvedValue();
        getConfig.mockResolvedValue(ACCOUNT_CONTACT);
        serverOk();
    });

    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        delete window.XLSX;
        jest.clearAllMocks();
    });

    it('configName·recordId로 설정을 1번 조회하고 열 안내를 설정대로 보여 준다', async () => {
        const handler = jest.fn();
        const el = createElement('c-excel-import', { is: ExcelImport });
        el.configName = 'Account_Contact';
        el.recordId = '001000000000001AAA';
        el.addEventListener('configload', handler);
        document.body.appendChild(el);
        await waitFor(() => $(el, '.file-input'));

        expect(getConfig).toHaveBeenCalledTimes(1);
        expect(getConfig).toHaveBeenCalledWith({ configName: 'Account_Contact', recordId: '001000000000001AAA' });
        expect($(el, '.config-label').textContent).toBe('Account + Contact 일괄 생성');
        const badges = [...el.shadowRoot.querySelectorAll('.columns .slds-badge')].map((b) => b.textContent);
        expect(badges).toEqual(['Account Name (필수)', 'First Name', 'Last Name (필수)', 'Email']);
        expect(handler.mock.calls[0][0].detail.config.name).toBe('Account_Contact');
    });

    it('설정이 없으면(파라미터 누락·미등록 등) 서버 문구를 오류로 보여 주고 파일 선택을 막는다', async () => {
        getConfig.mockRejectedValue({ body: { message: 'Excel 업로드 설정값(configName)이 지정되지 않았습니다.' } });
        const el = await mount({});

        expect(getConfig).toHaveBeenCalledWith({ configName: null, recordId: null });
        expect($(el, '.config-error').textContent).toContain('configName)이 지정되지 않았습니다');
        expect($(el, '.file-input')).toBeNull();
    });

    it('configName이 바뀌면 설정을 다시 조회한다', async () => {
        const el = await mount();
        getConfig.mockRejectedValue({ body: { message: '비활성화' } });
        el.configName = 'Other';
        await waitFor(() => $(el, '.config-error'));
        expect(getConfig).toHaveBeenLastCalledWith({ configName: 'Other', recordId: null });
    });

    it('파일을 설정 열 기준으로 검증해 미리보기를 보여 준다', async () => {
        const el = await mount();
        await upload(el, xlsxFile([HEADER, ['Acme', 'Gil', 'Hong', 'hong@acme.com'], ['Acme', '', 'Kim', 'bad-mail'], ['', 'Su', 'Lee', '']]));

        expect($(el, '.preview-summary').textContent.replace(/\s+/g, ' ')).toContain('업로드 가능 1건 · 오류 2건');
        const table = $(el, 'lightning-datatable');
        expect(table.columns.map((c) => c.label)).toEqual(['행', 'Account Name', 'First Name', 'Last Name', 'Email', '검증']);
        expect(table.data[0]).toMatchObject({ rowNumber: 2, f_accountName: 'Acme', f_lastName: 'Hong', status: 'OK' });
        expect(table.data[1].status).toBe('Email 형식 오류');
        expect(table.data[2].status).toBe('Account Name 필수');
    });

    it('필수 열이 없는 파일은 파일 오류', async () => {
        const el = await mount();
        await upload(el, xlsxFile([['Email'], ['a@b.com']]));
        expect($(el, '.file-error').textContent).toContain('필수 열이 없습니다: Account Name, Last Name');
    });

    it('Excel 날짜 셀은 yyyy-mm-dd로 읽어 Date 열 검증을 통과한다', async () => {
        getConfig.mockResolvedValue(TYPED);
        const el = await mount({ configName: 'Typed' });
        await upload(el, xlsxFile([['Last Name', 'Birthdate'], ['Hong', new Date(Date.UTC(1990, 4, 1))]]));
        expect($(el, 'lightning-datatable').data[0]).toMatchObject({ f_Birthdate: '1990-05-01', status: 'OK' });
    });

    it('설정의 chunkSize로 순차 업로드하고 carryOver를 다음 청크에 넘긴다', async () => {
        const complete = jest.fn();
        const busy = jest.fn();
        const el = await mount({ configName: 'Account_Contact', recordId: '001000000000001AAA' });
        el.addEventListener('importcomplete', complete);
        el.addEventListener('busychange', busy);
        await upload(el, xlsxFile([HEADER, ['A', '', 'L1', ''], ['A', '', 'L2', ''], ['B', '', 'L3', ''], ['B', '', '', '']]));

        $(el, '.import-button').click();
        await waitFor(() => $(el, '.success-count'));

        expect(importRows).toHaveBeenCalledTimes(2); // 유효 3행 / chunkSize 2
        const second = importRows.mock.calls[1][0];
        expect(second.configName).toBe('Account_Contact');
        expect(second.recordId).toBe('001000000000001AAA');
        expect(JSON.parse(second.requestJson).carryOver).toEqual({ calls: '1' });
        expect($(el, '.success-count').textContent).toBe('3');
        expect($(el, '.failed-count').textContent).toBe('1');
        expect(complete.mock.calls[0][0].detail).toEqual({ total: 4, success: 3, failed: 1 });
        expect(busy.mock.calls.map((c) => c[0].detail.busy)).toEqual([true, false]);
    });

    it('서버 오류가 나면 중단하고 남은 행을 실패로 표시한다', async () => {
        importRows.mockRejectedValue({ body: { message: '권한 없음' } });
        const el = await mount();
        await upload(el, xlsxFile([HEADER, ['A', '', 'L1', ''], ['A', '', 'L2', ''], ['B', '', 'L3', '']]));

        $(el, '.import-button').click();
        await waitFor(() => $(el, '.failed-count'));

        expect(importRows).toHaveBeenCalledTimes(1);
        expect($(el, '.failed-count').textContent).toBe('3');
        expect($(el, 'lightning-datatable').data[0].message).toBe('업로드 중단: 권한 없음');
    });
});
