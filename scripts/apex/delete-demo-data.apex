// seed-demo-data.apex로 만든 데모 데이터 삭제 (이름이 '[DEMO]'로 시작하는 레코드만)
// 실행: sf apex run --file scripts/apex/delete-demo-data.apex --target-org chartjs-dev
List<Opportunity> opps = [SELECT Id FROM Opportunity WHERE Name LIKE '[DEMO]%'];
List<Account> accounts = [SELECT Id FROM Account WHERE Name LIKE '[DEMO]%'];
delete opps;
delete accounts;
System.debug(LoggingLevel.INFO, '삭제 완료: Opportunity ' + opps.size() + '건, Account ' + accounts.size() + '건');
