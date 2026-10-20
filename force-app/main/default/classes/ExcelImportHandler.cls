/**
 * Excel 업로드 설정별 저장 로직의 기반 클래스 (Strategy).
 * ExcelImportService가 Excel_Import_Config__mdt.Handler_Class__c 이름으로 인스턴스를 만들어 호출한다.
 * 구현 클래스는 public 기본 생성자가 있어야 하고, with sharing으로 선언한다(업로드 사용자 권한으로 실행).
 *
 * 호출 순서 (청크마다): validateConfig → [공통 열 검증] → validateRow → process
 */
public abstract inherited sharing class ExcelImportHandler {
    /**
     * 설정·권한 검증. 화면 진입(getConfig)과 매 업로드 호출 때 실행된다.
     * 문제가 있으면 사용자에게 보여 줄 문구를 돌려준다 (예: 대상 필드 없음, 생성 권한 없음).
     */
    public virtual String validateConfig(ExcelImport.ConfigDef config) {
        return null;
    }

    /** 공통 검증(필수·길이·형식)을 통과한 행의 업무 검증. 오류 문구 또는 null */
    public virtual String validateRow(ExcelImport.Context ctx, ExcelImport.Row row) {
        return null;
    }

    /**
     * 저장. 행마다 row.succeed(id) 또는 row.fail(message)로 결과를 남긴다 (남기지 않은 행은 실패 처리).
     * 부분 성공을 위해 Database.insert(records, false, AccessLevel.USER_MODE) 사용을 권장.
     * ExcelImport.UserException을 던지면 이 청크 전체가 롤백되고 업로드가 중단된다.
     */
    public abstract void process(ExcelImport.Context ctx, List<ExcelImport.Row> rows);
}
