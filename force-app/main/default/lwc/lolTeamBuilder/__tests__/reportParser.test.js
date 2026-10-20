import { parseReport } from '../reportParser';

const SAMPLE = [
    '■ 한줄 평가',
    '- 광역 CC 연계로 한타를 여는 후반 조합',
    '■ 라인별 해야 할 것 / 주의사항',
    '▶ 탑',
    '- 6레벨 이후 R 각 유지',
    '- 주의: 초반 무리한 딜교환 금지',
    '▶ 정글',
    '- 첫 갱은 미드(요네) 3레벨',
    '■ 오브젝트 운영',
    '공허 유충 등장 시간 (확인 필요)',
    '• 첫 드래곤은 바텀 주도권이 있을 때'
].join('\n');

describe('parseReport', () => {
    it('■ 섹션, ▶ 라인 카드, 글머리표를 구조로 나눈다', () => {
        const sections = parseReport(SAMPLE);
        expect(sections.map((s) => s.title)).toEqual(['한줄 평가', '라인별 해야 할 것 / 주의사항', '오브젝트 운영']);

        expect(sections[0].lines).toEqual([expect.objectContaining({ text: '광역 CC 연계로 한타를 여는 후반 조합', cls: 'report-bullet' })]);
        expect(sections[0].hasGroups).toBe(false);

        const lanes = sections[1];
        expect(lanes.hasGroups).toBe(true);
        expect(lanes.groups.map((g) => g.title)).toEqual(['탑', '정글']);
        expect(lanes.groups[0].lines.map((l) => l.text)).toEqual(['6레벨 이후 R 각 유지', '주의: 초반 무리한 딜교환 금지']);

        expect(sections[2].lines.map((l) => [l.text, l.cls])).toEqual([
            ['공허 유충 등장 시간 (확인 필요)', 'report-para'],
            ['첫 드래곤은 바텀 주도권이 있을 때', 'report-bullet']
        ]);
    });

    it('■ 없이 시작하는 본문·빈 값도 안전하게 처리하고 key는 모두 고유하다', () => {
        expect(parseReport('')).toEqual([]);
        expect(parseReport(null)).toEqual([]);
        const plain = parseReport('지난 분석\n<script>alert(1)</script>');
        expect(plain).toHaveLength(1);
        expect(plain[0].title).toBeNull();
        expect(plain[0].lines[1].text).toBe('<script>alert(1)</script>'); // 텍스트로만 렌더링 (HTML 해석 안 함)

        const keys = [];
        parseReport(SAMPLE).forEach((s) => {
            keys.push(s.key);
            s.lines.forEach((l) => keys.push(l.key));
            s.groups.forEach((g) => {
                keys.push(g.key);
                g.lines.forEach((l) => keys.push(l.key));
            });
        });
        expect(new Set(keys).size).toBe(keys.length);
    });
});
