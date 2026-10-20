import { LightningElement, api } from 'lwc';
import { loadScript } from 'lightning/platformResourceLoader';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import SHEETJS from '@salesforce/resourceUrl/sheetjs';
import getConfig from '@salesforce/apex/ExcelImportController.getConfig';
import importRows from '@salesforce/apex/ExcelImportController.importRows';
import { MAX_FILE_BYTES, buildErrorCsv, parseMatrix, templateRows, toChunks, toRequestJson } from './importUtils';

const PREVIEW_LIMIT = 500; // 화면 성능을 위해 미리보기는 일부만 (업로드는 전체)
const FIELD_PREFIX = 'f_'; // datatable fieldName이 status 등 내부 키와 겹치지 않게

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
 * Excel 업로드 공통 컴포넌트. 어떤 데이터를 어디에 저장할지는 configName(Excel_Import_Config__mdt)이 정한다.
 *   - 열 정의·검증 규칙·저장 Handler는 모두 설정에서 받아오고, 이 컴포넌트는 화면 흐름만 담당
 *   - 설정이 없거나(파라미터 누락 포함) 비활성·불완전·권한 없음이면 파일 선택 대신 오류를 표시
 * 흐름: 설정 조회 → 파일 선택 → 브라우저에서 파싱·검증(미리보기) → chunkSize씩 Apex 순차 호출 → 결과·실패 CSV.
 *
 * 사용처: App/Home/Record Page(App Builder 속성), Flow Screen, c-excel-import-modal(버튼),
 *        c-excel-import-action(레코드 Quick Action), c-excel-import-page(List View·URL 버튼)
 * 이벤트: configload {config}, busychange {busy} (업로드 중 닫기 방지용), importcomplete {total, success, failed}
 */
export default class ExcelImport extends LightningElement {
    stage = 'loading'; // loading | configError | select | preview | importing | done
    config;
    configError;
    fileName;
    fileError;
    rows = [];
    showErrorsOnly = false;
    progress = 0;
    results = [];
    libraryError;
    libraryReady = false;

    _configName;
    _recordId;
    loadScheduled = false;
    loadSeq = 0;

    /** Excel_Import_Config__mdt DeveloperName */
    @api
    get configName() {
        return this._configName;
    }
    set configName(value) {
        this._configName = value;
        this.scheduleLoad();
    }

    /** 레코드 화면에서는 플랫폼이 자동으로 채움. Parent Object가 있는 설정은 필수 */
    @api
    get recordId() {
        return this._recordId;
    }
    set recordId(value) {
        this._recordId = value;
        this.scheduleLoad();
    }

    connectedCallback() {
        this.scheduleLoad();
        loadScript(this, SHEETJS)
            .then(() => {
                this.libraryReady = true;
            })
            .catch((error) => {
                this.libraryError = `Excel 라이브러리를 불러오지 못했습니다: ${errorMessage(error)}`;
            });
    }

    // configName·recordId가 연달아 설정돼도 조회는 1번만 (마이크로태스크로 묶음)
    scheduleLoad() {
        if (this.loadScheduled) {
            return;
        }
        this.loadScheduled = true;
        Promise.resolve().then(() => {
            this.loadScheduled = false;
            this.loadConfig();
        });
    }

    async loadConfig() {
        const seq = ++this.loadSeq;
        this.reset();
        this.stage = 'loading';
        try {
            const config = await getConfig({ configName: this._configName || null, recordId: this._recordId || null });
            if (seq !== this.loadSeq) {
                return; // 더 최신 요청이 있으면 무시
            }
            this.config = config;
            this.configError = undefined;
            this.stage = 'select';
            this.dispatchEvent(new CustomEvent('configload', { detail: { config } }));
        } catch (error) {
            if (seq !== this.loadSeq) {
                return;
            }
            this.config = undefined;
            this.configError = errorMessage(error);
            this.stage = 'configError';
        }
    }

    get isLoading() {
        return this.stage === 'loading';
    }
    get hasConfigError() {
        return this.stage === 'configError';
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

    get columns() {
        return this.config ? this.config.columns : [];
    }
    get columnGuide() {
        return this.columns.map((c) => ({ key: c.key, text: `${c.label}${c.required ? ' (필수)' : ''}`, required: c.required }));
    }
    get limitGuide() {
        return `.xlsx / .csv, 첫 번째 시트만, 최대 ${this.config.maxRows.toLocaleString()}행 · 5MB`;
    }

    get previewColumns() {
        return [
            { label: '행', fieldName: 'rowNumber', type: 'number', initialWidth: 70 },
            ...this.columns.map((c) => ({ label: c.label, fieldName: FIELD_PREFIX + c.key })),
            { label: '검증', fieldName: 'status', wrapText: true, cellAttributes: { class: { fieldName: 'statusClass' } } }
        ];
    }
    get resultColumns() {
        return [
            { label: '행', fieldName: 'rowNumber', type: 'number', initialWidth: 70 },
            ...this.columns.slice(0, 3).map((c) => ({ label: c.label, fieldName: FIELD_PREFIX + c.key })),
            { label: '실패 사유', fieldName: 'message', wrapText: true }
        ];
    }

    toTableRow(row, extra) {
        const flat = { rowNumber: row.rowNumber, ...extra };
        this.columns.forEach((c) => {
            flat[FIELD_PREFIX + c.key] = row.values[c.key];
        });
        return flat;
    }

    get validRows() {
        return this.rows.filter((r) => !r.errors.length);
    }
    get validCount() {
        return this.validRows.length;
    }
    get invalidCount() {
        return this.rows.length - this.validCount;
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

    get previewData() {
        const source = this.showErrorsOnly ? this.rows.filter((r) => r.errors.length) : this.rows;
        return source.slice(0, PREVIEW_LIMIT).map((r) =>
            this.toTableRow(r, {
                status: r.errors.length ? r.errors.join(', ') : 'OK',
                statusClass: r.errors.length ? 'slds-text-color_error' : 'slds-text-color_success'
            })
        );
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
    get failedTableData() {
        return this.failedRows.map((r) => this.toTableRow(r, { message: r.message }));
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
            // dateNF: Excel 기본 날짜 서식(m/d/yy)을 서버 규칙(yyyy-mm-dd)으로 읽음
            const workbook = window.XLSX.read(await readAsArrayBuffer(file), { type: 'array', dateNF: 'yyyy-mm-dd' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            // raw:false → 숫자·날짜도 화면에 보이는 문자열 그대로 (전화번호 앞 0 등 보존)
            const matrix = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: false, dateNF: 'yyyy-mm-dd' });
            const { fileError, rows } = parseMatrix(this.config, matrix);
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
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(templateRows(this.columns)), 'Upload');
        const base64 = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64' });
        downloadDataUri(this.config.templateFileName, `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${base64}`);
    }

    handleDownloadErrors() {
        const csv = buildErrorCsv(this.columns, this.failedRows);
        downloadDataUri(`${this.config.name}_errors.csv`, `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`);
    }

    async handleImport() {
        const chunks = toChunks(this.validRows, this.config.chunkSize);
        // 검증 실패 행은 서버로 보내지 않고 결과에 바로 포함
        const results = this.rows.filter((r) => r.errors.length).map((r) => ({ ...r, success: false, message: r.errors.join(', ') }));
        const byRowNumber = new Map(this.rows.map((r) => [r.rowNumber, r]));
        let carryOver = {};

        this.stage = 'importing';
        this.progress = 0;
        this.setBusy(true);
        for (let i = 0; i < chunks.length; i++) {
            try {
                // 앞 청크 결과(carryOver)가 다음 청크에 필요할 수 있어 병렬이 아닌 순차 호출
                // eslint-disable-next-line no-await-in-loop
                const response = await importRows({
                    configName: this.config.name,
                    recordId: this._recordId || null,
                    requestJson: toRequestJson(chunks[i], carryOver)
                });
                carryOver = response.carryOver || {};
                response.results.forEach((r) => results.push({ ...byRowNumber.get(r.rowNumber), ...r }));
            } catch (error) {
                // 설정·권한·시스템 오류는 다음 청크에서도 반복되므로 중단하고 남은 행을 실패로 표시
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
                title: `${this.config.label} 완료`,
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
        this.stage = 'select';
    }

    reset() {
        this.fileName = undefined;
        this.fileError = undefined;
        this.rows = [];
        this.results = [];
        this.showErrorsOnly = false;
        this.progress = 0;
    }
}
