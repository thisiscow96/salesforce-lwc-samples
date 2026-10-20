/**
 * LoL 팀 조합 분석기 컨트롤러.
 * - getBuilderData: Custom Metadata(챔피언·시너지·배점·티어)를 한 번에 제공. CMDT getAll()은 SOQL 한도를 쓰지 않고 캐시됨 → cacheable.
 * - submitAnalysisRequest / getAnalysisRequest / getRecentRequests (CLAUDE_CODE 모드):
 *   API Key 없이 Claude 구독(Claude Code)으로 분석. 요청을 LoL_Analysis_Request__c(Pending)로 저장하면
 *   로컬 Claude Code 워커(scripts/lol/claude-worker.js + WORKER.md)가 처리해 결과를 기록하고, LWC가 상태를 폴링한다.
 * - startAnalysis / processAnalysis (API 모드): Claude 호출은 최대 수십 초 걸리므로 Continuation(비동기 콜아웃)으로 처리.
 *   동기 Apex로 오래 기다리면 org의 "장시간 실행 요청(5초 초과) 동시 10건" 한도를 점유하기 때문.
 */
public with sharing class LolTeamBuilderController {
    static final String GENERIC_ERROR = '분석 요청 처리 중 오류가 발생했습니다. 관리자에게 문의하세요.';

    public class BuilderData {
        @AuraEnabled public List<LoL_Champion__mdt> champions;
        @AuraEnabled public List<LoL_Synergy__mdt> synergies;
        @AuraEnabled public List<LoL_Score_Weight__mdt> weights;
        @AuraEnabled public List<LoL_Tier__mdt> tiers;
        @AuraEnabled public String teamGoal;
        @AuraEnabled public String model;
        @AuraEnabled public String mode;
    }

    @AuraEnabled(cacheable=true)
    public static BuilderData getBuilderData() {
        BuilderData data = new BuilderData();
        data.champions = LoL_Champion__mdt.getAll().values();
        data.synergies = LoL_Synergy__mdt.getAll().values();
        data.weights = LoL_Score_Weight__mdt.getAll().values();
        data.tiers = LoL_Tier__mdt.getAll().values();
        LoL_AI_Setting__mdt s = LoL_AI_Setting__mdt.getInstance('Default');
        data.teamGoal = s?.Team_Goal__c;
        data.model = s?.Model__c;
        data.mode = String.isBlank(s?.Mode__c) ? 'CLAUDE_CODE' : s.Mode__c;
        return data;
    }

    /** 분석 요청 저장 (Pending). 프롬프트는 서버가 Custom Metadata로 조립 → 워커는 사용자 입력이 아닌 검증된 텍스트만 받음 */
    @AuraEnabled
    public static Id submitAnalysisRequest(String requestJson) {
        LolClaudeAnalysisService.AnalysisRequest req;
        try {
            req = (LolClaudeAnalysisService.AnalysisRequest) JSON.deserialize(requestJson, LolClaudeAnalysisService.AnalysisRequest.class);
        } catch (Exception e) {
            throw userError('조합 정보 형식이 올바르지 않습니다.');
        }
        try {
            LolClaudeAnalysisService.validate(req);
            LoL_AI_Setting__mdt s = LolClaudeAnalysisService.setting();
            LoL_Analysis_Request__c record = new LoL_Analysis_Request__c(
                Status__c = 'Pending',
                Composition__c = LolClaudeAnalysisService.composition(req),
                Request_JSON__c = JSON.serialize(req),
                Prompt__c = LolClaudeAnalysisService.fullPrompt(req, s),
                Total_Score__c = req.totalScore
            );
            insert as user record; // CRUD·FLS 적용 (권한 없으면 예외)
            // 클라우드 루틴이 설정돼 있으면 즉시 실행 요청 (비동기, 실패해도 요청은 큐에 남음)
            LolRoutineFire.enqueueIfConfigured([SELECT Name FROM LoL_Analysis_Request__c WHERE Id = :record.Id WITH USER_MODE].Name);
            return record.Id;
        } catch (LolClaudeAnalysisService.AnalysisException e) {
            throw userError(e.getMessage());
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'LolTeamBuilderController.submitAnalysisRequest: ' + e.getTypeName() + ' ' + e.getMessage());
            throw userError('분석 요청을 저장하지 못했습니다. 권한 집합(LoL Team Builder User)을 확인하세요.');
        }
    }

    /** 폴링용 (상태가 계속 바뀌므로 cacheable 아님) */
    @AuraEnabled
    public static LoL_Analysis_Request__c getAnalysisRequest(Id requestId) {
        List<LoL_Analysis_Request__c> rows = [
            SELECT Id, Name, Status__c, Composition__c, Total_Score__c, Result__c, Sources_JSON__c, Search_Count__c,
                Error_Message__c, Processed_By__c, CreatedDate, Completed_At__c
            FROM LoL_Analysis_Request__c
            WHERE Id = :requestId
            WITH USER_MODE
            LIMIT 1
        ];
        if (rows.isEmpty()) {
            throw userError('분석 요청을 찾을 수 없습니다.');
        }
        return rows[0];
    }

    /** 내 최근 요청 (PC가 꺼져 있던 동안 쌓인 결과 확인용). OWD Private이라 본인 것만 조회됨 */
    @AuraEnabled
    public static List<LoL_Analysis_Request__c> getRecentRequests() {
        // 목록에는 결과 본문(Long Text)을 싣지 않음 → 선택 시 getAnalysisRequest로 조회 (응답 크기 절감)
        return [
            SELECT Id, Name, Status__c, Composition__c, Total_Score__c, CreatedDate, Completed_At__c
            FROM LoL_Analysis_Request__c
            WHERE CreatedById = :UserInfo.getUserId()
            WITH USER_MODE
            ORDER BY CreatedDate DESC
            LIMIT 10
        ];
    }

    @AuraEnabled(continuation=true)
    public static Object startAnalysis(String requestJson) {
        LolClaudeAnalysisService.AnalysisRequest req;
        try {
            req = (LolClaudeAnalysisService.AnalysisRequest) JSON.deserialize(requestJson, LolClaudeAnalysisService.AnalysisRequest.class);
        } catch (Exception e) {
            throw userError('조합 정보 형식이 올바르지 않습니다.');
        }
        try {
            LolClaudeAnalysisService.validate(req);
            LoL_AI_Setting__mdt s = LolClaudeAnalysisService.setting();
            Integer timeout = s.Timeout_Seconds__c == null ? 120 : Math.min(120, s.Timeout_Seconds__c.intValue());
            Continuation con = new Continuation(timeout);
            con.continuationMethod = 'processAnalysis';
            con.state = con.addHttpRequest(LolClaudeAnalysisService.buildRequest(req, s));
            return con;
        } catch (LolClaudeAnalysisService.AnalysisException e) {
            throw userError(e.getMessage());
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'LolTeamBuilderController.startAnalysis: ' + e.getTypeName() + ' ' + e.getMessage() + '\n' + e.getStackTraceString());
            throw userError(GENERIC_ERROR);
        }
    }

    @AuraEnabled
    public static Object processAnalysis(List<String> labels, Object state) {
        try {
            return LolClaudeAnalysisService.parseResponse(Continuation.getResponse((String) state));
        } catch (LolClaudeAnalysisService.AnalysisException e) {
            throw userError(e.getMessage());
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'LolTeamBuilderController.processAnalysis: ' + e.getTypeName() + ' ' + e.getMessage() + '\n' + e.getStackTraceString());
            throw userError(GENERIC_ERROR);
        }
    }

    static AuraHandledException userError(String message) {
        AuraHandledException e = new AuraHandledException(message);
        e.setMessage(message);
        return e;
    }
}
