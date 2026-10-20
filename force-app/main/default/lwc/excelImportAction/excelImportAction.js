import { LightningElement, api } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';
import { RefreshEvent } from 'lightning/refresh';
import resolveRecordConfig from '@salesforce/apex/ExcelImportController.resolveRecordConfig';

/**
 * 레코드 화면 Quick Action용 Excel 업로드 (공통 c-excel-import 래퍼).
 * Quick Action은 파라미터를 넘길 수 없으므로, 레코드 Object에 Record Action Default로 지정된 설정을 서버에서 찾는다.
 * 설정이 없거나 여러 개면 오류를 표시. 업로드가 끝나면 RefreshEvent로 Related List를 새로 고침.
 */
export default class ExcelImportAction extends LightningElement {
    configName;
    resolveError;
    configLabel;
    busy = false;
    _recordId;

    // Screen Action은 recordId가 connectedCallback 이후에 들어올 수 있어 setter에서 조회
    @api
    get recordId() {
        return this._recordId;
    }
    set recordId(value) {
        if (value && value !== this._recordId) {
            this._recordId = value;
            this.resolve();
        }
    }

    get header() {
        return this.configLabel || 'Excel 업로드';
    }

    async resolve() {
        try {
            this.configName = await resolveRecordConfig({ recordId: this._recordId });
            this.resolveError = undefined;
        } catch (error) {
            this.configName = undefined;
            this.resolveError = error?.body?.message || error?.message || '알 수 없는 오류';
        }
    }

    handleConfigLoad(event) {
        this.configLabel = event.detail.config.label;
    }

    handleBusyChange(event) {
        this.busy = event.detail.busy;
    }

    handleImportComplete(event) {
        if (event.detail.success > 0) {
            this.dispatchEvent(new RefreshEvent());
        }
    }

    handleClose() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}
