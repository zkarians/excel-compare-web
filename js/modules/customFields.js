// --------------------------------------------------
// customFields.js - 사용자 정의 필드 로직
// --------------------------------------------------
let customFields = [];
// --- Custom Field System ---
async function loadCustomFields() {
    // 1순위: DB에서 조회
    try {
        const response = await fetch(`${API_BASE}/api/sync/custom-fields`);
        if (response.ok) {
            const data = await response.json();
            if (data.success && data.customFields && Array.isArray(data.customFields) && data.customFields.length > 0) {
                customFields = data.customFields;
                window.customFields = customFields;
                renderCustomFieldsUI();
                return;
            }
        }
    } catch (err) {
        console.error("DB 커스텀필드 로딩 실패:", err);
    }

    // 2순위: 로컬 스토리지
    const saved = localStorage.getItem('customFields');
    if (saved) {
        customFields = JSON.parse(saved);
        window.customFields = customFields;
        renderCustomFieldsUI();

        // DB가 비어있는 경우 로컬 설정을 DB로 업로드해둠
        saveCustomFields();
    }
}

async function saveCustomFields() {
    localStorage.setItem('customFields', JSON.stringify(customFields));
    try {
        await fetch(`${API_BASE}/api/sync/custom-fields`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customFields })
        });
    } catch (err) {
        console.error("DB 커스텀필드 저장 실패:", err);
    }
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
            <option value="downLoadType">[전산] Load Type</option>
            <option value="downPlanQty">[전산] Load Plan Qty</option>
            <option value="downPackingQty">[전산] Packing Qty</option>
            <option value="downSealNo">[전산] Seal No</option>
            <option value="downForwarder">[전산] 포워더</option>
            <option value="downCarrier">[전산] Carrier</option>
            <option value="downPort">[전산] L.Port</option>
            <option value="prodName">제품명</option>
            <option value="dest">목적지 (도착지)</option>
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

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        const btnExport = document.getElementById('btnExportSettings');
        const btnImport = document.getElementById('btnImportSettings');
        const inputImport = document.getElementById('inputImportSettings');

        if (btnExport) {
            btnExport.addEventListener('click', () => {
                const settings = {
                    customFields: customFields,
                    carrierMapPrefs: JSON.parse(localStorage.getItem('carrierMapPrefs') || '{}')
                };
                const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(settings, null, 4));
                const downloadAnchor = document.createElement('a');
                downloadAnchor.setAttribute("href", dataStr);
                downloadAnchor.setAttribute("download", "excel_compare_settings.json");
                document.body.appendChild(downloadAnchor);
                downloadAnchor.click();
                downloadAnchor.remove();
            });
        }

        if (btnImport) {
            btnImport.addEventListener('click', () => {
                btnImport.blur();
                inputImport.click();
            });
        }

        if (inputImport) {
            inputImport.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = async (evt) => {
                    try {
                        const settings = JSON.parse(evt.target.result);
                        if (!settings.customFields && !settings.carrierMapPrefs) {
                            throw new Error("유효한 설정 파일 형식이 아닙니다.");
                        }

                        if (settings.customFields) {
                            customFields = settings.customFields;
                            window.customFields = customFields;
                            localStorage.setItem('customFields', JSON.stringify(customFields));
                            await saveCustomFields(); // DB에도 전송
                        }

                        if (settings.carrierMapPrefs) {
                            localStorage.setItem('carrierMapPrefs', JSON.stringify(settings.carrierMapPrefs));
                            if (typeof window.saveCarrierMap === 'function') {
                                window.carrierMap = settings.carrierMapPrefs;
                                await window.saveCarrierMap();
                            }
                        }

                        renderCustomFieldsUI();
                        if (typeof window.renderCarrierSettings === 'function') {
                            window.renderCarrierSettings();
                        }

                        alert("✅ 설정 파일(.json)을 성공적으로 불러왔습니다. 화면을 새로고침합니다.");
                        location.reload();
                    } catch (err) {
                        alert("❌ 설정을 불러오는 중 오류가 발생했습니다: " + err.message);
                    }
                };
                reader.readAsText(file);
                inputImport.value = '';
            });
        }
    });
}