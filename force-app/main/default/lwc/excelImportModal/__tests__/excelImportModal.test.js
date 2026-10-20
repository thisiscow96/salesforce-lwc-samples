import { createElement } from 'lwc';
import ExcelImportModal from 'c/excelImportModal';
import getConfig from '@salesforce/apex/ExcelImportController.getConfig';

jest.mock('lightning/platformResourceLoader', () => ({ loadScript: jest.fn(() => Promise.resolve()) }), { virtual: true });
jest.mock('@salesforce/apex/ExcelImportController.getConfig', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/ExcelImportController.importRows', () => ({ default: jest.fn() }), { virtual: true });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0)); // eslint-disable-line @lwc/lwc/no-async-operation
const $ = (el, selector) => el.shadowRoot.querySelector(selector);

async function mount(props) {
    getConfig.mockResolvedValue({ name: 'Account_Contact', label: '설정 Label', columns: [], maxRows: 10, chunkSize: 1 });
    const el = createElement('c-excel-import-modal', { is: ExcelImportModal });
    Object.assign(el, props);
    document.body.appendChild(el);
    await flush();
    await flush();
    return el;
}

describe('c-excel-import-modal', () => {
    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        jest.clearAllMocks();
    });

    it('파라미터를 공통 컴포넌트로 넘기고, label이 없으면 설정 Label을 헤더로 쓴다', async () => {
        const el = await mount({ configName: 'Account_Contact', recordId: '001000000000001AAA' });
        const child = $(el, 'c-excel-import');
        expect(child.configName).toBe('Account_Contact');
        expect(child.recordId).toBe('001000000000001AAA');
        expect($(el, 'lightning-modal-header').label).toBe('설정 Label');
    });

    it('업로드 중에는 닫기를 막고, 닫을 때 마지막 결과를 돌려준다', async () => {
        const el = await mount({ configName: 'Account_Contact', label: '직접 지정' });
        expect($(el, 'lightning-modal-header').label).toBe('직접 지정');
        const child = $(el, 'c-excel-import');
        child.dispatchEvent(new CustomEvent('busychange', { detail: { busy: true } }));
        await flush();
        expect($(el, 'lightning-modal-footer lightning-button').disabled).toBe(true);

        child.dispatchEvent(new CustomEvent('busychange', { detail: { busy: false } }));
        child.dispatchEvent(new CustomEvent('importcomplete', { detail: { total: 2, success: 2, failed: 0 } }));
        const closed = jest.fn();
        el.addEventListener('close', closed);
        await flush();
        $(el, 'lightning-modal-footer lightning-button').click();
        expect(closed.mock.calls[0][0].detail).toEqual({ total: 2, success: 2, failed: 0 });
    });
});
