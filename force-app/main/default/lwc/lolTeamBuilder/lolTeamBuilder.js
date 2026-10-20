import { LightningElement, api, wire } from 'lwc';
import { loadScript } from 'lightning/platformResourceLoader';
import SHEETJS from '@salesforce/resourceUrl/sheetjs';
import getBuilderData from '@salesforce/apex/LolTeamBuilderController.getBuilderData';
import startAnalysis from '@salesforce/apexContinuation/LolTeamBuilderController.startAnalysis';
import submitAnalysisRequest from '@salesforce/apex/LolTeamBuilderController.submitAnalysisRequest';
import getAnalysisRequest from '@salesforce/apex/LolTeamBuilderController.getAnalysisRequest';
import getRecentRequests from '@salesforce/apex/LolTeamBuilderController.getRecentRequests';
import { LANES, LANE_LABELS, CLASS_LABELS, normalizeData, scoreTeam, explain, suggestSwaps, findBestTeams } from './lolScoring';
import { buildWorkbook } from './lolExcel';
import { parseReport } from './reportParser';

const TOP_LIMIT = 30; // 화면 조합표
const POLL_INTERVAL_MS = 10000; // Claude Code 처리 상태 확인 주기
const POLL_LIMIT_MS = 30 * 60000; // 30분 지나면 자동 확인 중단 (결과는 최근 요청에서 확인)
const STATUS_LABELS = { Pending: '대기 중', Processing: '분석 중', Completed: '완료', Failed: '실패' };

// 출처는 http(s) 링크만 표시 (javascript: 등 차단)
function parseSources(json) {
    try {
        return (JSON.parse(json || '[]') || []).filter((src) => /^https?:\/\//i.test(String(src?.url || '')));
    } catch {
        // 깨진 JSON이면 출처 없이 표시
        return [];
    }
}
const EXCEL_LIMIT = 100; // Excel 조합 시트

const COMBO_COLUMNS = [
    { label: '#', fieldName: 'rank', type: 'number', initialWidth: 50 },
    ...LANES.map((lane) => ({ label: LANE_LABELS[lane], fieldName: lane })),
    { label: '총점', fieldName: 'total', type: 'number', initialWidth: 80, typeAttributes: { minimumFractionDigits: 1 } },
    { label: '등급', fieldName: 'grade', initialWidth: 70 },
    { label: '주요 시너지', fieldName: 'synergy', wrapText: true },
    { type: 'button', initialWidth: 80, typeAttributes: { label: '적용', name: 'apply', variant: 'base' } }
];

const POOL_COLUMNS = [
    { label: '챔피언', fieldName: 'name' },
    { label: '역할군', fieldName: 'clsLabel', initialWidth: 100 },
    { label: '딜', fieldName: 'dmgType', initialWidth: 70 },
    { label: '티어', fieldName: 'tier', initialWidth: 70 },
    { label: '승률', fieldName: 'winRateLabel', initialWidth: 80 },
    { label: 'CC', fieldName: 'cc', type: 'number', initialWidth: 60 },
    { label: '앞라인', fieldName: 'front', type: 'number', initialWidth: 75 },
    { label: '후반', fieldName: 'late', type: 'number', initialWidth: 65 },
    { label: '이니시', fieldName: 'engage', type: 'number', initialWidth: 75 },
    { label: '보호', fieldName: 'peel', type: 'number', initialWidth: 65 },
    { label: '캐리', fieldName: 'carry', type: 'number', initialWidth: 65 },
    { label: '특징', fieldName: 'note', wrapText: true }
];

// 화면 기본값(App Builder에서 변경 가능): 사용자 팀 실력
const DEFAULT_TIERS = 'TOP=EMERALD_LOW;JUNGLE=DIAMOND_LOW;MID=MASTER_500;ADC=MASTER_500;SUPPORT=MASTER_0';

function parseTierSetting(value) {
    return Object.fromEntries(
        String(value || DEFAULT_TIERS)
            .split(';')
            .map((pair) => pair.split('=').map((s) => s.trim()))
            .filter(([lane, tier]) => LANES.includes(lane) && tier)
    );
}

function errorMessage(error) {
    return error?.body?.message || error?.message || '알 수 없는 오류';
}

/**
 * LoL 팀 조합 분석기: 라인별 챔피언·실력 선택 → 점수/근거/교체 추천, 전체 조합 탐색표, Excel, Claude 실시간 분석.
 * 데이터·배점은 Custom Metadata(관리자가 Setup에서 수정), 계산은 lolScoring.js(순수 함수).
 */
export default class LolTeamBuilder extends LightningElement {
    @api cardTitle = 'LoL 팀 조합 분석기';
    @api defaultTiers = DEFAULT_TIERS;

    ctx;
    teamGoal;
    model;
    loadError;
    picks = {};
    tiers = {};
    locks = {};
    requireStructure = true;
    bestTeams = [];
    evaluated = 0;
    analysis;
    analysisError;
    analyzing = false;
    mode = 'CLAUDE_CODE';
    canAnalyze = false; // 서버가 알려 준 분석 요청 가능 여부
    isGuestUser = false; // Experience Cloud 공개 사이트 방문자
    queued; // Claude Code 모드에서 추적 중인 요청 { id, name, status, composition, processedBy }
    recentRequests = [];
    pollTimer;
    sheetJsPromise;

    comboColumns = COMBO_COLUMNS;
    poolColumns = POOL_COLUMNS;

    @wire(getBuilderData)
    wiredData({ data, error }) {
        if (data) {
            this.ctx = normalizeData(data);
            this.teamGoal = data.teamGoal;
            this.model = data.model;
            this.mode = data.mode || 'CLAUDE_CODE';
            this.canAnalyze = data.canRequestAnalysis === true;
            this.isGuestUser = data.isGuest === true;
            if (this.showRecent) {
                this.loadRecent();
            }
            this.loadError = undefined;
            const tierKeys = new Set(this.ctx.tiers.map((t) => t.key));
            const defaults = parseTierSetting(this.defaultTiers);
            this.tiers = Object.fromEntries(LANES.map((lane) => [lane, tierKeys.has(defaults[lane]) ? defaults[lane] : this.ctx.tiers[0]?.key]));
            // 첫 화면: 전체 탐색 1위 조합을 바로 보여 줌
            this.search();
            if (this.bestTeams.length) {
                this.applyTeam(this.bestTeams[0].team);
            }
        } else if (error) {
            this.loadError = `데이터를 불러오지 못했습니다: ${errorMessage(error)}`;
        }
    }

    // ===== 계산 =====
    get skills() {
        const skillByKey = new Map((this.ctx?.tiers || []).map((t) => [t.key, t.skill]));
        return Object.fromEntries(LANES.map((lane) => [lane, skillByKey.get(this.tiers[lane]) ?? 5]));
    }

    get team() {
        if (!this.ctx) return null;
        const team = {};
        for (const lane of LANES) {
            const champ = this.ctx.byId.get(this.picks[lane]);
            if (!champ) return null;
            team[lane] = champ;
        }
        return team;
    }

    get duplicateChampion() {
        const team = this.team;
        if (!team) return null;
        const seen = new Set();
        for (const lane of LANES) {
            if (seen.has(team[lane].key)) return team[lane].name;
            seen.add(team[lane].key);
        }
        return null;
    }

    get result() {
        const team = this.team;
        return team && !this.duplicateChampion ? scoreTeam(team, this.skills, this.ctx) : null;
    }

    get explanation() {
        return this.result ? explain(this.result) : { strengths: [], weaknesses: [], plan: '' };
    }

    get swaps() {
        return this.result ? suggestSwaps(this.result.team, this.skills, this.ctx) : [];
    }

    search() {
        const locked = Object.fromEntries(LANES.filter((l) => this.locks[l] && this.picks[l]).map((l) => [l, this.ctx.byId.get(this.picks[l])]));
        const { teams, evaluated } = findBestTeams(this.ctx, this.skills, { locked, requireStructure: this.requireStructure, limit: EXCEL_LIMIT });
        this.bestTeams = teams;
        this.evaluated = evaluated;
    }

    applyTeam(team) {
        this.picks = Object.fromEntries(LANES.map((lane) => [lane, team[lane].id]));
    }

    // ===== 화면용 getter =====
    get isReady() {
        return !!this.ctx;
    }

    get laneRows() {
        if (!this.ctx) return [];
        const tierOptions = this.ctx.tiers.map((t) => ({ label: t.label, value: t.key }));
        return LANES.map((lane) => {
            const champ = this.ctx.byId.get(this.picks[lane]);
            return {
                lane,
                label: LANE_LABELS[lane],
                options: this.ctx.byLane[lane].map((c) => ({ label: `${c.name} · ${CLASS_LABELS[c.cls]} · ${c.tier === '-' ? '미집계' : c.tier}`, value: c.id })),
                value: this.picks[lane] || null,
                tierOptions,
                tier: this.tiers[lane],
                locked: !!this.locks[lane],
                info: champ ? `${CLASS_LABELS[champ.cls]} · ${champ.dmgType} · 승률 ${champ.winRate ?? '미집계'}${champ.winRate ? '%' : ''} · ${champ.note || ''}` : ''
            };
        });
    }

    get hasResult() {
        return !!this.result;
    }
    get total() {
        return this.result?.total;
    }
    get grade() {
        return this.result?.grade;
    }
    get gradeClass() {
        return `grade grade-${(this.result?.grade || 'd').toLowerCase()}`;
    }
    get categories() {
        return (this.result?.categories || []).map((c) => ({ ...c, percent: Math.round(c.ratio * 100), barStyle: `width:${Math.round(c.ratio * 100)}%` }));
    }
    get strengths() {
        return this.explanation.strengths.map((text, i) => ({ key: `s${i}`, text }));
    }
    get weaknesses() {
        return this.explanation.weaknesses.map((text, i) => ({ key: `w${i}`, text }));
    }
    get hasWeaknesses() {
        return this.weaknesses.length > 0;
    }
    get plan() {
        return this.explanation.plan;
    }
    get swapItems() {
        return this.swaps.map((s, i) => ({ key: `x${i}`, text: `${LANE_LABELS[s.lane]} ${s.from.name} → ${s.to.name}`, delta: `+${s.delta}`, lane: s.lane, id: s.to.id }));
    }
    get hasSwaps() {
        return this.swapItems.length > 0;
    }

    get radarOption() {
        if (!this.result) return null;
        const best = this.bestTeams[0];
        const indicator = this.result.categories.map((c) => ({ name: c.label, max: 100 }));
        const series = [{ value: this.result.categories.map((c) => Math.round(c.ratio * 100)), name: '현재 조합', areaStyle: { opacity: 0.25 } }];
        if (best && best.total !== this.result.total) {
            series.push({ value: best.categories.map((c) => Math.round(c.ratio * 100)), name: `탐색 1위 (${best.total})`, lineStyle: { type: 'dashed' } });
        }
        return {
            color: ['#0176D3', '#FE9339'],
            tooltip: {},
            legend: { bottom: 0 },
            radar: { indicator, radius: '62%', axisName: { color: '#444', fontSize: 11 } },
            series: [{ type: 'radar', data: series }]
        };
    }

    get comboRows() {
        return this.bestTeams.slice(0, TOP_LIMIT).map((t, i) => ({
            id: LANES.map((l) => t.team[l].id).join('-'),
            rank: i + 1,
            ...Object.fromEntries(LANES.map((l) => [l, t.team[l].name])),
            total: t.total,
            grade: t.grade,
            synergy: t.synergies
                .filter((s) => s.score > 0)
                .slice(0, 3)
                .map((s) => `${s.nameA}+${s.nameB}`)
                .join(', ')
        }));
    }
    get searchSummary() {
        return `${this.evaluated.toLocaleString()}개 조합 평가${this.requireStructure ? ' (탑·정글 1탱+1브루저만)' : ''}`;
    }

    get poolTabs() {
        if (!this.ctx) return [];
        return LANES.map((lane) => ({
            lane,
            label: `${LANE_LABELS[lane]} (${this.ctx.byLane[lane].length})`,
            rows: this.ctx.byLane[lane].map((c) => ({ ...c, clsLabel: CLASS_LABELS[c.cls], winRateLabel: c.winRate ? `${c.winRate}%` : '미집계' }))
        }));
    }

    get analyzeDisabled() {
        return !this.result || this.analyzing || this.isWaiting;
    }
    get isClaudeCodeMode() {
        return this.mode !== 'API';
    }
    get analyzeLabel() {
        return this.isClaudeCodeMode ? 'Claude Code 분석 요청' : 'Claude 실시간 분석';
    }
    get analysisTitle() {
        return this.isClaudeCodeMode ? 'Claude 분석 (Claude Code · 웹 검색 포함)' : 'Claude 실시간 분석 (웹 검색 포함)';
    }
    get isWaiting() {
        return this.queued?.status === 'Pending' || this.queued?.status === 'Processing';
    }
    get showWaiting() {
        return this.isWaiting || !!this.queued?.stopped;
    }
    get waitingMessage() {
        if (!this.queued) return '';
        if (this.queued.stopped) {
            return `${this.queued.name || ''} 아직 처리되지 않았습니다. Claude Code 워커가 켜져 있는지 확인하세요. 처리되면 최근 요청에서 볼 수 있습니다.`;
        }
        return this.queued.status === 'Processing'
            ? `${this.queued.name} 분석 중 — ${this.queued.processedBy || 'Claude Code'}가 최신 메타를 검색하고 있습니다.`
            : this.isGuestUser
              ? `${this.queued.name || '요청'} 대기 중 — 보통 1~2분 걸립니다. 화면을 닫았다면 같은 조합으로 다시 요청하면 결과를 볼 수 있습니다.`
              : `${this.queued.name || '요청'} 대기 중 — 보통 1~2분 걸립니다. 화면을 닫아도 결과는 최근 요청에 남습니다.`;
    }
    get hasRecent() {
        return this.recentRequests.length > 0;
    }
    get recentRows() {
        return this.recentRequests.map((r) => ({
            id: r.Id,
            name: r.Name,
            composition: r.Composition__c,
            score: r.Total_Score__c,
            status: STATUS_LABELS[r.Status__c] || r.Status__c,
            statusClass: `status status-${(r.Status__c || '').toLowerCase()}`,
            created: r.CreatedDate ? new Date(r.CreatedDate).toLocaleString() : ''
        }));
    }
    get exportDisabled() {
        return !this.ctx;
    }
    get noData() {
        return !this.loadError;
    }
    // 방문자는 모두 같은 게스트 계정이라 "내 최근 요청"이 의미 없으므로 숨김
    get showRecent() {
        return this.isClaudeCodeMode && this.canAnalyze && !this.isGuestUser;
    }
    get showGuestNote() {
        return !!this.ctx && !this.canAnalyze;
    }
    get guestNoteText() {
        return this.isGuestUser ? '공개 사이트의 Claude 분석 요청이 현재 꺼져 있습니다. 조합 점수·추천 조합표·Excel 다운로드는 이용할 수 있습니다.' : 'Claude 분석 요청 권한이 없습니다. 관리자에게 권한 집합(LoL Team Builder User)을 요청하세요.';
    }
    get showGuestInfo() {
        return this.isGuestUser && this.canAnalyze;
    }
    get showAnalysisHint() {
        return this.canAnalyze && !this.analysis && !this.analyzing && !this.analysisError;
    }
    get analysisSections() {
        return parseReport(this.analysis?.text);
    }
    get analysisSources() {
        return (this.analysis?.sources || []).map((s, i) => ({ key: `src${i}`, ...s }));
    }
    get hasSources() {
        return this.analysisSources.length > 0;
    }
    get analysisMeta() {
        if (!this.analysis) return '';
        const parts = [this.analysis.requestName, this.analysis.composition, this.analysis.model || this.model, `웹 검색 ${this.analysis.searchCount || 0}회`];
        if (this.analysis.truncated) parts.push('응답이 길어 일부 생략됨');
        return parts.filter(Boolean).join(' · ');
    }

    // ===== 이벤트 =====
    handlePickChange(event) {
        this.picks = { ...this.picks, [event.target.dataset.lane]: event.detail.value };
    }

    handleTierChange(event) {
        this.tiers = { ...this.tiers, [event.target.dataset.lane]: event.detail.value };
    }

    handleLockChange(event) {
        this.locks = { ...this.locks, [event.target.dataset.lane]: event.target.checked };
    }

    handleStructureToggle(event) {
        this.requireStructure = event.target.checked;
    }

    handleSearch() {
        this.search();
    }

    handleApplyBest() {
        if (this.bestTeams.length) {
            this.applyTeam(this.bestTeams[0].team);
        }
    }

    handleComboAction(event) {
        const index = event.detail.row.rank - 1;
        this.applyTeam(this.bestTeams[index].team);
    }

    handleSwap(event) {
        const { lane, id } = event.currentTarget.dataset;
        this.picks = { ...this.picks, [lane]: id };
    }

    async handleExport() {
        try {
            if (!this.sheetJsPromise) {
                this.sheetJsPromise = loadScript(this, SHEETJS);
            }
            await this.sheetJsPromise;
            const tierLabels = Object.fromEntries(LANES.map((l) => [l, this.ctx.tiers.find((t) => t.key === this.tiers[l])?.label]));
            const wb = buildWorkbook(window.XLSX, {
                ctx: this.ctx,
                teams: this.bestTeams,
                current: this.result,
                explanation: this.explanation,
                swaps: this.swaps,
                tierLabels,
                teamGoal: this.teamGoal
            });
            const base64 = window.XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
            const link = document.createElement('a');
            link.href = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${base64}`;
            link.download = 'lol_team_comp.xlsx';
            link.click();
        } catch (error) {
            this.sheetJsPromise = undefined;
            this.analysisError = `Excel 생성 실패: ${errorMessage(error)}`;
        }
    }

    async handleAnalyze() {
        const result = this.result;
        if (!result) return;
        this.analyzing = true;
        this.analysisError = undefined;
        this.analysis = undefined;
        try {
            // 서버에는 ID·숫자만 전달 (프롬프트는 서버가 Custom Metadata로 조립)
            const request = {
                picks: { ...this.picks },
                tiers: { ...this.tiers },
                totalScore: result.total,
                categoryPoints: Object.fromEntries(result.categories.map((c) => [c.key, c.points]))
            };
            const json = JSON.stringify(request);
            if (this.isClaudeCodeMode) {
                const id = await submitAnalysisRequest({ requestJson: json });
                this.watchRequest(id);
                this.loadRecent();
            } else {
                const composition = LANES.map((l) => result.team[l].name).join(' / ');
                this.analysis = { ...(await startAnalysis({ requestJson: json })), composition };
            }
        } catch (error) {
            this.analysisError = errorMessage(error);
        } finally {
            this.analyzing = false;
        }
    }

    // ===== Claude Code 모드: 요청 상태 폴링 =====
    disconnectedCallback() {
        this.stopPolling();
    }

    stopPolling() {
        clearTimeout(this.pollTimer);
        this.pollTimer = undefined;
    }

    watchRequest(id) {
        this.stopPolling();
        this.analysis = undefined;
        this.analysisError = undefined;
        this.queued = { id, status: 'Pending', startedAt: Date.now() };
        this.poll();
    }

    async poll() {
        const id = this.queued?.id;
        if (!id) return;
        try {
            const rec = await getAnalysisRequest({ requestId: id });
            if (this.queued?.id !== id) return; // 그 사이 다른 요청을 선택함
            this.applyRequest(rec);
            if (this.isWaiting) {
                if (Date.now() - this.queued.startedAt < POLL_LIMIT_MS) {
                    // 처리 완료를 알려 줄 push 채널이 없으므로 주기적으로 확인 (화면을 떠나면 disconnectedCallback에서 중단)
                    // eslint-disable-next-line @lwc/lwc/no-async-operation
                    this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL_MS);
                } else {
                    this.queued = { ...this.queued, status: 'Stopped', stopped: true };
                }
            } else {
                this.loadRecent();
            }
        } catch (error) {
            this.analysisError = errorMessage(error);
            this.queued = undefined;
        }
    }

    applyRequest(rec) {
        this.queued = { ...this.queued, id: rec.Id, name: rec.Name, status: rec.Status__c, composition: rec.Composition__c, processedBy: rec.Processed_By__c };
        if (rec.Status__c === 'Completed') {
            this.analysis = {
                text: rec.Result__c,
                sources: parseSources(rec.Sources_JSON__c),
                searchCount: rec.Search_Count__c || 0,
                model: rec.Processed_By__c || 'Claude Code',
                requestName: rec.Name,
                composition: rec.Composition__c,
                truncated: false
            };
        } else if (rec.Status__c === 'Failed') {
            this.analysisError = `${rec.Name} 처리 실패: ${rec.Error_Message__c || '사유 없음'}`;
        }
    }

    async loadRecent() {
        if (!this.showRecent) {
            return; // 방문자·권한 없는 사용자는 목록을 쓰지 않으므로 호출 생략
        }
        try {
            this.recentRequests = await getRecentRequests();
        } catch {
            this.recentRequests = []; // 목록은 보조 정보라 실패해도 화면은 계속 사용
        }
    }

    handleOpenRequest(event) {
        this.watchRequest(event.currentTarget.dataset.id);
    }

    handleRefreshRecent() {
        this.loadRecent();
        if (this.queued?.stopped) {
            this.watchRequest(this.queued.id);
        }
    }
}
