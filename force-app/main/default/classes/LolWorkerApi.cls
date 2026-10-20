/**
 * 클라우드 Claude Code(루틴) 워커 전용 큐 API. Salesforce Site(LoL_Worker)로 노출.
 *   GET  /lol/queue/pending?limit=3      대기 요청 (Pending + 30분 넘게 멈춘 Processing)
 *   POST /lol/queue/{id}/claim           Processing으로 선점 (이미 선점됐으면 409)
 *   POST /lol/queue/{id}/complete        {text, sources:[{title,url}], searchCount}
 *   POST /lol/queue/{id}/fail            {message}
 *
 * 보안 설계
 * - 인증: X-LoL-Worker-Key 헤더의 SHA-256 해시를 보호된 Custom Setting(LoL_Worker_Setting__c.Key_Hash__c)과 비교.
 *   키 원문은 Salesforce에 저장하지 않고, 클라우드 쪽에서는 Anthropic 프록시가 네트워크 시크릿으로 헤더를 붙인다(Claude가 키를 볼 수 없음).
 * - without sharing: Site 게스트 사용자는 레코드 공유를 받을 수 없으므로, 인증 통과 후 이 큐 오브젝트에 한해 시스템 권한으로 처리.
 *   다른 오브젝트·필드는 다루지 않고, 쓰기 가능한 필드도 상태·결과 필드로 한정한다.
 * - 키 미설정·불일치는 모두 401 (설정 여부를 노출하지 않음).
 */
@RestResource(urlMapping='/lol/queue/*')
global without sharing class LolWorkerApi {
    static final Integer STALE_MINUTES = 30;
    static final Integer MAX_RESULT = 131072;
    @TestVisible
    static final String KEY_HEADER = 'X-LoL-Worker-Key';

    @HttpGet
    global static void getPending() {
        if (!authorized()) {
            respond(401, new Map<String, Object>{ 'error' => 'unauthorized' });
            return;
        }
        String limitParam = RestContext.request.params.get('limit');
        Integer max = 3;
        if (String.isNotBlank(limitParam) && limitParam.isNumeric()) {
            max = Math.max(1, Math.min(10, Integer.valueOf(limitParam)));
        }
        Datetime stale = Datetime.now().addMinutes(-STALE_MINUTES);
        List<Map<String, Object>> items = new List<Map<String, Object>>();
        for (LoL_Analysis_Request__c r : [
            SELECT Id, Name, Composition__c, Total_Score__c, Prompt__c, CreatedBy.Name, CreatedDate
            FROM LoL_Analysis_Request__c
            WHERE Status__c = 'Pending' OR (Status__c = 'Processing' AND Claimed_At__c < :stale)
            ORDER BY CreatedDate
            LIMIT :max
        ]) {
            items.add(new Map<String, Object>{
                'id' => r.Id, 'name' => r.Name, 'composition' => r.Composition__c, 'totalScore' => r.Total_Score__c,
                'requestedBy' => r.CreatedBy.Name, 'createdDate' => r.CreatedDate, 'prompt' => r.Prompt__c
            });
        }
        respond(200, new Map<String, Object>{ 'count' => items.size(), 'items' => items });
    }

    @HttpPost
    global static void act() {
        if (!authorized()) {
            respond(401, new Map<String, Object>{ 'error' => 'unauthorized' });
            return;
        }
        // URI: .../lol/queue/{id}/{action}
        List<String> parts = RestContext.request.requestURI.substringAfter('/lol/queue/').split('/');
        if (parts.size() != 2 || !isRequestId(parts[0])) {
            respond(400, new Map<String, Object>{ 'error' => 'path must be /lol/queue/{id}/{claim|complete|fail}' });
            return;
        }
        Id requestId = Id.valueOf(parts[0]);
        String action = parts[1];
        try {
            if (action == 'claim') {
                claim(requestId);
            } else if (action == 'complete') {
                complete(requestId, body());
            } else if (action == 'fail') {
                fail(requestId, body());
            } else {
                respond(400, new Map<String, Object>{ 'error' => 'unknown action: ' + action });
            }
        } catch (JSONException e) {
            respond(400, new Map<String, Object>{ 'error' => 'invalid JSON body' });
        } catch (QueryException e) {
            respond(404, new Map<String, Object>{ 'error' => 'request not found' });
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'LolWorkerApi ' + action + ': ' + e.getTypeName() + ' ' + e.getMessage());
            respond(500, new Map<String, Object>{ 'error' => 'internal error' });
        }
    }

    // FOR UPDATE로 잠가 두 워커가 같은 요청을 동시에 선점하지 못하게 함
    static void claim(Id requestId) {
        LoL_Analysis_Request__c r = [SELECT Id, Status__c, Claimed_At__c FROM LoL_Analysis_Request__c WHERE Id = :requestId FOR UPDATE];
        Boolean stale = r.Status__c == 'Processing' && r.Claimed_At__c != null && r.Claimed_At__c < Datetime.now().addMinutes(-STALE_MINUTES);
        if (r.Status__c != 'Pending' && !stale) {
            respond(409, new Map<String, Object>{ 'error' => 'already ' + r.Status__c });
            return;
        }
        update new LoL_Analysis_Request__c(Id = r.Id, Status__c = 'Processing', Claimed_At__c = Datetime.now(), Processed_By__c = 'Claude Code (cloud routine)', Error_Message__c = null);
        respond(200, new Map<String, Object>{ 'claimed' => r.Id });
    }

    static void complete(Id requestId, Map<String, Object> payload) {
        String text = payload.get('text') == null ? '' : String.valueOf(payload.get('text')).trim();
        if (String.isBlank(text)) {
            respond(400, new Map<String, Object>{ 'error' => 'text is required' });
            return;
        }
        LoL_Analysis_Request__c r = [SELECT Id, Status__c FROM LoL_Analysis_Request__c WHERE Id = :requestId FOR UPDATE];
        if (r.Status__c == 'Completed') {
            respond(409, new Map<String, Object>{ 'error' => 'already Completed' });
            return;
        }
        List<Map<String, String>> sources = cleanSources(payload.get('sources'));
        update new LoL_Analysis_Request__c(
            Id = r.Id,
            Status__c = 'Completed',
            Result__c = text.left(MAX_RESULT),
            Sources_JSON__c = JSON.serialize(sources),
            Search_Count__c = payload.get('searchCount') instanceof Integer ? (Integer) payload.get('searchCount') : 0,
            Completed_At__c = Datetime.now(),
            Processed_By__c = 'Claude Code (cloud routine)',
            Error_Message__c = null
        );
        respond(200, new Map<String, Object>{ 'completed' => r.Id, 'sources' => sources.size() });
    }

    static void fail(Id requestId, Map<String, Object> payload) {
        LoL_Analysis_Request__c r = [SELECT Id FROM LoL_Analysis_Request__c WHERE Id = :requestId FOR UPDATE];
        String message = payload.get('message') == null ? '처리 실패' : String.valueOf(payload.get('message'));
        update new LoL_Analysis_Request__c(Id = r.Id, Status__c = 'Failed', Error_Message__c = message.left(255), Completed_At__c = Datetime.now(), Processed_By__c = 'Claude Code (cloud routine)');
        respond(200, new Map<String, Object>{ 'failed' => r.Id });
    }

    // 출처는 http(s)만, 최대 20개 (화면에서 링크로 렌더링)
    static List<Map<String, String>> cleanSources(Object raw) {
        List<Map<String, String>> out = new List<Map<String, String>>();
        Set<String> seen = new Set<String>();
        if (!(raw instanceof List<Object>)) {
            return out;
        }
        for (Object item : (List<Object>) raw) {
            if (!(item instanceof Map<String, Object>) || out.size() >= 20) {
                continue;
            }
            Map<String, Object> s = (Map<String, Object>) item;
            String url = s.get('url') == null ? '' : String.valueOf(s.get('url'));
            if (!Pattern.matches('(?i)^https?://\\S+$', url) || !seen.add(url)) {
                continue;
            }
            String title = s.get('title') == null ? url : String.valueOf(s.get('title'));
            out.add(new Map<String, String>{ 'title' => title.left(200), 'url' => url.left(1000) });
        }
        return out;
    }

    @TestVisible
    static Boolean authorized() {
        String key = RestContext.request.headers.get(KEY_HEADER);
        LoL_Worker_Setting__c setting = LoL_Worker_Setting__c.getOrgDefaults();
        if (String.isBlank(key) || setting == null || String.isBlank(setting.Key_Hash__c)) {
            return false;
        }
        return hash(key) == setting.Key_Hash__c.toLowerCase();
    }

    @TestVisible
    static String hash(String key) {
        return EncodingUtil.convertToHex(Crypto.generateDigest('SHA-256', Blob.valueOf(key)));
    }

    static Boolean isRequestId(String value) {
        try {
            return Id.valueOf(value).getSObjectType() == LoL_Analysis_Request__c.SObjectType;
        } catch (Exception e) {
            return false;
        }
    }

    static Map<String, Object> body() {
        Blob raw = RestContext.request.requestBody;
        if (raw == null || raw.size() == 0) {
            return new Map<String, Object>();
        }
        Object parsed = JSON.deserializeUntyped(raw.toString());
        return parsed instanceof Map<String, Object> ? (Map<String, Object>) parsed : new Map<String, Object>();
    }

    static void respond(Integer status, Object payload) {
        RestResponse res = RestContext.response;
        res.statusCode = status;
        res.addHeader('Content-Type', 'application/json');
        res.responseBody = Blob.valueOf(JSON.serialize(payload));
    }
}
