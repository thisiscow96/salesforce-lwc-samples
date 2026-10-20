import { createElement } from 'lwc';
import ExcelImportAction from 'c/excelImportAction';
import resolveRecordConfig from '@salesforce/apex/ExcelImportController.resolveRecordConfig';
import getConfig from '@salesforce/apex/ExcelImportController.getConfig';

jest.mock('lightning/platformResourceLoader', () => ({ loadScript: jest.fn(() => Promise.resolve()) }), { virtual: true });
jest.mock('@salesforce/apex/ExcelImportController.resolveRecordConfig', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/ExcelImportController.getConfig', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/ExcelImportController.importRows', () => ({ default: jest.fn() }), { virtual: true });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0)); // eslint-disable-line @lwc/lwc/no-async-operation
const $ = (el, selector) => el.shadowRoot.querySelector(selector);

async function mount() {
    const el = createElement('c-excel-import-action', { is: ExcelImportAction });
    document.body.appendChild(el);
    el.recordId = '001000000000001AAA'; // Screen Action은 recordId가 연결 후에 들어올 수 있음
    for (let i = 0; i < 4; i++) {
        await flush(); // eslint-disable-line no-await-in-loop
    }
    return el;
}

describe('c-excel-import-action', () => {
    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        jest.clearAllMocks();
    });

    it('레코드 Object의 기본 설정을 찾아 공통 컴포넌트에 넘긴다', async () => {
        resolveRecordConfig.mockResolvedValue('Account_Related_Contact');
        getConfig.mockResolvedValue({ name: 'Account_Related_Contact', label: 'Account 하위 Contact 일괄 생성', columns: [], maxRows: 10, chunkSize: 1 });
        const el = await mount();

        expect(resolveRecordConfig).toHaveBeenCalledWith({ recordId: '001000000000001AAA' });
        const child = $(el, 'c-excel-import');
        expect(child.configName).toBe('Account_Related_Contact');
        expect(child.recordId).toBe('001000000000001AAA');
        expect($(el, 'lightning-quick-action-panel').header).toBe('Account 하위 Contact 일괄 생성');
    });

    it('기본 설정이 없으면 오류를 보여 주고 업로드 화면을 띄우지 않는다', async () => {
        resolveRecordConfig.mockRejectedValue({ body: { message: 'Account 레코드용 Excel 업로드 설정이 없습니다.' } });
        const el = await mount();
        expect($(el, '.resolve-error').textContent).toContain('설정이 없습니다');
        expect($(el, 'c-excel-import')).toBeNull();
    });

    it('업로드 성공 시 화면을 새로 고치고, 닫기 버튼은 Quick Action을 닫는다 (업로드 중엔 비활성)', async () => {
        resolveRecordConfig.mockResolvedValue('Account_Related_Contact');
        getConfig.mockResolvedValue({ name: 'Account_Related_Contact', label: 'L', columns: [], maxRows: 10, chunkSize: 1 });
        const el = await mount();
        const refresh = jest.fn();
        const close = jest.fn();
        el.addEventListener('lightning__refresh', refresh);
        el.addEventListener('close', close);

        const child = $(el, 'c-excel-import');
        child.dispatchEvent(new CustomEvent('busychange', { detail: { busy: true } }));
        await flush();
        expect($(el, '.close-button').disabled).toBe(true);
        child.dispatchEvent(new CustomEvent('busychange', { detail: { busy: false } }));
        child.dispatchEvent(new CustomEvent('importcomplete', { detail: { total: 1, success: 1, failed: 0 } }));
        await flush();
        $(el, '.close-button').click();

        expect(refresh).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
    });
});
