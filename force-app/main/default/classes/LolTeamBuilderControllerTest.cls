@IsTest
private class LolTeamBuilderControllerTest {
    // Custom Metadata 레코드는 테스트에서도 조회 가능 (배포된 초기 데이터 사용)
    static Map<String, Object> validRequest() {
        return new Map<String, Object>{
            'picks' => new Map<String, String>{
                'TOP' => 'Ornn_Top', 'JUNGLE' => 'Wukong_Jungle', 'MID' => 'Yone_Mid', 'ADC' => 'Jinx_Adc', 'SUPPORT' => 'Lulu_Support'
            },
            'tiers' => new Map<String, String>{
                'TOP' => 'EMERALD_LOW', 'JUNGLE' => 'DIAMOND_LOW', 'MID' => 'MASTER_500', 'ADC' => 'MASTER_500', 'SUPPORT' => 'MASTER_0'
            },
            'categoryPoints' => new Map<String, Object>{ 'SYNERGY' => 12.5, 'STRUCTURE' => 15 },
            'totalScore' => 82.4
        };
    }

    static HttpResponse response(Integer status, String body) {
        HttpResponse res = new HttpResponse();
        res.setStatusCode(status);
        res.setBody(body);
        return res;
    }

    static Object runContinuation(Map<String, Object> request, HttpResponse res) {
        Continuation con = (Continuation) LolTeamBuilderController.startAnalysis(JSON.serialize(request));
        Map<String, HttpRequest> requests = con.getRequests();
        Assert.areEqual(1, requests.size());
        String label = new List<String>(requests.keySet())[0];
        Test.setContinuationResponse(label, res);
        // invokeContinuationMethod는 VF용(인자 없는 콜백)만 지원 → LWC 콜백 시그니처로 직접 호출
        // (startAnalysis가 state에 요청 label을 넣으므로 동일하게 label 전달. state는 테스트에서 읽을 수 없음)
        return LolTeamBuilderController.processAnalysis(new List<String>{ label }, label);
    }

    @IsTest
    static void builderDataComesFromCustomMetadata() {
        LolTeamBuilderController.BuilderData data = LolTeamBuilderController.getBuilderData();
        Assert.isTrue(data.champions.size() >= 5, '라인별 챔피언 존재');
        Set<String> lanes = new Set<String>();
        for (LoL_Champion__mdt c : data.champions) {
            lanes.add(c.Lane__c);
        }
        Assert.areEqual(new Set<String>{ 'TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT' }, lanes);
        Decimal total = 0;
        for (LoL_Score_Weight__mdt w : data.weights) {
            total += w.Max_Points__c;
        }
        Assert.areEqual(100, total, '배점 합계 100');
        Assert.isFalse(data.tiers.isEmpty());
        Assert.isNotNull(data.model);
        Assert.areEqual('CLAUDE_CODE', data.mode, '기본은 구독(Claude Code) 모드');
    }

    @IsTest
    static void requestIsBuiltFromMetadataWithWebSearch() {
        Continuation con = (Continuation) LolTeamBuilderController.startAnalysis(JSON.serialize(validRequest()));
        HttpRequest req = con.getRequests().values()[0];

        Assert.areEqual(LolClaudeAnalysisService.ENDPOINT, req.getEndpoint(), 'Named Credential 사용 (Key 하드코딩 없음)');
        Assert.areEqual('POST', req.getMethod());
        Assert.areEqual('2023-06-01', req.getHeader('anthropic-version'));
        Assert.isNull(req.getHeader('x-api-key'), 'API Key는 Named Credential이 주입');

        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(req.getBody());
        LoL_AI_Setting__mdt s = LoL_AI_Setting__mdt.getInstance('Default');
        Assert.areEqual(s.Model__c, body.get('model'));
        Map<String, Object> tool = (Map<String, Object>) ((List<Object>) body.get('tools'))[0];
        Assert.areEqual(s.Web_Search_Tool__c, tool.get('type'));
        String prompt = (String) ((Map<String, Object>) ((List<Object>) body.get('messages'))[0]).get('content');
        Assert.isTrue(prompt.contains('오른(Ornn)'), prompt);
        Assert.isTrue(prompt.contains('징크스(Jinx)'), prompt);
        Assert.isTrue(prompt.contains('마스터 500LP'), '티어 라벨 포함');
        Assert.isTrue(prompt.contains('총점 82.4'), prompt);
    }

    @IsTest
    static void successResponseReturnsTextAndCitedSources() {
        String body = JSON.serialize(new Map<String, Object>{
            'model' => 'claude-sonnet-5-5',
            'stop_reason' => 'end_turn',
            'content' => new List<Object>{
                new Map<String, Object>{ 'type' => 'server_tool_use', 'id' => 'srvtoolu_1', 'name' => 'web_search' },
                new Map<String, Object>{ 'type' => 'web_search_tool_result', 'tool_use_id' => 'srvtoolu_1', 'content' => new List<Object>() },
                new Map<String, Object>{ 'type' => 'text', 'text' => '■ 한줄 평가\n- 후반형 ' },
                new Map<String, Object>{
                    'type' => 'text',
                    'text' => '하이퍼캐리 조합',
                    'citations' => new List<Object>{
                        new Map<String, Object>{ 'type' => 'web_search_result_location', 'url' => 'https://example.com/a', 'title' => 'A' },
                        new Map<String, Object>{ 'type' => 'web_search_result_location', 'url' => 'https://example.com/a', 'title' => 'A' }
                    }
                }
            }
        });

        Test.startTest();
        LolClaudeAnalysisService.AnalysisResult result = (LolClaudeAnalysisService.AnalysisResult) runContinuation(validRequest(), response(200, body));
        Test.stopTest();

        Assert.areEqual('■ 한줄 평가\n- 후반형 하이퍼캐리 조합', result.text);
        Assert.areEqual(1, result.sources.size(), '중복 출처 제거');
        Assert.areEqual('https://example.com/a', result.sources[0].url);
        Assert.areEqual(1, result.searchCount);
        Assert.isFalse(result.truncated);
    }

    @IsTest
    static void apiErrorsBecomeActionableMessages() {
        Map<Integer, String> expected = new Map<Integer, String>{
            401 => 'API Key가 없거나',
            429 => '요청 한도',
            529 => '혼잡',
            2000 => '시간이 초과',
            2002 => 'Named Credential'
        };
        for (Integer status : expected.keySet()) {
            try {
                runContinuation(validRequest(), response(status, '{"type":"error"}'));
                Assert.fail('예외가 발생해야 함: ' + status);
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains(expected.get(status)), status + ': ' + e.getMessage());
            }
        }
        Assert.isTrue(LolClaudeAnalysisService.errorMessage(400, '{"error":{"message":"web search is not enabled"}}').contains('웹 검색'));
    }

    @IsTest
    static void invalidRequestsAreRejectedBeforeCallout() {
        Map<String, Object> missingLane = validRequest();
        ((Map<String, String>) missingLane.get('picks')).remove('SUPPORT');

        Map<String, Object> wrongLane = validRequest();
        ((Map<String, String>) wrongLane.get('picks')).put('TOP', 'Jinx_Adc');

        Map<String, Object> duplicate = validRequest();
        ((Map<String, String>) duplicate.get('picks')).put('TOP', 'Chogath_Top');
        ((Map<String, String>) duplicate.get('picks')).put('JUNGLE', 'Chogath_Jungle');

        Map<String, Object> badTier = validRequest();
        ((Map<String, String>) badTier.get('tiers')).put('MID', 'GOD');

        Map<String, Object> injectedCategory = validRequest();
        injectedCategory.put('categoryPoints', new Map<String, Object>{ 'IGNORE_PREVIOUS_INSTRUCTIONS' => 1 });

        Map<String, Object> badScore = validRequest();
        badScore.put('totalScore', 1000);

        Map<String, String> cases = new Map<String, String>{
            JSON.serialize(missingLane) => '서폿 챔피언을 선택하세요',
            JSON.serialize(wrongLane) => '탑 챔피언을 선택하세요',
            JSON.serialize(duplicate) => '같은 챔피언',
            JSON.serialize(badTier) => '미드 티어',
            JSON.serialize(injectedCategory) => '점수 항목',
            JSON.serialize(badScore) => '점수 값',
            'not json' => '형식'
        };
        for (String input : cases.keySet()) {
            try {
                LolTeamBuilderController.startAnalysis(input);
                Assert.fail('예외가 발생해야 함: ' + cases.get(input));
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains(cases.get(input)), cases.get(input) + ' → ' + e.getMessage());
            }
        }
    }

    @IsTest
    static void emptyOrTruncatedResponses() {
        try {
            runContinuation(validRequest(), response(200, '{"content":[],"stop_reason":"end_turn"}'));
            Assert.fail('빈 응답은 오류');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('비어 있습니다'), e.getMessage());
        }
        LolClaudeAnalysisService.AnalysisResult result = (LolClaudeAnalysisService.AnalysisResult) runContinuation(
            validRequest(),
            response(200, '{"content":[{"type":"text","text":"부분 응답"}],"stop_reason":"max_tokens"}')
        );
        Assert.isTrue(result.truncated);
    }
    // ===== Claude Code(로컬) 큐 모드 =====
    static User userWithProfile(String profileName, Boolean withPermissionSet) {
        String unique = String.valueOf(Crypto.getRandomInteger()).remove('-');
        User u = new User(
            Alias = 'lol' + unique.left(4), Email = 'lol' + unique + '@example.com', EmailEncodingKey = 'UTF-8',
            LastName = 'Builder', LanguageLocaleKey = 'ko', LocaleSidKey = 'ko_KR', TimeZoneSidKey = 'Asia/Seoul',
            ProfileId = [SELECT Id FROM Profile WHERE Name = :profileName LIMIT 1].Id,
            Username = 'lol' + unique + '@example.com.test'
        );
        insert u;
        if (withPermissionSet) {
            insert new PermissionSetAssignment(
                AssigneeId = u.Id,
                PermissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'LoL_Team_Builder_User' LIMIT 1].Id
            );
        }
        return u;
    }

    @IsTest
    static void submitCreatesPendingRequestWithServerBuiltPrompt() {
        User u = userWithProfile('Standard User', true);
        Id requestId;
        LoL_Analysis_Request__c fetched;
        List<LoL_Analysis_Request__c> recent;
        Test.startTest();
        System.runAs(u) {
            requestId = LolTeamBuilderController.submitAnalysisRequest(JSON.serialize(validRequest()));
            fetched = LolTeamBuilderController.getAnalysisRequest(requestId);
            recent = LolTeamBuilderController.getRecentRequests();
        }
        Test.stopTest();

        Assert.areEqual('Pending', fetched.Status__c);
        Assert.areEqual('오른 / 오공 / 요네 / 징크스 / 룰루', fetched.Composition__c);
        Assert.areEqual(82.4, fetched.Total_Score__c);
        Assert.areEqual(1, recent.size());
        Assert.areEqual(requestId, recent[0].Id);

        LoL_Analysis_Request__c stored = [SELECT Prompt__c, Request_JSON__c, OwnerId FROM LoL_Analysis_Request__c WHERE Id = :requestId];
        Assert.areEqual(u.Id, stored.OwnerId);
        Assert.isTrue(stored.Prompt__c.startsWith('[지침]'), '서버가 만든 지침 포함');
        Assert.isTrue(stored.Prompt__c.contains('징크스(Jinx)'));
        Assert.isTrue(stored.Prompt__c.contains('[팀 목표]'));
        Assert.isTrue(stored.Request_JSON__c.contains('Jinx_Adc'));
    }

    @IsTest
    static void promptListsScoreCategoriesInScreenOrder() {
        // 화면(배점 Sort_Order) 순서와 프롬프트 순서가 같아야 함 (CMDT SOQL ORDER BY가 무시되는 문제 회귀 방지)
        List<LoL_Score_Weight__mdt> weights = LolClaudeAnalysisService.sortedWeights();
        for (Integer i = 1; i < weights.size(); i++) {
            Assert.isTrue(weights[i - 1].Sort_Order__c <= weights[i].Sort_Order__c, 'Sort_Order 오름차순');
        }
        Map<String, Object> request = validRequest();
        Map<String, Object> points = new Map<String, Object>();
        for (LoL_Score_Weight__mdt w : weights) {
            points.put(w.DeveloperName, 1);
        }
        request.put('categoryPoints', points);
        String prompt = LolClaudeAnalysisService.userPrompt(
            (LolClaudeAnalysisService.AnalysisRequest) JSON.deserialize(JSON.serialize(request), LolClaudeAnalysisService.AnalysisRequest.class),
            LoL_AI_Setting__mdt.getInstance('Default')
        );
        // 대체 픽 후보 풀: 각 라인 후보가 프롬프트에 포함 (예: 서폿 후보에 룰루)
        Assert.isTrue(prompt.contains('[라인별 후보 풀]'), prompt);
        Assert.isTrue(prompt.contains('룰루('), '서폿 후보 포함');
        Map<String, List<String>> pool = LolClaudeAnalysisService.lanePool();
        Assert.areEqual([SELECT COUNT() FROM LoL_Champion__mdt WHERE Lane__c = 'TOP'], pool.get('TOP').size());
        Integer last = -1;
        for (LoL_Score_Weight__mdt w : weights) {
            Integer at = prompt.indexOf('- ' + w.MasterLabel + ':');
            Assert.isTrue(at > last, w.MasterLabel + ' 위치가 순서에 맞지 않음');
            last = at;
        }
    }

    @IsTest
    static void requestsAreVisibleOnlyToTheirOwner() {
        User owner = userWithProfile('Standard User', true);
        User other = userWithProfile('Standard User', true);
        Id requestId;
        System.runAs(owner) {
            requestId = LolTeamBuilderController.submitAnalysisRequest(JSON.serialize(validRequest()));
        }
        Test.startTest();
        System.runAs(other) {
            Assert.isTrue(LolTeamBuilderController.getRecentRequests().isEmpty(), '다른 사람 요청은 목록에 없음');
            try {
                LolTeamBuilderController.getAnalysisRequest(requestId);
                Assert.fail('OWD Private: 다른 사람 요청 조회 불가');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('찾을 수 없습니다'), e.getMessage());
            }
        }
        Test.stopTest();
    }

    @IsTest
    static void submitRequiresPermissionAndValidInput() {
        User noPermission = userWithProfile('Standard User', false);
        Test.startTest();
        System.runAs(noPermission) {
            try {
                LolTeamBuilderController.submitAnalysisRequest(JSON.serialize(validRequest()));
                Assert.fail('권한 없으면 저장 불가');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('LoL Team Builder User'), e.getMessage());
            }
        }
        Test.stopTest();

        Map<String, Object> wrongLane = validRequest();
        ((Map<String, String>) wrongLane.get('picks')).put('MID', 'Jinx_Adc');
        try {
            LolTeamBuilderController.submitAnalysisRequest(JSON.serialize(wrongLane));
            Assert.fail('검증 실패해야 함');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('미드 챔피언을 선택하세요'), e.getMessage());
        }
        try {
            LolTeamBuilderController.submitAnalysisRequest('{bad');
            Assert.fail('형식 오류');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('형식'), e.getMessage());
        }
        Assert.areEqual(0, [SELECT COUNT() FROM LoL_Analysis_Request__c]);
    }
}
