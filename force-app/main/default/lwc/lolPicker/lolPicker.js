import { LightningElement, api } from 'lwc';

/**
 * 다크 테마 커스텀 드롭다운 (브라우저 기본 select·lightning-combobox 대체).
 * 옵션: { value, label(검색·접근성용 전체 문구), name, icon?, badge?, tone?(배지 명도 단계), chips?[], stat?{label,value}, preferred? }
 * 선택 시 lightning-combobox와 같은 모양의 change 이벤트(detail.value)를 보낸다 → 부모 코드는 그대로 사용.
 * 색·여백은 부모(lolTeamBuilder)의 CSS 변수(--text 등)를 상속받고, 없으면 기본값을 쓴다.
 */
export default class LolPicker extends LightningElement {
    @api options = [];
    @api value;
    @api placeholder = '선택';
    @api label = '';
    @api searchable = false; // 챔피언 목록처럼 길면 검색창 표시

    isOpen = false;
    query = '';
    activeIndex = -1;
    focusOnRender = false;

    get selected() {
        return (this.options || []).find((o) => o.value === this.value);
    }
    get selectedBadgeClass() {
        return `badge badge-${this.selected?.tone || 'none'}`;
    }
    get rootClass() {
        return this.isOpen ? 'picker picker_open' : 'picker';
    }
    get ariaExpanded() {
        return String(this.isOpen);
    }
    get filtered() {
        const q = this.query.trim().toLowerCase();
        const list = this.options || [];
        return q ? list.filter((o) => (o.label || o.name || '').toLowerCase().includes(q)) : list;
    }
    get rows() {
        return this.filtered.map((o, index) => {
            const selected = o.value === this.value;
            const active = index === this.activeIndex;
            return {
                ...o,
                index,
                key: o.value,
                ariaSelected: String(selected),
                badgeClass: `badge badge-${o.tone || 'none'}`,
                chipItems: (o.chips || []).map((text, i) => ({ key: `${o.value}-c${i}`, text })),
                hasChips: !!(o.chips && o.chips.length),
                cls: `option${selected ? ' option_selected' : ''}${active ? ' option_active' : ''}`
            };
        });
    }
    get isEmpty() {
        return this.filtered.length === 0;
    }

    // ===== 열기·닫기 =====
    open() {
        if (this.isOpen) return;
        this.query = '';
        const idx = (this.options || []).findIndex((o) => o.value === this.value);
        this.activeIndex = idx >= 0 ? idx : 0;
        this.isOpen = true;
        this.focusOnRender = true;
    }
    close(focusTrigger) {
        if (!this.isOpen) return;
        this.isOpen = false;
        if (focusTrigger) {
            this.template.querySelector('.trigger')?.focus();
        }
    }
    select(value) {
        this.close(true);
        if (value !== this.value) {
            this.dispatchEvent(new CustomEvent('change', { detail: { value } }));
        }
    }

    renderedCallback() {
        if (!this.isOpen) return;
        if (this.focusOnRender) {
            this.focusOnRender = false;
            (this.template.querySelector('.search-input') || this.template.querySelector('.list'))?.focus();
        }
        // 키보드로 옮긴 항목이 보이도록 스크롤
        this.template.querySelector('.option_active')?.scrollIntoView?.({ block: 'nearest' });
    }

    // ===== 이벤트 =====
    handleToggle() {
        if (this.isOpen) {
            this.close(true);
        } else {
            this.open();
        }
    }
    handleTriggerKeydown(event) {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            this.open();
        } else if (event.key === 'Escape') {
            this.close(true);
        }
    }
    handleSearch(event) {
        this.query = event.target.value;
        this.activeIndex = 0;
    }
    handleListKeydown(event) {
        const count = this.filtered.length;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            this.activeIndex = count ? (this.activeIndex + 1) % count : -1;
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            this.activeIndex = count ? (this.activeIndex - 1 + count) % count : -1;
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const row = this.filtered[this.activeIndex];
            if (row) this.select(row.value);
        } else if (event.key === 'Escape' || event.key === 'Tab') {
            if (event.key === 'Escape') event.preventDefault();
            this.close(event.key === 'Escape');
        }
    }
    handleOptionClick(event) {
        this.select(event.currentTarget.dataset.value);
    }
    handleOptionHover(event) {
        const index = Number(event.currentTarget.dataset.index);
        if (index !== this.activeIndex) this.activeIndex = index;
    }
    // 목록을 누르는 동안 포커스가 검색창에 남도록 (focusout으로 먼저 닫히지 않게)
    handleMenuMousedown(event) {
        event.preventDefault();
    }
    // 포커스가 이 컴포넌트 밖으로 나가면 닫기 (바깥 클릭 포함)
    handleFocusOut(event) {
        const next = event.relatedTarget;
        if (!next || !this.template.contains(next)) {
            this.close(false);
        }
    }
}
