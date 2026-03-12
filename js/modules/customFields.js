// --------------------------------------------------
// customFields.js - 사용자 정의 필드 로직
// --------------------------------------------------
let customFields = [];
// --- Custom Field System ---
function loadCustomFields() {
    const saved = localStorage.getItem('customFields');
    if (saved) {
        customFields = JSON.parse(saved);
        renderCustomFieldsUI();
    }
}

function saveCustomFields() {
    localStorage.setItem('customFields', JSON.stringify(customFields));
}

function excelColToIdx(colStr) {
    if (!colStr) return -1;
    let col = String(colStr).trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (!col) return -1;
    let result = 0;
    for (let i = 0; i < col.length; i++) {
        result = result * 26 + (col.charCodeAt(i) - 64);
    }
    return result - 1; // 0-based index
}

function renderCustomFieldsUI() {
    const container = document.getElementById('customFieldsList');
    if (!container) return;
    container.innerHTML = '';

    customFields.forEach((cf, idx) => {
        const badge = document.createElement('div');
        badge.className = 'rule-condition-badge';
        badge.style.background = cf.source === 'down' ? '#eff6ff' : '#fff7ed';
        badge.style.borderColor = cf.source === 'down' ? '#bfdbfe' : '#ffedd5';
        badge.innerHTML = `
            <span style="font-size: 0.7rem; font-weight: bold; color: ${cf.source === 'down' ? '#3b82f6' : '#f97316'}; margin-right: 4px;">
                ${cf.source === 'down' ? '[전산]' : '[원본]'}
            </span>
            <span style="font-weight: 600;">${cf.name}</span>
            <small style="margin-left: 4px; color: #94a3b8;">(${cf.colLetter})</small>
            <i class="fas fa-times btn-remove-field" data-index="${idx}" style="margin-left: 8px; cursor: pointer; color: #94a3b8; font-size: 0.7rem;"></i>
        `;
        container.appendChild(badge);
    });

    document.querySelectorAll('.btn-remove-field').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = e.target.getAttribute('data-index');
            customFields.splice(index, 1);
            saveCustomFields();
            renderCustomFieldsUI();
        });
    });

    updateAllConditionDropdowns();
}

/**
 * 신규 필드가 추가되거나 삭제되었을 때, 
 * 현재 열려있는 모든 규칙 조건 드롭다운을 갱신합니다.
 */
function updateAllConditionDropdowns() {
    const dropdowns = document.querySelectorAll('.cond-field');
    dropdowns.forEach(select => {
        const currentValue = select.value;
        const baseOptions = `
            <option value="remark">비고/리마크 (원본 전체)</option>
            <option value="origRemark">[원본] 리마크</option>
            <option value="downRemark">[전산] 리마크</option>
            <option value="downLoadType">[전산] Load Type (B열)</option>
            <option value="downPlanQty">[전산] Load Plan Qty (J열)</option>
            <option value="downPackingQty">[전산] Packing Qty (N열)</option>
            <option value="downSealNo">[전산] Seal No (R열)</option>
            <option value="downForwarder">[전산] 포워더 (V열)</option>
            <option value="downCarrier">[전산] 선사 (X열)</option>
            <option value="downPort">[전산] L.Port (AB열)</option>
            <option value="prodName">제품명 (I열)</option>
            <option value="dest">도착지</option>
            <option value="prodType">제품구분 (예: CDZ, CVZ)</option>
        `;
        const dynamicOptions = customFields.map(cf => `
            <option value="${cf.id}">${cf.source === 'down' ? '[전산]' : '[원본]'} ${cf.name} (${cf.colLetter})</option>
        `).join('');

        select.innerHTML = baseOptions + dynamicOptions;

        // 이전에 선택되어 있던 값이 유효하면 복구
        if (Array.from(select.options).some(opt => opt.value === currentValue)) {
            select.value = currentValue;
        }
    });
}

window.customFields = customFields;
window.loadCustomFields = loadCustomFields;
window.saveCustomFields = saveCustomFields;
window.excelColToIdx = excelColToIdx;
window.renderCustomFieldsUI = renderCustomFieldsUI;
window.updateAllConditionDropdowns = updateAllConditionDropdowns;