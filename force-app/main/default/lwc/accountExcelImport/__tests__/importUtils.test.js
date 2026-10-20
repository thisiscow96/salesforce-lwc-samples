import { CHUNK_SIZE, MAX_ROWS, buildErrorCsv, mapHeaders, parseMatrix, toChunks, toPayload } from '../importUtils';

const HEADER = ['Account Name', 'First Name', 'Last Name', 'Email'];

describe('importUtils', () => {
    it('헤더는 대소문자·공백·기호를 무시하고 한글 별칭도 인식한다', () => {
        expect(mapHeaders(['EMAIL', 'last_name', ' first-name ', 'AccountName']).columns).toEqual({ email: 0, lastName: 1, firstName: 2, accountName: 3 });
        expect(mapHeaders(['회사명', '이름', '성', '이메일']).missing).toEqual([]);
        expect(mapHeaders(['Name', 'Email']).missing).toEqual(['Last Name']);
    });

    it('필수 열이 없으면 파일 단위 오류', () => {
        expect(parseMatrix([['Email'], ['a@b.com']]).fileError).toContain('Account Name, Last Name');
        expect(parseMatrix([HEADER]).fileError).toContain('데이터 행이 없습니다');
        expect(parseMatrix([]).fileError).toBeTruthy();
    });

    it('Excel 행 번호를 유지하고 빈 행은 건너뛰며 값은 trim', () => {
        const { fileError, rows } = parseMatrix([HEADER, ['  Acme ', ' Gil ', 'Hong', 'g@acme.com'], ['', '', '', ''], ['Acme', '', 'Kim', '']]);
        expect(fileError).toBeNull();
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ rowNumber: 2, accountName: 'Acme', firstName: 'Gil', lastName: 'Hong', email: 'g@acme.com', errors: [] });
        expect(rows[1]).toMatchObject({ rowNumber: 4, firstName: null, email: null, errors: [] });
    });

    it('행 단위 검증: 필수값, 길이, Email 형식, 파일 내 Email 중복', () => {
        const { rows } = parseMatrix([
            HEADER,
            ['', 'A', 'B', ''],
            ['Acme', 'A', '', ''],
            ['Acme', 'x'.repeat(41), 'B', ''],
            ['Acme', 'A', 'B', 'not-mail'],
            ['Acme', 'A', 'B', 'dup@acme.com'],
            ['Acme', 'A', 'C', 'DUP@acme.com']
        ]);
        expect(rows.map((r) => r.errors)).toEqual([
            ['Account Name 필수'],
            ['Last Name 필수'],
            ['First Name 40자 초과'],
            ['Email 형식 오류'],
            [],
            ['Email 중복 (6행)']
        ]);
    });

    it(`${MAX_ROWS}행 초과는 거부`, () => {
        const matrix = [HEADER, ...Array.from({ length: MAX_ROWS + 1 }, (_, i) => ['A', '', `L${i}`, ''])];
        expect(parseMatrix(matrix).fileError).toContain('Data Loader');
    });

    it('청크 분할과 이전 청크 Account Id 전달', () => {
        const items = Array.from({ length: CHUNK_SIZE * 2 + 1 }, (_, i) => i);
        expect(toChunks(items).map((c) => c.length)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 1]);

        const payload = toPayload([{ rowNumber: 2, accountName: ' ACME ', firstName: null, lastName: 'L', email: null, errors: [] }], new Map([['acme', '001xx']]));
        expect(payload).toEqual([{ rowNumber: 2, accountName: ' ACME ', accountId: '001xx', firstName: null, lastName: 'L', email: null }]);
    });

    it('실패 CSV: BOM, 따옴표·쉼표 이스케이프, 다시 업로드 가능한 헤더', () => {
        const csv = buildErrorCsv([{ rowNumber: 3, accountName: 'A, "B"', firstName: null, lastName: 'L', email: 'x', message: 'Email 형식 오류' }]);
        expect(csv.charCodeAt(0)).toBe(0xfeff);
        const lines = csv.slice(1).split('\r\n');
        expect(lines[0]).toBe('Row,Account Name,First Name,Last Name,Email,Error');
        expect(lines[1]).toBe('3,"A, ""B""",,L,x,Email 형식 오류');
        expect(mapHeaders(lines[0].split(',')).missing).toEqual([]);
    });
});
