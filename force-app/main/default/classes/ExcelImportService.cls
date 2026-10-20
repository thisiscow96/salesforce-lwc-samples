/**
 * Excel 업로드 공통 엔진: 설정 로드·검증, 공통 열 검증, Handler 분기.
 * - 설정(configName)은 Excel_Import_Config__mdt.DeveloperName. 없거나 비활성·불완전하면 UserException으로 화면에 안내.
 * - 클라이언트(LWC)가 이미 검증했더라도 매 호출 설정·권한·열 검증을 다시 한다 (클라이언트 값은 신뢰하지 않음).
 * - with sharing: 레코드 접근은 업로드 사용자 기준. DML은 각 Handler가 AccessLevel.USER_MODE로 수행.
 */
public with sharing class ExcelImportService {
    // 테스트에서 CMDT를 DML로 만들 수 없으므로 설정을 주입하는 통로
    @TestVisible
    static Map<String, ExcelImport.ConfigDef> testConfigs = new Map<String, ExcelImport.ConfigDef>();

    // RFC 전체가 아닌 실무 수준 형식 검사 (최종 판단은 플랫폼 Email 필드 검증). LWC importUtils와 같은 규칙
    static final Pattern EMAIL_PATTERN = Pattern.compile('^[A-Za-z0-9._%+\'-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$');
    static final Pattern DATE_PATTERN = Pattern.compile('^(\\d{4})-(\\d{1,2})-(\\d{1,2})$');
    static final Set<String> TRUE_VALUES = new Set<String>{ 'true', 'y', 'yes', '1', '예', 'o' };
    static final Set<String> FALSE_VALUES = new Set<String>{ 'false', 'n', 'no', '0', '아니오', 'x' };

    /** 화면 진입 시 설정 조회 + 사용 가능 여부(설정·화면 위치·권한) 검증 */
    public static ExcelImport.ConfigDef getConfig(String configName, Id recordId) {
        ExcelImport.ConfigDef config = loadConfig(configName);
        checkRecordContext(config, recordId);
        String error = newHandler(config).validateConfig(config);
        if (error != null) {
            throw new ExcelImport.UserException(error);
        }
        return config;
    }

    /** 레코드 Quick Action용: 레코드 Object에 Record Action Default로 지정된 설정 이름 */
    public static String resolveRecordConfigName(Id recordId) {
        if (recordId == null) {
            throw new ExcelImport.UserException('레코드 화면에서만 사용할 수 있습니다 (recordId 없음).');
        }
        String objectName = recordId.getSObjectType().getDescribe().getName();
        Set<String> names = new Set<String>();
        for (Excel_Import_Config__mdt record : [
            SELECT DeveloperName
            FROM Excel_Import_Config__mdt
            WHERE Parent_Object__c = :objectName AND Record_Action_Default__c = TRUE AND Active__c = TRUE
        ]) {
            names.add(record.DeveloperName);
        }
        for (ExcelImport.ConfigDef config : testConfigs.values()) {
            if (config.active && config.recordActionDefault && objectName.equalsIgnoreCase(config.parentObject)) {
                names.add(config.name);
            }
        }
        if (names.isEmpty()) {
            throw new ExcelImport.UserException(
                objectName + ' 레코드용 Excel 업로드 설정이 없습니다. 관리자: Excel Import Config에 Parent Object = ' +
                objectName + ', Record Action Default = true 인 설정을 등록하세요.'
            );
        }
        if (names.size() > 1) {
            throw new ExcelImport.UserException(
                objectName + ' 레코드용 기본 Excel 업로드 설정이 여러 개입니다 (' + String.join(new List<String>(names), ', ') +
                '). 관리자: Record Action Default는 Object당 1건만 체크하세요.'
            );
        }
        return new List<String>(names)[0];
    }

    /** 청크 1개 업로드. requestJson = {"rows":[{"rowNumber":2,"values":{"key":"값"}}], "carryOver":{...}} */
    public static ExcelImport.Response importRows(String configName, Id recordId, String requestJson) {
        ExcelImport.ConfigDef config = getConfig(configName, recordId);
        ImportRequest request = parseRequest(requestJson);
        if (request.rows.size() > config.chunkSize) {
            throw new ExcelImport.UserException('한 번에 ' + config.chunkSize + '행까지 처리할 수 있습니다.');
        }

        ExcelImportHandler handler = newHandler(config);
        ExcelImport.Context ctx = new ExcelImport.Context(config, recordId, request.carryOver);
        List<ExcelImport.Row> rows = new List<ExcelImport.Row>();
        List<ExcelImport.Row> valid = new List<ExcelImport.Row>();
        for (RowInput input : request.rows) {
            ExcelImport.Row row = new ExcelImport.Row(input.rowNumber, input.values);
            rows.add(row);
            String error = validateColumns(config, row);
            if (error == null) {
                error = handler.validateRow(ctx, row);
            }
            if (error == null) {
                valid.add(row);
            } else {
                row.fail(error);
            }
        }

        if (!valid.isEmpty()) {
            // Handler 중간 실패 시 이 청크에서 만든 데이터가 반쯤 남지 않도록 롤백
            Savepoint savepoint = Database.setSavepoint();
            try {
                handler.process(ctx, valid);
            } catch (Exception e) {
                Database.rollback(savepoint);
                throw e;
            }
        }

        ExcelImport.Response response = new ExcelImport.Response();
        for (ExcelImport.Row row : rows) {
            if (!row.isDone()) {
                // Handler 구현 누락 방어: 결과 없는 행을 성공으로 오인하지 않게 실패 처리
                System.debug(LoggingLevel.ERROR, 'ExcelImport: ' + config.handlerClass + ' 가 ' + row.rowNumber + '행 결과를 남기지 않음');
                row.fail('처리 결과가 없습니다. 관리자에게 문의하세요.');
            }
            response.results.add(row.result);
        }
        response.carryOver = ctx.carryOver;
        return response;
    }

    // ───────────────────────── 설정 ─────────────────────────

    static ExcelImport.ConfigDef loadConfig(String configName) {
        if (String.isBlank(configName)) {
            throw new ExcelImport.UserException(
                'Excel 업로드 설정값(configName)이 지정되지 않았습니다. 컴포넌트 속성 또는 URL 파라미터 c__configName 을 확인하세요.'
            );
        }
        String name = configName.trim();
        ExcelImport.ConfigDef config = testConfigs.get(name);
        if (config == null) {
            List<Excel_Import_Config__mdt> records = [
                SELECT DeveloperName, MasterLabel, Active__c, Handler_Class__c, Target_Object__c, Parent_Object__c,
                    Parent_Field__c, Record_Action_Default__c, Chunk_Size__c, Max_Rows__c, Template_File_Name__c, Guide__c
                FROM Excel_Import_Config__mdt
                WHERE DeveloperName = :name
                LIMIT 1
            ];
            if (records.isEmpty()) {
                throw new ExcelImport.UserException(
                    'Excel 업로드 설정 \'' + name + '\'을(를) 찾을 수 없습니다. 관리자: Setup > Custom Metadata Types > Excel Import Config 에 등록하세요.'
                );
            }
            config = toConfig(records[0], [
                SELECT DeveloperName, Field_Key__c, Column_Label__c, Aliases__c, Required__c, Max_Length__c, Data_Type__c,
                    Unique_In_File__c, Sort_Order__c, Sample_Value__c
                FROM Excel_Import_Column__mdt
                WHERE Config__c = :records[0].Id
                ORDER BY Sort_Order__c, DeveloperName
            ]);
        }
        if (config.active != true) {
            throw new ExcelImport.UserException('Excel 업로드 설정 \'' + name + '\'이(가) 비활성화되어 있습니다. 관리자에게 문의하세요.');
        }
        if (config.columns == null || config.columns.isEmpty()) {
            throw new ExcelImport.UserException(
                'Excel 업로드 설정 \'' + name + '\'에 열 정의(Excel Import Column)가 없습니다. 관리자에게 문의하세요.'
            );
        }
        return config;
    }

    @TestVisible
    static ExcelImport.ConfigDef toConfig(Excel_Import_Config__mdt record, List<Excel_Import_Column__mdt> columnRecords) {
        ExcelImport.ConfigDef config = new ExcelImport.ConfigDef();
        config.name = record.DeveloperName;
        config.label = record.MasterLabel;
        config.active = record.Active__c;
        config.handlerClass = record.Handler_Class__c;
        config.targetObject = record.Target_Object__c;
        config.parentObject = record.Parent_Object__c;
        config.parentField = record.Parent_Field__c;
        config.recordActionDefault = record.Record_Action_Default__c;
        config.guide = record.Guide__c;
        // 잘못 입력돼도 Governor Limit 범위를 벗어나지 않게 보정
        Integer chunk = record.Chunk_Size__c == null ? ExcelImport.MAX_CHUNK_SIZE : record.Chunk_Size__c.intValue();
        config.chunkSize = Math.max(1, Math.min(chunk, ExcelImport.MAX_CHUNK_SIZE));
        config.maxRows = record.Max_Rows__c == null || record.Max_Rows__c < 1 ? ExcelImport.DEFAULT_MAX_ROWS : record.Max_Rows__c.intValue();
        config.templateFileName = String.isBlank(record.Template_File_Name__c)
            ? record.DeveloperName + '_template.xlsx'
            : record.Template_File_Name__c;
        for (Excel_Import_Column__mdt c : columnRecords) {
            ExcelImport.ColumnDef column = new ExcelImport.ColumnDef();
            column.key = c.Field_Key__c;
            column.label = c.Column_Label__c;
            column.required = c.Required__c;
            column.maxLength = c.Max_Length__c == null ? null : c.Max_Length__c.intValue();
            column.dataType = String.isBlank(c.Data_Type__c) ? 'Text' : c.Data_Type__c;
            column.uniqueInFile = c.Unique_In_File__c;
            column.sampleValue = c.Sample_Value__c;
            column.aliases = new List<String>();
            for (String alias : (c.Aliases__c == null ? '' : c.Aliases__c).split(',')) {
                if (String.isNotBlank(alias)) {
                    column.aliases.add(alias.trim());
                }
            }
            config.columns.add(column);
        }
        return config;
    }

    // Parent Object가 지정된 설정은 해당 Object 레코드 화면에서만, 접근 가능한 레코드에서만 사용
    static void checkRecordContext(ExcelImport.ConfigDef config, Id recordId) {
        if (String.isBlank(config.parentObject)) {
            return;
        }
        if (recordId == null) {
            throw new ExcelImport.UserException(
                '\'' + config.label + '\'은(는) ' + config.parentObject + ' 레코드 화면에서만 사용할 수 있습니다.'
            );
        }
        Schema.SObjectType type = recordId.getSObjectType();
        if (!type.getDescribe().getName().equalsIgnoreCase(config.parentObject)) {
            throw new ExcelImport.UserException(
                '\'' + config.label + '\'은(는) ' + config.parentObject + ' 레코드 화면용입니다 (현재: ' + type.getDescribe().getName() + ').'
            );
        }
        // Object 이름은 사용자 입력이 아닌 Id의 SObjectType에서 얻으므로 SOQL Injection 위험 없음
        List<SObject> visible = Database.query(
            'SELECT Id FROM ' + type.getDescribe().getName() + ' WHERE Id = :recordId LIMIT 1',
            AccessLevel.USER_MODE
        );
        if (visible.isEmpty()) {
            throw new ExcelImport.UserException('레코드에 접근 권한이 없거나 삭제된 레코드입니다.');
        }
    }

    static ExcelImportHandler newHandler(ExcelImport.ConfigDef config) {
        Object instance;
        try {
            Type handlerType = String.isBlank(config.handlerClass) ? null : Type.forName(config.handlerClass.trim());
            instance = handlerType == null ? null : handlerType.newInstance();
        } catch (Exception e) {
            instance = null; // public 기본 생성자가 없는 클래스 등
        }
        if (!(instance instanceof ExcelImportHandler)) {
            throw new ExcelImport.UserException(
                'Excel 업로드 설정 \'' + config.name + '\'의 처리 클래스(' + config.handlerClass +
                ')가 없거나 ExcelImportHandler를 상속하지 않습니다. 관리자에게 문의하세요.'
            );
        }
        return (ExcelImportHandler) instance;
    }

    // ───────────────────────── 요청·검증 ─────────────────────────

    class ImportRequest {
        List<RowInput> rows = new List<RowInput>();
        Map<String, String> carryOver = new Map<String, String>();
    }

    class RowInput {
        Integer rowNumber;
        Map<String, String> values;
    }

    static ImportRequest parseRequest(String requestJson) {
        ImportRequest request;
        try {
            request = String.isBlank(requestJson) ? null : (ImportRequest) JSON.deserialize(requestJson, ImportRequest.class);
        } catch (JSONException e) {
            throw new ExcelImport.UserException('업로드 요청 형식이 올바르지 않습니다.');
        }
        if (request == null || request.rows == null || request.rows.isEmpty()) {
            throw new ExcelImport.UserException('업로드할 행이 없습니다.');
        }
        if (request.carryOver == null) {
            request.carryOver = new Map<String, String>();
        }
        return request;
    }

    /** 설정의 열 정의로 필수·길이·형식 검증 + 형 변환. 오류 문구(여러 개면 쉼표) 또는 null */
    @TestVisible
    static String validateColumns(ExcelImport.ConfigDef config, ExcelImport.Row row) {
        List<String> errors = new List<String>();
        for (ExcelImport.ColumnDef column : config.columns) {
            String value = row.text(column.key);
            if (value == null) {
                if (column.required) {
                    errors.add(column.label + ' 필수');
                }
                continue;
            }
            if (column.maxLength != null && value.length() > column.maxLength) {
                errors.add(column.label + ' ' + column.maxLength + '자 초과');
                continue;
            }
            try {
                row.setValue(column.key, convert(column.dataType, value));
            } catch (ExcelImport.UserException e) {
                errors.add(column.label + ' ' + e.getMessage());
            }
        }
        return errors.isEmpty() ? null : String.join(errors, ', ');
    }

    @TestVisible
    static Object convert(String dataType, String value) {
        switch on dataType {
            when 'Email' {
                if (!EMAIL_PATTERN.matcher(value).matches()) {
                    throw new ExcelImport.UserException('형식 오류');
                }
                return value;
            }
            when 'Number' {
                try {
                    return Decimal.valueOf(value.replace(',', ''));
                } catch (TypeException e) {
                    throw new ExcelImport.UserException('숫자 형식 오류');
                }
            }
            when 'Date' {
                Matcher m = DATE_PATTERN.matcher(value);
                if (m.matches()) {
                    Integer y = Integer.valueOf(m.group(1));
                    Integer mo = Integer.valueOf(m.group(2));
                    Integer d = Integer.valueOf(m.group(3));
                    // 2월 30일처럼 넘치는 날짜는 다음 달로 굴러가므로 되돌려 비교해 걸러냄
                    if (mo >= 1 && mo <= 12 && d >= 1 && d <= Date.daysInMonth(y, mo)) {
                        return Date.newInstance(y, mo, d);
                    }
                }
                throw new ExcelImport.UserException('날짜 형식 오류 (yyyy-mm-dd)');
            }
            when 'Boolean' {
                String v = value.toLowerCase();
                if (TRUE_VALUES.contains(v)) {
                    return true;
                }
                if (FALSE_VALUES.contains(v)) {
                    return false;
                }
                throw new ExcelImport.UserException('true/false 형식 오류');
            }
            when else {
                return value;
            }
        }
    }
}
