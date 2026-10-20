// 스모크 테스트(Excel 업로드)가 만든 레코드 확인 + 삭제. Account 이름이 '[SMOKE]'로 시작하는 것만 대상
// Account 삭제 시 연결된 Contact도 함께 삭제됨
List<Account> accounts = [SELECT Id, (SELECT Id FROM Contacts) FROM Account WHERE Name LIKE '[SMOKE]%'];
Integer contacts = 0;
for (Account a : accounts) {
    contacts += a.Contacts.size();
}
System.debug(LoggingLevel.ERROR, 'SMOKE_COUNTS accounts=' + accounts.size() + ' contacts=' + contacts);
delete accounts;
