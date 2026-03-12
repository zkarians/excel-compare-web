// --------------------------------------------------
// dynamicRules.js - 사용자 정의 동적 규칙 로직
// --------------------------------------------------
let dynamicRules = [];
const rulesModal = document.getElementById('rulesModal');

async function loadDynamicRules() {
    try {
        const response = await fetch(`${API_BASE}/api/rules`);
        const data = await response.json();
        if (data.success) {
            dynamicRules = (Array.isArray(data.rules) && data.rules.length > 0) ? data.rules : [
                {
                    "id": "dvq3f7e",
                    "isActive": true,
                    "conditionOperator": "AND",
                    "conditions": [
                        { "field": "prodName", "operator": "includes", "value": "LT1000P.AETC1" },
                        { "field": "downPlanQty", "operator": "ratioMismatch", "value": "downPackingQty:36" }
                    ],
                    "targetField": "errorDetail",
                    "targetValue": "<span style='color: #ef4444; font-weight: bold;'>(현재)계획:{{downPlanQty}} / 단위:{{downPackingQty}} -> 단위수량(Pack Qty) 1:36 오입력 확인 요망</span>",
                    "tagColor": "danger"
                },
                {
                    "id": "b8x9p2m",
                    "isActive": true,
                    "conditionOperator": "AND",
                    "conditions": [
                        { "field": "prodName", "operator": "includes", "value": "FSS-002.AETC" },
                        { "field": "downPlanQty", "operator": "ratioMismatch", "value": "downPackingQty:36" }
                    ],
                    "targetField": "errorDetail",
                    "targetValue": "<span style='color: #ef4444; font-weight: bold;'>(현재)계획:{{downPlanQty}} / 단위:{{downPackingQty}} -> 단위수량(Pack Qty) 1:36 오입력 확인 요망</span>",
                    "tagColor": "danger"
                }

            ];
            renderRulesTable();
        }
    } catch (err) {
        console.error("규칙 로딩 실패:", err);
    }
}

async function saveDynamicRules() {
    try {
        await fetch(`${API_BASE}/api/rules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rules: dynamicRules })
        });
    } catch (err) {
        console.error("규칙 저장 실패:", err);
        alert("규칙을 서버에 저장하는데 실패했습니다.");
    }
}

function createConditionRow() {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    row.className = 'condition-row';

    row.innerHTML = `
        <select class="cond-field" style="padding: 0.5rem; border: 1px solid #cbd5e1; border-radius: 6px;">
            <option value="remark">비고/리마크 (원본 전체)</option>
            <option value="origRemark">[원본] 리마크</option>
            <option value="downRemark">[전산] 리마크</option>
            <option value="downLoadType">[전산] Load Type (B열)</option>
            <option value="downPlanQty">[전산] Load Plan Qty (J열)</option>
            <option value="downPendingQty">[전산] Pending Qty (M열)</option>
            <option value="downPackingQty">[전산] Packing Qty (N열)</option>
            <option value="downSealNo">[전산] Seal No (R열)</option>
            <option value="downForwarder">[전산] 포워더 (V열)</option>
            <option value="downCarrier">[전산] 선사 (X열)</option>
            <option value="downPort">[전산] L.Port (AB열)</option>
            <option value="prodName">제품명 (I열)</option>
            <option value="dest">도착지</option>
            <option value="prodType">제품구분 (예: CDZ, CVZ)</option>
            <!-- 다이나믹 필드 추가 -->
            ${customFields.map(cf => `<option value="${cf.id}">${cf.source === 'down' ? '[전산]' : '[원본]'} ${cf.name} (${cf.colLetter})</option>`).join('')}
        </select>
        <span style="font-size: 0.9rem; color: #475569;">의 값이</span>
        <input type="text" class="cond-value" placeholder="예: 쇼링, 서부물류" style="flex: 1; padding: 0.5rem; border: 1px solid #cbd5e1; border-radius: 6px;">
        <select class="cond-operator" style="padding: 0.5rem; border: 1px solid #cbd5e1; border-radius: 6px;">
            <option value="includes">포함</option>
            <option value="notIncludes">미포함</option>
            <option value="startsWith">시작함</option>
            <option value="exact">정확히 일치</option>
            <option value="gte">이상 (>=)</option>
            <option value="gt">초과 (> )</option>
            <option value="lte">이하 (<=)</option>
            <option value="lt">미만 (< )</option>
            <option value="numEq">수치 동일 (=)</option>
            <option value="regexMatch">Regex 일치</option>
            <option value="regexNotMatch">Regex 미일치</option>
        </select>
        <button type="button" class="btn btn-danger btn-remove-cond" style="padding: 0.4rem 0.6rem; font-size: 0.8rem;">삭제</button>
    `;

    row.querySelector('.btn-remove-cond').addEventListener('click', () => {
        row.remove();
        updateConditionSeparators();
    });

    return row;
}

function updateConditionSeparators() {
    const container = document.getElementById('conditionRowsContainer');
    // Remove all existing separators
    container.querySelectorAll('.cond-separator').forEach(s => s.remove());
    const rows = container.querySelectorAll('.condition-row');
    if (rows.length <= 1) return;
    const op = document.getElementById('ruleConditionOperator').value;
    const isOr = op === 'OR';
    const color = isOr ? '#f59e0b' : '#3b82f6';
    const bgColor = isOr ? '#fffbeb' : '#eff6ff';
    const label = isOr ? 'OR' : 'AND';
    for (let i = 1; i < rows.length; i++) {
        const sep = document.createElement('div');
        sep.className = 'cond-separator';
        sep.style.cssText = `display:flex; align-items:center; gap:8px; margin: 2px 0; padding: 0 10px;`;
        sep.innerHTML = `<div style="flex:1; height:1px; background:${color};"></div><span style="font-size:0.8rem; font-weight:800; color:${color}; background:${bgColor}; padding:1px 10px; border-radius:10px; border:1.5px solid ${color};">${label}</span><div style="flex:1; height:1px; background:${color};"></div>`;
        container.insertBefore(sep, rows[i]);
    }
}

document.getElementById('ruleConditionOperator').addEventListener('change', () => {
    updateConditionSeparators();
});

document.getElementById('btnAddConditionRow').addEventListener('click', () => {
    document.getElementById('conditionRowsContainer').appendChild(createConditionRow());
    updateConditionSeparators();
});

function renderRulesTable() {
    const tbody = document.getElementById('rulesTableBody');
    const ruleCountEl = document.getElementById('ruleCount');
    tbody.innerHTML = '';

    if (ruleCountEl) ruleCountEl.textContent = dynamicRules.length;

    dynamicRules.forEach((rule, index) => {
        const tr = document.createElement('tr');

        // 1. 조건 렌더링 (배지 형태)
        let conditionsHtml = '<div style="display: flex; flex-wrap: wrap; gap: 6px;">';
        if (rule.conditions && rule.conditions.length > 0) {
            rule.conditions.forEach(cond => {
                let iconClass = 'fa-tag';
                let fText = cond.field;
                if (cond.field === 'remark') { fText = '비고(전체)'; iconClass = 'fa-sticky-note'; }
                else if (cond.field === 'origRemark') { fText = '원본비고'; iconClass = 'fa-comment-alt'; }
                else if (cond.field === 'downRemark') { fText = '전산비고'; iconClass = 'fa-comment'; }
                else if (cond.field === 'downLoadType') { fText = 'LoadType(B)'; iconClass = 'fa-truck-loading'; }
                else if (cond.field === 'downPlanQty') { fText = '계획수량(J)'; iconClass = 'fa-calculator'; }
                else if (cond.field === 'downPendingQty') { fText = '팬딩수량(M)'; iconClass = 'fa-clock'; }
                else if (cond.field === 'downPackingQty') { fText = '단위수량(N)'; iconClass = 'fa-boxes'; }
                else if (cond.field === 'downSealNo') { fText = 'Seal(R)'; iconClass = 'fa-lock'; }
                else if (cond.field === 'downForwarder') { fText = '포워더(V)'; iconClass = 'fa-shipping-fast'; }
                else if (cond.field === 'downCarrier') { fText = '선사(X)'; iconClass = 'fa-ship'; }
                else if (cond.field === 'downPort') { fText = 'L.Port(AB)'; iconClass = 'fa-anchor'; }
                else if (cond.field === 'dest') { fText = '도착지'; iconClass = 'fa-map-marker-alt'; }
                else if (cond.field === 'prodName') { fText = '제품명'; iconClass = 'fa-box'; }
                else if (cond.field === 'prodType') { fText = '품목'; iconClass = 'fa-cube'; }
                else if (cond.field.startsWith('f_')) {
                    const cf = customFields.find(f => f.id === cond.field);
                    fText = cf ? cf.name : '알수없는필드';
                    iconClass = 'fa-plus-circle';
                }

                let opText = '';
                if (cond.operator === 'includes') opText = '포함';
                else if (cond.operator === 'notIncludes') opText = '미포함';
                else if (cond.operator === 'startsWith') opText = '시작';
                else if (cond.operator === 'exact') opText = '일치';
                else if (cond.operator === 'gte') opText = '>=';
                else if (cond.operator === 'gt') opText = '>';
                else if (cond.operator === 'lte') opText = '<=';
                else if (cond.operator === 'lt') opText = '<';
                else if (cond.operator === 'numEq') opText = '=';
                else if (cond.operator === 'regexMatch') opText = 'Regex일치';
                else if (cond.operator === 'regexNotMatch') opText = 'Regex미일치';

                conditionsHtml += `
                    <div class="rule-condition-badge" title="${fText}">
                        <i class="fas ${iconClass}"></i>
                        <span style="color: #64748b; margin-right: 2px;">${fText}:</span>
                        <strong>${cond.value}</strong>
                        <small style="color: #94a3b8; margin-left: 2px;">(${opText})</small>
                    </div>`;
            });
        }
        conditionsHtml += '</div>';

        // 2. 타겟 텍스트 렌더링
        let targetText = '';
        if (rule.targetField === 'tags') {
            targetText = `특이사항 <span class="rule-result-tag tag-${rule.tagColor || 'secondary'}"><i class="fas fa-tag" style="font-size: 0.75rem; opacity: 0.8; margin-right: 4px;"></i>${rule.targetValue}</span> 추가`;
        }
        else if (rule.targetField === 'carrier') targetText = `선사 <span class="rule-result-tag tag-primary"><i class="fas fa-ship"></i> ${rule.targetValue}</span> 지정`;
        else if (rule.targetField === 'dest') targetText = `도착지 <span class="rule-result-tag tag-primary"><i class="fas fa-map-marked-alt"></i> ${rule.targetValue}</span> 변경`;
        else if (rule.targetField === 'errorDetail') targetText = `상세사유 <span class="rule-result-tag tag-danger">${rule.targetValue}</span> 기록`;
        else if (rule.targetField === 'planQty') targetText = `계획수량(Plan) <strong>${rule.targetValue}</strong> 적용`;
        else if (rule.targetField === 'loadQty') targetText = `적재수량(Loading) <strong>${rule.targetValue}</strong> 적용`;
        else if (rule.targetField === 'packingQty') targetText = `단위수량(Packing) <strong>${rule.targetValue}</strong> 적용`;
        else if (rule.targetField === 'transporter') {
            let color = rule.targetValue.includes('천마') ? '#ef4444' : (rule.targetValue.includes('BNI') ? '#3b82f6' : '#64748b');
            targetText = `운송사 <span class="rule-result-tag" style="background-color: ${color}; color: white;">${rule.targetValue}</span> 지정`;
        }

        const isOr = rule.conditionOperator === 'OR';
        const opBadgeColor = isOr ? '#f59e0b' : '#3b82f6';
        const opTextDisplay = isOr ? '⚡ OR (하나라도 만족)' : '🔗 AND (모두 만족)';
        const opBorderColor = isOr ? '#fbbf24' : '#60a5fa';

        tr.innerHTML = `
            <td style="text-align: center;">
                <input type="checkbox" class="rule-active-toggle" data-index="${index}" ${rule.isActive ? 'checked' : ''}>
            </td>
            <td style="font-weight: 600; color: #1e293b;">${rule.groupName || '-'}</td>
            <td style="padding: 12px 10px;">
                <div style="margin-bottom: 6px; padding: 3px 8px; background: ${opBadgeColor}; color: white; border-radius: 6px; display: inline-block; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.5px;">${opTextDisplay}</div>
                ${conditionsHtml}
            </td>
            <td>${targetText}</td>
            <td style="text-align: center; white-space: nowrap;">
                <button class="btn btn-secondary-outline btn-edit-rule" data-index="${index}" style="padding: 0.3rem 0.6rem; font-size: 0.75rem; border-radius: 4px; margin-right: 4px;">수정</button>
                <button class="btn btn-copy-rule" data-index="${index}" style="padding: 0.3rem 0.6rem; font-size: 0.75rem; border-radius: 4px; margin-right: 4px; background-color: #e0f2fe; color: #0284c7; border: 1px solid #7dd3fc; cursor: pointer;" title="이 규칙을 복사합니다"><i class="fas fa-copy"></i> 복사</button>
                <button class="btn btn-danger btn-delete-rule" data-index="${index}" style="padding: 0.3rem 0.6rem; font-size: 0.75rem; border-radius: 4px; background-color: #fee2e2; color: #dc2626;">삭제</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.querySelectorAll('.rule-active-toggle').forEach(chk => {
        chk.addEventListener('change', (e) => {
            const idx = e.target.getAttribute('data-index');
            dynamicRules[idx].isActive = e.target.checked;
            saveDynamicRules();
        });
    });

    document.querySelectorAll('.btn-delete-rule').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = e.target.getAttribute('data-index');
            if (confirm("이 규칙을 삭제하시겠습니까? (삭제 즉시 서버에 반영됩니다)")) {
                dynamicRules.splice(idx, 1);
                saveDynamicRules();
                renderRulesTable();
            }
        });
    });
}

document.getElementById('btnOpenRules').addEventListener('click', () => {
    loadDynamicRules();
    // 모달 열 때 기본 조건 행 1개 보장
    const container = document.getElementById('conditionRowsContainer');
    container.innerHTML = '';
    container.appendChild(createConditionRow());
    rulesModal.style.display = 'block';
});

document.querySelectorAll('#closeRulesBtn, #closeRulesBtnBottom').forEach(btn => {
    btn.addEventListener('click', () => {
        rulesModal.style.display = 'none';
        // 창을 닫을 때 현재 데이터를 기준으로 다시 비교 실행 (데이터가 있을 때만)
        if (originalData.length > 0 && downloadData.length > 0) {
            comparisonResult = compareData(originalData, downloadData);
            updateDashboard();
            displayResults(comparisonResult);
        }
    });
});

window.addEventListener('click', (event) => {
    if (event.target == rulesModal) {
        rulesModal.style.display = 'none';
        // 창을 닫을 때 현재 데이터를 기준으로 다시 비교 실행 (데이터가 있을 때만)
        if (originalData.length > 0 && downloadData.length > 0) {
            comparisonResult = compareData(originalData, downloadData);
            updateDashboard();
            displayResults(comparisonResult);
        }
    }
});

document.getElementById('ruleTargetField').addEventListener('change', (e) => {
    const transporterSelect = document.getElementById('ruleTargetTransporter');
    const valueInput = document.getElementById('ruleTargetValue');
    const valLabel = document.getElementById('ruleValLabel');

    if (e.target.value === 'tags') colorSelect.style.display = 'inline-block';
    else colorSelect.style.display = 'none';

    if (e.target.value === 'planQty' || e.target.value === 'loadQty') {
        qtyHintText.style.display = 'block';
    } else {
        qtyHintText.style.display = 'none';
    }

    if (e.target.value === 'transporter') {
        transporterSelect.style.display = 'inline-block';
        valueInput.style.display = 'none';
        valLabel.textContent = '운송사를';
    } else {
        transporterSelect.style.display = 'none';
        valueInput.style.display = 'inline-block';
        valLabel.textContent = '값을';
    }
});

document.getElementById('btnAddRule').addEventListener('click', () => {
    const groupName = document.getElementById('ruleGroupName').value.trim();
    const rows = document.querySelectorAll('.condition-row');
    const conditions = [];

    rows.forEach(row => {
        const field = row.querySelector('.cond-field').value;
        const operator = row.querySelector('.cond-operator').value;
        const value = row.querySelector('.cond-value').value.trim();
        if (value) {
            conditions.push({ field, operator, value });
        }
    });

    if (conditions.length === 0) {
        alert("최소 1개 이상의 조건을 입력해야 합니다.");
        return;
    }

    const conditionOperator = document.getElementById('ruleConditionOperator').value;
    const targetField = document.getElementById('ruleTargetField').value;
    let targetValue = document.getElementById('ruleTargetValue').value.trim();
    if (targetField === 'transporter') {
        targetValue = document.getElementById('ruleTargetTransporter').value;
    }
    const tagColor = document.getElementById('ruleTagColor').value;

    if (!targetValue && targetField !== 'planQty' && targetField !== 'loadQty') {
        alert("원하는 변경 결과를 입력하거나 선택해주세요.");
        return;
    }

    const editId = document.getElementById('editRuleId').value;
    if (editId) {
        // 수정 모드
        const idx = dynamicRules.findIndex(r => r.id === editId);
        if (idx !== -1) {
            dynamicRules[idx] = {
                ...dynamicRules[idx],
                groupName,
                conditionOperator,
                conditions,
                targetField,
                targetValue,
                tagColor: targetField === 'tags' ? tagColor : null
            };
        }
    } else {
        // 신규 추가
        dynamicRules.push({
            id: Date.now().toString(),
            isActive: true,
            groupName: groupName,
            conditionOperator: conditionOperator,
            conditions: conditions,
            targetField,
            targetValue,
            tagColor: targetField === 'tags' ? tagColor : null
        });
    }

    saveDynamicRules();
    renderRulesTable();

    // 입력폼 리셋
    resetRuleForm();
});

function resetRuleForm() {
    document.getElementById('editRuleId').value = '';
    document.getElementById('ruleFormTitle').textContent = '✨ 새로운 규칙 정의';
    document.getElementById('btnCancelRuleEdit').style.display = 'none';
    document.getElementById('btnAddRule').textContent = '규칙 등록';

    document.getElementById('ruleConditionOperator').value = 'AND';
    document.getElementById('ruleGroupName').value = '';
    document.getElementById('ruleTargetValue').value = '';
    document.getElementById('ruleTargetField').value = 'tags';
    document.getElementById('ruleTagColor').style.display = 'inline-block';
    document.getElementById('ruleTargetTransporter').style.display = 'none';
    document.getElementById('ruleTargetValue').style.display = 'inline-block';
    document.getElementById('ruleValLabel').textContent = '값을';

    const container = document.getElementById('conditionRowsContainer');
    container.innerHTML = '';
    container.appendChild(createConditionRow());
}

document.getElementById('ruleBtnGroup').appendChild(btnCancelEdit); // Fragment 대신 직접 추가? 아님 이미 있으니 리스너만.
// 취소 버튼
document.getElementById('btnCancelRuleEdit').addEventListener('click', resetRuleForm);

// 다이나믹 필드 추가 버튼
const btnAddCustomField = document.getElementById('btnAddCustomField');
if (btnAddCustomField) {
    btnAddCustomField.addEventListener('click', () => {
        const source = document.getElementById('newFieldSource').value;
        const colStr = document.getElementById('newFieldCol').value.trim();
        const name = document.getElementById('newFieldName').value.trim();

        if (!colStr || !name) {
            alert("엑셀 열(예: AC)과 나타낼 이름을 모두 입력해주세요.");
            return;
        }

        const colIdx = excelColToIdx(colStr);
        if (colIdx < 0) {
            alert("올바른 엑셀 열(A, B, C...)을 입력해주세요.");
            return;
        }

        const id = "f_" + Date.now();
        customFields.push({
            id: id,
            source: source,
            colIdx: colIdx,
            colLetter: colStr.toUpperCase(),
            name: name
        });

        saveCustomFields();
        renderCustomFieldsUI();

        // 입력창 초기화
        document.getElementById('newFieldCol').value = '';
        document.getElementById('newFieldName').value = '';
        alert(`필드 '${name}'가 추가되었습니다.`);
    });
}

// renderRulesTable 내부에서 호출되어야 함 (이벤트 위임 방식으로 변경 제안)
document.getElementById('rulesTableBody').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    // --- 복사 버튼 ---
    if (btn.classList.contains('btn-copy-rule')) {
        const idx = btn.getAttribute('data-index');
        const rule = dynamicRules[idx];
        const copiedRule = {
            id: Date.now().toString(),
            isActive: rule.isActive,
            groupName: (rule.groupName || '') + ' (복사)',
            conditionOperator: rule.conditionOperator || 'AND',
            conditions: rule.conditions ? rule.conditions.map(c => ({ ...c })) : [],
            targetField: rule.targetField,
            targetValue: rule.targetValue,
            tagColor: rule.tagColor || null
        };
        dynamicRules.splice(Number(idx) + 1, 0, copiedRule);
        saveDynamicRules();
        renderRulesTable();
        return;
    }

    // --- 수정 버튼 ---
    if (btn.classList.contains('btn-edit-rule')) {
        const idx = btn.getAttribute('data-index');
        const rule = dynamicRules[idx];

        document.getElementById('editRuleId').value = rule.id;
        document.getElementById('ruleFormTitle').textContent = '📝 규칙 수정 중...';
        document.getElementById('btnCancelRuleEdit').style.display = 'inline-block';
        document.getElementById('btnAddRule').textContent = '수정 완료';

        document.getElementById('ruleConditionOperator').value = rule.conditionOperator || 'AND';
        document.getElementById('ruleGroupName').value = rule.groupName || '';
        document.getElementById('ruleTargetField').value = rule.targetField;

        if (rule.targetField === 'transporter') {
            document.getElementById('ruleTargetTransporter').value = rule.targetValue;
            document.getElementById('ruleTargetTransporter').style.display = 'inline-block';
            document.getElementById('ruleTargetValue').style.display = 'none';
            document.getElementById('ruleValLabel').textContent = '운송사를';
        } else {
            document.getElementById('ruleTargetValue').value = rule.targetValue || '';
            document.getElementById('ruleTargetTransporter').style.display = 'none';
            document.getElementById('ruleTargetValue').style.display = 'inline-block';
            document.getElementById('ruleValLabel').textContent = '값을';
        }

        document.getElementById('ruleTagColor').value = rule.tagColor || 'success';
        document.getElementById('ruleTagColor').style.display = rule.targetField === 'tags' ? 'inline-block' : 'none';

        const container = document.getElementById('conditionRowsContainer');
        container.innerHTML = '';
        if (rule.conditions && rule.conditions.length > 0) {
            rule.conditions.forEach(c => {
                const row = createConditionRow();
                row.querySelector('.cond-field').value = c.field;
                row.querySelector('.cond-operator').value = c.operator;
                row.querySelector('.cond-value').value = c.value;
                container.appendChild(row);
            });
        } else {
            container.appendChild(createConditionRow());
        }

        // 스크롤 이동
        document.querySelector('.rule-form-card').scrollIntoView({ behavior: 'smooth' });
    }
});

// --- Cloud Sync Logic ---
async function uploadRulesToServer() {
    try {
        const resp = await fetch(`${API_BASE}/api/sync/rules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rules: dynamicRules })
        });
        const data = await resp.json();
        if (data.success) {
            alert("✅ 자동분류 규칙이 클라우드에 업로드되었습니다.");
            if (window.updateDbGlobalStats) window.updateDbGlobalStats();
        } else {
            alert("❌ 업로드 실패: " + data.message);
        }
    } catch (err) {
        console.error("Cloud Upload Error:", err);
        alert("❌ 클라우드 연결 오류가 발생했습니다.");
    }
}

async function downloadRulesFromServer() {
    if (!confirm("클라우드에서 데이터를 내려받으면 현재 로컬의 규칙 설정이 덮어씌워집니다. 진행하시겠습니까?")) return;
    try {
        const resp = await fetch(`${API_BASE}/api/sync/rules`);
        const data = await resp.json();
        if (data.success) {
            dynamicRules = data.rules;
            // 로컬 파일(rules.json)에도 저장 (서버 API 활용)
            await saveDynamicRules();
            renderRulesTable();
            alert("✅ 클라우드에서 자동분류 규칙을 성공적으로 내려받았습니다.");
            if (window.updateDbGlobalStats) window.updateDbGlobalStats();
        } else {
            alert("❌ 다운로드 실패: " + data.message);
        }
    } catch (err) {
        console.error("Cloud Download Error:", err);
        alert("❌ 클라우드 연결 오류가 발생했습니다.");
    }
}

document.getElementById('btnCloudUploadRules')?.addEventListener('click', uploadRulesToServer);
document.getElementById('btnCloudDownloadRules')?.addEventListener('click', downloadRulesFromServer);

// --- Exports ---
window.dynamicRules = dynamicRules;
window.loadDynamicRules = loadDynamicRules;
window.saveDynamicRules = saveDynamicRules;
window.createConditionRow = createConditionRow;
window.renderRulesTable = renderRulesTable;
window.resetRuleForm = resetRuleForm;
window.uploadRulesToServer = uploadRulesToServer;
window.downloadRulesFromServer = downloadRulesFromServer;