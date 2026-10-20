import { createElement } from 'lwc';
import AccountImportModal from 'c/accountImportModal';

jest.mock('lightning/platformResourceLoader', () => ({ loadScript: jest.fn(() => Promise.resolve()) }), { virtual: true });
jest.mock('@salesforce/apex/AccountExcelImportController.importRows', () => ({ default: jest.fn() }), { virtual: true });

const flush = () => Promise.resolve();

describe('c-account-import-modal', () => {
    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
    });

    it('업로드 중에는 닫기를 막고, 닫을 때 마지막 결과를 돌려준다', async () => {
        const el = createElement('c-account-import-modal', { is: AccountImportModal });
        const closed = jest.fn();
        el.addEventListener('close', closed);
        document.body.appendChild(el);
        await flush();

        const importer = el.shadowRoot.querySelector('c-account-excel-import');
        const closeButton = el.shadowRoot.querySelector('lightning-modal-footer lightning-button');
        importer.dispatchEvent(new CustomEvent('busychange', { detail: { busy: true } }));
        await flush();
        expect(closeButton.disabled).toBe(true);

        importer.dispatchEvent(new CustomEvent('busychange', { detail: { busy: false } }));
        importer.dispatchEvent(new CustomEvent('importcomplete', { detail: { total: 3, success: 2, failed: 1 } }));
        await flush();
        expect(closeButton.disabled).toBe(false);

        closeButton.click();
        expect(closed.mock.calls[0][0].detail).toEqual({ total: 3, success: 2, failed: 1 });
    });
});
