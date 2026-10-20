/**
 * 설정 'Account_Contact' Handler: 행마다 Contact 1건, 같은 Account Name(대소문자·앞뒤 공백 무시)은 Account 1건으로 묶는다.
 * - 이전 청크에서 만든 Account Id는 ctx.carryOver('account:<이름>')로 이어받아 청크 간에도 같은 Account를 쓴다.
 *   carryOver는 화면을 거쳐 돌아오는 값이므로 Account Id 형식을 다시 검증한다 (접근 권한은 USER_MODE DML이 판단).
 * - 부분 성공: Contact가 하나도 붙지 않은 신규 Account는 삭제 (재업로드 시 중복 Account 방지).
 * 필요 열 키: accountName, firstName, lastName, email
 */
public with sharing class AccountContactImportHandler extends ExcelImportHandler {
    static final String ACCOUNT_KEY_PREFIX = 'account:';

    public override String validateConfig(ExcelImport.ConfigDef config) {
        // CRUD를 먼저 확인해 행마다 같은 권한 오류가 반복되는 대신 화면 진입 시 한 번에 안내
        if (!Schema.SObjectType.Account.isCreateable() || !Schema.SObjectType.Contact.isCreateable()) {
            return 'Account/Contact 생성 권한이 없습니다. 관리자에게 권한을 요청하세요.';
        }
        return null;
    }

    public override void process(ExcelImport.Context ctx, List<ExcelImport.Row> rows) {
        Map<String, Account> newAccountsByKey = new Map<String, Account>();
        Map<Integer, Id> existingAccountIds = new Map<Integer, Id>(); // rowNumber → carryOver Account Id
        List<ExcelImport.Row> pending = new List<ExcelImport.Row>();

        for (ExcelImport.Row row : rows) {
            String key = accountKey(row.text('accountName'));
            String carried = ctx.carryOver.get(ACCOUNT_KEY_PREFIX + key);
            if (carried != null) {
                Id accountId = toAccountId(carried);
                if (accountId == null) {
                    row.fail('잘못된 Account Id');
                    continue;
                }
                existingAccountIds.put(row.rowNumber, accountId);
            } else if (!newAccountsByKey.containsKey(key)) {
                newAccountsByKey.put(key, new Account(Name = row.text('accountName')));
            }
            pending.add(row);
        }

        // 1) Account 생성 (이름별 1건)
        Map<String, String> accountErrors = new Map<String, String>();
        if (!newAccountsByKey.isEmpty()) {
            List<String> keys = new List<String>(newAccountsByKey.keySet());
            List<Database.SaveResult> saved = Database.insert(newAccountsByKey.values(), false, AccessLevel.USER_MODE);
            for (Integer i = 0; i < saved.size(); i++) {
                if (!saved[i].isSuccess()) {
                    accountErrors.put(keys[i], 'Account 생성 실패: ' + ExcelImport.joinErrors(saved[i].getErrors()));
                }
            }
        }

        // 2) Contact 생성
        List<Contact> contacts = new List<Contact>();
        List<ExcelImport.Row> contactRows = new List<ExcelImport.Row>();
        for (ExcelImport.Row row : pending) {
            String key = accountKey(row.text('accountName'));
            Id accountId = existingAccountIds.get(row.rowNumber);
            if (accountId == null) {
                if (accountErrors.containsKey(key)) {
                    row.fail(accountErrors.get(key));
                    continue;
                }
                accountId = newAccountsByKey.get(key).Id;
            }
            contacts.add(new Contact(
                AccountId = accountId,
                FirstName = row.text('firstName'),
                LastName = row.text('lastName'),
                Email = (String) row.value('email')
            ));
            contactRows.add(row);
        }
        Map<String, Integer> successByKey = new Map<String, Integer>();
        if (!contacts.isEmpty()) {
            List<Database.SaveResult> saved = Database.insert(contacts, false, AccessLevel.USER_MODE);
            for (Integer i = 0; i < saved.size(); i++) {
                ExcelImport.Row row = contactRows[i];
                if (saved[i].isSuccess()) {
                    row.succeed(saved[i].getId());
                    String key = accountKey(row.text('accountName'));
                    successByKey.put(key, (successByKey.containsKey(key) ? successByKey.get(key) : 0) + 1);
                } else {
                    row.fail('Contact 생성 실패: ' + ExcelImport.joinErrors(saved[i].getErrors()));
                }
            }
        }

        removeEmptyNewAccounts(newAccountsByKey, successByKey, rows);
        // Contact가 붙은 신규 Account만 다음 청크로 넘김
        for (String key : newAccountsByKey.keySet()) {
            if (successByKey.containsKey(key)) {
                ctx.carryOver.put(ACCOUNT_KEY_PREFIX + key, newAccountsByKey.get(key).Id);
            }
        }
    }

    // 이번 호출에서 만들었지만 Contact가 하나도 붙지 않은 Account는 삭제
    static void removeEmptyNewAccounts(Map<String, Account> created, Map<String, Integer> successByKey, List<ExcelImport.Row> rows) {
        List<Account> orphans = new List<Account>();
        List<String> orphanKeys = new List<String>();
        for (String key : created.keySet()) {
            Account a = created.get(key);
            if (a.Id != null && !successByKey.containsKey(key)) {
                orphans.add(new Account(Id = a.Id));
                orphanKeys.add(key);
            }
        }
        if (orphans.isEmpty()) {
            return;
        }
        List<Database.DeleteResult> deleted = Database.delete(orphans, false, AccessLevel.USER_MODE);
        Set<String> notDeleted = new Set<String>();
        for (Integer i = 0; i < deleted.size(); i++) {
            if (!deleted[i].isSuccess()) {
                notDeleted.add(orphanKeys[i]); // 삭제 권한이 없는 사용자 → 사실대로 안내
            }
        }
        for (ExcelImport.Row row : rows) {
            if (!row.result.success && notDeleted.contains(accountKey(row.text('accountName')))) {
                row.fail(row.result.message + ' (Account는 생성된 상태로 남음)');
            }
        }
    }

    static Id toAccountId(String value) {
        try {
            Id accountId = Id.valueOf(value);
            return accountId.getSObjectType() == Account.SObjectType ? accountId : null;
        } catch (Exception e) {
            return null;
        }
    }

    static String accountKey(String name) {
        return name == null ? '' : name.trim().toLowerCase();
    }
}
