/**
 * Excel 업로드 공통 엔진의 공유 타입.
 *
 * 흐름: LWC c-excel-import(configName, recordId)
 *       → ExcelImportController (AuraEnabled 진입점, 사용자 메시지/내부 로그 분리)
 *       → ExcelImportService   (설정 로드·검증, 공통 열 검증, Handler 분기)
 *       → Excel_Import_Config__mdt.Handler_Class__c 에 지정된 ExcelImportHandler 구현체 (설정별 저장 로직)
 *
 * 새 업로드 화면 추가 = CMDT 레코드(Config + Column) 등록. 단순 Insert는 코드 없이 ExcelImportGenericInsertHandler,
 * 업무 로직이 필요하면 ExcelImportHandler를 상속한 클래스를 만들어 Handler_Class__c에 지정한다.
 */
public inherited sharing class ExcelImport {
    // 호출당 최대 행 수. 트리거 1회 실행 단위(200)와 맞춰 Governor Limit 계산을 단순하게 유지
    public static final Integer MAX_CHUNK_SIZE = 200;
    public static final Integer DEFAULT_MAX_ROWS = 5000;

    /** 사용자에게 그대로 보여 줄 오류 (설정 누락·비활성, 권한, 잘못된 화면 등). 그 외 예외는 일반 문구로 바뀐다 */
    public class UserException extends Exception {}

    /** 화면에 내려가는 열 정의 (@AuraEnabled 필드만 직렬화) */
    public class ColumnDef {
        @AuraEnabled public String key;
        @AuraEnabled public String label;
        @AuraEnabled public List<String> aliases = new List<String>();
        @AuraEnabled public Boolean required = false;
        @AuraEnabled public Integer maxLength;
        @AuraEnabled public String dataType = 'Text';
        @AuraEnabled public Boolean uniqueInFile = false;
        @AuraEnabled public String sampleValue;
    }

    /** 설정. Handler 클래스명·Parent Field 같은 내부 값은 @AuraEnabled가 아니어서 화면으로 내려가지 않는다 */
    public class ConfigDef {
        @AuraEnabled public String name;
        @AuraEnabled public String label;
        @AuraEnabled public String guide;
        @AuraEnabled public String targetObject;
        @AuraEnabled public String parentObject;
        @AuraEnabled public Integer chunkSize = MAX_CHUNK_SIZE;
        @AuraEnabled public Integer maxRows = DEFAULT_MAX_ROWS;
        @AuraEnabled public String templateFileName;
        @AuraEnabled public List<ColumnDef> columns = new List<ColumnDef>();
        public Boolean active = false;
        public Boolean recordActionDefault = false;
        public String handlerClass;
        public String parentField;
    }

    /** Handler에 전달되는 실행 컨텍스트 */
    public class Context {
        public ConfigDef config { get; private set; }
        public Id recordId { get; private set; }
        /**
         * 청크 간 공유 값 (예: 앞 청크에서 만든 Account Id). 응답으로 화면에 돌려주고 다음 호출에 다시 받는다.
         * 클라이언트를 거치므로 Handler는 이 값을 신뢰하지 말고 형식·권한을 검증해서 써야 한다.
         */
        public Map<String, String> carryOver { get; private set; }

        public Context(ConfigDef config, Id recordId, Map<String, String> carryOver) {
            this.config = config;
            this.recordId = recordId;
            this.carryOver = carryOver == null ? new Map<String, String>() : carryOver;
        }
    }

    /** 업로드 1행. 공통 검증을 통과하면 typed 값이 채워진 상태로 Handler에 전달된다 */
    public class Row {
        public final Integer rowNumber;
        public final RowResult result;
        private final Map<String, String> raw;
        private final Map<String, Object> typed = new Map<String, Object>();

        public Row(Integer rowNumber, Map<String, String> raw) {
            this.rowNumber = rowNumber;
            this.raw = raw == null ? new Map<String, String>() : raw;
            this.result = new RowResult(rowNumber);
        }

        /** 앞뒤 공백을 제거한 문자열, 비어 있으면 null */
        public String text(String key) {
            String value = raw.get(key);
            return String.isBlank(value) ? null : value.trim();
        }

        /** 열 Data Type에 맞게 변환된 값 (Text/Email → String, Number → Decimal, Date → Date, Boolean → Boolean) */
        public Object value(String key) {
            return typed.get(key);
        }

        public void setValue(String key, Object value) {
            typed.put(key, value);
        }

        public void succeed(Id recordId) {
            result.success = true;
            result.recordId = recordId;
            result.message = null;
        }

        public void fail(String message) {
            result.success = false;
            result.message = message;
        }

        public Boolean isDone() {
            return result.success || result.message != null;
        }
    }

    public class RowResult {
        @AuraEnabled public Integer rowNumber;
        @AuraEnabled public Boolean success = false;
        @AuraEnabled public Id recordId;
        @AuraEnabled public String message;

        RowResult(Integer rowNumber) {
            this.rowNumber = rowNumber;
        }
    }

    public class Response {
        @AuraEnabled public List<RowResult> results = new List<RowResult>();
        @AuraEnabled public Map<String, String> carryOver = new Map<String, String>();
    }

    /** Database.Error 목록 → 한 줄 문구 (Handler 공용) */
    public static String joinErrors(List<Database.Error> errors) {
        List<String> messages = new List<String>();
        for (Database.Error e : errors) {
            messages.add(e.getMessage());
        }
        return String.join(messages, ' / ');
    }
}
