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
        // 전문 코치 관점의 지침. 패치마다 바뀌는 수치(오브젝트 시간·승률)는 하드코딩하지 않고 매번 검색으로 확인하게 한다
        return String.join(new List<String>{
            '너는 한국 서버 챌린저 출신 리그 오브 레전드 전문 코치이자 분석가다. 매 패치 프로 경기와 솔로랭크 메타를 추적한다.',
            '원칙:',
            '1) 반드시 웹 검색으로 현재 패치를 확인한다: 패치 노트, 챔피언 티어·승률(op.gg, lol.ps, u.gg 등), 오브젝트 등장·재생성 시간(드래곤, 공허 유충, 협곡의 전령, 아타칸, 바론), 커뮤니티 의견(인벤, 디시인사이드 리그오브레전드 갤러리, 유튜브 공략).',
            '2) 시간·승률 같은 수치는 검색으로 확인한 것만 단정하고, 확인하지 못한 것은 "(확인 필요)"로 표시한다. 제공된 자체 데이터와 검색 결과가 다르면 차이를 밝힌다.',
            '   오브젝트 시간은 전용 검색을 최소 1회 한다 (예: "롤 ' + Date.today().year() + ' 시즌 공허 유충 등장 시간", "Summoner\'s Rift objective spawn times ' + Date.today().year() + '"). 시즌 시작 패치에서 오브젝트가 추가·삭제될 수 있으므로 leagueoflegends.com 공식 개발 노트·패치 노트를 우선 근거로 삼는다.',
            '3) 일반론 대신 이 조합과 라인별 플레이어 실력대에 맞춘 구체적 행동 지침을 준다: 몇 분에, 누가, 어디서, 무엇을.',
            '4) 한국어로, 롤 커뮤니티 용어(라인전 주도권, 갱, 카정, 역갱, 다이브, 한타, 사이드 운영, 스노우볼 등)를 쓴다.',
            '형식: 섹션은 "■ 제목" 한 줄, 라인·단계별 소제목은 "▶ 탑"처럼 한 줄, 내용은 "- " 글머리표. 표·마크다운 굵게 금지. 전체 4,000자 이내.'
        }, '\n');
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
        lines.add('[요청] 위 조합으로 솔로랭크를 이기기 위한 코칭 리포트를 작성하라. 현재 패치를 먼저 검색한 뒤 아래 순서를 지킨다.');
        lines.add('■ 한줄 평가: 조합 컨셉과 승리 플랜');
        lines.add('■ 이 조합이 좋은 이유: 시너지·앞라인 구조, 자체 점수 근거');
        lines.add('■ 약점과 상대하기 까다로운 조합: 카운터 챔피언과 조합 유형, 대처법');
        lines.add('■ 라인별 해야 할 것 / 주의사항: ▶ 탑 ▶ 정글 ▶ 미드 ▶ 원딜 ▶ 서폿 소제목마다 라인전 핵심(레벨·아이템 구간별 강약 타이밍), 해야 할 것 3개, 주의사항 2개, 현재 패치 기준 핵심 아이템·룬 방향');
        lines.add('■ 정글 동선과 갱킹: 시작 위치와 첫 정글 루트, 첫 갱 타이밍과 대상 라인, 우선 봐줄 라인과 그 이유(우리 캐리 라인·상대 약점 기준), 카정·역갱·상대 정글 동선 추적 주의점');
        lines.add('■ 오브젝트 운영: 현재 패치의 등장 시간을 검색해 명시. 공허 유충(몇 분·몇 마리, 어느 라인 주도권으로 먹을지), 첫 드래곤 트라이 시점과 조건(바텀·미드 주도권, 정글 위치, 서폿 시야), 협곡의 전령·아타칸·바론 우선순위와 교환(트레이드) 판단');
        lines.add('■ 시간대별 운영 플랜: ▶ 0~14분 ▶ 14~25분 ▶ 25분 이후 (한타 구도, 사이드 운영, 시야 장악 포인트)');
        lines.add('■ 추천 밴 3개: 이유 포함');
        lines.add('■ 대체 픽: 라인별 후보 풀 안에서, 이유 포함');
        return String.join(lines, '\n');
    }

    class ChampionOrder implements Comparator<LoL_Champion__mdt> {
        public Integer compare(LoL_Champion__mdt a, LoL_Champion__mdt b) {
            Decimal x = a.Sort_Order__c == null ? 999 : a.Sort_Order__c;
            Decimal y = b.Sort_Order__c == null ? 999 : b.Sort_Order__c;
            return x == y ? 0 : (x < y ? -1 : 1);
        }
    }

    /** 라인 → 챔피언 이름(티어) 목록, 화면과 같은 순서 */
    @TestVisible
    static Map<String, List<String>> lanePool() {
        List<LoL_Champion__mdt> champions = LoL_Champion__mdt.getAll().values();
        champions.sort(new ChampionOrder());
        Map<String, List<String>> pool = new Map<String, List<String>>();
        for (String lane : LANES) {
            pool.put(lane, new List<String>());
        }
        for (LoL_Champion__mdt c : champions) {
            if (pool.containsKey(c.Lane__c)) {
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
