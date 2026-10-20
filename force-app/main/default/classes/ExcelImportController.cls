/**
 * Excel 업로드 공통 컴포넌트(c-excel-import)의 Apex 진입점. 로직은 ExcelImportService에 있다.
 * - 사용자 메시지와 내부 로그 분리: ExcelImport.UserException은 문구 그대로, 그 외 예외는 로그만 남기고 일반 문구.
 * - recordId를 String으로 받는 이유: Id 타입이면 잘못된 값이 들어올 때 플랫폼 역직렬화 오류(알아보기 힘든 문구)가 나기 때문.
 * - cacheable 미사용: 설정·권한 변경이 다음 화면 진입에 바로 반영되어야 하고, 호출은 화면당 1회뿐이다.
 */
public with sharing class ExcelImportController {
    static final String GENERIC_ERROR = '업로드 처리 중 오류가 발생했습니다. 관리자에게 문의하세요.';

    @AuraEnabled
    public static ExcelImport.ConfigDef getConfig(String configName, String recordId) {
        try {
            return ExcelImportService.getConfig(configName, toId(recordId));
        } catch (Exception e) {
            throw toAuraException(e);
        }
    }

    @AuraEnabled
    public static String resolveRecordConfig(String recordId) {
        try {
            return ExcelImportService.resolveRecordConfigName(toId(recordId));
        } catch (Exception e) {
            throw toAuraException(e);
        }
    }

    @AuraEnabled
    public static ExcelImport.Response importRows(String configName, String recordId, String requestJson) {
        try {
            return ExcelImportService.importRows(configName, toId(recordId), requestJson);
        } catch (Exception e) {
            throw toAuraException(e);
        }
    }

    static Id toId(String value) {
        if (String.isBlank(value)) {
            return null;
        }
        try {
            return Id.valueOf(value.trim());
        } catch (Exception e) {
            throw new ExcelImport.UserException('잘못된 레코드 Id 입니다: ' + value);
        }
    }

    @TestVisible
    static AuraHandledException toAuraException(Exception e) {
        String message;
        if (e instanceof ExcelImport.UserException) {
            message = e.getMessage();
        } else {
            System.debug(LoggingLevel.ERROR, 'ExcelImportController: ' + e.getTypeName() + ' ' + e.getMessage() + '\n' + e.getStackTraceString());
            message = GENERIC_ERROR;
        }
        AuraHandledException aura = new AuraHandledException(message);
        aura.setMessage(message); // getMessage()가 'Script-thrown exception' 대신 실제 문구를 돌려주도록
        return aura;
    }
}
