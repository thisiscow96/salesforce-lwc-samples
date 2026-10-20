// 배포되는 Custom Metadata와 같은 원본(scripts/lol/lol-data.js)으로 Apex 응답 형태를 만든다 → 실제 데이터로 로직 검증
const D = require('../../../../../../../scripts/lol/lol-data.js');

function builderData(mode = 'CLAUDE_CODE', canRequestAnalysis = true, isGuest = false) {
    const suffix = { TOP: 'Top', JUNGLE: 'Jungle', MID: 'Mid', ADC: 'Adc', SUPPORT: 'Support' };
    return {
        champions: D.CHAMPIONS.map((c, i) => ({
            DeveloperName: `${c[0]}_${suffix[c[3]]}`,
            Champion_Key__c: c[0],
            MasterLabel: c[1],
            English_Name__c: c[2],
            Lane__c: c[3],
            Role_Class__c: c[4],
            Damage_Type__c: c[5],
            Meta_Tier__c: c[6],
            Win_Rate__c: c[7],
            Meta_Score__c: D.TIER_SCORE[c[6]],
            CC__c: c[8],
            Frontline__c: c[9],
            Damage__c: c[10],
            Late_Game__c: c[11],
            Early_Game__c: c[12],
            Engage__c: c[13],
            Peel__c: c[14],
            Carry__c: c[15],
            Difficulty__c: c[16],
            Note__c: c[17],
            Source__c: c[18],
            Sort_Order__c: i + 1
        })),
        synergies: D.SYNERGIES.map((s) => ({ Champion_A__c: s[0], Champion_B__c: s[1], Score__c: s[2], Reason__c: s[3] })),
        weights: D.WEIGHTS.map((w) => ({ DeveloperName: w[0], MasterLabel: w[1], Max_Points__c: w[2], Sort_Order__c: w[3], Description__c: w[4] })),
        tiers: D.TIERS.map((t, i) => ({ DeveloperName: t[0], MasterLabel: t[1], Skill__c: t[2], Sort_Order__c: i + 1 })),
        teamGoal: D.TEAM_GOAL,
        model: 'claude-sonnet-5-5',
        mode,
        canRequestAnalysis,
        isGuest
    };
}

module.exports = { builderData };
