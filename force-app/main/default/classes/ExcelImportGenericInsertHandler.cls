/**
 * 코드 없이 설정만으로 쓰는 범용 Insert Handler.
 * - Target_Object__c 레코드를 행마다 1건 생성. 열 Field_Key__c = 필드 API Name.
 * - Parent_Field__c가 있으면 레코드 화면의 recordId를 그 Lookup에 넣는다 (예: Account 화면 → Contact.AccountId).
 * - 값은 설정에 정의된 열만 넣는다: 화면에서 임의 키를 보내도 다른 필드는 바뀌지 않음.
 * - USER_MODE DML: 사용자의 CRUD/FLS/Sharing을 그대로 적용, 부분 성공.
 */
public with sharing class ExcelImportGenericInsertHandler extends ExcelImportHandler {
    // 열 Data Type별로 받을 수 있는 필드 타입 (설정 실수를 업로드 전에 잡기 위함)
    static final Map<String, Set<Schema.DisplayType>> COMPATIBLE = new Map<String, Set<Schema.DisplayType>>{
        'Number' => new Set<Schema.DisplayType>{
            Schema.DisplayType.DOUBLE, Schema.DisplayType.INTEGER, Schema.DisplayType.LONG,
            Schema.DisplayType.CURRENCY, Schema.DisplayType.PERCENT
        },
        'Date' => new Set<Schema.DisplayType>{ Schema.DisplayType.DATE },
        'Boolean' => new Set<Schema.DisplayType>{ Schema.DisplayType.BOOLEAN }
    };

    public override String validateConfig(ExcelImport.ConfigDef config) {
        Schema.DescribeSObjectResult target = describe(config.targetObject);
        if (target == null) {
            return '설정 오류: Target Object(' + config.targetObject + ')가 없습니다. 관리자에게 문의하세요.';
        }
        if (!target.isCreateable()) {
            return target.getLabel() + ' 생성 권한이 없습니다. 관리자에게 권한을 요청하세요.';
        }
        if (String.isNotBlank(config.parentObject) && String.isBlank(config.parentField)) {
            return '설정 오류: Parent Object가 있으면 Parent Field가 필요합니다. 관리자에게 문의하세요.';
        }
        Map<String, Schema.SObjectField> fields = target.fields.getMap();
        List<String> keys = new List<String>();
        Map<String, String> dataTypes = new Map<String, String>();
        for (ExcelImport.ColumnDef column : config.columns) {
            keys.add(column.key);
            dataTypes.put(column.key, column.dataType);
        }
        if (String.isNotBlank(config.parentField)) {
            keys.add(config.parentField);
        }
        for (String key : keys) {
            Schema.SObjectField field = fields.get(key);
            if (field == null) {
                return '설정 오류: ' + target.getName() + '에 ' + key + ' 필드가 없습니다. 관리자에게 문의하세요.';
            }
            Schema.DescribeFieldResult f = field.getDescribe();
            // describe의 isCreateable은 현재 사용자 FLS 기준 → 권한 없는 열을 업로드 전에 안내
            if (!f.isCreateable()) {
                return target.getLabel() + '.' + f.getLabel() + ' 필드 입력 권한이 없습니다. 관리자에게 권한을 요청하세요.';
            }
            Set<Schema.DisplayType> allowed = COMPATIBLE.get(dataTypes.get(key));
            if (allowed != null && !allowed.contains(f.getType())) {
                return '설정 오류: ' + f.getLabel() + ' 필드(' + f.getType() + ')에 ' + dataTypes.get(key) + ' 열을 넣을 수 없습니다.';
            }
        }
        return null;
    }

    public override void process(ExcelImport.Context ctx, List<ExcelImport.Row> rows) {
        Schema.DescribeSObjectResult target = describe(ctx.config.targetObject);
        Map<String, Schema.SObjectField> fields = target.fields.getMap();
        List<SObject> records = new List<SObject>();
        for (ExcelImport.Row row : rows) {
            SObject record = target.getSObjectType().newSObject();
            for (ExcelImport.ColumnDef column : ctx.config.columns) {
                Object value = row.value(column.key);
                if (value == null) {
                    continue;
                }
                // Integer 필드(예: NumberOfEmployees)에 Decimal을 넣으면 SObjectException → 변환
                if (value instanceof Decimal && fields.get(column.key).getDescribe().getType() == Schema.DisplayType.INTEGER) {
                    value = ((Decimal) value).intValue();
                }
                record.put(column.key, value);
            }
            if (String.isNotBlank(ctx.config.parentField)) {
                record.put(ctx.config.parentField, ctx.recordId);
            }
            records.add(record);
        }
        List<Database.SaveResult> saved = Database.insert(records, false, AccessLevel.USER_MODE);
        for (Integer i = 0; i < saved.size(); i++) {
            if (saved[i].isSuccess()) {
                rows[i].succeed(saved[i].getId());
            } else {
                rows[i].fail(target.getLabel() + ' 생성 실패: ' + ExcelImport.joinErrors(saved[i].getErrors()));
            }
        }
    }

    static Schema.DescribeSObjectResult describe(String objectName) {
        if (String.isBlank(objectName)) {
            return null;
        }
        try {
            return Schema.describeSObjects(new List<String>{ objectName.trim() })[0];
        } catch (Exception e) {
            return null; // 없는 Object
        }
    }
}
