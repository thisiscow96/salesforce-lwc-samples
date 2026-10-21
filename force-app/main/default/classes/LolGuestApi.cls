/**
 * 공개 사이트 방문자(게스트)의 분석 요청 저장 API.
 * POST {사이트 경로}/services/apexrest/lol/guest/requests  본문 = 화면의 요청 JSON (챔피언·티어 ID와 점수만)
 *
 * 왜 Aura(@AuraEnabled)가 아니라 Apex REST인가: IP별 요청 횟수 제한에 방문자 접속 IP가 필요한데,
 * 게스트에게는 세션 정보(Auth.SessionManagement)를 쓸 수 없고 Apex REST의 RestContext.request.remoteAddress로만 얻을 수 있다.
 * 검증·저장 규칙은 Aura 경로와 같은 LolClaudeAnalysisService.validate / LolGuestAnalysis.submit을 쓴다.
 * 로그인 사용자는 이 API를 쓰지 않는다 (기존 Aura 경로 사용).
 */
@RestResource(urlMapping='/lol/guest/requests')
global without sharing class LolGuestApi {
    static final String GENERIC_ERROR = '분석 요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도하세요.';

    @HttpPost
    global static void submit() {
        RestResponse res = RestContext.response;
        res.addHeader('Content-Type', 'application/json');
        if (UserInfo.getUserType() != 'Guest') {
            respond(res, 403, new Map<String, Object>{ 'message' => '로그인 사용자는 화면의 기본 요청 경로를 사용하세요.' });
            return;
        }
        LolClaudeAnalysisService.AnalysisRequest req;
        try {
            req = (LolClaudeAnalysisService.AnalysisRequest) JSON.deserialize(RestContext.request.requestBody.toString(), LolClaudeAnalysisService.AnalysisRequest.class);
        } catch (Exception e) {
            respond(res, 400, new Map<String, Object>{ 'message' => '조합 정보 형식이 올바르지 않습니다.' });
            return;
        }
        try {
            LolClaudeAnalysisService.validate(req);
            Id requestId = LolGuestAnalysis.submit(req, LolClaudeAnalysisService.setting(), RestContext.request.remoteAddress);
            respond(res, 200, new Map<String, Object>{ 'id' => requestId });
        } catch (LolClaudeAnalysisService.AnalysisException e) {
            // 상한 초과·검증 오류: 화면에 그대로 보여 줄 문구 (429 = 요청 횟수 초과)
            respond(res, e.getMessage().contains('까지') ? 429 : 400, new Map<String, Object>{ 'message' => e.getMessage() });
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'LolGuestApi: ' + e.getTypeName() + ' ' + e.getMessage() + '\n' + e.getStackTraceString());
            respond(res, 500, new Map<String, Object>{ 'message' => GENERIC_ERROR });
        }
    }

    static void respond(RestResponse res, Integer status, Map<String, Object> body) {
        res.statusCode = status;
        res.responseBody = Blob.valueOf(JSON.serialize(body));
    }
}
