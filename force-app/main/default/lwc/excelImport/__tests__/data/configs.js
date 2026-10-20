// Apex ExcelImportController.getConfig 응답 형태의 테스트 설정 (org의 CMDT와 같은 구성)
export const ACCOUNT_CONTACT = {
    name: 'Account_Contact',
    label: 'Account + Contact 일괄 생성',
    guide: '행마다 Contact 1건을 만들고, 같은 Account Name은 Account 1건으로 묶습니다.',
    targetObject: 'Contact',
    parentObject: null,
    chunkSize: 2,
    maxRows: 5000,
    templateFileName: 'Account_Contact_template.xlsx',
    columns: [
        { key: 'accountName', label: 'Account Name', aliases: ['회사명', 'company'], required: true, maxLength: 255, dataType: 'Text', uniqueInFile: false, sampleValue: 'Hanbit Tech' },
        { key: 'firstName', label: 'First Name', aliases: ['이름'], required: false, maxLength: 40, dataType: 'Text', uniqueInFile: false, sampleValue: 'Gildong' },
        { key: 'lastName', label: 'Last Name', aliases: ['성'], required: true, maxLength: 80, dataType: 'Text', uniqueInFile: false, sampleValue: 'Hong' },
        { key: 'email', label: 'Email', aliases: ['이메일'], required: false, maxLength: 80, dataType: 'Email', uniqueInFile: true, sampleValue: 'a@b.com' }
    ]
};

export const TYPED = {
    ...ACCOUNT_CONTACT,
    name: 'Typed',
    columns: [
        { key: 'LastName', label: 'Last Name', aliases: [], required: true, maxLength: 80, dataType: 'Text' },
        { key: 'Amount', label: 'Amount', aliases: [], required: false, dataType: 'Number' },
        { key: 'Birthdate', label: 'Birthdate', aliases: ['생년월일'], required: false, dataType: 'Date' },
        { key: 'Active', label: 'Active', aliases: [], required: false, dataType: 'Boolean' }
    ]
};
