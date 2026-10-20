import LightningModal from 'lightning/modal';

/**
 * 표준 LightningModal로 업로드 화면을 띄움 (포커스 트랩·ESC·접근성을 플랫폼이 처리).
 * close 결과: 업로드를 한 번이라도 완료했으면 { success, failed, total }, 아니면 undefined.
 */
export default class AccountImportModal extends LightningModal {
    lastResult;

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
