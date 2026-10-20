import { buildErrorCsv, mapHeaders, parseMatrix, templateRows, toChunks, toRequestJson, validateValue } from '../importUtils';
import { ACCOUNT_CONTACT, TYPED } from './data/configs';

const HEADER = ['Account Name', 'First Name', 'Last Name', 'Email'];
const cols = ACCOUNT_CONTACT.columns;

describe('importUtils (설정 기반)', () => {
    it('헤더는 label·key·aliases를 대소문자·공백·기호 무시하고 인식한다', () => {
        expect(mapHeaders(cols, ['EMAIL', 'last_name', ' first-name ', 'AccountName']).indexes).toEqual({ email: 0, lastName: 1, firstName: 2, accountName: 3 });
        expect(mapHeaders(cols, ['회사명', '이름', '성', '이메일']).missing).toEqual([]);
        expect(mapHeaders(cols, ['Email']).missing).toEqual(['Account Name', 'Last Name']);
    });

    it('필수 열 누락·빈 파일·최대 행 초과는 파일 단위 오류', () => {
        expect(parseMatrix(ACCOUNT_CONTACT, [['Email'], ['a@b.com']]).fileError).toContain('Account Name, Last Name');
        expect(parseMatrix(ACCOUNT_CONTACT, [HEADER]).fileError).toContain('데이터 행이 없습니다');
        const small = { ...ACCOUNT_CONTACT, maxRows: 1 };
        expect(parseMatrix(small, [HEADER, ['A', '', 'B', ''], ['C', '', 'D', '']]).fileError).toContain('1행까지');
    });

    it('Excel 행 번호 유지, 빈 행 건너뜀, 값 trim', () => {
        const { fileError, rows } = parseMatrix(ACCOUNT_CONTACT, [HEADER, ['  Acme ', ' Gil ', 'Hong', 'g@acme.com'], ['', '', '', ''], ['Acme', '', 'Kim', '']]);
        expect(fileError).toBeNull();
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ rowNumber: 2, values: { accountName: 'Acme', firstName: 'Gil', lastName: 'Hong', email: 'g@acme.com' }, errors: [] });
        expect(rows[1]).toMatchObject({ rowNumber: 4, values: { firstName: null, email: null }, errors: [] });
    });

    it('행 검증: 필수, 길이, Email 형식, 파일 내 중복(uniqueInFile)', () => {
        const { rows } = parseMatrix(ACCOUNT_CONTACT, [
            HEADER,
            ['', 'A', 'B', ''],
            ['Acme', 'x'.repeat(41), 'Kim', 'bad-mail'],
            ['Acme', '', 'Lee', 'dup@a.com'],
            ['Acme', '', 'Park', 'DUP@a.com']
        ]);
        expect(rows[0].errors).toEqual(['Account Name 필수']);
        expect(rows[1].errors).toEqual(['First Name 40자 초과', 'Email 형식 오류']);
        expect(rows[2].errors).toEqual([]);
        expect(rows[3].errors).toEqual(['Email 중복 (4행)']);
    });

    it('Number·Date·Boolean 타입 검증 (서버와 같은 규칙)', () => {
        const [, amount, birth, active] = TYPED.columns;
        expect(validateValue(amount, '1,234.5')).toBeNull();
        expect(validateValue(amount, 'abc')).toBe('Amount 숫자 형식 오류');
        expect(validateValue(birth, '2024-02-29')).toBeNull();
        expect(validateValue(birth, '2025-02-29')).toContain('날짜 형식 오류');
        expect(validateValue(birth, '05/01/1990')).toContain('날짜 형식 오류');
        expect(validateValue(active, 'Y')).toBeNull();
        expect(validateValue(active, 'maybe')).toContain('true/false');
    });

    it('청크 분할과 Apex 요청 JSON (설정 열 값 + carryOver)', () => {
        expect(toChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
        const json = JSON.parse(toRequestJson([{ rowNumber: 2, values: { lastName: 'Hong' }, errors: [] }], { 'account:acme': '001x' }));
        expect(json).toEqual({ rows: [{ rowNumber: 2, values: { lastName: 'Hong' } }], carryOver: { 'account:acme': '001x' } });
    });

    it('양식은 열 label + 예시 행, 실패 CSV는 BOM + 원본 열 + 사유', () => {
        expect(templateRows(cols)).toEqual([HEADER, ['Hanbit Tech', 'Gildong', 'Hong', 'a@b.com']]);
        const csv = buildErrorCsv(cols, [{ rowNumber: 3, values: { accountName: 'A, Inc', lastName: 'Kim' }, message: 'Email "x" 오류' }]);
        expect(csv.charCodeAt(0)).toBe(0xfeff);
        expect(csv).toContain('Row,Account Name,First Name,Last Name,Email,Error');
        expect(csv).toContain('3,"A, Inc",,Kim,,"Email ""x"" 오류"');
    });
});
