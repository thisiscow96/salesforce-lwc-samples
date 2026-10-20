/**
 * SalesDashboardController 테스트
 * - 200건 Bulk 데이터로 집계 정확성 검증 (수주/실주/진행 = i mod 3 → 67 / 67 / 66건, 건당 1,000)
 * - 다른 연도 데이터 제외, 단계 정렬, LeadSource 미지정 처리, 권한 없는 사용자 오류 처리 검증
 * - 단계명은 OpportunityStage에서 조회해 org별 단계 설정에 의존하지 않음
 */
@IsTest
private class SalesDashboardControllerTest {

    // 실행일과 무관한 결과를 위해 고정 연도 사용 (컨트롤러는 오늘 날짜를 쓰지 않음)
    private static final Integer TEST_YEAR = 2025;
    private static final Integer BULK_SIZE = 200;
    private static final Decimal DEAL_AMOUNT = 1000;

    private static String stageApiName(Boolean isClosed, Boolean isWon) {
        return [
            SELECT ApiName FROM OpportunityStage
            WHERE IsActive = true AND IsClosed = :isClosed AND IsWon = :isWon
            ORDER BY SortOrder LIMIT 1
        ].ApiName;
    }

    @TestSetup
    static void setup() {
        String wonStage = stageApiName(true, true);
        String lostStage = stageApiName(true, false);
        String openStage = stageApiName(false, false);

        List<Account> accounts = new List<Account>{
            new Account(Name = 'Test Acme', Industry = 'Technology'),
            new Account(Name = 'Test Globex', Industry = 'Manufacturing')
        };
        insert accounts;

        List<Opportunity> opps = new List<Opportunity>();
        for (Integer i = 0; i < BULK_SIZE; i++) {
            Integer bucket = Math.mod(i, 3);
            opps.add(new Opportunity(
                Name = 'Test Opp ' + i,
                AccountId = accounts[Math.mod(i, 2)].Id,
                StageName = bucket == 0 ? wonStage : (bucket == 1 ? lostStage : openStage),
                CloseDate = Date.newInstance(TEST_YEAR, Math.mod(i, 12) + 1, 10),
                Amount = DEAL_AMOUNT,
                LeadSource = Math.mod(i, 2) == 0 ? 'Web' : null
            ));
        }
        // 다른 연도 데이터: 집계에서 제외되어야 함
        opps.add(new Opportunity(Name = 'Other Year', StageName = wonStage,
            CloseDate = Date.newInstance(TEST_YEAR - 1, 12, 31), Amount = 999999));
        insert opps;
    }

    @IsTest
    static void aggregatesMonthsByOutcomeAndExcludesOtherYears() {
        Test.startTest();
        SalesDashboardController.DashboardData data = SalesDashboardController.getDashboardData(TEST_YEAR);
        Test.stopTest();

        Assert.areEqual(12, data.months.size(), '1~12월이 모두 채워져야 함');
        Decimal won = 0;
        Integer wonCount = 0;
        Integer lostCount = 0;
        Integer openCount = 0;
        for (SalesDashboardController.MonthData m : data.months) {
            won += m.wonAmount;
            wonCount += m.wonCount;
            lostCount += m.lostCount;
            openCount += m.openCount;
        }
        Assert.areEqual(67, wonCount, '수주 건수');
        Assert.areEqual(67, lostCount, '실주 건수');
        Assert.areEqual(66, openCount, '진행 중 건수');
        Assert.areEqual(67 * DEAL_AMOUNT, won, '다른 연도(999,999)가 섞이면 금액이 달라짐');
        Assert.areEqual(1, data.months[0].month, '첫 항목은 1월');
    }

    @IsTest
    static void stagesFollowSortOrderAndContainOpenOnly() {
        String openStage = stageApiName(false, false);

        SalesDashboardController.DashboardData data = SalesDashboardController.getDashboardData(TEST_YEAR);

        Assert.isFalse(data.stages.isEmpty(), '진행 중 단계가 있어야 함');
        Assert.areEqual(openStage, data.stages[0].apiName, 'SortOrder가 가장 앞선 단계가 첫 번째');
        Assert.areEqual(66, data.stages[0].count, '진행 중 66건이 첫 단계에 집계');
        for (SalesDashboardController.StageData s : data.stages) {
            Assert.areNotEqual(stageApiName(true, true), s.apiName, '종료 단계는 퍼널에 포함되지 않음');
        }
    }

    @IsTest
    static void leadSourcesKeepNullSourceAndCoverAllDeals() {
        SalesDashboardController.DashboardData data = SalesDashboardController.getDashboardData(TEST_YEAR);

        Integer total = 0;
        Boolean hasNull = false;
        Boolean hasWeb = false;
        for (SalesDashboardController.LeadSourceData row : data.leadSources) {
            total += row.count;
            hasNull = hasNull || row.source == null;
            hasWeb = hasWeb || row.source == 'Web';
            Assert.isTrue(new Set<String>{ 'WON', 'LOST', 'OPEN' }.contains(row.outcome), '결과 코드 형식');
        }
        Assert.areEqual(BULK_SIZE, total, '해당 연도 전체 건수');
        Assert.isTrue(hasNull, 'LeadSource 미지정 건은 source = null로 반환');
        Assert.isTrue(hasWeb, 'Web 소스 포함');
    }

    @IsTest
    static void accountsAndDailyAggregateWonDealsOnly() {
        SalesDashboardController.DashboardData data = SalesDashboardController.getDashboardData(TEST_YEAR);

        Integer accountCount = 0;
        Set<String> industries = new Set<String>();
        for (SalesDashboardController.AccountData row : data.accounts) {
            accountCount += row.count;
            industries.add(row.industry);
        }
        Assert.areEqual(67, accountCount, 'Treemap은 수주 건만 집계');
        Assert.isTrue(industries.contains('Technology') && industries.contains('Manufacturing'), '산업별 그룹');

        Integer dailyCount = 0;
        for (SalesDashboardController.DailyData row : data.daily) {
            dailyCount += row.count;
            Assert.areEqual(TEST_YEAR, row.day.year(), '조회 연도 안의 날짜만');
        }
        Assert.areEqual(67, dailyCount, '캘린더는 수주 건만 집계');
    }

    @IsTest
    static void dealsAreFlattenedAndSortedByAmount() {
        SalesDashboardController.DashboardData data = SalesDashboardController.getDashboardData(TEST_YEAR);

        Assert.areEqual(BULK_SIZE, data.deals.size(), '해당 연도 딜 전체');
        Assert.isFalse(data.truncated, 'MAX_DEALS 미만이면 잘리지 않음');
        SalesDashboardController.DealData first = data.deals[0];
        Assert.isNotNull(first.accountName, 'Account.Name을 평탄화해 전달');
        Assert.isNotNull(first.status, '상태 코드 포함');
    }

    @IsTest
    static void yearWithoutDataReturnsEmptyStructure() {
        SalesDashboardController.DashboardData data = SalesDashboardController.getDashboardData(TEST_YEAR + 5);

        Assert.areEqual(12, data.months.size(), '데이터가 없어도 12개월 구조 유지');
        Assert.areEqual(0, data.months[0].wonAmount, '금액 0');
        Assert.isTrue(data.deals.isEmpty(), '딜 없음');
    }

    @IsTest
    static void nullYearThrowsUserFriendlyError() {
        try {
            SalesDashboardController.getDashboardData(null);
            Assert.fail('연도 없이 호출하면 예외가 나야 함');
        } catch (AuraHandledException e) {
            Assert.areEqual('조회 연도가 지정되지 않았습니다.', e.getMessage(), '사용자용 메시지');
        }
    }

    @IsTest
    static void userWithoutOpportunityAccessGetsFriendlyError() {
        // 'Minimum Access - Salesforce' 프로필은 Opportunity 조회 권한이 없음 → USER_MODE 쿼리가 거부되어야 함
        Profile minimum = [SELECT Id FROM Profile WHERE Name = 'Minimum Access - Salesforce' LIMIT 1];
        User restricted = new User(
            Alias = 'dashmin',
            Email = 'dash.min@example.com',
            Username = 'dash.min.' + System.currentTimeMillis() + '@example.com',
            LastName = 'Restricted',
            ProfileId = minimum.Id,
            EmailEncodingKey = 'UTF-8',
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US',
            TimeZoneSidKey = 'America/Los_Angeles'
        );
        insert restricted;

        System.runAs(restricted) {
            Test.startTest();
            try {
                SalesDashboardController.getDashboardData(TEST_YEAR);
                Assert.fail('권한이 없으면 데이터가 반환되면 안 됨');
            } catch (AuraHandledException e) {
                Assert.isTrue(e.getMessage().contains('권한'), '내부 예외 대신 사용자용 메시지 반환');
            }
            Test.stopTest();
        }
    }
}
