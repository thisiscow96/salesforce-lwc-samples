// sfdx-lwc-jest에 lightning/actions 스텁이 없어 직접 제공
export class CloseActionScreenEvent extends CustomEvent {
    constructor() {
        super('close');
    }
}
