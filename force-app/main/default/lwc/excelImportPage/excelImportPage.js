import { LightningElement, wire } from 'lwc';
import { CurrentPageReference, NavigationMixin } from 'lightning/navigation';

/**
 * URL로 여는 Excel 업로드 화면 (List View 버튼·Detail URL 버튼·다른 컴포넌트의 Navigate용).
 * URL: /lightning/cmp/c__excelImportPage?c__configName=Account_Contact[&c__recordId=001...]
 * 파라미터가 없거나 등록되지 않은 설정이면 c-excel-import가 오류를 표시한다.
 */
export default class ExcelImportPage extends NavigationMixin(LightningElement) {
    configName;
    recordId;

    @wire(CurrentPageReference)
    setPageReference(pageRef) {
        const state = (pageRef && pageRef.state) || {};
        this.configName = state.c__configName;
        this.recordId = state.c__recordId;
    }

    handleBack() {
        if (this.recordId) {
            this[NavigationMixin.Navigate]({ type: 'standard__recordPage', attributes: { recordId: this.recordId, actionName: 'view' } });
        } else {
            window.history.back();
        }
    }
}
