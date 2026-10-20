/*
 * lol-data.js → Custom Metadata Type 정의 + 레코드 XML 생성
 * 사용: node scripts/lol/build-metadata.js   (생성 후 sf project deploy start)
 * 레코드 파일은 매번 다시 쓰므로, Setup에서 직접 수정한 값을 유지하려면 먼저 retrieve 후 lol-data.js에 반영할 것.
 */
const fs = require('fs');
const path = require('path');
const { CHAMPIONS, SYNERGIES, WEIGHTS, TIERS, TIER_SCORE, TEAM_GOAL } = require('./lol-data');

const ROOT = path.join(__dirname, '..', '..', 'force-app', 'main', 'default');
const OBJECTS = path.join(ROOT, 'objects');
const RECORDS = path.join(ROOT, 'customMetadata');

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
}

// ---------- 타입/필드 정의 ----------
const fieldXml = (f) => {
    const common = `    <fullName>${f.name}</fullName>
    <description>${esc(f.description)}</description>
    <externalId>false</externalId>
    <fieldManageability>SubscriberControlled</fieldManageability>
    <label>${esc(f.label)}</label>
`;
    let typeXml;
    if (f.type === 'Text') {
        typeXml = `    <length>${f.length}</length>
    <required>${!!f.required}</required>
    <type>Text</type>
    <unique>false</unique>
`;
    } else if (f.type === 'Number') {
        typeXml = `    <precision>${f.precision}</precision>
    <required>${!!f.required}</required>
    <scale>${f.scale}</scale>
    <type>Number</type>
    <unique>false</unique>
`;
    } else if (f.type === 'LongTextArea') {
        typeXml = `    <length>${f.length}</length>
    <type>LongTextArea</type>
    <visibleLines>5</visibleLines>
`;
    } else if (f.type === 'Picklist') {
        typeXml = `    <required>${!!f.required}</required>
    <type>Picklist</type>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
${f.values
    .map(
        (v) => `            <value>
                <fullName>${v}</fullName>
                <default>false</default>
                <label>${v}</label>
            </value>
`
    )
    .join('')}        </valueSetDefinition>
    </valueSet>
`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
${common}${typeXml}</CustomField>
`;
};

const num = (name, label, description, precision = 3, scale = 0) => ({ name, label, description, type: 'Number', precision, scale });
const text = (name, label, description, length = 255, required = false) => ({ name, label, description, type: 'Text', length, required });

const TYPES = {
    LoL_Champion__mdt: {
        label: 'LoL Champion',
        plural: 'LoL Champions',
        description: '라인별 픽 가능한 챔피언과 능력치(0~10). 같은 챔피언이 여러 라인이면 라인별로 1건',
        fields: [
            text('Champion_Key__c', 'Champion Key', '시너지 매칭용 챔피언 키(라인 무관, 예: Chogath)', 40, true),
            text('English_Name__c', 'English Name', '영문 챔피언명', 40),
            { name: 'Lane__c', label: 'Lane', description: '라인', type: 'Picklist', required: true, values: ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'] },
            { name: 'Role_Class__c', label: 'Role Class', description: '역할군', type: 'Picklist', required: true, values: ['Tank', 'Bruiser', 'Skirmisher', 'Mage', 'Assassin', 'Marksman', 'Enchanter'] },
            { name: 'Damage_Type__c', label: 'Damage Type', description: '주 피해 유형', type: 'Picklist', required: true, values: ['AD', 'AP', 'Mixed'] },
            text('Meta_Tier__c', 'Meta Tier', '현재 패치 티어 (S+~D, - = 미집계)', 5),
            num('Win_Rate__c', 'Win Rate', '현재 패치 승률(%)', 4, 1),
            num('Meta_Score__c', 'Meta Score', '메타 점수 1~10 (티어 환산)', 3, 1),
            num('CC__c', 'CC', '군중 제어 0~10'),
            num('Frontline__c', 'Frontline', '앞라인·탱킹 0~10'),
            num('Damage__c', 'Damage', '딜량 0~10'),
            num('Late_Game__c', 'Late Game', '후반 영향력 0~10'),
            num('Early_Game__c', 'Early Game', '초반 영향력 0~10'),
            num('Engage__c', 'Engage', '이니시에이팅 0~10'),
            num('Peel__c', 'Peel', '아군 보호 0~10'),
            num('Carry__c', 'Carry', '캐리력 0~10'),
            num('Difficulty__c', 'Difficulty', '조작 난이도 0~10'),
            text('Note__c', 'Note', '특징·근거'),
            text('Source__c', 'Source', '통계 출처'),
            num('Sort_Order__c', 'Sort Order', '표시 순서', 4, 0)
        ]
    },
    LoL_Synergy__mdt: {
        label: 'LoL Synergy',
        plural: 'LoL Synergies',
        description: '두 챔피언(Champion Key)이 같은 팀일 때의 시너지 점수(-4~+5)와 근거',
        fields: [
            text('Champion_A__c', 'Champion A', 'Champion Key', 40, true),
            text('Champion_B__c', 'Champion B', 'Champion Key', 40, true),
            num('Score__c', 'Score', '시너지 점수 (-4~+5, 음수 = 상성 나쁨)', 2, 0),
            text('Reason__c', 'Reason', '시너지 근거')
        ]
    },
    LoL_Score_Weight__mdt: {
        label: 'LoL Score Weight',
        plural: 'LoL Score Weights',
        description: '조합 점수 카테고리별 배점 (합계 100 권장)',
        fields: [num('Max_Points__c', 'Max Points', '배점'), num('Sort_Order__c', 'Sort Order', '표시 순서'), text('Description__c', 'Description', '계산 방식')]
    },
    LoL_Tier__mdt: {
        label: 'LoL Tier',
        plural: 'LoL Tiers',
        description: '플레이어 티어 → 숙련도(1~10)',
        fields: [num('Skill__c', 'Skill', '숙련도 1~10', 3, 1), num('Sort_Order__c', 'Sort Order', '표시 순서')]
    },
    LoL_AI_Setting__mdt: {
        label: 'LoL AI Setting',
        plural: 'LoL AI Settings',
        description: 'Claude 실시간 분석 설정 (Default 레코드 사용)',
        fields: [
            { name: 'Mode__c', label: 'Mode', description: 'CLAUDE_CODE = 요청 큐를 로컬 Claude Code가 처리(구독 범위), API = Claude API 직접 호출(크레딧 과금)', type: 'Picklist', required: true, values: ['CLAUDE_CODE', 'API'] },
            text('Model__c', 'Model', 'Claude 모델 ID (API 모드)', 80, true),
            num('Max_Tokens__c', 'Max Tokens', '최대 출력 토큰', 5, 0),
            text('Web_Search_Tool__c', 'Web Search Tool', '웹 검색 도구 타입 (비우면 검색 안 함)', 40),
            num('Web_Search_Max_Uses__c', 'Web Search Max Uses', '요청당 최대 검색 횟수', 2, 0),
            num('Timeout_Seconds__c', 'Timeout Seconds', 'Continuation 타임아웃(최대 120)', 3, 0),
            text('Routine_Fire_Path__c', 'Routine Fire Path', '클라우드 루틴 API 트리거 경로 /v1/claude_code/routines/<id>/fire (비우면 즉시 실행 안 함)', 255),
            { name: 'Team_Goal__c', label: 'Team Goal', description: '팀 성향·목표 (분석 프롬프트에 포함)', type: 'LongTextArea', length: 2000 }
        ]
    }
};

for (const [type, def] of Object.entries(TYPES)) {
    write(
        path.join(OBJECTS, type, `${type}.object-meta.xml`),
        `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>${esc(def.description)}</description>
    <label>${esc(def.label)}</label>
    <pluralLabel>${esc(def.plural)}</pluralLabel>
    <visibility>Public</visibility>
</CustomObject>
`
    );
    def.fields.forEach((f) => write(path.join(OBJECTS, type, 'fields', `${f.name}.field-meta.xml`), fieldXml(f)));
}

// ---------- 레코드 ----------
fs.rmSync(RECORDS, { recursive: true, force: true }); // 삭제된 데이터가 남지 않도록 매번 재생성

function record(type, developerName, label, values) {
    const valueXml = Object.entries(values)
        .map(([field, value]) => {
            if (value === null || value === undefined || value === '') {
                return `    <values>
        <field>${field}</field>
        <value xsi:nil="true"/>
    </values>
`;
            }
            const xsiType = typeof value === 'number' ? 'xsd:double' : 'xsd:string';
            return `    <values>
        <field>${field}</field>
        <value xsi:type="${xsiType}">${esc(value)}</value>
    </values>
`;
        })
        .join('');
    write(
        path.join(RECORDS, `${type.replace('__mdt', '')}.${developerName}.md-meta.xml`),
        `<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <label>${esc(label)}</label>
    <protected>false</protected>
${valueXml}</CustomMetadata>
`
    );
}

const laneSuffix = { TOP: 'Top', JUNGLE: 'Jungle', MID: 'Mid', ADC: 'Adc', SUPPORT: 'Support' };
const keys = new Set();
CHAMPIONS.forEach((c, i) => {
    const [key, ko, en, lane, cls, dmg, tier, wr, cc, front, damage, late, early, engage, peel, carry, diff, note, source] = c;
    keys.add(key);
    record('LoL_Champion__mdt', `${key}_${laneSuffix[lane]}`, ko, {
        Champion_Key__c: key,
        English_Name__c: en,
        Lane__c: lane,
        Role_Class__c: cls,
        Damage_Type__c: dmg,
        Meta_Tier__c: tier,
        Win_Rate__c: wr,
        Meta_Score__c: TIER_SCORE[tier],
        CC__c: cc,
        Frontline__c: front,
        Damage__c: damage,
        Late_Game__c: late,
        Early_Game__c: early,
        Engage__c: engage,
        Peel__c: peel,
        Carry__c: carry,
        Difficulty__c: diff,
        Note__c: note,
        Source__c: source,
        Sort_Order__c: i + 1
    });
});

const seen = new Set();
SYNERGIES.forEach(([a, b, score, reason]) => {
    [a, b].forEach((k) => {
        if (!keys.has(k)) throw new Error(`시너지에 없는 챔피언 키: ${k}`);
    });
    const name = [a, b].sort().join('_');
    if (seen.has(name)) throw new Error(`시너지 중복: ${name}`);
    seen.add(name);
    record('LoL_Synergy__mdt', name, `${a} + ${b}`.slice(0, 40), { Champion_A__c: a, Champion_B__c: b, Score__c: score, Reason__c: reason });
});

WEIGHTS.forEach(([name, label, points, order, description]) =>
    record('LoL_Score_Weight__mdt', name, label, { Max_Points__c: points, Sort_Order__c: order, Description__c: description })
);
TIERS.forEach(([name, label, skill], i) => record('LoL_Tier__mdt', name, label, { Skill__c: skill, Sort_Order__c: i + 1 }));
record('LoL_AI_Setting__mdt', 'Default', 'Default', {
    Mode__c: 'CLAUDE_CODE',
    Model__c: 'claude-sonnet-5-5',
    Max_Tokens__c: 3000,
    Web_Search_Tool__c: 'web_search_20250305',
    Web_Search_Max_Uses__c: 3,
    Timeout_Seconds__c: 120,
    Routine_Fire_Path__c: '/v1/claude_code/routines/trig_016zhLGx3x9QL1KiPxuV8KQm/fire',
    Team_Goal__c: TEAM_GOAL
});

console.log(`챔피언 ${CHAMPIONS.length}, 시너지 ${SYNERGIES.length}, 배점 ${WEIGHTS.length}, 티어 ${TIERS.length}, AI 설정 1 생성`);
