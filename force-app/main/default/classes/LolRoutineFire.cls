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

    /**
     * 루틴이 설정된 경우 실행 신호(Platform Event)를 발행.
     * 콜아웃은 이벤트 구독 트리거(지정 관리자 사용자로 실행)가 맡으므로, 공개 사이트 게스트처럼
     * 자격 증명 권한이 없는 사용자의 요청도 루틴을 실행할 수 있다. 커밋 후 발행이라 저장이 롤백되면 실행 안 함.
     */
    public static void enqueueIfConfigured(String requestName) {
        if (String.isNotBlank(firePath())) {
            Database.SaveResult result = EventBus.publish(new LoL_Routine_Fire__e(Request_Name__c = requestName));
            if (!result.isSuccess()) {
                System.debug(LoggingLevel.ERROR, 'LolRoutineFire publish 실패: ' + result.getErrors());
            }
        }
    }

    /** 구독 트리거: 한 번에 들어온 신호를 묶어 루틴을 1회만 실행 (루틴은 대기 요청을 여러 건 함께 처리) */
    public static void handleEvents(List<LoL_Routine_Fire__e> events) {
        List<String> names = new List<String>();
        for (LoL_Routine_Fire__e e : events) {
            names.add(e.Request_Name__c);
        }
        if (!names.isEmpty() && String.isNotBlank(firePath())) {
            System.enqueueJob(new LolRoutineFire(String.join(names, ', ').left(200)));
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
