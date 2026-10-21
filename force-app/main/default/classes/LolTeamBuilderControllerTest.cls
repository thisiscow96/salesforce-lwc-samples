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
            'categoryPoints' => new Map<String, Object>{ 'PICK_STRENGTH' => 30.5, 'FRONTLINE' => 8 },
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
            '▶ 탑', '▶ 정글', '▶ 서폿', '■ 라인별 가이드', '"- 파워 커브:"', '"- 하드 카운터:"', '"- 정글 케어 요청:"', '■ 상대 조합별 대처법', '▶ 다이브 조합', '▶ 초반 스노우볼 조합',
            '▶ 상대 정글러별 첫 3분 대응', '■ 정글 운영과 갱킹', '▶ 캐리 라인 설정', '▶ 갱킹 우선순위와 호응', '■ 오브젝트 운영', '■ 추천 밴 3개', '■ 데이터 기준',
            // 운영: 등장 시간 나열 대신 상황(우세·비등·열세)별 행동 지침
            '▶ 첫 공허 유충: "- 결론:"', '"- 상대가 강할 때:" 반대편 이득', '▶ 첫 드래곤: "- 결론:"', '"- 포기할 때:" 반대편 이득', '"- 오브젝트:"(14~25분은 전령·드래곤', '■ 한타 포지션', '▶ 역할 분류', '▶ 지형별 포지션', '"- 상대가 여는 경우(받아치기):"',
            '■ 사이드 운영', '▶ 인원 수싸움 공식', '▶ 텔레포트 유무별 위치', '"- 1순위 챔피언 (위협 유형): 위협 사유 / 열렸을 때 위험"', '"- 웨이브 배치:"(14분 이후는 1-1-3 / 1-4 / 1-3-1 / 5인 뭉침',
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
        Assert.isTrue(guide.contains('[사이드 운영 작성 규칙: 중후반 1-4 / 1-1-3 구도와 인원 수싸움]'), guide);
        Assert.isTrue(guide.contains('[작성 후 자체 검수]'), guide);
        // 라인별 가이드·밴 규칙, 어색한 인원 체크 제거, 주도권 일관성·양식 되풀이 금지
        Assert.isTrue(guide.contains('[라인별 가이드 작성 규칙]'), guide);
        Assert.isTrue(guide.contains('[밴 작성 규칙]'), guide);
        // 보강: 공식 스킬 확인, 초반 약한 픽 판정, 중후반 위치 배정, 조합 위협 밴, 오브젝트 실전 신호, 숫자 기준
        Assert.isTrue(guide.contains('[정확성·일관성 보강 규칙]'), guide);
        Assert.isTrue(guide.contains('Riot Data Dragon 공식 스킬 설명'), guide);
        Assert.isTrue(guide.contains('3) 중후반 위치 배정'), guide);
        Assert.isTrue(prompt.contains('▶ 중후반 위치 배정'), prompt);
        Assert.isTrue(prompt.contains('(위협 유형)'), prompt);
        // 100점 리포트 4대 조건: 본대 미드 = 원딜·서폿·정글, 실전 스위치, 승리 플랜 파괴자 밴, 타임라인 일관성
        Assert.isTrue(guide.contains('본대 미드는 항상 [원딜 + 서폿 + 정글]'), guide);
        Assert.isTrue(prompt.contains('본대 미드 = 원딜·서폿·정글'), prompt);
        Assert.isTrue(guide.contains('8) 실전 스위치'), guide);
        Assert.isTrue(guide.contains('조합 승리 플랜 파괴자'), guide);
        Assert.isTrue(guide.contains('9) 타임라인 일관성'), guide);
        Assert.isTrue(prompt.contains('궁극기·코어 아이템은 쓰지 않는다'), prompt);
        // 마지막 디테일: 저지 불가 상호작용, 오브젝트 시점의 성장 단계, 기만 메커니즘 성립 조건
        Assert.isTrue(guide.contains('10) 상호작용 확인'), guide);
        Assert.isTrue(guide.contains('말파이트 R은 저지 불가라 뽀삐 W에 막히지 않음'), guide);
        Assert.isFalse(guide.contains('오공 E·말파이트 R 돌진을 그 자리에서 끊고'), '틀린 밴 예시 제거');
        Assert.isTrue(guide.contains('첫 드래곤·첫 유충은 라인전 단계라 캐리는 0~1코어'), guide);
        Assert.isTrue(guide.contains('11) 기만 메커니즘의 성립 조건'), guide);
        Assert.isTrue(prompt.contains('  스킬 확인: Data Dragon id '), prompt);
        Assert.isTrue(prompt.contains(', 초반 '), '파워 커브 근거: 초반 능력치 포함');
        Assert.isFalse(guide.contains('2명 이하가 보일 때 즉시 후퇴'), '기계적인 인원 체크 제거');
        Assert.isTrue(guide.contains('모든 섹션에서 같게 쓴다'), guide);
        Assert.isTrue(guide.contains('그대로 옮겨 쓰지 않는다'), guide);
        // 오브젝트: 기본 시간표 대신 판단 3요소 / 정글: 정석 동선 대신 실전 스노우볼링
        Assert.isTrue(guide.contains('2) 오브젝트 판단 3요소'), guide);
        Assert.isTrue(guide.contains('[정글 작성 규칙: 실전 스노우볼링 전략]'), guide);
        Assert.isFalse(prompt.contains('▶ 레드 시작'), '정석 동선 소제목 제거');
        Assert.isFalse(prompt.contains('"- 90초 전:"'), '오브젝트 기본 시간표 제거');
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
        Assert.isTrue(guide.contains('- 두괄식: 각 판단의 첫 문장에 결론'), guide); // 오브젝트 판단은 결론 먼저
        // 프로관전러(lol.ps)를 항상 1순위로: 지침 + 픽마다 lol.ps 챔피언 페이지(라인 지정)
        Assert.isTrue(guide.contains('1순위(항상 먼저 참조): lol.ps'), guide);
        Assert.isTrue(prompt.contains('lol.ps: https://lol.ps/champ/222?tier=2&region=0&lane=3'), '징크스 원딜 lol.ps 페이지');
        Assert.areEqual('https://lol.ps/champ/516?tier=2&region=0&lane=0', LolClaudeAnalysisService.lolpsChampionUrl(516, 'TOP'));
        // lol.ps 수치를 프롬프트에 직접 포함 (워커가 lol.ps 페이지를 못 읽어도 근거 수치가 있도록) + 출처 읽기 실패로 중단 금지
        Assert.isTrue(prompt.contains('  lol.ps 통계: 티어 '), prompt);
        Assert.isTrue(prompt.contains('[상대 정글러 픽률 상위 5 (lol.ps 한국 에메랄드+)]'), prompt);
        Assert.isTrue(guide.contains('분석을 중단하거나 실패 처리하지 않는다'), guide);
        List<LoL_Champion__mdt> junglers = LolClaudeAnalysisService.topPicked('JUNGLE', 5);
        Assert.areEqual(5, junglers.size());
        for (Integer i = 1; i < junglers.size(); i++) {
            Assert.isTrue(junglers[i - 1].Pick_Rate__c >= junglers[i].Pick_Rate__c, '픽률 내림차순');
            Assert.areEqual('JUNGLE', junglers[i].Lane__c);
        }
        Assert.isTrue(prompt.contains('- ' + junglers[0].MasterLabel + ': 픽률 '), '픽률 1위 정글러 포함');
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
        Assert.isFalse(stored.Prompt__c.contains('[팀 목표]'), '객관 기준: 팀 목표는 프롬프트에 넣지 않음');
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
        String auraPathError;
        Test.startTest();
        System.runAs(guest) {
            data = LolTeamBuilderController.getBuilderData();
            // 방문자는 Apex REST(LolGuestApi)로 요청 (접속 IP로 IP별 상한)
            first = (Id) ((Map<String, Object>) JSON.deserializeUntyped(callGuestApi(JSON.serialize(validRequest()), '198.51.100.40').responseBody.toString())).get('id');
            second = (Id) ((Map<String, Object>) JSON.deserializeUntyped(callGuestApi(JSON.serialize(validRequest()), '198.51.100.40').responseBody.toString())).get('id');
            // 방문자의 Aura 요청 경로는 막힘 (IP별 상한 우회 방지)
            try {
                LolTeamBuilderController.submitAnalysisRequest(JSON.serialize(validRequest()));
            } catch (AuraHandledException e) {
                auraPathError = e.getMessage();
            }
            fetched = LolTeamBuilderController.getAnalysisRequest(first);
            Assert.isTrue(LolTeamBuilderController.getRecentRequests().isEmpty(), '방문자 이력에는 완료 건만 (대기 중 요청은 제외)');
            try {
                LolTeamBuilderController.startAnalysis(JSON.serialize(validRequest()));
            } catch (AuraHandledException e) {
                apiModeError = e.getMessage();
            }
        }
        Test.stopTest();

        Assert.isTrue(data.isGuest);
        Assert.isTrue(data.canRequestAnalysis, '설정이 켜져 있으면 방문자도 분석 버튼 표시');
        Assert.areEqual(LoL_AI_Setting__mdt.getInstance('Default').Guest_Api_Path__c, data.guestApiPath, '방문자에게 REST 경로 전달');
        Assert.areEqual('화면을 새로고침한 뒤 다시 요청하세요.', auraPathError);
        Assert.areEqual(LoL_AI_Setting__mdt.getInstance('Default').Guest_Ip_Limit__c.intValue(), data.guestIpLimit, '안내 문구용 IP 상한');
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
            // IP가 달라도(새 네트워크) 방문자 전체 시간당 상한은 적용
            RestResponse res = callGuestApi(JSON.serialize(validRequest()), '198.51.100.50');
            limitError = (String) ((Map<String, Object>) JSON.deserializeUntyped(res.responseBody.toString())).get('message');
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

    // Apex REST(LolGuestApi) 호출 흉내: 요청 본문과 접속 IP를 지정
    static RestResponse callGuestApi(String body, String ip) {
        RestRequest req = new RestRequest();
        req.requestURI = '/services/apexrest/lol/guest/requests';
        req.httpMethod = 'POST';
        req.requestBody = Blob.valueOf(body);
        req.remoteAddress = ip;
        RestContext.request = req;
        RestContext.response = new RestResponse();
        LolGuestApi.submit();
        return RestContext.response;
    }

    @IsTest
    static void guestApiLimitsPerIpAndStoresOnlyHash() {
        Test.setMock(HttpCalloutMock.class, new FireMock());
        User guest = siteGuest();
        LoL_AI_Setting__mdt s = LoL_AI_Setting__mdt.getInstance('Default');
        Integer ipLimit = s.Guest_Ip_Limit__c.intValue();
        Integer windowMinutes = s.Guest_Ip_Window_Minutes__c.intValue();
        String blockedIp = '203.0.113.7';

        RestResponse blocked;
        RestResponse allowed;
        RestResponse badBody;
        Test.startTest();
        System.runAs(guest) {
            // 같은 IP에서 최근 상한만큼 이미 요청함
            List<LoL_Analysis_Request__c> filler = new List<LoL_Analysis_Request__c>();
            for (Integer i = 0; i < ipLimit; i++) {
                filler.add(new LoL_Analysis_Request__c(Status__c = 'Completed', Composition__c = 'ip filler ' + i, Composition_Key__c = 'ip-filler-' + i, Client_Key__c = LolGuestAnalysis.clientKey(blockedIp), Completed_At__c = Datetime.now()));
            }
            insert filler;
            blocked = callGuestApi(JSON.serialize(validRequest()), blockedIp);
            allowed = callGuestApi(JSON.serialize(validRequest()), '198.51.100.20'); // 다른 네트워크는 영향 없음
            badBody = callGuestApi('{not json', '198.51.100.21');
        }
        Test.stopTest();

        Assert.areEqual(429, blocked.statusCode, '같은 IP 상한 초과 → 429');
        Assert.isTrue(blocked.responseBody.toString().contains(windowMinutes + '분에 ' + ipLimit + '건'), blocked.responseBody.toString());
        Assert.areEqual(200, allowed.statusCode, allowed.responseBody.toString());
        Id createdId = (Id) ((Map<String, Object>) JSON.deserializeUntyped(allowed.responseBody.toString())).get('id');
        LoL_Analysis_Request__c created = [SELECT Client_Key__c, Prompt__c FROM LoL_Analysis_Request__c WHERE Id = :createdId];
        Assert.areEqual(LolGuestAnalysis.clientKey('198.51.100.20'), created.Client_Key__c, 'IP 해시 저장');
        Assert.areEqual(64, created.Client_Key__c.length(), 'SHA-256 해시(64자)만 저장');
        Assert.isFalse(created.Client_Key__c.contains('198.51'), '원본 IP는 저장하지 않음');
        Assert.isTrue(created.Prompt__c.startsWith('[지침]'), '프롬프트는 서버가 조립');
        Assert.areEqual(400, badBody.statusCode);
        Assert.isNull(LolGuestAnalysis.clientKey(null), 'IP를 모르면 IP별 상한 미적용');
    }

    @IsTest
    static void guestApiRejectsLoggedInUsers() {
        RestResponse res = callGuestApi(JSON.serialize(validRequest()), '198.51.100.30');
        Assert.areEqual(403, res.statusCode, '로그인 사용자는 Aura 경로 사용');
        Assert.areEqual(0, [SELECT COUNT() FROM LoL_Analysis_Request__c]);
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
    static void guestHistoryShowsOnlyCompletedVisitorRequests() {
        User guest = siteGuest();
        User member = userWithProfile('Standard User', true);
        System.runAs(member) {
            LolTeamBuilderController.submitAnalysisRequest(JSON.serialize(validRequest())); // 로그인 사용자 요청: 방문자 이력에 없음
        }
        List<LoL_Analysis_Request__c> history;
        LoL_Analysis_Request__c opened;
        Test.startTest();
        System.runAs(guest) {
            insert new List<LoL_Analysis_Request__c>{
                new LoL_Analysis_Request__c(Status__c = 'Completed', Composition__c = '오른 / 오공 / 요네 / 징크스 / 룰루', Composition_Key__c = 'h1', Result__c = '■ 한줄 평가\n- 지난 분석', Client_Key__c = LolGuestAnalysis.clientKey('203.0.113.9'), Completed_At__c = Datetime.now()),
                new LoL_Analysis_Request__c(Status__c = 'Failed', Composition__c = 'failed', Composition_Key__c = 'h2', Error_Message__c = '내부 오류')
            };
            history = LolTeamBuilderController.getRecentRequests();
            opened = LolTeamBuilderController.getAnalysisRequest(history[0].Id);
        }
        Test.stopTest();

        Assert.areEqual(1, history.size(), '방문자 이력: 방문자가 만든 완료 건만');
        Assert.areEqual('오른 / 오공 / 요네 / 징크스 / 룰루', history[0].Composition__c);
        Assert.isFalse(history[0].isSet('Client_Key__c'), 'IP 해시는 조회하지 않음');
        Assert.isFalse(history[0].isSet('Result__c'), '목록에는 결과 본문을 싣지 않음');
        Assert.isTrue(opened.Result__c.contains('지난 분석'), '선택하면 결과 본문 조회');
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
