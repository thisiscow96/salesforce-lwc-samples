import { createElement } from 'lwc';
import AccountExcelImport from 'c/accountExcelImport';
import { loadScript } from 'lightning/platformResourceLoader';
import importRows from '@salesforce/apex/AccountExcelImportController.importRows';

// 실제 SheetJS(정적 리소스 그대로)로 .xlsx를 만들고 읽음 → 라이브러리 연동까지 검증
const realXlsx = require('../../../staticresources/sheetjs.js');

jest.mock('lightning/platformResourceLoader', () => ({ loadScript: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AccountExcelImportController.importRows', () => ({ default: jest.fn() }), { virtual: true });

const HEADER = ['Account Name', 'First Name', 'Last Name', 'Email'];

function xlsxFile(rows, name = 'accounts.xlsx') {
    const workbook = realXlsx.utils.book_new();
    realXlsx.utils.book_append_sheet(workbook, realXlsx.utils.aoa_to_sheet(rows), 'Sheet1');
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

// 서버 동작 흉내: 행마다 성공, 같은 이름은 같은 Account Id
function serverOk() {
    importRows.mockImplementation(({ rows }) =>
        Promise.resolve(
            rows.map((r) => ({
                rowNumber: r.rowNumber,
                success: true,
                accountName: r.accountName,
                accountId: r.accountId || `001${r.accountName.toLowerCase()}`,
                contactId: `003${r.rowNumber}`
            }))
        )
    );
}

async function mount() {
    const el = createElement('c-account-excel-import', { is: AccountExcelImport });
    document.body.appendChild(el);
    await flush();
    return el;
}

async function upload(el, file) {
    const input = el.shadowRoot.querySelector('.file-input');
    input.dispatchEvent(new CustomEvent('change', { detail: { files: [file] } }));
    await waitFor(() => el.shadowRoot.querySelector('lightning-datatable, .file-error'));
}

const $ = (el, selector) => el.shadowRoot.querySelector(selector);

describe('c-account-excel-import', () => {
    beforeEach(() => {
        window.XLSX = realXlsx;
        loadScript.mockResolvedValue();
        serverOk();
    });

    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        delete window.XLSX;
        jest.clearAllMocks();
    });

    it('xlsx를 읽어 검증 결과를 미리보기로 보여 준다', async () => {
        const el = await mount();
        await upload(el, xlsxFile([HEADER, ['Acme', 'Gil', 'Hong', 'hong@acme.com'], ['Acme', '', 'Kim', 'bad-mail'], ['Beta', 'Su', 'Lee', '']]));

        expect($(el, '.preview-summary').textContent.replace(/\s+/g, ' ')).toContain('업로드 가능 2건 (Account 2건) · 오류 1건');
        const data = $(el, 'lightning-datatable').data;
        expect(data.map((r) => [r.rowNumber, r.status])).toEqual([
            [2, 'OK'],
            [3, 'Email 형식 오류'],
            [4, 'OK']
        ]);
        expect($(el, '.import-button').label).toBe('2건 업로드');
    });

    it('필수 열이 없는 파일은 업로드 단계로 넘어가지 않는다', async () => {
        const el = await mount();
        await upload(el, xlsxFile([['Email'], ['a@b.com']]));
        expect($(el, '.file-error').textContent).toContain('필수 열이 없습니다');
        expect($(el, 'lightning-datatable')).toBeNull();
    });

    it('200행씩 순차 업로드하고, 앞 청크에서 만든 Account Id를 다음 청크에 넘긴다', async () => {
        const rows = Array.from({ length: 250 }, (_, i) => ['Acme', `F${i}`, `L${i}`, `u${i}@acme.com`]);
        const el = await mount();
        await upload(el, xlsxFile([HEADER, ...rows, ['', '', 'NoAccount', '']]));
        const busy = jest.fn();
        const complete = jest.fn();
        const toast = jest.fn();
        el.addEventListener('busychange', busy);
        el.addEventListener('importcomplete', complete);
        el.addEventListener('lightning__showtoast', toast); // ShowToastEvent 이벤트명

        $(el, '.import-button').click();
        await waitFor(() => $(el, '.success-count'));

        expect(importRows).toHaveBeenCalledTimes(2);
        const first = importRows.mock.calls[0][0].rows;
        const second = importRows.mock.calls[1][0].rows;
        expect(first).toHaveLength(200);
        expect(second).toHaveLength(50);
        expect(first[0].accountId).toBeNull();
        expect(second.every((r) => r.accountId === '001acme')).toBe(true);
        expect(first.concat(second).some((r) => r.lastName === 'NoAccount')).toBe(false); // 검증 실패 행은 서버로 안 보냄

        expect($(el, '.success-count').textContent).toBe('250');
        expect($(el, '.failed-count').textContent).toBe('1');
        expect(busy.mock.calls.map((c) => c[0].detail.busy)).toEqual([true, false]);
        expect(complete.mock.calls[0][0].detail).toEqual({ total: 251, success: 250, failed: 1 });
        expect(toast.mock.calls[0][0].detail.variant).toBe('warning');
    });

    it('서버 오류 시 중단하고 남은 행을 실패로 표시하며 실패 CSV를 받을 수 있다', async () => {
        importRows.mockRejectedValue({ body: { message: 'Account/Contact 생성 권한이 없습니다.' } });
        const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const el = await mount();
        await upload(el, xlsxFile([HEADER, ['Acme', 'A', 'B', 'a@acme.com']]));

        $(el, '.import-button').click();
        await waitFor(() => $(el, '.failed-count'));

        expect($(el, '.failed-count').textContent).toBe('1');
        expect($(el, 'lightning-datatable').data[0].message).toBe('업로드 중단: Account/Contact 생성 권한이 없습니다.');

        $(el, '.error-csv-button').click();
        const link = click.mock.instances[0];
        expect(link.download).toBe('account_upload_errors.csv');
        const csv = decodeURIComponent(link.href.split(',').slice(1).join(','));
        expect(csv).toContain('2,Acme,A,B,a@acme.com,업로드 중단: Account/Contact 생성 권한이 없습니다.');
    });

    it('업로드 양식은 실제로 다시 읽을 수 있는 xlsx로 내려받는다', async () => {
        const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const el = await mount();
        $(el, '.template-button').click();

        const link = click.mock.instances[0];
        expect(link.download).toBe('account_upload_template.xlsx');
        const workbook = realXlsx.read(link.href.split(',')[1], { type: 'base64' });
        const matrix = realXlsx.utils.sheet_to_json(workbook.Sheets.Accounts, { header: 1 });
        expect(matrix[0]).toEqual(HEADER);
        expect(matrix).toHaveLength(3);
    });

    it('라이브러리 로드 실패 시 안내하고 파일 선택을 막는다', async () => {
        loadScript.mockRejectedValue(new Error('blocked'));
        const el = await mount();
        await flush();
        expect($(el, '.slds-alert_error').textContent).toContain('Excel 라이브러리를 불러오지 못했습니다');
        expect($(el, '.file-input').disabled).toBe(true);
    });
});
