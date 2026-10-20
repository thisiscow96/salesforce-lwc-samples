@IsTest
private class LolWorkerApiTest {
    static final String KEY = 'test-worker-key-0123456789abcdef';

    @TestSetup
    static void setup() {
        insert new LoL_Worker_Setting__c(SetupOwnerId = UserInfo.getOrganizationId(), Key_Hash__c = LolWorkerApi.hash(KEY));
        List<LoL_Analysis_Request__c> rows = new List<LoL_Analysis_Request__c>();
        for (Integer i = 0; i < 5; i++) {
            rows.add(new LoL_Analysis_Request__c(Status__c = 'Pending', Composition__c = 'Comp ' + i, Prompt__c = 'prompt ' + i, Total_Score__c = 80 + i));
        }
        rows.add(new LoL_Analysis_Request__c(Status__c = 'Completed', Composition__c = 'Done', Prompt__c = 'x'));
        // 30분 넘게 멈춘 Processing → 재처리 대상
        rows.add(new LoL_Analysis_Request__c(Status__c = 'Processing', Claimed_At__c = Datetime.now().addHours(-2), Composition__c = 'Stale', Prompt__c = 'y'));
        insert rows;
    }

    static RestResponse call(String method, String path, String key, String body) {
        RestRequest req = new RestRequest();
        req.requestURI = '/services/apexrest/lol/queue' + path;
        req.httpMethod = method;
        if (key != null) {
            req.addHeader(LolWorkerApi.KEY_HEADER, key);
        }
        if (path.contains('?')) {
            req.addParameter(path.substringAfter('?').substringBefore('='), path.substringAfter('='));
        }
        if (body != null) {
            req.requestBody = Blob.valueOf(body);
        }
        RestContext.request = req;
        RestContext.response = new RestResponse();
        if (method == 'GET') {
            LolWorkerApi.getPending();
        } else {
            LolWorkerApi.act();
        }
        return RestContext.response;
    }

    static Map<String, Object> json(RestResponse res) {
        return (Map<String, Object>) JSON.deserializeUntyped(res.responseBody.toString());
    }

    static Id firstPending() {
        return [SELECT Id FROM LoL_Analysis_Request__c WHERE Status__c = 'Pending' ORDER BY CreatedDate, Id LIMIT 1].Id;
    }

    @IsTest
    static void rejectsMissingOrWrongKey() {
        Assert.areEqual(401, call('GET', '/pending', null, null).statusCode);
        Assert.areEqual(401, call('GET', '/pending', 'wrong-key', null).statusCode);
        Assert.areEqual(401, call('POST', '/' + firstPending() + '/claim', 'wrong-key', null).statusCode);
        Assert.areEqual('Pending', [SELECT Status__c FROM LoL_Analysis_Request__c WHERE Id = :firstPending()].Status__c, '인증 실패 시 변경 없음');

        delete [SELECT Id FROM LoL_Worker_Setting__c];
        Assert.areEqual(401, call('GET', '/pending', KEY, null).statusCode, '키 미설정 시에도 401 (설정 여부 노출 안 함)');
    }

    @IsTest
    static void pendingReturnsQueueIncludingStaleWithinLimit() {
        RestResponse res = call('GET', '/pending?limit=10', KEY, null);
        Assert.areEqual(200, res.statusCode);
        Map<String, Object> body = json(res);
        Assert.areEqual(6, body.get('count'), 'Pending 5 + 멈춘 Processing 1, Completed 제외');
        Map<String, Object> first = (Map<String, Object>) ((List<Object>) body.get('items'))[0];
        Assert.isTrue(String.valueOf(first.get('prompt')).startsWith('prompt'), '프롬프트 포함');

        Assert.areEqual(3, json(call('GET', '/pending', KEY, null)).get('count'), '기본 3건');
        Assert.areEqual(1, json(call('GET', '/pending?limit=0', KEY, null)).get('count'), '최소 1건');
    }

    @IsTest
    static void claimIsExclusiveAndCompleteStoresResult() {
        Id requestId = firstPending();
        Assert.areEqual(200, call('POST', '/' + requestId + '/claim', KEY, null).statusCode);
        Assert.areEqual(409, call('POST', '/' + requestId + '/claim', KEY, null).statusCode, '두 번째 워커는 선점 불가');

        String payload = JSON.serialize(new Map<String, Object>{
            'text' => '■ 한줄 평가\n- 좋음',
            'searchCount' => 3,
            'sources' => new List<Object>{
                new Map<String, Object>{ 'title' => 'OP.GG', 'url' => 'https://op.gg/a' },
                new Map<String, Object>{ 'title' => 'dup', 'url' => 'https://op.gg/a' },
                new Map<String, Object>{ 'title' => 'bad', 'url' => 'javascript:alert(1)' }
            }
        });
        RestResponse res = call('POST', '/' + requestId + '/complete', KEY, payload);
        Assert.areEqual(200, res.statusCode, res.responseBody.toString());

        LoL_Analysis_Request__c r = [SELECT Status__c, Result__c, Sources_JSON__c, Search_Count__c, Processed_By__c, Completed_At__c FROM LoL_Analysis_Request__c WHERE Id = :requestId];
        Assert.areEqual('Completed', r.Status__c);
        Assert.areEqual('■ 한줄 평가\n- 좋음', r.Result__c);
        Assert.areEqual(3, r.Search_Count__c);
        Assert.areEqual(1, ((List<Object>) JSON.deserializeUntyped(r.Sources_JSON__c)).size(), '중복·javascript: 제거');
        Assert.areEqual('Claude Code (cloud routine)', r.Processed_By__c);
        Assert.isNotNull(r.Completed_At__c);

        Assert.areEqual(409, call('POST', '/' + requestId + '/complete', KEY, payload).statusCode, '완료된 요청 덮어쓰기 금지');
    }

    @IsTest
    static void staleProcessingCanBeReclaimed() {
        Id stale = [SELECT Id FROM LoL_Analysis_Request__c WHERE Composition__c = 'Stale'].Id;
        Assert.areEqual(200, call('POST', '/' + stale + '/claim', KEY, null).statusCode);
    }

    @IsTest
    static void failAndValidationErrors() {
        Id requestId = firstPending();
        Assert.areEqual(400, call('POST', '/' + requestId + '/complete', KEY, '{"text":"  "}').statusCode, 'text 필수');
        Assert.areEqual(400, call('POST', '/' + requestId + '/complete', KEY, '{bad json').statusCode);
        Assert.areEqual(400, call('POST', '/' + requestId + '/explode', KEY, null).statusCode);
        Assert.areEqual(400, call('POST', '/not-an-id/claim', KEY, null).statusCode);
        Assert.areEqual(400, call('POST', '/' + UserInfo.getUserId() + '/claim', KEY, null).statusCode, '다른 오브젝트 Id 거부');

        Id deleted = firstPending();
        delete new LoL_Analysis_Request__c(Id = deleted);
        Assert.areEqual(404, call('POST', '/' + deleted + '/claim', KEY, null).statusCode);

        Id other = firstPending();
        Assert.areEqual(200, call('POST', '/' + other + '/fail', KEY, '{"message":"웹 검색 실패"}').statusCode);
        LoL_Analysis_Request__c r = [SELECT Status__c, Error_Message__c FROM LoL_Analysis_Request__c WHERE Id = :other];
        Assert.areEqual('Failed', r.Status__c);
        Assert.areEqual('웹 검색 실패', r.Error_Message__c);
    }

    // ===== 루틴 즉시 실행 (LolRoutineFire) =====
    class FireMock implements HttpCalloutMock {
        HttpRequest captured;
        public HttpResponse respond(HttpRequest req) {
            captured = req;
            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            res.setBody('{"type":"routine_fire"}');
            return res;
        }
    }

    @IsTest
    static void routineFireCallsNamedCredentialWithBetaHeader() {
        LolRoutineFire.firePathOverride = '/v1/claude_code/routines/trig_TEST/fire';
        FireMock mock = new FireMock();
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest();
        LolRoutineFire.enqueueIfConfigured('LAR-00099');
        Test.stopTest();

        Assert.areEqual('callout:Claude_Routine/v1/claude_code/routines/trig_TEST/fire', mock.captured.getEndpoint());
        Assert.areEqual('experimental-cc-routine-2026-04-01', mock.captured.getHeader('anthropic-beta'));
        Assert.isNull(mock.captured.getHeader('Authorization'), '토큰은 Named Credential이 주입');
        Assert.isTrue(mock.captured.getBody().contains('LAR-00099'));
        Assert.areEqual(200, LolRoutineFire.lastStatus);
    }

    @IsTest
    static void routineFireSkipsWhenNotConfiguredOrInvalid() {
        Test.setMock(HttpCalloutMock.class, new FireMock());
        LolRoutineFire.firePathOverride = '';
        Test.startTest();
        LolRoutineFire.enqueueIfConfigured('LAR-1');
        Assert.areEqual(0, Limits.getQueueableJobs(), '경로 없으면 큐잉 안 함');
        LolRoutineFire.firePathOverride = 'https://evil.example.com/steal';
        new LolRoutineFire('LAR-2').execute(null);
        Test.stopTest();
        Assert.isNull(LolRoutineFire.lastStatus, '형식이 다른 경로는 호출 안 함');
    }
}
