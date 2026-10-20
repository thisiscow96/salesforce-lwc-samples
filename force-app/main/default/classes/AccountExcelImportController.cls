/**
 * Excel 업로드 → Account + Contact 생성.
 * - Excel 파싱은 브라우저(SheetJS)에서 수행: 파일 원본을 Apex로 보내면 Heap 6MB 제한에 쉽게 걸리기 때문.
 *   클라이언트는 행을 MAX_ROWS_PER_CALL 단위로 나눠 순차 호출 → 호출당 DML 2~3회, SOQL 0~1회로 Governor Limit 여유.
 * - 클라이언트 검증은 UX용일 뿐이므로 서버에서 다시 검증한다.
 * - with sharing + AccessLevel.USER_MODE: 업로드 사용자의 CRUD/FLS/Sharing 그대로 적용.
 * - 부분 성공(allOrNone=false): 실패 행만 결과로 돌려주고 나머지는 저장. Contact가 실패해 비게 된 신규 Account는 삭제(고아 방지).
 * - 같은 Account Name(대소문자·앞뒤 공백 무시)의 행은 하나의 Account를 공유한다.
 *   이전 청크에서 만든 Account는 클라이언트가 accountId로 넘겨 청크 간에도 공유.
 */
public with sharing class AccountExcelImportController {
    @TestVisible
    static final Integer MAX_ROWS_PER_CALL = 200;
    static final String GENERIC_ERROR = '업로드 처리 중 오류가 발생했습니다. 관리자에게 문의하세요.';
    // RFC 전체가 아닌 실무 수준 형식 검사 (최종 판단은 플랫폼의 Email 필드 검증)
    static final Pattern EMAIL_PATTERN = Pattern.compile('^[A-Za-z0-9._%+\'-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$');

    public class ImportRow {
        @AuraEnabled public Integer rowNumber { get; set; }
        @AuraEnabled public String accountName { get; set; }
        @AuraEnabled public String accountId { get; set; }
        @AuraEnabled public String firstName { get; set; }
        @AuraEnabled public String lastName { get; set; }
        @AuraEnabled public String email { get; set; }
    }

    public class RowResult {
        @AuraEnabled public Integer rowNumber;
        @AuraEnabled public Boolean success = false;
        @AuraEnabled public String accountName;
        @AuraEnabled public Id accountId;
        @AuraEnabled public Id contactId;
        @AuraEnabled public String message;

        RowResult(ImportRow row) {
            this.rowNumber = row.rowNumber;
            this.accountName = clean(row.accountName);
        }
    }

    @AuraEnabled
    public static List<RowResult> importRows(List<ImportRow> rows) {
        if (rows == null || rows.isEmpty()) {
            throw userError('업로드할 행이 없습니다.');
        }
        if (rows.size() > MAX_ROWS_PER_CALL) {
            throw userError('한 번에 ' + MAX_ROWS_PER_CALL + '행까지 처리할 수 있습니다.');
        }
        // CRUD를 먼저 확인해 행마다 같은 권한 오류가 반복되는 대신 한 번에 명확히 안내
        if (!Schema.SObjectType.Account.isCreateable() || !Schema.SObjectType.Contact.isCreateable()) {
            throw userError('Account/Contact 생성 권한이 없습니다. 관리자에게 권한을 요청하세요.');
        }
        try {
            return process(rows);
        } catch (Exception e) {
            // 내부 로그와 사용자 메시지 분리
            System.debug(LoggingLevel.ERROR, 'AccountExcelImportController: ' + e.getTypeName() + ' ' + e.getMessage() + '\n' + e.getStackTraceString());
            throw userError(GENERIC_ERROR);
        }
    }

    static List<RowResult> process(List<ImportRow> rows) {
        List<RowResult> results = new List<RowResult>();
        Map<String, Account> newAccountsByKey = new Map<String, Account>();
        List<Integer> pending = new List<Integer>(); // 검증 통과한 행의 인덱스

        for (Integer i = 0; i < rows.size(); i++) {
            ImportRow row = rows[i];
            RowResult result = new RowResult(row);
            results.add(result);
            String error = validate(row);
            if (error != null) {
                result.message = error;
                continue;
            }
            if (String.isNotBlank(row.accountId)) {
                result.accountId = Id.valueOf(row.accountId);
            } else {
                String key = accountKey(row.accountName);
                if (!newAccountsByKey.containsKey(key)) {
                    newAccountsByKey.put(key, new Account(Name = clean(row.accountName)));
                }
            }
            pending.add(i);
        }

        // 1) Account 생성 (이름별 1건)
        Map<String, String> accountErrors = new Map<String, String>();
        if (!newAccountsByKey.isEmpty()) {
            List<String> keys = new List<String>(newAccountsByKey.keySet());
            List<Account> accounts = newAccountsByKey.values();
            List<Database.SaveResult> saved = Database.insert(accounts, false, AccessLevel.USER_MODE);
            for (Integer i = 0; i < saved.size(); i++) {
                if (!saved[i].isSuccess()) {
                    accountErrors.put(keys[i], 'Account 생성 실패: ' + joinErrors(saved[i].getErrors()));
                }
            }
        }

        // 2) Contact 생성
        List<Contact> contacts = new List<Contact>();
        List<RowResult> contactOwners = new List<RowResult>();
        for (Integer i : pending) {
            ImportRow row = rows[i];
            RowResult result = results[i];
            if (result.accountId == null) {
                String key = accountKey(row.accountName);
                if (accountErrors.containsKey(key)) {
                    result.message = accountErrors.get(key);
                    continue;
                }
                result.accountId = newAccountsByKey.get(key).Id;
            }
            contacts.add(new Contact(
                AccountId = result.accountId,
                FirstName = clean(row.firstName),
                LastName = clean(row.lastName),
                Email = clean(row.email)
            ));
            contactOwners.add(result);
        }
        if (!contacts.isEmpty()) {
            List<Database.SaveResult> saved = Database.insert(contacts, false, AccessLevel.USER_MODE);
            for (Integer i = 0; i < saved.size(); i++) {
                RowResult result = contactOwners[i];
                if (saved[i].isSuccess()) {
                    result.success = true;
                    result.contactId = saved[i].getId();
                } else {
                    result.message = 'Contact 생성 실패: ' + joinErrors(saved[i].getErrors());
                }
            }
        }

        removeEmptyNewAccounts(newAccountsByKey.values(), results);
        return results;
    }

    // 이번 호출에서 만들었지만 Contact가 하나도 붙지 않은 Account는 삭제 (재업로드 시 중복 Account 방지)
    static void removeEmptyNewAccounts(List<Account> created, List<RowResult> results) {
        Set<Id> used = new Set<Id>();
        for (RowResult r : results) {
            if (r.success) {
                used.add(r.accountId);
            }
        }
        List<Account> orphans = new List<Account>();
        Set<Id> orphanIds = new Set<Id>();
        for (Account a : created) {
            if (a.Id != null && !used.contains(a.Id)) {
                orphans.add(new Account(Id = a.Id));
                orphanIds.add(a.Id);
            }
        }
        if (orphans.isEmpty()) {
            return;
        }
        List<Database.DeleteResult> deleted = Database.delete(orphans, false, AccessLevel.USER_MODE);
        Set<Id> notDeleted = new Set<Id>();
        for (Integer i = 0; i < deleted.size(); i++) {
            if (!deleted[i].isSuccess()) {
                notDeleted.add(orphans[i].Id); // 삭제 권한이 없는 사용자 → 사실대로 안내
            }
        }
        for (RowResult r : results) {
            if (!r.success && orphanIds.contains(r.accountId)) {
                r.message += notDeleted.contains(r.accountId) ? ' (Account는 생성된 상태로 남음)' : '';
                r.accountId = null;
            }
        }
    }

    @TestVisible
    static String validate(ImportRow row) {
        List<String> errors = new List<String>();
        if (String.isBlank(row.accountId) && String.isBlank(row.accountName)) {
            errors.add('Account Name 필수');
        }
        if (String.isNotBlank(row.accountId) && !isAccountId(row.accountId)) {
            errors.add('잘못된 Account Id');
        }
        if (tooLong(row.accountName, 255)) {
            errors.add('Account Name 255자 초과');
        }
        if (String.isBlank(row.lastName)) {
            errors.add('Last Name 필수');
        } else if (tooLong(row.lastName, 80)) {
            errors.add('Last Name 80자 초과');
        }
        if (tooLong(row.firstName, 40)) {
            errors.add('First Name 40자 초과');
        }
        String email = clean(row.email);
        if (email != null && (tooLong(email, 80) || !EMAIL_PATTERN.matcher(email).matches())) {
            errors.add('Email 형식 오류');
        }
        return errors.isEmpty() ? null : String.join(errors, ', ');
    }

    static Boolean isAccountId(String value) {
        try {
            return Id.valueOf(value).getSObjectType() == Account.SObjectType;
        } catch (Exception e) {
            return false;
        }
    }

    // 필드 길이 초과를 DML 오류 대신 행 단위 안내로 돌려주기 위해 미리 검사
    static Boolean tooLong(String value, Integer max) {
        String v = clean(value);
        return v != null && v.length() > max;
    }

    static String clean(String value) {
        return String.isBlank(value) ? null : value.trim();
    }

    static String accountKey(String name) {
        return clean(name).toLowerCase();
    }

    static String joinErrors(List<Database.Error> errors) {
        List<String> messages = new List<String>();
        for (Database.Error e : errors) {
            messages.add(e.getMessage());
        }
        return String.join(messages, ' / ');
    }

    static AuraHandledException userError(String message) {
        AuraHandledException e = new AuraHandledException(message);
        e.setMessage(message); // getMessage()가 'Script-thrown exception' 대신 실제 문구를 돌려주도록
        return e;
    }
}
