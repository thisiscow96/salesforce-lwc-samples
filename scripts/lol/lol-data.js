/*
 * LoL 팀 조합 분석기 초기 데이터 (Custom Metadata 레코드 생성용 원본)
 * - 배포 후에는 Setup > Custom Metadata Types에서 수정한 값이 기준이 된다. 이 파일은 초기 적재/재생성용.
 * - 메타 통계: Patch 26.20 (2026-10-18 갱신)
 *     MOBA Trainer (Emerald+)  https://www.mobatrainer.com/lol/tier-list
 *     metabot.gg (All ranks)   https://metabot.gg/en/league/champions/tier-list/top-lane
 *     SeeMeta                  https://seemeta.com/ko/lol/vi/jungle
 *     Zaahen 특성               https://www.esports.net/wiki/guides/lol-zaahen-guide/
 * - 능력치(CC, 탱킹, 후반 등 0~10)는 스킬 구성 기준의 정성 평가. 표본이 없는 챔피언은 Meta_Score 5~5.5(보수적)
 */
const MT = 'MOBA Trainer 26.20 Emerald+';
const MB = 'metabot.gg 26.20 All ranks';
const NONE = '26.20 통계 미집계 (표본 부족) → 보수적 점수';

// tier → 메타 점수 (S+ 10 … D 5)
const TIER_SCORE = { 'S+': 10, S: 9, A: 8, B: 7, C: 6, D: 5, '-': 5.5 };

// [key, 한글명, 영문명, lane, class, dmg, tier, winRate, cc, front, damage, late, early, engage, peel, carry, difficulty, note, source]
const CHAMPIONS = [
    // TOP: 탱커 선호, 브루저 일부 가능
    ['Sion', '사이온', 'Sion', 'TOP', 'Tank', 'AD', 'C', 50.1, 8, 9, 4, 7, 5, 9, 5, 3, 5, 'R 돌진 이니시 + Q 넉업, 후반 체력 스택 탱커', MB],
    ['Ornn', '오른', 'Ornn', 'TOP', 'Tank', 'Mixed', 'S', 53.3, 9, 9, 4, 9, 6, 8, 6, 3, 5, '아군 아이템 업그레이드로 후반 팀 전체 강화, R 광역 넉업', MT],
    ['Shen', '쉔', 'Shen', 'TOP', 'Tank', 'Mixed', 'A', 52.7, 6, 8, 4, 6, 6, 6, 9, 3, 5, 'R 글로벌 보호막으로 캐리 보호, E 도발', MT],
    ['Malphite', '말파이트', 'Malphite', 'TOP', 'Tank', 'AP', 'S+', 53.6, 8, 9, 5, 7, 4, 10, 5, 3, 3, 'R 광역 넉업 이니시, 상대 AD 위주일수록 강함', MT],
    ['Mordekaiser', '모데카이저', 'Mordekaiser', 'TOP', 'Bruiser', 'AP', 'S', 52.8, 4, 6, 8, 7, 6, 5, 4, 7, 4, 'R로 적 핵심 캐리를 격리해 1:1', MT],
    ['Zaahen', '자헨', 'Zaahen', 'TOP', 'Bruiser', 'AD', 'B', 51.9, 6, 6, 7, 7, 5, 6, 4, 6, 6, '부활·지속 전투 브루저, 다중 CC. 카이팅·고CC 조합에 약함', MT],
    ['Renekton', '레넥톤', 'Renekton', 'TOP', 'Bruiser', 'AD', 'C', 51.3, 5, 6, 7, 4, 9, 6, 3, 5, 5, '초반 라인전 최강급, 후반 영향력 감소', MT],
    ['Nasus', '나서스', 'Nasus', 'TOP', 'Bruiser', 'AD', 'A', 52.0, 4, 7, 7, 9, 3, 3, 6, 6, 3, 'Q 스택 후반 스케일, W 시듦으로 적 원딜 무력화', MT],
    ['Olaf', '올라프', 'Olaf', 'TOP', 'Bruiser', 'AD', 'A', 52.4, 3, 6, 8, 4, 8, 7, 2, 6, 3, 'R 사용 중 CC 면역 돌진, 초중반 교전 강함', MT],
    ['DrMundo', '문도', 'Dr. Mundo', 'TOP', 'Tank', 'AD', 'B', 51.9, 2, 10, 5, 8, 4, 4, 3, 4, 2, '후반 체력 탱킹 최상, CC 부족', MT],
    ['Maokai', '마오카이', 'Maokai', 'TOP', 'Tank', 'AP', '-', null, 9, 8, 3, 6, 6, 8, 8, 2, 3, 'W 지정 속박 + R 광역 속박', NONE],
    ['Singed', '신지드', 'Singed', 'TOP', 'Tank', 'AP', 'S', 53.3, 6, 7, 6, 6, 5, 5, 6, 4, 6, 'E 던지기로 진형 붕괴, 프록시 운영', MT],
    ['Chogath', '초가스', "Cho'Gath", 'TOP', 'Tank', 'AP', 'A', 52.1, 8, 9, 6, 8, 5, 6, 7, 4, 3, 'Q 넉업 + W 침묵, R 스택으로 후반 체력', MT],
    // JUNGLE: 탱커 위주
    ['Chogath', '초가스', "Cho'Gath", 'JUNGLE', 'Tank', 'AP', 'S+', 53.5, 8, 9, 6, 8, 5, 6, 7, 4, 3, 'Q 넉업 + W 침묵, 26.20 정글 S+ 상승', MT],
    ['Sejuani', '세주아니', 'Sejuani', 'JUNGLE', 'Tank', 'AP', 'S', 53.5, 9, 9, 4, 7, 6, 9, 6, 3, 4, '아군 근접 챔피언 공격이 서리 스택을 쌓아 기절 연계, R 광역 기절', MT],
    ['Wukong', '오공', 'Wukong', 'JUNGLE', 'Bruiser', 'AD', 'S+', 54.0, 7, 6, 7, 6, 6, 8, 4, 6, 5, 'R 광역 넉업 2회 이니시, 26.20 정글 최상위', MT],
    ['JarvanIV', '자르반', 'Jarvan IV', 'JUNGLE', 'Bruiser', 'AD', 'C', 51.0, 8, 6, 6, 4, 8, 9, 4, 5, 5, 'EQ 넉업 + R 지형으로 적을 가둬 광역기 연계', MT],
    ['Poppy', '뽀삐', 'Poppy', 'JUNGLE', 'Tank', 'AD', '-', null, 8, 8, 4, 6, 6, 6, 9, 3, 5, 'W 돌진 차단으로 캐리 보호, E 벽꿍 기절', NONE],
    ['Vi', '바이', 'Vi', 'JUNGLE', 'Bruiser', 'AD', 'C', 50.4, 7, 5, 7, 4, 8, 8, 3, 6, 4, 'R 지정 제압으로 적 핵심 딜러 고정 (SeeMeta 전 티어 기준 S+ 52.6%)', MT],
    // MID: 캐리 라인 (M500)
    ['Aurora', '오로라', 'Aurora', 'MID', 'Mage', 'AP', 'B', 52.4, 6, 1, 8, 7, 6, 4, 4, 8, 7, 'R 영역으로 적을 가두고 기동성 높은 메이지', MT],
    ['Zoe', '조이', 'Zoe', 'MID', 'Mage', 'AP', 'B', 52.3, 6, 1, 9, 6, 7, 2, 3, 8, 8, 'E 수면 + Q 장거리 폭딜 픽메이커', MT],
    ['Hwei', '흐웨이', 'Hwei', 'MID', 'Mage', 'AP', 'B', 52.5, 8, 1, 8, 8, 5, 3, 6, 8, 8, '광역 공포·속박 등 다양한 CC, 장거리 한타', MT],
    ['Irelia', '이렐리아', 'Irelia', 'MID', 'Skirmisher', 'AD', 'C', 50.3, 5, 4, 8, 7, 7, 6, 2, 8, 9, 'Q 리셋 돌진 근접 캐리, E 기절', MT],
    ['Yone', '요네', 'Yone', 'MID', 'Skirmisher', 'Mixed', 'A', 52.4, 6, 3, 9, 9, 5, 7, 2, 9, 8, 'R 광역 넉업 돌진, 후반 하이퍼캐리 근접 딜러', MT],
    ['LeBlanc', '르블랑', 'LeBlanc', 'MID', 'Assassin', 'AP', 'A', 52.3, 4, 1, 9, 4, 9, 3, 2, 8, 9, '초중반 순간 폭딜 암살, 후반 영향력 감소', MT],
    ['Ahri', '아리', 'Ahri', 'MID', 'Mage', 'AP', 'S', 53.0, 6, 2, 8, 6, 7, 5, 5, 7, 5, 'E 매혹 픽, R 3회 돌진 기동성', MT],
    // ADC: 캐리 라인 (M500)
    ['Jinx', '징크스', 'Jinx', 'ADC', 'Marksman', 'AD', 'S+', 54.1, 4, 0, 10, 10, 4, 0, 3, 10, 5, '처치 관여 시 리셋, 후반 최고 하이퍼캐리 (보호 필요)', MT],
    ['Tristana', '트리스타나', 'Tristana', 'ADC', 'Marksman', 'AD', 'A', 52.9, 3, 0, 9, 9, 6, 2, 4, 9, 5, '레벨당 사거리 증가로 후반 강함, W 리셋 자기 보호', MT],
    ['Kaisa', '카이사', "Kai'Sa", 'ADC', 'Marksman', 'Mixed', 'B', 51.4, 1, 0, 9, 8, 5, 4, 2, 9, 7, '아군의 이동 불가 CC가 패시브 스택을 쌓음 → CC 많은 조합과 시너지', MT],
    ['Xayah', '자야', 'Xayah', 'ADC', 'Marksman', 'AD', 'A', 53.3, 4, 0, 8, 8, 5, 0, 4, 8, 6, 'E 속박, R 지정 불가로 자기 보호', MT],
    ['Caitlyn', '케이틀린', 'Caitlyn', 'ADC', 'Marksman', 'AD', 'B', 51.2, 4, 0, 8, 6, 8, 0, 3, 7, 5, '긴 사거리 라인전, 덫 + 속박 서폿 연계', MT],
    ['Jhin', '진', 'Jhin', 'ADC', 'Marksman', 'AD', 'C', 51.4, 5, 0, 8, 6, 6, 0, 3, 7, 6, 'W가 아군 CC에 맞은 적을 속박 → CC 연계형', MT],
    ['Yunara', '유나라', 'Yunara', 'ADC', 'Marksman', 'AD', 'C', 51.0, 1, 0, 9, 9, 4, 0, 2, 9, 6, '후반 지속 딜 하이퍼캐리', MT],
    ['Kalista', '칼리스타', 'Kalista', 'ADC', 'Marksman', 'AD', 'C', 50.7, 3, 0, 7, 5, 8, 4, 4, 7, 9, 'R로 서포터를 던져 이니시 → 이니시형 서폿과 시너지, 인챈터와는 약함', MT],
    ['Lucian', '루시안', 'Lucian', 'ADC', 'Marksman', 'AD', 'C', 50.6, 0, 0, 8, 4, 9, 2, 1, 7, 6, '초반 라인전 강함, 후반 사거리 열세', MT],
    ['Sivir', '시비르', 'Sivir', 'ADC', 'Marksman', 'AD', 'B', 52.2, 0, 0, 8, 8, 5, 5, 4, 7, 3, 'R 팀 이동속도로 교전 개시·이탈, E 주문 방어막', MT],
    ['Ashe', '애쉬', 'Ashe', 'ADC', 'Marksman', 'AD', 'C', 51.2, 7, 0, 7, 7, 5, 6, 6, 6, 3, 'R 장거리 기절 이니시, 지속 둔화', MT],
    // SUPPORT (M0)
    ['Lux', '럭스', 'Lux', 'SUPPORT', 'Mage', 'AP', 'B', 51.9, 7, 0, 7, 6, 6, 4, 6, 5, 4, 'Q 2인 속박 픽, W 보호막', MT],
    ['Soraka', '소라카', 'Soraka', 'SUPPORT', 'Enchanter', 'AP', 'B', 52.3, 4, 0, 2, 7, 5, 0, 7, 3, 3, '지속 회복, R 글로벌 힐, E 침묵', MT],
    ['Yuumi', '유미', 'Yuumi', 'SUPPORT', 'Enchanter', 'AP', 'D', 49.3, 3, 0, 2, 8, 3, 0, 6, 3, 2, '아군에 붙어 회복·버프, 단독 영향력 낮음', MT],
    ['Lulu', '룰루', 'Lulu', 'SUPPORT', 'Enchanter', 'AP', 'B', 51.4, 6, 0, 2, 8, 6, 2, 10, 3, 4, 'W 변이·R 거대화 → 하이퍼캐리 보호 최상', MT],
    ['Karma', '카르마', 'Karma', 'SUPPORT', 'Enchanter', 'AP', 'C', 50.2, 4, 0, 5, 5, 8, 4, 7, 4, 5, '라인전 견제, E 팀 보호막·이속', MT],
    ['Seraphine', '세라핀', 'Seraphine', 'SUPPORT', 'Enchanter', 'AP', 'A', 52.4, 7, 0, 6, 7, 5, 5, 7, 5, 4, 'R 광역 매혹 + E 속박, 아군 CC 연계', MT],
    ['Neeko', '니코', 'Neeko', 'SUPPORT', 'Mage', 'AP', 'C', 50.8, 8, 1, 6, 6, 6, 7, 5, 5, 5, 'R 광역 기절 이니시, E 속박', MT]
];

// [A, B, 점수(-4~+5), 근거] — 순서 무관
const SYNERGIES = [
    ['Ornn', 'Jinx', 3, '오른의 아이템 업그레이드가 후반 하이퍼캐리 징크스를 추가 강화'],
    ['Ornn', 'Yunara', 3, '오른의 아이템 업그레이드가 후반 지속딜 원딜을 추가 강화'],
    ['Ornn', 'Tristana', 2, '오른의 아이템 업그레이드로 후반 원딜 강화'],
    ['Ornn', 'Kaisa', 2, '오른 R 넉업이 카이사 패시브 스택 + 아이템 업그레이드'],
    ['Shen', 'Jinx', 3, '쉔 R 글로벌 보호막으로 하이퍼캐리 원딜 생존'],
    ['Shen', 'Yunara', 2, '쉔 R 보호막으로 지속딜 원딜 생존'],
    ['Shen', 'Kaisa', 2, '카이사 R 돌진 + 쉔 R 보호막 동시 진입'],
    ['Shen', 'Tristana', 2, '쉔 R 보호막으로 원딜 생존'],
    ['Sejuani', 'Mordekaiser', 3, '세주아니 서리 스택을 근접 아군이 쌓아 기절 연계'],
    ['Sejuani', 'Zaahen', 3, '세주아니 서리 스택을 근접 아군이 쌓아 기절 연계'],
    ['Sejuani', 'Renekton', 2, '세주아니 서리 스택을 근접 아군이 쌓아 기절 연계'],
    ['Sejuani', 'Nasus', 2, '세주아니 서리 스택을 근접 아군이 쌓아 기절 연계'],
    ['Sejuani', 'Olaf', 2, '세주아니 서리 스택을 근접 아군이 쌓아 기절 연계'],
    ['Sejuani', 'Yone', 3, '근접 캐리 요네가 서리 스택을 쌓아 기절 연계, R 동시 진입'],
    ['Sejuani', 'Irelia', 3, '근접 캐리 이렐리아가 서리 스택을 쌓아 기절 연계'],
    ['Sejuani', 'Hwei', 2, '세주아니 광역 기절 위에 흐웨이 광역 CC·딜 연계'],
    ['Malphite', 'Yone', 3, '말파이트 R 광역 넉업 → 요네 R 광역 진입'],
    ['Malphite', 'Hwei', 2, '말파이트 R로 뭉친 적에게 흐웨이 광역기'],
    ['Malphite', 'Aurora', 2, '말파이트 R 이후 오로라 R 영역으로 퇴로 차단'],
    ['Malphite', 'Seraphine', 2, '말파이트 R → 세라핀 R 광역 매혹 연쇄'],
    ['Malphite', 'Neeko', 2, '말파이트 R → 니코 R 광역 기절 연쇄'],
    ['Malphite', 'Wukong', 2, '광역 넉업 2중 이니시'],
    ['Malphite', 'Kaisa', 2, '광역 넉업이 카이사 패시브 스택'],
    ['Wukong', 'Yone', 2, '오공 R 광역 넉업 → 요네 진입'],
    ['Wukong', 'Seraphine', 2, '오공 R → 세라핀 R 연쇄 CC'],
    ['Wukong', 'Neeko', 2, '오공 R → 니코 R 연쇄 CC'],
    ['Wukong', 'Hwei', 2, '오공 R로 뭉친 적에게 흐웨이 광역기'],
    ['Wukong', 'Sivir', 2, '시비르 R 이속으로 오공 이니시에 동시 진입'],
    ['JarvanIV', 'Aurora', 3, '자르반 R 지형에 갇힌 적에게 오로라 R'],
    ['JarvanIV', 'Hwei', 2, '자르반 R 지형 안 적에게 흐웨이 광역기'],
    ['JarvanIV', 'Seraphine', 2, '자르반 R → 세라핀 R 연쇄 CC'],
    ['JarvanIV', 'Neeko', 2, '자르반 R → 니코 R 연쇄 CC'],
    ['JarvanIV', 'Yone', 2, '자르반 R로 가둔 적에게 요네 R'],
    ['JarvanIV', 'Ashe', 2, '애쉬 R 장거리 기절 → 자르반 진입'],
    ['Vi', 'Ahri', 2, '바이 R 고정 → 아리 매혹·폭딜로 픽'],
    ['Vi', 'Zoe', 2, '바이 R 고정 → 조이 수면·폭딜로 픽'],
    ['Vi', 'LeBlanc', 2, '초중반 다이브·암살 연계'],
    ['Vi', 'Kaisa', 2, '바이 R 제압이 카이사 패시브 스택, 동시 다이브'],
    ['Vi', 'Ashe', 2, '애쉬 R → 바이 R 장거리 픽'],
    ['Chogath', 'Kaisa', 2, '초가스 Q 넉업·W 침묵이 카이사 패시브 스택'],
    ['Maokai', 'Kaisa', 2, '마오카이 속박이 카이사 패시브 스택'],
    ['Maokai', 'Jhin', 2, '마오카이 속박 → 진 W 연계 속박'],
    ['Poppy', 'Jinx', 2, '뽀삐 W 돌진 차단으로 징크스 보호'],
    ['Poppy', 'Yunara', 2, '뽀삐 W 돌진 차단으로 지속딜 원딜 보호'],
    ['Sejuani', 'Kaisa', 2, '세주아니 기절이 카이사 패시브 스택'],
    ['Lux', 'Kaisa', 2, '럭스 속박이 카이사 패시브 스택'],
    ['Neeko', 'Kaisa', 2, '니코 속박·기절이 카이사 패시브 스택'],
    ['Lux', 'Jhin', 2, '럭스 속박 → 진 W 연계'],
    ['Neeko', 'Jhin', 2, '니코 CC → 진 W 연계'],
    ['Seraphine', 'Jhin', 2, '세라핀 CC → 진 W 연계'],
    ['Lux', 'Caitlyn', 3, '럭스 속박 위 덫 → 확정 헤드샷 (라인전 킬각)'],
    ['Neeko', 'Caitlyn', 2, '니코 속박 위 덫 연계'],
    ['Karma', 'Caitlyn', 1, '라인전 견제 듀오'],
    ['Karma', 'Lucian', 2, '초반 공격적 라인전 듀오'],
    ['Lulu', 'Jinx', 3, '룰루 보호·공속 버프로 하이퍼캐리 극대화'],
    ['Lulu', 'Yunara', 3, '룰루 보호·공속 버프로 지속딜 원딜 극대화'],
    ['Lulu', 'Kaisa', 2, '룰루 버프 + R 거대화로 카이사 진입 보조'],
    ['Lulu', 'Xayah', 2, '룰루 보호로 자야 후반 캐리'],
    ['Lulu', 'Tristana', 2, '룰루 보호로 트리스타나 후반 캐리'],
    ['Yuumi', 'Jinx', 2, '유미 회복·버프로 징크스 후반 캐리'],
    ['Yuumi', 'Yunara', 2, '유미 회복·버프로 지속딜 원딜 캐리'],
    ['Soraka', 'Jinx', 2, '소라카 지속 회복으로 장기전 → 하이퍼캐리 유리'],
    ['Soraka', 'Yunara', 2, '소라카 지속 회복으로 장기전'],
    ['Seraphine', 'Sivir', 2, '시비르 R 이속 + 세라핀 R로 한타 개시'],
    ['Kalista', 'Yuumi', -3, '칼리스타 R 이니시를 활용할 수 없는 서포터'],
    ['Kalista', 'Soraka', -2, '칼리스타 R 이니시를 활용하기 어려운 서포터'],
    ['Kalista', 'Lulu', -1, '칼리스타 R 이니시 활용도 낮음'],
    ['Kalista', 'Neeko', 2, '칼리스타 R로 니코를 던져 광역 기절'],
    ['Yuumi', 'Irelia', -1, '근접 캐리가 아닌 원딜을 버프해야 하는 서폿 특성상 분산'],
    ['LeBlanc', 'Yunara', -1, '초반 주도 미드와 후반형 원딜의 템포 불일치'],
    ['Renekton', 'Yunara', -1, '초반형 탑과 후반형 원딜의 템포 불일치']
];

// 점수 카테고리 (합 100). 비율 계산식은 LWC lolScoring.js
const WEIGHTS = [
    ['META', '메타 강도', 10, 1, '5개 픽의 26.20 메타 점수 평균'],
    ['LATE', '후반 캐리력', 15, 2, '라인별 가중(미드·원딜 중심) 후반 지수'],
    ['CC', 'CC (탑·정글 중심)', 15, 3, '탑+정글 CC 합 2/3 + 팀 전체 CC 1/3'],
    ['STRUCTURE', '앞라인 구조', 15, 4, '탑·정글 1탱+1브루저 = 만점, 2탱 절반, 2브루저/없음 감점'],
    ['BALANCE', 'AD/AP 밸런스', 10, 5, '딜 가중 AP 비중 30~60% 만점'],
    ['TEAMFIGHT', '이니시·보호', 10, 6, '최고 이니시 능력 + 탑·정글·서폿 보호 능력'],
    ['SYNERGY', '챔피언 시너지', 15, 7, '시너지 표의 쌍별 점수 합 (중립 6점, +1당 +0.75점, 최대 15)'],
    ['SKILL', '실력 적합도', 10, 8, '라인 실력 대비 난이도 + 캐리 라인 캐리력/서브 라인 팀플레이']
];

// 실력(티어) → 숙련도 1~10
const TIERS = [
    ['IRON', '아이언', 1], ['BRONZE', '브론즈', 2], ['SILVER', '실버', 3], ['GOLD', '골드', 4],
    ['PLATINUM', '플래티넘', 5], ['EMERALD_LOW', '에메랄드 하위', 6], ['EMERALD_HIGH', '에메랄드 상위', 6.5],
    ['DIAMOND_LOW', '다이아 하위', 7], ['DIAMOND_HIGH', '다이아 상위', 7.5], ['MASTER_0', '마스터 0LP', 8],
    ['MASTER_500', '마스터 500LP', 8.7], ['GRANDMASTER', '그랜드마스터', 9.3], ['CHALLENGER', '챌린저', 10]
];

const TEAM_GOAL = [
    '미드·원딜이 캐리 라인(마스터 500LP), 탑(에메랄드 하위)·정글(다이아 하위)이 CC와 앞라인 담당, 서폿 마스터 0LP.',
    '탑·정글은 2탱이 아닌 1탱 + 1브루저 구조를 선호.',
    '후반을 챙길 수 있는 조합을 목표로 한다.'
].join(' ');

module.exports = { CHAMPIONS, SYNERGIES, WEIGHTS, TIERS, TIER_SCORE, TEAM_GOAL };
