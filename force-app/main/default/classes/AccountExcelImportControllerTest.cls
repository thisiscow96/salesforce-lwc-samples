@IsTest
private class AccountExcelImportControllerTest {
    static final String PREFIX = 'ImportTest ';

    static AccountExcelImportController.ImportRow row(Integer n, String accountName, String firstName, String lastName, String email) {
        AccountExcelImportController.ImportRow r = new AccountExcelImportController.ImportRow();
        r.rowNumber = n;
        r.accountName = accountName;
        r.firstName = firstName;
        r.lastName = lastName;
        r.email = email;
        return r;
    }

    // 권한 없는 사용자: Minimum Access 프로필 (Account/Contact 생성 권한 없음)
    static User minimumAccessUser() {
        Profile p = [SELECT Id FROM Profile WHERE Name = 'Minimum Access - Salesforce' LIMIT 1];
        String unique = String.valueOf(Crypto.getRandomInteger()).remove('-');
        User u = new User(
            Alias = 'imp' + unique.left(4), Email = 'import' + unique + '@example.com', EmailEncodingKey = 'UTF-8',
            LastName = 'Importer', LanguageLocaleKey = 'ko', LocaleSidKey = 'ko_KR', TimeZoneSidKey = 'Asia/Seoul',
            ProfileId = p.Id, Username = 'import' + unique + '@example.com.test'
        );
        insert u;
        return u;
    }

    @IsTest
    static void bulk200RowsShareAccountsByName() {
        List<AccountExcelImportController.ImportRow> rows = new List<AccountExcelImportController.ImportRow>();
        for (Integer i = 0; i < AccountExcelImportController.MAX_ROWS_PER_CALL; i++) {
            // 50개 회사 × 4명. 대소문자·공백이 달라도 같은 Account로 묶여야 함
            String name = PREFIX + Math.mod(i, 50);
            rows.add(row(i + 2, Math.mod(i, 2) == 0 ? name : '  ' + name.toUpperCase() + ' ', 'First' + i, 'Last' + i, 'user' + i + '@example.com'));
        }

        Test.startTest();
        List<AccountExcelImportController.RowResult> results = AccountExcelImportController.importRows(rows);
        Integer dmlRows = Limits.getDmlRows();
        Test.stopTest();

        Assert.areEqual(200, results.size());
        for (AccountExcelImportController.RowResult r : results) {
            Assert.isTrue(r.success, 'row ' + r.rowNumber + ': ' + r.message);
            Assert.isNotNull(r.contactId);
            Assert.isNotNull(r.accountId);
        }
        Assert.areEqual(50, [SELECT COUNT() FROM Account WHERE Name LIKE :PREFIX + '%'], '회사명 기준 50건만 생성');
        Assert.areEqual(200, [SELECT COUNT() FROM Contact WHERE Account.Name LIKE :PREFIX + '%']);
        Assert.areEqual(250, dmlRows, 'Account 50 + Contact 200, 추가 DML 없음');

        Contact c = [SELECT FirstName, LastName, Email, Account.Name FROM Contact WHERE Id = :results[0].contactId];
        Assert.areEqual('First0', c.FirstName);
        Assert.areEqual('Last0', c.LastName);
        Assert.areEqual('user0@example.com', c.Email);
        Assert.areEqual(PREFIX + '0', c.Account.Name, '처음 나온 표기(trim)로 Account 이름 저장');
    }

    @IsTest
    static void invalidRowsAreRejectedWithoutBlockingValidRows() {
        List<AccountExcelImportController.ImportRow> rows = new List<AccountExcelImportController.ImportRow>{
            row(2, PREFIX + 'Valid', 'Gil-dong', 'Hong', 'hong@example.com'),
            row(3, PREFIX + 'NoLast', 'A', ' ', 'a@example.com'),
            row(4, ' ', 'B', 'Kim', 'b@example.com'),
            row(5, PREFIX + 'BadMail', 'C', 'Lee', 'not-an-email'),
            row(6, PREFIX + 'Long', 'x'.repeat(41), 'Park', null)
        };
        AccountExcelImportController.ImportRow badId = row(7, null, 'D', 'Choi', null);
        badId.accountId = UserInfo.getUserId(); // Account가 아닌 Id
        rows.add(badId);

        Test.startTest();
        List<AccountExcelImportController.RowResult> results = AccountExcelImportController.importRows(rows);
        Test.stopTest();

        Assert.isTrue(results[0].success);
        Assert.areEqual('Last Name 필수', results[1].message);
        Assert.areEqual('Account Name 필수', results[2].message);
        Assert.areEqual('Email 형식 오류', results[3].message);
        Assert.areEqual('First Name 40자 초과', results[4].message);
        Assert.isTrue(results[5].message.contains('잘못된 Account Id'), results[5].message);
        for (Integer i = 1; i < results.size(); i++) {
            Assert.isFalse(results[i].success);
            Assert.isNull(results[i].contactId);
        }
        Assert.areEqual(1, [SELECT COUNT() FROM Account WHERE Name LIKE :PREFIX + '%'], '실패 행의 Account는 만들지 않음');
        Assert.areEqual(1, [SELECT COUNT() FROM Contact]);
    }

    @IsTest
    static void reusesAccountIdFromPreviousChunk() {
        Account existing = new Account(Name = PREFIX + 'Chunk1');
        insert existing;
        AccountExcelImportController.ImportRow r = row(300, PREFIX + 'Chunk1', 'Next', 'Chunk', null);
        r.accountId = existing.Id;

        Test.startTest();
        List<AccountExcelImportController.RowResult> results = AccountExcelImportController.importRows(new List<AccountExcelImportController.ImportRow>{ r });
        Test.stopTest();

        Assert.isTrue(results[0].success, 'message=' + results[0].message);
        Assert.areEqual(existing.Id, results[0].accountId);
        Assert.areEqual(1, [SELECT COUNT() FROM Account WHERE Name LIKE :PREFIX + '%'], '새 Account를 만들지 않음');
    }

    @IsTest
    static void userWithoutCreatePermissionGetsClearError() {
        User u = minimumAccessUser();
        Test.startTest();
        System.runAs(u) {
            try {
                AccountExcelImportController.importRows(new List<AccountExcelImportController.ImportRow>{ row(2, PREFIX + 'NoPerm', 'A', 'B', null) });
                Assert.fail('권한 오류가 발생해야 함');
            } catch (AuraHandledException e) {
                Assert.areEqual('Account/Contact 생성 권한이 없습니다. 관리자에게 권한을 요청하세요.', e.getMessage());
            }
        }
        Test.stopTest();
        Assert.areEqual(0, [SELECT COUNT() FROM Account WHERE Name LIKE :PREFIX + '%']);
    }

    @IsTest
    static void contactFailureRemovesNewlyCreatedAccount() {
        // 'a@x..com'은 형식 검사는 통과하지만 플랫폼 Email 검증에서 거부됨 → Contact만 실패하는 실제 경로
        List<AccountExcelImportController.ImportRow> rows = new List<AccountExcelImportController.ImportRow>{
            row(2, PREFIX + 'Orphan', 'A', 'Bad', 'a@x..com'),
            row(3, PREFIX + 'Shared', 'B', 'Bad', 'b@x..com'),
            row(4, PREFIX + 'Shared', 'C', 'Good', 'c@example.com')
        };

        Test.startTest();
        List<AccountExcelImportController.RowResult> results = AccountExcelImportController.importRows(rows);
        Test.stopTest();

        Assert.isFalse(results[0].success);
        Assert.isTrue(results[0].message.startsWith('Contact 생성 실패'), results[0].message);
        Assert.isNull(results[0].accountId, '삭제된 Account Id를 돌려주지 않음');
        Assert.isFalse(results[1].success);
        Assert.isNotNull(results[1].accountId, '같은 Account에 성공한 Contact가 있으면 Account 유지');
        Assert.isTrue(results[2].success);
        Assert.areEqual(1, [SELECT COUNT() FROM Account WHERE Name LIKE :PREFIX + '%'], 'Orphan Account만 삭제');
        Assert.areEqual(PREFIX + 'Shared', [SELECT Name FROM Account WHERE Name LIKE :PREFIX + '%'].Name);
    }

    @IsTest
    static void rejectsEmptyAndOversizedRequests() {
        List<AccountExcelImportController.ImportRow> tooMany = new List<AccountExcelImportController.ImportRow>();
        for (Integer i = 0; i <= AccountExcelImportController.MAX_ROWS_PER_CALL; i++) {
            tooMany.add(row(i, 'A', null, 'B', null));
        }
        for (List<AccountExcelImportController.ImportRow> input : new List<List<AccountExcelImportController.ImportRow>>{ null, new List<AccountExcelImportController.ImportRow>(), tooMany }) {
            try {
                AccountExcelImportController.importRows(input);
                Assert.fail('예외가 발생해야 함');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('업로드할 행이 없습니다') || e.getMessage().contains('200행까지'), e.getMessage());
            }
        }
        Assert.areEqual(0, [SELECT COUNT() FROM Account]);
    }
}
