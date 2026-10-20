import { api } from 'lwc';
import LightningModal from 'lightning/modal';

/**
 * 버튼에서 여는 Excel 업로드 모달 (공통 c-excel-import 래퍼).
 * 사용: ExcelImportModal.open({ size: 'large', configName: 'Account_Contact', recordId, label })
 * close 결과: 업로드를 한 번이라도 완료했으면 { total, success, failed }, 아니면 undefined.
 */
export default class ExcelImportModal extends LightningModal {
    @api configName;
    @api recordId;
    @api label; // 없으면 설정 Label 사용
    configLabel;
    lastResult;

    get headerLabel() {
        return this.label || this.configLabel || 'Excel 업로드';
    }

    handleConfigLoad(event) {
        this.configLabel = event.detail.config.label;
    }

    // 업로드 중에는 ESC/X/닫기 버튼을 막아 중간에 끊기지 않게 함 (disableClose는 LightningModal 표준 속성)
    handleBusyChange(event) {
        this.disableClose = event.detail.busy;
    }

    handleImportComplete(event) {
        this.lastResult = event.detail;
    }

    handleClose() {
        this.close(this.lastResult);
    }
}
