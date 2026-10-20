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
        // 리포트 양식: 라인별 빌드, 상대 조합 6유형 + 상대 정글러 대응, 정글 동선, 데이터 기준 / 기준 패치·티어
        for (String required : new List<String>{
            '▶ 탑', '▶ 정글', '▶ 서폿', '"- 카운터:"', '■ 상대 조합별 대처법', '▶ 다이브 조합', '▶ 초반 스노우볼 조합',
            '▶ 상대 정글러별 첫 3분 대응', '▶ 레드 시작', '▶ 블루 시작', '■ 오브젝트 운영', '■ 추천 밴 3개', '■ 데이터 기준',
            // 운영: 등장 시간 나열 대신 상황(우세·비등·열세)별 행동 지침
            '"- 90초 전:", "- 60초 전:", "- 30초 전:", "- 등장 후:"', '"- 열세:" (맞교환', '■ 한타 포지션', '▶ 역할 분류', '▶ 지형별 포지션', '"- 상대가 여는 경우(받아치기):"',
            '■ 사이드 운영', '▶ 깊이 기준', '"- 웨이브 배치:"(1-3-1 / 1-4 / 5인 뭉침',
            '- 기준 패치: ' + s.Base_Patch__c, '- 기준 티어: 에메랄드+'
        }) {
            Assert.isTrue(prompt.contains(required), '프롬프트에 "' + required + '" 포함');
        }
        // 지침: 교차 검색 규칙과 금지 표현 (불확실성은 데이터 기준 섹션에만)
        String guide = (String) body.get('system');
        Assert.isTrue(guide.contains('최소 2개 출처를 교차 확인'), guide);
        Assert.isTrue(guide.contains('[금지 표현]'), guide);
        Assert.isTrue(guide.contains('[운영 작성 규칙'), guide);
        Assert.isTrue(guide.contains('[한타 포지션 작성 규칙]'), guide);
        Assert.isTrue(guide.contains('[사이드 운영 작성 규칙]'), guide);
        Assert.isTrue(guide.contains('[작성 후 자체 검수]'), guide);
        Assert.isTrue(guide.contains('캐리가 먼저 자리를 잡는다"는 문장은 금지'), '진입 순서: 캐리는 마지막');
        Assert.isTrue(guide.contains('트라이 조건: 오공 R, 세라핀 R 중 2개 이상이면 시도한다." / "공허 유충 8:00 등장"'), '일반론·등장 시간을 나쁜 예로 명시');
        Assert.isFalse(guide.contains('"(확인 필요)"로 표시'), '이전 지침(확인 필요 표기) 제거');
        Assert.areEqual(24000, body.get('max_tokens'));
        // 템트리 제거: 출력 양식에 룬·아이템 항목 없음, 지침에서 금지
        Assert.isFalse(prompt.contains('"- 룬:"'), '라인별 룬 항목 제거');
        Assert.isFalse(prompt.contains('아이템·룬 조정'), '상대 조합별 아이템 조정 제거');
        Assert.isTrue(guide.contains('템트리(룬·스킬 마스터 순서·시작 아이템·코어·상황별 아이템)는 쓰지 않는다'), guide);
        // 운영 사실 점검: 포탑 방패 14분, 14분 전 기본 라인 배치, 궁극기 보유만으로 판단 금지, 영혼·장로 깊이
        Assert.isTrue(guide.contains('포탑 방패(플레이팅)는 14분에 사라진다'), guide);
        Assert.isTrue(guide.contains('1-3-1·1-4 같은 웨이브 배치는 첫 포탑이 깨진 뒤'), guide);
        Assert.isTrue(guide.contains('우리 궁극기 보유 여부만으로 판단하지 않는다'), guide);
        Assert.isTrue(guide.contains('드래곤 영혼·장로도 다른 오브젝트와 같은 깊이'), guide);
        // 프로관전러(lol.ps)를 항상 1순위로: 지침 + 픽마다 lol.ps 챔피언 페이지(라인 지정)
        Assert.isTrue(guide.contains('1순위(항상 먼저 참조): lol.ps'), guide);
        Assert.isTrue(prompt.contains('lol.ps: https://lol.ps/champ/222?tier=2&region=0&lane=3'), '징크스 원딜 lol.ps 페이지');
        Assert.areEqual('https://lol.ps/champ/516?tier=2&region=0&lane=0', LolClaudeAnalysisService.lolpsChampionUrl(516, 'TOP'));
    }

    @IsTest
    static void statBracketFollowsLowestPlayerTier() {
        Map<String, String> tiers = new Map<String, String>{
            'TOP' => 'MASTER_0', 'JUNGLE' => 'MASTER_0', 'MID' => 'MASTER_0', 'ADC' => 'MASTER_0', 'SUPPORT' => 'MASTER_0'
        };
        LolClaudeAnalysisService.AnalysisRequest req = new LolClaudeAnalysisService.AnalysisRequest();
        req.tiers = tiers;
        Assert.areEqual('마스터+', LolClaudeAnalysisService.statBracket(req));
        tiers.put('ADC', 'DIAMOND_HIGH');
        Assert.areEqual('다이아+', LolClaudeAnalysisService.statBracket(req));
        tiers.put('TOP', 'GOLD');
        Assert.areEqual('골드+', LolClaudeAnalysisService.statBracket(req));
        tiers.put('MID', 'SILVER');
        Assert.areEqual('전체 티어', LolClaudeAnalysisService.statBracket(req));
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

    static User siteGuest() {
        List<User> guests = [SELECT Id FROM User WHERE UserType = 'Guest' AND IsActive = true LIMIT 1];
        Assert.isFalse(guests.isEmpty(), '사이트 게스트 사용자가 있어야 함');
        return guests[0];
    }

    class FireMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            res.setBody('{}');
            return res;
        }
    }

    @IsTest
    static void guestCanRequestAnalysisAndReusesSameComposition() {
        Test.setMock(HttpCalloutMock.class, new FireMock());
        User guest = siteGuest();
        LolTeamBuilderController.BuilderData data;
        Id first;
        Id second;
        LoL_Analysis_Request__c fetched;
        String apiModeError;
        Test.startTest();
        System.runAs(guest) {
            data = LolTeamBuilderController.getBuilderData();
            first = LolTeamBuilderController.submitAnalysisRequest(JSON.serialize(validRequest()));
            second = LolTeamBuilderController.submitAnalysisRequest(JSON.serialize(validRequest()));
            fetched = LolTeamBuilderController.getAnalysisRequest(first);
            Assert.isTrue(LolTeamBuilderController.getRecentRequests().isEmpty(), '방문자는 최근 요청 목록 없음');
            try {
                LolTeamBuilderController.startAnalysis(JSON.serialize(validRequest()));
            } catch (AuraHandledException e) {
                apiModeError = e.getMessage();
            }
        }
        Test.stopTest();

        Assert.isTrue(data.isGuest);
        Assert.isTrue(data.canRequestAnalysis, '설정이 켜져 있으면 방문자도 분석 버튼 표시');
        Assert.areEqual(first, second, '같은 조합은 진행 중 요청을 재사용 (Claude 실행 1회)');
        Assert.areEqual(1, [SELECT COUNT() FROM LoL_Analysis_Request__c]);
        Assert.areEqual('Pending', fetched.Status__c);
        LoL_Analysis_Request__c stored = [SELECT Composition_Key__c, Prompt__c FROM LoL_Analysis_Request__c WHERE Id = :first];
        Assert.isTrue(stored.Composition_Key__c.startsWith('Ornn_Top/EMERALD_LOW|'), stored.Composition_Key__c);
        Assert.isTrue(stored.Prompt__c.startsWith('[지침]'), '프롬프트는 서버가 조립');
        Assert.areEqual('분석 요청은 로그인한 사용자만 사용할 수 있습니다.', apiModeError, 'API(크레딧) 모드는 로그인 사용자만');
    }

    @IsTest
    static void guestHourlyLimitAndVisibility() {
        Test.setMock(HttpCalloutMock.class, new FireMock());
        User guest = siteGuest();
        Integer hourlyLimit = LoL_AI_Setting__mdt.getInstance('Default').Guest_Hourly_Limit__c.intValue();
        // 로그인 사용자의 요청: 방문자에게 보이면 안 됨
        LoL_Analysis_Request__c memberRow = new LoL_Analysis_Request__c(Status__c = 'Completed', Composition__c = 'member', Result__c = 'private');
        insert memberRow;

        String limitError;
        String hiddenError;
        Test.startTest();
        System.runAs(guest) {
            List<LoL_Analysis_Request__c> filler = new List<LoL_Analysis_Request__c>();
            for (Integer i = 0; i < hourlyLimit; i++) {
                filler.add(new LoL_Analysis_Request__c(Status__c = 'Completed', Composition__c = 'filler ' + i, Composition_Key__c = 'filler-' + i, Completed_At__c = Datetime.now()));
            }
            insert filler;
            try {
                LolTeamBuilderController.submitAnalysisRequest(JSON.serialize(validRequest()));
            } catch (AuraHandledException e) {
                limitError = e.getMessage();
            }
            try {
                LolTeamBuilderController.getAnalysisRequest(memberRow.Id);
            } catch (AuraHandledException e) {
                hiddenError = e.getMessage();
            }
        }
        Test.stopTest();

        Assert.isNotNull(limitError, '시간당 상한 초과 시 거부');
        Assert.isTrue(limitError.contains('시간당 ' + hourlyLimit + '건'), limitError);
        Assert.areEqual('분석 요청을 찾을 수 없습니다.', hiddenError, '로그인 사용자의 요청은 방문자에게 보이지 않음');
        Assert.areEqual(hourlyLimit + 1, [SELECT COUNT() FROM LoL_Analysis_Request__c], '새 요청이 만들어지지 않음');
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
        Assert.areEqual([SELECT COUNT() FROM LoL_Champion__mdt WHERE Lane__c = 'TOP' AND Preferred__c = TRUE], pool.get('TOP').size(), '팀 선호 픽만 후보');
        Assert.isTrue([SELECT COUNT() FROM LoL_Champion__mdt WHERE Lane__c = 'TOP'] > pool.get('TOP').size(), '전체 픽은 프롬프트에 넣지 않음');
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
