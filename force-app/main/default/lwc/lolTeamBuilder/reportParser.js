// Claude 분석 리포트 텍스트 파서 (순수 함수, Jest로 단독 검증)

/**
 * 분석 본문(텍스트) → 화면 구조. 형식: "■ 섹션", "▶ 소제목"(라인·시간대), "- 글머리표".
 * HTML로 해석하지 않고 텍스트로만 렌더링하므로 본문에 태그가 섞여도 안전.
 */
export function parseReport(text) {
    const sections = [];
    let section = null;
    let group = null;
    let n = 0;
    const ensureSection = () => {
        if (!section) {
            section = { key: `s${n++}`, title: null, lines: [], groups: [] };
            sections.push(section);
        }
        return section;
    };
    String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
            if (line.startsWith('■')) {
                section = { key: `s${n++}`, title: line.replace(/^■\s*/, ''), lines: [], groups: [] };
                sections.push(section);
                group = null;
            } else if (line.startsWith('▶')) {
                group = { key: `g${n++}`, title: line.replace(/^▶\s*/, ''), lines: [] };
                ensureSection().groups.push(group);
            } else {
                const isBullet = /^[-•·]\s+/.test(line);
                const item = { key: `l${n++}`, text: isBullet ? line.replace(/^[-•·]\s+/, '') : line, cls: isBullet ? 'report-bullet' : 'report-para' };
                (group ? group.lines : ensureSection().lines).push(item);
            }
        });
    return sections.map((s) => ({ ...s, hasGroups: s.groups.length > 0 }));
}
