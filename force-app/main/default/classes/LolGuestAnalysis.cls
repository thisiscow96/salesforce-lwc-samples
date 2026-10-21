/**
 * Experience Cloud 공개 사이트 방문자(게스트)의 분석 요청 처리.
 *
 * 왜 without sharing인가: 게스트 사용자는 레코드 공유·오브젝트 권한을 받을 수 없어 사용자 모드로는 요청 저장·조회가 불가.
 * 대신 범위를 이 클래스로 좁히고 아래 규칙으로 남용을 막는다.
 * - 방문자가 만든 요청만 조회 (로그인 사용자의 요청은 볼 수 없음). 모든 방문자는 같은 게스트 계정이므로 결과는 방문자끼리 공유됨
 * - 같은 조합(챔피언·티어)은 진행 중이거나 최근(Guest_Cache_Hours__c) 완료된 결과를 재사용 → Claude 실행 없음
 * - 새 요청은 방문자 IP 1개당 Guest_Ip_Window_Minutes__c분에 Guest_Ip_Limit__c건(기본 10분 5건), 방문자 전체 기준 시간당 Guest_Hourly_Limit__c건까지
 *   IP는 SHA-256 해시(Client_Key__c)로만 저장·비교한다. IP를 얻지 못하면 IP별 상한은 건너뛰고 전체 상한만 적용
 * - 프롬프트는 서버가 Custom Metadata로 조립 (방문자 입력 문자열이 프롬프트에 들어가지 않음)
 */
public without sharing class LolGuestAnalysis {
    static final List<String> LANES = new List<String>{ 'TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT' };

    public static Boolean enabled(LoL_AI_Setting__mdt s) {
        return s != null && s.Guest_Analysis_Enabled__c == true && s.Mode__c != 'API';
    }

    /**
     * 검증된 요청을 저장하거나 재사용할 기존 요청 Id를 돌려준다.
     * clientIp: 방문자 접속 IP (LolGuestApi가 Apex REST의 RestContext.request.remoteAddress로 전달). null이면 IP별 상한 생략
     * 주의: 게스트에게 Auth.SessionManagement.getCurrentSession()을 호출하면 "Guest users must never have a session ID" 오류가
     *       try/catch로도 잡히지 않아 요청 전체가 실패한다(2026-10 확인) → IP는 Apex REST 경로에서만 얻는다.
     */
    public static Id submit(LolClaudeAnalysisService.AnalysisRequest req, LoL_AI_Setting__mdt s, String clientIp) {
        if (!enabled(s)) {
            throw new LolClaudeAnalysisService.AnalysisException('공개 사이트의 분석 요청이 현재 꺼져 있습니다.');
        }
        Id guestId = UserInfo.getUserId();
        String key = compositionKey(req);
        Integer cacheHours = s.Guest_Cache_Hours__c == null ? 24 : s.Guest_Cache_Hours__c.intValue();
        Datetime cacheSince = Datetime.now().addHours(-cacheHours);

        List<LoL_Analysis_Request__c> reusable = [
            SELECT Id, Name, Status__c, CreatedDate
            FROM LoL_Analysis_Request__c
            WHERE Composition_Key__c = :key AND CreatedById = :guestId
                AND (Status__c IN ('Pending', 'Processing') OR (Status__c = 'Completed' AND Completed_At__c >= :cacheSince))
            ORDER BY CreatedDate DESC
            LIMIT 1
        ];
        if (!reusable.isEmpty()) {
            LoL_Analysis_Request__c existing = reusable[0];
            // 2분 넘게 대기 중이면 이전 실행 신호가 유실된 것으로 보고 다시 보냄 (루틴은 대기 요청을 함께 처리하므로 중복 분석 없음)
            if (existing.Status__c == 'Pending' && existing.CreatedDate < Datetime.now().addMinutes(-2)) {
                LolRoutineFire.enqueueIfConfigured(existing.Name);
            }
            return existing.Id;
        }

        // IP별 상한: 한 방문자가 전체 상한을 혼자 다 쓰지 못하게 (IP는 해시로만 비교·저장)
        String clientKey = clientKey(clientIp);
        if (clientKey != null) {
            Integer ipLimit = s.Guest_Ip_Limit__c == null ? 5 : s.Guest_Ip_Limit__c.intValue();
            Integer windowMinutes = s.Guest_Ip_Window_Minutes__c == null ? 10 : s.Guest_Ip_Window_Minutes__c.intValue();
            Integer recent = [
                SELECT COUNT()
                FROM LoL_Analysis_Request__c
                WHERE CreatedById = :guestId AND Client_Key__c = :clientKey AND CreatedDate >= :Datetime.now().addMinutes(-windowMinutes)
            ];
            if (recent >= ipLimit) {
                throw new LolClaudeAnalysisService.AnalysisException(
                    '같은 네트워크에서 ' + windowMinutes + '분에 ' + ipLimit + '건까지 새 분석을 요청할 수 있습니다. 잠시 후 다시 시도하거나, 이미 분석된 조합을 확인하세요.'
                );
            }
        }

        Integer hourlyLimit = s.Guest_Hourly_Limit__c == null ? 10 : s.Guest_Hourly_Limit__c.intValue();
        Integer lastHour = [SELECT COUNT() FROM LoL_Analysis_Request__c WHERE CreatedById = :guestId AND CreatedDate >= :Datetime.now().addHours(-1)];
        if (lastHour >= hourlyLimit) {
            throw new LolClaudeAnalysisService.AnalysisException(
                '공개 사이트 분석 요청이 많습니다(시간당 ' + hourlyLimit + '건). 잠시 후 다시 시도하거나, 이미 분석된 조합을 확인하세요.'
            );
        }

        LoL_Analysis_Request__c record = new LoL_Analysis_Request__c(
            Status__c = 'Pending',
            Composition__c = LolClaudeAnalysisService.composition(req),
            Composition_Key__c = key,
            Request_JSON__c = JSON.serialize(req),
            Prompt__c = LolClaudeAnalysisService.fullPrompt(req, s),
            Total_Score__c = req.totalScore,
            Client_Key__c = clientKey
        );
        insert record;
        LolRoutineFire.enqueueIfConfigured([SELECT Name FROM LoL_Analysis_Request__c WHERE Id = :record.Id].Name);
        return record.Id;
    }


    /** IP → 해시 (원본 IP는 저장하지 않음). 조직 Id를 섞어 다른 시스템의 해시와 맞춰 볼 수 없게 한다 */
    @TestVisible
    static String clientKey(String ip) {
        if (String.isBlank(ip)) {
            return null;
        }
        Blob digest = Crypto.generateDigest('SHA-256', Blob.valueOf(UserInfo.getOrganizationId() + '|' + ip.trim()));
        return EncodingUtil.convertToHex(digest);
    }

    /** 방문자가 만든 요청만 조회 */
    public static LoL_Analysis_Request__c get(Id requestId) {
        List<LoL_Analysis_Request__c> rows = [
            SELECT Id, Name, Status__c, Composition__c, Total_Score__c, Result__c, Sources_JSON__c, Search_Count__c,
                Error_Message__c, Processed_By__c, CreatedDate, Completed_At__c
            FROM LoL_Analysis_Request__c
            WHERE Id = :requestId AND CreatedById = :UserInfo.getUserId()
            LIMIT 1
        ];
        return rows.isEmpty() ? null : rows[0];
    }

    /** 라인 순서대로 챔피언/티어를 이어 붙인 키 (점수는 같은 조합이면 같으므로 제외) */
    public static String compositionKey(LolClaudeAnalysisService.AnalysisRequest req) {
        List<String> parts = new List<String>();
        for (String lane : LANES) {
            parts.add(req.picks.get(lane) + '/' + req.tiers.get(lane));
        }
        return String.join(parts, '|').left(255);
    }
}
