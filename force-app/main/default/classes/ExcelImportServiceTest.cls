/**
 * Excel 업로드 공통 엔진 테스트: 설정 오류 안내, Handler 분기, 공통 검증, 두 Handler의 Bulk 저장, 권한, 롤백.
 * 실제 배포된 CMDT(Account_Contact, Account_Related_Contact)와 주입 설정(testConfigs)을 함께 사용.
 * public: 테스트용 Handler(내부 클래스)를 ExcelImportService가 Type.forName으로 생성할 수 있도록.
 */
@IsTest
public class ExcelImportServiceTest {
    static final String PREFIX = 'XlsTest ';

    /** 테스트 전용 Handler: 저장 도중 시스템 예외 → 청크 롤백 확인 */
    public with sharing class ThrowingHandler extends ExcelImportHandler {
        public override void process(ExcelImport.Context ctx, List<ExcelImport.Row> rows) {
            insert new Account(Name = PREFIX + 'BeforeFailure');
            Integer zero = 0;
            Integer boom = 1 / zero;
        }
    }

    /** 테스트 전용 Handler: 결과를 남기지 않음 → 실패 처리 확인 */
    public with sharing class SilentHandler extends ExcelImportHandler {
        public override void process(ExcelImport.Context ctx, List<ExcelImport.Row> rows) {
            return;
        }
    }

    // ───────── helpers ─────────

    static String request(List<Map<String, String>> rows, Map<String, String> carryOver) {
        List<Map<String, Object>> payload = new List<Map<String, Object>>();
        for (Integer i = 0; i < rows.size(); i++) {
            payload.add(new Map<String, Object>{ 'rowNumber' => i + 2, 'values' => rows[i] });
        }
        return JSON.serialize(new Map<String, Object>{ 'rows' => payload, 'carryOver' => carryOver });
    }

    static Map<String, String> contactRow(String accountName, String firstName, String lastName, String email) {
        return new Map<String, String>{ 'accountName' => accountName, 'firstName' => firstName, 'lastName' => lastName, 'email' => email };
    }

    static ExcelImport.ColumnDef column(String key, String dataType, Boolean required) {
        ExcelImport.ColumnDef c = new ExcelImport.ColumnDef();
        c.key = key;
        c.label = key;
        c.dataType = dataType;
        c.required = required;
        return c;
    }

    static ExcelImport.ConfigDef injectConfig(String name, String handlerClass, String targetObject, List<ExcelImport.ColumnDef> columns) {
        ExcelImport.ConfigDef config = new ExcelImport.ConfigDef();
        config.name = name;
        config.label = name;
        config.active = true;
        config.handlerClass = handlerClass;
        config.targetObject = targetObject;
        config.columns = columns;
        ExcelImportService.testConfigs.put(name, config);
        return config;
    }

    static String errorOf(String configName, String recordId) {
        try {
            ExcelImportController.getConfig(configName, recordId);
        } catch (AuraHandledException e) {
            return e.getMessage();
        }
        Assert.fail('오류가 발생해야 함: ' + configName);
        return null;
    }

    static User minimumAccessUser() {
        Profile p = [SELECT Id FROM Profile WHERE Name = 'Minimum Access - Salesforce' LIMIT 1];
        String unique = String.valueOf(Crypto.getRandomInteger()).remove('-');
        User u = new User(
            Alias = 'xls' + unique.left(4), Email = 'xls' + unique + '@example.com', EmailEncodingKey = 'UTF-8',
            LastName = 'Importer', LanguageLocaleKey = 'ko', LocaleSidKey = 'ko_KR', TimeZoneSidKey = 'Asia/Seoul',
            ProfileId = p.Id, Username = 'xls' + unique + '@example.com.test'
        );
        insert u;
        return u;
    }

    // ───────── 설정 로드 ─────────

    @IsTest
    static void loadsDeployedConfigWithOrderedColumns() {
        ExcelImport.ConfigDef config = ExcelImportController.getConfig('Account_Contact', null);

        Assert.areEqual('Account_Contact', config.name);
        Assert.areEqual(200, config.chunkSize);
        List<String> keys = new List<String>();
        for (ExcelImport.ColumnDef c : config.columns) {
            keys.add(c.key);
        }
        Assert.areEqual('accountName,firstName,lastName,email', String.join(keys, ','), 'Sort Order 순');
        Assert.isTrue(config.columns[0].aliases.contains('회사명'));
        Assert.areEqual('Email', config.columns[3].dataType);
        Assert.isTrue(config.columns[3].uniqueInFile);
    }

    @IsTest
    static void missingOrBrokenConfigShowsClearErrors() {
        Account acc = new Account(Name = PREFIX + 'Ctx');
        insert acc;
        Contact con = new Contact(LastName = 'Ctx', AccountId = acc.Id);
        insert con;
        ExcelImport.ConfigDef inactive = injectConfig('Inactive_Cfg', 'ExcelImportGenericInsertHandler', 'Contact', new List<ExcelImport.ColumnDef>{ column('LastName', 'Text', true) });
        inactive.active = false;
        injectConfig('No_Columns', 'ExcelImportGenericInsertHandler', 'Contact', new List<ExcelImport.ColumnDef>());
        injectConfig('No_Handler', 'NoSuchHandlerClass', 'Contact', new List<ExcelImport.ColumnDef>{ column('LastName', 'Text', true) });
        injectConfig('Not_Handler', 'ExcelImport', 'Contact', new List<ExcelImport.ColumnDef>{ column('LastName', 'Text', true) });

        Test.startTest();
        Assert.isTrue(errorOf(null, null).contains('configName'), '파라미터 누락');
        Assert.isTrue(errorOf('  ', null).contains('configName'));
        Assert.isTrue(errorOf('Not_Registered', null).contains('\'Not_Registered\'을(를) 찾을 수 없습니다'));
        Assert.isTrue(errorOf('Inactive_Cfg', null).contains('비활성화'));
        Assert.isTrue(errorOf('No_Columns', null).contains('열 정의'));
        Assert.isTrue(errorOf('No_Handler', null).contains('처리 클래스(NoSuchHandlerClass)'));
        Assert.isTrue(errorOf('Not_Handler', null).contains('ExcelImportHandler를 상속하지 않습니다'));
        Assert.isTrue(errorOf('Account_Related_Contact', null).contains('Account 레코드 화면에서만'), '레코드 화면 전용');
        Assert.isTrue(errorOf('Account_Related_Contact', con.Id).contains('현재: Contact'), 'Object 불일치');
        Assert.isTrue(errorOf('Account_Related_Contact', 'not-an-id').contains('잘못된 레코드 Id'));
        Test.stopTest();
    }

    @IsTest
    static void genericHandlerRejectsInvalidSetup() {
        injectConfig('Bad_Object', 'ExcelImportGenericInsertHandler', 'No_Such_Object__c', new List<ExcelImport.ColumnDef>{ column('Name', 'Text', true) });
        injectConfig('Bad_Field', 'ExcelImportGenericInsertHandler', 'Contact', new List<ExcelImport.ColumnDef>{ column('No_Such_Field__c', 'Text', false) });
        injectConfig('Bad_Type', 'ExcelImportGenericInsertHandler', 'Contact', new List<ExcelImport.ColumnDef>{ column('LastName', 'Date', true) });
        ExcelImport.ConfigDef noParentField = injectConfig('No_Parent_Field', 'ExcelImportGenericInsertHandler', 'Contact', new List<ExcelImport.ColumnDef>{ column('LastName', 'Text', true) });
        noParentField.parentObject = 'Account';
        Account acc = new Account(Name = PREFIX + 'Parent');
        insert acc;

        Assert.isTrue(errorOf('Bad_Object', null).contains('Target Object(No_Such_Object__c)'));
        Assert.isTrue(errorOf('Bad_Field', null).contains('No_Such_Field__c 필드가 없습니다'));
        Assert.isTrue(errorOf('Bad_Type', null).contains('Date 열을 넣을 수 없습니다'));
        Assert.isTrue(errorOf('No_Parent_Field', acc.Id).contains('Parent Field가 필요'));
    }

    @IsTest
    static void userWithoutCreatePermissionIsBlockedOnLoad() {
        User u = minimumAccessUser();
        System.runAs(u) {
            Assert.areEqual('Account/Contact 생성 권한이 없습니다. 관리자에게 권한을 요청하세요.', errorOf('Account_Contact', null));
        }
    }

    // ───────── AccountContactImportHandler ─────────

    @IsTest
    static void accountContactBulk200SharesAccountsAndReturnsCarryOver() {
        List<Map<String, String>> rows = new List<Map<String, String>>();
        for (Integer i = 0; i < 200; i++) {
            // 50개 회사 × 4명. 대소문자·공백이 달라도 같은 Account로 묶여야 함
            String name = PREFIX + Math.mod(i, 50);
            rows.add(contactRow(Math.mod(i, 2) == 0 ? name : '  ' + name.toUpperCase() + ' ', 'First' + i, 'Last' + i, 'user' + i + '@example.com'));
        }

        Test.startTest();
        ExcelImport.Response response = ExcelImportController.importRows('Account_Contact', null, request(rows, null));
        Integer dmlRows = Limits.getDmlRows();
        Test.stopTest();

        Assert.areEqual(200, response.results.size());
        for (ExcelImport.RowResult r : response.results) {
            Assert.isTrue(r.success, 'row ' + r.rowNumber + ': ' + r.message);
            Assert.areEqual(Contact.SObjectType, r.recordId.getSObjectType());
        }
        Assert.areEqual(50, [SELECT COUNT() FROM Account WHERE Name LIKE :PREFIX + '%'], '회사명 기준 50건만 생성');
        Assert.areEqual(200, [SELECT COUNT() FROM Contact WHERE Account.Name LIKE :PREFIX + '%']);
        Assert.areEqual(250, dmlRows, 'Account 50 + Contact 200, 추가 DML 없음');
        Assert.areEqual(50, response.carryOver.size(), '다음 청크용 Account Id');

        Contact c = [SELECT FirstName, LastName, Email, Account.Name FROM Contact WHERE Id = :response.results[0].recordId];
        Assert.areEqual('First0', c.FirstName);
        Assert.areEqual('user0@example.com', c.Email);
        Assert.areEqual(PREFIX + '0', c.Account.Name, '처음 나온 표기(trim)로 Account 이름 저장');
    }

    @IsTest
    static void commonValidationRejectsRowsWithoutBlockingValidOnes() {
        List<Map<String, String>> rows = new List<Map<String, String>>{
            contactRow(PREFIX + 'Valid', 'Gil-dong', 'Hong', 'hong@example.com'),
            contactRow(PREFIX + 'NoLast', 'A', ' ', 'a@example.com'),
            contactRow(' ', 'B', 'Kim', 'b@example.com'),
            contactRow(PREFIX + 'BadMail', 'C', 'Lee', 'not-an-email'),
            contactRow(PREFIX + 'Long', 'x'.repeat(41), 'Park', null)
        };

        ExcelImport.Response response = ExcelImportController.importRows('Account_Contact', null, request(rows, null));

        Assert.isTrue(response.results[0].success, 'message=' + response.results[0].message);
        Assert.areEqual('Last Name 필수', response.results[1].message);
        Assert.areEqual('Account Name 필수', response.results[2].message);
        Assert.areEqual('Email 형식 오류', response.results[3].message);
        Assert.areEqual('First Name 40자 초과', response.results[4].message);
        Assert.areEqual(1, [SELECT COUNT() FROM Account WHERE Name LIKE :PREFIX + '%'], '실패 행의 Account는 만들지 않음');
    }

    @IsTest
    static void reusesCarryOverAccountAndRejectsForgedId() {
        Account existing = new Account(Name = PREFIX + 'Chunk1');
        insert existing;
        Map<String, String> carryOver = new Map<String, String>{
            'account:' + (PREFIX + 'chunk1').toLowerCase() => existing.Id,
            'account:' + (PREFIX + 'forged').toLowerCase() => UserInfo.getUserId() // Account가 아닌 Id
        };
        List<Map<String, String>> rows = new List<Map<String, String>>{
            contactRow(PREFIX + 'Chunk1', 'Next', 'Chunk', null),
            contactRow(PREFIX + 'Forged', 'F', 'Forged', null)
        };

        ExcelImport.Response response = ExcelImportController.importRows('Account_Contact', null, request(rows, carryOver));

        Assert.isTrue(response.results[0].success, 'message=' + response.results[0].message);
        Assert.areEqual(existing.Id, [SELECT AccountId FROM Contact WHERE Id = :response.results[0].recordId].AccountId);
        Assert.areEqual('잘못된 Account Id', response.results[1].message);
        Assert.areEqual(1, [SELECT COUNT() FROM Account WHERE Name LIKE :PREFIX + '%'], '새 Account를 만들지 않음');
    }

    // ───────── ExcelImportGenericInsertHandler (레코드 화면) ─────────

    @IsTest
    static void genericHandlerCreates200ChildContactsUnderRecord() {
        Account acc = new Account(Name = PREFIX + 'Parent');
        insert acc;
        List<Map<String, String>> rows = new List<Map<String, String>>();
        for (Integer i = 0; i < 199; i++) {
            rows.add(new Map<String, String>{ 'LastName' => 'Child' + i, 'Email' => 'child' + i + '@example.com', 'Birthdate' => '1990-05-01', 'Title' => 'Manager' });
        }
        rows.add(new Map<String, String>{ 'LastName' => 'BadDate', 'Birthdate' => '2026-02-30' });

        Test.startTest();
        ExcelImport.Response response = ExcelImportController.importRows('Account_Related_Contact', acc.Id, request(rows, null));
        Test.stopTest();

        Integer success = 0;
        for (ExcelImport.RowResult r : response.results) {
            success += r.success ? 1 : 0;
        }
        Assert.areEqual(199, success);
        Assert.areEqual('Birthdate 날짜 형식 오류 (yyyy-mm-dd)', response.results[199].message);
        Contact c = [SELECT AccountId, Birthdate, Title FROM Contact WHERE Id = :response.results[0].recordId];
        Assert.areEqual(acc.Id, c.AccountId, 'Parent Field에 recordId');
        Assert.areEqual(Date.newInstance(1990, 5, 1), c.Birthdate);
        Assert.areEqual('Manager', c.Title);
    }

    @IsTest
    static void ignoresKeysNotDefinedInConfig() {
        Account acc = new Account(Name = PREFIX + 'Parent');
        insert acc;
        List<Map<String, String>> rows = new List<Map<String, String>>{
            new Map<String, String>{ 'LastName' => 'Safe', 'Department' => 'Injected' }
        };

        ExcelImport.Response response = ExcelImportController.importRows('Account_Related_Contact', acc.Id, request(rows, null));

        Assert.isTrue(response.results[0].success, 'message=' + response.results[0].message);
        Assert.isNull([SELECT Department FROM Contact WHERE Id = :response.results[0].recordId].Department, '설정에 없는 필드는 저장하지 않음');
    }

    // ───────── 공통 처리 ─────────

    @IsTest
    static void handlerFailureRollsBackChunkAndHidesInternalError() {
        injectConfig('Throwing', 'ExcelImportServiceTest.ThrowingHandler', null, new List<ExcelImport.ColumnDef>{ column('name', 'Text', true) });
        try {
            ExcelImportController.importRows('Throwing', null, request(new List<Map<String, String>>{ new Map<String, String>{ 'name' => 'x' } }, null));
            Assert.fail('예외가 발생해야 함');
        } catch (AuraHandledException e) {
            Assert.areEqual('업로드 처리 중 오류가 발생했습니다. 관리자에게 문의하세요.', e.getMessage(), '내부 오류 내용은 숨김');
        }
        Assert.areEqual(0, [SELECT COUNT() FROM Account WHERE Name LIKE :PREFIX + '%'], 'Handler가 만든 데이터는 롤백');
    }

    @IsTest
    static void rowsWithoutHandlerResultAreFailed() {
        injectConfig('Silent', 'ExcelImportServiceTest.SilentHandler', null, new List<ExcelImport.ColumnDef>{ column('name', 'Text', true) });
        ExcelImport.Response response = ExcelImportController.importRows('Silent', null, request(new List<Map<String, String>>{ new Map<String, String>{ 'name' => 'x' } }, null));
        Assert.isFalse(response.results[0].success);
        Assert.areEqual('처리 결과가 없습니다. 관리자에게 문의하세요.', response.results[0].message);
    }

    @IsTest
    static void rejectsEmptyMalformedAndOversizedRequests() {
        ExcelImport.ConfigDef small = injectConfig('Small', 'ExcelImportServiceTest.SilentHandler', null, new List<ExcelImport.ColumnDef>{ column('name', 'Text', true) });
        small.chunkSize = 1;
        List<Map<String, String>> two = new List<Map<String, String>>{ new Map<String, String>{ 'name' => 'a' }, new Map<String, String>{ 'name' => 'b' } };
        Map<String, String> expected = new Map<String, String>{
            '' => '업로드할 행이 없습니다.',
            '{not json' => '업로드 요청 형식이 올바르지 않습니다.',
            request(two, null) => '한 번에 1행까지 처리할 수 있습니다.'
        };
        for (String body : expected.keySet()) {
            try {
                ExcelImportController.importRows('Small', null, body);
                Assert.fail('예외가 발생해야 함: ' + body);
            } catch (AuraHandledException e) {
                Assert.areEqual(expected.get(body), e.getMessage());
            }
        }
    }

    @IsTest
    static void convertsDataTypes() {
        Assert.areEqual(1234.5, (Decimal) ExcelImportService.convert('Number', '1,234.5'));
        Assert.areEqual(Date.newInstance(2024, 2, 29), (Date) ExcelImportService.convert('Date', '2024-2-29'));
        Assert.areEqual(true, (Boolean) ExcelImportService.convert('Boolean', 'Y'));
        Assert.areEqual(false, (Boolean) ExcelImportService.convert('Boolean', '아니오'));
        for (List<String> bad : new List<List<String>>{ new List<String>{ 'Number', 'abc' }, new List<String>{ 'Date', '2025-02-29' }, new List<String>{ 'Date', '05/01/1990' }, new List<String>{ 'Boolean', 'maybe' } }) {
            try {
                ExcelImportService.convert(bad[0], bad[1]);
                Assert.fail('변환 오류가 발생해야 함: ' + bad);
            } catch (ExcelImport.UserException e) {
                Assert.isNotNull(e.getMessage());
            }
        }
    }

    // ───────── Quick Action 설정 해석 / App Builder Picklist ─────────

    @IsTest
    static void resolvesRecordActionConfigByObject() {
        Account acc = new Account(Name = PREFIX + 'Action');
        insert acc;
        Contact con = new Contact(LastName = 'Action', AccountId = acc.Id);
        insert con;

        Assert.areEqual('Account_Related_Contact', ExcelImportController.resolveRecordConfig(acc.Id));
        try {
            ExcelImportController.resolveRecordConfig(con.Id);
            Assert.fail('Contact용 설정은 없음');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('Contact 레코드용 Excel 업로드 설정이 없습니다'), e.getMessage());
        }

        ExcelImport.ConfigDef duplicate = injectConfig('Second_Default', 'ExcelImportGenericInsertHandler', 'Contact', new List<ExcelImport.ColumnDef>{ column('LastName', 'Text', true) });
        duplicate.parentObject = 'Account';
        duplicate.recordActionDefault = true;
        try {
            ExcelImportController.resolveRecordConfig(acc.Id);
            Assert.fail('기본 설정 중복');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('여러 개'), e.getMessage());
        }
    }

    @IsTest
    static void picklistShowsConfigsForPageObject() {
        VisualEditor.DesignTimePageContext contactPage = new VisualEditor.DesignTimePageContext();
        contactPage.entityName = 'Contact';
        VisualEditor.DesignTimePageContext accountPage = new VisualEditor.DesignTimePageContext();
        accountPage.entityName = 'Account';

        String onContact = JSON.serialize(new ExcelImportConfigPicklist(contactPage).getValues().getDataRows());
        String onAccount = JSON.serialize(new ExcelImportConfigPicklist(accountPage).getValues().getDataRows());

        Assert.isTrue(onContact.contains('Account_Contact'), '어디서나 쓰는 설정');
        Assert.isFalse(onContact.contains('Account_Related_Contact'), 'Account 화면 전용 설정은 숨김');
        Assert.isTrue(onAccount.contains('Account_Related_Contact'));
        Assert.isNull(new ExcelImportConfigPicklist(null).getDefaultValue());
    }
}
