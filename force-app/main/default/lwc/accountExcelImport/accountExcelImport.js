import { LightningElement } from 'lwc';
import { loadScript } from 'lightning/platformResourceLoader';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import SHEETJS from '@salesforce/resourceUrl/sheetjs';
import importRows from '@salesforce/apex/AccountExcelImportController.importRows';
import { MAX_FILE_BYTES, TEMPLATE_ROWS, accountKey, buildErrorCsv, parseMatrix, toChunks, toPayload } from './importUtils';

const PREVIEW_LIMIT = 500; // 화면 성능을 위해 미리보기는 일부만 (업로드는 전체)

const PREVIEW_COLUMNS = [
    { label: '행', fieldName: 'rowNumber', type: 'number', initialWidth: 70 },
    { label: 'Account Name', fieldName: 'accountName' },
    { label: 'First Name', fieldName: 'firstName' },
    { label: 'Last Name', fieldName: 'lastName' },
    { label: 'Email', fieldName: 'email' },
    { label: '검증', fieldName: 'status', cellAttributes: { class: { fieldName: 'statusClass' } } }
];

const RESULT_COLUMNS = [
    { label: '행', fieldName: 'rowNumber', type: 'number', initialWidth: 70 },
    { label: 'Account Name', fieldName: 'accountName' },
    { label: 'Last Name', fieldName: 'lastName' },
    { label: 'Email', fieldName: 'email' },
    { label: '실패 사유', fieldName: 'message', wrapText: true }
];

function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
}

function downloadDataUri(fileName, dataUri) {
    const link = document.createElement('a');
    link.href = dataUri;
    link.download = fileName;
    link.click();
}

function errorMessage(error) {
    return error?.body?.message || error?.message || '알 수 없는 오류';
}

/**
 * Excel(.xlsx)/CSV → Account + Contact 업로드.
 * 흐름: 파일 선택 → 브라우저에서 파싱·검증(미리보기) → 200행씩 Apex 순차 호출 → 결과·실패 CSV.
 * 이벤트: busychange {busy} (업로드 중 모달 닫기 방지용), importcomplete {total, success, failed}
 */
export default class AccountExcelImport extends LightningElement {
    stage = 'select'; // select | preview | importing | done
    fileName;
    fileError;
    rows = [];
    showErrorsOnly = false;
    progress = 0;
    results = [];
    libraryError;
    libraryReady = false;

    previewColumns = PREVIEW_COLUMNS;
    resultColumns = RESULT_COLUMNS;

    connectedCallback() {
        loadScript(this, SHEETJS)
            .then(() => {
                this.libraryReady = true;
            })
            .catch((error) => {
                this.libraryError = `Excel 라이브러리를 불러오지 못했습니다: ${errorMessage(error)}`;
            });
    }

    get isSelect() {
        return this.stage === 'select';
    }
    get isPreview() {
        return this.stage === 'preview';
    }
    get isImporting() {
        return this.stage === 'importing';
    }
    get isDone() {
        return this.stage === 'done';
    }
    get fileInputDisabled() {
        return !this.libraryReady;
    }

    get validRows() {
        return this.rows.filter((r) => !r.errors.length);
    }
    get invalidCount() {
        return this.rows.length - this.validRows.length;
    }
    get validCount() {
        return this.validRows.length;
    }
    get hasInvalid() {
        return this.invalidCount > 0;
    }
    get importDisabled() {
        return this.validCount === 0;
    }
    get importLabel() {
        return `${this.validCount.toLocaleString()}건 업로드`;
    }
    get accountCount() {
        return new Set(this.validRows.map((r) => accountKey(r.accountName))).size;
    }

    get previewData() {
        const source = this.showErrorsOnly ? this.rows.filter((r) => r.errors.length) : this.rows;
        return source.slice(0, PREVIEW_LIMIT).map((r) => ({
            ...r,
            status: r.errors.length ? r.errors.join(', ') : 'OK',
            statusClass: r.errors.length ? 'slds-text-color_error' : 'slds-text-color_success'
        }));
    }
    get previewTruncated() {
        return this.rows.length > PREVIEW_LIMIT && !this.showErrorsOnly;
    }
    get previewLimit() {
        return PREVIEW_LIMIT;
    }

    get progressLabel() {
        return `${this.progress}%`;
    }

    // 결과: 클라이언트 검증 실패 + 서버 실패를 합쳐 행 번호순
    get failedRows() {
        return this.results.filter((r) => !r.success).sort((a, b) => a.rowNumber - b.rowNumber);
    }
    get successCount() {
        return this.results.length - this.failedRows.length;
    }
    get failedCount() {
        return this.failedRows.length;
    }
    get hasFailures() {
        return this.failedCount > 0;
    }

    async handleFileChange(event) {
        const file = event.detail.files && event.detail.files[0];
        if (!file) {
            return;
        }
        this.reset();
        this.fileName = file.name;
        if (file.size > MAX_FILE_BYTES) {
            this.fileError = '파일이 5MB를 넘습니다. 파일을 나누거나 Data Loader를 사용하세요.';
            return;
        }
        try {
            const workbook = window.XLSX.read(await readAsArrayBuffer(file), { type: 'array' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            // raw:false → 숫자·날짜도 화면에 보이는 문자열 그대로 (전화번호 앞 0 등 보존)
            const matrix = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: false });
            const { fileError, rows } = parseMatrix(matrix);
            if (fileError) {
                this.fileError = fileError;
                return;
            }
            this.rows = rows;
            this.stage = 'preview';
        } catch (error) {
            this.fileError = `파일을 읽지 못했습니다. .xlsx 또는 .csv 파일인지 확인하세요. (${errorMessage(error)})`;
        }
    }

    handleToggleErrors(event) {
        this.showErrorsOnly = event.target.checked;
    }

    handleDownloadTemplate() {
        const XLSX = window.XLSX;
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(TEMPLATE_ROWS), 'Accounts');
        const base64 = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64' });
        downloadDataUri('account_upload_template.xlsx', `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${base64}`);
    }

    handleDownloadErrors() {
        downloadDataUri('account_upload_errors.csv', `data:text/csv;charset=utf-8,${encodeURIComponent(buildErrorCsv(this.failedRows))}`);
    }

    async handleImport() {
        const chunks = toChunks(this.validRows);
        // 검증 실패 행은 서버로 보내지 않고 결과에 바로 포함
        const results = this.rows
            .filter((r) => r.errors.length)
            .map((r) => ({ ...r, success: false, message: r.errors.join(', ') }));
        const accountIds = new Map();
        const byRowNumber = new Map(this.rows.map((r) => [r.rowNumber, r]));

        this.stage = 'importing';
        this.progress = 0;
        this.setBusy(true);
        for (let i = 0; i < chunks.length; i++) {
            try {
                // 앞 청크에서 만든 Account Id가 필요하므로 병렬이 아닌 순차 호출
                // eslint-disable-next-line no-await-in-loop
                const saved = await importRows({ rows: toPayload(chunks[i], accountIds) });
                saved.forEach((r) => {
                    if (r.success) {
                        accountIds.set(accountKey(r.accountName), r.accountId);
                    }
                    results.push({ ...byRowNumber.get(r.rowNumber), ...r });
                });
            } catch (error) {
                // 권한·시스템 오류는 다음 청크에서도 반복되므로 중단하고 남은 행을 실패로 표시
                const message = `업로드 중단: ${errorMessage(error)}`;
                chunks.slice(i).flat().forEach((r) => results.push({ ...r, success: false, message }));
                break;
            }
            this.progress = Math.round(((i + 1) / chunks.length) * 100);
        }
        this.results = results;
        this.stage = 'done';
        this.setBusy(false);
        this.notify();
    }

    notify() {
        const detail = { total: this.results.length, success: this.successCount, failed: this.failedCount };
        this.dispatchEvent(
            new ShowToastEvent({
                title: 'Excel 업로드 완료',
                message: `성공 ${detail.success.toLocaleString()}건, 실패 ${detail.failed.toLocaleString()}건`,
                variant: detail.failed ? (detail.success ? 'warning' : 'error') : 'success'
            })
        );
        this.dispatchEvent(new CustomEvent('importcomplete', { detail }));
    }

    setBusy(busy) {
        this.dispatchEvent(new CustomEvent('busychange', { detail: { busy } }));
    }

    handleReset() {
        this.reset();
    }

    reset() {
        this.stage = 'select';
        this.fileName = undefined;
        this.fileError = undefined;
        this.rows = [];
        this.results = [];
        this.showErrorsOnly = false;
        this.progress = 0;
    }
}
