/**
 * Sales Dashboard(LWC + ECharts) 데이터 제공 컨트롤러
 * - with sharing + WITH USER_MODE: 실행 사용자의 Sharing·CRUD·FLS를 그대로 적용
 * - 차트용 집계는 SOQL Aggregate로 DB에서 처리 → 레코드가 늘어도 Heap/CPU 부담이 거의 늘지 않음
 * - 상세 목록(deals)만 MAX_DEALS 건으로 제한하고, 잘렸는지(truncated)를 함께 반환
 * - 조회 기간은 CloseDate 범위 조건으로 걸어 인덱스를 탈 수 있게 함 (CALENDAR_YEAR() 조건은 인덱스 미사용)
 */
public with sharing class SalesDashboardController {

    @TestVisible
    private static final Integer MAX_DEALS = 2000;
    private static final Integer MAX_ACCOUNT_GROUPS = 2000;

    @AuraEnabled(cacheable=true)
    public static DashboardData getDashboardData(Integer year) {
        if (year == null) {
            throw newUserError('조회 연도가 지정되지 않았습니다.');
        }
        Date startDate = Date.newInstance(year, 1, 1);
        Date endDate = startDate.addYears(1);
        try {
            DashboardData result = new DashboardData();
            result.year = year;
            result.months = buildMonths(startDate, endDate);
            result.stages = buildStages(startDate, endDate);
            result.leadSources = buildLeadSources(startDate, endDate);
            result.accounts = buildAccounts(startDate, endDate);
            result.daily = buildDaily(startDate, endDate);
            result.deals = buildDeals(startDate, endDate);
            result.truncated = result.deals.size() >= MAX_DEALS;
            return result;
        } catch (Exception e) {
            // 사용자에게는 일반 메시지, 상세 원인은 Debug Log에 남김
            System.debug(LoggingLevel.ERROR, 'SalesDashboardController.getDashboardData: '
                + e.getTypeName() + ' ' + e.getMessage() + '\n' + e.getStackTraceString());
            throw newUserError('대시보드 데이터를 불러오지 못했습니다. Opportunity 조회 권한을 확인하세요.');
        }
    }

    // 월별 수주/실주/진행 중 금액·건수 (1~12월 모두 채워서 반환)
    private static List<MonthData> buildMonths(Date startDate, Date endDate) {
        List<MonthData> months = new List<MonthData>();
        for (Integer m = 1; m <= 12; m++) {
            months.add(new MonthData(m));
        }
        for (AggregateResult ar : [
            SELECT CALENDAR_MONTH(CloseDate) mon, IsClosed isClosedFlag, IsWon isWonFlag,
                   SUM(Amount) amt, COUNT(Id) cnt
            FROM Opportunity
            WHERE CloseDate >= :startDate AND CloseDate < :endDate
            WITH USER_MODE
            GROUP BY CALENDAR_MONTH(CloseDate), IsClosed, IsWon
        ]) {
            MonthData md = months[(Integer) ar.get('mon') - 1];
            Decimal amt = toDecimal(ar.get('amt'));
            Integer cnt = (Integer) ar.get('cnt');
            String outcome = toOutcome((Boolean) ar.get('isClosedFlag'), (Boolean) ar.get('isWonFlag'));
            if (outcome == 'OPEN') {
                md.openAmount += amt;
                md.openCount += cnt;
            } else if (outcome == 'WON') {
                md.wonAmount += amt;
                md.wonCount += cnt;
            } else {
                md.lostAmount += amt;
                md.lostCount += cnt;
            }
        }
        return months;
    }

    // 진행 중 파이프라인의 단계별 금액 (단계 순서는 Setup의 Opportunity Stage 정렬 순서 → 단계명 하드코딩 없음)
    private static List<StageData> buildStages(Date startDate, Date endDate) {
        List<StageData> ordered = new List<StageData>();
        Map<String, StageData> byApiName = new Map<String, StageData>();
        for (OpportunityStage s : [
            SELECT ApiName, MasterLabel
            FROM OpportunityStage
            WHERE IsActive = true AND IsClosed = false
            WITH USER_MODE
            ORDER BY SortOrder
        ]) {
            StageData sd = new StageData(s.ApiName, s.MasterLabel);
            ordered.add(sd);
            byApiName.put(s.ApiName, sd);
        }
        for (AggregateResult ar : [
            SELECT StageName stage, SUM(Amount) amt, COUNT(Id) cnt
            FROM Opportunity
            WHERE IsClosed = false AND CloseDate >= :startDate AND CloseDate < :endDate
            WITH USER_MODE
            GROUP BY StageName
        ]) {
            String stage = (String) ar.get('stage');
            StageData sd = byApiName.get(stage);
            if (sd == null) {
                // 비활성화된 단계에 남아 있는 기회도 누락 없이 맨 뒤에 표시
                sd = new StageData(stage, stage);
                ordered.add(sd);
                byApiName.put(stage, sd);
            }
            sd.amount = toDecimal(ar.get('amt'));
            sd.count = (Integer) ar.get('cnt');
        }
        return ordered;
    }

    // Lead Source → 결과(수주/실주/진행 중) 흐름 (Sankey용). LeadSource가 비어 있으면 source = null
    private static List<LeadSourceData> buildLeadSources(Date startDate, Date endDate) {
        List<LeadSourceData> rows = new List<LeadSourceData>();
        for (AggregateResult ar : [
            SELECT LeadSource src, IsClosed isClosedFlag, IsWon isWonFlag, SUM(Amount) amt, COUNT(Id) cnt
            FROM Opportunity
            WHERE CloseDate >= :startDate AND CloseDate < :endDate
            WITH USER_MODE
            GROUP BY LeadSource, IsClosed, IsWon
        ]) {
            LeadSourceData row = new LeadSourceData();
            row.source = (String) ar.get('src');
            row.outcome = toOutcome((Boolean) ar.get('isClosedFlag'), (Boolean) ar.get('isWonFlag'));
            row.amount = toDecimal(ar.get('amt'));
            row.count = (Integer) ar.get('cnt');
            rows.add(row);
        }
        return rows;
    }

    // 수주 금액의 산업 → 거래처 구성 (Treemap용)
    private static List<AccountData> buildAccounts(Date startDate, Date endDate) {
        List<AccountData> rows = new List<AccountData>();
        for (AggregateResult ar : [
            SELECT AccountId accId, Account.Name accName, Account.Industry ind, SUM(Amount) amt, COUNT(Id) cnt
            FROM Opportunity
            WHERE IsWon = true AND CloseDate >= :startDate AND CloseDate < :endDate
            WITH USER_MODE
            GROUP BY AccountId, Account.Name, Account.Industry
            LIMIT :MAX_ACCOUNT_GROUPS
        ]) {
            AccountData row = new AccountData();
            row.accountId = (Id) ar.get('accId');
            row.accountName = (String) ar.get('accName');
            row.industry = (String) ar.get('ind');
            row.amount = toDecimal(ar.get('amt'));
            row.count = (Integer) ar.get('cnt');
            rows.add(row);
        }
        return rows;
    }

    // 일별 수주 금액 (캘린더 히트맵용)
    private static List<DailyData> buildDaily(Date startDate, Date endDate) {
        List<DailyData> rows = new List<DailyData>();
        for (AggregateResult ar : [
            SELECT CloseDate closeDay, SUM(Amount) amt, COUNT(Id) cnt
            FROM Opportunity
            WHERE IsWon = true AND CloseDate >= :startDate AND CloseDate < :endDate
            WITH USER_MODE
            GROUP BY CloseDate
        ]) {
            DailyData row = new DailyData();
            row.day = (Date) ar.get('closeDay');
            row.amount = toDecimal(ar.get('amt'));
            row.count = (Integer) ar.get('cnt');
            rows.add(row);
        }
        return rows;
    }

    // 상세 목록 + Scatter용 개별 딜 (금액 큰 순 MAX_DEALS 건)
    private static List<DealData> buildDeals(Date startDate, Date endDate) {
        List<DealData> rows = new List<DealData>();
        for (Opportunity o : [
            SELECT Id, Name, AccountId, Account.Name, Account.Industry, StageName, Amount, Probability,
                   CloseDate, IsClosed, IsWon, LeadSource
            FROM Opportunity
            WHERE CloseDate >= :startDate AND CloseDate < :endDate
            WITH USER_MODE
            ORDER BY Amount DESC NULLS LAST
            LIMIT :MAX_DEALS
        ]) {
            DealData row = new DealData();
            row.id = o.Id;
            row.name = o.Name;
            row.accountId = o.AccountId;
            row.accountName = o.Account?.Name;
            row.industry = o.Account?.Industry;
            row.stage = o.StageName;
            row.amount = o.Amount;
            row.probability = o.Probability;
            row.closeDate = o.CloseDate;
            row.status = toOutcome(o.IsClosed, o.IsWon);
            row.leadSource = o.LeadSource;
            rows.add(row);
        }
        return rows;
    }

    private static String toOutcome(Boolean isClosed, Boolean isWon) {
        if (isClosed != true) {
            return 'OPEN';
        }
        return isWon == true ? 'WON' : 'LOST';
    }

    private static Decimal toDecimal(Object value) {
        return value == null ? 0 : (Decimal) value;
    }

    private static AuraHandledException newUserError(String message) {
        AuraHandledException ex = new AuraHandledException(message);
        ex.setMessage(message); // Apex 테스트에서 getMessage()로 검증할 수 있도록
        return ex;
    }

    // ===== 화면 전달용 DTO =====
    public class DashboardData {
        @AuraEnabled public Integer year;
        @AuraEnabled public List<MonthData> months;
        @AuraEnabled public List<StageData> stages;
        @AuraEnabled public List<LeadSourceData> leadSources;
        @AuraEnabled public List<AccountData> accounts;
        @AuraEnabled public List<DailyData> daily;
        @AuraEnabled public List<DealData> deals;
        @AuraEnabled public Boolean truncated;
    }

    public class MonthData {
        @AuraEnabled public Integer month;
        @AuraEnabled public Decimal wonAmount = 0;
        @AuraEnabled public Decimal lostAmount = 0;
        @AuraEnabled public Decimal openAmount = 0;
        @AuraEnabled public Integer wonCount = 0;
        @AuraEnabled public Integer lostCount = 0;
        @AuraEnabled public Integer openCount = 0;

        public MonthData(Integer month) {
            this.month = month;
        }
    }

    public class StageData {
        @AuraEnabled public String apiName;
        @AuraEnabled public String label;
        @AuraEnabled public Decimal amount = 0;
        @AuraEnabled public Integer count = 0;

        public StageData(String apiName, String label) {
            this.apiName = apiName;
            this.label = label;
        }
    }

    public class LeadSourceData {
        @AuraEnabled public String source;
        @AuraEnabled public String outcome;
        @AuraEnabled public Decimal amount;
        @AuraEnabled public Integer count;
    }

    public class AccountData {
        @AuraEnabled public Id accountId;
        @AuraEnabled public String accountName;
        @AuraEnabled public String industry;
        @AuraEnabled public Decimal amount;
        @AuraEnabled public Integer count;
    }

    public class DailyData {
        @AuraEnabled public Date day;
        @AuraEnabled public Decimal amount;
        @AuraEnabled public Integer count;
    }

    public class DealData {
        @AuraEnabled public Id id;
        @AuraEnabled public String name;
        @AuraEnabled public Id accountId;
        @AuraEnabled public String accountName;
        @AuraEnabled public String industry;
        @AuraEnabled public String stage;
        @AuraEnabled public Decimal amount;
        @AuraEnabled public Decimal probability;
        @AuraEnabled public Date closeDate;
        @AuraEnabled public String status;
        @AuraEnabled public String leadSource;
    }
}
