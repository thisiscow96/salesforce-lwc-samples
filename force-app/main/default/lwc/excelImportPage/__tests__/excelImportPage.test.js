import { createElement } from 'lwc';
import ExcelImportPage from 'c/excelImportPage';
import { CurrentPageReference } from 'lightning/navigation';
import getConfig from '@salesforce/apex/ExcelImportController.getConfig';

jest.mock('lightning/platformResourceLoader', () => ({ loadScript: jest.fn(() => Promise.resolve()) }), { virtual: true });
jest.mock('@salesforce/apex/ExcelImportController.getConfig', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/ExcelImportController.importRows', () => ({ default: jest.fn() }), { virtual: true });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0)); // eslint-disable-line @lwc/lwc/no-async-operation

async function settle() {
    for (let i = 0; i < 5; i++) {
        await flush(); // eslint-disable-line no-await-in-loop
    }
}

describe('c-excel-import-page', () => {
    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        jest.clearAllMocks();
    });

    it('URL state(c__configName, c__recordId)를 공통 컴포넌트로 넘긴다', async () => {
        getConfig.mockRejectedValue({ body: { message: '설정 없음' } });
        const el = createElement('c-excel-import-page', { is: ExcelImportPage });
        document.body.appendChild(el);
        // eslint-disable-next-line @lwc/lwc/no-unexpected-wire-adapter-usages -- 테스트에서 URL state 주입
        CurrentPageReference.emit({ type: 'standard__component', attributes: {}, state: { c__configName: 'Account_Contact', c__recordId: '001000000000001AAA' } });
        await settle();

        const child = el.shadowRoot.querySelector('c-excel-import');
        expect(child.configName).toBe('Account_Contact');
        expect(child.recordId).toBe('001000000000001AAA');
        expect(getConfig).toHaveBeenLastCalledWith({ configName: 'Account_Contact', recordId: '001000000000001AAA' });
    });

    it('파라미터가 없으면 공통 컴포넌트가 설정 오류를 표시한다', async () => {
        getConfig.mockRejectedValue({ body: { message: 'Excel 업로드 설정값(configName)이 지정되지 않았습니다.' } });
        const el = createElement('c-excel-import-page', { is: ExcelImportPage });
        document.body.appendChild(el);
        // eslint-disable-next-line @lwc/lwc/no-unexpected-wire-adapter-usages -- 테스트에서 URL state 주입
        CurrentPageReference.emit({ type: 'standard__component', attributes: {}, state: {} });
        await settle();

        const child = el.shadowRoot.querySelector('c-excel-import');
        expect(child.shadowRoot.querySelector('.config-error').textContent).toContain('configName');
    });
});
