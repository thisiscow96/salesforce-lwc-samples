// 배포되는 Custom Metadata와 같은 원본(scripts/lol/lol-data.js)으로 Apex 응답 형태를 만든다 → 실제 데이터로 로직 검증
const D = require('../../../../../../../scripts/lol/lol-data.js');
const { championRecords } = require('../../../../../../../scripts/lol/champion-records.js');

function builderData(mode = 'CLAUDE_CODE', canRequestAnalysis = true, isGuest = false) {
    return {
        // 배포되는 전체 챔피언 레코드(선호 픽 + 전체 통계)와 동일
        champions: championRecords().map((r) => ({ DeveloperName: r.developerName, MasterLabel: r.label, ...r.fields })),
        synergies: D.SYNERGIES.map((s) => ({ Champion_A__c: s[0], Champion_B__c: s[1], Score__c: s[2], Reason__c: s[3] })),
        weights: D.WEIGHTS.map((w) => ({ DeveloperName: w[0], MasterLabel: w[1], Max_Points__c: w[2], Sort_Order__c: w[3], Description__c: w[4] })),
        tiers: D.TIERS.map((t, i) => ({ DeveloperName: t[0], MasterLabel: t[1], Skill__c: t[2], Sort_Order__c: i + 1 })),
        model: 'claude-sonnet-5-5',
        ddragonVersion: '16.20.1',
        mode,
        canRequestAnalysis,
        isGuest,
        guestApiPath: isGuest ? '/lolvforcesite/services/apexrest/lol/guest/requests' : null,
        guestIpLimit: 5,
        guestIpWindowMinutes: 10
    };
}

module.exports = { builderData };
