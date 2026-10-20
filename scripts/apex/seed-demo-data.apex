// Sales Dashboard 확인용 데모 데이터 생성 (작년 + 올해 Opportunity 약 700건, Account 15건)
// - 모든 레코드 이름이 '[DEMO]'로 시작 → scripts/apex/delete-demo-data.apex로 일괄 삭제
// - 단계명은 OpportunityStage에서 조회 (org별 단계 설정에 맞춤)
// 실행: sf apex run --file scripts/apex/seed-demo-data.apex --target-org chartjs-dev

Integer rnd(Integer bound) {
    return Math.floor(Math.random() * bound).intValue();
}

Integer existing = [SELECT COUNT() FROM Opportunity WHERE Name LIKE '[DEMO]%'];
if (existing > 0) {
    System.debug(LoggingLevel.WARN, '이미 데모 데이터가 ' + existing + '건 있습니다. delete-demo-data.apex 실행 후 다시 시도하세요.');
} else {
    List<OpportunityStage> openStages = [
        SELECT ApiName FROM OpportunityStage WHERE IsActive = true AND IsClosed = false ORDER BY SortOrder
    ];
    String wonStage = [SELECT ApiName FROM OpportunityStage WHERE IsActive = true AND IsWon = true ORDER BY SortOrder LIMIT 1].ApiName;
    String lostStage = [SELECT ApiName FROM OpportunityStage WHERE IsActive = true AND IsClosed = true AND IsWon = false ORDER BY SortOrder LIMIT 1].ApiName;

    List<String> industries = new List<String>{ 'Technology', 'Manufacturing', 'Finance', 'Retail', 'Healthcare', 'Energy', 'Telecommunications' };
    List<String> names = new List<String>{
        'Hanbit Tech', 'Daehan Motors', 'Saebyeol Bank', 'Mirae Retail', 'Hanul Pharma',
        'Green Energy', 'Nuri Telecom', 'Bitsoft', 'Kosmo Steel', 'Seoul Capital',
        'Sunrise Mart', 'Medi Care', 'Solar Power', 'Link Mobile', 'Data Forge'
    };
    List<Account> accounts = new List<Account>();
    for (Integer i = 0; i < names.size(); i++) {
        accounts.add(new Account(Name = '[DEMO] ' + names[i], Industry = industries[Math.mod(i, industries.size())]));
    }
    insert accounts;

    // 유입 경로 가중치: Web이 가장 많고 Partner Referral은 적지만 승률이 높게
    List<String> sources = new List<String>{ 'Web', 'Web', 'Web', 'Phone Inquiry', 'Phone Inquiry', 'Partner Referral', 'Purchased List', 'Other', null };

    Date today = Date.today();
    Integer thisYear = today.year();
    List<Opportunity> opps = new List<Opportunity>();
    Integer seq = 0;
    for (Integer y = thisYear - 1; y <= thisYear; y++) {
        for (Integer m = 1; m <= 12; m++) {
            Integer perMonth = 18 + rnd(12) + (y == thisYear ? 6 : 0);
            for (Integer k = 0; k < perMonth; k++) {
                Date closeDate = Date.newInstance(y, m, 1 + rnd(28));
                // 금액: 소액 딜이 많고 대형 딜은 드물게 (제곱 분포)
                Decimal amount = Math.roundToLong((5000 + Math.pow(Math.random(), 2.0d) * 145000) / 1000) * 1000;
                String source = sources[rnd(sources.size())];
                Account acc = accounts[Math.mod(rnd(names.size()) + rnd(4), names.size())];
                String stage;
                if (closeDate < today) {
                    // 월별 승률을 조금씩 다르게 (계절성) + 파트너 소개는 승률 가산
                    Double winRate = 0.45 + 0.15 * Math.sin(m / 2.0d) + (source == 'Partner Referral' ? 0.2 : 0);
                    stage = Math.random() < winRate ? wonStage : lostStage;
                    if (Math.random() < 0.05) {
                        stage = openStages[rnd(openStages.size())].ApiName; // 마감일이 지난 지연 딜
                    }
                } else {
                    // 앞 단계일수록 많게 → 퍼널 모양
                    stage = openStages[Math.floor(Math.pow(Math.random(), 1.6d) * openStages.size()).intValue()].ApiName;
                }
                seq++;
                opps.add(new Opportunity(
                    Name = '[DEMO] ' + acc.Name.removeStart('[DEMO] ') + ' - Deal ' + seq,
                    AccountId = acc.Id,
                    StageName = stage,
                    CloseDate = closeDate,
                    Amount = amount,
                    LeadSource = source,
                    Description = 'Sales Dashboard demo data'
                ));
            }
        }
    }
    insert opps;
    System.debug(LoggingLevel.INFO, '데모 데이터 생성 완료: Account ' + accounts.size() + '건, Opportunity ' + opps.size() + '건');
}
