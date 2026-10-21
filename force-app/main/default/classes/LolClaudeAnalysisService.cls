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
            '   - 1순위(항상 먼저 참조): lol.ps (프로관전러 P.S, 한국 서버 · 에메랄드+). [우리 조합]의 "lol.ps 통계"와 [상대 정글러 픽률 상위 5]는 lol.ps에서 이미 가져온 값이므로 통계 수치는 이 값을 그대로 쓴다.',
            '     카운터 등 추가 수치는 lol.ps 챔피언 페이지에서 확인한다. lol.ps는 수치가 페이지 스크립트 데이터에 있어 일반 웹 읽기(화면 글자)로는 비어 보일 수 있다 → 그때는 lolalytics·op.gg 등으로 대체하고 "데이터 기준"에 한 줄 적는다.',
            '     출처를 읽지 못했다는 이유로 분석을 중단하거나 실패 처리하지 않는다. 수치를 지어내지 않는 범위에서 끝까지 작성한다.',
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
            '- 추천 밴 3개는 [밴 작성 규칙]대로 쓴다.',
            '- 라인별 주도권(강한 라인·약한 라인)은 리포트 전체에서 한 번 판단하고 모든 섹션에서 같게 쓴다. 라인전 성향과 lol.ps 카운터를 근거로 판단한다 (예: 정글 섹션에서 "바텀은 스스로 지킨다"라고 썼다면 드래곤 섹션에서 "바텀이 밀린다"라고 쓰지 않는다).',
            '- [출력 양식]의 항목 이름이나 이 지침의 문장을 그대로 옮겨 쓰지 않는다 (예: "카정, 강제 오브젝트, 반대 라인 다이브 순으로 판단한다" 금지). 이 조합에서 왜 그런지 판단과 이유를 쓴다.',
            '- 결단 조건마다 눈으로 확인할 수 있는 신호를 1개 이상 쓴다: 레벨(예: 레넥톤 3레벨), 상대 귀환·점멸·궁극기 사용, 웨이브 상태(빅웨이브·크래시), 상대 정글 마지막 위치.',
            '- 승률·픽률 같은 통계 숫자는 "이 조합이 좋은 이유"와 "데이터 기준"에만 쓴다. 라인별 가이드·추천 밴에는 숫자 대신 판단과 이유를 쓴다.',
            '- 기본 스킬 설명("Q로 딜을 넣고 W로 보호막")은 쓰지 않는다. 스킬은 판단·연계에 필요한 경우에만 이름으로 쓴다.',
            '- 정글 섹션은 풀캠프 순서(레드 → 돌거북 …)나 "3분 30초 바위게" 같은 정석 동선을 쓰지 않는다. [정글 작성 규칙]대로 실전 스노우볼링 전략을 쓴다.',
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
            '2) 오브젝트 판단 3요소 (첫 공허 유충·첫 드래곤). "90초 전 리콜, 60초 전 와드" 같은 기본 시간표는 쓰지 않는다.',
            '- 라인전 주도권: 어느 라인이 강한가, 그 라인이 웨이브를 밀고 먼저 합류하는 픽인지 웨이브를 받아 주며 당겨야 하는 픽인지.',
            '- 시야·자리 잡기: 주도권 있는 라인이 먼저 움직여 잡을 시야와 위치. 정글·서폿·탱커가 먼저, 캐리(원딜·AP 메이지)는 마지막. "캐리가 먼저 자리를 잡는다"는 문장은 금지한다.',
            '- 결단 조건: 선공 이니시 보유 여부(누가 어떤 스킬로 여는지), 오브젝트 버스트·트라이 조건, 교전을 유도할지 포기하고 교환할지.',
            '- 두괄식: 각 판단의 첫 문장에 결론(친다 / 포기하고 무엇과 교환한다)을 쓰고 이유를 뒤에 붙인다.',
            '3) 상황별 판단 (우세/비등/열세)',
            '- 판단 기준을 숫자나 조건으로 쓴다. 예: 라인 우선권 2곳 이상, 상대 정글 마지막 위치, 상대 핵심 스킬(점멸·궁극기) 사용 여부, 웨이브 상태, 시야 우위.',
            '- 우리 궁극기 보유 여부만으로 판단하지 않는다. "오공 R이 있을 때만 시도", "R 2개 이상이면 연다" 같은 문장은 금지하고, 반드시 상대 위치·웨이브·시야 조건과 함께 쓴다.',
            '- 열세일 때는 반드시 맞교환을 쓴다: 무엇을 내주고 반대편에서 무엇을 가져오는지, 그 교환이 왜 손해가 적은지 한 줄(골드·포탑·시간 기준).',
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
            '[사이드 운영 작성 규칙: 중후반 1-4 / 1-1-3 구도와 인원 수싸움]',
            '- "상대 N명이 보이면 후퇴" 같은 기계적인 인원 체크, 단순 스킬 설명은 쓰지 않는다. 사이드에 설 챔피언이 마땅치 않으면 이 조합에서 가장 적합한 1명을 정하고 이유를 쓴다.',
            '1) 사이드 롤 분담과 본대 미드 자리잡기: 중후반 미드는 누가(챔피언 이름) 맡아 먼저 밀고, 그 미드 주도권이 왜 사이드 담당이 밀 시간을 만들어 주는지.',
            '2) 텔레포트 유무에 따른 사이드 위치: 사이드 담당에게 텔레포트가 있을 때(오브젝트 반대편 사이드 압박 → 교전 시 텔레포트 합류)와 없을 때(오브젝트 쪽 사이드 관리 또는 미리 본대 합류).',
            '3) 인원 수싸움 공식: 상대가 사이드에 2명 이상을 썼을 때 본대가 누구의 어떤 이니시로 미드 다이브·오브젝트 강제 개시를 하는지 / 1명만 보냈을 때 사이드 담당이 1:1로 이기는지(이기는 레벨·성장 시점) 또는 포탑 철거 압박을 하는지.',
            '4) 한타 합류 vs 사이드 철거(포탑 교환) 결단: 언제 텔레포트로 합류하고, 언제 포탑·억제기를 깨며 교환하는지 신호(오브젝트 등장 직전, 상대 핵심 스킬 사용, 사이드 포탑 체력)로 쓴다.',
            '',
            '[라인별 가이드 작성 규칙]',
            '- 라인마다 세 가지만 쓴다. 게임 시작 전에 읽고 바로 머리에 넣을 수 있게 두괄식·간결하게.',
            '1) 파워 커브: 몇 레벨(또는 몇 코어)까지 주도권이 없어 사려야 하는지, 주도권을 잡거나 정글을 불러 킬각을 볼 수 있는 시점(파워 스파이크)은 언제인지.',
            '2) 하드 카운터 2~3개: 그 라인이 만나면 가장 어려운 챔피언(lol.ps 상대하기 어려운 챔피언 우선). 챔피언마다 [카운터인 이유] 한 줄 + [대처법] 딜교 피하는 법·웨이브 관리(빅웨이브 받아먹기·당기기)·정글 요청 타이밍.',
            '3) 정글 케어 요청: 이 라인이 우리 정글러에게 바라는 케어(디나이 방지, 다이브 방지, 라인 선점 등)와 그 타이밍.',
            '',
            '[밴 작성 규칙]',
            '- 우리 조합의 초반 약점, 진입 메커니즘, 캐리 보호 필요성, 한타 콘셉트를 가장 크게 무너뜨리는 챔피언 3개를 우선순위 순으로 고른다. 승률 숫자·표본 수는 쓰지 않는다.',
            '- 챔피언마다 [위협 사유] 우리 조합의 무엇을 어떻게 무너뜨리는지(예: 초반 주도권이 없는 라인을 노린 극초반 다이브·카정, 우리 진입을 막거나 캐리를 무는 픽, 하드 이니시·암살) + [열렸을 때 위험] 밴하지 않으면 우리 승리 플랜이 어떻게 무너지는지 한 줄.',
            '',
            '[정글 작성 규칙: 실전 스노우볼링 전략]',
            '- 풀캠프 순서, "3분 30초 바위게" 같은 누구나 아는 정석 동선 안내는 쓰지 않는다. 두괄식으로 쓰고, 정글·오브젝트 소제목마다 2~3줄 이상(판단 + 신호 + 이유) 쓴다.',
            '1) 캐리 라인 설정: 후반 캐리 라인과 라인전 스파이크 라인. 1~6레벨에 정글이 반드시 힘을 실어 줄 라인과 내버려 둬도 되는 라인을 이유와 함께 구분한다.',
            '2) 갱킹 우선순위: "몇 분에 간다" 대신 [상대 라인 빅웨이브 형성 / 우리 라이너와 CC 연계가 가능한 시점 / 상대 점멸·스펠 유무] 조건으로 우선순위를 정한다. 라인마다 우리 라이너 스킬 + 정글 스킬의 호응 구조(누가 먼저 무엇을 맞히고 무엇을 잇는지)를 쓴다.',
            '3) 카정·동선 설계: 라이너 주도권이 있을 때 상대 캠프 카정·상대 정글 시야 차단 조건. 상대 정글이 반대편 갱을 갔을 때 [상대 정글 카정 / 강제 오브젝트 / 반대 라인 다이브] 중 우선순위와 이유.',
            '4) 역갱·교전: 우리 정글러가 확실히 이기는 타이밍(레벨·스킬·첫 코어)과 2:2·3:3 교전에서 역갱을 노릴 라인.',
            '',
            '[작성 후 자체 검수] 출력 전에 다음을 확인하고 해당 문장을 고친다.',
            '- 캐리가 먼저 강가·둥지에 들어가는 문장이 있는가?',
            '- 오브젝트 운영에 90·60·30초 시간표 같은 기본 수칙이 남았는가? 각 판단이 두괄식(결론 먼저)인가?',
            '- 정글 섹션에 풀캠프 순서·바위게 시간 같은 정석 동선이 있는가?',
            '- "각이 있을 때", "상황에 따라" 같은 표현이 조건 없이 단독으로 쓰였는가?',
            '- 다른 조합에도 그대로 쓸 수 있는 일반론 문장이 있는가?',
            '- 조합 내 챔피언의 고유 스킬이 운영 문장에 한 번도 등장하지 않는가?',
            '- 열세 상황에 맞교환이 빠졌는가?',
            '- 같은 라인의 주도권을 섹션마다 다르게 쓴 곳이 있는가?',
            '- 출력 양식이나 지침 문장을 그대로 옮긴 문장이 있는가? 결단 조건에 확인 가능한 신호가 빠졌는가?',
            '- 라인별 가이드·추천 밴에 승률 숫자나 기본 스킬 설명이 들어갔는가?',
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
        // 특정 팀 목표는 넣지 않는다 (객관 기준 분석). 조합·통계·점수만 전달
        List<String> lines = new List<String>{ '[우리 조합]' };
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
                lines.add('  lol.ps: ' + lolpsChampionUrl(c.Riot_Key__c.intValue(), lane));
            }
            if (c.PS_Score__c != null) {
                // Salesforce에 저장된 lol.ps 수치(scripts/lol/fetch-stats.js로 수집): 페이지를 못 읽어도 근거 수치가 있도록
                lines.add('  lol.ps 통계: 티어 ' + c.Meta_Tier__c + ' · 승률 ' + c.Win_Rate__c + '% · 픽률 ' + c.Pick_Rate__c + '% · 밴률 ' + c.Ban_Rate__c +
                    '% · PS 점수 ' + c.PS_Score__c + (c.Honey__c ? ' · 꿀챔' : ''));
            }
        }
        // "상대 정글러별 첫 3분 대응"의 근거: lol.ps 정글 픽률 상위 5명 (Salesforce에 저장된 값)
        lines.add('');
        lines.add('[상대 정글러 픽률 상위 5 (lol.ps 한국 에메랄드+)]');
        for (LoL_Champion__mdt j : topPicked('JUNGLE', 5)) {
            lines.add('- ' + j.MasterLabel + ': 픽률 ' + j.Pick_Rate__c + '% · 승률 ' + j.Win_Rate__c + '% · 티어 ' + j.Meta_Tier__c);
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
        lines.add('  마지막에 "▶ 상대 정글러별 첫 3분 대응" 소제목: [상대 정글러 픽률 상위 5]의 5명 각각 "- 챔피언: 예상 동선 / 우리 팀 대응" 한 줄.');
        lines.add('■ 라인별 가이드: [라인별 가이드 작성 규칙]대로 쓴다. ▶ 탑 ▶ 정글 ▶ 미드 ▶ 원딜 ▶ 서폿 소제목마다 "- 파워 커브:" 사려야 하는 구간과 스파이크, "- 하드 카운터:" 2~3개(챔피언 — 이유 / 대처), "- 정글 케어 요청:"');
        lines.add('■ 정글 운영과 갱킹: [정글 작성 규칙]대로 두괄식으로 쓴다. ▶ 캐리 라인 설정 ▶ 갱킹 우선순위와 호응 ▶ 카정·동선 판단 ▶ 역갱·교전 타이밍');
        lines.add('■ 오브젝트 운영: [운영 작성 규칙] 2) 판단 3요소대로 두괄식으로 쓴다. "▶ 첫 공허 유충" "▶ 첫 드래곤" 두 소제목만 쓴다 (전령·바론·영혼은 시간대별 운영 플랜에서 다룬다).');
        lines.add('  ▶ 첫 공허 유충: "- 결론:" 이 조합의 기본 판단 한 줄, "- 탑·미드 주도권:" 밀어붙이는 픽일 때 vs 당겨야 하는 픽일 때, "- 시야·자리:", "- 정글 동선·트라이 조건:" 이니시·교전 픽 보유 시, "- 상대가 강할 때:" 반대편 이득(하체 플레이, 첫 드래곤 교환 등)');
        lines.add('  ▶ 첫 드래곤: "- 결론:", "- 바텀·미드 주도권:", "- 시야·자리:", "- 2:2·3:3 교전과 선공 이니시:" 트라이 기준, "- 포기할 때:" 반대편 이득(유충, 정글 캠프 수급, 포탑 압박)');
        lines.add('■ 한타 포지션: [한타 포지션 작성 규칙]대로 쓴다.');
        lines.add('  ▶ 역할 분류: 챔피언마다 "- 챔피언: 역할 유형 / 시작 위치 / 진입 조건 / 1순위 타겟(2순위, 쫓으면 안 되는 대상) / 아낄 스킬(진입용·생존용) / 실패 시 대응" 한 줄');
        lines.add('  ▶ 지형별 포지션: 드래곤 둥지 / 바론 둥지 / 정글 좁은 길 / 미드 오픈 필드마다 싸우고 싶은 곳과 피할 곳');
        lines.add('  ▶ 한타 시나리오: "- 우리가 여는 경우:", "- 상대가 여는 경우(받아치기):", "- 포킹 대치가 길어지는 경우:"');
        lines.add('■ 사이드 운영: [사이드 운영 작성 규칙]대로 두괄식으로 쓴다. ▶ 사이드 롤 분담과 미드 자리잡기 ▶ 텔레포트 유무별 위치 ▶ 인원 수싸움 공식 ▶ 합류 vs 철거 결단');
        lines.add('■ 시간대별 운영 플랜: ▶ 0~14분 ▶ 14~25분 ▶ 25분 이후 소제목마다 "- 목표:", "- 웨이브 배치:"(1-3-1 / 1-4 / 5인 뭉침 중 무엇을, 누가 어디), "- 오브젝트:"(14~25분은 전령·드래곤, 25분 이후는 바론·영혼·장로 판단을 두괄식으로), "- 우세 시:", "- 열세 시:", "- 라인별 역할:"(우리 챔피언 이름으로)을 쓴다');
        lines.add('■ 추천 밴 3개: [밴 작성 규칙]대로 우선순위 순. "- 1순위 챔피언: 위협 사유 / 열렸을 때 위험" 형식으로 3줄');
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

    /** 라인별 픽률 상위 N명 (lol.ps 수치가 있는 레코드만) */
    @TestVisible
    static List<LoL_Champion__mdt> topPicked(String lane, Integer count) {
        List<PickRateOrder> rows = new List<PickRateOrder>();
        for (LoL_Champion__mdt c : LoL_Champion__mdt.getAll().values()) {
            if (c.Lane__c == lane && c.Pick_Rate__c != null) {
                rows.add(new PickRateOrder(c));
            }
        }
        rows.sort();
        List<LoL_Champion__mdt> top = new List<LoL_Champion__mdt>();
        for (Integer i = 0; i < Math.min(count, rows.size()); i++) {
            top.add(rows[i].champion);
        }
        return top;
    }

    class PickRateOrder implements Comparable {
        LoL_Champion__mdt champion;
        PickRateOrder(LoL_Champion__mdt champion) {
            this.champion = champion;
        }
        public Integer compareTo(Object other) {
            Decimal mine = champion.Pick_Rate__c;
            Decimal theirs = ((PickRateOrder) other).champion.Pick_Rate__c;
            return mine == theirs ? 0 : (mine > theirs ? -1 : 1); // 픽률 내림차순
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
