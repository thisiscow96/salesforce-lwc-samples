/**
 * LoL 팀 조합 → Claude Messages API 요청 생성 / 응답 해석.
 * - 프롬프트는 서버에서 Custom Metadata 값으로만 조립: 클라이언트는 챔피언·티어 DeveloperName과 점수(숫자)만 보내므로
 *   사용자 입력 문자열이 프롬프트에 그대로 들어가지 않는다 (프롬프트 인젝션 차단).
 * - API Key는 Named Credential(Claude_API)의 External Credential에만 존재. 코드·로그에 남기지 않는다.
 * - 웹 검색(server tool)으로 최신 패치 메타·커뮤니티 의견을 조회하고 출처(citations)를 함께 돌려준다.
 */
public with sharing class LolClaudeAnalysisService {
    public static final String ENDPOINT = 'callout:Claude_API/v1/messages';
    static final String API_VERSION = '2023-06-01';
    static final List<String> LANES = new List<String>{ 'TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT' };
    static final Map<String, String> LANE_LABELS = new Map<String, String>{
        'TOP' => '탑', 'JUNGLE' => '정글', 'MID' => '미드', 'ADC' => '원딜', 'SUPPORT' => '서폿'
    };

    public class AnalysisRequest {
        @AuraEnabled public Map<String, String> picks { get; set; } // lane → LoL_Champion__mdt.DeveloperName
        @AuraEnabled public Map<String, String> tiers { get; set; } // lane → LoL_Tier__mdt.DeveloperName
        @AuraEnabled public Map<String, Decimal> categoryPoints { get; set; } // LoL_Score_Weight__mdt.DeveloperName → 점수
        @AuraEnabled public Decimal totalScore { get; set; }
    }

    public class Source {
        @AuraEnabled public String title;
        @AuraEnabled public String url;
        Source(String title, String url) {
            this.title = String.isBlank(title) ? url : title;
            this.url = url;
        }
    }

    public class AnalysisResult {
        @AuraEnabled public String text;
        @AuraEnabled public List<Source> sources = new List<Source>();
        @AuraEnabled public Integer searchCount = 0;
        @AuraEnabled public String model;
        @AuraEnabled public Boolean truncated = false;
    }

    public class AnalysisException extends Exception {}

    public static LoL_AI_Setting__mdt setting() {
        LoL_AI_Setting__mdt s = LoL_AI_Setting__mdt.getInstance('Default');
        if (s == null || String.isBlank(s.Model__c)) {
            throw new AnalysisException('AI 설정(LoL AI Setting > Default)이 없습니다. 관리자에게 문의하세요.');
        }
        return s;
    }

    /** 입력 검증: 5개 라인 모두, 해당 라인의 챔피언, 존재하는 티어, 점수 범위 */
    public static void validate(AnalysisRequest req) {
        if (req == null || req.picks == null || req.tiers == null) {
            throw new AnalysisException('조합 정보가 없습니다.');
        }
        Set<String> keys = new Set<String>();
        for (String lane : LANES) {
            LoL_Champion__mdt champ = LoL_Champion__mdt.getInstance(req.picks.get(lane) == null ? '' : req.picks.get(lane));
            if (champ == null || champ.Lane__c != lane) {
                throw new AnalysisException(LANE_LABELS.get(lane) + ' 챔피언을 선택하세요.');
            }
            if (!keys.add(champ.Champion_Key__c)) {
                throw new AnalysisException('같은 챔피언을 두 라인에 선택할 수 없습니다: ' + champ.MasterLabel);
            }
            if (LoL_Tier__mdt.getInstance(req.tiers.get(lane) == null ? '' : req.tiers.get(lane)) == null) {
                throw new AnalysisException(LANE_LABELS.get(lane) + ' 티어를 선택하세요.');
            }
        }
        if (req.totalScore == null || req.totalScore < 0 || req.totalScore > 100) {
            throw new AnalysisException('점수 값이 올바르지 않습니다.');
        }
        if (req.categoryPoints != null) {
            for (String key : req.categoryPoints.keySet()) {
                Decimal value = req.categoryPoints.get(key);
                if (LoL_Score_Weight__mdt.getInstance(key) == null || value == null || value < 0 || value > 100) {
                    throw new AnalysisException('점수 항목 값이 올바르지 않습니다.');
                }
            }
        }
    }

    public static HttpRequest buildRequest(AnalysisRequest req, LoL_AI_Setting__mdt s) {
        Map<String, Object> body = new Map<String, Object>{
            'model' => s.Model__c,
            'max_tokens' => s.Max_Tokens__c == null ? 3000 : s.Max_Tokens__c.intValue(),
            'system' => systemPrompt(),
            'messages' => new List<Object>{ new Map<String, Object>{ 'role' => 'user', 'content' => userPrompt(req, s) } }
        };
        if (String.isNotBlank(s.Web_Search_Tool__c)) {
            body.put('tools', new List<Object>{
                new Map<String, Object>{
                    'type' => s.Web_Search_Tool__c,
                    'name' => 'web_search',
                    'max_uses' => s.Web_Search_Max_Uses__c == null ? 3 : s.Web_Search_Max_Uses__c.intValue(),
                    'user_location' => new Map<String, Object>{ 'type' => 'approximate', 'country' => 'KR', 'timezone' => 'Asia/Seoul' }
                }
            });
        }
        HttpRequest http = new HttpRequest();
        http.setEndpoint(ENDPOINT);
        http.setMethod('POST');
        http.setHeader('content-type', 'application/json');
        http.setHeader('anthropic-version', API_VERSION);
        http.setTimeout(120000);
        http.setBody(JSON.serialize(body));
        return http;
    }

    /** Claude Code(로컬) 처리용: 시스템 지침 + 요청 본문을 하나의 텍스트로 (API 모드와 같은 프롬프트 사용) */
    public static String fullPrompt(AnalysisRequest req, LoL_AI_Setting__mdt s) {
        return '[지침]\n' + systemPrompt() + '\n\n' + userPrompt(req, s);
    }

    /** 사람이 읽는 조합 요약: "말파이트 / 오공 / 요네 / 징크스 / 세라핀" */
    public static String composition(AnalysisRequest req) {
        List<String> names = new List<String>();
        for (String lane : LANES) {
            names.add(LoL_Champion__mdt.getInstance(req.picks.get(lane)).MasterLabel);
        }
        return String.join(names, ' / ');
    }

    static String systemPrompt() {
        // 패치마다 바뀌는 수치(승률·빌드·오브젝트 시간)는 하드코딩하지 않고 매번 교차 검색하게 한다.
        // "확인 필요" 남발을 막기 위해 못 찾은 수치는 챔피언 고정 특성으로 대체하고, 불확실성은 마지막 섹션에만 모은다.
        return String.join(new List<String>{
            '너는 리그 오브 레전드 솔로랭크 조합 분석가다. [우리 조합]의 5인 조합을 분석해 [출력 양식]대로 보고서를 작성한다.',
            '',
            '[리서치 규칙: 반드시 지킬 것]',
            '1) 직접 여러 사이트를 검색해 내용을 채운다. 한 항목당 최소 2개 출처를 교차 확인한다.',
            '   - 1순위(항상 먼저 참조): lol.ps (프로관전러 P.S, 한국 서버 · 에메랄드+). [우리 조합]에 적힌 lol.ps 챔피언 페이지를 먼저 열어 승률·픽률·밴률·PS 점수·카운터를 확인하고, 통계 수치는 lol.ps 값을 기준으로 쓴다.',
            '   - 교차 확인용 통계·카운터: op.gg, u.gg, lolalytics, mobalytics, deeplol, leagueofgraphs',
            '   - 패치 변경·오브젝트 규칙: leagueoflegends.com 공식 패치노트·시즌 공지',
            '   - 운영·동선·매치업 팁: mobalytics 가이드, 프로·챌린저 가이드, 커뮤니티 공략',
            '2) 첫 검색에서 답이 안 나오면 검색어를 바꿔(영어/한국어, 챔피언명+"build"·"matchup"·"counter", 패치 번호 등) 최소 3번 더 찾는다.',
            '3) 모든 통계는 [기준]의 패치 하나로 통일한다. 다른 패치의 수치는 쓰지 않는다. 기준 패치 표본이 적으면 직전 패치를 쓰고 "데이터 기준"에 한 번만 적는다.',
            '4) 질문과 관련 없는 통계는 넣지 않는다 (예: 같은 팀 챔피언끼리의 맞라인 승률).',
            '',
            '[금지 표현]',
            '본문에 "확인 필요", "확인하지 못했다", "참조 필요", "구체적 내용은 확인 필요", "현재 패치 확인 필요" 같은 표현을 쓰지 않는다.',
            '',
            '[찾지 못했을 때의 처리]',
            '- 숫자(승률·픽률·시간)를 끝까지 못 찾으면 숫자를 지어내지 말고, 챔피언의 고정된 특성(스킬 구조, 파워 스파이크)에 근거한 구체적 설명으로 대체한다.',
            '  나쁜 예: "카운터: 현재 패치 확인 필요"',
            '  좋은 예: "카운터: 다리우스. 요릭 Q 사거리 안에서 출혈 5중첩을 허용하면 6레벨 전 솔킬을 내준다 → 구울을 먼저 소환해 거리를 벌린다"',
            '- 출처마다 값이 다르면 더 많은 출처가 지지하는 값을 쓰고, 차이가 크면 범위로 쓴다 (예: "첫 유충 6~8분").',
            '- 불확실성은 본문에 흩어 쓰지 말고 맨 끝 "데이터 기준" 섹션에 1~3줄로만 정리한다.',
            '',
            '[작성 원칙]',
            '- 모든 항목은 실행 가능한 구체 내용으로 쓴다: 챔피언명, 스킬명, 레벨, 분 단위 시간, 와드 위치.',
            '- 템트리(룬·스킬 마스터 순서·시작 아이템·코어·상황별 아이템)는 쓰지 않는다. 운영·한타·라인전 판단에 집중한다. 성장 시점이 필요하면 아이템명 대신 "첫 코어 완성", "2코어"처럼 쓴다.',
            '- 추천 밴 3개는 반드시 실제 챔피언 이름 3개와 각각의 이유 1줄로 쓴다.',
            '- 정글 동선은 시작 캠프부터 첫 귀환까지 실제 캠프 순서로 쓴다 (레드/블루 시작 각각). 인접 캠프를 이어 도는 순서여야 하고(예: 레드 → 돌거북 → 칼날부리 → 늑대 → 블루 → 심술두꺼비), 동선이 끝나는 레벨·시간과 첫 갱이 서로 맞아야 한다.',
            '- 스킬 이름과 용도는 Riot Data Dragon 한국어 챔피언 데이터(ko_KR champion/<챔피언>.json)의 스킬 설명으로 확인하고 정식 명칭을 쓴다. 스킬 용도(진입·차단·생존·추격)를 설명과 다르게 분류하지 않는다 (예: 요릭 W 망자의 진은 적의 이동을 막는 벽 = 차단용, 생존기 아님).',
            '- 카운터는 그 라인에서 실제로 쓰이는 챔피언만 쓴다.',
            '- 통계 수치는 기준 패치 값만 본문에 쓴다 (예: "26.8 기준 52.4%" 같은 다른 패치 수치 금지). 범위로 쓴 값의 이유(출처 간 차이 등)는 본문에 쓰지 않고 "데이터 기준"에만 쓴다.',
            '- 섹션끼리 서로 모순되지 않게 쓴다 (예: 시너지에서 룰루 R 대상을 말파이트로 썼다면 서폿 섹션도 같은 판단).',
            '- 한국어로, 롤 커뮤니티 용어(라인전 주도권, 갱, 카정, 역갱, 다이브, 한타, 사이드 운영, 스노우볼 등)를 쓴다.',
            '',
            '[운영 작성 규칙: 전문 운영 수준으로 쓸 것. 오브젝트 운영·한타 포지션·사이드 운영·시간대별 운영 플랜에 적용]',
            '1) 문장 구체성',
            '- 운영 문장에는 반드시 다섯 요소를 넣는다: 누가 / 언제(초 단위 또는 명확한 조건) / 어디서(지형·와드 위치 이름) / 무엇을 / 왜.',
            '  나쁜 예: "비등할 때 오공 R 각이 있을 때만 싸운다." / "트라이 조건: 오공 R, 세라핀 R 중 2개 이상이면 시도한다." / "공허 유충 8:00 등장"',
            '  좋은 예: "비등할 때: 드래곤 둥지 입구가 좁아지는 20초 전, 오공이 상대 정글 쪽 강가 부쉬(트라이 부쉬)를 점령한다. 상대 탱커가 둥지 안쪽으로 들어온 뒤 오공이 R로 탱커와 원딜을 한꺼번에 띄우며 연다. 탱커가 입구에 버티면 열지 않고, 세라핀 포킹으로 체력을 깎은 뒤 다시 판단한다."',
            '- "각이 있을 때", "상황에 따라", "시야를 확보한다", "유리하게 싸운다", "조심한다"는 단독으로 쓰지 않는다. 쓰려면 구체적 조건을 붙인다.',
            '- 등장·재생성 시간, 오브젝트 규칙 설명은 본문에 쓰지 않는다 (판단 근거로만 사용).',
            '2) 오브젝트 셋업 타임라인 (오브젝트마다)',
            '- 90초 전: 누가 리콜하는지, 어느 라인을 어디까지 밀어 둘지(크래시/슬로우 푸시).',
            '- 60초 전: 시야 작업 순서. 외곽 와드 → 내부 제어 와드 → 상대 와드 스위핑. 담당자와 와드 위치 이름을 쓴다.',
            '- 30초 전: 진입 순서와 서 있을 위치.',
            '- 등장 후: 사냥 담당, 스틸 견제 담당, 사냥 중 상대가 오면 누가 먼저 받아칠지.',
            '- 진입 순서 원칙: 정글·서폿·탱커가 먼저 강가에 들어가 시야와 공간을 잡는다. 캐리(원딜·AP 메이지)는 마지막에 합류한다. "캐리가 먼저 자리를 잡는다"는 문장은 금지한다.',
            '3) 상황별 판단 (우세/비등/열세)',
            '- 판단 기준을 숫자나 조건으로 쓴다. 예: 라인 우선권 2곳 이상, 상대 정글 마지막 위치, 상대 핵심 스킬(점멸·궁극기) 사용 여부, 웨이브 상태, 시야 우위.',
            '- 우리 궁극기 보유 여부만으로 판단하지 않는다. "오공 R이 있을 때만 시도", "R 2개 이상이면 연다" 같은 문장은 금지하고, 반드시 상대 위치·웨이브·시야 조건과 함께 쓴다.',
            '- 열세일 때는 반드시 맞교환을 쓴다: 무엇을 내주고 반대편에서 무엇을 가져오는지, 그 교환이 왜 손해가 적은지 한 줄(골드·포탑·시간 기준).',
            '- 드래곤 영혼·장로도 다른 오브젝트와 같은 깊이(타임라인 4단계·와드 위치 이름·상황별 판단·맞교환)로 쓴다. 영혼 포인트 상황(우리/상대 영혼 직전)별 판단을 포함한다.',
            '5) 게임 규칙 사실 점검 (틀리면 운영 전체가 무너지므로 반드시 지킨다)',
            '- 포탑 방패(플레이팅)는 14분에 사라진다. 14분 이후(전령 후반·바론·영혼·장로)의 맞교환에 "포탑 방패"를 쓰지 않는다. 14분 이후 교환 대상은 포탑 자체·억제기·정글 캠프·다음 오브젝트다.',
            '- 14분 전(라인전 단계)은 기본 라인 배치(탑·미드 1, 바텀 2, 정글 로밍)다. 1-3-1·1-4 같은 웨이브 배치는 첫 포탑이 깨진 뒤(보통 14분 이후)에만 쓴다.',
            '- 존재하지 않는 아이템·스킬·지형 이름을 쓰지 않는다. 기준 패치에 없는 오브젝트는 쓰지 않는다.',
            '4) 챔피언 고유 메커니즘 반영',
            '- 조합 안의 각 챔피언에 대해 운영에 영향을 주는 스킬·패시브를 먼저 검색해 정리한다 (포탑 압박, 순간 합류, 오브젝트 사냥 속도, 시야 장악, 강제 이니시 등).',
            '- 오브젝트 운영·한타·사이드 운영의 모든 문장에서 이 메커니즘을 실제로 쓴다. 일반 챔피언 누구에게나 해당되는 문장은 쓰지 않는다.',
            '',
            '[한타 포지션 작성 규칙]',
            '1) 조합의 5명을 역할 유형으로 분류한다: 이니시에이터 / 프론트라인 / 다이버·암살자 / 원거리 캐리 / 유틸·보호 / 사이드 압박.',
            '2) 각 챔피언마다: 시작 위치(아군 기준 위치와 거리, 예: "오른 뒤 2~3칸, 상대 이니시 스킬 사거리 바깥"), 진입 조건(상대의 어떤 챔피언·스킬이 빠졌을 때), 타겟 우선순위(1순위, 2순위, 쫓으면 안 되는 대상), 아껴야 할 스킬(진입용과 생존용 구분), 실패 신호와 대응(이니시가 빗나갔을 때 각자 무엇을 하는지).',
            '3) 지형별 포지션: 드래곤 둥지 / 바론 둥지 / 정글 좁은 길 / 미드 오픈 필드에서 우리 조합이 싸우고 싶은 곳과 피해야 할 곳.',
            '4) 한타 시작 시나리오 3개: 우리가 여는 경우, 상대가 여는 경우(받아치기), 포킹 대치가 길어지는 경우.',
            '',
            '[사이드 운영 작성 규칙]',
            '조합에 사이드 압박 챔피언(예: 요릭·피오라·잭스·트런들·카밀)이 있으면 반드시 작성한다. 없으면 "사이드는 누가 받고 4명은 어떻게 할지"를 1-4 기준으로 쓴다.',
            '1) 사이드 진입 조건: 미드 웨이브 상태, 반대편 사이드 웨이브 상태, 상대 사이드 대응 챔피언이 마지막으로 보인 위치, 텔레포트 쿨타임.',
            '2) 들어가는 깊이 기준: 상대 5명이 미니맵에 보일 때 포탑까지 / 3~4명이 보일 때 강가까지 / 2명 이하가 보일 때 즉시 후퇴. 이 조합과 상대 조합에 맞춰 조정한다.',
            '3) 챔피언 고유 압박 방법: 포탑 철거 속도, 소환물 활용, 1:1 승패 구간을 레벨·성장 시점(첫 코어 완성 등) 기준으로 쓴다 (예: 요릭이면 구울과 안개 마녀(R 군도의 장송곡)로 웨이브·포탑을 어떻게 압박하고 본체가 어떻게 빠지거나 합류하는지).',
            '4) 나머지 4명의 행동: 미드 웨이브 정리, 한타를 피하는 거리, 어떤 오브젝트를 동시에 요구할지(사이드 압박 + 바론/드래곤 동시 위협).',
            '5) 합류 vs 계속 압박: 오브젝트 몇 초 전에 합류하는지, 텔레포트로 합류할지, 압박을 계속해 포탑과 교환할지.',
            '6) 상대가 사이드에 2명을 보냈을 때: 4:3 상황을 어디서 어떻게 활용할지 구체적으로 쓴다.',
            '',
            '[작성 후 자체 검수] 출력 전에 다음을 확인하고 해당 문장을 고친다.',
            '- 캐리가 먼저 강가·둥지에 들어가는 문장이 있는가?',
            '- "각이 있을 때", "상황에 따라" 같은 표현이 조건 없이 단독으로 쓰였는가?',
            '- 다른 조합에도 그대로 쓸 수 있는 일반론 문장이 있는가?',
            '- 조합 내 챔피언의 고유 스킬이 운영 문장에 한 번도 등장하지 않는가?',
            '- 열세 상황에 맞교환이 빠졌는가?',
            '- 14분 이후 맞교환에 포탑 방패가 들어갔거나, 14분 전에 1-3-1·1-4 배치를 썼는가?',
            '- 우리 궁극기 보유 여부만으로 싸움을 판단한 문장이 있는가?',
            '- 템트리(룬·스킬 순서·아이템 이름)가 들어갔는가?',
            '',
            '[표기 형식: 화면이 이 형식만 읽는다]',
            '- 섹션은 "■ 제목" 한 줄(제목은 [출력 양식]의 제목 그대로), 소제목은 "▶ 이름" 한 줄, 내용은 "- " 글머리표.',
            '- 표·마크다운(#, **, |)은 쓰지 않는다. 표가 필요한 곳은 소제목 + 글머리표로 쓴다.',
            '- 출처 URL은 본문에 쓰지 않는다. 실제로 참고한 페이지는 검색 인용(출처 목록)으로 남기며 화면이 리포트 아래에 따로 표시한다.',
            '- 전체 16,000자 이내. 운영·한타·사이드 섹션을 우선하고, 다른 섹션은 간결하게 쓴다.'
        }, '\n');
    }

    /**
     * 통계 구간: 팀에서 가장 낮은 플레이어 티어 기준 (예: 에메랄드 하위 → "에메랄드+").
     * 통계 사이트의 티어 필터 구간에 맞춰 묶는다.
     */
    @TestVisible
    static String statBracket(AnalysisRequest req) {
        Decimal lowest = null;
        for (String lane : LANES) {
            LoL_Tier__mdt t = LoL_Tier__mdt.getInstance(req.tiers.get(lane));
            if (t != null && t.Sort_Order__c != null && (lowest == null || t.Sort_Order__c < lowest)) {
                lowest = t.Sort_Order__c;
            }
        }
        if (lowest == null || lowest <= 3) {
            return '전체 티어';
        }
        // LoL_Tier Sort_Order: 4 골드, 5 플래티넘, 6~7 에메랄드, 8~9 다이아, 10+ 마스터 이상
        return lowest <= 4 ? '골드+' : lowest <= 5 ? '플래티넘+' : lowest <= 7 ? '에메랄드+' : lowest <= 9 ? '다이아+' : '마스터+';
    }

    @TestVisible
    public static String userPrompt(AnalysisRequest req, LoL_AI_Setting__mdt s) {
        List<String> lines = new List<String>{ '[팀 목표] ' + s.Team_Goal__c, '', '[우리 조합]' };
        for (String lane : LANES) {
            LoL_Champion__mdt c = LoL_Champion__mdt.getInstance(req.picks.get(lane));
            LoL_Tier__mdt t = LoL_Tier__mdt.getInstance(req.tiers.get(lane));
            lines.add(String.format('- {0}: {1}({2}) / {3}·{4} / 플레이어 {5} / CC {6}, 앞라인 {7}, 후반 {8}, 이니시 {9}, 보호 {10}, 캐리 {11} / 메타 {12} 승률 {13}', new List<Object>{
                LANE_LABELS.get(lane), c.MasterLabel, c.English_Name__c, c.Role_Class__c, c.Damage_Type__c, t.MasterLabel,
                c.CC__c, c.Frontline__c, c.Late_Game__c, c.Engage__c, c.Peel__c, c.Carry__c,
                c.Meta_Tier__c, c.Win_Rate__c == null ? '미집계' : c.Win_Rate__c + '%'
            }));
            // 분석 시 항상 먼저 열어 볼 lol.ps(프로관전러) 챔피언 페이지. lane 번호는 lol.ps 기준(0 탑 ~ 4 서폿)
            if (c.Riot_Key__c != null) {
                lines.add('  lol.ps: ' + lolpsChampionUrl(c.Riot_Key__c.intValue(), lane) +
                    (c.PS_Score__c == null ? '' : ' (PS 점수 ' + c.PS_Score__c + (c.Honey__c ? ', 꿀챔' : '') + ')'));
            }
        }
        // 대체 픽을 팀이 실제로 할 수 있는 챔피언 안에서 고르도록 후보 풀을 함께 전달
        lines.add('');
        lines.add('[라인별 후보 풀] (대체 픽은 반드시 이 안에서)');
        Map<String, List<String>> pool = lanePool();
        for (String lane : LANES) {
            lines.add('- ' + LANE_LABELS.get(lane) + ': ' + String.join(pool.get(lane), ', '));
        }
        lines.add('');
        lines.add('[자체 점수] 총점 ' + req.totalScore.setScale(1) + ' / 100');
        if (req.categoryPoints != null) {
            // 화면과 같은 순서로 출력. CMDT는 Apex SOQL의 ORDER BY Sort_Order__c가 무시되고 DeveloperName 순으로 오므로 직접 정렬
            for (LoL_Score_Weight__mdt w : sortedWeights()) {
                if (req.categoryPoints.containsKey(w.DeveloperName)) {
                    lines.add('- ' + w.MasterLabel + ': ' + req.categoryPoints.get(w.DeveloperName).setScale(1) + ' / ' + w.Max_Points__c);
                }
            }
        }
        lines.add('');
        lines.add('[기준]');
        lines.add('- 기준 패치: ' + (String.isBlank(s.Base_Patch__c) ? '가장 최신 패치 (검색으로 확인)' : s.Base_Patch__c.trim()));
        lines.add('- 기준 티어: ' + statBracket(req) + ' (우리 팀 최저 티어 기준 통계 구간)');
        lines.add('');
        lines.add('[출력 양식] 아래 순서와 섹션 제목을 그대로 유지한다.');
        lines.add('■ 한줄 평가: 조합 정체성 + 승리 플랜 2문장. 자체 점수(총점) 표기');
        lines.add('■ 이 조합이 좋은 이유: 자체 점수 항목별 해석 + 검색으로 찾은 기준 패치 승률·티어 + 핵심 시너지 2~3개를 구체적 스킬 연계로 설명');
        lines.add('■ 약점과 상대하기 까다로운 조합: 초반 약점 시간대, 까다로운 조합 유형, 유형별 대표 챔피언 3개 이상');
        lines.add('■ 상대 조합별 대처법: 아래 6개 유형을 각각 "▶ 유형명" 소제목으로 쓰고, 소제목마다 "- 위험 포인트:", "- 라인별 행동:", "- 오브젝트 판단:", "- 한타 포지션:"을 각 1~2줄로 쓴다.');
        lines.add('  ▶ 다이브 조합 (예: 자르반·말파이트·카밀) ▶ 포킹·시즈 조합 (예: 제이스·제라스·직스) ▶ 스플릿 푸시 조합 (예: 피오라·잭스·트런들)');
        lines.add('  ▶ 픽·암살 조합 (예: 카직스·제드·블리츠크랭크) ▶ 보호형 하이퍼캐리 조합 (예: 룰루·코그모) ▶ 초반 스노우볼 조합 (예: 렉사이·드레이븐·판테온)');
        lines.add('  예시 챔피언은 기준 패치에서 실제로 많이 쓰이는 챔피언으로 검색해 교체해도 된다.');
        lines.add('  마지막에 "▶ 상대 정글러별 첫 3분 대응" 소제목: 기준 패치 픽률 상위 정글러 5명 각각 "- 챔피언: 예상 동선 / 우리 팀 대응" 한 줄.');
        lines.add('■ 라인별 해야 할 것 / 주의사항: ▶ 탑 ▶ 정글 ▶ 미드 ▶ 원딜 ▶ 서폿 소제목마다 "- 라인전:", "- 해야 할 것:" 3개, "- 주의사항:" 2개, "- 카운터:" 이 라인의 상위 카운터 챔피언 3개와 대처 1줄');
        lines.add('■ 정글 동선과 갱킹: ▶ 레드 시작 ▶ 블루 시작 (각각 시작 캠프부터 첫 귀환까지 캠프 순서) ▶ 첫 갱 타이밍과 우선 라인 ▶ 역갱·카정 대응');
        lines.add('■ 오브젝트 운영: [운영 작성 규칙]대로 쓴다. 기준 패치에 있는 오브젝트만 "▶ 공허 유충" "▶ 첫 드래곤" "▶ 협곡의 전령" "▶ 바론" "▶ 드래곤 영혼·장로" 소제목으로 쓰고, 소제목마다 아래 글머리표를 쓴다.');
        lines.add('  "- 90초 전:", "- 60초 전:", "- 30초 전:", "- 등장 후:"');
        lines.add('  "- 우세:" (판단 기준 포함), "- 비등:" (판단 기준 포함), "- 열세:" (맞교환 + 손해가 적은 이유)');
        lines.add('  "- 상대 조합별:" 상대 조합 유형에 따른 변화 1~2줄');
        lines.add('■ 한타 포지션: [한타 포지션 작성 규칙]대로 쓴다.');
        lines.add('  ▶ 역할 분류: 챔피언마다 "- 챔피언: 역할 유형 / 시작 위치 / 진입 조건 / 1순위 타겟(2순위, 쫓으면 안 되는 대상) / 아낄 스킬(진입용·생존용) / 실패 시 대응" 한 줄');
        lines.add('  ▶ 지형별 포지션: 드래곤 둥지 / 바론 둥지 / 정글 좁은 길 / 미드 오픈 필드마다 싸우고 싶은 곳과 피할 곳');
        lines.add('  ▶ 한타 시나리오: "- 우리가 여는 경우:", "- 상대가 여는 경우(받아치기):", "- 포킹 대치가 길어지는 경우:"');
        lines.add('■ 사이드 운영: [사이드 운영 작성 규칙]대로 쓴다. ▶ 사이드 담당과 진입 조건 ▶ 깊이 기준 ▶ 챔피언 고유 압박법 ▶ 나머지 4명 행동 ▶ 합류·압박 판단 (상대가 2명을 보냈을 때 4:3 활용 포함)');
        lines.add('■ 시간대별 운영 플랜: ▶ 0~14분 ▶ 14~25분 ▶ 25분 이후 소제목마다 "- 목표:", "- 웨이브 배치:"(1-3-1 / 1-4 / 5인 뭉침 중 무엇을, 누가 어디), "- 우세 시:", "- 열세 시:", "- 라인별 역할:"(우리 챔피언 이름으로)을 쓴다');
        lines.add('■ 추천 밴 3개: "- 챔피언명: 이유" 3줄');
        lines.add('■ 대체 픽: [라인별 후보 풀] 안에서 라인별 1개, "- 라인 챔피언: 대체 시 조합에서 바뀌는 점" 1줄');
        lines.add('■ 데이터 기준: 기준 패치·티어, 출처 간 값이 달랐던 항목 1~3줄 (이 섹션 외에는 불확실성 표현을 쓰지 않는다)');
        return String.join(lines, '\n');
    }

    class ChampionOrder implements Comparator<LoL_Champion__mdt> {
        public Integer compare(LoL_Champion__mdt a, LoL_Champion__mdt b) {
            Decimal x = a.Sort_Order__c == null ? 999 : a.Sort_Order__c;
            Decimal y = b.Sort_Order__c == null ? 999 : b.Sort_Order__c;
            return x == y ? 0 : (x < y ? -1 : 1);
        }
    }

    /** lol.ps 챔피언 페이지 (한국 서버 · 에메랄드+, 라인 지정). 라인 번호는 LANES 순서와 같다 */
    @TestVisible
    static String lolpsChampionUrl(Integer riotKey, String lane) {
        return 'https://lol.ps/champ/' + riotKey + '?tier=2&region=0&lane=' + LANES.indexOf(lane);
    }

    /** 라인 → 팀 선호 픽 이름(티어) 목록, 화면과 같은 순서 */
    @TestVisible
    static Map<String, List<String>> lanePool() {
        List<LoL_Champion__mdt> champions = LoL_Champion__mdt.getAll().values();
        champions.sort(new ChampionOrder());
        Map<String, List<String>> pool = new Map<String, List<String>>();
        for (String lane : LANES) {
            pool.put(lane, new List<String>());
        }
        for (LoL_Champion__mdt c : champions) {
            // 전체 픽(260여 건)을 다 넣으면 프롬프트가 길어지므로 팀 선호 픽만 대체 후보로 전달
            if (pool.containsKey(c.Lane__c) && c.Preferred__c) {
                pool.get(c.Lane__c).add(c.MasterLabel + '(' + c.Meta_Tier__c + ')');
            }
        }
        return pool;
    }

    class WeightOrder implements Comparator<LoL_Score_Weight__mdt> {
        public Integer compare(LoL_Score_Weight__mdt a, LoL_Score_Weight__mdt b) {
            Decimal x = a.Sort_Order__c == null ? 999 : a.Sort_Order__c;
            Decimal y = b.Sort_Order__c == null ? 999 : b.Sort_Order__c;
            return x == y ? 0 : (x < y ? -1 : 1);
        }
    }

    @TestVisible
    static List<LoL_Score_Weight__mdt> sortedWeights() {
        List<LoL_Score_Weight__mdt> weights = LoL_Score_Weight__mdt.getAll().values();
        weights.sort(new WeightOrder());
        return weights;
    }

    /** HTTP 응답 → 결과. 실패는 사용자용 메시지로 변환하고 상세는 debug 로그에만 남김 */
    public static AnalysisResult parseResponse(HttpResponse res) {
        Integer status = res.getStatusCode();
        if (status != 200) {
            System.debug(LoggingLevel.ERROR, 'Claude API ' + status + ': ' + res.getBody()?.left(2000));
            throw new AnalysisException(errorMessage(status, res.getBody()));
        }
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        AnalysisResult result = new AnalysisResult();
        result.model = (String) body.get('model');
        result.truncated = body.get('stop_reason') == 'max_tokens' || body.get('stop_reason') == 'pause_turn';

        List<String> texts = new List<String>();
        Map<String, Source> sourcesByUrl = new Map<String, Source>();
        for (Object item : (List<Object>) body.get('content')) {
            Map<String, Object> block = (Map<String, Object>) item;
            String type = (String) block.get('type');
            if (type == 'text') {
                texts.add((String) block.get('text'));
                // 실제로 인용된 출처만 표시 (검색했지만 쓰지 않은 결과는 제외)
                for (Object citation : block.get('citations') == null ? new List<Object>() : (List<Object>) block.get('citations')) {
                    Map<String, Object> c = (Map<String, Object>) citation;
                    String url = (String) c.get('url');
                    if (String.isNotBlank(url) && !sourcesByUrl.containsKey(url)) {
                        sourcesByUrl.put(url, new Source((String) c.get('title'), url));
                    }
                }
            } else if (type == 'server_tool_use') {
                result.searchCount++;
            }
        }
        result.text = String.join(texts, '').trim();
        result.sources = sourcesByUrl.values();
        if (String.isBlank(result.text)) {
            throw new AnalysisException('Claude 응답이 비어 있습니다. 잠시 후 다시 시도하세요.');
        }
        return result;
    }

    @TestVisible
    static String errorMessage(Integer status, String body) {
        String lower = body == null ? '' : body.toLowerCase();
        if (status == 401 || status == 403) {
            return 'Claude API Key가 없거나 올바르지 않습니다. Setup > Named Credentials > External Credentials > Claude API에서 ApiKey를 확인하세요.';
        }
        if (status == 400 && lower.contains('web search')) {
            return 'Claude Console에서 웹 검색이 비활성화되어 있습니다. 활성화하거나 AI 설정의 Web Search Tool을 비우세요.';
        }
        if (status == 400 && lower.contains('model')) {
            return 'AI 설정의 모델 ID를 확인하세요.';
        }
        if (status == 429) {
            return 'Claude API 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.';
        }
        if (status == 529 || status >= 500 && status < 600) {
            return 'Claude 서버가 혼잡합니다. 잠시 후 다시 시도하세요.';
        }
        // Continuation 자체 오류 코드 (2000: 타임아웃, 2001: 연결 실패, 2002: 예외, 2003: 응답 미도착, 2004: 응답 크기 초과)
        if (status == 2000 || status == 2003) {
            return '분석 시간이 초과되었습니다(최대 120초). 다시 시도하거나 AI 설정에서 검색 횟수를 줄이세요.';
        }
        if (status == 2001 || status == 2002) {
            return 'Claude API에 연결하지 못했습니다. Named Credential(Claude_API) 설정과 API Key 등록, 권한 집합(LoL Team Builder User)을 확인하세요.';
        }
        if (status == 2004) {
            return '응답이 너무 큽니다. AI 설정의 Max Tokens를 줄이세요.';
        }
        return 'Claude 분석 요청이 실패했습니다 (HTTP ' + status + ').';
    }
}
