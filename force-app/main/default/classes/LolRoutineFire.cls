/**
 * 분석 요청 저장 직후 Claude Code 클라우드 루틴을 API 트리거(/fire)로 즉시 실행.
 * - 같은 트랜잭션에서 DML 뒤 콜아웃이 불가하므로 Queueable(AllowsCallouts)로 분리.
 * - 루틴 토큰은 Named Credential(Claude_Routine)의 External Credential에만 존재 (코드·로그에 없음).
 * - 실패해도 요청은 큐에 남고, 루틴의 매시간 예약 실행이 처리하므로 사용자 저장은 막지 않는다.
 * - 루틴 경로(LoL AI Setting.Routine_Fire_Path__c)가 비어 있으면 아무것도 하지 않음 (로컬 PC 워커만 사용하는 구성).
 */
public with sharing class LolRoutineFire implements Queueable, Database.AllowsCallouts {
    public static final String NAMED_CREDENTIAL = 'callout:Claude_Routine';
    @TestVisible
    static String firePathOverride; // 테스트용 (CMDT는 테스트에서 변경 불가)
    @TestVisible
    static Integer lastStatus;

    final String requestName;

    public LolRoutineFire(String requestName) {
        this.requestName = requestName;
    }

    public static String firePath() {
        if (firePathOverride != null) {
            return firePathOverride;
        }
        LoL_AI_Setting__mdt s = LoL_AI_Setting__mdt.getInstance('Default');
        return s == null ? null : s.Routine_Fire_Path__c;
    }

    /** 루틴이 설정된 경우에만 큐잉 */
    public static void enqueueIfConfigured(String requestName) {
        if (String.isNotBlank(firePath()) && Limits.getQueueableJobs() < Limits.getLimitQueueableJobs()) {
            System.enqueueJob(new LolRoutineFire(requestName));
        }
    }

    public void execute(QueueableContext context) {
        String path = firePath();
        if (String.isBlank(path) || !path.startsWith('/v1/claude_code/routines/') || !path.endsWith('/fire')) {
            System.debug(LoggingLevel.WARN, 'LolRoutineFire: 루틴 경로가 비었거나 형식이 다름 → 건너뜀');
            return;
        }
        HttpRequest req = new HttpRequest();
        req.setEndpoint(NAMED_CREDENTIAL + path);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('anthropic-version', '2023-06-01');
        req.setHeader('anthropic-beta', 'experimental-cc-routine-2026-04-01');
        req.setTimeout(30000);
        // fire 텍스트는 루틴 쪽에서 "신뢰하지 않는 데이터"로 감싸짐. 참고 정보(요청 번호)만 전달
        req.setBody(JSON.serialize(new Map<String, Object>{ 'text' => 'LoL 분석 요청 ' + requestName + ' 이(가) 저장됨' }));
        try {
            HttpResponse res = new Http().send(req);
            lastStatus = res.getStatusCode();
            if (lastStatus >= 300) {
                System.debug(LoggingLevel.ERROR, 'LolRoutineFire ' + lastStatus + ': ' + res.getBody()?.left(500));
            }
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'LolRoutineFire: ' + e.getTypeName() + ' ' + e.getMessage());
        }
    }
}
