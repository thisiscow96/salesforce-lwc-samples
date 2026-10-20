// Excel 업로드용 순수 함수 (SheetJS·Apex에 의존하지 않아 Jest로 단독 검증 가능)

export const MAX_ROWS = 5000; // 이보다 많으면 Data Loader/Bulk API가 적합 (브라우저 순차 호출은 느림)
export const CHUNK_SIZE = 200; // Apex AccountExcelImportController.MAX_ROWS_PER_CALL과 동일하게 유지
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

// 헤더는 대소문자·공백·_·-·. 무시하고 비교. 한글 헤더도 허용
export const FIELDS = [
    { key: 'accountName', label: 'Account Name', required: true, max: 255, aliases: ['accountname', 'name', 'account', 'company', '회사명', '거래처명', '고객사'] },
    { key: 'firstName', label: 'First Name', max: 40, aliases: ['firstname', 'first', '이름'] },
    { key: 'lastName', label: 'Last Name', required: true, max: 80, aliases: ['lastname', 'last', 'surname', '성'] },
    { key: 'email', label: 'Email', max: 80, aliases: ['email', 'mail', '이메일'] }
];

export const TEMPLATE_ROWS = [
    FIELDS.map((f) => f.label),
    ['Hanbit Tech', 'Gildong', 'Hong', 'gildong.hong@example.com'],
    ['Hanbit Tech', 'Younghee', 'Kim', 'younghee.kim@example.com']
];

// Apex와 같은 규칙. 최종 판단은 서버와 플랫폼 Email 검증이 한다
const EMAIL_PATTERN = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function normalizeHeader(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[\s_\-.]/g, '');
}

export function clean(value) {
    const text = String(value ?? '').trim();
    return text === '' ? null : text;
}

export function accountKey(name) {
    return (clean(name) || '').toLowerCase();
}

/** 헤더 행 → { columns: {fieldKey: 열 index}, missing: [필수인데 없는 열 label] } */
export function mapHeaders(headerRow) {
    const normalized = (headerRow || []).map(normalizeHeader);
    const columns = {};
    FIELDS.forEach((field) => {
        const index = normalized.findIndex((h) => field.aliases.includes(h));
        if (index >= 0) {
            columns[field.key] = index;
        }
    });
    const missing = FIELDS.filter((f) => f.required && columns[f.key] === undefined).map((f) => f.label);
    return { columns, missing };
}

export function validateRow(row) {
    const errors = [];
    FIELDS.forEach((field) => {
        const value = row[field.key];
        if (field.required && !value) {
            errors.push(`${field.label} 필수`);
        } else if (value && value.length > field.max) {
            errors.push(`${field.label} ${field.max}자 초과`);
        }
    });
    if (row.email && row.email.length <= 80 && !EMAIL_PATTERN.test(row.email)) {
        errors.push('Email 형식 오류');
    }
    return errors;
}

/**
 * sheet_to_json(header:1) 결과(2차원 배열) → 업로드 행 목록.
 * 첫 행은 헤더, rowNumber는 Excel 행 번호(사용자가 파일에서 바로 찾을 수 있게). 빈 행은 건너뜀.
 */
export function parseMatrix(matrix) {
    if (!matrix || matrix.length < 2) {
        return { fileError: '데이터 행이 없습니다. 첫 행은 헤더, 두 번째 행부터 데이터를 입력하세요.', rows: [] };
    }
    const { columns, missing } = mapHeaders(matrix[0]);
    if (missing.length) {
        return { fileError: `필수 열이 없습니다: ${missing.join(', ')} (헤더 행을 확인하세요)`, rows: [] };
    }
    const rows = [];
    const firstRowByEmail = new Map();
    for (let i = 1; i < matrix.length; i++) {
        const cells = matrix[i] || [];
        const row = { rowNumber: i + 1 };
        FIELDS.forEach((field) => {
            row[field.key] = columns[field.key] === undefined ? null : clean(cells[columns[field.key]]);
        });
        if (FIELDS.every((field) => !row[field.key])) {
            continue;
        }
        row.errors = validateRow(row);
        // 같은 파일 안의 중복 Email은 대개 복사 실수 → 두 번째부터 오류 처리
        if (row.email) {
            const key = row.email.toLowerCase();
            if (firstRowByEmail.has(key)) {
                row.errors.push(`Email 중복 (${firstRowByEmail.get(key)}행)`);
            } else {
                firstRowByEmail.set(key, row.rowNumber);
            }
        }
        rows.push(row);
    }
    if (!rows.length) {
        return { fileError: '데이터 행이 없습니다.', rows: [] };
    }
    if (rows.length > MAX_ROWS) {
        return { fileError: `한 번에 ${MAX_ROWS.toLocaleString()}행까지 업로드할 수 있습니다 (현재 ${rows.length.toLocaleString()}행). 파일을 나누거나 Data Loader를 사용하세요.`, rows: [] };
    }
    return { fileError: null, rows };
}

export function toChunks(items, size = CHUNK_SIZE) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

/**
 * Apex 호출용 payload. 이전 청크에서 만든 Account는 accountId로 넘겨 청크 간에도 같은 Account를 쓰게 한다.
 */
export function toPayload(chunk, accountIdsByKey) {
    return chunk.map((row) => ({
        rowNumber: row.rowNumber,
        accountName: row.accountName,
        accountId: accountIdsByKey.get(accountKey(row.accountName)) || null,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email
    }));
}

function csvCell(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 실패 행 CSV (Excel에서 한글이 깨지지 않도록 UTF-8 BOM 포함). 원본 열 + 오류 사유 → 고쳐서 다시 업로드 가능 */
export function buildErrorCsv(failedRows) {
    const header = ['Row', ...FIELDS.map((f) => f.label), 'Error'];
    const lines = failedRows.map((r) => [r.rowNumber, ...FIELDS.map((f) => r[f.key]), r.message].map(csvCell).join(','));
    return '﻿' + [header.join(','), ...lines].join('\r\n');
}
