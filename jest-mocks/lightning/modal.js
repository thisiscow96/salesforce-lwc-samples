// sfdx-lwc-jest에 lightning/modal 스텁이 없어 직접 제공 (open은 테스트에서 호출 여부·인자를 검증)
import { LightningElement } from 'lwc';

export default class LightningModal extends LightningElement {
    disableClose = false;

    close(result) {
        this.dispatchEvent(new CustomEvent('close', { detail: result }));
    }
}

LightningModal.open = jest.fn(() => Promise.resolve());
