// Excel 업로드 공통 순수 함수. 열 정의(config.columns)를 받아 동작하므로 업로드 종류와 무관
// (SheetJS·Apex에 의존하지 않아 Jest로 단독 검증 가능). 서버 ExcelImportService와 같은 검증 규칙

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const EMAIL_PATTERN = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const DATE_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const TRUE_VALUES = ['true', 'y', 'yes', '1', '예', 'o'];
const FALSE_VALUES = ['false', 'n', 'no', '0', '아니오', 'x'];

/** 헤더 비교용: 대소문자·공백·_·-·. 무시 */
export function normalizeHeader(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[\s_\-.]/g, '');
}

export function clean(value) {
    const text = String(value ?? '').trim();
    return text === '' ? null : text;
}

/** 헤더 행 → { indexes: {열 key: 열 index}, missing: [필수인데 없는 열 label] }. label·key·aliases 중 하나와 같으면 인식 */
export function mapHeaders(columns, headerRow) {
    const normalized = (headerRow || []).map(normalizeHeader);
    const indexes = {};
    columns.forEach((column) => {
        const names = new Set([column.label, column.key, ...(column.aliases || [])].map(normalizeHeader));
        const index = normalized.findIndex((h) => names.has(h));
        if (index >= 0) {
            indexes[column.key] = index;
        }
    });
    const missing = columns.filter((c) => c.required && indexes[c.key] === undefined).map((c) => c.label);
    return { indexes, missing };
}

function isValidDate(text) {
    const m = DATE_PATTERN.exec(text);
    if (!m) {
        return false;
    }
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(Date.UTC(y, mo - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** 값 1개 검증 → 오류 문구 또는 null */
export function validateValue(column, value) {
    if (!value) {
        return column.required ? `${column.label} 필수` : null;
    }
    if (column.maxLength && value.length > column.maxLength) {
        return `${column.label} ${column.maxLength}자 초과`;
    }
    switch (column.dataType) {
        case 'Email':
            return EMAIL_PATTERN.test(value) ? null : `${column.label} 형식 오류`;
        case 'Number':
            return value.replace(/,/g, '') !== '' && Number.isFinite(Number(value.replace(/,/g, ''))) ? null : `${column.label} 숫자 형식 오류`;
        case 'Date':
            return isValidDate(value) ? null : `${column.label} 날짜 형식 오류 (yyyy-mm-dd)`;
        case 'Boolean':
            return [...TRUE_VALUES, ...FALSE_VALUES].includes(value.toLowerCase()) ? null : `${column.label} true/false 형식 오류`;
        default:
            return null;
    }
}

/**
 * sheet_to_json(header:1) 결과(2차원 배열) → 업로드 행 목록 { rowNumber, values: {key: 값}, errors: [] }.
 * 첫 행은 헤더, rowNumber는 Excel 행 번호(사용자가 파일에서 바로 찾을 수 있게). 빈 행은 건너뜀.
 */
export function parseMatrix(config, matrix) {
    const columns = config.columns;
    if (!matrix || matrix.length < 2) {
        return { fileError: '데이터 행이 없습니다. 첫 행은 헤더, 두 번째 행부터 데이터를 입력하세요.', rows: [] };
    }
    const { indexes, missing } = mapHeaders(columns, matrix[0]);
    if (missing.length) {
        return { fileError: `필수 열이 없습니다: ${missing.join(', ')} (헤더 행을 확인하세요)`, rows: [] };
    }
    const rows = [];
    // 파일 안 중복 검사 대상 열 (예: Email). 같은 값은 대개 복사 실수 → 두 번째부터 오류
    const firstRowByValue = new Map(columns.filter((c) => c.uniqueInFile).map((c) => [c.key, new Map()]));
    for (let i = 1; i < matrix.length; i++) {
        const cells = matrix[i] || [];
        const values = {};
        columns.forEach((c) => {
            values[c.key] = indexes[c.key] === undefined ? null : clean(cells[indexes[c.key]]);
        });
        if (columns.every((c) => !values[c.key])) {
            continue;
        }
        const row = { rowNumber: i + 1, values, errors: columns.map((c) => validateValue(c, values[c.key])).filter(Boolean) };
        firstRowByValue.forEach((seen, key) => {
            const value = values[key];
            if (!value) {
                return;
            }
            const normalized = value.toLowerCase();
            if (seen.has(normalized)) {
                const label = columns.find((c) => c.key === key).label;
                row.errors.push(`${label} 중복 (${seen.get(normalized)}행)`);
            } else {
                seen.set(normalized, row.rowNumber);
            }
        });
        rows.push(row);
    }
    if (!rows.length) {
        return { fileError: '데이터 행이 없습니다.', rows: [] };
    }
    if (rows.length > config.maxRows) {
        return {
            fileError: `한 번에 ${config.maxRows.toLocaleString()}행까지 업로드할 수 있습니다 (현재 ${rows.length.toLocaleString()}행). 파일을 나누거나 Data Loader를 사용하세요.`,
            rows: []
        };
    }
    return { fileError: null, rows };
}

export function toChunks(items, size) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

/** Apex ExcelImportController.importRows 의 requestJson */
export function toRequestJson(chunk, carryOver) {
    return JSON.stringify({
        rows: chunk.map((r) => ({ rowNumber: r.rowNumber, values: r.values })),
        carryOver: carryOver || {}
    });
}

/** 업로드 양식: 헤더 + 예시 1행 */
export function templateRows(columns) {
    return [columns.map((c) => c.label), columns.map((c) => c.sampleValue || '')];
}

function csvCell(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 실패 행 CSV (Excel에서 한글이 깨지지 않도록 UTF-8 BOM). 원본 열 + 오류 사유 → 고쳐서 다시 업로드 가능 */
export function buildErrorCsv(columns, failedRows) {
    const header = ['Row', ...columns.map((c) => c.label), 'Error'];
    const lines = failedRows.map((r) => [r.rowNumber, ...columns.map((c) => r.values[c.key]), r.message].map(csvCell).join(','));
    return '﻿' + [header.map(csvCell).join(','), ...lines].join('\r\n');
}
