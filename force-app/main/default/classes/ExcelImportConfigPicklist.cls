/**
 * Lightning App Builder에서 c-excel-import의 configName을 드롭다운으로 고르게 하는 Dynamic Picklist.
 * 레코드 페이지에서는 그 Object용(Parent Object 일치) 설정과 Parent Object가 없는 설정만 보여 준다.
 * (VisualEditor.DynamicPickList는 플랫폼 규약상 global 선언)
 */
global with sharing class ExcelImportConfigPicklist extends VisualEditor.DynamicPickList {
    private final String entityName;

    global ExcelImportConfigPicklist(VisualEditor.DesignTimePageContext context) {
        this.entityName = context == null ? null : context.entityName;
    }

    global override VisualEditor.DataRow getDefaultValue() {
        return null;
    }

    global override VisualEditor.DynamicPickListRows getValues() {
        VisualEditor.DynamicPickListRows rows = new VisualEditor.DynamicPickListRows();
        for (Excel_Import_Config__mdt config : [
            SELECT DeveloperName, MasterLabel, Parent_Object__c
            FROM Excel_Import_Config__mdt
            WHERE Active__c = TRUE
            ORDER BY MasterLabel
        ]) {
            Boolean fits = String.isBlank(config.Parent_Object__c) ||
                (entityName != null && config.Parent_Object__c.equalsIgnoreCase(entityName));
            if (fits) {
                rows.addRow(new VisualEditor.DataRow(config.MasterLabel + ' (' + config.DeveloperName + ')', config.DeveloperName));
            }
        }
        return rows;
    }
}
