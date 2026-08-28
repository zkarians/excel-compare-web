// API 서버 베이스 URL 설정 (Electron=localhost:3000, Web=현재 도메인)
const API_BASE = (window.isElectron || window.location.hostname === 'localhost')
    ? 'http://localhost:3000'
    : window.location.origin;

/* =========================================================================
 *  GLOBAL STATE & VARIABLES
 * ========================================================================= */
let originalFile = null;
let reworkFile = null; // 재작업 파일 (선택)
let downloadFile = null;
let warehouseFile = null; // 창고재고 파일 정보
let masterFileBuffer = null; // 마스터 파일 버퍼

// 창고재고 관련 전역 상태
let warehouseData = []; // 창고재고 데이터 (파싱됨)
let warehouseStockDongPrefixes = new Set(); // 창고재고 파일에서 파싱한 (동) 태그 접두어 집합

// 활성 데이터 (현재 필터 및 체크박스 적용 상태)
let warehouseStockBlockProducts = new Set(); // 현재 활성 Block Qty > 0 인 제품명 집합
let warehouseStockQtyMap = {}; // 현재 활성 제품명별 실물재고, 사용불가재고, 사용가능재고 맵 { "PROD": { physical, block, available } }
let warehouseHoldStockList = []; // 현재 활성 블록 재고 목록 (H, L, B 수량 존재 건)

// 백업 데이터 (17구역 포함/제외 데이터 분리 저장)
let warehouseStockBlockProductsAll = new Set();
let warehouseStockBlockProductsNo17 = new Set();
let warehouseStockQtyMapAll = {};
let warehouseStockQtyMapNo17 = {};
let warehouseHoldStockListAll = [];
let warehouseHoldStockListNo17 = [];
let warehouseAllStockList = [];
let warehouseAllStockListAll = [];
let warehouseAllStockListNo17 = [];

let warehouseStockLoaded = false; // 창고재고 파일 업로드 여부

// 17구역 포함 여부 변경에 따른 활성 데이터 업데이트 및 UI 동적 리렌더링
function updateActiveWarehouseStock() {
    const chkInclude17 = document.getElementById('chkInclude17');
    const include17 = chkInclude17 ? chkInclude17.checked : false;

    warehouseStockBlockProducts = include17 ? warehouseStockBlockProductsAll : warehouseStockBlockProductsNo17;
    warehouseStockQtyMap = include17 ? warehouseStockQtyMapAll : warehouseStockQtyMapNo17;
    warehouseHoldStockList = include17 ? warehouseHoldStockListAll : warehouseHoldStockListNo17;
    warehouseAllStockList = include17 ? warehouseAllStockListAll : warehouseAllStockListNo17;

    console.log(`🔄 [재고 필터 변경] 17구역 포함: ${include17} (활성 제품 수: ${Object.keys(warehouseStockQtyMap).length}개, 홀드 리스트: ${warehouseHoldStockList.length}건)`);

    // UI 즉시 재렌더링
    if (comparisonResult && comparisonResult.length > 0) {
        displayResults(comparisonResult, false);
    }
}

// ===================================================================
// [신규] IndexedDB 기반 작업 세션 영구 보관 & 자동 복원 엔진
// ===================================================================
const SessionDB = {
    dbName: 'ExcelCompareSessionDB_v1',
    storeName: 'workSessions',

    open: function() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'id' });
                }
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = (e) => reject(e.target.error);
        });
    },

    save: async function(id, data) {
        try {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                store.put({ id, data, updatedAt: Date.now() });
                tx.oncomplete = () => resolve(true);
                tx.onerror = (e) => reject(e.target.error);
            });
        } catch (err) {
            console.warn('SessionDB.save error:', err);
        }
    },

    get: async function(id) {
        try {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const req = store.get(id);
                req.onsuccess = () => resolve(req.result ? req.result.data : null);
                req.onerror = (e) => reject(e.target.error);
            });
        } catch (err) {
            console.warn('SessionDB.get error:', err);
            return null;
        }
    },

    clear: async function() {
        try {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                store.clear();
                tx.oncomplete = () => resolve(true);
                tx.onerror = (e) => reject(e.target.error);
            });
        } catch (err) {
            console.warn('SessionDB.clear error:', err);
        }
    }
};

async function fileToArrayBuffer(file) {
    if (!file) return null;
    if (file instanceof ArrayBuffer) return file;
    if (typeof file.arrayBuffer === 'function') {
        return await file.arrayBuffer();
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

window.autoSaveWorkSession = async function() {
    try {
        const filesPayload = {};
        const rawMap = window.savedRawFiles || {};

        for (const key of ['original', 'download', 'rework', 'warehouse']) {
            const f = rawMap[key];
            if (f && f.name) {
                try {
                    const buf = await fileToArrayBuffer(f);
                    if (buf) {
                        filesPayload[key] = {
                            name: f.name,
                            type: f.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                            size: f.size,
                            buffer: buf
                        };
                    }
                } catch (fe) {
                    console.warn(`Failed to buffer file ${key}:`, fe);
                }
            }
        }

        const sessionData = {
            timestamp: Date.now(),
            files: filesPayload,
            comparisonResult: (typeof comparisonResult !== 'undefined' && comparisonResult && comparisonResult.length > 0) ? comparisonResult : (window.comparisonResult || null),
            originalData: typeof originalData !== 'undefined' ? originalData : null,
            downloadData: typeof downloadData !== 'undefined' ? downloadData : null,
            reworkData: typeof reworkData !== 'undefined' ? reworkData : null,
            warehouseStockLoaded: typeof warehouseStockLoaded !== 'undefined' ? warehouseStockLoaded : false,
            processedAvailabilityData: typeof processedAvailabilityData !== 'undefined' ? processedAvailabilityData : null
        };

        await SessionDB.save('currentSession', sessionData);
        console.log('💾 [SessionDB] 작업 세션 자동 저장 완료 (파일 수:', Object.keys(filesPayload).length, ')');
    } catch (err) {
        console.warn('autoSaveWorkSession error:', err);
    }
};

window.autoRestoreWorkSession = async function() {
    try {
        const session = await SessionDB.get('currentSession');
        if (!session || !session.files || Object.keys(session.files).length === 0) {
            return false;
        }

        console.log('🔄 [SessionDB] 이전 작업 세션 발견! 자동 복원 시작...', session);

        window.savedRawFiles = window.savedRawFiles || {};

        // 1. 파일 객체 복원
        if (session.files.original && session.files.original.buffer) {
            originalFile = new File([session.files.original.buffer], session.files.original.name, { type: session.files.original.type });
            window.savedRawFiles['original'] = originalFile;
            const statOrig = document.getElementById('statusOriginal');
            if (statOrig) {
                statOrig.textContent = `업로드됨: ${originalFile.name}`;
                statOrig.style.color = '#1e293b';
            }
            const lastOrigEl = document.getElementById('lastOrig');
            if (lastOrigEl) lastOrigEl.textContent = `최근 사용: ${originalFile.name}`;
            const btnRelOrig = document.getElementById('btnReloadOriginal');
            if (btnRelOrig) btnRelOrig.style.display = 'inline-block';
        }

        if (session.files.download && session.files.download.buffer) {
            downloadFile = new File([session.files.download.buffer], session.files.download.name, { type: session.files.download.type });
            window.savedRawFiles['download'] = downloadFile;
            const statDown = document.getElementById('statusDownload');
            if (statDown) {
                statDown.textContent = `업로드됨: ${downloadFile.name}`;
                statDown.style.color = '#1e293b';
            }
            const lastDownEl = document.getElementById('lastDown');
            if (lastDownEl) lastDownEl.textContent = `최근 사용: ${downloadFile.name}`;
            const btnRelDown = document.getElementById('btnReloadDownload');
            if (btnRelDown) btnRelDown.style.display = 'inline-block';
        }

        if (session.files.rework && session.files.rework.buffer) {
            reworkFile = new File([session.files.rework.buffer], session.files.rework.name, { type: session.files.rework.type });
            window.savedRawFiles['rework'] = reworkFile;
            const statRework = document.getElementById('statusRework');
            if (statRework) {
                statRework.textContent = `업로드됨: ${reworkFile.name}`;
                statRework.style.color = '#1e293b';
            }
            const btnClrRework = document.getElementById('btnClearRework');
            if (btnClrRework) btnClrRework.style.display = 'inline-block';
        }

        if (session.files.warehouse && session.files.warehouse.buffer) {
            const wsFile = new File([session.files.warehouse.buffer], session.files.warehouse.name, { type: session.files.warehouse.type });
            window.savedRawFiles['warehouse'] = wsFile;
            const wsStat = document.getElementById('statusWarehouseStock');
            if (wsStat) {
                wsStat.textContent = `업로드됨: ${wsFile.name}`;
                wsStat.style.color = '#1e293b';
            }
            const btnClrWs = document.getElementById('btnClearWarehouseStock');
            if (btnClrWs) btnClrWs.style.display = 'inline-block';
        }

        if (session.originalData) originalData = session.originalData;
        if (session.downloadData) downloadData = session.downloadData;
        if (session.reworkData) reworkData = session.reworkData;
        if (session.processedAvailabilityData) processedAvailabilityData = session.processedAvailabilityData;

        // 2. 비교 결과 복원
        if (session.comparisonResult && session.comparisonResult.length > 0) {
            comparisonResult = session.comparisonResult;
            window.comparisonResult = session.comparisonResult;
            window.displayData = session.comparisonResult;

            const dashEl = document.getElementById('dashboardContainer');
            const resEl = document.getElementById('resultsContainer');
            if (dashEl) dashEl.style.display = 'flex';
            if (resEl) resEl.style.display = 'block';

            if (typeof renderTable === 'function') {
                renderTable(window.comparisonResult);
            }
            if (typeof updateStats === 'function') {
                updateStats();
            }
            if (window.fetchContainerPhotoCounts) {
                window.fetchContainerPhotoCounts();
            }

            window.showSessionRestoredBanner(session.timestamp);
        }

        if (typeof checkReadyStatus === 'function') {
            checkReadyStatus();
        }

        return true;
    } catch (err) {
        console.warn('autoRestoreWorkSession error:', err);
        return false;
    }
};

window.clearWorkSession = async function() {
    if (confirm("저장된 이전 작업 세션(업로드된 4개 엑셀 파일 및 비교 결과)을 모두 초기화하시겠습니까?")) {
        await SessionDB.clear();
        location.reload();
    }
};

window.showSessionRestoredBanner = function(timestamp) {
    let banner = document.getElementById('sessionRestoredBanner');
    if (banner) banner.remove();

    const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString() : '';

    banner = document.createElement('div');
    banner.id = 'sessionRestoredBanner';
    banner.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 999999;
        background: rgba(15, 23, 42, 0.95);
        color: #f8fafc;
        border: 1px solid #38bdf8;
        border-radius: 12px;
        padding: 9px 15px;
        box-shadow: 0 12px 30px rgba(0,0,0,0.5);
        backdrop-filter: blur(12px);
        display: flex;
        align-items: center;
        gap: 10px;
        animation: popoverFadeIn 0.3s ease;
        font-family: inherit;
    `;
    banner.innerHTML = `
        <span style="font-size: 1.1rem; color: #38bdf8;">🔄</span>
        <div style="font-size: 0.85rem; font-weight: 800; color: #38bdf8; white-space: nowrap;">
            세션복원완료 <span style="font-size:0.75rem; color:#94a3b8; font-weight:600;">(${timeStr})</span>
        </div>
        <button type="button" onclick="window.clearWorkSession()" style="background: rgba(239,68,68,0.2); border: 1px solid rgba(239,68,68,0.5); color: #fca5a5; border-radius: 6px; padding: 4px 8px; font-size: 0.75rem; font-weight: 800; cursor: pointer; white-space: nowrap; margin-left: 4px;">
            <i class="fas fa-trash-alt"></i> 새로 시작
        </button>
        <button type="button" onclick="document.getElementById('sessionRestoredBanner').remove()" style="background: transparent; border: none; color: #94a3b8; font-size: 1.1rem; cursor: pointer; padding: 0 2px; line-height: 1;">&times;</button>
    `;
    document.body.appendChild(banner);

    setTimeout(() => {
        if (banner && banner.parentNode) {
            banner.style.opacity = '0';
            banner.style.transition = 'opacity 0.5s ease';
            setTimeout(() => banner.remove(), 500);
        }
    }, 6000);
};

// POP 샘플 무게 전역 상태 { "CNTR_NO": { weight: 150.5, memo: "샘플" } }
let popWeightMap = {};

let originalData = [];
let reworkData = []; // 파싱된 재작업 데이터
let reworkContainers = new Set(); // 재작업 파일에 존재하는 컨테이너 번호 집합
let downloadData = [];
let comparisonResult = [];
let displayData = []; // 현재 화면에 표시 중인 (필터링된) 전체 데이터
let excludedList = []; // 제외된 컨테이너 목록 (작업일 없음)
let lastDbSearchResults = []; // 마지막 DB 검색 결과 (탭 전환 시 유지용)
let currentFilter = 'success';
let selectedItems = new Set(); // DB 저장을 위해 선택된 항목
let cautionModels = []; // 주의 모델 목록 [{ modelName, remark }]

window.toggleSelectItem = (itemKey, event) => {
    if (event.target.checked) {
        selectedItems.add(itemKey);
    } else {
        selectedItems.delete(itemKey);
    }
    updateSelectionUI();
    // 행 배경색만 즉시 변경 (전체 렌더링 피함)
    const tr = event.target.closest('tr');
    if (tr) tr.classList.toggle('selected-row', event.target.checked);
};
let holdContainerMap = new Map(); // 보류 컨테이너 상태 (DB 연동)
let productMaster = []; // 엑셀에서 추출한 제품 마스터
let manualApprovedItems = new Set(); // 수동 승인 항목 보관 (Session level)

window.approveHItem = (cntrNo, prodName) => {
    const cleanCntr = (cntrNo || "").trim();
    const cleanProd = (prodName || "").trim();
    if (confirm(`[${cleanCntr}] 의 ${cleanProd} 모델을 정상으로 승인하시겠습니까?`)) {
        manualApprovedItems.add(`${cleanCntr}_${cleanProd}`);
        if (typeof comparisonResult !== 'undefined' && Array.isArray(comparisonResult)) {
            // 동일 사유 일괄 승인 로직
            const targetItem = comparisonResult.find(r => (r.cntrNo || "").trim() === cleanCntr && (r.prodName || "").trim() === cleanProd);
            if (targetItem && targetItem.isErrorRow && targetItem.detail) {
                const detailReason = targetItem.detail;
                // 에러이면서 사유가 동일하고, 컨테이너 번호가 동일하며, 아직 승인되지 않은 다른 항목들 찾기
                const similarItems = comparisonResult.filter(r =>
                    r.isErrorRow &&
                    r.detail === detailReason &&
                    (r.cntrNo || "").trim() === cleanCntr &&
                    !((r.cntrNo || "").trim() === cleanCntr && (r.prodName || "").trim() === cleanProd) &&
                    !manualApprovedItems.has(`${(r.cntrNo || "").trim()}_${(r.prodName || "").trim()}`)
                );

                if (similarItems.length > 0) {
                    // HTML 태그 제거된 사유로 표시 (디스플레이용)
                    const displayReason = detailReason.replace(/<[^>]*>?/gm, '');
                    if (confirm(`동일오류로 인해 발생된 오류건(${similarItems.length}건)은 모두 승인하시겠습니까?\n사유: ${displayReason}`)) {
                        similarItems.forEach(item => {
                            manualApprovedItems.add(`${(item.cntrNo || "").trim()}_${(item.prodName || "").trim()}`);
                        });
                    }
                }
            }

            updateDashboard(); // 상단 요약 갱신
            displayResults(comparisonResult, false); // 테이블 갱신
        }
    }
};

window.cancelApproveHItem = (cntrNo, prodName) => {
    const cleanCntr = (cntrNo || "").trim();
    const cleanProd = (prodName || "").trim();
    manualApprovedItems.delete(`${cleanCntr}_${cleanProd}`);
    if (typeof comparisonResult !== 'undefined' && Array.isArray(comparisonResult)) {
        updateDashboard();
        displayResults(comparisonResult, false);
    }
};

window.updateWeightChoice = (cntrNo, choice) => {
    userSelectedWeights[cntrNo] = choice;
    displayResults(comparisonResult, false);
};

/* =========================================================================
 *  CONTAINER HOLD LOGIC (DB SYNC)
 * ========================================================================= */
async function loadHoldContainers() {
    try {
        const resp = await fetch(`${API_BASE}/api/sync/holds`);
        if (resp.ok) {
            const data = await resp.json();
            if (data.success && Array.isArray(data.holds)) {
                holdContainerMap.clear();
                data.holds.forEach(h => {
                    holdContainerMap.set(h.cntrNo, h.reason || '');
                });
                console.log(`✅ [DB] 보류 컨테이너 ${holdContainerMap.size}건 로드 완료`);
            }
        }
    } catch (err) {
        console.error("보류 목록 로드 실패:", err);
    }
}

window.toggleContainerHold = async (cntrNo, event) => {
    if (event) event.stopPropagation();
    const isHeld = holdContainerMap.has(cntrNo);

    try {
        if (isHeld) {
            // 보류 해제
            const resp = await fetch(`${API_BASE}/api/sync/holds/${cntrNo}`, { method: 'DELETE' });
            if (resp.ok) {
                holdContainerMap.delete(cntrNo);
                console.log(`[Hold] ${cntrNo} 보류 해제`);
            }
        } else {
            // 보류 등록
            const resp = await fetch(`${API_BASE}/api/sync/holds`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cntrNo, reason: '사용자 지정 보류' })
            });
            if (resp.ok) {
                holdContainerMap.set(cntrNo, '사용자 지정 보류');
                console.log(`[Hold] ${cntrNo} 보류 등록`);
            }
        }

        // UI 갱신 (집계수량 등 재계산 포함)
        displayResults(comparisonResult, false);
    } catch (err) {
        console.error("보류 처리 실패:", err);
        alert("보류 처리에 실패했습니다.");
    }
};

/* =========================================================================
 *  CAUTION MODELS LOGIC
 * ========================================================================= */
async function loadCautionModels() {
    try {
        const resp = await fetch(`${API_BASE}/api/caution-models`);
        if (resp.ok) {
            const data = await resp.json();
            if (data.success && Array.isArray(data.models)) {
                cautionModels = data.models;
                console.log(`✅ [Local] 주의 모델 목록 ${cautionModels.length}건 로드 완료`);
            }
        }
    } catch (err) {
        console.error("주의 모델 목록 로드 실패:", err);
    }
}

// 주의 모델 모달 UI 관리 및 렌더링
function renderCautionModelsTable() {
    const tbody = document.getElementById('cautionModelsTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (cautionModels.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: #94a3b8; padding: 12px;">등록된 주의 모델이 없습니다.</td></tr>`;
        return;
    }

    cautionModels.forEach((item, index) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #f1f5f9';
        
        tr.innerHTML = `
            <td style="padding: 8px 12px; font-weight: 600; color: #1e293b;">${item.modelName}</td>
            <td style="padding: 8px 12px; color: #475569;">${item.remark || '-'}</td>
            <td style="padding: 8px 12px; text-align: center;">
                <button class="btn btn-danger-soft" style="padding: 2px 6px; font-size: 0.75rem; color: #ef4444; border: 1px solid #fee2e2; background: #fff5f5; border-radius: 4px; cursor: pointer;" onclick="window.removeCautionModel(${index})">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

window.removeCautionModel = (index) => {
    cautionModels.splice(index, 1);
    renderCautionModelsTable();
};

document.addEventListener('DOMContentLoaded', () => {
    const btnOpenCaution = document.getElementById('btnOpenCautionModels');
    const modalCaution = document.getElementById('cautionModelsModal');
    const btnCloseCaution = document.getElementById('closeCautionModelsBtn');
    const btnCloseCautionBottom = document.getElementById('closeCautionModelsBottomBtn');
    const btnAddCaution = document.getElementById('btnAddCautionModel');
    const btnSaveCaution = document.getElementById('btnSaveCautionModels');

    if (btnOpenCaution && modalCaution) {
        btnOpenCaution.onclick = () => {
            renderCautionModelsTable();
            modalCaution.style.display = 'block';
        };
    }

    const closeFn = () => {
        if (modalCaution) modalCaution.style.display = 'none';
    };

    if (btnCloseCaution) btnCloseCaution.onclick = closeFn;
    if (btnCloseCautionBottom) btnCloseCautionBottom.onclick = closeFn;

    if (btnAddCaution) {
        btnAddCaution.onclick = () => {
            const nameInput = document.getElementById('inputCautionModelName');
            const remarkInput = document.getElementById('inputCautionModelRemark');
            if (!nameInput) return;

            const name = nameInput.value.trim();
            const remark = remarkInput ? remarkInput.value.trim() : '';

            if (!name) {
                alert('주의 대상 모델명을 입력해 주세요.');
                return;
            }

            // 중복 체크
            const isDuplicate = cautionModels.some(item => item.modelName.toUpperCase() === name.toUpperCase());
            if (isDuplicate) {
                alert('이미 등록된 모델명입니다.');
                return;
            }

            cautionModels.push({ modelName: name, remark: remark });
            nameInput.value = '';
            if (remarkInput) remarkInput.value = '';

            renderCautionModelsTable();
        };
    }

    if (btnSaveCaution) {
        btnSaveCaution.onclick = async () => {
            try {
                const resp = await fetch(`${API_BASE}/api/caution-models`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ models: cautionModels })
                });
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.success) {
                        alert('주의 모델 설정이 성공적으로 저장되었습니다.');
                        if (modalCaution) modalCaution.style.display = 'none';
                        // 현재 로드된 비교 데이터 화면 갱신
                        if (typeof comparisonResult !== 'undefined' && Array.isArray(comparisonResult) && comparisonResult.length > 0) {
                            displayResults(comparisonResult, false);
                        }
                    } else {
                        alert('설정 저장 중 오류가 발생했습니다: ' + data.message);
                    }
                } else {
                    alert('서버 응답 오류로 저장에 실패했습니다.');
                }
            } catch (err) {
                console.error('주의 모델 저장 오류:', err);
                alert('서버 연결 실패로 저장에 실패했습니다.');
            }
        };
    }

    // 모달 외곽 클릭 시 닫기
    window.addEventListener('click', (event) => {
        if (event.target === modalCaution) {
            modalCaution.style.display = 'none';
        }
    });
});

/**
 * 클립보드 복사 및 토스트 알림
 */
window.copyToClipboard = (text, label) => {
    if (!text) return;

    // 브라우저 복사 API 사용
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
            showToast(`[${label}] 복사됨: ${text}`);
        }).catch(err => {
            console.error('클립보드 복사 실패 (API):', err);
            copyFallback(text, label);
        });
    } else {
        copyFallback(text, label);
    }
};

function copyFallback(text, label) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    try {
        document.execCommand('copy');
        showToast(`[${label}] 복사됨: ${text}`);
    } catch (err) {
        console.error('복사 실패 (Fallback):', err);
    }
    document.body.removeChild(textArea);
}

function showToast(message) {
    let toast = document.getElementById('copy-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'copy-toast';
        Object.assign(toast.style, {
            position: 'fixed',
            bottom: '40px',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: '#1e293b',
            color: 'white',
            padding: '12px 24px',
            borderRadius: '12px',
            fontSize: '0.9rem',
            fontWeight: '700',
            zIndex: '100000',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
            transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            opacity: '0',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            border: '1px solid rgba(255,255,255,0.1)'
        });
        document.body.appendChild(toast);
    }

    toast.innerHTML = `<i class="fas fa-check-circle" style="color: #10b981;"></i> ${message}`;
    toast.style.display = 'flex';
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(-15px)';

    if (window._toastTimer) clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(0)';
        setTimeout(() => { if (toast.style.opacity === '0') toast.style.display = 'none'; }, 400);
    }, 2500);
}

window.openWeightMismatchPopup = (cntrNo) => {
    const item = displayData.find(d => d.cntrNo === cntrNo);
    if (!item) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-ov';
    Object.assign(overlay.style, {
        position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
        backgroundColor: 'rgba(0, 0, 0, 0.7)', display: 'flex', justifyContent: 'center',
        alignItems: 'center', zIndex: '10000', backdropFilter: 'blur(4px)'
    });

    const modal = document.createElement('div');
    Object.assign(modal.style, {
        backgroundColor: 'white', padding: '30px', borderRadius: '20px',
        width: '600px', maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)', border: '1px solid #e2e8f0'
    });

    const details = item.mismatchDetails;
    let detailHtml = "";

    // 1. 누락 품목 (원본에만 있음 = 전산 누락)
    if (details.missingInDown.length > 0) {
        detailHtml += `
            <div style="margin-bottom: 20px;">
                <h4 style="margin: 0 0 8px 0; color: #e11d48; font-size: 0.9rem;"><i class="fas fa-minus-circle"></i> 전산(다운로드) 파일 누락 품목</h4>
                <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                    <tr style="background: #fff1f2; color: #be123c;">
                        <th style="padding: 6px; border: 1px solid #fecaca; text-align: left;">제품명</th>
                        <th style="padding: 6px; border: 1px solid #fecaca; text-align: center; width: 80px;">원본수량</th>
                    </tr>
                    ${details.missingInDown.map(p => `<tr><td style="padding:6px; border:1px solid #fecaca;">${p.name}</td><td style="padding:6px; border:1px solid #fecaca; text-align:center; font-weight:700;">${p.qty}</td></tr>`).join('')}
                </table>
            </div>`;
    }

    // 2. 누락 품목 (전산에만 있음 = 원본 누락)
    if (details.missingInOrig.length > 0) {
        detailHtml += `
            <div style="margin-bottom: 20px;">
                <h4 style="margin: 0 0 8px 0; color: #0284c7; font-size: 0.9rem;"><i class="fas fa-plus-circle"></i> 원본 워크시트 누락 품목</h4>
                <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                    <tr style="background: #f0f9ff; color: #0369a1;">
                        <th style="padding: 6px; border: 1px solid #bae6fd; text-align: left;">제품명</th>
                        <th style="padding: 6px; border: 1px solid #bae6fd; text-align: center; width: 80px;">전산수량</th>
                    </tr>
                    ${details.missingInOrig.map(p => `<tr><td style="padding:6px; border:1px solid #bae6fd;">${p.name}</td><td style="padding:6px; border:1px solid #bae6fd; text-align:center; font-weight:700;">${p.qty}</td></tr>`).join('')}
                </table>
            </div>`;
    }

    // 3. 수량 불일치
    if (details.qtyDiffs.length > 0) {
        detailHtml += `
            <div style="margin-bottom: 20px;">
                <h4 style="margin: 0 0 8px 0; color: #d97706; font-size: 0.9rem;"><i class="fas fa-calculator"></i> 수량 불일치 품목</h4>
                <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                    <tr style="background: #fffbeb; color: #92400e;">
                        <th style="padding: 6px; border: 1px solid #fde68a; text-align: left;">제품명</th>
                        <th style="padding: 6px; border: 1px solid #fde68a; text-align: center;">원본</th>
                        <th style="padding: 6px; border: 1px solid #fde68a; text-align: center;">전산</th>
                    </tr>
                    ${details.qtyDiffs.map(p => `<tr><td style="padding:6px; border:1px solid #fde68a;">${p.name}</td><td style="padding:6px; border:1px solid #fde68a; text-align:center;">${p.orig}</td><td style="padding:6px; border:1px solid #fde68a; text-align:center; font-weight:700; color:#e11d48;">${p.down}</td></tr>`).join('')}
                </table>
            </div>`;
    }

    // 4. 개별중량 불일치
    if (details.weightDiffs.length > 0) {
        detailHtml += `
            <div style="margin-bottom: 20px;">
                <h4 style="margin: 0 0 8px 0; color: #7c3aed; font-size: 0.9rem;"><i class="fas fa-weight-hanging"></i> 개별중량 상이 품목</h4>
                <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                    <tr style="background: #f5f3ff; color: #5b21b6;">
                        <th style="padding: 6px; border: 1px solid #ddd6fe; text-align: left;">제품명</th>
                        <th style="padding: 6px; border: 1px solid #ddd6fe; text-align: center;">DB기준</th>
                        <th style="padding: 6px; border: 1px solid #ddd6fe; text-align: center;">실측(전산)</th>
                    </tr>
                    ${details.weightDiffs.map(p => `<tr><td style="padding:6px; border:1px solid #ddd6fe;">${p.name}</td><td style="padding:6px; border:1px solid #ddd6fe; text-align:center;">${p.db}kg</td><td style="padding:6px; border:1px solid #ddd6fe; text-align:center; font-weight:700; color:#7c3aed;">${(parseFloat(p.current) || 0).toFixed(2)}kg</td></tr>`).join('')}
                </table>
            </div>`;
    }

    // 4.5 개별 CBM 불일치
    if (details.cbmDiffs && details.cbmDiffs.length > 0) {
        detailHtml += `
            <div style="margin-bottom: 20px;">
                <h4 style="margin: 0 0 8px 0; color: #0284c7; font-size: 0.9rem;"><i class="fas fa-cube"></i> 개별 CBM 상이 품목</h4>
                <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                    <tr style="background: #f0f9ff; color: #0369a1;">
                        <th style="padding: 6px; border: 1px solid #bae6fd; text-align: left;">제품명</th>
                        <th style="padding: 6px; border: 1px solid #bae6fd; text-align: center;">DB기준</th>
                        <th style="padding: 6px; border: 1px solid #bae6fd; text-align: center;">실측(전산)</th>
                    </tr>
                    ${details.cbmDiffs.map(p => `<tr><td style="padding:6px; border:1px solid #bae6fd;">${p.name}</td><td style="padding:6px; border:1px solid #bae6fd; text-align:center;">${(parseFloat(p.db) || 0).toFixed(3)}</td><td style="padding:6px; border:1px solid #bae6fd; text-align:center; font-weight:700; color:#0284c7;">${(parseFloat(p.current) || 0).toFixed(3)}</td></tr>`).join('')}
                </table>
            </div>`;
    }

    // 5. DB 정보 없음
    if (details.noWeightInfo && details.noWeightInfo.length > 0) {
        detailHtml += `
            <div style="margin-bottom: 20px;">
                <h4 style="margin: 0 0 8px 0; color: #92400e; font-size: 0.9rem;"><i class="fas fa-question-circle"></i> DB 중량 정보 누락</h4>
                <div style="background: #fefce8; border: 1px solid #fef08a; padding: 10px; border-radius: 8px; font-size: 0.85rem; color: #854d0e;">
                    기준 마스터(DB)에 중량이 등록되지 않은 품목입니다: <br>
                    <strong>${details.noWeightInfo.map(p => p.name).join(', ')}</strong>
                </div>
            </div>`;
    }

    const wO = parseFloat(item.weights.orig) || 0;
    const wD = parseFloat(item.weights.down) || 0;

    // 만약 특이사항이 정말 없는데 중량이 다르다면 (계산 오류 등)
    if (!detailHtml && Math.abs(wO - wD) > 1) {
        detailHtml = `
            <div style="text-align:center; padding:20px; color:#ef4444; font-weight:600;">
                <i class="fas fa-exclamation-triangle"></i> 직접적인 원인 모델을 찾을 수 없으나 총 합계가 다릅니다. <br>
                <small style="color:#64748b; font-weight:normal;">(제품 구성은 동일하나 각 파일의 수치가 미세하게 다를 수 있습니다)</small>
            </div>`;
    }

    modal.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 25px;">
            <div style="display: flex; align-items: center; gap: 12px;">
                <div style="width: 48px; height: 48px; background: #fff1f2; border-radius: 14px; display: flex; align-items: center; justify-content: center; color: #e11d48;">
                    <i class="fas fa-search-plus" style="font-size: 1.4rem;"></i>
                </div>
                <div>
                    <h3 style="margin: 0; font-size: 1.25rem; color: #1e293b; letter-spacing: -0.5px;">중량 상세분석 (${item.cntrNo})</h3>
                    <div style="font-size: 0.85rem; color: #64748b; margin-top: 2px;">두 파일 간의 불일치 원인을 품목별로 분석한 결과입니다.</div>
                </div>
            </div>
            <button onclick="this.closest('.modal-ov').remove();" style="background:none; border:none; color:#94a3b8; cursor:pointer; font-size:1.5rem;"><i class="fas fa-times"></i></button>
        </div>
        
        <div style="background: #f8fafc; border-radius: 12px; padding: 15px; margin-bottom: 25px; border: 1px dashed #e2e8f0;">
            ${detailHtml || '<div style="text-align:center; color:#94a3b8; padding:20px;">특이사항이 발견되지 않았습니다.</div>'}
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 25px;">
            <button class="choice-btn" onclick="window.updateWeightChoice('${cntrNo}', 'orig'); this.closest('.modal-ov').remove();" 
                    style="display: flex; flex-direction: column; gap: 6px; padding: 16px; border: 2px solid #e2e8f0; border-radius: 14px; background: white; cursor: pointer; transition: all 0.2s; text-align: left;">
                <span style="font-weight: 700; color: #64748b; font-size: 0.8rem;">원본(워크시트) 합계 선택</span>
                <span style="font-size: 1.2rem; color: #1e293b; font-weight: 800;">${wO.toLocaleString()} kg</span>
            </button>
            <button class="choice-btn" onclick="window.updateWeightChoice('${cntrNo}', 'down'); this.closest('.modal-ov').remove();"
                    style="display: flex; flex-direction: column; gap: 6px; padding: 16px; border: 2px solid #e2e8f0; border-radius: 14px; background: white; cursor: pointer; transition: all 0.2s; text-align: left;">
                <span style="font-weight: 700; color: #0284c7; font-size: 0.8rem;">전산(다운로드) 합계 선택</span>
                <span style="font-size: 1.2rem; color: #1e293b; font-weight: 800;">${wD.toLocaleString()} kg</span>
            </button>
        </div>

        <button onclick="this.closest('.modal-ov').remove();" 
                style="width: 100%; padding: 12px; background: #f1f5f9; border: none; border-radius: 10px; color: #475569; font-weight: 700; cursor: pointer; transition: background 0.2s;">
            창 닫기 (다음에 선택)
        </button>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const btns = modal.querySelectorAll('.choice-btn');
    btns.forEach(btn => {
        btn.onmouseover = () => { btn.style.borderColor = '#3b82f6'; btn.style.backgroundColor = '#eff6ff'; };
        btn.onmouseout = () => { btn.style.borderColor = '#e2e8f0'; btn.style.backgroundColor = 'white'; };
    });

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
};

let stats = {
    total: 0, success: 0, error: 0, missing: 0,
    extra: 0, chunma: 0, bni: 0, updateRequired: 0
};

let userSelectedWeights = {}; // 반입정보 생성 탭에서 사용자가 선택한 중량 (컨테이너별)

let missingProductsSet = new Set(); // 마스터에 없는 제품명 수집용
let weightMismatchSet = new Set();  // 중량 정보 불일치 제품명 수집용
let weightMismatchDetails = {};    // 중량/CBM 불일치 상세 정보 수집용 { prodName: { dbWeight, downWeight, dbCbm, downCbm, hasWeightDiff, hasCbmDiff } }


/* =========================================================================
 *  ERROR HANDLING (Frontend -> Backend Logging)
 * ========================================================================= */

window.addEventListener('error', (event) => {
    if (window.electronAPI && window.electronAPI.logFrontendError) {
        window.electronAPI.logFrontendError(`[Uncaught Error] ${event.message} at ${event.filename}:${event.lineno}`);
    }
});
window.addEventListener('unhandledrejection', (event) => {
    if (window.electronAPI && window.electronAPI.logFrontendError) {
        window.electronAPI.logFrontendError(`[Unhandled Promise Rejection] ${event.reason}`);
    }
});

/* =========================================================================
 *  DOM ELEMENTS
 * ========================================================================= */
const pathOriginal = document.getElementById('pathOriginal');
const pathRework = document.getElementById('pathRework'); // 재작업 경로
const pathDownload = document.getElementById('pathDownload');
const fileOriginal = document.getElementById('fileOriginal');
const fileRework = document.getElementById('fileRework'); // 재작업 파일 입력
const fileDownload = document.getElementById('fileDownload');
const statusOriginal = document.getElementById('statusOriginal');
const statusRework = document.getElementById('statusRework'); // 재작업 상태
const statusDownload = document.getElementById('statusDownload');
const lastOrig = document.getElementById('lastOrig');
const lastDown = document.getElementById('lastDown');
const btnReloadOriginal = document.getElementById('btnReloadOriginal');
const btnReloadDownload = document.getElementById('btnReloadDownload');
const btnAutoLoadOrig = document.getElementById('btnAutoLoadOrig');
const btnAutoLoadDown = document.getElementById('btnAutoLoadDown');
const btnAutoLoadRework = document.getElementById('btnAutoLoadRework');
const btnReloadRework = document.getElementById('btnReloadRework');
const btnCompare = document.getElementById('btnCompare');
const btnClearRework = document.getElementById('btnClearRework');
const processStatus = document.getElementById('processStatus');
const dashboardContainer = document.getElementById('dashboardContainer');
const resultsContainer = document.getElementById('resultsContainer');
const btnLoadExcel = document.getElementById('btnLoadExcel'); // Added from instruction
const btnDownloadResult = document.getElementById('btnDownloadResult');
const btnViewResult = document.getElementById('btnViewResult');
const btnDbViewExcel = document.getElementById('btnDbViewExcel');
const btnClearOriginal = document.getElementById('btnClearOriginal');
const btnClearDown = document.getElementById('btnClearDown');
// Warehouse Stock Elements
const pathWarehouse = document.getElementById('pathWarehouse');
const btnAutoLoadWarehouse = document.getElementById('btnAutoLoadWarehouse');
const btnReloadWarehouse = document.getElementById('btnReloadWarehouse');
// DOM 요소 (애플리케이션 구동 시점에 찾되, 필요시 함수 내에서 재확인)
function getResultBody() {
    return document.getElementById('resultBody');
}
const tabAll = document.getElementById('tabAll');
const tabSuccessOnly = document.getElementById('tabSuccessOnly');
const tabErrorOnly = document.getElementById('tabErrorOnly');
const tabMissingOnly = document.getElementById('tabMissingOnly');
const tabEntryInfo = document.getElementById('tabEntryInfo');
const tabUnclassifiedEntry = document.getElementById('tabUnclassifiedEntry');
const tabHold = document.getElementById('tabHold'); // Added for hold tab
const successFilterContainer = document.getElementById('successFilterContainer');
const chkFilterCompleted = document.getElementById('chkFilterCompleted');
const chkFilterProgress = document.getElementById('chkFilterProgress');
const chkFilterPending = document.getElementById('chkFilterPending');
const chkFilterChunma = document.getElementById('chkFilterChunma');
const chkFilterBni = document.getElementById('chkFilterBni');
const chkFilterOtherTrans = document.getElementById('chkFilterOtherTrans');
const btnCopyChunma = document.getElementById('btnCopyChunma');
const btnSendChunma = document.getElementById('btnSendChunma');
const btnCopyBni = document.getElementById('btnCopyBni');
const btnSendBni = document.getElementById('btnSendBni');


// DB Sync Elements
const dbSettingsModal = document.getElementById('dbSettingsModal');
const btnOpenDbSettings = document.getElementById('btnOpenDbSettings');
const closeDbSettingsBtn = document.getElementById('closeDbSettingsBtn');
const closeDbSettingsBottomBtn = document.getElementById('closeDbSettingsBottomBtn');
const phoneDbIp = document.getElementById('phoneDbIp');
const phoneDbPort = document.getElementById('phoneDbPort');
const phoneDbUser = document.getElementById('phoneDbUser');
const phoneDbName = document.getElementById('phoneDbName');
const phoneDbPassword = document.getElementById('phoneDbPassword');
const btnSavePhoneDb = document.getElementById('btnSavePhoneDb');
const switchToCloud = document.getElementById('switchToCloud');
const switchToPhone = document.getElementById('switchToPhone');

// DB 데이터 조회 Modal Elements
const dbSearchModal = document.getElementById('dbSearchModal');
const btnOpenDbSearchModal = document.getElementById('btnOpenDbSearchModal');
const closeDbSearchModalBtn = document.getElementById('closeDbSearchModalBtn');
const closeDbSearchModalBottomBtn = document.getElementById('closeDbSearchModalBottomBtn');
const syncToPhone = document.getElementById('syncToPhone');
const syncToCloud = document.getElementById('syncToCloud');
const currentDbHost = document.getElementById('currentDbHost');
const currentDbStatus = document.getElementById('currentDbStatus');
const syncProgress = document.getElementById('syncProgress');
const syncStatusText = document.getElementById('syncStatusText');
const syncProgressBar = document.getElementById('syncProgressBar');

/* =========================================================================
 *  MAIN NAVIGATION TABS ( Selection vs Results vs Availability )
 * ========================================================================= */
function switchMainTab(tabId) {
    const mainTabBtnSelection = document.getElementById('mainTabBtnSelection');
    const mainTabBtnResults = document.getElementById('mainTabBtnResults');
    const mainTabBtnAvailability = document.getElementById('mainTabBtnAvailability');
    const tabContentSelection = document.getElementById('tabContentSelection');
    const tabContentResults = document.getElementById('tabContentResults');
    const tabContentAvailability = document.getElementById('tabContentAvailability');

    function setActive(btn) {
        if (!btn) return;
        btn.style.background = '#fff';
        btn.style.color = '#0ea5e9';
        btn.style.boxShadow = '0 1px 4px rgba(0,0,0,0.10)';
        btn.classList.add('active');
    }
    function setInactive(btn) {
        if (!btn) return;
        btn.style.background = 'transparent';
        btn.style.color = '#64748b';
        btn.style.boxShadow = 'none';
        btn.classList.remove('active');
    }

    // 모든 탭 비활성화
    setInactive(mainTabBtnSelection);
    setInactive(mainTabBtnResults);
    setInactive(mainTabBtnAvailability);
    if (tabContentSelection) tabContentSelection.classList.remove('active');
    if (tabContentResults) tabContentResults.classList.remove('active');
    if (tabContentAvailability) tabContentAvailability.classList.remove('active');

    if (tabId === 'selection') {
        setActive(mainTabBtnSelection);
        if (tabContentSelection) tabContentSelection.classList.add('active');
    } else if (tabId === 'availability') {
        setActive(mainTabBtnAvailability);
        if (tabContentAvailability) tabContentAvailability.classList.add('active');
        // 가용성 데이터가 아직 없는데 원본 데이터가 메모리에 있으면 자동 분석
        if ((!processedAvailabilityData || processedAvailabilityData.length === 0) && originalData && originalData.length > 0) {
            runPreWorkAvailabilityCheck(true);
        }
    } else {
        setActive(mainTabBtnResults);
        if (tabContentResults) tabContentResults.classList.add('active');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const btnSelection = document.getElementById('mainTabBtnSelection');
    const btnResults = document.getElementById('mainTabBtnResults');
    const btnAvailability = document.getElementById('mainTabBtnAvailability');
    if (btnSelection) btnSelection.addEventListener('click', () => switchMainTab('selection'));
    if (btnResults) btnResults.addEventListener('click', () => switchMainTab('results'));
    if (btnAvailability) btnAvailability.addEventListener('click', () => switchMainTab('availability'));

    const fileAvailDirect = document.getElementById('fileAvailDirect');
    if (fileAvailDirect) {
        fileAvailDirect.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const parsedData = await readExcelFile(file, 'original');
                originalData = parsedData.filter(item => (item.qty || 0) > 0);
                originalFile = file;
                if (statusOriginal) {
                    statusOriginal.innerHTML = `<i class="fas fa-check-circle" style="color:#059669; margin-right:4px;"></i>상태: 분석 완료 (${originalData.length}건)`;
                    statusOriginal.style.color = '#059669';
                }
                rawAvailabilityItems = originalData;
                processAvailabilityData(originalData);
                renderAvailabilityDashboard();
                renderAvailabilityTable();
                switchMainTab('availability');
            } catch (err) {
                console.error("가용성 원본 파일 직접 로드 실패:", err);
                alert("원본 엑셀 파일 파싱에 실패했습니다: " + err.message);
            }
        });
    }
});


/* =========================================================================
 *  INITIALIZATION
 * ========================================================================= */

// 컨테이너 사진 버튼 렌더러 (테이블 내 사진 컬럼용)
window.renderContainerPhotoBtn = function(cntrNo, options = {}) {
    if (!cntrNo || cntrNo === '미지정' || cntrNo === '-') return '';
    const cleanNo = cntrNo.trim().toUpperCase();
    const map = window.containerPhotoCountsMap || window.containerPhotoCounts || {};
    const info = map[cleanNo];
    if (!info || info.total <= 0) {
        return '';
    }

    const total = info.total || 0;
    const hasSeal = info.seal > 0;
    const badgeColor = hasSeal ? '#059669' : '#e11d48';
    const iconClass = hasSeal ? 'fas fa-camera' : 'fas fa-camera camera-pulse';
    const titleText = hasSeal 
        ? `${cleanNo} 등록된 사진 ${total}장 보기 (씰 포함)` 
        : `${cleanNo} 등록된 사진 ${total}장 (⚠️ 씰 사진 미등록)`;

    return `
        <button type="button" class="btn-table-photo-badge" onclick="window.openPhotoGalleryModal('${cleanNo}', event)" title="${titleText}" style="background: ${hasSeal ? 'rgba(16,185,129,0.12)' : 'rgba(244,63,94,0.12)'}; border: 1px solid ${hasSeal ? '#6ee7b7' : '#fda4af'}; color: ${badgeColor}; padding: 2px 6px; border-radius: 6px; font-size: 0.72rem; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; transition: all 0.15s;">
            <i class="${iconClass}" style="font-size: 0.75rem;"></i>
            <span>${total}</span>
        </button>
    `;
};

// 컨테이너 사진 수치 캐싱 유틸리티
window.fetchContainerPhotoCounts = async function() {
    try {
        const res = await fetch(`${API_BASE}/api/photos`);
        const data = await res.json();
        if (data.success && data.photos) {
            window.containerPhotoCountsMap = {};
            data.photos.forEach(p => {
                if (!p.cntr_no) return;
                const cNo = p.cntr_no.toUpperCase().trim();
                if (!window.containerPhotoCountsMap[cNo]) {
                    window.containerPhotoCountsMap[cNo] = { total: 0, seal: 0, normal: 0 };
                }
                window.containerPhotoCountsMap[cNo].total++;
                if (p.photo_type === 'seal') window.containerPhotoCountsMap[cNo].seal++;
                else window.containerPhotoCountsMap[cNo].normal++;
            });
            window.containerPhotoCounts = window.containerPhotoCountsMap;

            // DOM 상에 이미 렌더링된 결과 테이블의 사진 셀 즉시 실시간 업데이트
            document.querySelectorAll('[data-photo-cntr]').forEach(el => {
                const cNo = el.getAttribute('data-photo-cntr');
                if (cNo) {
                    el.innerHTML = window.renderContainerPhotoBtn(cNo, { iconOnly: true });
                }
            });
        }
    } catch (e) {
        console.warn('fetchContainerPhotoCounts error:', e.message);
    }
};

// 초기화: 이전 저장 데이터 및 서버 상태 확인
async function initializeApp() {
    // 마스터 데이터 일괄 로드 (어느 하나가 실패해도 앱 초기화가 중단되지 않도록 Promise.allSettled 사용)
    await Promise.allSettled([
        loadCarrierMap(),
        loadDynamicRules(),
        loadProductMaster(),
        loadCustomFields(),
        loadHoldContainers(),
        loadCautionModels(),
        window.fetchContainerPhotoCounts()
    ]);

    // Check Server & DB Status
    try {
        const resp = await fetch(`${API_BASE}/api/health`).catch(e => {
            throw new Error("서버에 연결할 수 없습니다. (백엔드 실행 확인 필요)");
        });
        const healthData = await resp.json();
        console.log('Server Health:', healthData);

        const dbResp = await fetch(`${API_BASE}/api/db-status`);
        const data = await dbResp.json();
        const tabDbSearch = document.getElementById('tabDbSearch');

        if (!data.success) {
            console.warn('DB Not Available:', data.message);
            updateDbConfigUI(false, data.message);

            // 원격 PC DB가 먹통일 때 사용자에게 즉시 알려주고 클라우드 전환 제안
            if (data.message.includes('timeout') || data.message.includes('ECONNREFUSED')) {
                const useCloud = confirm("현재 원격 PC DB(Remote)에 접속할 수 없습니다.\n[안전망] Cloudtype DB로 즉시 전환하여 작업을 계속하시겠습니까?");
                if (useCloud) {
                    document.getElementById('switchToCloud').click();
                }
            }

            if (tabDbSearch) {
                tabDbSearch.title = `DB 연결 실패: ${data.message}`;
                tabDbSearch.style.opacity = '0.7';
            }
        } else {
            console.log('DB Available:', data.message);
            updateDbConfigUI(true);
            updateDbGlobalStats(); // Fetch and display cloud/DB stats
            if (tabDbSearch) {
                tabDbSearch.style.display = '';
                tabDbSearch.style.opacity = '1';
                tabDbSearch.title = 'DB 데이터 조회';
            }
        }
        // 로컬 전용 기능 노출 제어 (Electron, localhost, 브라우저 모두 지원)
        document.querySelectorAll('.local-only-feature').forEach(el => {
            if (el.tagName === 'DIV' && (el.style.alignItems === 'center' || el.style.gap)) {
                el.style.display = 'flex';
            } else {
                el.style.display = 'block';
            }
        });
        // 네이티브 탐색기 피커 버튼 노출
        document.querySelectorAll('.electron-only-picker').forEach(el => el.style.display = 'inline-flex');
    } catch (err) {
        console.error('Critical initialization error:', err);
        alert(`🚧 경고: ${err.message}\n프로그램의 일부 기능(DB, 마스터 로드 등)이 작동하지 않을 수 있습니다.`);
    }

    // Web 환경에서 잘못 저장된 로컬 경로가 있으면 미리 제거 (오류 방지)
    const isLocalHost = window.isElectron || window.location.hostname === 'localhost';
    if (!isLocalHost) {
        ['pathOrig', 'pathRework', 'pathDown', 'dirOrig', 'dirRework', 'dirDown'].forEach(key => {
            const val = localStorage.getItem(key);
            if (val && (/^[a-zA-Z]:\\/.test(val) || val.startsWith('\\\\'))) {
                localStorage.removeItem(key);
                console.log(`🧹 Web 버전: 로컬 경로 캐시 제거 (${key})`);
            }
        });
        // 입력창 강제 비우기
        if (pathOriginal) pathOriginal.value = '';
        if (pathRework) pathRework.value = '';
        if (pathDownload) pathDownload.value = '';
    }

    let savedPathOrig = localStorage.getItem('pathOrig');
    let savedPathRework = localStorage.getItem('pathRework');
    let savedPathDown = localStorage.getItem('pathDown');
    let savedPathWarehouse = localStorage.getItem('pathWarehouse');

    // Electron 환경에서 디스크에 저장된 경로 정보가 있다면 우선 사용
    if (window.electronAPI) {
        const diskOrig = await window.electronAPI.getFilePath('original');
        const diskRework = await window.electronAPI.getFilePath('rework');
        const diskDown = await window.electronAPI.getFilePath('download');
        const diskWarehouse = await window.electronAPI.getFilePath('warehouse');
        if (diskOrig) savedPathOrig = diskOrig;
        if (diskRework) savedPathRework = diskRework;
        if (diskDown) savedPathDown = diskDown;
        if (diskWarehouse) savedPathWarehouse = diskWarehouse;
    }

    // 마지막 백업 시간 로드
    const lastBackup = localStorage.getItem('lastBackupTime');
    if (lastBackup && document.getElementById('lastBackupTime')) {
        document.getElementById('lastBackupTime').textContent = lastBackup;
    }

    // 경로 검증 헬퍼
    const isPathValid = async (p) => {
        if (!p || p.trim() === "") return false;

        // Electron 환경이면 실제 파일 존재 여부 체크
        if (window.electronAPI && window.electronAPI.checkFileExists) {
            return await window.electronAPI.checkFileExists(p);
        }

        // 웹 환경이면 로컬 경로(Y:\, C:\ 등)는 무조건 무효 처리
        const isLocalPath = /^[a-zA-Z]:\\/.test(p) || p.startsWith('\\\\');
        if (isLocalPath && window.location.hostname !== 'localhost') {
            return false;
        }

        return true;
    };

    if (savedPathOrig) {
        if (await isPathValid(savedPathOrig)) {
            pathOriginal.value = savedPathOrig;
            statusOriginal.innerHTML = `<i class="fas fa-folder-open" style="color:#4361ee; margin-right:4px;"></i>상태: 원본 경로 준비됨`;
            statusOriginal.style.color = '#4361ee';
            // Electron API에도 다시 동기화
            if (window.electronAPI) window.electronAPI.saveFilePath('original', savedPathOrig);
        } else {
            localStorage.removeItem('pathOrig');
        }
    }

    if (savedPathRework) {
        if (await isPathValid(savedPathRework)) {
            pathRework.value = savedPathRework;
            statusRework.innerHTML = `<i class="fas fa-folder-open" style="color:#db2777; margin-right:4px;"></i>상태: 재작업 경로 준비됨`;
            statusRework.style.color = '#db2777';
            if (btnClearRework) btnClearRework.style.display = 'inline-block';
            if (window.electronAPI) window.electronAPI.saveFilePath('rework', savedPathRework);
        } else {
            localStorage.removeItem('pathRework');
        }
    }

    let savedDirDown = localStorage.getItem('dirDown') || savedPathDown;
    if (savedDirDown === 'C:\\Users\\Administrator\\Downloads') {
        savedDirDown = 'W:\\helpdesk\\Downloads';
        localStorage.setItem('dirDown', savedDirDown);
    }
    if (savedDirDown) {
        pathDownload.value = savedDirDown;
        statusDownload.innerHTML = `<i class="fas fa-folder-open" style="color:#0284c7; margin-right:4px;"></i>상태: 전산 경로 준비됨 (${savedDirDown})`;
        statusDownload.style.color = '#0284c7';
        if (window.electronAPI) window.electronAPI.saveFilePath('download', savedDirDown);
    }

    if (savedPathWarehouse) {
        if (await isPathValid(savedPathWarehouse)) {
            pathWarehouse.value = savedPathWarehouse;
            statusWarehouseStock.innerHTML = `<i class="fas fa-folder-open" style="color:#16a34a; margin-right:4px;"></i>상태: 창고 경로 준비됨`;
            statusWarehouseStock.style.color = '#16a34a';
            if (btnReloadWarehouse) btnReloadWarehouse.style.display = 'inline-block';
            if (window.electronAPI) window.electronAPI.saveFilePath('warehouse', savedPathWarehouse);
        } else {
            localStorage.removeItem('pathWarehouse');
        }
    }

    const savedOrigName = localStorage.getItem('lastOrigName');
    const savedDownName = localStorage.getItem('lastDownName');

    if (savedOrigName) {
        lastOrig.textContent = `최근 사용: ${savedOrigName}`;
        btnReloadOriginal.style.display = 'inline-block';
    }
    if (savedDownName) {
        lastDown.textContent = `최근 사용: ${savedDownName}`;
        btnReloadDownload.style.display = 'inline-block';
    }

    // DB Settings IP/Port/User/DB Load
    const savedPhoneIp = localStorage.getItem('phoneDbIp');
    const savedPhonePort = localStorage.getItem('phoneDbPort');
    const savedPhoneUser = localStorage.getItem('phoneDbUser') || 'u0_a354';
    const savedPhoneName = localStorage.getItem('phoneDbName') || 'u0_a354';
    const savedPhonePassword = localStorage.getItem('phoneDbPassword') || '';

    if (savedPhoneIp && phoneDbIp) phoneDbIp.value = savedPhoneIp;
    if (savedPhonePort && phoneDbPort) phoneDbPort.value = savedPhonePort;
    if (phoneDbUser) phoneDbUser.value = savedPhoneUser;
    if (phoneDbName) phoneDbName.value = savedPhoneName;
    if (phoneDbPassword) phoneDbPassword.value = savedPhonePassword;

    // 17 로케이션 포함 체크박스 이벤트 초기화
    const chkInclude17 = document.getElementById('chkInclude17');
    if (chkInclude17) {
        chkInclude17.checked = localStorage.getItem('include17Locations') === 'true';
        chkInclude17.addEventListener('change', () => {
            localStorage.setItem('include17Locations', chkInclude17.checked);
            updateActiveWarehouseStock();
        });
    }

    checkReadyStatus();

    // [신규] 이전 작업 세션 (4종 파일 및 비교 결과) 자동 복원
    await window.autoRestoreWorkSession();
}

// --- DB Settings & Sync Logic ---
function updateDbConfigUI(isConnected, errorMsg) {
    fetch(`${API_BASE}/api/db/config`)
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                currentDbHost.textContent = data.config.host;
                if (isConnected) {
                    currentDbStatus.textContent = "연결됨 ✅";
                    currentDbStatus.style.color = "#059669";
                } else {
                    currentDbStatus.textContent = `연결 안 됨 ❌ (${errorMsg || '알 수 없는 오류'})`;
                    currentDbStatus.style.color = "#ef4444";
                }
            }
        });
}

btnOpenDbSettings.addEventListener('click', () => {
    dbSettingsModal.style.display = 'block';
    updateDbConfigUI(true);
});

[closeDbSettingsBtn, closeDbSettingsBottomBtn].forEach(btn => {
    btn.addEventListener('click', () => dbSettingsModal.style.display = 'none');
});

// DB 데이터 조회 모달 제어
if (btnOpenDbSearchModal) {
    btnOpenDbSearchModal.addEventListener('click', () => {
        // 1. 비교결과 메인 탭으로 전환
        switchMainTab('results');

        // 2. resultsContainer 강제 표시 (비교 전이어도 DB 조회 탭 접근 가능하도록)
        const resultsContainer = document.getElementById('resultsContainer');
        if (resultsContainer) resultsContainer.style.display = 'block';

        // 3. DB 조회 탭 활성화
        if (typeof setActiveTab === 'function') {
            setActiveTab('dbSearch');
        } else {
            const tabDbSearchEl = document.getElementById('tabDbSearch');
            if (tabDbSearchEl) tabDbSearchEl.click();
        }

        // 4. DB 조회 탭으로 스크롤
        setTimeout(() => {
            const el = document.getElementById('dbSearchFilterBar');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 150);
    });
}

[closeDbSearchModalBtn, closeDbSearchModalBottomBtn].forEach(btn => {
    if (btn) {
        btn.addEventListener('click', () => {
            dbSearchModal.style.display = 'none';
        });
    }
});

btnSavePhoneDb.addEventListener('click', () => {
    const ip = phoneDbIp.value.trim();
    const port = phoneDbPort.value.trim();
    const user = phoneDbUser.value.trim();
    const db = phoneDbName.value.trim();
    const pass = phoneDbPassword ? phoneDbPassword.value.trim() : '';

    if (!ip || !port || !user || !db) return alert("필수 정보를 모두 입력하세요 (호스트, 포트, 사용자, DB명).");

    localStorage.setItem('phoneDbIp', ip);
    localStorage.setItem('phoneDbPort', port);
    localStorage.setItem('phoneDbUser', user);
    localStorage.setItem('phoneDbName', db);
    localStorage.setItem('phoneDbPassword', pass);
    alert("원격 PC 접속 정보가 저장되었습니다.");
});


switchToCloud.addEventListener('click', async () => {
    if (!confirm("클라우드 DB(cloudtype)로 전환하시겠습니까?")) return;
    const resp = await fetch(`${API_BASE}/api/db/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: 'svc.sel3.cloudtype.app', user: 'root', port: 30554, database: 'excel_compare' })
    });
    const data = await resp.json();
    alert(data.message);
    updateDbConfigUI(data.success, data.message);
    loadProductMaster(); // 마스터 새로고침
});

switchToPhone.addEventListener('click', async () => {
    const ip = phoneDbIp.value.trim();
    const port = phoneDbPort.value.trim() || '5432';
    const user = phoneDbUser.value.trim();
    const db = phoneDbName.value.trim();
    const pass = phoneDbPassword ? phoneDbPassword.value.trim() : '';

    if (!ip || !user || !db) return alert("원격 PC 설정을 먼저 완료하고 저장해주세요.");
    if (!confirm(`원격 PC DB(${ip}:${port})로 전환하시겠습니까?`)) return;

    const resp = await fetch(`${API_BASE}/api/db/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: ip, user: user, port: Number(port), database: db, password: pass, ssl: false })
    });
    const data = await resp.json();
    alert(data.message);
    updateDbConfigUI(data.success, data.message);
    loadProductMaster(); // 마스터 새로고침
});

// [ADD] Local PC DB Switch Logic
const switchToLocalPc = document.getElementById('switchToLocalPc');
if (switchToLocalPc) {
    switchToLocalPc.addEventListener('click', async () => {
        if (!confirm("로컬 PC DB(localhost:5432)로 전환하시겠습니까?")) return;
        const resp = await fetch(`${API_BASE}/api/db/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: 'localhost', user: 'postgres', port: 5432, database: 'excel', password: 'z456qwe12!@', ssl: false })
        });
        const data = await resp.json();
        alert(data.message);
        updateDbConfigUI(data.success, data.message);
        loadProductMaster(); // 마스터 새로고침
    });
}

async function startSync(srcType, dstType) {
    const LOCAL_PC_CONFIG = { host: 'localhost', user: 'postgres', port: 5432, database: 'excel', password: 'z456qwe12!@', ssl: false };
    const CLOUD_CFG = null; // 서버측 CLOUD_CONFIG 사용 (null = 서버 기본값)

    // 원격 PC 설정 읽기
    const ip = document.getElementById('phoneDbIp')?.value.trim();
    const port = document.getElementById('phoneDbPort')?.value.trim() || '5432';
    const user = document.getElementById('phoneDbUser')?.value.trim();
    const db = document.getElementById('phoneDbName')?.value.trim();
    const pass = document.getElementById('phoneDbPassword')?.value.trim() || '';
    const phoneConfig = { host: ip, user: user, port: Number(port), database: db, password: pass, ssl: false };

    // 동기화 옵션 (최적화)
    const incrementalOnly = document.getElementById('syncIncrementalOnly')?.checked || false;
    const selectedTables = Array.from(document.querySelectorAll('.sync-table-chk:checked')).map(el => el.value);
    if (selectedTables.length === 0) return alert("동기화할 테이블을 최소 하나 이상 선택해주세요.");

    // 원격 PC가 포함된 경우 IP 유효성 체크
    if ((srcType === 'phone' || dstType === 'phone') && !ip) {
        return alert('원격 PC DB 주소를 먼저 입력해 주세요. (원격 PC 연결 설정 패널 참고)');
    }
    if (srcType === dstType) return alert('출발지와 목적지가 같습니다. 다른 대상을 선택해 주세요.');

    const nameMap = { pc: '로컬 PC', cloud: '클라우드', phone: '원격 PC' };
    if (!confirm(`${nameMap[srcType]} ➜ ${nameMap[dstType]} 데이터 전송을 시작하시겠습니까?`)) return;

    const syncProgress = document.getElementById('syncProgress');
    const syncProgressBar = document.getElementById('syncProgressBar');
    const syncStatusText = document.getElementById('syncStatusText');
    syncProgress.style.display = 'block';
    syncProgressBar.style.width = '0%';
    syncStatusText.textContent = '동기화 준비 중...';

    // direction 매핑: 서버 API는 source/target을 직접 받도록 수정 필요 없이 phoneConfig 기반 전송
    // to_phone: cloud->phone, to_cloud: phone->cloud 식의 레거시 호환을 유지하면서,
    // PC가 포함된 경우엔 새로운 direction 값을 사용
    let direction;
    if (srcType === 'cloud' && dstType === 'phone') direction = 'to_phone';
    else if (srcType === 'phone' && dstType === 'cloud') direction = 'to_cloud';
    else if (srcType === 'pc') direction = `pc_to_${dstType}`;
    else if (dstType === 'pc') direction = `${srcType}_to_pc`;
    else direction = `${srcType}_to_${dstType}`;

    try {
        const resp = await fetch(`${API_BASE}/api/db/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                direction,
                phoneConfig,
                pcConfig: LOCAL_PC_CONFIG,
                tables: selectedTables,
                options: {
                    incrementalOnly
                }
            })
        });
        const data = await resp.json();
        if (data.success) {
            syncProgressBar.style.width = '100%';
            syncStatusText.textContent = '동기화 완료!';
            let resultMsg = '✅ 동기화 결과:\n';
            data.results.forEach(r => {
                if (r.success) {
                    const written = r.count !== undefined ? r.count.toLocaleString() : '0';
                    const total = r.queriedCount !== undefined ? r.queriedCount.toLocaleString() : '0';
                    resultMsg += `- ${r.table}: ${written}건 반영 (총 ${total}건 검사 완료)\n`;
                } else {
                    resultMsg += `- ${r.table}: 실패(${r.error})\n`;
                }
            });
            alert(resultMsg);
            if (typeof loadProductMaster === 'function') {
                loadProductMaster();
            }
        } else {
            throw new Error(data.message);
        }
    } catch (err) {
        alert('동기화 실패: ' + err.message);
        syncStatusText.textContent = '실패: ' + err.message;
    } finally {
        setTimeout(() => { syncProgress.style.display = 'none'; }, 3000);
    }
}

// --- 새 UI: sync-node-btn 선택 로직 ---
let syncSrc = null, syncDst = null;
const ACTIVE_SRC_STYLE = { border: '2px solid #10b981', background: '#ecfdf5', color: '#065f46', fontWeight: '600' };
const ACTIVE_DST_STYLE = { border: '2px solid #4361ee', background: '#eef2ff', color: '#3730a3', fontWeight: '600' };
const INACTIVE_STYLE = { border: '2px solid #e2e8f0', background: 'white', color: '#475569', fontWeight: 'normal' };

function applyBtnStyle(btn, styleObj) {
    Object.assign(btn.style, styleObj);
}

document.querySelectorAll('.sync-node-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const role = btn.getAttribute('data-role');
        const val = btn.getAttribute('data-val');

        if (role === 'src') {
            syncSrc = val;
            // 출발지 선택 하이라이트
            document.querySelectorAll('.sync-node-btn[data-role="src"]').forEach(b => applyBtnStyle(b, INACTIVE_STYLE));
            applyBtnStyle(btn, ACTIVE_SRC_STYLE);

            // 목적지에서 같은 값 비활성화, 나머지 활성화
            document.querySelectorAll('.sync-node-btn[data-role="dst"]').forEach(b => {
                if (b.getAttribute('data-val') === val) {
                    b.disabled = true;
                    Object.assign(b.style, { border: '2px solid #e2e8f0', background: '#f1f5f9', color: '#94a3b8', cursor: 'not-allowed', fontWeight: 'normal' });
                    if (syncDst === val) { syncDst = null; } // 이미 같은 목적지 선택된 경우 초기화
                } else {
                    b.disabled = false;
                    if (syncDst === b.getAttribute('data-val')) {
                        applyBtnStyle(b, ACTIVE_DST_STYLE);
                    } else {
                        applyBtnStyle(b, INACTIVE_STYLE);
                    }
                }
            });
        } else {
            syncDst = val;
            // 목적지 선택 하이라이트
            document.querySelectorAll('.sync-node-btn[data-role="dst"]').forEach(b => {
                if (!b.disabled) applyBtnStyle(b, INACTIVE_STYLE);
            });
            applyBtnStyle(btn, ACTIVE_DST_STYLE);

            // 출발지에서 같은 값 비활성화, 나머지 활성화
            document.querySelectorAll('.sync-node-btn[data-role="src"]').forEach(b => {
                if (b.getAttribute('data-val') === val) {
                    b.disabled = true;
                    Object.assign(b.style, { border: '2px solid #e2e8f0', background: '#f1f5f9', color: '#94a3b8', cursor: 'not-allowed', fontWeight: 'normal' });
                    if (syncSrc === val) { syncSrc = null; }
                } else {
                    b.disabled = false;
                    if (syncSrc === b.getAttribute('data-val')) {
                        applyBtnStyle(b, ACTIVE_SRC_STYLE);
                    } else {
                        applyBtnStyle(b, INACTIVE_STYLE);
                    }
                }
            });
        }

        const nameMap = { pc: '로컬 PC', cloud: '클라우드', phone: '원격 PC' };
        const label = document.getElementById('syncDirectionLabel');
        if (label && syncSrc && syncDst) {
            label.textContent = `${nameMap[syncSrc]} ➜ ${nameMap[syncDst]}`;
        } else if (label && syncSrc) {
            label.textContent = `출발지: ${nameMap[syncSrc]} 선택됨. 목적지를 선택하세요.`;
        } else if (label && syncDst) {
            label.textContent = `목적지: ${nameMap[syncDst]} 선택됨. 출발지를 선택하세요.`;
        }
    });
});


document.getElementById('btnStartSync')?.addEventListener('click', () => {
    if (!syncSrc || !syncDst) return alert('출발지와 목적지를 모두 선택해 주세요.');
    startSync(syncSrc, syncDst);
});




if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

// 제품 마스터 로드
async function loadProductMaster() {
    const statusMaster = document.getElementById('statusMaster');
    try {
        const response = await fetch(`${API_BASE}/api/master-data`);
        if (response.ok) {
            const apiData = await response.json();
            if (apiData.success) {
                productMaster = apiData.masterData;
                console.log(`✅ 제품 마스터 ${productMaster.length}건 로드 완료 (서버 DB)`);
                if (statusMaster) {
                    statusMaster.innerHTML = `<i class="fas fa-database" style="color: #4361ee; margin-right:4px;"></i>상태: 클라우드 DB 연동 완료 (${productMaster.length.toLocaleString()}건)`;
                }
            } else {
                throw new Error(apiData.message);
            }
        } else {
            // DB 연결 실패 시에만 로컬 JSON 시도
            const responseJson = await fetch('products.json');
            if (responseJson.ok) {
                productMaster = await responseJson.json();
                console.log(`✅ 제품 마스터 ${productMaster.length}건 로드 완료 (JSON 백업)`);
                if (statusMaster) {
                    statusMaster.innerHTML = `<i class="fas fa-file-json" style="color: #64748b; margin-right:4px;"></i>상태: 로컬 백업 로드 완료 (${productMaster.length.toLocaleString()}건)`;
                }
            }
        }
    } catch (err) {
        console.error('❌ 제품 마스터 로드 오류:', err);
        if (statusMaster) {
            statusMaster.innerHTML = `<i class="fas fa-exclamation-triangle" style="color: #ef4444; margin-right:4px;"></i>상태: 로드 오류 (DB 확인 필요)`;
        }
    }
}
loadProductMaster();

// --- Custom Field System ---
// --- Dynamic Rules Logic ---

// 목적지 추출 공통 함수
function extractDestination(text) {
    return window.excelParser.extractDestination(text);
}

// 색상 기반 운송사 추출 함수 복구
function getTransporterFromColor(fontColor) {
    return window.excelParser.getTransporterFromColor(fontColor);
}

// 브라우저 환경용 엑셀 읽기 함수 복구
async function readExcelFile(file, type) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const mapping = (window.mappingManager && typeof window.mappingManager.getActiveMapping === 'function') ? window.mappingManager.getActiveMapping() : {};
                
                let results = [];
                if (type === 'original' || type === 'rework') {
                    const targetSheets = type === 'original' ? ["직선적당일", "법인당일", "혼적당일"] : ["재작업당일"];
                    results = await window.excelParser.parseOriginalExcel(data, mapping, targetSheets, type, {
                        stopOnEmptyRow: false,
                        legacyCntrDetection: false,
                        includeExtraFields: true,
                        allowEmptyCntr: true
                    });
                } else {
                    results = await window.excelParser.parseDownloadExcel(data, mapping);
                }
                resolve(results);
            } catch (err) {
                alert('엑셀 파일을 읽는 데 실패했습니다. 파일이 열려있거나 손상되었을 수 있습니다.\n\n상세: ' + err.message);
                if (window.electronAPI && window.electronAPI.logFrontendError) {
                    window.electronAPI.logFrontendError(`[ExcelJS Load Error] ${err.message}`);
                }
                resolve([]);
            }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

// 마스터 데이터 파일 업로드 로직 (동적 매핑 기능 적용)
let currentExcelDataForUpsert = null;
const MASTER_REQUIRED_FIELDS = [
    { id: 'prod_name', label: '제품명(기준키)', guess: ['Model', '제품명', '품명'] },
    { id: 'business_unit', label: '사업부', guess: ['HQ BA(G)', '사업부', '부서'] },
    { id: 'prod_type', label: '제품구분', guess: ['BA(P)', '제품구분', '구분'] },
    { id: 'width', label: '가로', guess: ['Gross Width', 'Net Width', '가로', 'Width'] },
    { id: 'depth', label: '세로', guess: ['Gross Length', 'Net Length', '세로', 'Length', 'Depth'] },
    { id: 'height', label: '높이', guess: ['Gross Height', 'Net Height', '높이', 'Height'] },
    { id: 'weight', label: '무게', guess: ['Gross Weight', 'Net Weight', '중량', '무게', 'Weight'] },
    { id: 'cbm', label: '부피(CBM)', guess: ['Gross Volume', 'Net Volume', '부피', 'CBM', 'Volume'] }
];

document.getElementById('btnUploadMaster').addEventListener('click', async () => {
    const fileInput = document.getElementById('fileMasterUpload');
    const file = fileInput.files[0];

    if (!file) {
        alert("업데이트할 마스터 데이터 엑셀 파일을 선택해주세요.");
        return;
    }

    try {
        const reader = new FileReader();
        reader.onload = async function(e) {
            try {
                const buffer = e.target.result;
                const workbook = new ExcelJS.Workbook();
                await workbook.xlsx.load(buffer);
                const sheet = workbook.worksheets[0];
                const rows = [];
                sheet.eachRow((row) => {
                    const rowData = [];
                    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                        rowData[colNumber - 1] = cell.value?.result !== undefined ? cell.value.result : cell.value;
                    });
                    rows.push(rowData);
                });
                
                if (rows.length < 2) {
                    alert("엑셀 파일에 데이터가 충분하지 않습니다.");
                    return;
                }
                const headerRow = rows[0] || [];
                const headers = [];
                for (let i = 0; i < headerRow.length; i++) {
                    const h = headerRow[i];
                    headers.push({ text: h ? String(h).trim() : `Column ${i+1}`, index: i });
                }
                currentExcelDataForUpsert = rows;

            // 모달 UI 그리기
            const container = document.getElementById('mappingContainer');
            container.innerHTML = '';
            
            // 저장된 매핑 설정 불러오기
            const savedMapping = JSON.parse(localStorage.getItem('masterColumnMapping') || '{}');

            MASTER_REQUIRED_FIELDS.forEach(field => {
                const rowDiv = document.createElement('div');
                rowDiv.style.display = 'flex';
                rowDiv.style.justifyContent = 'space-between';
                rowDiv.style.alignItems = 'center';
                rowDiv.style.background = '#f1f5f9';
                rowDiv.style.padding = '10px';
                rowDiv.style.borderRadius = '6px';
                
                const labelDiv = document.createElement('div');
                labelDiv.innerHTML = `<strong>${field.label}</strong>`;
                labelDiv.style.width = '30%';

                const select = document.createElement('select');
                select.className = 'form-select form-select-sm mapping-select';
                select.dataset.field = field.id;
                select.style.width = '65%';
                
                const defaultOption = document.createElement('option');
                defaultOption.value = '-1';
                defaultOption.text = '선택 안 함 / 없음';
                select.appendChild(defaultOption);

                let bestMatch = -1;
                headers.forEach(h => {
                    const opt = document.createElement('option');
                    opt.value = h.index;
                    opt.text = `[${h.index}] ${h.text}`;
                    select.appendChild(opt);

                    // 자동 매핑 추측 로직
                    if (bestMatch === -1) {
                        const isMatch = field.guess.some(g => h.text.toLowerCase().includes(g.toLowerCase()));
                        if (isMatch) bestMatch = h.index;
                    }
                });

                // 우선순위: 1. 저장된 매핑 2. 자동 추측
                if (savedMapping[field.id] !== undefined && savedMapping[field.id] !== null) {
                    select.value = savedMapping[field.id];
                } else if (bestMatch !== -1) {
                    select.value = bestMatch;
                }

                rowDiv.appendChild(labelDiv);
                rowDiv.appendChild(select);
                container.appendChild(rowDiv);
            });

            document.getElementById('masterMappingModal').style.display = 'flex';
            } catch (err) {
                console.error("엑셀 파싱 에러:", err);
                alert("파일을 읽는 중 에러가 발생했습니다: " + err.message);
            }
        };
        reader.readAsArrayBuffer(file);
    } catch (err) {
        console.error("엑셀 파싱 에러:", err);
        alert("파일을 읽는 중 에러가 발생했습니다.");
    }
});

// 업데이트 실행 버튼 클릭 로직
document.getElementById('btnExecuteMasterUpsert').addEventListener('click', async () => {
    if (!currentExcelDataForUpsert) return;
    const statusMaster = document.getElementById('statusMaster');
    const selects = document.querySelectorAll('.mapping-select');
    const mapping = {};
    let hasNameMapped = false;
    
    selects.forEach(s => {
        const val = parseInt(s.value);
        mapping[s.dataset.field] = val;
        if (s.dataset.field === 'prod_name' && val !== -1) hasNameMapped = true;
    });

    if (!hasNameMapped) {
        alert("'제품명' 항목은 필수적으로 연결되어야 합니다.");
        return;
    }

    // 매핑 설정 로컬 스토리지에 저장
    localStorage.setItem('masterColumnMapping', JSON.stringify(mapping));
    document.getElementById('masterMappingModal').style.display = 'none';
    statusMaster.innerHTML = `<i class="fas fa-spinner fa-spin" style="color: #3b82f6; margin-right:4px;"></i>상태: 파싱 및 업데이트 중...`;
    statusMaster.style.color = '#3b82f6';

    try {
        const dataPayload = [];
        // row 0 is header
        for (let i = 1; i < currentExcelDataForUpsert.length; i++) {
            const row = currentExcelDataForUpsert[i];
            if (!row || row.length === 0) continue;

            const nameIdx = mapping['prod_name'];
            if (nameIdx === -1 || !row[nameIdx]) continue; // 제품명 없으면 스킵

            dataPayload.push({
                prod_name: String(row[nameIdx]).trim(),
                business_unit: mapping['business_unit'] !== -1 ? String(row[mapping['business_unit']] || '').trim() : '',
                prod_type: mapping['prod_type'] !== -1 ? String(row[mapping['prod_type']] || '').trim() : '',
                width: mapping['width'] !== -1 ? (parseFloat(row[mapping['width']]) || 0) : 0,
                height: mapping['height'] !== -1 ? (parseFloat(row[mapping['height']]) || 0) : 0,
                depth: mapping['depth'] !== -1 ? (parseFloat(row[mapping['depth']]) || 0) : 0,
                weight: mapping['weight'] !== -1 ? (parseFloat(row[mapping['weight']]) || 0) : 0,
                cbm: mapping['cbm'] !== -1 ? (parseFloat(row[mapping['cbm']]) || 0) : 0,
            });
        }

        const response = await fetch(`${API_BASE}/api/upsert-master-json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: dataPayload })
        });

        const result = await response.json();

        if (result.success) {
            statusMaster.innerHTML = `<i class="fas fa-check-circle" style="color: #10b981; margin-right:4px;"></i>상태: ${result.message}`;
            statusMaster.style.color = '#10b981';
            
            if (result.masterData) {
                productMaster = result.masterData;
                console.log(`✅ 마스터 데이터 ${productMaster.length}건 새로고침 완료!`);
            }
            alert(`DB 갱신 성공!\n\n${result.message}`);
            if (window.updateDbGlobalStats) window.updateDbGlobalStats();
            document.getElementById('fileMasterUpload').value = ''; 
        } else {
            throw new Error(result.message);
        }
    } catch (err) {
        console.error("❌ 업데이트 실패:", err);
        statusMaster.innerHTML = `<i class="fas fa-exclamation-circle" style="color: #ef4444; margin-right:4px;"></i>상태: 업데이트 실패`;
        statusMaster.style.color = '#ef4444';
        alert(`업데이트 실패: ${err.message}`);
    }
});


// 파일 업로드 (Files 저장)
window.savedRawFiles = window.savedRawFiles || {};
window.savedNativeFileHandles = window.savedNativeFileHandles || {};

fileOriginal.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        window.savedRawFiles['original'] = file;
        statusOriginal.textContent = `업로드됨: ${file.name}`;
        statusOriginal.style.color = '#1e293b';
        localStorage.setItem('lastOrigName', file.name);

        // [FIX] 수동 업로드 시 기존 캐시 데이터 지우기
        originalFile = file;
        originalFile.isReloaded = false;
        originalFile.isAutoLoaded = false;
        originalData = [];

        // 불러오기 버튼 즉시 표시
        lastOrig.textContent = `최근 사용: ${file.name}`;
        btnReloadOriginal.style.display = 'inline-block';

        // Electron webUtils로 파일 경로 저장 (불러오기 시 최신 파일 로드용)
        if (window.electronAPI && window.electronAPI.getPathForFile) {
            const filePath = window.electronAPI.getPathForFile(file);
            if (filePath) {
                const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
                const dirPath = lastSlash !== -1 ? filePath.substring(0, lastSlash) : filePath;

                window.electronAPI.saveFilePath('original', filePath);
                localStorage.setItem('pathOrig', filePath);
                localStorage.setItem('dirOrig', dirPath); // 디렉토리 별도 저장
                pathOriginal.value = filePath;
                console.log('✅ 원본 파일 경로 저장:', filePath);
            }
        } else {
            pathOriginal.value = file.name;
        }

        if (window.autoSaveWorkSession) window.autoSaveWorkSession();
    }
    checkReadyStatus();
});

fileDownload.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        window.savedRawFiles['download'] = file;
        statusDownload.textContent = `업로드됨: ${file.name}`;
        statusDownload.style.color = '#1e293b';
        localStorage.setItem('lastDownName', file.name);

        // [FIX] 수동 업로드 시 기존 캐시 데이터 지우기
        downloadFile = file;
        downloadFile.isReloaded = false;
        downloadFile.isAutoLoaded = false;
        downloadData = [];

        // 불러오기 버튼 즉시 표시
        lastDown.textContent = `최근 사용: ${file.name}`;
        btnReloadDownload.style.display = 'inline-block';

        // Electron webUtils로 파일 경로 저장 (불러오기 시 최신 파일 로드용)
        if (window.electronAPI && window.electronAPI.getPathForFile) {
            const filePath = window.electronAPI.getPathForFile(file);
            if (filePath) {
                // [수정] 전산파일은 파일명이 아닌 폴더 경로만 저장하여 '최신파일 자동불러오기' 연동성 강화
                const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
                const dirPath = lastSlash !== -1 ? filePath.substring(0, lastSlash) : filePath;

                window.electronAPI.saveFilePath('download', filePath);
                localStorage.setItem('pathDown', filePath);
                localStorage.setItem('dirDown', dirPath); // 디렉토리 별도 저장
                pathDownload.value = dirPath;
                console.log('✅ 전산 파일 폴더 경로 저장:', dirPath);
            }
        } else {
            pathDownload.value = file.name;
        }

        if (window.autoSaveWorkSession) window.autoSaveWorkSession();
    }
    checkReadyStatus();
});

// 재작업 파일 업로드
fileRework.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        window.savedRawFiles['rework'] = file;
        statusRework.textContent = `업로드됨: ${file.name}`;
        statusRework.style.color = '#1e293b';
        reworkFile = file;
        if (btnClearRework) {
            btnClearRework.style.display = 'inline-block';
        }

        // Electron webUtils로 파일 경로 저장
        if (window.electronAPI && window.electronAPI.getPathForFile) {
            const filePath = window.electronAPI.getPathForFile(file);
            if (filePath) {
                window.electronAPI.saveFilePath('rework', filePath);
                localStorage.setItem('pathRework', filePath);
                pathRework.value = filePath;
                console.log('✅ 재작업 파일 경로 저장:', filePath);
            }
        } else {
            pathRework.value = file.name;
        }

        if (window.autoSaveWorkSession) window.autoSaveWorkSession();
    } else {
        if (!pathRework.value.trim() && btnClearRework) {
            btnClearRework.style.display = 'none';
        }
    }
    checkReadyStatus();
});

// 마스터 데이터 파일 업로드 로직 추가
document.getElementById('btnUploadMaster').addEventListener('click', async () => {
    const fileInput = document.getElementById('fileMasterUpload');
    const file = fileInput.files[0];
    const statusMaster = document.getElementById('statusMaster');

    if (!file) {
        alert("업데이트할 마스터 데이터 엑셀 파일을 선택해주세요.");
        return;
    }

    const formData = new FormData();
    formData.append('masterFile', file);

    try {
        statusMaster.innerHTML = `<i class="fas fa-spinner fa-spin" style="color: #3b82f6; margin-right:4px;"></i>상태: 업로드 중...`;
        statusMaster.style.color = '#3b82f6';

        const response = await fetch(`${API_BASE}/api/upload-master`, {
            method: 'POST',
            body: formData
        });

        let result;
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            result = await response.json();
        } else {
            const text = await response.text();
            console.error("서버에서 JSON이 아닌 응답이 왔습니다:", text.substring(0, 200));
            throw new Error(`서버 오류 (상태 코드: ${response.status}). 서버가 응답하지 않거나 파일 크기가 너무 큽니다.`);
        }

        if (result.success) {
            statusMaster.innerHTML = `<i class="fas fa-check-circle" style="color: #10b981; margin-right:4px;"></i>상태: 업데이트 성공 (${file.name})`;
            statusMaster.style.color = '#10b981';

            // Reload the local array
            if (result.masterData) {
                productMaster = result.masterData;
                console.log(`✅ 마스터 데이터 ${productMaster.length}건 새로고침 완료!`);
            }
            alert("마스터 데이터가 성공적으로 업데이트되었습니다!\n이제부터 변경된 중량/CBM 기준으로 데이터가 비교됩니다.");
            if (window.updateDbGlobalStats) window.updateDbGlobalStats();
            fileInput.value = ''; // Reset input
        } else {
            throw new Error(result.message);
        }
    } catch (err) {
        console.error("❌ 마스터 업로드 실패:", err);
        statusMaster.innerHTML = `<i class="fas fa-exclamation-circle" style="color: #ef4444; margin-right:4px;"></i>상태: 업로드 실패`;
        statusMaster.style.color = '#ef4444';
        alert(`업로드 실패: ${err.message}`);
    }
});

// 경로 입력 시 자동 저장 및 체크
pathOriginal.addEventListener('input', () => {
    const val = pathOriginal.value.trim();
    originalData = [];  // 캐시 초기화
    originalFile = null; // 파일 객체 초기화
    if (val) {
        localStorage.setItem('pathOrig', val);
        if (window.electronAPI) {
            window.electronAPI.saveFilePath('original', val);
        }
        statusOriginal.innerHTML = `<i class="fas fa-folder-open" style="color:#059669; margin-right:4px;"></i>상태: 경로 입력됨 (자동 로드)`;
        statusOriginal.style.color = '#059669';
    } else {
        localStorage.removeItem('pathOrig');
        if (window.electronAPI) window.electronAPI.saveFilePath('original', null);
        statusOriginal.textContent = "상태: 대기 중";
        statusOriginal.style.color = '#64748b';
    }
    checkReadyStatus();
});

pathRework.addEventListener('input', () => {
    const val = pathRework.value.trim();
    reworkData = []; // 캐시 초기화
    reworkFile = null; // 파일 객체 초기화
    if (val) {
        localStorage.setItem('pathRework', val);
        if (window.electronAPI) {
            window.electronAPI.saveFilePath('rework', val);
        }
        statusRework.innerHTML = `<i class="fas fa-folder-open" style="color:#059669; margin-right:4px;"></i>상태: 경로 입력됨 (자동 로드)`;
        statusRework.style.color = '#059669';
        if (btnClearRework) btnClearRework.style.display = 'inline-block';
    } else {
        localStorage.removeItem('pathRework');
        if (window.electronAPI) window.electronAPI.saveFilePath('rework', null);
        statusRework.textContent = "상태: 대기 중";
        statusRework.style.color = '#64748b';
        if (btnClearRework) btnClearRework.style.display = 'none';
    }
    checkReadyStatus();
});

pathDownload.addEventListener('input', () => {
    const val = pathDownload.value.trim();
    downloadData = []; // 캐시 초기화
    downloadFile = null; // 파일 객체 초기화
    if (val) {
        let dir = val;
        const lastSlash = Math.max(val.lastIndexOf('/'), val.lastIndexOf('\\'));
        if (val.toLowerCase().endsWith('.xlsx') || val.toLowerCase().endsWith('.xls') || val.toLowerCase().endsWith('.xlsm')) {
            dir = lastSlash !== -1 ? val.substring(0, lastSlash) : val;
        }
        localStorage.setItem('dirDown', dir);
        localStorage.setItem('pathDown', val);
        if (window.electronAPI) {
            window.electronAPI.saveFilePath('download', val);
        }
        statusDownload.innerHTML = `<i class="fas fa-folder-open" style="color:#059669; margin-right:4px;"></i>상태: 경로 입력됨 (${dir})`;
        statusDownload.style.color = '#059669';
    } else {
        localStorage.removeItem('pathDown');
        localStorage.removeItem('dirDown');
        if (window.electronAPI) window.electronAPI.saveFilePath('download', null);
        statusDownload.textContent = "상태: 대기 중";
        statusDownload.style.color = '#64748b';
    }
    checkReadyStatus();
});

if (btnClearRework) {
    btnClearRework.addEventListener('click', () => {
        reworkFile = null;
        pathRework.value = "";
        fileRework.value = "";
        localStorage.removeItem('pathRework');
        if (window.electronAPI) window.electronAPI.saveFilePath('rework', null);
        statusRework.textContent = "상태: 대기 중";
        statusRework.style.color = '#64748b';
        btnClearRework.style.display = 'none';
        if (btnReloadRework) btnReloadRework.style.display = 'none';
        checkReadyStatus();
    });
}

// 원본/전산 해제 버튼
if (btnClearOriginal) {
    btnClearOriginal.addEventListener('click', () => {
        originalData = [];
        originalFile = null;
        pathOriginal.value = "";
        localStorage.removeItem('pathOrig');
        if (window.electronAPI) window.electronAPI.saveFilePath('original', null);
        statusOriginal.textContent = "상태: 대기 중";
        statusOriginal.style.color = '#64748b';
        btnClearOriginal.style.display = 'none';
        checkReadyStatus();
    });
}
if (btnClearDown) {
    btnClearDown.addEventListener('click', () => {
        downloadData = [];
        downloadFile = null;
        pathDownload.value = "";
        localStorage.removeItem('pathDown');
        if (window.electronAPI) window.electronAPI.saveFilePath('download', null);
        statusDownload.textContent = "상태: 대기 중";
        statusDownload.style.color = '#64748b';
        btnClearDown.style.display = 'none';
        checkReadyStatus();
    });
}

// =========================================================================
//  창고재고 파일 업로드 핸들러
// =========================================================================
(function setupWarehouseStockHandlers() {
    const fileWarehouseStock = document.getElementById('fileWarehouseStock');
    const statusWarehouseStock = document.getElementById('statusWarehouseStock');
    const lastWarehouseStock = document.getElementById('lastWarehouseStock');
    const btnClearWarehouseStock = document.getElementById('btnClearWarehouseStock');
    const dongTagBadge = document.getElementById('dongTagBadge');
    const dongPrefixCount = document.getElementById('dongPrefixCount');

    if (!fileWarehouseStock) return;

    fileWarehouseStock.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        statusWarehouseStock.innerHTML = `<i class="fas fa-spinner fa-spin" style="color:#16a34a; margin-right:4px;"></i>상태: 분석 중...`;
        statusWarehouseStock.style.color = '#16a34a';

        try {
            const formData = new FormData();
            formData.append('warehouseFile', file);

            const resp = await fetch(`${API_BASE}/api/parse-warehouse-stock`, {
                method: 'POST',
                body: formData
            });

            let result;
            const contentType = resp.headers.get("content-type");
            if (contentType && contentType.includes("application/json")) {
                result = await resp.json();
            } else {
                const text = await resp.text();
                console.error("서버에서 JSON이 아닌 응답이 왔습니다:", text.substring(0, 200));
                throw new Error(`서버 오류 (상태 코드: ${resp.status}). 서버가 응답하지 않거나 파일 크기가 너무 큽니다.`);
            }

            if (result.success) {
                warehouseStockDongPrefixes = new Set(result.dongPrefixes.map(p => p.toUpperCase()));
                
                // 두 버전의 데이터 백업 변수에 저장 (수동 업로드 경로)
                warehouseStockBlockProductsAll = new Set(
                    (result.blockProductNamesWith17 || []).map(p => p.toUpperCase())
                );
                warehouseStockBlockProductsNo17 = new Set(
                    (result.blockProductNames || []).map(p => p.toUpperCase())
                );
                
                warehouseStockQtyMapAll = result.stockMapWith17 || {};
                warehouseStockQtyMapNo17 = result.stockMap || {};
                
                warehouseHoldStockListAll = result.holdStockListWith17 || [];
                warehouseHoldStockListNo17 = result.holdStockList || [];
                
                warehouseAllStockListAll = result.allStockListWith17 || [];
                warehouseAllStockListNo17 = result.allStockList || [];
                
                warehouseStockLoaded = true;

                // 체크박스 상태에 맞춰 active 변수 업데이트 및 UI 재렌더링
                updateActiveWarehouseStock();

                statusWarehouseStock.innerHTML = `<i class="fas fa-check-circle" style="color:#16a34a; margin-right:4px;"></i>상태: 업로드 완료 (${result.fileName})`;
                statusWarehouseStock.style.color = '#16a34a';
                lastWarehouseStock.textContent = `고유제품 ${result.totalProducts}개 분석 완료`;
                const pathWarehouseEl = document.getElementById('pathWarehouse');
                if (pathWarehouseEl && !window.electronAPI) pathWarehouseEl.value = file.name;
                if (btnClearWarehouseStock) btnClearWarehouseStock.style.display = 'inline-block';

                // (동) 배지 업데이트
                if (dongTagBadge && dongPrefixCount) {
                    dongPrefixCount.textContent = result.dongPrefixes.length;
                    dongTagBadge.style.display = 'inline-flex';
                    dongTagBadge.style.alignItems = 'center';
                    dongTagBadge.style.gap = '4px';
                }

                console.log(`✅ 창고재고 파싱 완료: (동) 접두어 ${result.dongPrefixes.length}개 / Block Qty 대상 ${warehouseStockBlockProducts.size}개`);
                window.savedRawFiles = window.savedRawFiles || {};
                window.savedRawFiles['warehouse'] = file;
                if (window.autoSaveWorkSession) window.autoSaveWorkSession();
            } else {
                throw new Error(result.message);
            }
        } catch (err) {
            console.error('❌ 창고재고 파일 파싱 실패:', err);
            statusWarehouseStock.innerHTML = `<i class="fas fa-exclamation-circle" style="color:#ef4444; margin-right:4px;"></i>상태: 파싱 실패`;
            statusWarehouseStock.style.color = '#ef4444';
            warehouseStockLoaded = false;
            warehouseStockDongPrefixes = new Set();
            warehouseStockBlockProducts = new Set();
            warehouseStockBlockProductsAll = new Set();
            warehouseStockBlockProductsNo17 = new Set();
            warehouseStockQtyMap = {};
            warehouseStockQtyMapAll = {};
            warehouseStockQtyMapNo17 = {};
            warehouseHoldStockList = [];
            warehouseHoldStockListAll = [];
            warehouseHoldStockListNo17 = [];
            warehouseAllStockList = [];
            warehouseAllStockListAll = [];
            warehouseAllStockListNo17 = [];
            alert(`창고재고 파일 파싱 실패: ${err.message}`);
        }
    });

    if (btnClearWarehouseStock) {
        btnClearWarehouseStock.addEventListener('click', () => {
            warehouseStockDongPrefixes = new Set();
            warehouseStockBlockProducts = new Set();
            warehouseStockBlockProductsAll = new Set();
            warehouseStockBlockProductsNo17 = new Set();
            warehouseStockQtyMap = {};
            warehouseStockQtyMapAll = {};
            warehouseStockQtyMapNo17 = {};
            warehouseHoldStockList = [];
            warehouseHoldStockListAll = [];
            warehouseHoldStockListNo17 = [];
            warehouseAllStockList = [];
            warehouseAllStockListAll = [];
            warehouseAllStockListNo17 = [];
            warehouseStockLoaded = false;
            fileWarehouseStock.value = '';
            pathWarehouse.value = '';
            localStorage.removeItem('pathWarehouse');
            if (window.electronAPI) window.electronAPI.saveFilePath('warehouse', null);
            statusWarehouseStock.textContent = '상태: 대기 중 (미사용)';
            statusWarehouseStock.style.color = '#64748b';
            lastWarehouseStock.textContent = '';
            btnClearWarehouseStock.style.display = 'none';
            if (btnReloadWarehouse) btnReloadWarehouse.style.display = 'none';
            if (dongTagBadge) dongTagBadge.style.display = 'none';
            // 비교 결과 재렌더링 ((동) 태그 제거)
            if (comparisonResult && comparisonResult.length > 0) {
                displayResults(comparisonResult, false);
            }
            console.log('🗑️ 창고재고 파일 해제됨 및 영구 삭제');
        });
    }

    if (pathWarehouse) {
        pathWarehouse.addEventListener('input', () => {
            const val = pathWarehouse.value.trim();
            warehouseData = []; // 캐시 초기화
            warehouseFile = null; // 파일 객체 초기화
            if (val) {
                localStorage.setItem('pathWarehouse', val);
                if (window.electronAPI) window.electronAPI.saveFilePath('warehouse', val);
                statusWarehouseStock.innerHTML = `<i class="fas fa-folder-open" style="color:#16a34a; margin-right:4px;"></i>상태: 경로 입력됨 (자동 로드)`;
                statusWarehouseStock.style.color = '#16a34a';
                if (btnReloadWarehouse) btnReloadWarehouse.style.display = 'inline-block';
            } else {
                localStorage.removeItem('pathWarehouse');
                if (window.electronAPI) window.electronAPI.saveFilePath('warehouse', null);
                statusWarehouseStock.textContent = '상태: 대기 중 (미사용)';
                statusWarehouseStock.style.color = '#64748b';
                if (btnReloadWarehouse) btnReloadWarehouse.style.display = 'none';
            }
        });
    }

    if (btnAutoLoadWarehouse) {
        btnAutoLoadWarehouse.addEventListener('click', () => handleAutoLoad('warehouse'));
    }
    if (btnReloadWarehouse) {
        btnReloadWarehouse.addEventListener('click', () => reloadLatestFile('warehouse'));
    }
})();

// =========================================================================
//  H재고리스트 관리 및 카카오톡 이미지 복사/엑셀 다운로드
// =========================================================================
(function setupHoldStockListHandlers() {
    const btnOpenHoldStock = document.getElementById('btnOpenHoldStock');
    const holdStockModal = document.getElementById('holdStockModal');
    const closeHoldStockBtn = document.getElementById('closeHoldStockBtn');
    const closeHoldStockBottomBtn = document.getElementById('closeHoldStockBottomBtn');
    const btnCopyHoldStockImage = document.getElementById('btnCopyHoldStockImage');
    const btnDownloadHoldStockExcel = document.getElementById('btnDownloadHoldStockExcel');
    const searchHoldStock = document.getElementById('searchHoldStock');

    const renderHoldStockTable = () => {
        const tableBody = document.getElementById('holdStockTableBody');
        const countEl = document.getElementById('holdStockCount');
        const filterText = (searchHoldStock ? searchHoldStock.value : '').trim().toUpperCase();
        
        if (!tableBody) return;
        tableBody.innerHTML = '';

        if (!warehouseHoldStockList || warehouseHoldStockList.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="10" style="padding: 40px; color: #94a3b8; text-align: center; font-size: 0.85rem;">
                        <i class="fas fa-info-circle" style="font-size: 1.2rem; margin-bottom: 6px; display: block; color: #cbd5e1;"></i>
                        창고재고 데이터가 업로드되지 않았거나 매칭되는 블록 재고가 없습니다.
                    </td>
                </tr>
            `;
            if (countEl) countEl.textContent = '0';
            return;
        }

        const filtered = warehouseHoldStockList.filter(row => {
            const model = (row.modelName || '').toUpperCase();
            const loc = (row.location || '').toUpperCase();
            return model.includes(filterText) || loc.includes(filterText);
        });

        if (countEl) countEl.textContent = filtered.length;

        if (filtered.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="10" style="padding: 30px; color: #94a3b8; text-align: center;">검색 결과와 일치하는 재고 정보가 없습니다.</td>
                </tr>
            `;
            return;
        }

        const normalContainerModels = new Set();
        if (typeof comparisonResult !== 'undefined' && Array.isArray(comparisonResult)) {
            comparisonResult.forEach(item => {
                if (getContainerStatus(comparisonResult, item.cntrNo) === 'success' && item.prodName) {
                    normalContainerModels.add(item.prodName.toUpperCase());
                }
            });
        }

        filtered.forEach(row => {
            const tr = document.createElement('tr');
            const rowModelStr = (row.modelName || '').toUpperCase();
            const isBlocked = normalContainerModels.has(rowModelStr);

            tr.style.borderBottom = '1px solid #edf2f7';
            tr.style.background = isBlocked ? '#fff5f5' : 'white';
            tr.style.transition = 'background-color 0.15s';
            tr.onmouseenter = () => { tr.style.background = isBlocked ? '#fee2e2' : '#f8fafc'; };
            tr.onmouseleave = () => { tr.style.background = isBlocked ? '#fff5f5' : 'white'; };

            let modelNameHtml = row.modelName || '-';
            if (isBlocked) {
                modelNameHtml += ` <span style="background: #ef4444; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; margin-left: 5px; display: inline-flex; align-items: center; gap: 3px;"><i class="fas fa-lock"></i>작업걸림</span>`;
            }

            tr.innerHTML = `
                <td style="padding: 10px 8px; color: #475569;">${row.division || '-'}</td>
                <td style="padding: 10px 8px; color: #334155; font-weight: 600; white-space: nowrap;">${row.location || '-'}</td>
                <td style="padding: 10px 8px; text-align: left; color: ${isBlocked ? '#dc2626' : '#0f172a'}; font-weight: 600;">${modelNameHtml}</td>
                <td style="padding: 10px 8px; color: #475569; font-weight: 500;">${row.totalQty.toLocaleString()} EA</td>
                <td style="padding: 10px 8px; color: #1e293b; font-weight: 700;">${row.availableQty.toLocaleString()} EA</td>
                <td style="padding: 10px 8px; color: #64748b;">${row.goodQty.toLocaleString()} EA</td>
                <td style="padding: 10px 8px; color: #64748b;">${row.pendingQty.toLocaleString()} EA</td>
                <td style="padding: 10px 8px; color: ${row.oqcHold > 0 ? '#dc2626' : '#94a3b8'}; font-weight: ${row.oqcHold > 0 ? '700' : '400'}; background: ${row.oqcHold > 0 ? '#fef2f2' : 'transparent'};">${row.oqcHold.toLocaleString()} EA</td>
                <td style="padding: 10px 8px; color: ${row.longTermHold > 0 ? '#c2410c' : '#94a3b8'}; font-weight: ${row.longTermHold > 0 ? '700' : '400'}; background: ${row.longTermHold > 0 ? '#fff7ed' : 'transparent'};">${row.longTermHold.toLocaleString()} EA</td>
                <td style="padding: 10px 8px; color: ${row.binBlock > 0 ? '#1d4ed8' : '#94a3b8'}; font-weight: ${row.binBlock > 0 ? '700' : '400'}; background: ${row.binBlock > 0 ? '#eff6ff' : 'transparent'};">${row.binBlock.toLocaleString()} EA</td>
            `;
            tableBody.appendChild(tr);
        });
    };
    window.filterHoldStockTable = renderHoldStockTable;

    if (searchHoldStock) {
        searchHoldStock.addEventListener('input', renderHoldStockTable);
    }

    // 모달 제어
    if (btnOpenHoldStock) {
        btnOpenHoldStock.addEventListener('click', () => {
            if (holdStockModal) {
                holdStockModal.style.display = 'block';
                if (searchHoldStock) searchHoldStock.value = '';
                renderHoldStockTable();
            }
        });
    }

    const closeModal = () => {
        if (holdStockModal) holdStockModal.style.display = 'none';
    };

    if (closeHoldStockBtn) closeHoldStockBtn.addEventListener('click', closeModal);
    if (closeHoldStockBottomBtn) closeHoldStockBottomBtn.addEventListener('click', closeModal);

    // 모달 외부 클릭 시 닫기
    window.addEventListener('click', (event) => {
        if (event.target === holdStockModal) {
            closeModal();
        }
    });

    // 1. 이미지 복사 구현 (카톡 발송용)
    if (btnCopyHoldStockImage) {
        btnCopyHoldStockImage.addEventListener('click', () => {
            const captureContainer = document.getElementById('holdStockCaptureContainer');
            const captureHeader = document.getElementById('holdStockCaptureHeader');
            const captureTime = document.getElementById('holdStockCaptureTime');

            if (!warehouseHoldStockList || warehouseHoldStockList.length === 0) {
                alert("복사할 재고 데이터가 없습니다.");
                return;
            }

            // 캡처용 헤더 타이틀 표시 및 시간 지정
            if (captureHeader && captureTime) {
                captureHeader.style.display = 'flex';
                const now = new Date();
                captureTime.textContent = `기준일시: ${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
            }

            // 캡처 전 스크롤 영역 일시적 확장 및 가로 폭 강제 지정 (가로 잘림 방지)
            const scrollWrapper = document.getElementById('holdStockScrollWrapper');
            let originalMaxHeight = '';
            let originalOverflowY = '';
            if (scrollWrapper) {
                originalMaxHeight = scrollWrapper.style.maxHeight;
                originalOverflowY = scrollWrapper.style.overflowY;
                scrollWrapper.style.maxHeight = 'none';
                scrollWrapper.style.overflowY = 'visible';
            }

            const originalWidth = captureContainer.style.width;
            captureContainer.style.width = '920px'; // 패딩 포함 테이블 최소 가로폭(850px + 여유분)을 수용하기 위해 임시 고정

            btnCopyHoldStockImage.disabled = true;
            btnCopyHoldStockImage.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 복사 중...';

            setTimeout(() => {
                html2canvas(captureContainer, {
                    backgroundColor: '#ffffff',
                    scale: 2, // 고해상도 복사
                    useCORS: true
                }).then(canvas => {
                    // 헤더 비활성화 복원
                    if (captureHeader) captureHeader.style.display = 'none';

                    // 스크롤 영역 및 가로폭 원복
                    if (scrollWrapper) {
                        scrollWrapper.style.maxHeight = originalMaxHeight;
                        scrollWrapper.style.overflowY = originalOverflowY;
                    }
                    captureContainer.style.width = originalWidth;

                    (async () => {
                        try {
                            const successMsg = "📋 H재고 현황 이미지가 클립보드에 성공적으로 복사되었습니다!\n카카오톡 채팅방(Ctrl+V)에 바로 붙여넣어 공지할 수 있습니다.";
                            if (window.isElectron && window.electronAPI && typeof window.electronAPI.writeImageToClipboard === 'function') {
                                const dataUrl = canvas.toDataURL('image/png');
                                const res = await window.electronAPI.writeImageToClipboard(dataUrl);
                                if (res && res.success) {
                                    alert(successMsg);
                                } else {
                                    throw new Error(res ? res.error : '클립보드 복사 실패');
                                }
                            } else if (navigator.clipboard && window.ClipboardItem && canvas.toBlob) {
                                const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                                if (!blob) throw new Error("이미지 데이터 생성 실패");
                                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                                alert(successMsg);
                            } else {
                                throw new Error("브라우저에서 이미지 클립보드 복사를 지원하지 않습니다.");
                            }
                        } catch (err) {
                            console.error("클립보드 복사 오류:", err);
                            alert("이미지 클립보드 복사 실패: " + err.message);
                        } finally {
                            btnCopyHoldStockImage.disabled = false;
                            btnCopyHoldStockImage.innerHTML = '<i class="far fa-copy"></i> 이미지 복사 (카톡 공지용)';
                        }
                    })();
                }).catch(err => {
                    if (captureHeader) captureHeader.style.display = 'none';

                    // 스크롤 영역 및 가로폭 원복
                    if (scrollWrapper) {
                        scrollWrapper.style.maxHeight = originalMaxHeight;
                        scrollWrapper.style.overflowY = originalOverflowY;
                    }
                    captureContainer.style.width = originalWidth;

                    btnCopyHoldStockImage.disabled = false;
                    btnCopyHoldStockImage.innerHTML = '<i class="far fa-copy"></i> 이미지 복사 (카톡 공지용)';
                    console.error("html2canvas 오류:", err);
                    alert("캡처 중 오류가 발생했습니다: " + err.message);
                });
            }, 100);
        });
    }

    // 2. 엑셀 다운로드 구현
    if (btnDownloadHoldStockExcel) {
        btnDownloadHoldStockExcel.addEventListener('click', async () => {
            if (!warehouseHoldStockList || warehouseHoldStockList.length === 0) {
                alert("다운로드할 재고 데이터가 없습니다.");
                return;
            }

            btnDownloadHoldStockExcel.disabled = true;
            btnDownloadHoldStockExcel.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 내보내는 중...';

            try {
                // 현재 검색창 필터링이 적용된 상태의 데이터를 추출하여 다운로드 요청
                const filterText = (searchHoldStock ? searchHoldStock.value : '').trim().toUpperCase();
                const filtered = warehouseHoldStockList.filter(row => {
                    const model = (row.modelName || '').toUpperCase();
                    const loc = (row.location || '').toUpperCase();
                    return model.includes(filterText) || loc.includes(filterText);
                });

                const response = await fetch(`${API_BASE}/api/export-hold-stock`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ list: filtered })
                });

                if (!response.ok) throw new Error("서버 에러가 발생했습니다.");

                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                
                const now = new Date();
                const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
                a.download = `H재고리스트_${dateStr}.xlsx`;
                
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
            } catch (err) {
                console.error("엑셀 내보내기 오류:", err);
                alert("엑셀 다운로드 중 오류가 발생했습니다: " + err.message);
            } finally {
                btnDownloadHoldStockExcel.disabled = false;
                btnDownloadHoldStockExcel.innerHTML = '<i class="far fa-file-excel"></i> 엑셀 다운로드';
            }
        });
    }
})();

// =========================================================================
//  제품 로케이션별 상세 재고 집계 전역 함수 (작업가능/블록/유사/동일 모델)
// =========================================================================
function getProductLocationStockDetails(prodName, prodType = '') {
    if (!warehouseStockLoaded) return null;
    const nameUpper = (prodName || '').trim().toUpperCase();
    if (!nameUpper || nameUpper === 'NONASSET.ITEM') return null;

    const stockInfo = (warehouseStockQtyMap && warehouseStockQtyMap[nameUpper]) || {
        physical: 0,
        good: 0,
        pending: 0,
        available: 0,
        block: 0,
        oqc: 0,
        longTerm: 0,
        bin: 0,
        workTotal: 0
    };

    const totalNeeded = window.totalProductRemainMap ? (window.totalProductRemainMap[nameUpper] || 0) : 0;

    // 1. 기준 제품 로케이션별 수량 집계 (작업가능 재고: Good / Pending)
    const locMap = {};

    const allMatches = (warehouseAllStockList || []).filter(item => (item.modelName || '').trim().toUpperCase() === nameUpper);
    allMatches.forEach(item => {
        const loc = (item.location || '미지정').trim();
        const good = item.goodQty || 0;
        const pending = item.pendingQty || 0;
        const workTotal = good + pending;

        if (workTotal > 0 || (item.physicalQty > 0 && !item.blockQty)) {
            if (!locMap[loc]) {
                locMap[loc] = { 
                    location: loc, 
                    physicalQty: 0, 
                    goodQty: 0, 
                    pendingQty: 0, 
                    workTotalQty: 0
                };
            }
            locMap[loc].physicalQty += (item.physicalQty || 0);
            locMap[loc].goodQty += good;
            locMap[loc].pendingQty += pending;
            locMap[loc].workTotalQty += workTotal;
        }
    });

    const locations = Object.values(locMap).sort((a, b) => a.location.localeCompare(b.location));

    // 작업가능 합계 산출 (로케이션 집계 기준)
    const totalGood = locations.reduce((sum, loc) => sum + loc.goodQty, 0);
    const totalPending = locations.reduce((sum, loc) => sum + loc.pendingQty, 0);
    const totalWork = totalGood + totalPending;

    // 2. 블록/홀드/롱텀/BIN 로케이션별 수량 집계
    const blockLocMap = {};

    // 2-1. warehouseHoldStockList에서 수집
    const holdItems = (warehouseHoldStockList || []).filter(item => (item.modelName || '').trim().toUpperCase() === nameUpper);
    holdItems.forEach(item => {
        const loc = (item.location || '미지정').trim();
        if (!blockLocMap[loc]) {
            blockLocMap[loc] = {
                location: loc,
                oqcHold: 0,
                longTermHold: 0,
                binBlock: 0,
                totalBlock: 0
            };
        }
        blockLocMap[loc].oqcHold += (item.oqcHold || 0);
        blockLocMap[loc].longTermHold += (item.longTermHold || 0);
        blockLocMap[loc].binBlock += (item.binBlock || 0);
        blockLocMap[loc].totalBlock += ((item.oqcHold || 0) + (item.longTermHold || 0) + (item.binBlock || 0));
    });

    // 2-2. allMatches에서도 block 수량 보완
    allMatches.forEach(item => {
        const oqc = item.oqcHold || 0;
        const lt = item.longTermHold || 0;
        const bin = item.binBlock || 0;
        const total = (oqc + lt + bin) || (item.blockQty || 0);

        if (total > 0) {
            const loc = (item.location || '미지정').trim();
            if (!blockLocMap[loc]) {
                blockLocMap[loc] = {
                    location: loc,
                    oqcHold: oqc,
                    longTermHold: lt,
                    binBlock: bin,
                    totalBlock: total
                };
            }
        }
    });

    const blockLocations = Object.values(blockLocMap)
        .filter(loc => loc.totalBlock > 0)
        .sort((a, b) => a.location.localeCompare(b.location));

    const totalOqc = blockLocations.reduce((s, l) => s + l.oqcHold, 0);
    const totalLongTerm = blockLocations.reduce((s, l) => s + l.longTermHold, 0);
    const totalBin = blockLocations.reduce((s, l) => s + l.binBlock, 0);
    const totalBlock = blockLocations.reduce((s, l) => s + l.totalBlock, 0);

    const effectiveStockInfo = {
        physical: stockInfo.physical || (totalWork + totalBlock),
        good: stockInfo.good !== undefined && stockInfo.good > 0 ? stockInfo.good : totalGood,
        pending: stockInfo.pending !== undefined && stockInfo.pending > 0 ? stockInfo.pending : totalPending,
        workTotal: totalWork > 0 ? totalWork : (stockInfo.workTotal || (totalGood + totalPending)),
        available: stockInfo.available || totalWork,
        block: totalBlock > 0 ? totalBlock : (stockInfo.block || 0),
        oqc: totalOqc > 0 ? totalOqc : (stockInfo.oqc || 0),
        longTerm: totalLongTerm > 0 ? totalLongTerm : (stockInfo.longTerm || 0),
        bin: totalBin > 0 ? totalBin : (stockInfo.bin || 0)
    };

    // 3. 연관 모델 탐색 (유사 모델 [유] 및 동일 서픽스 [동]) - 제품구분이 'Q'인 경우에만 적용!
    const relatedGroups = [];
    const targetPrefix = nameUpper.includes('.') ? nameUpper.substring(0, nameUpper.lastIndexOf('.')) : nameUpper;
    const pt = (prodType || '').trim().toUpperCase();

    let isQType = (pt === 'Q');
    if (!isQType && comparisonResult && Array.isArray(comparisonResult)) {
        const foundItem = comparisonResult.find(it => (it.prodName || '').trim().toUpperCase() === nameUpper);
        if (foundItem && (foundItem.prodType || '').trim().toUpperCase() === 'Q') {
            isQType = true;
        }
    }
    if (!isQType && processedAvailabilityData && Array.isArray(processedAvailabilityData)) {
        const foundItem = processedAvailabilityData.find(it => (it.prodName || '').trim().toUpperCase() === nameUpper);
        if (foundItem && (foundItem.prodType || '').trim().toUpperCase() === 'Q') {
            isQType = true;
        }
    }
    if (!isQType && productMaster && Array.isArray(productMaster)) {
        const pmMatch = productMaster.find(p => (p.name || '').trim().toUpperCase() === nameUpper);
        if (pmMatch && (pmMatch.prodType || pmMatch.type || '').trim().toUpperCase() === 'Q') {
            isQType = true;
        }
    }

    if (isQType) {
        // 3-1. [유] 유사 모델 탐색 (창고에 실물/가용 재고가 존재하는 모델만 대상)
        if (targetPrefix.length >= 3) {
            const candidates = new Set();
            if (warehouseStockLoaded && warehouseStockQtyMap) {
                Object.entries(warehouseStockQtyMap).forEach(([mName, sInfo]) => {
                    const hasStock = (sInfo.physical || 0) > 0 || (sInfo.good || 0) > 0 || (sInfo.available || 0) > 0 || (sInfo.pending || 0) > 0;
                    if (hasStock) candidates.add(mName.toUpperCase().trim());
                });
            }
            if (warehouseAllStockList && Array.isArray(warehouseAllStockList)) {
                warehouseAllStockList.forEach(item => {
                    const qty = (item.goodQty !== undefined || item.pendingQty !== undefined)
                        ? ((item.goodQty || 0) + (item.pendingQty || 0))
                        : (item.physicalQty || 0);
                    if (qty > 0 && item.modelName) candidates.add(item.modelName.toUpperCase().trim());
                });
            }

            const simList = [];
            const maxAllowedDiff = (targetPrefix.length <= 7) ? 1 : 2;

            candidates.forEach(cand => {
                if (cand === nameUpper) return;
                const candPrefix = cand.includes('.') ? cand.substring(0, cand.lastIndexOf('.')) : cand;
                if (candPrefix === targetPrefix) return;
                const prefixDist = getGlobalLevenshteinDistance(targetPrefix, candPrefix);
                if (prefixDist >= 1 && prefixDist <= maxAllowedDiff) {
                    simList.push({ name: cand, diff: prefixDist });
                }
            });

            simList.sort((a, b) => a.diff - b.diff || a.name.localeCompare(b.name));

            simList.forEach(sim => {
                const simName = sim.name;
                const simLocMap = {};
                const matches = (warehouseAllStockList || []).filter(item => (item.modelName || '').trim().toUpperCase() === simName);
                matches.forEach(item => {
                    const loc = (item.location || '미지정').trim();
                    const gQty = item.goodQty !== undefined ? item.goodQty : 0;
                    const pQty = item.pendingQty !== undefined ? item.pendingQty : 0;
                    const wTotal = (gQty + pQty) > 0 ? (gQty + pQty) : (item.physicalQty || 0);
                    if (wTotal > 0) {
                        if (!simLocMap[loc]) {
                            simLocMap[loc] = { location: loc, goodQty: 0, pendingQty: 0, workTotalQty: 0 };
                        }
                        simLocMap[loc].goodQty += gQty;
                        simLocMap[loc].pendingQty += pQty;
                        simLocMap[loc].workTotalQty += wTotal;
                    }
                });
                const simLocations = Object.values(simLocMap).sort((a, b) => a.location.localeCompare(b.location));
                const simGood = simLocations.reduce((s, l) => s + l.goodQty, 0);
                const simPending = simLocations.reduce((s, l) => s + l.pendingQty, 0);
                const simTotal = simLocations.reduce((s, l) => s + l.workTotalQty, 0);

                if (simTotal <= 0 || simLocations.length === 0) return; // 재고가 0인 유사 모델은 팝업 제외

                relatedGroups.push({
                    type: 'similar',
                    tag: '유',
                    title: `유사 모델 (${sim.diff}글자 차이)`,
                    modelName: simName,
                    locations: simLocations,
                    totalGood: simGood,
                    totalPending: simPending,
                    totalWork: simTotal
                });
            });
        }

        // 3-2. [동] 동일 접두어 모델 탐색 (창고에 실물/가용 재고가 존재하는 모델만 대상)
        if (targetPrefix.length >= 3 && nameUpper.includes('.')) {
            const prefix = targetPrefix;
            const dongCandidates = new Set();

            (warehouseAllStockList || []).forEach(item => {
                const mUpper = (item.modelName || '').trim().toUpperCase();
                const qty = (item.goodQty !== undefined || item.pendingQty !== undefined)
                    ? ((item.goodQty || 0) + (item.pendingQty || 0))
                    : (item.physicalQty || 0);
                if (qty > 0 && mUpper !== nameUpper && mUpper.startsWith(prefix + '.')) {
                    dongCandidates.add(mUpper);
                }
            });

            dongCandidates.forEach(dongName => {
                if (relatedGroups.some(g => g.modelName === dongName)) return;

                const dongLocMap = {};
                const matches = (warehouseAllStockList || []).filter(item => (item.modelName || '').trim().toUpperCase() === dongName);
                matches.forEach(item => {
                    const loc = (item.location || '미지정').trim();
                    const gQty = item.goodQty !== undefined ? item.goodQty : 0;
                    const pQty = item.pendingQty !== undefined ? item.pendingQty : 0;
                    const wTotal = (gQty + pQty) > 0 ? (gQty + pQty) : (item.physicalQty || 0);
                    if (wTotal > 0) {
                        if (!dongLocMap[loc]) {
                            dongLocMap[loc] = { location: loc, goodQty: 0, pendingQty: 0, workTotalQty: 0 };
                        }
                        dongLocMap[loc].goodQty += gQty;
                        dongLocMap[loc].pendingQty += pQty;
                        dongLocMap[loc].workTotalQty += wTotal;
                    }
                });
                const dongLocations = Object.values(dongLocMap).sort((a, b) => a.location.localeCompare(b.location));
                const dongGood = dongLocations.reduce((s, l) => s + l.goodQty, 0);
                const dongPending = dongLocations.reduce((s, l) => s + l.pendingQty, 0);
                const dongTotal = dongLocations.reduce((s, l) => s + l.workTotalQty, 0);

                if (dongTotal <= 0 || dongLocations.length === 0) return; // 재고가 0인 동일접두어 모델은 팝업 제외

                relatedGroups.push({
                    type: 'dong',
                    tag: '동',
                    title: `동일 제품군 (접두어 일치)`,
                    modelName: dongName,
                    locations: dongLocations,
                    totalGood: dongGood,
                    totalPending: dongPending,
                    totalWork: dongTotal
                });
            });
        }
    }

    return {
        name: nameUpper,
        stockInfo: effectiveStockInfo,
        totalNeeded,
        locations,
        blockLocations,
        relatedGroups
    };
}
window.getProductLocationStockDetails = getProductLocationStockDetails;

// =========================================================================
//  홀드·롱텀·BIN블록 작업 공지 리스트 및 이미지 복사/엑셀 다운로드
// =========================================================================
(function setupBlockWorkListHandlers() {
    const btnOpenBlockWork = document.getElementById('btnOpenBlockWork');
    const btnOpenBlockWorkFromToolbar = document.getElementById('btnOpenBlockWorkFromToolbar');
    const blockWorkModal = document.getElementById('blockWorkModal');
    const closeBlockWorkBtn = document.getElementById('closeBlockWorkBtn');
    const closeBlockWorkBottomBtn = document.getElementById('closeBlockWorkBottomBtn');
    const btnCopyBlockWorkImage = document.getElementById('btnCopyBlockWorkImage');
    const btnDownloadBlockWorkExcel = document.getElementById('btnDownloadBlockWorkExcel');
    const searchBlockWork = document.getElementById('searchBlockWork');
    const blockWorkBadge = document.getElementById('blockWorkBadge');

    // 블록 연관 작업 항목 수집 함수
    const getBlockWorkItems = () => {
        if (!comparisonResult || !Array.isArray(comparisonResult) || comparisonResult.length === 0) return [];
        if (!warehouseStockLoaded || !warehouseStockQtyMap) return [];

        const blockItems = [];
        comparisonResult.forEach(item => {
            if (!item.prodName) return;
            const status = typeof getContainerStatus === 'function' ? getContainerStatus(comparisonResult, item.cntrNo) : 'success';
            // 정상 작업 컨테이너(또는 승인된 항목)를 우선 대상
            if (status !== 'success' && !item.isApproved) return;

            const nameUpper = item.prodName.trim().toUpperCase();
            const stockInfo = warehouseStockQtyMap[nameUpper];
            if (!stockInfo) return;

            const hasOqc = (stockInfo.oqc || 0) > 0;
            const hasLongTerm = (stockInfo.longTerm || 0) > 0;
            const hasBin = (stockInfo.bin || 0) > 0;

            if (hasOqc || hasLongTerm || hasBin) {
                // 로케이션 정보 추출
                const details = getProductLocationStockDetails(item.prodName, item.prodType);
                
                // 1. 블록 로케이션 문자열 구성 및 로케이션별 블록 맵
                const blockLocList = [];
                const blockLocItemObjects = [];
                const blockLocWarningMap = {}; // { '24-1-04-14-0': '롱텀 2EA' }
                if (details && details.blockLocations && details.blockLocations.length > 0) {
                    details.blockLocations.forEach(b => {
                        const tags = [];
                        const warnTags = [];
                        const badgeList = [];
                        if (b.oqcHold > 0) {
                            tags.push(`${b.oqcHold}EA (홀드)`);
                            warnTags.push(`홀드 ${b.oqcHold}EA`);
                            badgeList.push({ qty: `${b.oqcHold}EA`, type: '홀드', bg: '#ef4444' });
                        }
                        if (b.longTermHold > 0) {
                            tags.push(`${b.longTermHold}EA (롱텀)`);
                            warnTags.push(`롱텀 ${b.longTermHold}EA`);
                            badgeList.push({ qty: `${b.longTermHold}EA`, type: '롱텀', bg: '#8b5cf6' });
                        }
                        if (b.binBlock > 0) {
                            tags.push(`${b.binBlock}EA (BIN블록)`);
                            warnTags.push(`BIN블록 ${b.binBlock}EA`);
                            badgeList.push({ qty: `${b.binBlock}EA`, type: 'BIN블록', bg: '#e11d48' });
                        }
                        if (tags.length === 0 && b.totalBlock > 0) {
                            tags.push(`${b.totalBlock}EA (블록)`);
                            warnTags.push(`블록 ${b.totalBlock}EA`);
                            badgeList.push({ qty: `${b.totalBlock}EA`, type: '블록', bg: '#64748b' });
                        }
                        blockLocList.push(`${b.location}: ${tags.join(', ')}`);
                        blockLocItemObjects.push({
                            location: b.location,
                            badges: badgeList
                        });
                        const cleanLoc = (b.location || '').trim().toUpperCase();
                        if (cleanLoc && cleanLoc !== '미지정') {
                            blockLocWarningMap[cleanLoc] = warnTags.join(', ');
                        }
                    });
                } else {
                    const fallbackTags = [];
                    if (hasOqc) fallbackTags.push(`${stockInfo.oqc}EA (홀드)`);
                    if (hasLongTerm) fallbackTags.push(`${stockInfo.longTerm}EA (롱텀)`);
                    if (hasBin) fallbackTags.push(`${stockInfo.bin}EA (BIN블록)`);
                    blockLocList.push(`위치 미지정 (${fallbackTags.join(', ')})`);
                }

                // 2. 정상 가용 로케이션 문자열 구성 (혼적 검사 포함)
                const goodLocList = [];
                const goodLocItemObjects = [];
                if (details && details.locations && details.locations.length > 0) {
                    details.locations.forEach(g => {
                        if (g.goodQty > 0 || g.pendingQty > 0 || g.workTotalQty > 0) {
                            const parts = [];
                            if (g.goodQty > 0) parts.push(`${g.goodQty}EA`);
                            if (g.pendingQty > 0) parts.push(`팬딩 ${g.pendingQty}EA`);
                            const cleanLoc = (g.location || '').trim().toUpperCase();
                            const isMixed = cleanLoc && cleanLoc !== '미지정' && !!blockLocWarningMap[cleanLoc];
                            const mixReason = isMixed ? blockLocWarningMap[cleanLoc] : '';
                            
                            goodLocItemObjects.push({
                                location: g.location,
                                qtyStr: parts.join(' + '),
                                isMixed: isMixed,
                                mixReason: mixReason
                            });

                            if (isMixed) {
                                goodLocList.push(`${g.location}: ${parts.join(' + ')} [⚠️ ${mixReason} 혼적]`);
                            } else {
                                goodLocList.push(`${g.location}: ${parts.join(' + ')}`);
                            }
                        }
                    });
                }
                if (goodLocList.length === 0) {
                    goodLocList.push(stockInfo.good > 0 ? `양품: ${stockInfo.good}EA (위치 미지정)` : '가용 로케이션 없음');
                }

                blockItems.push({
                    cntrNo: item.cntrNo || '-',
                    transporter: item.transporter || '',
                    type: item.type || '대기',
                    division: item.division || '-',
                    prodType: item.prodType || '-',
                    prodName: item.prodName || '-',
                    qtyInfo: item.qtyInfo || {},
                    hasOqc,
                    hasLongTerm,
                    hasBin,
                    stockInfo,
                    blockLocStr: blockLocList.join('\n') || '-',
                    blockLocItems: blockLocItemObjects,
                    goodLocStr: goodLocList.join('\n') || '-',
                    goodLocItems: goodLocItemObjects
                });
            }
        });

        return blockItems;
    };

    // 테이블 렌더링
    const renderBlockWorkTable = () => {
        const tableBody = document.getElementById('blockWorkTableBody');
        const countEl = document.getElementById('blockWorkCount');
        const cntrCountEl = document.getElementById('blockWorkCntrCount');
        const filterText = (searchBlockWork ? searchBlockWork.value : '').trim().toUpperCase();

        if (!tableBody) return;
        tableBody.innerHTML = '';

        const allItems = getBlockWorkItems();
        const filtered = allItems.filter(row => {
            const cntr = (row.cntrNo || '').toUpperCase();
            const prod = (row.prodName || '').toUpperCase();
            const trans = (row.transporter || '').toUpperCase();
            return cntr.includes(filterText) || prod.includes(filterText) || trans.includes(filterText);
        });

        const uniqueCntrs = new Set(filtered.map(r => r.cntrNo));
        if (countEl) countEl.textContent = filtered.length;
        if (cntrCountEl) cntrCountEl.textContent = uniqueCntrs.size;

        if (filtered.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="6" style="padding: 35px; color: #94a3b8; text-align: center; font-size: 0.85rem; border: 1px solid #cbd5e1;">
                        <i class="fas fa-check-circle" style="font-size: 1.3rem; margin-bottom: 6px; display: block; color: #10b981;"></i>
                        ${filterText ? '검색 조건과 일치하는 블록 작업이 없습니다.' : '현재 작업 건 중 홀드/롱텀/BIN블록 재고가 걸려있는 항목이 없습니다.'}
                    </td>
                </tr>
            `;
            return;
        }

        filtered.forEach(row => {
            const tr = document.createElement('tr');
            tr.style.transition = 'background-color 0.15s';
            tr.onmouseenter = () => { tr.style.background = '#faf5ff'; };
            tr.onmouseleave = () => { tr.style.background = 'white'; };

            // 태그 뱃지 생성
            const tags = [];
            if (row.hasOqc) tags.push(`<span style="display:inline-block; margin-left:3px; font-size:0.7rem; color:#fff; background:#ef4444; border-radius:3px; padding:1px 5px; font-weight:700;">H</span>`);
            if (row.hasLongTerm) tags.push(`<span style="display:inline-block; margin-left:3px; font-size:0.7rem; color:#fff; background:#8b5cf6; border-radius:3px; padding:1px 5px; font-weight:700;">L</span>`);
            if (row.hasBin) tags.push(`<span style="display:inline-block; margin-left:3px; font-size:0.7rem; color:#fff; background:#e11d48; border-radius:3px; padding:1px 5px; font-weight:700;">B</span>`);
            const tagHtml = tags.join('');

            const planQty = row.qtyInfo.origPlan || row.qtyInfo.plan || 0;
            const remainQty = row.qtyInfo.remain !== undefined ? row.qtyInfo.remain : planQty;

            // 1. 블록 로케이션 (로케이션 폰트와 수량 컬러 분리)
            let blockLocFormatted = '';
            if (row.blockLocItems && row.blockLocItems.length > 0) {
                blockLocFormatted = row.blockLocItems.map(b => {
                    const badgeHtml = b.badges.map(bg => 
                        `<span style="color:#dc2626; font-weight:800; font-size:0.83rem;">${bg.qty}</span> <span style="display:inline-block; background:${bg.bg}; color:white; padding:1px 5px; border-radius:3px; font-size:0.68rem; font-weight:700; vertical-align:middle; margin-left:2px; margin-right:4px;">${bg.type}</span>`
                    ).join('');
                    return `<div style="line-height:1.6; font-size:0.8rem; white-space:nowrap;">
                        <i class="fas fa-ban" style="font-size:0.7rem; margin-right:5px; color:#ef4444;"></i>
                        <span style="color:#0f172a; font-weight:700; font-family:monospace, sans-serif; font-size:0.83rem;">${b.location}</span><span style="color:#94a3b8; margin:0 3px;">:</span>
                        ${badgeHtml}
                    </div>`;
                }).join('');
            } else {
                blockLocFormatted = row.blockLocStr.split('\n').map(l => {
                    const formatted = l
                        .replace(/(\d+EA)\s*\(홀드\)/g, '<span style="color:#dc2626; font-weight:800;">$1</span> <span style="display:inline-block; background:#ef4444; color:white; padding:1px 5px; border-radius:3px; font-size:0.68rem; font-weight:700; vertical-align:middle;">홀드</span>')
                        .replace(/(\d+EA)\s*\(롱텀\)/g, '<span style="color:#dc2626; font-weight:800;">$1</span> <span style="display:inline-block; background:#8b5cf6; color:white; padding:1px 5px; border-radius:3px; font-size:0.68rem; font-weight:700; vertical-align:middle;">롱텀</span>')
                        .replace(/(\d+EA)\s*\(BIN블록\)/g, '<span style="color:#dc2626; font-weight:800;">$1</span> <span style="display:inline-block; background:#e11d48; color:white; padding:1px 5px; border-radius:3px; font-size:0.68rem; font-weight:700; vertical-align:middle;">BIN블록</span>');
                    return `<div style="line-height:1.6; font-size:0.8rem; white-space:nowrap;"><i class="fas fa-ban" style="font-size:0.7rem; margin-right:5px; color:#ef4444;"></i>${formatted}</div>`;
                }).join('');
            }

            // 2. 정상 피킹 로케이션 (로케이션과 수량 색상 분리 및 혼적 태그 인라인 배치)
            let goodLocFormatted = '';
            if (row.goodLocItems && row.goodLocItems.length > 0) {
                goodLocFormatted = row.goodLocItems.map(g => {
                    if (g.isMixed) {
                        return `<div style="line-height:1.6; font-size:0.8rem; white-space:nowrap;">
                            <i class="fas fa-exclamation-triangle" style="font-size:0.75rem; margin-right:5px; color:#d97706;"></i>
                            <span style="color:#9a3412; font-weight:700; font-family:monospace, sans-serif; font-size:0.83rem;">${g.location}</span><span style="color:#94a3b8; margin:0 3px;">:</span>
                            <span style="color:#047857; font-weight:800; font-size:0.83rem;">${g.qtyStr}</span>
                            <span style="display:inline-block; background:#ea580c; color:white; padding:1px 6px; border-radius:3px; font-size:0.68rem; font-weight:700; vertical-align:middle; margin-left:6px;">⚠️ (${g.mixReason} 혼적)</span>
                        </div>`;
                    } else {
                        return `<div style="line-height:1.6; font-size:0.8rem; white-space:nowrap;">
                            <i class="fas fa-check" style="font-size:0.7rem; margin-right:5px; color:#10b981;"></i>
                            <span style="color:#0f172a; font-weight:700; font-family:monospace, sans-serif; font-size:0.83rem;">${g.location}</span><span style="color:#94a3b8; margin:0 3px;">:</span>
                            <span style="color:#047857; font-weight:800; font-size:0.83rem;">${g.qtyStr}</span>
                        </div>`;
                    }
                }).join('');
            } else {
                goodLocFormatted = row.goodLocStr.split('\n').map(l => `<div style="line-height:1.6; color:#047857; font-weight:700; font-size:0.8rem; white-space:nowrap;"><i class="fas fa-check" style="font-size:0.7rem; margin-right:5px;"></i>${l}</div>`).join('');
            }

            // 운송사별 색상 구분 (천마=빨강, BNI=파랑)
            const trans = (row.transporter || '').toUpperCase();
            let cntrColor = '#1e293b';
            let transBadge = '';
            if (trans.includes('천마')) {
                cntrColor = '#dc2626'; // 빨강
                transBadge = `<span style="display:inline-block; font-size:0.68rem; background:#fee2e2; color:#b91c1c; padding:1px 5px; border-radius:4px; margin-left:4px; font-weight:700; border:1px solid #fca5a5;">천마</span>`;
            } else if (trans.includes('BNI')) {
                cntrColor = '#2563eb'; // 파랑
                transBadge = `<span style="display:inline-block; font-size:0.68rem; background:#dbeafe; color:#1d4ed8; padding:1px 5px; border-radius:4px; margin-left:4px; font-weight:700; border:1px solid #93c5fd;">BNI</span>`;
            }

            tr.innerHTML = `
                <td style="padding: 8px 6px; font-weight: 800; color: ${cntrColor}; border: 1px solid #cbd5e1; vertical-align: middle; text-align: center; font-size: 0.84rem; white-space: nowrap;">
                    ${row.cntrNo} ${transBadge}
                </td>
                <td style="padding: 8px 4px; color: #64748b; font-size: 0.78rem; border: 1px solid #cbd5e1; vertical-align: middle; text-align: center;">${row.type}</td>
                <td style="padding: 8px 8px; text-align: left; font-weight: 600; color: #0f172a; border: 1px solid #cbd5e1; vertical-align: middle; word-break: break-word;">
                    ${row.prodName} ${tagHtml}
                </td>
                <td style="padding: 8px 4px; color: #334155; font-weight: 600; border: 1px solid #cbd5e1; vertical-align: middle; text-align: center; font-size: 0.82rem;">
                    ${planQty}<br><span style="font-size:0.72rem; color:#64748b;">(잔여 ${remainQty})</span>
                </td>
                <td style="padding: 8px 8px; text-align: left; background: #fef2f2; border: 1px solid #cbd5e1; vertical-align: middle; word-break: break-word;">
                    ${blockLocFormatted}
                </td>
                <td style="padding: 8px 8px; text-align: left; background: #ecfdf5; border: 1px solid #cbd5e1; vertical-align: middle; word-break: break-word;">
                    ${goodLocFormatted}
                </td>
            `;
            tableBody.appendChild(tr);
        });
    };

    window.updateBlockWorkBadge = () => {
        const items = getBlockWorkItems();
        if (blockWorkBadge) {
            if (items.length > 0) {
                blockWorkBadge.style.display = 'inline-block';
                blockWorkBadge.textContent = items.length;
            } else {
                blockWorkBadge.style.display = 'none';
            }
        }
    };

    const openModal = () => {
        if (blockWorkModal) {
            blockWorkModal.style.display = 'block';
            if (searchBlockWork) searchBlockWork.value = '';
            renderBlockWorkTable();
        }
    };

    const closeModal = () => {
        if (blockWorkModal) blockWorkModal.style.display = 'none';
    };

    if (btnOpenBlockWork) btnOpenBlockWork.addEventListener('click', openModal);
    if (btnOpenBlockWorkFromToolbar) btnOpenBlockWorkFromToolbar.addEventListener('click', openModal);
    if (closeBlockWorkBtn) closeBlockWorkBtn.addEventListener('click', closeModal);
    if (closeBlockWorkBottomBtn) closeBlockWorkBottomBtn.addEventListener('click', closeModal);

    window.addEventListener('click', (event) => {
        if (event.target === blockWorkModal) {
            closeModal();
        }
    });

    if (searchBlockWork) {
        searchBlockWork.addEventListener('input', renderBlockWorkTable);
    }

    // 1. 이미지 복사 구현 (html2canvas)
    if (btnCopyBlockWorkImage) {
        btnCopyBlockWorkImage.addEventListener('click', () => {
            const captureContainer = document.getElementById('blockWorkCaptureContainer');
            const captureHeader = document.getElementById('blockWorkCaptureHeader');
            const captureTime = document.getElementById('blockWorkCaptureTime');

            const allItems = getBlockWorkItems();
            if (allItems.length === 0) {
                alert("공지할 블록 재고 작업 데이터가 없습니다.");
                return;
            }

            if (captureHeader && captureTime) {
                captureHeader.style.display = 'flex';
                const now = new Date();
                captureTime.textContent = `발행일시: ${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
            }

            const scrollWrapper = document.getElementById('blockWorkScrollWrapper');
            let originalMaxHeight = '';
            let originalOverflowY = '';
            if (scrollWrapper) {
                originalMaxHeight = scrollWrapper.style.maxHeight;
                originalOverflowY = scrollWrapper.style.overflowY;
                scrollWrapper.style.maxHeight = 'none';
                scrollWrapper.style.overflowY = 'visible';
            }

            const originalWidth = captureContainer.style.width;
            captureContainer.style.width = '1300px';

            btnCopyBlockWorkImage.disabled = true;
            btnCopyBlockWorkImage.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 복사 중...';

            setTimeout(() => {
                html2canvas(captureContainer, {
                    backgroundColor: '#ffffff',
                    scale: 2,
                    useCORS: true
                }).then(canvas => {
                    if (captureHeader) captureHeader.style.display = 'none';
                    if (scrollWrapper) {
                        scrollWrapper.style.maxHeight = originalMaxHeight;
                        scrollWrapper.style.overflowY = originalOverflowY;
                    }
                    captureContainer.style.width = originalWidth;

                    (async () => {
                        try {
                            const successMsg = "📋 홀드·롱텀·BIN블록 작업 공지 이미지가 클립보드에 성공적으로 복사되었습니다!\n카카오톡 또는 사내 메신저(Ctrl+V)에 바로 붙여넣어 근무자에게 공지할 수 있습니다.";
                            if (window.isElectron && window.electronAPI && typeof window.electronAPI.writeImageToClipboard === 'function') {
                                const dataUrl = canvas.toDataURL('image/png');
                                const res = await window.electronAPI.writeImageToClipboard(dataUrl);
                                if (res && res.success) {
                                    alert(successMsg);
                                } else {
                                    throw new Error(res ? res.error : '클립보드 복사 실패');
                                }
                            } else if (navigator.clipboard && window.ClipboardItem && canvas.toBlob) {
                                const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                                if (!blob) throw new Error("이미지 데이터 생성 실패");
                                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                                alert(successMsg);
                            } else {
                                throw new Error("브라우저에서 이미지 클립보드 복사를 지원하지 않습니다.");
                            }
                        } catch (err) {
                            console.error("클립보드 복사 오류:", err);
                            alert("이미지 클립보드 복사 실패: " + err.message);
                        } finally {
                            btnCopyBlockWorkImage.disabled = false;
                            btnCopyBlockWorkImage.innerHTML = '<i class="far fa-copy"></i> 이미지 복사 (카톡 공지용)';
                        }
                    })();
                }).catch(err => {
                    if (captureHeader) captureHeader.style.display = 'none';
                    if (scrollWrapper) {
                        scrollWrapper.style.maxHeight = originalMaxHeight;
                        scrollWrapper.style.overflowY = originalOverflowY;
                    }
                    captureContainer.style.width = originalWidth;

                    btnCopyBlockWorkImage.disabled = false;
                    btnCopyBlockWorkImage.innerHTML = '<i class="far fa-copy"></i> 이미지 복사 (카톡 공지용)';
                    console.error("html2canvas 오류:", err);
                    alert("이미지 캡처 중 오류가 발생했습니다: " + err.message);
                });
            }, 100);
        });
    }

    // 2. 엑셀 다운로드 구현
    if (btnDownloadBlockWorkExcel) {
        btnDownloadBlockWorkExcel.addEventListener('click', async () => {
            const allItems = getBlockWorkItems();
            if (allItems.length === 0) {
                alert("다운로드할 데이터가 없습니다.");
                return;
            }

            const filterText = (searchBlockWork ? searchBlockWork.value : '').trim().toUpperCase();
            const filtered = allItems.filter(row => {
                const cntr = (row.cntrNo || '').toUpperCase();
                const prod = (row.prodName || '').toUpperCase();
                return cntr.includes(filterText) || prod.includes(filterText);
            });

            btnDownloadBlockWorkExcel.disabled = true;
            btnDownloadBlockWorkExcel.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 내보내는 중...';

            try {
                const wb = new ExcelJS.Workbook();
                const ws = wb.addWorksheet('블록작업공지');

                ws.columns = [
                    { header: '컨테이너번호', key: 'cntrNo', width: 16 },
                    { header: '작업구분', key: 'type', width: 10 },
                    { header: '제품모델명', key: 'prodName', width: 26 },
                    { header: '계획수량', key: 'planQty', width: 10 },
                    { header: '적재수량', key: 'loadQty', width: 10 },
                    { header: '잔여수량', key: 'remainQty', width: 10 },
                    { header: '🚫 블록 재고 위치 (피할 곳)', key: 'blockLoc', width: 38 },
                    { header: '✅ 정상 피킹 위치 (사용할 곳)', key: 'goodLoc', width: 38 }
                ];

                const headerRow = ws.getRow(1);
                headerRow.font = { name: '맑은 고딕', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
                headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6B21A8' } };
                headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
                headerRow.height = 28;

                filtered.forEach(item => {
                    const row = ws.addRow({
                        cntrNo: item.cntrNo,
                        type: item.type,
                        prodName: item.prodName,
                        planQty: item.qtyInfo.origPlan || item.qtyInfo.plan || 0,
                        loadQty: item.qtyInfo.load || 0,
                        remainQty: item.qtyInfo.remain !== undefined ? item.qtyInfo.remain : (item.qtyInfo.origPlan || 0),
                        blockLoc: item.blockLocStr,
                        goodLoc: item.goodLocStr
                    });

                    row.font = { name: '맑은 고딕', size: 10 };
                    row.alignment = { vertical: 'middle', wrapText: true };
                    row.getCell('cntrNo').alignment = { vertical: 'middle', horizontal: 'center' };
                    const trans = (item.transporter || '').toUpperCase();
                    if (trans.includes('천마')) {
                        row.getCell('cntrNo').font = { name: '맑은 고딕', size: 10, bold: true, color: { argb: 'FFDC2626' } };
                    } else if (trans.includes('BNI')) {
                        row.getCell('cntrNo').font = { name: '맑은 고딕', size: 10, bold: true, color: { argb: 'FF2563EB' } };
                    }
                    row.getCell('type').alignment = { vertical: 'middle', horizontal: 'center' };
                    row.getCell('planQty').alignment = { vertical: 'middle', horizontal: 'right' };
                    row.getCell('loadQty').alignment = { vertical: 'middle', horizontal: 'right' };
                    row.getCell('remainQty').alignment = { vertical: 'middle', horizontal: 'right' };
                    row.getCell('blockLoc').font = { name: '맑은 고딕', size: 10, color: { argb: 'FFDC2626' }, bold: true };
                    row.getCell('goodLoc').font = { name: '맑은 고딕', size: 10, color: { argb: 'FF047857' } };
                });

                const buffer = await wb.xlsx.writeBuffer();
                const now = new Date();
                const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
                const fileName = `블록작업_공지리스트_${dateStr}.xlsx`;

                if (window.electronAPI && window.electronAPI.saveExcel) {
                    const res = await window.electronAPI.saveExcel(buffer, fileName);
                    if (res && res.success) {
                        alert(`✅ 엑셀 파일이 저장되었습니다:\n${res.filePath}`);
                    }
                } else {
                    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = fileName;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    window.URL.revokeObjectURL(url);
                }
            } catch (err) {
                console.error("블록작업 엑셀 내보내기 오류:", err);
                alert("엑셀 다운로드 중 오류가 발생했습니다: " + err.message);
            } finally {
                btnDownloadBlockWorkExcel.disabled = false;
                btnDownloadBlockWorkExcel.innerHTML = '<i class="far fa-file-excel"></i> 엑셀 다운로드';
            }
        });
    }
})();

// Levenshtein Distance (문자열 편집 거리) 전역 계산 함수
function getGlobalLevenshteinDistance(a, b) {
    if (a === b) return 0;
    const al = a.length;
    const bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;

    let v0 = new Array(bl + 1);
    let v1 = new Array(bl + 1);

    for (let i = 0; i <= bl; i++) v0[i] = i;

    for (let i = 0; i < al; i++) {
        v1[0] = i + 1;
        for (let j = 0; j < bl; j++) {
            const cost = a[i] === b[j] ? 0 : 1;
            v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
        }
        for (let j = 0; j <= bl; j++) v0[j] = v1[j];
    }

    return v1[bl];
}

// =========================================================================
//  제품 마우스 오버 시 로케이션별 재고 현황 팝업 & 클립보드 복사
// =========================================================================
(function setupProductStockPopoverHandlers() {
    const popover = document.getElementById('productStockPopover');
    const popoverModelName = document.getElementById('popoverModelName');
    const btnPopoverCopyStock = document.getElementById('btnPopoverCopyStock');
    const popoverSummary = document.getElementById('popoverSummary');
    const popoverStockTableBody = document.getElementById('popoverStockTableBody');

    if (!popover) return;

    let popoverTimeout = null;
    let currentDetails = null;

    // 마우스가 팝업 자체에 들어오면 닫기 타이머 취소 (복사 버튼 등을 클릭할 수 있도록)
    popover.addEventListener('mouseenter', () => {
        if (popoverTimeout) {
            clearTimeout(popoverTimeout);
            popoverTimeout = null;
        }
    });

    // 마우스가 팝업에서 나가면 부드럽게 닫기
    popover.addEventListener('mouseleave', () => {
        hidePopover(false);
    });

    function getProductLocationStockDetails(prodName, prodType = '') {
        if (!warehouseStockLoaded) return null;
        const nameUpper = (prodName || '').trim().toUpperCase();
        if (!nameUpper || nameUpper === 'NONASSET.ITEM') return null;

        const stockInfo = (warehouseStockQtyMap && warehouseStockQtyMap[nameUpper]) || {
            physical: 0,
            good: 0,
            pending: 0,
            available: 0,
            block: 0,
            oqc: 0,
            longTerm: 0,
            bin: 0,
            workTotal: 0
        };

        const totalNeeded = window.totalProductRemainMap ? (window.totalProductRemainMap[nameUpper] || 0) : 0;

        // 1. 기준 제품 로케이션별 수량 집계 (작업가능 재고: Good / Pending)
        const locMap = {};

        const allMatches = (warehouseAllStockList || []).filter(item => (item.modelName || '').trim().toUpperCase() === nameUpper);
        allMatches.forEach(item => {
            const loc = (item.location || '미지정').trim();
            const good = item.goodQty || 0;
            const pending = item.pendingQty || 0;
            const workTotal = good + pending;

            if (workTotal > 0 || (item.physicalQty > 0 && !item.blockQty)) {
                if (!locMap[loc]) {
                    locMap[loc] = { 
                        location: loc, 
                        physicalQty: 0, 
                        goodQty: 0, 
                        pendingQty: 0, 
                        workTotalQty: 0
                    };
                }
                locMap[loc].physicalQty += (item.physicalQty || 0);
                locMap[loc].goodQty += good;
                locMap[loc].pendingQty += pending;
                locMap[loc].workTotalQty += workTotal;
            }
        });

        const locations = Object.values(locMap).sort((a, b) => a.location.localeCompare(b.location));

        // 작업가능 합계 산출 (로케이션 집계 기준)
        const totalGood = locations.reduce((sum, loc) => sum + loc.goodQty, 0);
        const totalPending = locations.reduce((sum, loc) => sum + loc.pendingQty, 0);
        const totalWork = totalGood + totalPending;

        // 2. 블록/홀드/롱텀/BIN 로케이션별 수량 집계
        const blockLocMap = {};

        // 2-1. warehouseHoldStockList에서 수집
        const holdItems = (warehouseHoldStockList || []).filter(item => (item.modelName || '').trim().toUpperCase() === nameUpper);
        holdItems.forEach(item => {
            const loc = (item.location || '미지정').trim();
            if (!blockLocMap[loc]) {
                blockLocMap[loc] = {
                    location: loc,
                    oqcHold: 0,
                    longTermHold: 0,
                    binBlock: 0,
                    totalBlock: 0
                };
            }
            blockLocMap[loc].oqcHold += (item.oqcHold || 0);
            blockLocMap[loc].longTermHold += (item.longTermHold || 0);
            blockLocMap[loc].binBlock += (item.binBlock || 0);
            blockLocMap[loc].totalBlock += ((item.oqcHold || 0) + (item.longTermHold || 0) + (item.binBlock || 0));
        });

        // 2-2. allMatches에서도 block 수량 보완
        allMatches.forEach(item => {
            const oqc = item.oqcHold || 0;
            const lt = item.longTermHold || 0;
            const bin = item.binBlock || 0;
            const total = (oqc + lt + bin) || (item.blockQty || 0);

            if (total > 0) {
                const loc = (item.location || '미지정').trim();
                if (!blockLocMap[loc]) {
                    blockLocMap[loc] = {
                        location: loc,
                        oqcHold: oqc,
                        longTermHold: lt,
                        binBlock: bin,
                        totalBlock: total
                    };
                }
            }
        });

        const blockLocations = Object.values(blockLocMap)
            .filter(loc => loc.totalBlock > 0)
            .sort((a, b) => a.location.localeCompare(b.location));

        const totalOqc = blockLocations.reduce((s, l) => s + l.oqcHold, 0);
        const totalLongTerm = blockLocations.reduce((s, l) => s + l.longTermHold, 0);
        const totalBin = blockLocations.reduce((s, l) => s + l.binBlock, 0);
        const totalBlock = blockLocations.reduce((s, l) => s + l.totalBlock, 0);

        const effectiveStockInfo = {
            physical: stockInfo.physical || (totalWork + totalBlock),
            good: stockInfo.good !== undefined && stockInfo.good > 0 ? stockInfo.good : totalGood,
            pending: stockInfo.pending !== undefined && stockInfo.pending > 0 ? stockInfo.pending : totalPending,
            workTotal: totalWork > 0 ? totalWork : (stockInfo.workTotal || (totalGood + totalPending)),
            available: stockInfo.available || totalWork,
            block: totalBlock > 0 ? totalBlock : (stockInfo.block || 0),
            oqc: totalOqc > 0 ? totalOqc : (stockInfo.oqc || 0),
            longTerm: totalLongTerm > 0 ? totalLongTerm : (stockInfo.longTerm || 0),
            bin: totalBin > 0 ? totalBin : (stockInfo.bin || 0)
        };

        // 3. 연관 모델 탐색 (유사 모델 [유] 및 동일 서픽스 [동]) - 제품구분이 'Q'인 경우에만 적용!
        const relatedGroups = [];
        const targetPrefix = nameUpper.includes('.') ? nameUpper.substring(0, nameUpper.lastIndexOf('.')) : nameUpper;
        const pt = (prodType || '').trim().toUpperCase();

        let isQType = (pt === 'Q');
        if (!isQType && comparisonResult && Array.isArray(comparisonResult)) {
            const foundItem = comparisonResult.find(it => (it.prodName || '').trim().toUpperCase() === nameUpper);
            if (foundItem && (foundItem.prodType || '').trim().toUpperCase() === 'Q') {
                isQType = true;
            }
        }
        if (!isQType && processedAvailabilityData && Array.isArray(processedAvailabilityData)) {
            const foundItem = processedAvailabilityData.find(it => (it.prodName || '').trim().toUpperCase() === nameUpper);
            if (foundItem && (foundItem.prodType || '').trim().toUpperCase() === 'Q') {
                isQType = true;
            }
        }
        if (!isQType && productMaster && Array.isArray(productMaster)) {
            const pmMatch = productMaster.find(p => (p.name || '').trim().toUpperCase() === nameUpper);
            if (pmMatch && (pmMatch.prodType || pmMatch.type || '').trim().toUpperCase() === 'Q') {
                isQType = true;
            }
        }

        // 제품구분이 'Q'인 경우에 한해 [유] 유사모델 및 [동] 동일접두어 모델 수집 (창고 재고 > 0인 모델만)
        if (isQType) {
            // 3-1. [유] 유사 모델 탐색
            if (targetPrefix.length >= 3) {
                const candidates = new Set();
                if (warehouseStockLoaded && warehouseStockQtyMap) {
                    Object.entries(warehouseStockQtyMap).forEach(([mName, sInfo]) => {
                        const hasStock = (sInfo.physical || 0) > 0 || (sInfo.good || 0) > 0 || (sInfo.available || 0) > 0 || (sInfo.pending || 0) > 0;
                        if (hasStock) candidates.add(mName.toUpperCase().trim());
                    });
                }
                if (warehouseAllStockList && Array.isArray(warehouseAllStockList)) {
                    warehouseAllStockList.forEach(item => {
                        const qty = (item.goodQty !== undefined || item.pendingQty !== undefined)
                            ? ((item.goodQty || 0) + (item.pendingQty || 0))
                            : (item.physicalQty || 0);
                        if (qty > 0 && item.modelName) candidates.add(item.modelName.toUpperCase().trim());
                    });
                }

                const simList = [];
                // 점 앞 접두어 길이에 따라 허용 차이 동적 결정: 7글자 이하 -> 1글자만 / 8글자 이상 -> 최대 2글자까지
                const maxAllowedDiff = (targetPrefix.length <= 7) ? 1 : 2;

                candidates.forEach(cand => {
                    if (cand === nameUpper) return;
                    const candPrefix = cand.includes('.') ? cand.substring(0, cand.lastIndexOf('.')) : cand;
                    if (candPrefix === targetPrefix) return; // 동일 접두어는 아래 [동]에서 처리
                    // 서피스넘버(점 뒤 단어)를 제외하고 접두어만 순수 비교
                    const prefixDist = getGlobalLevenshteinDistance(targetPrefix, candPrefix);
                    if (prefixDist >= 1 && prefixDist <= maxAllowedDiff) {
                        simList.push({ name: cand, diff: prefixDist });
                    }
                });

                simList.forEach(sim => {
                    const simLocMap = {};
                    const matches = (warehouseAllStockList || []).filter(item => (item.modelName || '').trim().toUpperCase() === sim.name);
                    matches.forEach(item => {
                        const loc = (item.location || '미지정').trim();
                        const gQty = item.goodQty !== undefined ? item.goodQty : 0;
                        const pQty = item.pendingQty !== undefined ? item.pendingQty : 0;
                        const wTotal = (gQty + pQty) > 0 ? (gQty + pQty) : (item.physicalQty || 0);
                        if (wTotal > 0) {
                            if (!simLocMap[loc]) {
                                simLocMap[loc] = { location: loc, goodQty: 0, pendingQty: 0, workTotalQty: 0 };
                            }
                            simLocMap[loc].goodQty += gQty;
                            simLocMap[loc].pendingQty += pQty;
                            simLocMap[loc].workTotalQty += wTotal;
                        }
                    });
                    const simLocations = Object.values(simLocMap).sort((a, b) => a.location.localeCompare(b.location));
                    const simGood = simLocations.reduce((s, l) => s + l.goodQty, 0);
                    const simPending = simLocations.reduce((s, l) => s + l.pendingQty, 0);
                    const simTotal = simLocations.reduce((s, l) => s + l.workTotalQty, 0);

                    if (simTotal <= 0 || simLocations.length === 0) return; // 재고가 0인 유사 모델은 팝업 제외

                    relatedGroups.push({
                        type: 'yu',
                        tag: '유',
                        title: `유사모델 (${sim.diff}글자 차이)`,
                        modelName: sim.name,
                        locations: simLocations,
                        totalGood: simGood,
                        totalPending: simPending,
                        totalWork: simTotal
                    });
                });
            }

            // 3-2. [동] 동일 접두어 모델 탐색 (창고 재고 > 0인 모델만)
            const dotIdx = nameUpper.lastIndexOf('.');
            if (dotIdx !== -1) {
                const prefix = nameUpper.substring(0, dotIdx);
                const dongCandidates = new Set();
                (warehouseAllStockList || []).forEach(item => {
                    const mUpper = (item.modelName || '').trim().toUpperCase();
                    const qty = (item.goodQty !== undefined || item.pendingQty !== undefined)
                        ? ((item.goodQty || 0) + (item.pendingQty || 0))
                        : (item.physicalQty || 0);
                    if (qty > 0 && mUpper !== nameUpper && mUpper.startsWith(prefix + '.')) {
                        dongCandidates.add(mUpper);
                    }
                });

                dongCandidates.forEach(dongName => {
                    if (relatedGroups.some(g => g.modelName === dongName)) return;

                    const dongLocMap = {};
                    const matches = (warehouseAllStockList || []).filter(item => (item.modelName || '').trim().toUpperCase() === dongName);
                    matches.forEach(item => {
                        const loc = (item.location || '미지정').trim();
                        const gQty = item.goodQty !== undefined ? item.goodQty : 0;
                        const pQty = item.pendingQty !== undefined ? item.pendingQty : 0;
                        const wTotal = (gQty + pQty) > 0 ? (gQty + pQty) : (item.physicalQty || 0);
                        if (wTotal > 0) {
                            if (!dongLocMap[loc]) {
                                dongLocMap[loc] = { location: loc, goodQty: 0, pendingQty: 0, workTotalQty: 0 };
                            }
                            dongLocMap[loc].goodQty += gQty;
                            dongLocMap[loc].pendingQty += pQty;
                            dongLocMap[loc].workTotalQty += wTotal;
                        }
                    });
                    const dongLocations = Object.values(dongLocMap).sort((a, b) => a.location.localeCompare(b.location));
                    const dongGood = dongLocations.reduce((s, l) => s + l.goodQty, 0);
                    const dongPending = dongLocations.reduce((s, l) => s + l.pendingQty, 0);
                    const dongTotal = dongLocations.reduce((s, l) => s + l.workTotalQty, 0);

                    if (dongTotal <= 0 || dongLocations.length === 0) return; // 재고가 0인 동일접두어 모델은 팝업 제외

                    relatedGroups.push({
                        type: 'dong',
                        tag: '동',
                        title: `동일 제품군 (접두어 일치)`,
                        modelName: dongName,
                        locations: dongLocations,
                        totalGood: dongGood,
                        totalPending: dongPending,
                        totalWork: dongTotal
                    });
                });
            }
        }

        return {
            name: nameUpper,
            stockInfo: effectiveStockInfo,
            totalNeeded,
            locations,
            blockLocations,
            relatedGroups
        };
    }

    function formatProductStockTextForClipboard(details) {
        if (!details) return '';
        const lines = [
            `[${details.name}] 창고 재고 현황`,
            `• 작업가능 합계: ${details.stockInfo.workTotal.toLocaleString()} EA (패스: ${details.stockInfo.good.toLocaleString()} EA / 팬딩: ${details.stockInfo.pending.toLocaleString()} EA)`,
            `• 합산 필요수량: ${details.totalNeeded.toLocaleString()} EA`
        ];

        if (details.locations.length > 0) {
            lines.push(`• 작업가능 로케이션 (패스 / 팬딩 / 합계):`);
            details.locations.forEach(loc => {
                lines.push(`  - ${loc.location}: 패스 ${loc.goodQty.toLocaleString()} EA, 팬딩 ${loc.pendingQty.toLocaleString()} EA (합계 ${loc.workTotalQty.toLocaleString()} EA)`);
            });
        } else {
            lines.push(`• 등록된 작업가능 로케이션 재고가 없습니다.`);
        }

        // 블록/홀드/롱텀 로케이션 클립보드 포함
        if (details.blockLocations && details.blockLocations.length > 0) {
            lines.push(``);
            lines.push(`[🚫 블록 / 홀드 / 롱텀 재고 로케이션 (합계: ${details.stockInfo.block.toLocaleString()} EA)]`);
            details.blockLocations.forEach(loc => {
                const reasons = [];
                if (loc.oqcHold > 0) reasons.push(`OQC홀드 ${loc.oqcHold.toLocaleString()} EA`);
                if (loc.longTermHold > 0) reasons.push(`롱텀홀드 ${loc.longTermHold.toLocaleString()} EA`);
                if (loc.binBlock > 0) reasons.push(`BIN블럭 ${loc.binBlock.toLocaleString()} EA`);
                lines.push(`• ${loc.location}: ${reasons.join(', ')} (합계 ${loc.totalBlock.toLocaleString()} EA)`);
            });
        }

        // 연관/유사 모델 클립보드 포함
        if (details.relatedGroups && details.relatedGroups.length > 0) {
            lines.push(``);
            lines.push(`[연관 / 유사 제품 로케이션 재고]`);
            details.relatedGroups.forEach(group => {
                lines.push(`• [${group.tag}] ${group.modelName} (${group.title}) - 합계: ${group.totalWork.toLocaleString()} EA (패스: ${group.totalGood.toLocaleString()} / 팬딩: ${group.totalPending.toLocaleString()})`);
                if (group.locations.length > 0) {
                    group.locations.forEach(loc => {
                        lines.push(`  - ${loc.location}: 패스 ${loc.goodQty.toLocaleString()} EA, 팬딩 ${loc.pendingQty.toLocaleString()} EA (합계 ${loc.workTotalQty.toLocaleString()} EA)`);
                    });
                } else {
                    lines.push(`  - 등록된 로케이션 재고 없음`);
                }
            });
        }

        return lines.join('\n');
    }

    function showPopover(prodName, targetEl, prodType = '') {
        if (popoverTimeout) {
            clearTimeout(popoverTimeout);
            popoverTimeout = null;
        }

        const details = getProductLocationStockDetails(prodName, prodType);
        if (!details) {
            hidePopover(true);
            return;
        }

        currentDetails = details;

        // 팝업 내용 렌더링
        popoverModelName.textContent = details.name;

        let summaryPillsHtml = `
            <span class="summary-pill total">합계 ${details.stockInfo.workTotal.toLocaleString()} EA</span>
            <span class="summary-pill pass">패스 ${details.stockInfo.good.toLocaleString()} EA</span>
            <span class="summary-pill pending">팬딩 ${details.stockInfo.pending.toLocaleString()} EA</span>
        `;
        if (details.stockInfo.block > 0) {
            summaryPillsHtml += `<span class="summary-pill blocked">🚫 블록 ${details.stockInfo.block.toLocaleString()} EA</span>`;
        }

        popoverSummary.innerHTML = summaryPillsHtml;

        let mainTableRows = '';
        if (details.locations.length === 0) {
            mainTableRows = `
                <tr>
                    <td colspan="4" style="text-align: center; color: #94a3b8; padding: 12px;">작업가능 로케이션 정보가 없습니다.</td>
                </tr>
            `;
        } else {
            mainTableRows = details.locations.map(loc => {
                return `
                    <tr>
                        <td class="loc-code">${loc.location}</td>
                        <td class="loc-qty-pass" style="text-align: right;">${loc.goodQty > 0 ? `${loc.goodQty.toLocaleString()} EA` : '<span style="color:#cbd5e1;">-</span>'}</td>
                        <td class="loc-qty-pending" style="text-align: right;">${loc.pendingQty > 0 ? `${loc.pendingQty.toLocaleString()} EA` : '<span style="color:#cbd5e1;">-</span>'}</td>
                        <td class="loc-qty-total" style="text-align: right;">${loc.workTotalQty > 0 ? `${loc.workTotalQty.toLocaleString()} EA` : '<span style="color:#cbd5e1;">0 EA</span>'}</td>
                    </tr>
                `;
            }).join('');
        }

        // 블록 / 홀드 / 롱텀 섹션 렌더링
        let blockHtml = '';
        if (details.blockLocations && details.blockLocations.length > 0) {
            blockHtml = `
                <div class="popover-block-section">
                    <div class="block-section-title">
                        <span><i class="fas fa-ban"></i> 블록 / 홀드 / 롱텀 재고 로케이션</span>
                        <span style="margin-left:auto; font-size:0.7rem; font-weight:700; color:#dc2626; background:#fee2e2; padding:1px 6px; border-radius:4px; border:1px solid #fca5a5;">
                            합계 ${details.stockInfo.block.toLocaleString()} EA
                        </span>
                    </div>
                    <table class="popover-stock-table block-table">
                        <thead>
                            <tr>
                                <th style="text-align: left;">로케이션</th>
                                <th style="text-align: right; color: #d97706;">OQC홀드</th>
                                <th style="text-align: right; color: #b45309;">롱텀홀드</th>
                                <th style="text-align: right; color: #e11d48;">BIN블럭</th>
                                <th style="text-align: right; color: #dc2626;">합계</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${details.blockLocations.map(loc => `
                                <tr>
                                    <td class="loc-code" style="color: #991b1b;">${loc.location}</td>
                                    <td class="loc-qty-oqc" style="text-align: right;">${loc.oqcHold > 0 ? `${loc.oqcHold.toLocaleString()} EA` : '<span style="color:#cbd5e1;">-</span>'}</td>
                                    <td class="loc-qty-longterm" style="text-align: right;">${loc.longTermHold > 0 ? `${loc.longTermHold.toLocaleString()} EA` : '<span style="color:#cbd5e1;">-</span>'}</td>
                                    <td class="loc-qty-bin" style="text-align: right;">${loc.binBlock > 0 ? `${loc.binBlock.toLocaleString()} EA` : '<span style="color:#cbd5e1;">-</span>'}</td>
                                    <td class="loc-qty-blocktotal" style="text-align: right;">${loc.totalBlock.toLocaleString()} EA</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        // 연관/유사 모델 섹션 렌더링
        let relatedHtml = '';
        if (details.relatedGroups && details.relatedGroups.length > 0) {
            relatedHtml = `
                <div class="popover-related-section">
                    <div style="font-size: 0.73rem; font-weight: 700; color: #64748b; margin-bottom: 6px;">
                        <i class="fas fa-link" style="margin-right: 4px;"></i> 연관 / 유사 제품 로케이션 현황
                    </div>
                    ${details.relatedGroups.map(group => `
                        <div class="related-model-group">
                            <div class="related-model-header">
                                <span class="related-badge ${group.type}">[${group.tag}]</span>
                                <strong class="related-model-title">${group.modelName}</strong>
                                <span class="related-summary-pill">합계 ${group.totalWork.toLocaleString()} EA (패스: ${group.totalGood.toLocaleString()} / 팬딩: ${group.totalPending.toLocaleString()})</span>
                            </div>
                            <table class="popover-stock-table related-table">
                                <thead>
                                    <tr>
                                        <th style="text-align: left;">로케이션</th>
                                        <th style="text-align: right; color: #16a34a;">패스</th>
                                        <th style="text-align: right; color: #ea580c;">팬딩</th>
                                        <th style="text-align: right; color: #2563eb;">합계</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${group.locations.length === 0 ? `
                                        <tr><td colspan="4" style="text-align: center; color: #94a3b8; padding: 6px;">로케이션 재고 없음</td></tr>
                                    ` : group.locations.map(loc => `
                                        <tr>
                                            <td class="loc-code">${loc.location}</td>
                                            <td class="loc-qty-pass" style="text-align: right;">${loc.goodQty > 0 ? `${loc.goodQty.toLocaleString()} EA` : '<span style="color:#cbd5e1;">-</span>'}</td>
                                            <td class="loc-qty-pending" style="text-align: right;">${loc.pendingQty > 0 ? `${loc.pendingQty.toLocaleString()} EA` : '<span style="color:#cbd5e1;">-</span>'}</td>
                                            <td class="loc-qty-total" style="text-align: right;">${loc.workTotalQty > 0 ? `${loc.workTotalQty.toLocaleString()} EA` : '<span style="color:#cbd5e1;">0 EA</span>'}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        const tableWrapper = document.getElementById('popoverTableWrapper');
        if (tableWrapper) {
            tableWrapper.innerHTML = `
                <table class="popover-stock-table">
                    <thead>
                        <tr>
                            <th style="text-align: left;">로케이션</th>
                            <th style="text-align: right; color: #16a34a;">패스</th>
                            <th style="text-align: right; color: #ea580c;">팬딩</th>
                            <th style="text-align: right; color: #2563eb;">합계</th>
                        </tr>
                    </thead>
                    <tbody id="popoverStockTableBody">
                        ${mainTableRows}
                    </tbody>
                </table>
                ${blockHtml}
                ${relatedHtml}
            `;
        }

        // 이미지 복사 버튼 이벤트 바인딩 (html2canvas 고해상도 캡처 -> 클립보드 PNG 복사)
        if (btnPopoverCopyStock) {
            btnPopoverCopyStock.onclick = async (e) => {
                e.stopPropagation();
                if (btnPopoverCopyStock.disabled) return;

                const originalBtnHtml = btnPopoverCopyStock.innerHTML;
                btnPopoverCopyStock.disabled = true;
                btnPopoverCopyStock.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 복사중...';

                // 캡처 시 복사 버튼 자체는 숨겨서 깔끔한 카드 이미지로 출력
                btnPopoverCopyStock.style.visibility = 'hidden';

                const targetWrapper = document.getElementById('popoverTableWrapper');
                const origMaxHeight = targetWrapper ? targetWrapper.style.maxHeight : '';
                const origOverflowY = targetWrapper ? targetWrapper.style.overflowY : '';
                if (targetWrapper) {
                    targetWrapper.style.maxHeight = 'none';
                    targetWrapper.style.overflowY = 'visible';
                }

                try {
                    if (typeof html2canvas !== 'function') {
                        throw new Error("html2canvas 라이브러리가 로드되지 않았습니다.");
                    }

                    // 2배 스케일 고해상도 캡처
                    const canvas = await html2canvas(popover, {
                        backgroundColor: '#ffffff',
                        scale: 2,
                        useCORS: true,
                        logging: false
                    });

                    const dataUrl = canvas.toDataURL('image/png');

                    if (window.isElectron && window.electronAPI && window.electronAPI.writeImageToClipboard) {
                        const res = await window.electronAPI.writeImageToClipboard(dataUrl);
                        if (res && res.success) {
                            if (typeof showToast === 'function') {
                                showToast("📋 로케이션 재고 이미지가 복사되었습니다! (카톡/메신저에 Ctrl+V)");
                            }
                        } else {
                            throw new Error(res ? res.error : '클립보드 복사 실패');
                        }
                    } else if (navigator.clipboard && window.ClipboardItem) {
                        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                        if (typeof showToast === 'function') {
                            showToast("📋 로케이션 재고 이미지가 복사되었습니다! (카톡/메신저에 Ctrl+V)");
                        }
                    } else {
                        throw new Error("클립보드 이미지 쓰기를 지원하지 않는 환경입니다.");
                    }
                } catch (err) {
                    console.error("재고 팝업 이미지 복사 실패:", err);
                    // 실패 시 텍스트 복사로 fallback
                    const copyText = formatProductStockTextForClipboard(details);
                    window.copyToClipboard(copyText, '재고현황 (텍스트)');
                    if (typeof showToast === 'function') {
                        showToast("⚠️ 이미지 복사 실패로 텍스트로 복사되었습니다.");
                    }
                } finally {
                    btnPopoverCopyStock.style.visibility = 'visible';
                    btnPopoverCopyStock.disabled = false;
                    btnPopoverCopyStock.innerHTML = '<i class="fas fa-check"></i> 복사완료!';
                    setTimeout(() => {
                        if (btnPopoverCopyStock) {
                            btnPopoverCopyStock.innerHTML = originalBtnHtml;
                        }
                    }, 1600);

                    if (targetWrapper) {
                        targetWrapper.style.maxHeight = origMaxHeight;
                        targetWrapper.style.overflowY = origOverflowY;
                    }
                }
            };
        }

        // 팝업 위치 계산 (위/아래 행의 제품명 앞글자 3~4개가 가려지지 않도록 오른쪽으로 80px 오프셋)
        popover.style.display = 'block';
        const rect = targetEl.getBoundingClientRect();
        const popoverWidth = 390;
        const popoverHeight = popover.offsetHeight || 260;

        // 제품명 앞 3~4글자(약 80px)를 노출하여 마우스를 상하로 바로 이동할 수 있도록 위치 설정
        const OFFSET_LEFT = 80;
        let left = rect.left + OFFSET_LEFT;
        let top = rect.bottom + 6;

        // 우측 경계 보정 (화면 우측 밖으로 나가지 않도록)
        if (left + popoverWidth > window.innerWidth - 16) {
            left = window.innerWidth - popoverWidth - 16;
            // 가능한 한 제품명 시작 부분(앞글자)은 가리지 않도록 유지
            if (left < rect.left + 40) {
                left = rect.left + 40;
            }
        }
        if (left < 16) left = 16;

        // 하단 경계 보정 (하단 공간 부족 시 대상 요소 위로 띄움)
        if (top + popoverHeight > window.innerHeight - 16) {
            top = Math.max(16, rect.top - popoverHeight - 6);
        }

        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;

        requestAnimationFrame(() => {
            popover.classList.add('show');
        });
    }

    function hidePopover(immediate = false) {
        if (popoverTimeout) clearTimeout(popoverTimeout);

        if (immediate) {
            popover.classList.remove('show');
            popover.style.display = 'none';
        } else {
            popoverTimeout = setTimeout(() => {
                popover.classList.remove('show');
                setTimeout(() => {
                    if (!popover.classList.contains('show')) {
                        popover.style.display = 'none';
                    }
                }, 180);
            }, 200);
        }
    }

    // 전역 노출 함수
    window.handleProductMouseEnter = (prodName, el, prodType = '') => {
        showPopover(prodName, el, prodType);
    };

    window.handleProductMouseLeave = () => {
        hidePopover(false);
    };
})();

// =========================================================================
//  POP 샘플 무게 관리
// =========================================================================

// POP 무게 UI 업데이트 (목록 테이블 + 배지)
function renderPopWeightTable() {
    const tbody = document.getElementById('popWeightTableBody');
    const countEl = document.getElementById('popWeightCount');
    const badge = document.getElementById('popWeightBadge');
    if (!tbody) return;

    const entries = Object.entries(popWeightMap);
    if (countEl) countEl.textContent = entries.length;

    if (badge) {
        if (entries.length > 0) {
            badge.style.display = 'inline';
            badge.textContent = entries.length;
        } else {
            badge.style.display = 'none';
        }
    }

    if (entries.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="padding:20px; text-align:center; color:#94a3b8;">등록된 POP 무게가 없습니다.</td></tr>`;
        return;
    }

    tbody.innerHTML = entries.map(([cntrNo, info]) => `
        <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:8px 12px; font-weight:700; color:#ea580c;">${cntrNo}</td>
            <td style="padding:8px 12px; text-align:right; font-weight:700; color:#1e293b;">+${info.weight.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg</td>
            <td style="padding:8px 12px; color:#64748b; font-size:0.82rem;">${info.memo || '-'}</td>
            <td style="padding:8px 12px; text-align:center;">
                <button onclick="deletePOPWeight('${cntrNo}')" 
                    style="background:#fee2e2; color:#dc2626; border:none; border-radius:5px; padding:3px 8px; cursor:pointer; font-size:0.8rem; font-weight:600;">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');
}

// POP 무게 삭제
window.deletePOPWeight = async function (cntrNo) {
    if (!confirm(`${cntrNo}의 POP 무게를 삭제하시겠습니까?`)) return;
    try {
        const resp = await fetch(`${API_BASE}/api/pop-weights?cntrNo=${encodeURIComponent(cntrNo)}`, { method: 'DELETE' });
        const result = await resp.json();
        if (result.success) {
            popWeightMap = result.data;
            renderPopWeightTable();
            if (comparisonResult && comparisonResult.length > 0) displayResults(comparisonResult, false);
        } else {
            alert('삭제 실패: ' + result.message);
        }
    } catch (err) {
        alert('삭제 오류: ' + err.message);
    }
};

// POP 무게 초기 로드
async function loadPopWeights() {
    try {
        const resp = await fetch(`${API_BASE}/api/pop-weights`);
        const result = await resp.json();
        if (result.success) {
            popWeightMap = result.data || {};
            renderPopWeightTable();
            console.log(`📦 [POP] 로드 완료: ${Object.keys(popWeightMap).length}건`);
        }
    } catch (err) {
        console.warn('⚠️ POP 무게 로드 실패:', err.message);
    }
}
loadPopWeights();

// POP 모달 이벤트 바인딩
(function setupPopWeightModal() {
    const modal = document.getElementById('popWeightModal');
    const btnOpen = document.getElementById('btnOpenPopWeight');
    const btnClose = document.getElementById('closePopWeightBtn');
    const btnCloseBottom = document.getElementById('closePopWeightBottomBtn');
    const btnAdd = document.getElementById('btnAddPopWeight');

    if (btnOpen) btnOpen.addEventListener('click', () => {
        if (modal) modal.style.display = 'flex';
    });
    const closeModal = () => { if (modal) modal.style.display = 'none'; };
    if (btnClose) btnClose.addEventListener('click', closeModal);
    if (btnCloseBottom) btnCloseBottom.addEventListener('click', closeModal);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    if (btnAdd) {
        btnAdd.addEventListener('click', async () => {
            const cntrNoRaw = (document.getElementById('popCntrNoInput').value || '').trim().toUpperCase();
            const weightRaw = parseFloat(document.getElementById('popWeightInput').value);
            const memo = (document.getElementById('popMemoInput').value || '').trim();

            if (!cntrNoRaw) { alert('컨테이너 번호를 입력해주세요.'); return; }
            if (isNaN(weightRaw) || weightRaw <= 0) { alert('올바른 무게(kg)를 입력해주세요.'); return; }

            try {
                const resp = await fetch(`${API_BASE}/api/pop-weights`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cntrNo: cntrNoRaw, weight: weightRaw, memo })
                });
                const result = await resp.json();
                if (result.success) {
                    popWeightMap = result.data;
                    renderPopWeightTable();
                    document.getElementById('popCntrNoInput').value = '';
                    document.getElementById('popWeightInput').value = '';
                    document.getElementById('popMemoInput').value = '';
                    if (comparisonResult && comparisonResult.length > 0) displayResults(comparisonResult, false);
                    console.log(`✅ [POP] 등록: ${cntrNoRaw} +${weightRaw}kg`);
                } else {
                    alert('등록 실패: ' + result.message);
                }
            } catch (err) {
                alert('등록 오류: ' + err.message);
            }
        });
    }
})();


async function reloadLatestFile(type) {
    const statusEl = type === 'original' ? statusOriginal : (type === 'download' ? statusDownload : (type === 'warehouse' ? statusWarehouseStock : statusRework));
    const originalText = statusEl.innerHTML;

    try {
        statusEl.innerHTML = `<i class="fas fa-spinner fa-spin" style="color:#3b82f6; margin-right:4px;"></i>상태: ${type === 'warehouse' ? '창고' : (type === 'original' ? '원본' : '전산')} 데이터 불러오는 중...`;
        statusEl.style.color = '#3b82f6';

        let file = null;

        // 1. 네이티브 FileHandle이 저장되어 있는 경우 (브라우저 디스크에서 최신 내용 직접 다시 읽기)
        if (window.savedNativeFileHandles && window.savedNativeFileHandles[type]) {
            try {
                file = await window.savedNativeFileHandles[type].getFile();
                console.log(`✅ [불러오기] 저장된 FileHandle을 통해 최신 '${file.name}' 재로드 성공`);
            } catch (hErr) {
                console.warn(`FileHandle getFile failed for ${type}:`, hErr);
            }
        }

        // 2. Electron IPC 또는 서버 파일 경로가 존재하는 경우
        let filePath = null;
        if (window.electronAPI) {
            filePath = await window.electronAPI.getFilePath(type);
        }
        if (!filePath) {
            if (type === 'original') filePath = pathOriginal.value.trim();
            else if (type === 'download') filePath = pathDownload.value.trim();
            else if (type === 'rework') filePath = pathRework.value.trim();
            else if (type === 'warehouse') filePath = pathWarehouse.value.trim();
        }

        // 경로가 절대 경로 (C:\ 또는 /)인 경우 서버 API로 로드
        if (!file && filePath && (filePath.includes(':') || filePath.startsWith('/') || filePath.startsWith('\\\\'))) {
            try {
                const response = await fetch(`${API_BASE}/api/load-file-raw?path=${encodeURIComponent(filePath)}&t=${Date.now()}`);
                if (response.ok) {
                    const result = await response.json();
                    if (result.success && result.base64) {
                        const binaryStr = atob(result.base64);
                        const bytes = new Uint8Array(binaryStr.length);
                        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
                        const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                        const fileName = result.fileName || `${type}.xlsx`;
                        file = new File([blob], fileName, { type: blob.type });
                    }
                }
            } catch (netErr) {
                console.warn("Server raw file fetch failed:", netErr);
            }
        }

        // 3. 브라우저 메모리에 저장된 원본 File 객체가 있는 경우
        if (!file && window.savedRawFiles && window.savedRawFiles[type]) {
            file = window.savedRawFiles[type];
            console.log(`✅ [불러오기] 메모리에 보관된 '${file.name}' 재분석 진행`);
        }

        // 4. 저장된 핸들이나 파일이 없지만 브라우저 showOpenFilePicker가 지원되는 경우 (마지막 기억된 폴더로 피커 바로 열기)
        if (!file && window.showOpenFilePicker) {
            const storageKey = type === 'original' ? 'dirOrig' : (type === 'download' ? 'dirDown' : (type === 'warehouse' ? 'dirWarehouse' : 'dirRework'));
            try {
                const [newHandle] = await window.showOpenFilePicker({
                    id: storageKey,
                    types: [{
                        description: 'Excel Files (*.xlsx, *.xls, *.xlsm)',
                        accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx', '.xls', '.xlsm'] }
                    }],
                    multiple: false
                });
                if (newHandle) {
                    window.savedNativeFileHandles = window.savedNativeFileHandles || {};
                    window.savedNativeFileHandles[type] = newHandle;
                    file = await newHandle.getFile();
                }
            } catch (userCancel) {
                statusEl.innerHTML = originalText;
                statusEl.style.color = '#64748b';
                return;
            }
        }

        if (!file) {
            throw new Error('불러올 파일이 없습니다. 탐색기 버튼을 눌러 파일을 먼저 선택해주세요.');
        }

        // 저장
        window.savedRawFiles = window.savedRawFiles || {};
        window.savedRawFiles[type] = file;

        // 파일 파싱 및 처리
        if (type === 'warehouse') {
            const formData = new FormData();
            formData.append('warehouseFile', file);
            const resp = await fetch(`${API_BASE}/api/parse-warehouse-stock`, { method: 'POST', body: formData });
            const result = await resp.json();
            if (result.success) {
                warehouseStockDongPrefixes = new Set(result.dongPrefixes.map(x => x.toUpperCase()));
                warehouseStockBlockProductsAll = new Set((result.blockProductNamesWith17 || []).map(x => x.toUpperCase()));
                warehouseStockBlockProductsNo17 = new Set((result.blockProductNames || []).map(x => x.toUpperCase()));
                warehouseStockQtyMapAll = result.stockMapWith17 || {};
                warehouseStockQtyMapNo17 = result.stockMap || {};
                warehouseHoldStockListAll = result.holdStockListWith17 || [];
                warehouseHoldStockListNo17 = result.holdStockList || [];
                warehouseAllStockListAll = result.allStockListWith17 || [];
                warehouseAllStockListNo17 = result.allStockList || [];
                warehouseStockLoaded = true;
                updateActiveWarehouseStock();
                statusWarehouseStock.innerHTML = `<i class="fas fa-check-circle" style="color:#16a34a; margin-right:4px;"></i>상태: 분석 완료 (${file.name})`;
                statusWarehouseStock.style.color = '#16a34a';
                const lastWhEl = document.getElementById('lastWarehouseStock');
                if (lastWhEl) lastWhEl.textContent = `고유제품 ${result.totalProducts}개 분석 완료`;
                if (btnClearWarehouseStock) btnClearWarehouseStock.style.display = 'inline-block';
                if (btnReloadWarehouse) btnReloadWarehouse.style.display = 'inline-block';
            } else {
                throw new Error(result.message || '창고 재고 파싱 실패');
            }
        } else {
            const parsedData = await readExcelFile(file, type);
            if (type === 'original') {
                originalData = parsedData.filter(item => (item.qty || 0) > 0);
                statusOriginal.innerHTML = `<i class="fas fa-check-circle" style="color:#059669; margin-right:4px;"></i>상태: 분석 완료 (${originalData.length}건)`;
                statusOriginal.style.color = '#059669';
                originalFile = { name: file.name, isReloaded: true };
                localStorage.setItem('lastOrigName', file.name);
                if (lastOrig) lastOrig.textContent = `최근 사용: ${file.name}`;
                if (btnClearOriginal) btnClearOriginal.style.display = 'inline-block';
                if (btnReloadOriginal) btnReloadOriginal.style.display = 'inline-block';
            } else if (type === 'download') {
                downloadData = parsedData;
                statusDownload.innerHTML = `<i class="fas fa-check-circle" style="color:#059669; margin-right:4px;"></i>상태: 분석 완료 (${downloadData.length}건)`;
                statusDownload.style.color = '#059669';
                downloadFile = { name: file.name, isReloaded: true };
                localStorage.setItem('lastDownName', file.name);
                if (lastDown) lastDown.textContent = `최근 사용: ${file.name}`;
                if (btnClearDown) btnClearDown.style.display = 'inline-block';
                if (btnReloadDownload) btnReloadDownload.style.display = 'inline-block';
            } else if (type === 'rework') {
                reworkData = parsedData.filter(item => (item.qty || 0) > 0);
                statusRework.innerHTML = `<i class="fas fa-check-circle" style="color:#059669; margin-right:4px;"></i>상태: 분석 완료 (${reworkData.length}건)`;
                statusRework.style.color = '#059669';
                reworkFile = { name: file.name, isReloaded: true };
                localStorage.setItem('lastReworkName', file.name);
                if (lastRework) lastRework.textContent = `최근 사용: ${file.name}`;
                if (btnClearRework) btnClearRework.style.display = 'inline-block';
                if (btnReloadRework) btnReloadRework.style.display = 'inline-block';
            }
            checkReadyStatus();
        }
    } catch (err) {
        console.error(`❌ ${type} 불러오기 실패:`, err);
        statusEl.innerHTML = `<i class="fas fa-exclamation-circle" style="color:#ef4444; margin-right:4px;"></i>상태: 로드 실패 (${err.message})`;
        statusEl.style.color = '#ef4444';
        setTimeout(() => {
            statusEl.innerHTML = originalText;
            statusEl.style.color = '#64748b';
        }, 3000);
    }
}

btnReloadOriginal.addEventListener('click', () => reloadLatestFile('original'));
btnReloadDownload.addEventListener('click', () => reloadLatestFile('download'));

// 공통 자동 불러오기 로직
async function handleAutoLoad(type) {
    let inputEl, statusEl, lastEl, reloadBtn, storageKey;

    if (type === 'original') {
        inputEl = pathOriginal; statusEl = statusOriginal; lastEl = lastOrig; reloadBtn = btnReloadOriginal; storageKey = 'dirOrig';
    } else if (type === 'download') {
        inputEl = pathDownload; statusEl = statusDownload; lastEl = lastDown; reloadBtn = btnReloadDownload; storageKey = 'dirDown';
    } else if (type === 'rework') {
        inputEl = pathRework; statusEl = statusRework; lastEl = lastRework; reloadBtn = btnReloadRework; storageKey = 'dirRework';
    } else {
        inputEl = pathWarehouse; statusEl = statusWarehouseStock; lastEl = lastWarehouseStock; reloadBtn = btnReloadWarehouse; storageKey = 'dirWarehouse';
    }

    let pathVal = inputEl ? inputEl.value.trim() : "";
    let dirPath = "";

    if (pathVal && !pathVal.startsWith('선택된 파일:')) {
        const lastSlash = Math.max(pathVal.lastIndexOf('/'), pathVal.lastIndexOf('\\'));
        if (pathVal.toLowerCase().endsWith('.xlsx') || pathVal.toLowerCase().endsWith('.xls') || pathVal.toLowerCase().endsWith('.xlsm')) {
            dirPath = lastSlash !== -1 ? pathVal.substring(0, lastSlash) : pathVal;
        } else {
            dirPath = pathVal;
        }
    } else {
        dirPath = localStorage.getItem(storageKey) || "";
    }

    const typeKor = type === 'original' ? '원본' : (type === 'download' ? '전산(다운로드)' : (type === 'warehouse' ? '창고재고' : '재작업'));

    try {
        statusEl.innerHTML = `<i class="fas fa-spinner fa-spin" style="color:#3b82f6; margin-right:4px;"></i>상태: ${typeKor} 최신 파일 탐색 중...`;
        statusEl.style.color = '#3b82f6';

        let response = await fetch(`${API_BASE}/api/load-latest-from-dir?dirPath=${encodeURIComponent(dirPath)}&t=${Date.now()}`);

        // 경로를 찾지 못한 경우 사용자에게 폴더 입력 요청
        if (!response.ok) {
            const defaultPrompt = dirPath || (localStorage.getItem(storageKey) || "C:\\Users\\Administrator\\Downloads");
            const inputDir = prompt(`[${typeKor}] 엑셀 파일이 저장되는 폴더 경로를 입력해주세요.\n(예: C:\\Users\\Administrator\\Downloads)`, defaultPrompt);
            if (!inputDir || !inputDir.trim()) {
                statusEl.innerHTML = `상태: 대기 중`;
                statusEl.style.color = '#64748b';
                return;
            }
            dirPath = inputDir.trim();
            localStorage.setItem(storageKey, dirPath);
            response = await fetch(`${API_BASE}/api/load-latest-from-dir?dirPath=${encodeURIComponent(dirPath)}&t=${Date.now()}`);
        }

        if (!response.ok) {
            let errMsg = `파일을 찾을 수 없습니다. 폴더 경로를 확인해주세요.`;
            try {
                const errData = await response.json();
                if (errData && errData.message) errMsg = errData.message;
            } catch (e) { }
            throw new Error(errMsg);
        }

        const result = await response.json();

        if (result.success) {
            const binaryStr = atob(result.base64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const file = new File([blob], result.fileName, { type: blob.type });

            // 메모리 캐시에 보관 (불러오기 버튼 연동)
            window.savedRawFiles = window.savedRawFiles || {};
            window.savedRawFiles[type] = file;

            const parsed = await readExcelFile(file, type);
            if (type === 'original') {
                originalData = parsed.filter(item => (item.qty || 0) > 0);
                originalFile = { name: result.fileName, path: result.fullPath, isAutoLoaded: true, isReloaded: true };
                localStorage.setItem('lastOrigName', result.fileName);
                if (btnClearOriginal) btnClearOriginal.style.display = 'inline-block';
            } else if (type === 'download') {
                downloadData = parsed;
                downloadFile = { name: result.fileName, path: result.fullPath, isAutoLoaded: true, isReloaded: true };
                localStorage.setItem('lastDownName', result.fileName);
                if (btnClearDown) btnClearDown.style.display = 'inline-block';
            } else if (type === 'rework') {
                reworkData = parsed.filter(item => (item.qty || 0) > 0);
                reworkFile = { name: result.fileName, path: result.fullPath, isAutoLoaded: true, isReloaded: true };
                localStorage.setItem('lastReworkName', result.fileName);
                if (btnClearRework) btnClearRework.style.display = 'inline-block';
            } else if (type === 'warehouse') {
                await loadNativeWarehouseFile(result.fullPath);
                return;
            }

            statusEl.innerHTML = `<i class="fas fa-check-circle" style="color:#059669; margin-right:4px;"></i>상태: 분석 완료 (${result.fileName})`;
            statusEl.style.color = '#059669';
            if (lastEl) lastEl.textContent = `최근 사용: ${result.fileName}`;
            if (reloadBtn) reloadBtn.style.display = 'inline-block';

            if (result.fullPath) {
                const pathKey = type === 'original' ? 'pathOrig' : (type === 'download' ? 'pathDown' : (type === 'rework' ? 'pathRework' : 'pathWarehouse'));
                localStorage.setItem(pathKey, result.fullPath);
                if (result.dirPath) localStorage.setItem(storageKey, result.dirPath);
                if (inputEl) {
                    inputEl.value = (type === 'download') ? (result.dirPath || dirPath) : result.fullPath;
                }
            }

            checkReadyStatus();
            alert(`✅ ${typeKor} 최신 파일 '${result.fileName}'을(를) 성공적으로 불러왔습니다.`);
        } else {
            throw new Error(result.message);
        }
    } catch (err) {
        console.error("handleAutoLoad error:", err);
        statusEl.innerHTML = `<i class="fas fa-exclamation-circle" style="color:#ef4444; margin-right:4px;"></i>상태: 오류 (${err.message})`;
        statusEl.style.color = '#ef4444';
        alert(`❌ 최신 파일 로드 실패:\n${err.message}`);
    }
}

if (btnAutoLoadOrig) btnAutoLoadOrig.addEventListener('click', () => handleAutoLoad('original'));
if (btnAutoLoadDown) btnAutoLoadDown.addEventListener('click', () => handleAutoLoad('download'));
if (btnAutoLoadRework) btnAutoLoadRework.addEventListener('click', () => handleAutoLoad('rework'));
if (btnReloadRework) btnReloadRework.addEventListener('click', () => reloadLatestFile('rework'));

function checkReadyStatus() {
    const hasOrig = (pathOriginal.value.trim() !== "" || (originalFile !== null && originalFile !== undefined));
    const hasDown = (pathDownload.value.trim() !== "" || (downloadFile !== null && downloadFile !== undefined));
    btnCompare.disabled = !(hasOrig && hasDown);
}

// 상태 업데이트 함수
function setProcessStatus(msg, progress, isDone = false) {
    if (processStatus) {
        processStatus.style.display = 'block';
        const msgEl = document.getElementById('statusMessage');
        const barEl = document.getElementById('progressBar');
        if (msgEl) msgEl.textContent = msg;
        if (barEl) barEl.style.width = `${progress}%`;

        if (isDone) {
            setTimeout(() => {
                processStatus.style.display = 'none';
            }, 3000);
        }
    }
}

// 대시보드 통계 업데이트
function updateDashboard() {
    if (!comparisonResult || comparisonResult.length === 0) return;

    const cntrSet = new Set(comparisonResult.map(r => r.cntrNo));
    const successCntrs = new Set();
    const errorCntrs = new Set();
    const extraCntrs = new Set();
    const missingCntrs = new Set();
    const holdCntrs = new Set();

    cntrSet.forEach(cntrNo => {
        const ck = (cntrNo || "").trim().toUpperCase();
        if (holdContainerMap.has(ck)) {
            holdCntrs.add(ck);
            return;
        }

        const rows = comparisonResult.filter(r => r.cntrNo === cntrNo);

        // [전산 누락 방지] 전산 파일에 데이터가 아예 없는 컨테이너는
        // 사용자가 승인했더라도 전산 데이터가 들어오기 전까지는 정상(success)으로 이동하지 않고 missing으로 유지
        const isPureMissing = rows.every(r => 
            (r.initialBadgeClass === 'missing' || r.origBadgeClass === 'missing' || r.badgeClass === 'missing') ||
            (r.destination && r.destination.val === '-' && r.carrierName && r.carrierName.val === '-')
        );

        if (isPureMissing) {
            missingCntrs.add(cntrNo);
            return;
        }

        // 수동 승인 여부 확인 헬퍼
        const checkApproved = (r) => manualApprovedItems.has(`${(r.cntrNo || "").trim()}_${(r.prodName || "").trim()}`);

        const allNew = rows.every(r => r.qtyInfo.origPlan === null && !checkApproved(r));
        const allMissing = rows.every(r => r.badgeClass === 'missing' && !checkApproved(r));
        const hasError = rows.some(r => (r.isErrorRow || r.badgeClass === 'diff') && !checkApproved(r));

        if (allNew) {
            const allNewNonAssetOnly = rows.every(r => r.badgeClass === 'success' || checkApproved(r));
            if (allNewNonAssetOnly) successCntrs.add(cntrNo);
            else extraCntrs.add(cntrNo);
        } else if (allMissing) {
            missingCntrs.add(cntrNo);
        } else if (hasError || rows.some(r => (r.badgeClass === 'new' || r.badgeClass === 'missing') && !checkApproved(r))) {
            errorCntrs.add(cntrNo);
        } else {
            successCntrs.add(cntrNo);
        }
    });

    const valTotalCntr = document.getElementById('valTotalCntr');
    const valSuccessCntr = document.getElementById('valSuccessCntr');
    const valErrorCntr = document.getElementById('valErrorCntr');
    const valDownExtraCntr = document.getElementById('valDownExtraCntr');
    const valOrigExtraCntr = document.getElementById('valOrigExtraCntr');
    const valExcludedCntr = document.getElementById('valExcludedCntr');
    const valUpdate = document.getElementById('valUpdate');
    const holdCountEl = document.getElementById('holdCount');
    const valHoldCntr = document.getElementById('valHoldCntr');
    const cntMissingExtra = document.getElementById('cntMissingExtra');
    const cntMissingMissing = document.getElementById('cntMissingMissing');

    if (valTotalCntr) valTotalCntr.textContent = cntrSet.size;
    if (valSuccessCntr) valSuccessCntr.textContent = successCntrs.size;
    if (valErrorCntr) valErrorCntr.textContent = errorCntrs.size;
    if (valDownExtraCntr) valDownExtraCntr.textContent = extraCntrs.size;
    if (valOrigExtraCntr) valOrigExtraCntr.textContent = missingCntrs.size;
    if (cntMissingExtra) cntMissingExtra.textContent = extraCntrs.size;
    if (cntMissingMissing) cntMissingMissing.textContent = missingCntrs.size;
    if (valExcludedCntr) {
        valExcludedCntr.textContent = new Set(excludedList.map(item => item.cntrNo)).size;
    }
    if (holdCountEl) holdCountEl.textContent = holdCntrs.size;
    if (valHoldCntr) valHoldCntr.textContent = holdCntrs.size;
    if (valUpdate) valUpdate.textContent = (missingProductsSet ? missingProductsSet.size : 0) + (weightMismatchSet ? weightMismatchSet.size : 0);

    // [통합] 미분류 컨테이너 목록 (누락/추가건 포함)
    const unclassifiedCntrNos = new Set(
        comparisonResult.filter(r => (r.badgeClass === 'missing' || r.badgeClass === 'extra' ||
            (manualApprovedItems.has(`${(r.cntrNo || "").trim()}_${(r.prodName || "").trim()}`) &&
                (r.origBadgeClass === 'missing' || r.origBadgeClass === 'extra'))))
            .map(r => r.cntrNo)
    );

    // 운송사 통계: 컨테이너와 운송사 쌍으로 집계 (한 컨테이너에 여러 운송사가 섞인 경우 대비)
    let chunmaCount = 0;
    let bniCount = 0;
    let unknownCount = 0;

    const transAssignmentMap = new Set();
    comparisonResult.forEach(r => {
        const ck = (r.cntrNo || "").trim().toUpperCase();
        const isUnclassified = unclassifiedCntrNos.has(r.cntrNo);

        let trans = (r.transporter || "").trim();
        let transKey = "unknown";

        if (isUnclassified || trans === "미분류") {
            transKey = "unknown";
        } else if (trans.includes('천마')) {
            transKey = '천마';
        } else if (trans.includes('BNI')) {
            transKey = 'BNI';
        }

        transAssignmentMap.add(`${ck}|${transKey}`);
    });

    transAssignmentMap.forEach(assignment => {
        const [_, trans] = assignment.split('|');
        if (trans === '천마') chunmaCount++;
        else if (trans === 'BNI') bniCount++;
        else unknownCount++;
    });

    const valChunma = document.getElementById('valChunma');
    const valBni = document.getElementById('valBni');
    const valUnknownTransporter = document.getElementById('valUnknownTransporter');

    if (valChunma) valChunma.textContent = chunmaCount;
    if (valBni) valBni.textContent = bniCount;
    if (valUnknownTransporter) valUnknownTransporter.textContent = unknownCount;

    // 제품정보 업데이트 필요 카드 클릭 이벤트 (대화형 팝업 연동)
    const updateCard = document.querySelector('.summary-card.update-needed');
    if (updateCard && !updateCard._hasClickHandler) {
        updateCard.style.cursor = 'pointer';
        updateCard.addEventListener('click', () => {
            const hasMissing = missingProductsSet && missingProductsSet.size > 0;
            const hasMismatch = weightMismatchSet && weightMismatchSet.size > 0;
            if (!hasMissing && !hasMismatch) {
                alert('업데이트가 필요한 제품이 없습니다.');
                return;
            }
            showInteractiveUpdateNeededPopup(missingProductsSet, weightMismatchSet);
        });
        updateCard._hasClickHandler = true;
    }

    // 운송사 배정 현황 카드 클릭 이벤트 (반입정보 생성 탭으로 이동)
    const transporterCard = document.getElementById('cardTransporter');
    if (transporterCard && !transporterCard._hasClickHandler) {
        transporterCard.style.cursor = 'pointer';
        transporterCard.addEventListener('click', () => {
            if (typeof setActiveTab === 'function') {
                setActiveTab('entry');
                if (comparisonResult && comparisonResult.length > 0) {
                    displayResults(comparisonResult);
                }
            }
        });
        transporterCard._hasClickHandler = true;
    }

    if (typeof window.updateBlockWorkBadge === 'function') {
        window.updateBlockWorkBadge();
    }
}

function evaluateMathString(currentVal, expr) {
    if (!expr) return currentVal;
    let str = expr.trim();
    if (str.startsWith('+')) return currentVal + parseFloat(str.substring(1));
    if (str.startsWith('-')) return currentVal - parseFloat(str.substring(1));
    if (str.startsWith('*')) return currentVal * parseFloat(str.substring(1));
    if (str.startsWith('/')) return currentVal / parseFloat(str.substring(1));
    if (str.startsWith('=')) return parseFloat(str.substring(1));
    let num = parseFloat(str);
    if (!isNaN(num)) return num;
    return currentVal;
}

// Electron 및 웹 브라우저 공용 OS 네이티브 탐색기 파일 피커 바인딩 (각 기능별 마지막 폴더 기억)
(function setupNativePickers() {
    const pickers = [
        { btn: 'btnNativePickerOrig', fileInputId: 'fileOriginal', pathInputId: 'pathOriginal', type: 'original', storageKey: 'dirOrig', title: '1. 원본 파일 선택' },
        { btn: 'btnNativePickerRework', fileInputId: 'fileRework', pathInputId: 'pathRework', type: 'rework', storageKey: 'dirRework', title: '1-2. 재작업 파일 선택' },
        { btn: 'btnNativePickerWarehouse', fileInputId: 'fileWarehouseStock', pathInputId: 'pathWarehouse', type: 'warehouse', storageKey: 'dirWarehouse', title: '1-3. 창고재고 파일 선택' },
        { btn: 'btnNativePickerDown', fileInputId: 'fileDownload', pathInputId: 'pathDownload', type: 'download', storageKey: 'dirDown', title: '2. 전산 다운로드 파일 선택' }
    ];

    pickers.forEach(p => {
        const btn = document.getElementById(p.btn);
        if (!btn) return;

        btn.addEventListener('click', async () => {
            // 1. Electron 데스크톱 앱 환경인 경우 -> Electron native dialog 호출
            if (window.electronAPI && typeof window.electronAPI.selectFile === 'function') {
                const lastDir = localStorage.getItem(p.storageKey);
                const filePath = await window.electronAPI.selectFile(p.type, lastDir);
                if (filePath) {
                    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
                    const dirPath = lastSlash !== -1 ? filePath.substring(0, lastSlash) : filePath;
                    localStorage.setItem(p.storageKey, dirPath);
                    const pathEl = document.getElementById(p.pathInputId);
                    if (pathEl) pathEl.value = (p.type === 'download') ? dirPath : filePath;
                    if (p.type === 'warehouse') loadNativeWarehouseFile(filePath);
                    else reloadNativeFileFromPath(p.type, filePath);
                }
                return;
            }

            // 2. 웹 브라우저 (Chrome, Edge 등) 환경인 경우 -> W3C File System Access API (id별 마지막 폴더 자동 기억!)
            if (window.showOpenFilePicker) {
                try {
                    const [fileHandle] = await window.showOpenFilePicker({
                        id: p.storageKey, // 브라우저가 각 기능별(dirOrig, dirDown 등) 마지막 열었던 폴더를 자동 기억하여 바로 엽니다!
                        types: [{
                            description: 'Excel Files (*.xlsx, *.xls, *.xlsm)',
                            accept: {
                                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx', '.xls', '.xlsm']
                            }
                        }],
                        multiple: false
                    });

                    if (!fileHandle) return;
                    const file = await fileHandle.getFile();
                    if (!file) return;

                    window.savedNativeFileHandles = window.savedNativeFileHandles || {};
                    window.savedNativeFileHandles[p.type] = fileHandle;
                    window.savedRawFiles = window.savedRawFiles || {};
                    window.savedRawFiles[p.type] = file;

                    // 파일 직접 파싱 및 로드
                    if (p.type === 'warehouse') {
                        const statusEl = document.getElementById('statusWarehouseStock');
                        if (statusEl) statusEl.innerHTML = `<i class="fas fa-spinner fa-spin" style="color:#16a34a; margin-right:4px;"></i>상태: 분석 중...`;
                        const formData = new FormData();
                        formData.append('warehouseFile', file);
                        const resp = await fetch(`${API_BASE}/api/parse-warehouse-stock`, { method: 'POST', body: formData });
                        const result = await resp.json();
                        if (result.success) {
                            warehouseStockDongPrefixes = new Set(result.dongPrefixes.map(x => x.toUpperCase()));
                            warehouseStockBlockProductsAll = new Set((result.blockProductNamesWith17 || []).map(x => x.toUpperCase()));
                            warehouseStockBlockProductsNo17 = new Set((result.blockProductNames || []).map(x => x.toUpperCase()));
                            warehouseStockQtyMapAll = result.stockMapWith17 || {};
                            warehouseStockQtyMapNo17 = result.stockMap || {};
                            warehouseHoldStockListAll = result.holdStockListWith17 || [];
                            warehouseHoldStockListNo17 = result.holdStockList || [];
                            warehouseAllStockListAll = result.allStockListWith17 || [];
                            warehouseAllStockListNo17 = result.allStockList || [];
                            warehouseStockLoaded = true;
                            updateActiveWarehouseStock();
                            if (statusEl) statusEl.innerHTML = `<i class="fas fa-check-circle" style="color:#16a34a; margin-right:4px;"></i>상태: 분석 완료 (${file.name})`;
                            const lastWhEl = document.getElementById('lastWarehouseStock');
                            if (lastWhEl) lastWhEl.textContent = `고유제품 ${result.totalProducts}개 분석 완료`;
                            if (btnClearWarehouseStock) btnClearWarehouseStock.style.display = 'inline-block';
                            if (btnReloadWarehouse) btnReloadWarehouse.style.display = 'inline-block';
                        }
                    } else {
                        const parsed = await readExcelFile(file, p.type);
                        if (p.type === 'original') {
                            originalData = parsed.filter(item => (item.qty || 0) > 0);
                            originalFile = { name: file.name, isLoaded: true };
                            localStorage.setItem('lastOrigName', file.name);
                            if (statusOriginal) {
                                statusOriginal.innerHTML = `<i class="fas fa-check-circle" style="color:#059669; margin-right:4px;"></i>상태: 분석 완료 (${file.name})`;
                                statusOriginal.style.color = '#059669';
                            }
                            if (lastOrig) lastOrig.textContent = `최근 사용: ${file.name}`;
                            if (btnClearOriginal) btnClearOriginal.style.display = 'inline-block';
                            if (btnReloadOriginal) btnReloadOriginal.style.display = 'inline-block';
                        } else if (p.type === 'download') {
                            downloadData = parsed;
                            downloadFile = { name: file.name, isLoaded: true };
                            localStorage.setItem('lastDownName', file.name);
                            if (statusDownload) {
                                statusDownload.innerHTML = `<i class="fas fa-check-circle" style="color:#059669; margin-right:4px;"></i>상태: 분석 완료 (${file.name})`;
                                statusDownload.style.color = '#059669';
                            }
                            if (lastDown) lastDown.textContent = `최근 사용: ${file.name}`;
                            if (btnClearDown) btnClearDown.style.display = 'inline-block';
                            if (btnReloadDownload) btnReloadDownload.style.display = 'inline-block';
                        } else if (p.type === 'rework') {
                            reworkData = parsed.filter(item => (item.qty || 0) > 0);
                            reworkFile = { name: file.name, isLoaded: true };
                            localStorage.setItem('lastReworkName', file.name);
                            if (statusRework) {
                                statusRework.innerHTML = `<i class="fas fa-check-circle" style="color:#059669; margin-right:4px;"></i>상태: 분석 완료 (${file.name})`;
                                statusRework.style.color = '#059669';
                            }
                            if (lastRework) lastRework.textContent = `최근 사용: ${file.name}`;
                            if (btnClearRework) btnClearRework.style.display = 'inline-block';
                            if (btnReloadRework) btnReloadRework.style.display = 'inline-block';
                        }
                        checkReadyStatus();
                    }

                    // 파일 이름 표시
                    const pathEl = document.getElementById(p.pathInputId);
                    if (pathEl && !pathEl.value.trim()) {
                        pathEl.placeholder = `선택된 파일: ${file.name}`;
                    }

                } catch (err) {
                    if (err.name === 'AbortError') return; // 사용자가 창을 닫거나 취소한 경우
                    console.warn("showOpenFilePicker failed, falling back to input:", err);
                    const fileInput = document.getElementById(p.fileInputId);
                    if (fileInput) fileInput.click();
                }
            } else {
                // 3. Fallback: input.click()
                const fileInput = document.getElementById(p.fileInputId);
                if (fileInput) fileInput.click();
            }
        });
    });
})();

// 네이티브 경로에서 파일 로드 및 파싱 (원본/전산/재작업 공용)
async function reloadNativeFileFromPath(type, filePath) {
    const statusEl = type === 'original' ? statusOriginal : (type === 'download' ? statusDownload : statusRework);
    try {
        statusEl.textContent = `상태: 데이터 불러오는 중...`;
        statusEl.style.color = '#3b82f6';

        const response = await fetch(`${API_BASE}/api/load-file-raw?path=${encodeURIComponent(filePath)}&t=${Date.now()}`);
        if (!response.ok) throw new Error("파일 로드 실패");

        const result = await response.json();
        if (result.success) {
            const binaryStr = atob(result.base64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const file = new File([blob], result.fileName, { type: blob.type });

            const parsed = await readExcelFile(file, type);

            if (type === 'original') {
                originalData = parsed.filter(item => (item.qty || 0) > 0);
                originalFile = { name: result.fileName, path: filePath, isReloaded: true };
                localStorage.setItem('lastOrigName', result.fileName);
                localStorage.setItem('pathOrig', filePath);
                document.getElementById('pathOriginal').value = filePath;
                document.getElementById('lastOrig').textContent = `최근 사용: ${result.fileName}`;
                document.getElementById('btnReloadOriginal').style.display = 'inline-block';
            } else if (type === 'download') {
                downloadData = parsed;
                downloadFile = { name: result.fileName, path: filePath, isReloaded: true };
                localStorage.setItem('lastDownName', result.fileName);
                localStorage.setItem('pathDown', filePath);
                document.getElementById('pathDownload').value = filePath;
                document.getElementById('lastDown').textContent = `최근 사용: ${result.fileName}`;
                document.getElementById('btnReloadDownload').style.display = 'inline-block';
            } else if (type === 'rework') {
                reworkData = parsed.filter(item => (item.qty || 0) > 0);
                reworkFile = { name: result.fileName, path: filePath, isReloaded: true };
                localStorage.setItem('pathRework', filePath);
                if (document.getElementById('pathRework')) document.getElementById('pathRework').value = filePath;
                if (document.getElementById('lastRework')) document.getElementById('lastRework').textContent = `최근 사용: ${result.fileName}`;
                if (document.getElementById('btnClearRework')) document.getElementById('btnClearRework').style.display = 'inline-block';
                if (document.getElementById('btnReloadRework')) document.getElementById('btnReloadRework').style.display = 'inline-block';
            }


            const itemCount = type === 'original' ? originalData.length : (type === 'download' ? downloadData.length : (type === 'rework' ? reworkData.length : "- "));
            statusEl.innerHTML = `<i class="fas fa-check-circle" style="color:#059669; margin-right:4px;"></i>상태: 분석 완료 (${itemCount}건)`;
            statusEl.style.color = '#059669';

            // 불러오기 성공 시 해제 버튼 활성화
            if (type === 'original' && btnClearOriginal) btnClearOriginal.style.display = 'inline-block';
            if (type === 'download' && btnClearDown) btnClearDown.style.display = 'inline-block';

            checkReadyStatus();
        }
    } catch (err) {
        statusEl.textContent = `상태: 로드 실패 (${err.message})`;
        statusEl.style.color = '#ef4444';
    }
}

// 창고재고 파일 네이티브 로드
async function loadNativeWarehouseFile(filePath) {
    const statusEl = document.getElementById('statusWarehouseStock');
    try {
        statusEl.innerHTML = `<i class="fas fa-spinner fa-spin" style="color:#16a34a; margin-right:4px;"></i>상태: 분석 중...`;

        // 창고재고는 서버에서 파싱하므로 path만 전달해도 되지만 현재 API는 multipart/form-data를 원함
        // 편리하게 하기 위해 파일을 받아서 처리하거나, 서버에 path 기반 파싱 API를 추가해야 함.
        // 여기서는 위와 동일하게 base64로 가져와서 Blob을 만들고 FormData로 전송
        const response = await fetch(`${API_BASE}/api/load-file-raw?path=${encodeURIComponent(filePath)}&t=${Date.now()}`);
        const resultRaw = await response.json();

        if (resultRaw.success) {
            const binaryStr = atob(resultRaw.base64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            const file = new File([new Blob([bytes])], resultRaw.fileName);

            const formData = new FormData();
            formData.append('warehouseFile', file);
            const resp = await fetch(`${API_BASE}/api/parse-warehouse-stock`, { method: 'POST', body: formData });
            const result = await resp.json();

            if (result.success) {
                warehouseStockDongPrefixes = new Set(result.dongPrefixes.map(p => p.toUpperCase()));
                
                // 두 버전의 데이터 백업 변수에 저장 (자동 로드 경로)
                warehouseStockBlockProductsAll = new Set(
                    (result.blockProductNamesWith17 || []).map(p => p.toUpperCase())
                );
                warehouseStockBlockProductsNo17 = new Set(
                    (result.blockProductNames || []).map(p => p.toUpperCase())
                );
                
                warehouseStockQtyMapAll = result.stockMapWith17 || {};
                warehouseStockQtyMapNo17 = result.stockMap || {};
                
                warehouseHoldStockListAll = result.holdStockListWith17 || [];
                warehouseHoldStockListNo17 = result.holdStockList || [];
                
                warehouseAllStockListAll = result.allStockListWith17 || [];
                warehouseAllStockListNo17 = result.allStockList || [];
                
                warehouseStockLoaded = true;

                // 체크박스 상태에 맞춰 active 변수 업데이트 및 UI 재렌더링
                updateActiveWarehouseStock();

                if (pathWarehouse) pathWarehouse.value = filePath;
                statusEl.innerHTML = `<i class="fas fa-check-circle" style="color:#16a34a; margin-right:4px;"></i>상태: 분석 완료 (${result.fileName})`;
                document.getElementById('lastWarehouseStock').textContent = `고유제품 ${result.totalProducts}개 분석 완료`;
                if (btnClearWarehouseStock) btnClearWarehouseStock.style.display = 'inline-block';
                if (btnReloadWarehouse) btnReloadWarehouse.style.display = 'inline-block';
                if (document.getElementById('dongTagBadge')) {
                    document.getElementById('dongPrefixCount').textContent = result.dongPrefixes.length;
                    document.getElementById('dongTagBadge').style.display = 'inline-flex';
                }
                console.log(`✅ [자동로드] 창고재고 완료: Block Qty 대상 ${warehouseStockBlockProducts.size}개`);
            }
        }
    } catch (err) {
        statusEl.textContent = `에러: ${err.message}`;
    }
}

// 비교 로직 실행 버튼
btnCompare.addEventListener('click', async () => {
    try {
        if (!originalFile && !pathOriginal.value.trim()) {
            alert("원본 파일을 선택하거나 폴더 경로를 입력해주세요.");
            setProcessStatus("원본 파일 필요", 0);
            return;
        }
        if (!downloadFile && !pathDownload.value.trim()) {
            alert("전산(다운로드) 파일을 선택하거나 폴더 경로를 입력해주세요.");
            setProcessStatus("전산 파일 필요", 0);
            return;
        }

        // [사용자 요청] 비교 시작 시 기존 검색 필터 및 체크된 선택 항목(승인/보류 건 예외) 초기화
        // 1. 검색 필터 초기화
        const searchInput = document.getElementById('inputSearch');
        const prodSearchInput = document.getElementById('inputProdSearch');
        const prodTypeSelect = document.getElementById('selectProdType');
        const chkFilterCompleted = document.getElementById('chkFilterCompleted');
        const chkFilterProgress = document.getElementById('chkFilterProgress');
        const chkFilterPending = document.getElementById('chkFilterPending');
        const chkFilterChunma = document.getElementById('chkFilterChunma');
        const chkFilterBni = document.getElementById('chkFilterBni');
        const chkFilterOtherTrans = document.getElementById('chkFilterOtherTrans');
        const chkFilterHasPhoto = document.getElementById('chkFilterHasPhoto');
        
        if (searchInput) searchInput.value = "";
        if (prodSearchInput) prodSearchInput.value = "";
        if (prodTypeSelect) prodTypeSelect.value = "";
        if (chkFilterCompleted) chkFilterCompleted.checked = false;
        if (chkFilterProgress) chkFilterProgress.checked = false;
        if (chkFilterPending) chkFilterPending.checked = false;
        if (chkFilterChunma) chkFilterChunma.checked = false;
        if (chkFilterBni) chkFilterBni.checked = false;
        if (chkFilterOtherTrans) chkFilterOtherTrans.checked = false;
        if (chkFilterHasPhoto) chkFilterHasPhoto.checked = false;

        // 2. 체크박스 선택 항목 초기화 (승인 건과 보류 건은 예외로 유지)
        const keepKeys = [];
        selectedItems.forEach(itemKey => {
            const [cntr, prod] = itemKey.split('_');
            const isApproved = manualApprovedItems.has(itemKey);
            const isHold = holdContainerMap.has(cntr);
            let isDataApproved = false;
            let isDataHeld = false;
            if (window.comparisonResult) {
                const row = window.comparisonResult.find(r => 
                    (r.cntrNo || "").trim() === cntr && (r.prodName || "").trim() === prod
                );
                if (row) {
                    isDataApproved = row.isApproved;
                    isDataHeld = row.isHeld;
                }
            }
            if (isApproved || isDataApproved || isHold || isDataHeld) {
                keepKeys.push(itemKey);
            }
        });
        selectedItems.clear();
        keepKeys.forEach(k => selectedItems.add(k));

        // 3. UI 체크박스 전체선택 상태도 해제
        const selectAllCheckbox = document.getElementById('selectAll');
        if (selectAllCheckbox) selectAllCheckbox.checked = false;

        setProcessStatus("데이터 처리 준비 중...", 10);
        userSelectedWeights = {}; // 새로운 비교 시작 시 초기화
        reworkContainers.clear(); // 새로운 비교 시작 시 초기화

        let finalOrigList = [];
        let finalDownList = [];
        let finalReworkList = [];

        // 1. 원본 데이터 로드 (캐시 우선 사용, 비어있을 때만 새로 파싱)
        if (originalData && originalData.length > 0) {
            finalOrigList = [...originalData];
            console.log(`⚡ [Cache] 원본 데이터 캐시 사용 (${finalOrigList.length}건)`);
        } else if (originalFile && originalFile.path) {
            const filePath = originalFile.path;
            const resp = await fetch(`${API_BASE}/api/load-file-raw?path=${encodeURIComponent(filePath)}&t=${Date.now()}`);
            if (!resp.ok) throw new Error("서버 경로(원본)를 찾을 수 없습니다.");
            const res = await resp.json();
            if (res.success) {
                const binaryStr = atob(res.base64);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
                const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                const fObj = new File([blob], res.fileName || 'original.xlsx', { type: blob.type });
                finalOrigList = await readExcelFile(fObj, 'original');
                finalOrigList = finalOrigList.filter(item => (item.qty || 0) > 0);
            } else {
                throw new Error("원본 경로에서 파일을 읽을 수 없습니다.");
            }
        } else if (originalFile) {
            finalOrigList = await readExcelFile(originalFile, 'original');
            finalOrigList = finalOrigList.filter(item => (item.qty || 0) > 0);
        } else if (pathOriginal.value.trim()) {
            const filePath = pathOriginal.value.trim();
            const isLocalPath = /^[a-zA-Z]:\\/.test(filePath) || filePath.startsWith('\\\\');
            if (isLocalPath && !window.isElectron && window.location.hostname !== 'localhost') {
                throw new Error("웹 버전에서는 로컬 절대 경로(Y:\\, C:\\ 등)를 사용할 수 없습니다. 파일을 직접 선택해 주세요.");
            }
            const resp = await fetch(`${API_BASE}/api/load-file-raw?path=${encodeURIComponent(filePath)}&t=${Date.now()}`);
            if (!resp.ok) throw new Error("서버 경로(원본)를 찾을 수 없습니다.");
            const res = await resp.json();
            if (res.success) {
                const binaryStr = atob(res.base64);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
                const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                const fObj = new File([blob], res.fileName || 'original.xlsx', { type: blob.type });
                finalOrigList = await readExcelFile(fObj, 'original');
                finalOrigList = finalOrigList.filter(item => (item.qty || 0) > 0);

                // 경로 저장 (성공 시)
                localStorage.setItem('pathOrig', filePath);
                if (window.electronAPI) window.electronAPI.saveFilePath('original', filePath);
            } else {
                throw new Error("원본 경로에서 파일을 읽을 수 없습니다: " + (res.message || "알 수 없는 오류"));
            }
        }

        setProcessStatus("원본 데이터 분석 완료. 전산 데이터 로드 중...", 40);

        // 2. 전산 데이터 로드 (캐시 우선 사용, 비어있을 때만 새로 파싱)
        if (downloadData && downloadData.length > 0) {
            finalDownList = [...downloadData];
            console.log(`⚡ [Cache] 전산 데이터 캐시 사용 (${finalDownList.length}건)`);
        } else if (downloadFile && downloadFile.path) {
            const filePath = downloadFile.path;
            const isDir = !filePath.match(/\.(xlsx|xls|xlsm)$/i);
            if (isDir) {
                const resp = await fetch(`${API_BASE}/api/load-latest-from-dir?dirPath=${encodeURIComponent(filePath)}&t=${Date.now()}`);
                if (!resp.ok) throw new Error("서버 경로(전산 폴더)를 찾을 수 없습니다.");
                const res = await resp.json();
                if (res.success) {
                    const binaryStr = atob(res.base64);
                    const bytes = new Uint8Array(binaryStr.length);
                    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
                    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                    const fObj = new File([blob], res.fileName || 'download.xlsx', { type: blob.type });
                    finalDownList = await readExcelFile(fObj, 'download');
                } else throw new Error("폴더에서 전산 파일을 찾을 수 없습니다.");
            } else {
                const resp = await fetch(`${API_BASE}/api/load-file-raw?path=${encodeURIComponent(filePath)}&t=${Date.now()}`);
                if (!resp.ok) throw new Error("서버 경로(전산)를 찾을 수 없습니다.");
                const res = await resp.json();
                if (res.success) {
                    const binaryStr = atob(res.base64);
                    const bytes = new Uint8Array(binaryStr.length);
                    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
                    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                    const fObj = new File([blob], res.fileName || 'download.xlsx', { type: blob.type });
                    finalDownList = await readExcelFile(fObj, 'download');
                } else throw new Error("전산 경로에서 파일을 읽을 수 없습니다.");
            }
        } else if (downloadFile) {
            finalDownList = await readExcelFile(downloadFile, 'download');
        } else if (pathDownload.value.trim()) {
            const filePath = pathDownload.value.trim();
            const isLocalPath = /^[a-zA-Z]:\\/.test(filePath) || filePath.startsWith('\\\\');
            if (isLocalPath && !window.isElectron && window.location.hostname !== 'localhost') {
                throw new Error("웹 버전에서는 로컬 폴더/파일 경로를 사용할 수 없습니다. 파일을 직접 선택해 주세요.");
            }

            // 폴더 경로인지 파일 경로인지 판단
            // 확장자(.xlsx 등)가 없으면 폴더 경로로 간주
            const isDir = !filePath.match(/\.(xlsx|xls|xlsm)$/i);

            if (isDir) {
                // 폴더에서 최신 파일 자동 로드
                const resp = await fetch(`${API_BASE}/api/load-latest-from-dir?dirPath=${encodeURIComponent(filePath)}&t=${Date.now()}`);
                if (!resp.ok) throw new Error("서버 경로(전산 폴더)를 찾을 수 없습니다. 폴더가 존재하는지 확인하거나 파일을 직접 선택해주세요.");
                const res = await resp.json();
                if (res.success) {
                    const binaryStr = atob(res.base64);
                    const bytes = new Uint8Array(binaryStr.length);
                    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
                    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                    const fObj = new File([blob], res.fileName || 'download.xlsx', { type: blob.type });
                    finalDownList = await readExcelFile(fObj, 'download');
                    setProcessStatus(`전산 파일 자동 로드됨: ${res.fileName}`, 42);
                } else {
                    throw new Error("폴더에서 전산 파일을 찾을 수 없습니다: " + (res.message || "알 수 없는 오류"));
                }
            } else {
                // 파일 직접 경로
                const resp = await fetch(`${API_BASE}/api/load-file-raw?path=${encodeURIComponent(filePath)}&t=${Date.now()}`);
                if (!resp.ok) throw new Error("서버 경로(전산)를 찾을 수 없습니다. 파일이 존재하는지 확인하거나 직접 선택해주세요.");
                const res = await resp.json();
                if (res.success) {
                    const binaryStr = atob(res.base64);
                    const bytes = new Uint8Array(binaryStr.length);
                    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
                    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                    const fObj = new File([blob], res.fileName || 'download.xlsx', { type: blob.type });
                    finalDownList = await readExcelFile(fObj, 'download');

                    // 경로 저장 (성공 시)
                    localStorage.setItem('pathDown', filePath);
                    if (window.electronAPI) window.electronAPI.saveFilePath('download', filePath);
                } else {
                    throw new Error("전산 경로에서 파일을 읽을 수 없습니다: " + (res.message || "알 수 없는 오류"));
                }
            }
        }

        setProcessStatus("전산 데이터 분석 완료. 재작업 데이터 확인 중...", 60);

        // 3. 재작업 데이터 로드 (캐시 우선 사용, 비어있을 때만 새로 파싱)
        if (reworkData && reworkData.length > 0) {
            finalReworkList = [...reworkData];
            console.log(`⚡ [Cache] 재작업 데이터 캐시 사용 (${finalReworkList.length}건)`);
        } else if (reworkFile && (reworkFile.isReloaded || reworkFile.isAutoLoaded)) {
            finalReworkList = reworkData;
        } else if (reworkFile) {
            finalReworkList = await readExcelFile(reworkFile, 'rework'); // 재작업 파일은 '재작업당일' 시트를 읽어야 함
            finalReworkList = finalReworkList.filter(item => (item.qty || 0) > 0);
        } else if (pathRework.value.trim()) {
            // 경로 기반 재작업 파일 로드: raw 파일을 받아서 브라우저에서 파싱
            const filePath = pathRework.value.trim();
            const isLocalPath = /^[a-zA-Z]:\\/.test(filePath) || filePath.startsWith('\\\\');
            if (isLocalPath && !window.isElectron && window.location.hostname !== 'localhost') {
                console.warn("웹 버전에서는 로컬 재작업 파일 경로를 건너뜁니다.");
            } else {
                const reworkResp = await fetch(`${API_BASE}/api/load-file-raw?path=${encodeURIComponent(filePath)}&t=${Date.now()}`);
                if (reworkResp.ok) {
                    const reworkResult = await reworkResp.json();
                    if (reworkResult.success) {
                        const binaryStr = atob(reworkResult.base64);
                        const bytes = new Uint8Array(binaryStr.length);
                        for (let i = 0; i < binaryStr.length; i++) {
                            bytes[i] = binaryStr.charCodeAt(i);
                        }
                        const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                        const reworkFileObj = new File([blob], reworkResult.fileName || 'rework.xlsx', { type: blob.type });
                        finalReworkList = await readExcelFile(reworkFileObj, 'rework');
                        finalReworkList = finalReworkList.filter(item => (item.qty || 0) > 0);

                        // 경로 저장 (성공 시)
                        localStorage.setItem('pathRework', filePath);
                        if (window.electronAPI) window.electronAPI.saveFilePath('rework', filePath);
                    }
                }
            }
        }

        // 재작업 컨테이너 번호 집합 생성
        reworkContainers = new Set(
            finalReworkList
                .map(item => (item.cntrNo || "").trim().toUpperCase())
                .filter(Boolean)
        );

        // 재작업 데이터가 있으면 원본 데이터에 합침
        if (finalReworkList.length > 0) {
            finalReworkList.forEach(item => { item.source = 'rework'; });
            finalOrigList = [...finalOrigList, ...finalReworkList];
            console.log(`✅ 재작업 데이터 ${finalReworkList.length}건이 원본에 통합되었습니다.`);
        }

        // 동적 매핑 및 창 닫기 시 재비교 연동을 위해 글로벌 변수 동기화
        originalData = finalOrigList.filter(item => item.source !== 'rework');
        downloadData = [...finalDownList];
        reworkData = [...finalReworkList];

        // [사용자 요청] 원본파일, 재작업대상 파일의 S열(작업일)값에 날짜가 없는 경우 작업대상에서 제외 처리
        excludedList = [];
        const excludedContainers = new Set();
        finalOrigList.forEach(item => {
            const cntr = (item.cntrNo || "").trim().toUpperCase();
            if (cntr && !item.workDate) {
                excludedContainers.add(cntr);
                excludedList.push({
                    cntrNo: cntr,
                    sheetName: item.sheetName || "-",
                    rowNumber: item.rowNumber || "-",
                    prodName: item.prodName || "-",
                    qty: item.qty || 0,
                    transporter: item.transporter || "미분류"
                });
            }
        });

        if (excludedContainers.size > 0) {
            console.log(`⚠️ 작업일(S열)이 없어 작업대상에서 제외되는 컨테이너 목록:`, [...excludedContainers]);
            // 원본 리스트에서 제외
            finalOrigList = finalOrigList.filter(item => {
                const cntr = (item.cntrNo || "").trim().toUpperCase();
                return !excludedContainers.has(cntr);
            });
            // 전산 리스트에서도 제외 (원본누락 등으로 노출되는 것을 방지)
            if (finalDownList) {
                finalDownList = finalDownList.filter(item => {
                    const cntr = (item.cntrNo || "").trim().toUpperCase();
                    return !excludedContainers.has(cntr);
                });
            }
        }

        setProcessStatus("데이터 비교 알고리즘 실행 중...", 80);

        // [DEBUG] 파싱 결과 콘솔 출력
        const _origU = [...new Set(finalOrigList.map(r=>(r.cntrNo||'').trim().toUpperCase()))];
        const _downU = [...new Set(finalDownList.map(r=>(r.cntrNo||'').trim().toUpperCase()))];
        console.log('[DEBUG] 원본:', finalOrigList.length, '행 /', _origU.length, '개 컨테이너');
        console.log('[DEBUG] 전산:', finalDownList.length, '행 /  ', _downU.length, '개 컨테이너');
        console.log('[DEBUG] 원본 샘플:', finalOrigList.slice(0,3).map(r=>r.cntrNo+'|'+r.prodName));
        console.log('[DEBUG] 전산 샘플:', finalDownList.slice(0,3).map(r=>r.cntrNo+'|'+r.prodName));
        console.log('[DEBUG] 매칭 컨테이너:', _origU.filter(c=>_downU.includes(c)));

        // 4. 비교 로직 실행 (compareLogic.js의 함수 호출)
        comparisonResult = compareData(
            finalOrigList,
            finalDownList,
            productMaster,
            dynamicRules,
            customFields,
            carrierMap,
            normalizeCarrier
        );
        comparisonResult.forEach(r => {
            r.initialBadgeClass = r.badgeClass;
            r.origBadgeClass = r.badgeClass;
        });

        setProcessStatus("화면 업데이트 중...", 95);

        // 5. 결과 표시 (기본값을 '정상컨테이너만 보기'로 변경)
        updateDashboard();
        // [자동 저장 추가] 정상 컨테이너 자동 저장
        autoSaveSuccessContainers(comparisonResult);
        setActiveTab('success');
        switchMainTab('results'); // 결과 탭으로 자동 전환

        // 작업 가용성 분석 데이터도 함께 사전 계산 (가용성 탭 전환 시 즉시 표시되도록)
        try {
            if (originalData && originalData.length > 0) {
                rawAvailabilityItems = originalData;
                processAvailabilityData(originalData);
                renderAvailabilityDashboard();
                renderAvailabilityTable();
            }
        } catch (availErr) {
            console.warn("작업 가용성 백그라운드 분석 중 경고:", availErr);
        }

        // 대시보드 및 결과 영역 표시
        dashboardContainer.style.display = 'flex';
        resultsContainer.style.display = 'block';

        setProcessStatus("모든 처리가 완료되었습니다!", 100, true);

        // [신규] 비교 완료 후 작업 세션 (4종 파일 & 결과 데이터) IndexedDB 영구 보관
        if (window.autoSaveWorkSession) window.autoSaveWorkSession();

        // 결과 영역으로 스크롤
        resultsContainer.scrollIntoView({ behavior: 'smooth' });

    } catch (err) {
        console.error("비교 중 오류:", err);
        alert(`비교 중 오류가 발생했습니다: ${err.message}\n\n스택:\n${err.stack}`);
        setProcessStatus("오류 발생", 0);
    }
});

// [사용자 요청] 필터링 조건(작업일 없는 컨테이너 제외)을 적용하여 대조를 재실행하는 함수
function reCompareFilteredData() {
    if (!originalData || originalData.length === 0 || !downloadData || downloadData.length === 0) return;

    let finalOrigList = [...originalData];
    let finalDownList = [...downloadData];
    let finalReworkList = typeof reworkData !== 'undefined' ? [...reworkData] : [];

    // 재작업 데이터가 있으면 원본 데이터에 합침
    if (finalReworkList.length > 0) {
        finalReworkList.forEach(item => { item.source = 'rework'; });
        // 중복 방지를 위해 source가 rework인 항목은 제외 후 합침
        finalOrigList = finalOrigList.filter(item => item.source !== 'rework');
        finalOrigList = [...finalOrigList, ...finalReworkList];
    }

    // [사용자 요청] 원본파일, 재작업대상 파일의 S열(작업일)값에 날짜가 없는 경우 작업대상에서 제외 처리
    excludedList = [];
    const excludedContainers = new Set();
    finalOrigList.forEach(item => {
        const cntr = (item.cntrNo || "").trim().toUpperCase();
        if (cntr && !item.workDate) {
            excludedContainers.add(cntr);
            excludedList.push({
                cntrNo: cntr,
                sheetName: item.sheetName || "-",
                rowNumber: item.rowNumber || "-",
                prodName: item.prodName || "-",
                qty: item.qty || 0,
                transporter: item.transporter || "미분류"
            });
        }
    });

    if (excludedContainers.size > 0) {
        // 원본 리스트에서 제외
        finalOrigList = finalOrigList.filter(item => {
            const cntr = (item.cntrNo || "").trim().toUpperCase();
            return !excludedContainers.has(cntr);
        });
        // 전산 리스트에서도 제외 (원본누락 등으로 노출되는 것을 방지)
        finalDownList = finalDownList.filter(item => {
            const cntr = (item.cntrNo || "").trim().toUpperCase();
            return !excludedContainers.has(cntr);
        });
    }

    comparisonResult = compareData(
        finalOrigList,
        finalDownList,
        productMaster,
        dynamicRules,
        customFields,
        carrierMap,
        normalizeCarrier
    );
    comparisonResult.forEach(r => {
        r.initialBadgeClass = r.badgeClass;
        r.origBadgeClass = r.badgeClass;
    });

    updateDashboard();
    displayResults(comparisonResult);
}
window.reCompareFilteredData = reCompareFilteredData;

// 비교 로직 메인
// Helper to categorize a container's rows (matches updateDashboard logic)
function getContainerStatus(results, cntrNo) {
    const rows = results.filter(r => r.cntrNo === cntrNo);
    if (rows.length === 0) return 'none';

    // [전산 누락 방지] 전산 파일에 데이터가 아예 없는 컨테이너는
    // 사용자가 승인했더라도 전산 데이터가 들어오기 전까지는 정상(success)으로 이동하지 않고 missing으로 유지
    const isPureMissing = rows.every(r => 
        (r.initialBadgeClass === 'missing' || r.origBadgeClass === 'missing' || r.badgeClass === 'missing') ||
        (r.destination && r.destination.val === '-' && r.carrierName && r.carrierName.val === '-')
    );

    if (isPureMissing) {
        return 'missing';
    }

    // 수동 승인 여부 확인 헬퍼 (r.isApproved 플래그 및 manualApprovedItems Set 동시 확인)
    const checkApproved = (r) => r.isApproved || manualApprovedItems.has(`${(r.cntrNo || "").trim()}_${(r.prodName || "").trim()}`);

    const allNew = rows.every(r => r.qtyInfo.origPlan === null && !checkApproved(r));
    const allMissing = rows.every(r => r.badgeClass === 'missing' && !checkApproved(r));
    const hasError = rows.some(r => (r.isErrorRow || r.badgeClass === 'diff') && !checkApproved(r));

    if (allNew) return 'extra';
    if (allMissing) return 'missing';
    if (hasError || rows.some(r => (r.badgeClass === 'extra' || r.badgeClass === 'missing') && !checkApproved(r))) return 'error';
    return 'success';
}

// Levenshtein Distance (문자열 편집 거리) 계산 함수
function getLevenshteinDistance(a, b) {
    if (a === b) return 0;
    const al = a.length;
    const bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;

    let v0 = new Array(bl + 1);
    let v1 = new Array(bl + 1);

    for (let i = 0; i <= bl; i++) v0[i] = i;

    for (let i = 0; i < al; i++) {
        v1[0] = i + 1;
        for (let j = 0; j < bl; j++) {
            const cost = a[i] === b[j] ? 0 : 1;
            v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
        }
        for (let j = 0; j <= bl; j++) v0[j] = v1[j];
    }

    return v1[bl];
}

// (동) 태그 헬퍼: 창고재고 업로드 시 + 제품구분이 'Q'인 경우에 한해 동일 접두어가 2개 이상 존재하는 제품이면 표시
function getDongTag(prodName, masterProdType) {
    if (!warehouseStockLoaded || warehouseStockDongPrefixes.size === 0) return '';
    const pt = (masterProdType || '').toUpperCase().trim();
    if (pt !== 'Q') return ''; // 제품구분이 Q일 때만 적용

    const nameUpper = (prodName || '').toUpperCase().trim();
    const dotIdx = nameUpper.lastIndexOf('.');
    if (dotIdx === -1) return '';
    const prefix = nameUpper.substring(0, dotIdx);
    if (warehouseStockDongPrefixes.has(prefix)) {
        let tooltipContent = '';
        if (warehouseAllStockList && warehouseAllStockList.length > 0) {
            const relatedItems = warehouseAllStockList.filter(item => {
                const isMatch = (item.modelName || '').trim().toUpperCase() !== nameUpper && 
                                (item.modelName || '').trim().toUpperCase().startsWith(prefix + '.');
                const qty = (item.goodQty !== undefined || item.pendingQty !== undefined)
                    ? ((item.goodQty || 0) + (item.pendingQty || 0))
                    : (item.physicalQty || 0);
                return isMatch && qty > 0;
            });
            
            if (relatedItems.length === 0) return ''; // 실제 재고 > 0인 관련 모델이 없으면 태그 미표시!

            const grouped = {};
            relatedItems.forEach(item => {
                const mName = (item.modelName || '').trim();
                if (!grouped[mName]) grouped[mName] = [];
                const qty = (item.goodQty !== undefined || item.pendingQty !== undefined)
                    ? ((item.goodQty || 0) + (item.pendingQty || 0))
                    : (item.physicalQty || 0);
                grouped[mName].push(`[${item.location || '로케이션 없음'}] ${qty.toLocaleString()} EA`);
            });
            
            const tooltipLines = [];
            for (const [mName, locs] of Object.entries(grouped)) {
                tooltipLines.push(`[${mName}]`);
                locs.forEach(loc => tooltipLines.push(`  - ${loc}`));
            }
            
            if (tooltipLines.length > 0) {
                tooltipContent = ` title="${tooltipLines.join('\n').replace(/"/g, '&quot;')}"`;
            }
        }
        return `<span${tooltipContent} class="badge-dong">동</span>`;
    }
    return '';
}

// [유] 태그 헬퍼: 제품구분이 'Q'인 경우에 한해, 스펠링이 1~2개 차이나는 유사모델이 창고 재고에 존재하면 표시
function getYuTag(prodName, masterProdType) {
    const pt = (masterProdType || '').toUpperCase().trim();
    if (pt !== 'Q') return ''; // 제품구분이 Q일 때만 적용

    const nameUpper = (prodName || '').toUpperCase().trim();
    if (!nameUpper || nameUpper === 'NONASSET.ITEM') return '';

    const targetPrefix = nameUpper.includes('.') ? nameUpper.substring(0, nameUpper.lastIndexOf('.')) : nameUpper;
    if (targetPrefix.length < 3) return '';

    // 비교 대상 후보군 수집: 현재 창고에 실제 실물/가용 재고(재고 > 0)가 존재하는 모델만 수집!
    const candidates = new Set();
    if (warehouseStockLoaded && warehouseStockQtyMap) {
        Object.entries(warehouseStockQtyMap).forEach(([mName, sInfo]) => {
            const hasStock = (sInfo.physical || 0) > 0 || (sInfo.good || 0) > 0 || (sInfo.available || 0) > 0 || (sInfo.pending || 0) > 0;
            if (hasStock) {
                candidates.add(mName.toUpperCase().trim());
            }
        });
    }
    if (warehouseAllStockList && Array.isArray(warehouseAllStockList)) {
        warehouseAllStockList.forEach(item => {
            const qty = (item.goodQty !== undefined || item.pendingQty !== undefined)
                ? ((item.goodQty || 0) + (item.pendingQty || 0))
                : (item.physicalQty || 0);
            if (qty > 0 && item.modelName) {
                candidates.add(item.modelName.toUpperCase().trim());
            }
        });
    }

    const similarModels = [];
    // 점 앞 접두어 길이에 따라 허용 차이 동적 결정: 7글자 이하 -> 1글자만 / 8글자 이상 -> 최대 2글자까지
    const maxAllowedDiff = (targetPrefix.length <= 7) ? 1 : 2;

    candidates.forEach(cand => {
        if (cand === nameUpper) return; // 자기 자신 제외

        const candPrefix = cand.includes('.') ? cand.substring(0, cand.lastIndexOf('.')) : cand;
        if (candPrefix === targetPrefix) return; // 동일 접두어는 (동) 태그에서 처리되므로 제외

        // 서피스넘버(점 뒤 단어)를 제외하고 접두어만 순수 비교
        const prefixDist = getLevenshteinDistance(targetPrefix, candPrefix);
        if (prefixDist >= 1 && prefixDist <= maxAllowedDiff) {
            similarModels.push({
                modelName: cand,
                diff: prefixDist
            });
        }
    });

    if (similarModels.length > 0) {
        // 차이 적은 순, 모델명 순 정렬
        similarModels.sort((a, b) => a.diff - b.diff || a.modelName.localeCompare(b.modelName));

        const tooltipLines = [
            `[유사모델 주의 (스펠링 1~2개 차이)]`
        ];
        similarModels.slice(0, 8).forEach(item => {
            tooltipLines.push(`• ${item.modelName} (${item.diff}글자 차이)`);
        });
        if (similarModels.length > 8) {
            tooltipLines.push(`• 외 ${similarModels.length - 8}개 유사 모델 존재`);
        }

        return `<span class="badge-yu" title="${tooltipLines.join('\n').replace(/"/g, '&quot;')}">유</span>`;
    }

    return '';
}

// [H/L/B] 배지 헬퍼: 창고재고 블록 타입에 따른 H(OQC), L(Long term), B(Bin) 태그 표시
function getBlockHoldTag(prodName) {
    if (!warehouseStockLoaded || !warehouseStockQtyMap) return '';
    const nameUpper = (prodName || '').toUpperCase().trim();
    const stockInfo = warehouseStockQtyMap[nameUpper];
    if (!stockInfo) return '';

    const available = stockInfo.available || 0;
    const totalNeeded = window.totalProductRemainMap ? (window.totalProductRemainMap[nameUpper] || 0) : 0;
    const physical = stockInfo.physical || 0;

    let statusText = '';
    if (totalNeeded > available) {
        statusText = `재고부족 (-${totalNeeded - available} EA)`;
    } else {
        statusText = `작업가능 (여유: ${available - totalNeeded} EA)`;
    }

    // 로케이션별 홀드/롱텀/Bin 블럭 수량 상세 구성
    const locDetails = [];
    if (Array.isArray(warehouseHoldStockList) && warehouseHoldStockList.length > 0) {
        const matches = warehouseHoldStockList.filter(item => item.modelName === nameUpper);
        matches.forEach(item => {
            const parts = [];
            if (item.oqcHold > 0) parts.push(`홀드: ${item.oqcHold} EA`);
            if (item.longTermHold > 0) parts.push(`롱텀: ${item.longTermHold} EA`);
            if (item.binBlock > 0) parts.push(`bin블럭: ${item.binBlock} EA`);
            if (parts.length > 0) {
                locDetails.push(`  - [${item.location || '로케이션 없음'}] ${parts.join(', ')}`);
            }
        });
    }

    const tooltipLines = [
        `[재고 분석 상세]`,
        `• 전체재고수량: ${physical} EA`,
        `• 작업가능 수량: ${available} EA`,
        `• 합산 필요 수량: ${totalNeeded} EA`,
        `• 상태: ${statusText}`
    ];

    if (locDetails.length > 0) {
        tooltipLines.push(``);
        tooltipLines.push(`• 로케이션별 블록 상세:`);
        tooltipLines.push(...locDetails);
    }

    const tooltipText = tooltipLines.join('\n').replace(/"/g, '&quot;');

    let tags = [];
    if (stockInfo.oqc > 0) {
        tags.push(`<span title="${tooltipText}" style="display:inline-block; margin-left:4px; font-size:0.72rem; color:#fff; background:#ef4444; border-radius:4px; padding:1px 5px; font-weight:700; vertical-align:middle; line-height:1.4; letter-spacing:0.03em; cursor:help;">H</span>`);
    }
    if (stockInfo.longTerm > 0) {
        tags.push(`<span title="${tooltipText}" style="display:inline-block; margin-left:4px; font-size:0.72rem; color:#fff; background:#8b5cf6; border-radius:4px; padding:1px 5px; font-weight:700; vertical-align:middle; line-height:1.4; letter-spacing:0.03em; cursor:help;">L</span>`);
    }
    if (stockInfo.bin > 0) {
        tags.push(`<span title="${tooltipText}" style="display:inline-block; margin-left:4px; font-size:0.72rem; color:#fff; background:#e11d48; border-radius:4px; padding:1px 5px; font-weight:700; vertical-align:middle; line-height:1.4; letter-spacing:0.03em; cursor:help;">B</span>`);
    }
    return tags.join('');
}

// 재고부족 배지 헬퍼: 전체 합산 필요 수량과 사용 가능 재고를 대조하여 부족분을 표시 (해당 행의 필요 수량이 0인 완료 건은 미노출)
function getStockShortageBadge(prodName, rowRemain) {
    if (!warehouseStockLoaded || !warehouseStockQtyMap) return '';
    const nameUpper = (prodName || '').toUpperCase().trim();
    const stockInfo = warehouseStockQtyMap[nameUpper];
    if (!stockInfo) return '';
    
    const available = stockInfo.available;
    const totalNeeded = window.totalProductRemainMap ? (window.totalProductRemainMap[nameUpper] || 0) : 0;
    const thisRowRemain = Number(rowRemain) || 0;

    // 본인 행의 잔여 필요 수량이 0 이하이면 표시 안 함 (적재 완료 건 제외)
    if (thisRowRemain <= 0) return '';

    // 합산 필요 수량이 창고의 사용 가능 재고보다 큰 경우에만 재고 부족 표시
    if (totalNeeded > available) {
        const shortage = totalNeeded - available;
        return `
            <div class="stock-shortage-badge" title="[재고 분석 상세]\n• 전체 실물재고: ${stockInfo.physical} EA\n• OQC Hold: ${stockInfo.oqc || 0} EA\n• Long Term Hold: ${stockInfo.longTerm || 0} EA\n• Bin Block: ${stockInfo.bin || 0} EA\n• 작업가능 재고: ${available} EA\n• 합산 필요 수량: ${totalNeeded} EA">
                <i class="fas fa-exclamation-triangle"></i> 재고부족 (-${shortage} EA)
            </div>
        `;
    }
    return '';
}

function displayResults(results, isDbMode = false) {
    if (typeof window.fetchContainerPhotoCounts === 'function') {
        window.fetchContainerPhotoCounts();
    }

    // [사용자 요청] 전체 컨테이너에 대해 동일 제품별 잔여 필요수량(remain)을 합산하여 맵핑
    window.totalProductRemainMap = {};
    if (window.comparisonResult && window.comparisonResult.length > 0) {
        window.comparisonResult.forEach(r => {
            if (!r.prodName) return;
            const nameUpper = r.prodName.toUpperCase().trim();
            const remain = Number(r.qtyInfo ? r.qtyInfo.remain : 0) || 0;
            window.totalProductRemainMap[nameUpper] = (window.totalProductRemainMap[nameUpper] || 0) + remain;
        });
    }

    const renderMismatch = (orig, down, isMismatch) => {
        if (!isMismatch || !orig) return `<span>${down}</span>`;
        return `
            <div class="mismatch-box">
                <span class="mismatch-orig">${orig}</span>
                <span class="mismatch-arrow">↓</span>
                <span class="mismatch-down">${down}</span>
            </div>
        `;
    };

    const renderQtyMismatch = (qty) => {
        if (!qty.isMismatch || qty.origPlan === null) {
            return `${qty.plan} / ${qty.load} / ${qty.pending} / ${qty.remain} / <span style="font-weight: bold; color: #3b82f6;">${qty.packing}</span>`;
        }
        const diff = Math.abs((qty.origPlan || 0) - (qty.plan || 0));
        return `
            <div class="mismatch-box">
                <div style="font-size: 0.85rem; margin-bottom: 3px; line-height: 1.4;">
                    <span style="color: #64748b;">원본 ${qty.origPlan}개, </span>
                    <span style="color: #64748b;">전산 ${qty.plan}개</span>
                    <br>
                    <span style="color: #ef4444; font-weight: bold;">(${diff}개 다름)</span>
                </div>
                <div style="color: #64748b; font-size: 0.8rem;">${qty.load} / ${qty.pending} / ${qty.remain} / <span style="font-weight: bold; color: #3b82f6;">${qty.packing}</span></div>
            </div>
        `;
    };

    // 테이블 클래스 초기화 및 부여 (UI 깨짐 방지)
    const resultTable = document.getElementById('resultTable');
    if (resultTable) {
        resultTable.classList.remove('general-table', 'entry-table');
        if (currentFilter === 'entry' || currentFilter === 'entry_unclassified') {
            resultTable.classList.add('entry-table');
        } else {
            resultTable.classList.add('general-table');
        }
    }

    const rb = getResultBody();
    if (!rb) {
        console.error("❌ 'resultBody' 요소를 찾을 수 없습니다.");
        alert("'resultBody' UI 요소를 찾을 수 없어 결과를 표시할 수 없습니다.");
        return;
    }
    rb.innerHTML = '';

    // dbMode일 때는 자체적으로 필터링된 배열이 넘어오므로 프론트 검색/탭 필터를 무시
    if (isDbMode) {
        displayData = results;
    } else {
        // --- 수동 승인 데이터 반영 ---
        results.forEach(r => {
            const approvalKey = `${(r.cntrNo || "").trim()}_${(r.prodName || "").trim()}`;
            if (!r.initialBadgeClass) {
                r.initialBadgeClass = r.badgeClass; // 수동 승인 전 원본 배지 정보 영구 보존
            }
            r.origBadgeClass = r.initialBadgeClass;

            if (manualApprovedItems.has(approvalKey)) {
                let calculatedType = '대기';
                if (r.qtyInfo) {
                    const load = r.qtyInfo.load || 0;
                    const plan = r.qtyInfo.plan || 0;
                    if (load === 0) {
                        if (r.prodName === 'NONASSET.ITEM') {
                            calculatedType = '완료';
                        } else {
                            calculatedType = '대기';
                        }
                    } else if (load >= plan) {
                        calculatedType = '완료';
                    } else {
                        calculatedType = '작업중';
                    }
                }
                r.type = `승인(${calculatedType})`;
                r.badgeClass = 'approved';
                r.cssClass = 'row-success-manual';
                r.isErrorRow = false;
                r.isApproved = true;
                // 기존 상세 정보 보관 (필요 시)
                const originalDetail = r.detail || "";
                r.detail = `<span style="color: #7c3aed; font-weight: bold;">[사용자 수동 정상전환]</span> ${originalDetail ? `(${originalDetail})` : ''}`;
            } else {
                r.badgeClass = r.initialBadgeClass;
                r.isApproved = false;
            }
        });

        // [통합] 미분류 컨테이너 목록 (누락/추가건 포함) - 탭 분류 및 요약 집계에서 공통 사용
        const unclassifiedCntrNos = new Set(
            results.filter(r => (r.origBadgeClass === 'missing' || r.origBadgeClass === 'extra')).map(r => r.cntrNo)
        );

        // --- 보류 정보 동기화 및 요약 ---
        const heldCntrs = new Set();
        results.forEach(r => {
            const ck = (r.cntrNo || "").trim().toUpperCase();
            if (holdContainerMap.has(ck)) {
                r.isHeld = true;
                heldCntrs.add(ck);
            } else {
                r.isHeld = false;
            }
        });
        const holdCountEl = document.getElementById('holdCount');
        if (holdCountEl) holdCountEl.textContent = heldCntrs.size;

        // 탭 필터링 시 컨테이너 상태를 판단하기 위해, 검색 필터 전의 전체 승인/보류 반영 리스트를 보관
        const fullResultsForStatus = [...results];

        // --- 검색 필터링 추가 (컨테이너 번호, 제품명, 제품구분) ---
        const searchInput = document.getElementById('inputSearch');
        const prodSearchInput = document.getElementById('inputProdSearch');
        const prodTypeSelect = document.getElementById('selectProdType');

        const searchTerm = (searchInput ? searchInput.value : "").trim().toUpperCase();
        const prodSearchTerm = (prodSearchInput ? prodSearchInput.value : "").trim().toUpperCase();
        const prodTypeFilter = (prodTypeSelect ? prodTypeSelect.value : "").trim().toUpperCase();

        if (searchTerm || prodSearchTerm || prodTypeFilter) {
            results = results.filter(r => {
                const cntr = (r.cntrNo || "").toUpperCase();
                const prod = (r.prodName || "").toUpperCase();
                const type = (r.prodType || "").trim().toUpperCase();

                let match = true;
                if (searchTerm && !cntr.includes(searchTerm)) match = false;
                if (prodSearchTerm && !prod.includes(prodSearchTerm)) match = false;
                if (prodTypeFilter && type !== prodTypeFilter) match = false;

                return match;
            });
        }

        // --- 탭 필터링 로직 ---
        if (currentFilter === 'hold') {
            displayData = results.filter(r => r.isHeld);
        } else {
            // 보류 탭이 아닌 경우 보류 건은 무조건 제외
            results = results.filter(r => !r.isHeld);

            if (currentFilter === 'all') {
                // Exclude completely missing containers from the All view, UNLESS they have rework data
                const missingCntrs = new Set(results.filter(r => {
                    if (r.source === 'rework') return false; // Never hide rework containers
                    return getContainerStatus(fullResultsForStatus, r.cntrNo) === 'missing';
                }).map(r => r.cntrNo));
                displayData = results.filter(r => !missingCntrs.has(r.cntrNo));
            } else if (currentFilter === 'error') {
                displayData = results.filter(r => getContainerStatus(fullResultsForStatus, r.cntrNo) === 'error');
            } else if (currentFilter === 'success') {
                const successRows = results.filter(r => getContainerStatus(fullResultsForStatus, r.cntrNo) === 'success');

                // 1. 컨테이너 번호별 분류 및 카운트
                const successContainers = {};
                successRows.forEach(r => {
                    if (!successContainers[r.cntrNo]) {
                        successContainers[r.cntrNo] = [];
                    }
                    successContainers[r.cntrNo].push(r);
                });

                let completedCount = 0;
                let progressCount = 0;
                let pendingCount = 0;
                let chunmaCount = 0;
                let bniCount = 0;
                let otherCount = 0;
                let hasPhotoCount = 0;

                const containerStatusMap = {};
                const containerTransMap = {};
                const containerHasPhotoMap = {};

                for (const cntrNo in successContainers) {
                    const rows = successContainers[cntrNo];
                    
                    // 상태 판별
                    const allCompleted = rows.every(r => (r.type || '').includes('완료'));
                    const allPending = rows.every(r => (r.type || '').includes('대기'));

                    let status = 'progress';
                    if (allCompleted) {
                        status = 'completed';
                        completedCount++;
                    } else if (allPending) {
                        status = 'pending';
                        pendingCount++;
                    } else {
                        status = 'progress';
                        progressCount++;
                    }
                    containerStatusMap[cntrNo] = status;

                    // 운송사 판별
                    const isChunma = rows.some(r => (r.transporter || '').includes('천마'));
                    const isBni = rows.some(r => (r.transporter || '').includes('BNI'));
                    let trans = 'other';
                    if (isChunma) {
                        trans = 'chunma';
                        chunmaCount++;
                    } else if (isBni) {
                        trans = 'bni';
                        bniCount++;
                    } else {
                        trans = 'other';
                        otherCount++;
                    }
                    containerTransMap[cntrNo] = trans;

                    // 사진 등록 여부 판별
                    const cleanNo = cntrNo.trim().toUpperCase();
                    const pInfo = window.containerPhotoCounts ? window.containerPhotoCounts[cleanNo] : null;
                    const hasPhoto = pInfo ? ((typeof pInfo === 'number' && pInfo > 0) || (typeof pInfo === 'object' && (pInfo.total || 0) > 0)) : false;
                    containerHasPhotoMap[cntrNo] = hasPhoto;
                    if (hasPhoto) {
                        hasPhotoCount++;
                    }
                }

                // UI 카운터 업데이트
                const elCompleted = document.getElementById('cntCompleted');
                const elProgress = document.getElementById('cntProgress');
                const elPending = document.getElementById('cntPending');
                const elChunma = document.getElementById('cntChunma');
                const elBni = document.getElementById('cntBni');
                const elOtherTrans = document.getElementById('cntOtherTrans');
                const elHasPhoto = document.getElementById('cntHasPhoto');

                if (elCompleted) elCompleted.textContent = completedCount;
                if (elProgress) elProgress.textContent = progressCount;
                if (elPending) elPending.textContent = pendingCount;
                if (elChunma) elChunma.textContent = chunmaCount;
                if (elBni) elBni.textContent = bniCount;
                if (elOtherTrans) elOtherTrans.textContent = otherCount;
                if (elHasPhoto) elHasPhoto.textContent = hasPhotoCount;

                // 2. 체크박스 필터링 적용
                const chkFilterCompleted = document.getElementById('chkFilterCompleted');
                const chkFilterProgress = document.getElementById('chkFilterProgress');
                const chkFilterPending = document.getElementById('chkFilterPending');
                const chkFilterChunma = document.getElementById('chkFilterChunma');
                const chkFilterBni = document.getElementById('chkFilterBni');
                const chkFilterOtherTrans = document.getElementById('chkFilterOtherTrans');
                const chkFilterHasPhoto = document.getElementById('chkFilterHasPhoto');

                const showCompleted = chkFilterCompleted ? chkFilterCompleted.checked : false;
                const showProgress = chkFilterProgress ? chkFilterProgress.checked : false;
                const showPending = chkFilterPending ? chkFilterPending.checked : false;
                const showChunma = chkFilterChunma ? chkFilterChunma.checked : false;
                const showBni = chkFilterBni ? chkFilterBni.checked : false;
                const showOther = chkFilterOtherTrans ? chkFilterOtherTrans.checked : false;
                const showHasPhoto = chkFilterHasPhoto ? chkFilterHasPhoto.checked : false;

                const anyStatusChecked = showCompleted || showProgress || showPending;
                const anyTransChecked = showChunma || showBni || showOther;

                displayData = successRows.filter(r => {
                    // 사진 필터 체크
                    if (showHasPhoto && !containerHasPhotoMap[r.cntrNo]) {
                        return false;
                    }

                    // 상태 필터 체크
                    let passStatus = true;
                    if (anyStatusChecked) {
                        const status = containerStatusMap[r.cntrNo];
                        if (status === 'completed') passStatus = showCompleted;
                        else if (status === 'progress') passStatus = showProgress;
                        else if (status === 'pending') passStatus = showPending;
                    }

                    if (!passStatus) return false;

                    // 운송사 필터 체크
                    let passTrans = true;
                    if (anyTransChecked) {
                        const trans = containerTransMap[r.cntrNo];
                        if (trans === 'chunma') passTrans = showChunma;
                        else if (trans === 'bni') passTrans = showBni;
                        else if (trans === 'other') passTrans = showOther;
                    }
                    return passTrans;
                });
            } else if (currentFilter === 'missing') {
                const chkFilterMissingExtra = document.getElementById('chkFilterMissingExtra');
                const chkFilterMissingMissing = document.getElementById('chkFilterMissingMissing');
                const showMissingExtra = chkFilterMissingExtra ? chkFilterMissingExtra.checked : true;
                const showMissingMissing = chkFilterMissingMissing ? chkFilterMissingMissing.checked : true;

                displayData = results.filter(r => {
                    const status = getContainerStatus(fullResultsForStatus, r.cntrNo);
                    if (status === 'extra') return showMissingExtra;
                    if (status === 'missing') return showMissingMissing;
                    return false;
                });
                displayData.sort((a, b) => {
                    const statusA = getContainerStatus(results, a.cntrNo);
                    const statusB = getContainerStatus(results, b.cntrNo);
                    if (statusA === 'missing' && statusB !== 'missing') return -1;
                    if (statusA !== 'missing' && statusB === 'missing') return 1;
                    return a.cntrNo.localeCompare(b.cntrNo);
                });
            } else if (currentFilter === 'entry' || currentFilter === 'entry_unclassified') {
                const aggregated = new Map();
                let totalWeight = 0;

                results.forEach(item => {
                    const cleanTrans = (item.transporter || "").replace(/\(빨강\)|\(파랑\)/g, "").trim();

                    // 미분류 반입 탭 대상: 실제 운송사가 미분류이거나, 혹은 컨테이너 내부에 누락/추가건이 있는 경우
                    const isUnclassifiedTab = (cleanTrans === "미분류") || unclassifiedCntrNos.has(item.cntrNo);
                    const isTargetTab = (currentFilter === 'entry') ? !isUnclassifiedTab : isUnclassifiedTab;

                    if (!isTargetTab) return;
                    // 전산 누락 컨테이너/모델도 합산 및 원인 분석을 위해 포함
                    // (기존에는 여기서 return; 하여 원인 분석이 안 되었음)

                    const key = `${item.cntrNo}_${item.transporter}`;

                    if (!aggregated.has(key)) {
                        const newItem = JSON.parse(JSON.stringify(item));
                        newItem.transporter = cleanTrans;
                        newItem.qtyDiffs = [];
                        newItem.allProdNames = new Set([item.prodName]);
                        newItem.mismatchReasons = new Set();
                        newItem.mismatchDetails = {
                            missingInDown: [], // 원본(O)에만 있고 전산(D)엔 없는 모델
                            missingInOrig: [], // 전산(D)에만 있고 원본(O)엔 없는 모델
                            qtyDiffs: [],      // 수량 다른 모델
                            weightDiffs: [],   // 개별중량 기준 다른 모델
                            cbmDiffs: [],      // 개별 CBM 기준 다른 모델
                            noWeightInfo: []   // DB 중량 정보 없는 모델
                        };

                        if (item.badgeClass === 'missing') newItem.mismatchDetails.missingInDown.push({ name: item.prodName, qty: (item.qtyInfo ? item.qtyInfo.origPlan : '-') });
                        else if (item.badgeClass === 'extra') newItem.mismatchDetails.missingInOrig.push({ name: item.prodName, qty: (item.qtyInfo ? item.qtyInfo.plan : '-') });
                        else if (item.badgeClass === 'noproduct') newItem.mismatchDetails.noWeightInfo.push({ name: item.prodName });
                        else if (item.badgeClass === 'update') {
                            if (item.currentUnitWeight !== undefined) {
                                newItem.mismatchDetails.weightDiffs.push({ name: item.prodName, db: item.unitWeight, current: item.currentUnitWeight });
                            }
                            if (item.isCbmMismatch) {
                                newItem.mismatchDetails.cbmDiffs.push({ name: item.prodName, db: item.unitCBM, current: item.currentUnitCBM });
                            }
                        }

                        if (item.qtyInfo && item.qtyInfo.origPlan !== null && item.qtyInfo.plan !== null && item.qtyInfo.origPlan !== item.qtyInfo.plan) {
                            newItem.mismatchDetails.qtyDiffs.push({ name: item.prodName, orig: item.qtyInfo.origPlan, down: item.qtyInfo.plan });
                        }

                        newItem._totalMixed = parseFloat(item.weights.mixed) || 0;
                        newItem._totalOrig = parseFloat(item.weights.orig) || 0;
                        newItem._totalDown = parseFloat(item.weights.down) || 0;
                        newItem._totalCBM = parseFloat(item.totalCBM) || 0;
                        aggregated.set(key, newItem);
                    } else {
                        const existing = aggregated.get(key);
                        existing.allProdNames.add(item.prodName);

                        if (item.badgeClass === 'missing') existing.mismatchDetails.missingInDown.push({ name: item.prodName, qty: (item.qtyInfo ? item.qtyInfo.origPlan : '-') });
                        else if (item.badgeClass === 'extra') existing.mismatchDetails.missingInOrig.push({ name: item.prodName, qty: (item.qtyInfo ? item.qtyInfo.plan : '-') });
                        else if (item.badgeClass === 'noproduct') existing.mismatchDetails.noWeightInfo.push({ name: item.prodName });
                        else if (item.badgeClass === 'update') {
                            if (item.currentUnitWeight !== undefined) {
                                existing.mismatchDetails.weightDiffs.push({ name: item.prodName, db: item.unitWeight, current: item.currentUnitWeight });
                            }
                            if (item.isCbmMismatch) {
                                existing.mismatchDetails.cbmDiffs.push({ name: item.prodName, db: item.unitCBM, current: item.currentUnitCBM });
                            }
                        }

                        if (item.qtyInfo && item.qtyInfo.origPlan !== null && item.qtyInfo.plan !== null && item.qtyInfo.origPlan !== item.qtyInfo.plan) {
                            existing.mismatchDetails.qtyDiffs.push({ name: item.prodName, orig: item.qtyInfo.origPlan, down: item.qtyInfo.plan });
                        }

                        existing._totalMixed += (parseFloat(item.weights.mixed) || 0);
                        existing._totalOrig += (parseFloat(item.weights.orig) || 0);
                        existing._totalDown += (parseFloat(item.weights.down) || 0);
                        existing._totalCBM += (parseFloat(item.totalCBM) || 0);

                        // 하나라도 오류가 있으면 전체를 오류로 처리
                        if (item.isErrorRow) existing.isErrorRow = true;
                        if (item.badgeClass === 'missing') existing.hasMissingModel = true;

                        if (item.tags && item.tags.length > 0) {
                            if (!existing.tags) existing.tags = [];
                            item.tags.forEach(tag => {
                                if (!existing.tags.some(t => t.text === tag.text)) existing.tags.push(tag);
                            });
                        }
                    }
                });

                // Second pass to finalize values and calculate totalWeight
                displayData = Array.from(aggregated.values()).map(item => {
                    const choice = userSelectedWeights[item.cntrNo];
                    if (choice === 'orig') {
                        item.selectedTotalWeight = item._totalOrig;
                    } else if (choice === 'down') {
                        item.selectedTotalWeight = item._totalDown;
                    } else {
                        item.selectedTotalWeight = item._totalMixed;
                    }

                    // Finalize strings for display
                    item.weights.mixed = item._totalMixed.toFixed(2);
                    item.weights.orig = item._totalOrig.toFixed(2);
                    item.weights.down = item._totalDown.toFixed(2);
                    item.totalCBM = item._totalCBM.toFixed(2);

                    // Determine if a critical weight mismatch exists
                    item.isCriticalWeightMismatch = Math.abs(item._totalMixed - item._totalOrig) >= 1 && !userSelectedWeights[item.cntrNo];

                    // 요약 집계 시 오류건(붉은색 건)은 배제 (단, 수동 승인된 건은 포함)
                    const isApproved = item.isApproved || (manualApprovedItems && manualApprovedItems.has(`${(item.cntrNo || "").trim()}_${(item.prodName || "").trim()}`));
                    const isError = (item.isErrorRow || item.hasMissingModel || item.badgeClass === 'missing' || item.isCriticalWeightMismatch) && !isApproved;

                    if (!isError) {
                        totalWeight += item.selectedTotalWeight;
                    }

                    return item;
                });

                // --- 요약 집계 (화면 중앙 상단 요약 바와 일치시키기 위해 검색 필터와 무관하게 전체 집계) ---
                const totalCountsForSummary = {};
                let summaryTotalWeight = 0;

                // 검색 필터 전의 전체 리스트(fullResultsForStatus)를 사용하여 집계
                const aggregatedFull = new Map();
                fullResultsForStatus.forEach(item => {
                    const cleanTrans = (item.transporter || "").replace(/\(빨강\)|\(파랑\)/g, "").trim();
                    const isUnclassified = (cleanTrans === "미분류") || (unclassifiedCntrNos && unclassifiedCntrNos.has(item.cntrNo));
                    const isTargetTrans = (currentFilter === 'entry') ? !isUnclassified : isUnclassified;
                    if (!isTargetTrans) return;

                    const key = `${item.cntrNo}_${item.transporter}`;
                    if (!aggregatedFull.has(key)) {
                        const newItem = JSON.parse(JSON.stringify(item));
                        newItem._totalMixed = parseFloat(item.weights.mixed) || 0;
                        newItem._totalOrig = parseFloat(item.weights.orig) || 0;
                        newItem._totalDown = parseFloat(item.weights.down) || 0;
                        newItem.allProdNames = new Set([item.prodName]);
                        aggregatedFull.set(key, newItem);
                    } else {
                        const existing = aggregatedFull.get(key);
                        existing.allProdNames.add(item.prodName);
                        existing._totalMixed += (parseFloat(item.weights.mixed) || 0);
                        existing._totalOrig += (parseFloat(item.weights.orig) || 0);
                        existing._totalDown += (parseFloat(item.weights.down) || 0);

                        // 하위 행 중 하나라도 오류가 있으면 전체를 오류로 표시
                        if (item.isErrorRow) existing.isErrorRow = true;
                        if (item.badgeClass === 'missing') existing.hasMissingModel = true;
                    }
                });

                aggregatedFull.forEach(item => {
                    // 중량 차이 계산 (임계치 1kg)
                    const isManualWeight = userSelectedWeights[item.cntrNo];
                    const weightDiff = Math.abs(item._totalMixed - item._totalOrig);
                    item.isCriticalWeightMismatch = weightDiff >= 1 && !isManualWeight;

                    const isApproved = item.isApproved || (manualApprovedItems && manualApprovedItems.has(`${(item.cntrNo || "").trim()}_${(item.prodName || "").trim()}`));
                    const isError = (item.isErrorRow || item.hasMissingModel || item.badgeClass === 'missing' || item.isCriticalWeightMismatch) && !isApproved;

                    const t = item.transporter;
                    if (t) {
                        if (!totalCountsForSummary[t]) totalCountsForSummary[t] = { total: 0, success: 0, error: 0 };
                        totalCountsForSummary[t].total++;
                        if (isError) totalCountsForSummary[t].error++;
                        else {
                            totalCountsForSummary[t].success++;
                            // 중량 합산
                            const choice = userSelectedWeights[item.cntrNo];
                            let w = 0;
                            if (choice === 'orig') w = item._totalOrig || parseFloat(item.weights.orig) || 0;
                            else if (choice === 'down') w = item._totalDown || parseFloat(item.weights.down) || 0;
                            else w = item._totalMixed || parseFloat(item.weights.mixed) || 0;
                            summaryTotalWeight += w;
                        }
                    }
                });

                const summaryContent = Object.entries(totalCountsForSummary)
                    .sort((a, b) => {
                        if (a[0] === '미분류') return 1;
                        if (b[0] === '미분류') return -1;
                        return a[0].localeCompare(b[0]);
                    })
                    .map(([name, counts]) => {
                        if (counts.error > 0) {
                            return `${name} ${counts.total}개 (${counts.success}정상 / <span style="color: #ef4444; font-weight: bold;">${counts.error}오류</span>)`;
                        }
                        return `${name} ${counts.total}개`;
                    })
                    .join(' / ');

                const entrySummaryContent = document.getElementById('entrySummaryContent');
                if (entrySummaryContent) {
                    entrySummaryContent.innerHTML = summaryContent || "결과 없음";
                }
                const entryTotalWeight = document.getElementById('entryTotalWeight');
                if (entryTotalWeight) {
                    entryTotalWeight.textContent = summaryTotalWeight.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                }
                const entrySummary = document.getElementById('entrySummary');
                if (entrySummary) entrySummary.style.display = 'flex';

                displayData.sort((a, b) => {
                    const transA = (a.transporter || "");
                    const transB = (b.transporter || "");
                    if (transA !== transB) return transA.localeCompare(transB);

                    if (a.isCriticalWeightMismatch && !b.isCriticalWeightMismatch) return -1;
                    if (!a.isCriticalWeightMismatch && b.isCriticalWeightMismatch) return 1;
                    return 0;
                });
            }
        }
    }


    // 'entry' 또는 'entry_unclassified' 탭이 아닌 경우 entrySummary를 숨김
    if (currentFilter !== 'entry' && currentFilter !== 'entry_unclassified') {
        const entrySummary = document.getElementById('entrySummary');
        if (entrySummary) entrySummary.style.display = 'none';
    }

    // --- 검색 UI 갱신 (초기화 버튼 색상 및 검색 건수) ---
    refreshSearchUI();

    // 헤더 업데이트 함수 호출
    updateTableHeaders(currentFilter);

    let prevCntr = null;
    let prevDetailRaw = null;
    let prevDetailCntr = null;
    let prevTrans = null;

    const CHUNK_SIZE = 100;
    let currentIndex = 0;

    function renderChunk() {
        const fragment = document.createDocumentFragment();
        const end = Math.min(currentIndex + CHUNK_SIZE, displayData.length);

        for (let i = currentIndex; i < end; i++) {
            const res = displayData[i];
            const tr = document.createElement('tr');
            const itemKey = `${res.cntrNo}_${res.prodName}_${i}`;

            const nameUpperForCaution = (res.prodName || '').toUpperCase().trim();
            const matchedCaution = cautionModels.find(item => nameUpperForCaution.includes((item.modelName || '').toUpperCase().trim()));
            const isCaution = !!matchedCaution;

            let rowClasses = [];
            if (res.cssClass) rowClasses.push(res.cssClass);
            if (prevCntr !== null && prevCntr !== res.cntrNo) rowClasses.push('border-group');
            if (selectedItems.has(itemKey)) rowClasses.push('selected-row');
            if (res.isHeld) rowClasses.push('row-held');

            prevCntr = res.cntrNo;
            tr.className = rowClasses.join(' ');

            let cntrColor = 'inherit';
            if (res.transporter === '천마(빨강)') cntrColor = '#e74c3c';
            else if (res.transporter === 'BNI(파랑)') cntrColor = '#3498db';

            let detailHtml = res.detail || '';
            if (detailHtml) detailHtml = detailHtml.replace(/\[자동분류\] /g, '');

            let isSameAsAbove = false;
            if (res.cntrNo === prevDetailCntr && detailHtml === prevDetailRaw && detailHtml !== '') {
                isSameAsAbove = true;
            } else {
                prevDetailCntr = res.cntrNo;
                prevDetailRaw = detailHtml;
            }

            if (detailHtml.includes('리마크 불일치')) detailHtml = detailHtml.replace('리마크 불일치', '<span style="color: #f59e0b; font-weight: bold;">리마크 불일치</span>');
            if (detailHtml.includes('목적지 불일치')) detailHtml = detailHtml.replace('목적지 불일치', '<span style="color: #f59e0b; font-weight: bold;">목적지 불일치</span>');
            if (detailHtml.includes('선사 불일치')) detailHtml = detailHtml.replace('선사 불일치', '<span style="color: #f59e0b; font-weight: bold;">선사 불일치</span>');
            if (detailHtml.includes('컨테이너 불일치')) detailHtml = detailHtml.replace('컨테이너 불일치', '<span style="color: #f59e0b; font-weight: bold;">컨테이너 불일치</span>');
            if (detailHtml.includes('중량 불일치')) detailHtml = detailHtml.replace('중량 불일치', '<span style="color: #ef4444; font-weight: bold;">중량 불일치</span>');

            let finalDetailHtml = '';
            if (isSameAsAbove) {
                finalDetailHtml = `<div class="detail-text" style="color: #94a3b8; font-style: italic; font-size: 0.8rem; letter-spacing: -0.3px;">↪ 위와 동일</div>`;
            } else {
                const isLongDetail = detailHtml.length > 50 || detailHtml.split(' | ').length > 2;
                if (isLongDetail) {
                    finalDetailHtml = `
                        <div class="detail-container">
                            <div class="detail-text truncated">${detailHtml}</div>
                            <button class="btn-detail-toggle" onclick="this.previousElementSibling.classList.toggle('truncated'); this.textContent = this.previousElementSibling.classList.contains('truncated') ? '더보기' : '접기'; event.stopPropagation();">더보기</button>
                        </div>
                    `;
                } else {
                    finalDetailHtml = `<div class="detail-text">${detailHtml || '-'}</div>`;
                }
            }

            let tagsHtml = '';
            if (res.tags && res.tags.length > 0) {
                tagsHtml = res.tags.map(tag => {
                    const fullText = typeof tag === 'object' ? tag.text : tag;
                    const displayChars = (fullText || "").substring(0, 3);
                    const type = typeof tag === 'object' ? (tag.type || '') : '';
                    return `<span class="tag-badge ${type}" title="${fullText}">${displayChars}</span>`;
                }).join('');
            }

            if (currentFilter === 'entry' || currentFilter === 'entry_unclassified') {
                if (prevTrans !== null && prevTrans !== res.transporter) {
                    const headerRow = document.createElement('tr');
                    headerRow.className = 'repeat-header';
                    headerRow.style.backgroundColor = '#e2e8f0';
                    headerRow.style.height = '36px';
                    headerRow.innerHTML = `
                        <td style="text-align: center; font-weight: 700; background: #cbd5e1; padding: 10px 8px;">선사</td>
                        <td style="text-align: center; font-weight: 700; background: #cbd5e1; padding: 10px 8px;">규격</td>
                        <td style="text-align: center; font-weight: 700; background: #cbd5e1; padding: 10px 8px;">F.DEST</td>
                        <td style="text-align: center; font-weight: 700; background: #cbd5e1; padding: 10px 8px;">CTNR NO</td>
                        <td style="text-align: center; font-weight: 700; background: #cbd5e1; padding: 10px 4px; width: 44px;">P</td>
                        <td style="text-align: center; font-weight: 700; background: #cbd5e1; padding: 10px 8px;">SEAL</td>
                        <td style="text-align: right; font-weight: 700; background: #cbd5e1; padding: 10px 8px;">G/W</td>
                        <td style="text-align: center; font-weight: 700; background: #cbd5e1; padding: 10px 8px;">리마크</td>
                        <td style="text-align: center; font-weight: 700; background: #cbd5e1; padding: 10px 8px;">출항일</td>
                        <td style="text-align: center; font-weight: 700; background: #cbd5e1; padding: 10px 8px;">작업일</td>
                        <td style="text-align: center; font-weight: 700; background: #cbd5e1; padding: 10px 8px;">운송사</td>
                    `;
                    fragment.appendChild(headerRow);
                }
                prevTrans = res.transporter;
                let displayEtd = res.etd || '-';
                if (displayEtd instanceof Date || (typeof displayEtd === 'string' && displayEtd.includes('GMT'))) {
                    try {
                        const d = new Date(displayEtd);
                        displayEtd = `${d.getMonth() + 1}월 ${d.getDate()}일`;
                    } catch (e) { }
                }

                const today = new Date();
                const displayWorkDate = `${today.getMonth() + 1}월 ${today.getDate()}일`;

                // ── POP 무게 처리 ──────────────────────────────────
                const cntrKey = (res.cntrNo || '').trim().toUpperCase();
                const popInfo = popWeightMap[cntrKey];
                const popWeight = popInfo ? (parseFloat(popInfo.weight) || 0) : 0;
                const hasPop = popWeight > 0;

                // 컨테이너 번호 색상: POP 있으면 주황색, 기존 색 유지
                const effectiveCntrColor = hasPop ? '#ea580c' : cntrColor;

                // 리마크: POP 있으면 앞에 접두어 삽입
                const origRemarkDisplay = res.origRemark || '';
                const remarkHtml = hasPop
                    ? `<span style="color:#ea580c; font-weight:700; margin-right:4px;">(POP : ${popWeight.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}kg)</span>${origRemarkDisplay}`
                    : origRemarkDisplay;

                tr.innerHTML = `
                    <td style="text-align: center;">${res.carrierName.val}</td>
                    <td style="text-align: center;">${res.cntrType.val}</td>
                    <td style="text-align: center; color: ${/^(US|CA)/i.test(res.destination.val) ? 'inherit' : '#ef4444'}; font-weight: ${/^(US|CA)/i.test(res.destination.val) ? 'normal' : 'bold'};">
                        ${typeof renderDestinationHtml === 'function' ? renderDestinationHtml(null, res.destination.val, false) : res.destination.val}
                    </td>
                    <td style="color: ${effectiveCntrColor}; ${hasPop ? 'font-style:italic;' : ''}; padding: 6px 8px;">
                        <div style="display: flex; align-items: center; gap: 4px;">
                            <strong onclick="window.copyToClipboard('${res.cntrNo.replace(/'/g, "\\'")}', '컨테이너')" 
                                    style="cursor: pointer; text-decoration: underline dotted #cbd5e1; text-underline-offset: 3px;"
                                    title="클릭하여 컨테이너 복사"
                                    class="copyable-item">${res.cntrNo}</strong>
                            ${reworkContainers.has((res.cntrNo || "").trim().toUpperCase()) ? `<span style="display:inline-flex; align-items:center; justify-content:center; font-size:0.7rem; font-weight:bold; background:#fdf2f8; color:#db2777; border:1px solid #fbcfe8; border-radius:4px; padding:0px 4px; vertical-align:middle; line-height:1.2;" title="재작업 대상 컨테이너">재</span>` : ''}
                            ${hasPop ? `<span style="display:inline-block;font-size:0.65rem;background:#fff7ed;color:#ea580c;border:1px solid #fed7aa;border-radius:4px;padding:0px 4px;vertical-align:middle;">POP</span>` : ''}
                        </div>
                    </td>
                    <td style="text-align: center; padding: 6px 2px; vertical-align: middle;" data-photo-cntr="${res.cntrNo}">
                        ${typeof window.renderContainerPhotoBtn === 'function' ? window.renderContainerPhotoBtn(res.cntrNo, { iconOnly: true }) : ''}
                    </td>
                    <td style="text-align: center; color: #3b82f6; font-weight: 500;">${res.sealNo || '-'}</td>
                    <td class="col-gw-entry" style="text-align: right; font-weight: 700; vertical-align: top; padding-top: 8px;">
                        ${(() => {
                        const choice = userSelectedWeights[res.cntrNo];

                        if (res.isCriticalWeightMismatch) {
                            // POP 있을 때 중량상이 표시도 POP 합산 안내
                            return `
                                <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
                                    <span class="badge tag-danger weight-mismatch-badge" 
                                          style="cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; font-weight: 800; line-height: 1.2; box-shadow: 0 4px 6px -1px rgba(239, 68, 68, 0.2);"
                                          onclick="window.openWeightMismatchPopup('${res.cntrNo}')">
                                        <i class="fas fa-exclamation-triangle" style="margin-right: 4px;"></i>중량 상이
                                    </span>
                                    ${hasPop ? `<div style="font-size:0.65rem;color:#ea580c;font-weight:700;margin-top:2px;">+POP ${popWeight.toFixed(2)}kg</div>` : ''}
                                </div>
                            `;
                        }

                        const baseWeight = res.selectedTotalWeight || 0;
                        const totalWeight = baseWeight + popWeight;
                        const isChoice = !!choice;
                        return `
                                <div style="text-align: center; color: ${hasPop ? '#ea580c' : (isChoice ? '#2563eb' : '#1e293b')}; font-weight: ${(hasPop || isChoice) ? '800' : '500'};">
                                    ${totalWeight.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    ${hasPop ? `<div style="font-size:0.65rem; color:#ea580c; font-weight:600; margin-top:1px;">(기본 ${baseWeight.toFixed(2)} + POP ${popWeight.toFixed(2)})</div>` : ''}
                                    ${isChoice && !hasPop ? `<div style="font-size: 0.72rem; color: #3b82f6; font-weight: 600; margin-top: 2px;">(${choice === 'orig' ? '원본' : '전산'} 선택됨)</div>` : ''}
                                    ${isChoice ? `<button style="background: #f1f5f9; border: 1px solid #e2e8f0; color: #64748b; font-size: 0.65rem; cursor: pointer; border-radius: 4px; padding: 1px 4px; margin-top: 4px;" onclick="window.updateWeightChoice('${res.cntrNo}', null)">다시 선택</button>` : ''}
                                </div>
                            `;
                    })()}
                    </td>
                    <td class="entry-remark-cell">
                        <div class="entry-remark-container" title="${origRemarkDisplay}">${remarkHtml}</div>
                    </td>
                    <td style="text-align: center; font-size: 0.85rem;">${displayEtd}</td>
                    <td style="text-align: center; font-size: 0.85rem;">${displayWorkDate}</td>
                    <td><span class="badge" style="background: ${res.transporter.includes('천마') ? '#fee2e2; color: #b91c1c' : '#dbeafe; color: #1d4ed8'}; border: none; padding: 4px 8px; font-weight: 600;">${res.transporter}</span></td>
                `;

                const hasMeaningfulError = res.isErrorRow && detailHtml && detailHtml !== '-';
                if (hasMeaningfulError && !finalDetailHtml.includes('위와 동일')) {
                    const trError = document.createElement('tr');
                    trError.style.backgroundColor = '#fef2f2';
                    trError.innerHTML = `<td colspan="11" style="padding: 4px 12px; font-size: 0.85rem; color: #b91c1c; border-bottom: 2px solid #fca5a5;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <i class="fas fa-exclamation-triangle"></i>
                            <span>${finalDetailHtml}</span>
                        </div>
                    </td>`;
                    tr._trError = trError;
                }
            } else {
                const isSelectable = (currentFilter === 'all' || currentFilter === 'success' || currentFilter === 'hold' || currentFilter === 'error');
                tr.innerHTML = `
                    ${isSelectable ? `
                        <td class="col-select" style="text-align: center;">
                            <input type="checkbox" ${selectedItems.has(itemKey) ? 'checked' : ''} 
                                   onchange="window.toggleSelectItem('${itemKey}', event)" 
                                   style="width: 16px; height: 16px; cursor: pointer;">
                        </td>
                    ` : ''}
                    ${(currentFilter === 'error' || currentFilter === 'missing' || currentFilter === 'all' || currentFilter === 'success') ? `
                        <td class="col-manage" style="text-align: center;">
                            ${(() => {
                            const isError = res.isErrorRow || res.badgeClass === 'diff' || res.badgeClass === 'missing' || res.badgeClass === 'extra' || res.badgeClass === 'noproduct';
                            const isApproved = res.isApproved;

                            if (isApproved) {
                                return `<button class="btn btn-secondary" style="padding: 2px 6px; font-size: 0.75rem;" onclick="window.cancelApproveHItem('${res.cntrNo}', '${res.prodName}')">승인취소</button>`;
                            }
                            if (isError) {
                                return `<button class="btn btn-primary" style="padding: 2px 6px; font-size: 0.75rem; background-color: #7c3aed; border-color: #7c3aed;" onclick="window.approveHItem('${res.cntrNo}', '${res.prodName}')">승인</button>`;
                            }
                            return '-';
                        })()}
                        </td>
                    ` : ''}
                    <td class="col-work"><span class="badge ${res.badgeClass}">${res.type}</span></td>
                    <td class="col-special">
                        ${tagsHtml ? `<div style="display: flex; flex-wrap: wrap; gap: 2px; justify-content: center; line-height: 1; width: 100%; margin: 0 auto; padding: 2px 0;">${tagsHtml}</div>` : '-'}
                    </td>
                    <td class="col-cntr" style="padding-top: 4px; padding-bottom: 4px;">
                        <div style="display: flex; align-items: center; justify-content: center; gap: 6px; color: ${cntrColor}; line-height: 1;">
                            ${currentFilter === 'hold' ? `
                                <button class="btn-hold-toggle held" 
                                        onclick="window.toggleContainerHold('${res.cntrNo}', event)" 
                                        title="보류 해제">
                                    <i class="fas fa-pause-circle"></i>
                                </button>
                            ` : ''}
                            <strong onclick="window.copyToClipboard('${res.cntrNo.replace(/'/g, "\\'")}', '컨테이너')" 
                                    style="cursor: pointer; text-decoration: underline dotted #cbd5e1; text-underline-offset: 3px;"
                                    class="copyable-item"
                                    title="클릭하여 컨테이너 복사">${res.cntrNo}</strong>
                            ${isCaution ? `<span title="주의 비고: ${matchedCaution.remark || '사유 없음'}" style="display:inline-flex; align-items:center; justify-content:center; font-size:0.7rem; font-weight:bold; background:#ef4444; color:#fff; border-radius:4px; padding:0px 4px; line-height:1.2; cursor:help; white-space:nowrap;">주의</span>` : ''}
                            ${reworkContainers.has((res.cntrNo || "").trim().toUpperCase()) ? `<span style="display:inline-flex; align-items:center; justify-content:center; margin-left:4px; font-size:0.7rem; font-weight:bold; background:#fdf2f8; color:#db2777; border:1px solid #fbcfe8; border-radius:4px; padding:0px 4px; vertical-align:middle; line-height:1.2;" title="재작업 대상 컨테이너">재</span>` : ''}
                        </div>
                    </td>
                    <td class="col-photo" style="text-align: center; vertical-align: middle; padding: 2px 4px;" data-photo-cntr="${res.cntrNo}">
                        ${typeof window.renderContainerPhotoBtn === 'function' ? window.renderContainerPhotoBtn(res.cntrNo) : ''}
                    </td>
                    <td class="col-type" style="${(res.prodType || '').toUpperCase() === 'H' ? 'color: #7c3aed; font-weight: 700;' : (res.prodType || '').toUpperCase() === 'Q' ? 'color: #0d9488; font-weight: 700;' : ''}">${res.prodType || '-'}</td>
                    <td class="col-div">${res.division || '-'}</td>
                    <td class="col-model" 
                        onclick="window.copyToClipboard('${res.prodName.replace(/'/g, "\\'")}', '제품명')"
                        style="cursor: pointer; ${isCaution ? 'color: #dc2626; font-weight: 700;' : (res.prodName || '').trim().toUpperCase() !== 'NONASSET.ITEM' && (res.dims || '').trim().toLowerCase() === '0x0x0' ? 'color: #ef4444; font-weight: 700;' : (res.prodType || '').toUpperCase() === 'H' ? 'color: #7c3aed; font-weight: 700;' : (res.prodType || '').toUpperCase() === 'Q' ? 'color: #0d9488; font-weight: 700;' : ''}"
                        title="클릭하여 제품명 복사 (마우스 오버 시 로케이션별 재고 확인)"
                        class="copyable-item ${(res.prodName || '').trim().toUpperCase() !== 'NONASSET.ITEM' && (res.dims || '').trim().toLowerCase() === '0x0x0' ? 'no-size-model-text' : ''}">
                        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                            <span class="product-name-hoverable" 
                                  onmouseenter="window.handleProductMouseEnter('${res.prodName.replace(/'/g, "\\'")}', this, '${(res.prodType || '').replace(/'/g, "\\'")}')" 
                                  onmouseleave="window.handleProductMouseLeave()">${res.prodName}</span>
                            ${(res.prodName || '').trim().toUpperCase() !== 'NONASSET.ITEM' && (res.dims || '').trim().toLowerCase() === '0x0x0' ? '<span class="tag-no-size">사이즈없음</span>' : ''}
                            ${isCaution ? `<span title="주의 비고: ${matchedCaution.remark || '사유 없음'}" style="display:inline-flex; align-items:center; justify-content:center; font-size:0.7rem; font-weight:bold; background:#ef4444; color:#fff; border-radius:4px; padding:0px 4px; line-height:1.2; cursor:help; white-space:nowrap;">주의</span>` : ''}
                            ${getDongTag(res.prodName, res.prodType)}
                            ${getYuTag(res.prodName, res.prodType)}
                            ${getBlockHoldTag(res.prodName)}
                            ${getStockShortageBadge(res.prodName, res.qtyInfo.remain)}
                        </div>
                    </td>
                    <td class="col-qty" style="font-size: 0.9em;">${renderQtyMismatch(res.qtyInfo)}</td>
                    <td class="col-spec">${renderMismatch(res.cntrType.orig, res.cntrType.val, res.cntrType.isMismatch)}</td>
                    <td class="col-dims">${res.dims || '-'}</td>
                    <td class="col-carrier">${renderMismatch(res.carrierName.orig, res.carrierName.val, res.carrierName.isMismatch)}</td>
                    <td class="col-dest">${typeof renderDestinationHtml === 'function' ? renderDestinationHtml(res.destination.orig, res.destination.val, res.destination.isMismatch) : (res.destination.orig === null ? `<span>${res.destination.val}</span>` : renderMismatch(res.destination.orig, res.destination.val, res.destination.isMismatch))}</td>
                    <td class="col-gw" ${(() => {
                        const cleanProdName = (res.prodName || '').trim().toUpperCase();
                        let dbUnitW = res.unitWeight;
                        if ((dbUnitW === undefined || isNaN(dbUnitW)) && productMaster && Array.isArray(productMaster)) {
                            const pm = productMaster.find(p => (p.name || '').trim().toUpperCase() === cleanProdName);
                            if (pm && pm.weight) dbUnitW = parseFloat(pm.weight);
                        }
                        const planQty = res.qtyInfo ? (res.qtyInfo.plan || res.qtyInfo.origPlan || res.qtyInfo.load || 0) : 0;
                        const dRaw = parseFloat(res.weights.down) || 0;
                        const oRaw = parseFloat(res.weights.orig) || 0;
                        let curUnitW = res.currentUnitWeight;
                        if ((curUnitW === undefined || isNaN(curUnitW)) && planQty > 0) {
                            if (dRaw > 0) curUnitW = dRaw / planQty;
                            else if (oRaw > 0) curUnitW = oRaw / planQty;
                        }

                        // 해당 컨테이너 전체 작업 총중량 및 총수량 집계
                        let cntrTotalW = 0;
                        let cntrTotalQty = 0;
                        const cleanCntr = (res.cntrNo || '').trim();
                        if (cleanCntr && typeof comparisonResult !== 'undefined' && Array.isArray(comparisonResult)) {
                            const cntrItems = comparisonResult.filter(it => (it.cntrNo || '').trim() === cleanCntr);
                            if (cntrItems.length > 0) {
                                cntrTotalW = cntrItems.reduce((sum, it) => {
                                    const w = parseFloat(it.weights?.down || it.weights?.mixed || it.weights?.orig) || 0;
                                    return sum + w;
                                }, 0);
                                cntrTotalQty = cntrItems.reduce((sum, it) => {
                                    const q = (it.qtyInfo?.plan || it.qtyInfo?.origPlan || it.qtyInfo?.load || 0);
                                    return sum + q;
                                }, 0);
                            }
                        }

                        const lines = [];
                        if (dbUnitW !== undefined && !isNaN(dbUnitW) && dbUnitW > 0) {
                            lines.push(`• DB 마스터 개별중량: ${dbUnitW.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg/EA`);
                        }
                        if (curUnitW !== undefined && !isNaN(curUnitW) && curUnitW > 0) {
                            if (dbUnitW && Math.abs(curUnitW - dbUnitW) > 0.05) {
                                lines.push(`• 전산 실측 개별중량: ${curUnitW.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg/EA`);
                            } else if (!dbUnitW) {
                                lines.push(`• 개별중량: ${curUnitW.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg/EA`);
                            }
                        }
                        if (planQty > 0) {
                            lines.push(`• 품목 작업수량: ${planQty.toLocaleString()} EA`);
                        }
                        const totalW = dRaw > 0 ? dRaw : oRaw;
                        if (totalW > 0) {
                            lines.push(`• 품목 합계중량: ${totalW.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg`);
                        }
                        if (cntrTotalW > 0) {
                            lines.push(`────────────────────`);
                            lines.push(`📦 [${cleanCntr}] 컨테이너 작업총중량: ${cntrTotalW.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg (총 ${cntrTotalQty.toLocaleString()} EA)`);
                        }

                        if (lines.length > 0) {
                            const tooltipContent = `[중량 및 작업 상세 정보]\n` + lines.join('\n');
                            return `title="${tooltipContent.replace(/"/g, '&quot;')}" style="text-align: right; vertical-align: middle; padding: 4px 6px; cursor: help;"`;
                        }
                        return `style="text-align: right; vertical-align: middle; padding: 4px 6px;"`;
                    })()}>
                        ${(() => {
                        if (res.badgeClass === 'noproduct') {
                            return `<div style="text-align: center; color: #ef4444; font-weight: 800; font-size: 0.78rem;">정보없음</div>`;
                        }
                        const mRaw = parseFloat(res.weights.mixed);
                        const oRaw = parseFloat(res.weights.orig) || 0;
                        const dRaw = parseFloat(res.weights.down) || 0;
                        if (isNaN(mRaw) && isNaN(oRaw) && isNaN(dRaw)) {
                            return `<div style="text-align: center; color: #ef4444; font-weight: 800; font-size: 0.78rem;">정보없음</div>`;
                        }
                        const effectiveMRaw = !isNaN(mRaw) ? mRaw : dRaw;
                        const diffAbs = Math.abs(effectiveMRaw - oRaw);
                        if (diffAbs < 1) {
                            return `<div style="text-align: right; color: #475569; font-size: 0.8rem; font-weight: 500;">${dRaw > 0 ? dRaw.toLocaleString() : (oRaw > 0 ? oRaw.toLocaleString() : '-')}</div>`;
                        }
                        const diffStr = diffAbs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                        const sign = effectiveMRaw >= oRaw ? '+' : '-';
                        return `
                            <div class="gw-mismatch-box" style="display: flex; flex-direction: column; gap: 1px; font-size: 0.70rem; line-height: 1.2; width: 100%; box-sizing: border-box;">
                                <div style="display: flex; justify-content: space-between; width: 100%; gap: 2px;">
                                    <span style="font-weight: 600; color: #64748b; font-size: 0.68rem;">전산:</span>
                                    <strong style="color: #0284c7; font-size: 0.70rem;">${dRaw.toLocaleString()}</strong>
                                </div>
                                <div style="display: flex; justify-content: space-between; width: 100%; gap: 2px;">
                                    <span style="font-weight: 600; color: #64748b; font-size: 0.68rem;">원본:</span>
                                    <strong style="color: #334155; font-size: 0.70rem;">${oRaw.toLocaleString()}</strong>
                                </div>
                                <div style="display: flex; justify-content: space-between; width: 100%; border-top: 1px dashed #fecaca; padding-top: 1px; margin-top: 1px; gap: 2px;">
                                    <span style="font-weight: 700; color: #dc2626; font-size: 0.68rem;">차이:</span>
                                    <strong style="color: #dc2626; font-weight: 800; font-size: 0.70rem;">${sign}${diffStr}</strong>
                                </div>
                            </div>
                        `;
                    })()}
                    </td>
                    ${(currentFilter === 'all' || currentFilter === 'error' || currentFilter === 'missing') ? `
                        <td class="col-error-detail" colspan="2" style="font-size: 0.8rem; line-height: 1.4; color: #475569;">
                            <div style="display: flex; flex-direction: column; gap: 4px;">
                                ${res.isErrorRow ? finalDetailHtml : ''}
                                ${(() => {
                            let extraItems = [];
                            if (res.adj1 && res.adj1 !== '-') {
                                let adj1ColorStr = 'inherit';
                                if (res.adj1Color) {
                                    adj1ColorStr = res.adj1Color.startsWith('FF') ? '#' + res.adj1Color.substring(2) : res.adj1Color;
                                }
                                extraItems.push(`<span style="color: ${adj1ColorStr}; font-weight: 500;">${res.adj1}</span>`);
                            }
                            if (res.adj2 && res.adj2 !== '-') extraItems.push(`<span>${res.adj2}</span>`);

                            if (extraItems.length > 0) {
                                const needsSep = res.isErrorRow;
                                return `<div style="color: #64748b; ${needsSep ? 'border-top: 1px dotted #e2e8f0; padding-top: 3px; margin-top: 2px;' : ''}">${extraItems.join(' | ')}</div>`;
                            }
                            return res.isErrorRow ? '' : '-';
                        })()}
                            </div>
                        </td>
                    ` : `
                        <td class="col-adj1" style="font-size: 0.8rem; line-height: 1.4; color: #475569;">
                            ${(() => {
                        const val = res.adj1 || '-';
                        if (isDbMode || currentFilter === 'success') {
                            let adj1ColorStr = 'inherit';
                            if (res.adj1Color) {
                                adj1ColorStr = res.adj1Color.startsWith('FF') ? '#' + res.adj1Color.substring(2) : res.adj1Color;
                            }
                            return `<div class="detail-text" style="color: ${adj1ColorStr}; font-weight: 500;">${val}</div>`;
                        }
                        return finalDetailHtml;
                    })()}
                        </td>
                        <td class="col-adj2" style="font-size: 0.8rem; line-height: 1.4; color: #475569;">
                            <div class="detail-text">${res.adj2 || '-'}</div>
                        </td>
                    `}
                `;
                // 컬럼 개수 계산 (전체/오류/미분류 탭은 선택+관리+11+상세오류(2)=15)
                let colSpanCount = 14;
                if (currentFilter === 'all' || currentFilter === 'error' || currentFilter === 'missing') {
                    colSpanCount = 15;
                } else if (currentFilter === 'entry' || currentFilter === 'entry_unclassified') {
                    colSpanCount = 10;
                }

                if (res.isErrorRow && finalDetailHtml && finalDetailHtml.trim() !== '-' && !finalDetailHtml.includes('위와 동일')) {
                    const trError = document.createElement('tr');
                    trError.className = 'error-detail-row';
                    trError.style.backgroundColor = '#fef2f2';
                    // 전체/오류/미분류 탭에서는 기본적으로 숨김 처리 (기존에는 전체 탭에서 항상 보였음)
                    if (currentFilter === 'all' || currentFilter === 'error' || currentFilter === 'missing') {
                        trError.style.display = 'none';
                        tr.style.cursor = 'pointer';
                        tr.title = '클릭하면 상세 오류 내용을 확인할 수 있습니다';
                        tr.addEventListener('click', (e) => {
                            if (e.target.closest('.col-select') || e.target.closest('.col-manage')) return;
                            const isExpanded = trError.style.display !== 'none';
                            trError.style.display = isExpanded ? 'none' : 'table-row';
                            tr.style.backgroundColor = isExpanded ? '' : '#fef2f2';
                        });
                    }

                    trError.innerHTML = `<td colspan="${colSpanCount}" style="padding: 4px 12px; font-size: 0.85rem; color: #b91c1c; border-bottom: 2px solid #fca5a5;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <i class="fas fa-exclamation-triangle"></i>
                            <span>${finalDetailHtml}</span>
                        </div>
                    </td>`;
                    tr._trError = trError;
                }

                // DB 검색 모드: 관리 버튼 (삭제) 추가
                if (isDbMode) {
                    const tdManage = document.createElement('td');
                    tdManage.className = 'col-manage';
                    tdManage.style.textAlign = 'center';

                    // 개별 선택 체크박스
                    const chk = document.createElement('input');
                    chk.type = 'checkbox';
                    chk.className = 'db-row-chk';
                    chk.dataset.id = res.dbId;
                    chk.style.marginRight = '8px';
                    chk.onclick = (e) => {
                        e.stopPropagation();
                        const total = document.querySelectorAll('.db-row-chk').length;
                        const checked = document.querySelectorAll('.db-row-chk:checked').length;
                        document.getElementById('dbSelectedCount').textContent = checked;
                        document.getElementById('chkDbAll').checked = (total === checked);
                    };

                    const btnDel = document.createElement('button');
                    btnDel.innerHTML = '<i class="fas fa-trash-alt"></i>';
                    btnDel.className = 'btn-icon-delete';
                    btnDel.style.cssText = 'background:none; border:none; color:#ef4444; cursor:pointer; padding:5px; transition:all 0.2s;';
                    btnDel.title = 'DB에서 삭제';

                    btnDel.onclick = async (e) => {
                        e.stopPropagation();
                        if (!confirm('이 레코드를 데이터베이스에서 영구적으로 삭제하시겠습니까?')) return;

                        try {
                            const resp = await fetch(`${API_BASE}/api/db-record/${res.dbId}`, { method: 'DELETE' });
                            const result = await resp.json();
                            if (result.success) {
                                alert('삭제되었습니다.');
                                displayData = displayData.filter(d => d.dbId !== res.dbId);
                                lastDbSearchResults = displayData; // 전역 유지 변수도 갱신
                                const uniqueCntrs = new Set(displayData.map(d => d.cntrNo));
                                document.getElementById('dbTotalItems').textContent = displayData.length.toLocaleString();
                                document.getElementById('dbTotalCntrs').textContent = uniqueCntrs.size.toLocaleString();
                                tr.remove();
                                if (tr._detailTr) tr._detailTr.remove();
                            } else {
                                alert('삭제 실패: ' + result.message);
                            }
                        } catch (err) {
                            alert('통신 오류: ' + err.message);
                        }
                    };

                    tdManage.appendChild(chk);
                    tdManage.appendChild(btnDel);
                    tr.prepend(tdManage);
                }

                // 정상컨테이너 탭: 클릭 시 확장 패널 추가
                if ((currentFilter === 'success' || isDbMode) && currentFilter !== 'entry' && currentFilter !== 'entry_unclassified') {
                    tr.style.cursor = 'pointer';
                    tr.title = '클릭하면 원본 상세정보를 확인할 수 있습니다';

                    const detailTr = document.createElement('tr');
                    detailTr.className = 'success-detail-row';
                    detailTr.style.cssText = 'display:none; background: #f0f9ff; border-left: 3px solid #0ea5e9;';

                    detailTr.innerHTML = `
                    <td colspan="${colSpanCount}" style="padding: 0; background-color: #f1f5f9;">
                        <div class="success-detail-container">
                            <div class="detail-card">
                                <div class="detail-grid">
                                    <div class="detail-item">
                                        <span class="label"><i class="fas fa-tasks"></i> 작업명</span>
                                        <span class="value">${res.jobName || '-'}</span>
                                    </div>
                                    <div class="detail-item">
                                        <span class="label"><i class="fas fa-lock"></i> 씰정보</span>
                                        <span class="value">${res.sealNo || '-'}</span>
                                    </div>
                                    <div class="detail-item">
                                        <span class="label"><i class="fas fa-calendar-alt"></i> 선적일</span>
                                        <span class="value date-eta">${res.eta || '-'}</span>
                                    </div>
                                    <div class="detail-item">
                                        <span class="label"><i class="fas fa-ship"></i> 출항일</span>
                                        <span class="value date-etd">${res.etd || '-'}</span>
                                    </div>
                                    <div class="detail-item" style="flex: 1; min-width: 600px;">
                                        <span class="label"><i class="fas fa-comment-dots"></i> 리마크</span>
                                        <div class="remark-content">${res.origRemark || '-'}</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </td>
                `;
                    tr._detailTr = detailTr; // 참조 저장

                    tr.addEventListener('click', (e) => {
                        if (e.target.closest('.col-select') || e.target.closest('.col-manage')) return;
                        const isExpanded = detailTr.style.display !== 'none';
                        detailTr.style.display = isExpanded ? 'none' : 'table-row';
                        tr.style.backgroundColor = isExpanded ? '' : '#f0f9ff';
                    });
                }
            }

            // --- 최종 행 Append (Entry/정상 공통) ---
            fragment.appendChild(tr);
            if (tr._trError) fragment.appendChild(tr._trError);
            if (tr._detailTr) fragment.appendChild(tr._detailTr);
        }

        try {
            const rb = getResultBody();
            if (rb) rb.appendChild(fragment);
        } catch (fragmentErr) {
            console.error("❌ Fragment append failed:", fragmentErr);
        }
        currentIndex = end;

        if (currentIndex < displayData.length) {
            requestAnimationFrame(renderChunk);
        } else {
            updateSelectionUI();
        }
    }

    renderChunk();
}

// 테이블 헤더 업데이트 함수 (탭 전환 및 결과 표시 시 공통 사용)
function updateTableHeaders(filterName) {
    const tableHead = document.querySelector('#resultTable thead');
    if (!tableHead) return;

    if (filterName === 'entry' || filterName === 'entry_unclassified') {
        tableHead.innerHTML = `
            <tr>
                <th class="col-carrier">선사</th>
                <th class="col-spec">규격</th>
                <th class="col-dest">F.DEST</th>
                <th class="col-cntr">CTNR NO</th>
                <th class="col-photo" style="text-align: center; width: 44px;">P</th>
                <th class="col-seal">SEAL</th>
                <th class="col-gw" style="text-align: right;">G/W</th>
                <th class="col-remark" style="text-align: center;">리마크</th>
                <th class="col-etd" style="text-align: center;">출항일</th>
                <th class="col-work-date" style="text-align: center;">작업일</th>
                <th class="col-trans">운송사</th>
            </tr>
        `;
    } else {
        const isSelectableTab = filterName === 'all' || filterName === 'success' || filterName === 'hold' || filterName === 'error';
        const isDbSearchTab = filterName === 'dbSearch';
        const isMergedColTab = filterName === 'all' || filterName === 'error' || filterName === 'missing';
        const isErrorTab = filterName === 'error' || filterName === 'missing';

        tableHead.innerHTML = `
            <tr>
                ${isSelectableTab ? '<th class="col-select">선택</th>' : ''}
                ${(isDbSearchTab || isErrorTab || filterName === 'success' || filterName === 'all') ? '<th class="col-manage">관리</th>' : ''}
                <th class="col-work">작업구분</th>
                <th class="col-special">특이사항</th>
                <th class="col-cntr">컨테이너번호</th>
                <th class="col-photo">사진</th>
                <th class="col-type">제품구분</th>
                <th class="col-div">사업부</th>
                <th class="col-model">제품모델명</th>
                <th class="col-qty">수량 (계획/적재/팬딩/잔여/단위)</th>
                <th class="col-spec">규격</th>
                <th class="col-dims">제품크기</th>
                <th class="col-carrier">선사</th>
                <th class="col-dest">도착지</th>
                <th class="col-gw">GW</th>
                ${isMergedColTab ? `
                    <th class="col-error-detail" colspan="2" style="text-align: center;">${filterName === 'all' ? '상세내역 및 추가정보' : '상세오류내용'}</th>
                ` : `
                    <th class="col-adj1">추가정보1</th>
                    <th class="col-adj2">추가정보2</th>
                `}
            </tr>
        `;
    }
}

// --- 탭 클릭 이벤트 리스너 복구 (displayResults 밖으로 이동) ---
function setActiveTab(filterName) {
    currentFilter = filterName;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

    const tabMap = {
        'all': document.getElementById('tabAll'),
        'success': document.getElementById('tabSuccessOnly'),
        'error': document.getElementById('tabErrorOnly'),
        'missing': document.getElementById('tabMissingOnly'),
        'hold': document.getElementById('tabHold'),
        'entry': document.getElementById('tabEntryInfo'),
        'entry_unclassified': document.getElementById('tabUnclassifiedEntry'),
        'dbSearch': document.getElementById('tabDbSearch')
    };
    if (tabMap[filterName]) tabMap[filterName].classList.add('active');

    // 반입정보 탭 요약 바 표시/숨김
    const entrySummary = document.getElementById('entrySummary');
    if (entrySummary) {
        entrySummary.style.display = (filterName === 'entry' || filterName === 'entry_unclassified') ? 'flex' : 'none';
    }

    // 정상 컨테이너 서브 필터 표시/숨김
    const successFilterContainer = document.getElementById('successFilterContainer');
    if (successFilterContainer) {
        successFilterContainer.style.display = (filterName === 'success') ? 'block' : 'none';
    }

    const missingFilterContainer = document.getElementById('missingFilterContainer');
    if (missingFilterContainer) {
        missingFilterContainer.style.display = (filterName === 'missing') ? 'block' : 'none';
    }

    // DB 검색 전용 필터 바 표시/숨김
    const dbSearchFilterBar = document.getElementById('dbSearchFilterBar');
    if (dbSearchFilterBar) {
        dbSearchFilterBar.style.display = (filterName === 'dbSearch') ? 'flex' : 'none';
    }

    // DB 검색 탭 진입 시 요약 정보 업데이트
    const dbSummary = document.getElementById('dbSearchResultSummary');
    if (dbSummary) {
        dbSummary.style.display = (filterName === 'dbSearch') ? 'flex' : 'none';
        if (filterName === 'dbSearch') updateDbGlobalStats();
    }

    // 테이블 클래스 초기화 및 부여 (UI 깨짐 방지)
    const resultTable = document.getElementById('resultTable');
    if (resultTable) {
        resultTable.classList.remove('general-table', 'entry-table');
        if (filterName === 'entry' || filterName === 'entry_unclassified') {
            resultTable.classList.add('entry-table');
        } else {
            resultTable.classList.add('general-table');
        }
    }

    // [추가] 탭 전환 시 헤더 즉시 업데이트 (DB 조회 전에도 올바른 헤더 표시용)
    updateTableHeaders(filterName);

    const rb = getResultBody();
    if (filterName === 'dbSearch') {
        // DB 검색 탭 진입 시: 기존 검색 결과가 있으면 재표시, 없으면 안내 메시지
        if (lastDbSearchResults && lastDbSearchResults.length > 0) {
            displayResults(lastDbSearchResults, true);
        } else {
            if (rb) {
                rb.innerHTML = '<tr><td colspan="12" style="text-align:center; padding: 2.5rem; color: #64748b; font-size: 1.05rem;"><i class="fas fa-search" style="font-size: 1.5rem; display: block; margin-bottom: 15px; color: #cbd5e1;"></i>상단의 다중 검색 필터를 입력하고 [검색] 버튼을 눌러주세요.</td></tr>';
            }
            displayData = [];
            updateSelectionUI();
        }
    } else {
        if (comparisonResult.length > 0) displayResults(comparisonResult);
    }
}

// 탭 이벤트 리스너 재설정 함수 (초기화 및 수동 호출 가능)
function initTabListeners() {
    const attach = (id, filter) => {
        const el = document.getElementById(id);
        if (el) {
            // 기존 리스너 제거는 어려우므로 새로 할당 (onclick 사용 혹은 cloneNode 사용 가능하나 여기선 안전하게 체크)
            el.onclick = () => setActiveTab(filter);
        }
    };

    attach('tabAll', 'all');
    attach('tabSuccessOnly', 'success');
    attach('tabErrorOnly', 'error');
    attach('tabMissingOnly', 'missing');
    attach('tabHold', 'hold');
    attach('tabEntryInfo', 'entry');
    attach('tabUnclassifiedEntry', 'entry_unclassified');
    attach('tabDbSearch', 'dbSearch');

    // 상단 요약 카드 클릭 이벤트 (대시보드 네비게이션)
    attach('cardTotal', 'all');
    attach('cardSuccess', 'success');
    attach('cardError', 'error');
    attach('cardMissingMerged', 'missing');
    attach('cardHold', 'hold');
}

initTabListeners();
const tabDbSearchObj = document.getElementById('tabDbSearch');
if (tabDbSearchObj) {
    tabDbSearchObj.addEventListener('click', () => setActiveTab('dbSearch'));
}

['chkFilterCompleted', 'chkFilterProgress', 'chkFilterPending', 'chkFilterChunma', 'chkFilterBni', 'chkFilterOtherTrans', 'chkFilterHasPhoto', 'chkFilterMissingExtra', 'chkFilterMissingMissing'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('change', () => {
            if (comparisonResult.length > 0) displayResults(comparisonResult);
        });
    }
});

const btnResetSuccessFilters = document.getElementById('btnResetSuccessFilters');
if (btnResetSuccessFilters) {
    btnResetSuccessFilters.addEventListener('click', () => {
        ['chkFilterCompleted', 'chkFilterProgress', 'chkFilterPending', 'chkFilterChunma', 'chkFilterBni', 'chkFilterOtherTrans', 'chkFilterHasPhoto'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.checked = false;
        });
        if (comparisonResult.length > 0) displayResults(comparisonResult);
    });
}

/**
 * [추가] 결과 바로보기 핸들러
 * 다운로드 창을 생략하고 엑셀 프로그램을 즉시 실행하며, 웹 브라우저에서도 즉시 다운로드 제공
 */
window.handleViewResultDirectly = async function() {
    const targetData = (comparisonResult && comparisonResult.length > 0) 
        ? comparisonResult 
        : ((window.comparisonResult && window.comparisonResult.length > 0) 
            ? window.comparisonResult 
            : ((window.displayData && window.displayData.length > 0) ? window.displayData : []));

    if (!targetData || targetData.length === 0) {
        alert("조회 또는 비교된 데이터가 없습니다. 먼저 엑셀 파일을 업로드하거나 조회를 실행해 주세요.");
        return;
    }

    const btn = document.getElementById('btnViewResult');
    const originalText = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 생성 중...';
        btn.disabled = true;
    }

    try {
        const wb = await generateComparisonWorkbook(targetData);
        const buffer = await wb.xlsx.writeBuffer();
        const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const fileName = (window.currentFilter === 'entry') 
            ? `반입정보_${timestamp}.xlsx` 
            : ((window.currentFilter === 'entry_unclassified') ? `반입정보_미분류_${timestamp}.xlsx` : `비교결과_${timestamp}.xlsx`);

        // 1. Electron 환경인 경우 직접 OS 임시 파일로 열기
        if (window.isElectron && window.electronAPI && typeof window.electronAPI.openTempExcel === 'function') {
            const result = await window.electronAPI.openTempExcel(buffer, fileName);
            if (!result.success) {
                console.warn('Electron openTempExcel 실패:', result.error);
            }
        } else {
            // 2. 백엔드 API 호출하여 로컬 PC에서 즉시 엑셀 프로그램 실행 시도
            try {
                const base64 = bufToBase64(buffer);
                await fetch(`${API_BASE}/api/open-excel`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ buffer: base64, fileName: fileName })
                });
                console.log('✅ 엑셀 바로보기(로컬 실행 API) 요청 완료');
            } catch (netErr) {
                console.warn('로컬 엑셀 실행 API 통신 실패 (웹 브라우저 다운로드로 대체):', netErr);
            }

            // 3. 웹 브라우저 환경에서도 파일 즉시 다운로드 / 열기 제공
            const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            if (typeof saveAs === 'function') {
                saveAs(blob, fileName);
            }
        }
    } catch (err) {
        console.error('❌ 바로보기 오류:', err);
        alert(`엑셀을 생성/여는 중 오류가 발생했습니다: ${err.message}`);
    } finally {
        if (btn) {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }
};

if (btnViewResult) {
    btnViewResult.addEventListener('click', window.handleViewResultDirectly);
}

/**
 * [분리] 비교 결과 Workbook 생성 로직 (Download/View 중복 제거)
 */
async function generateComparisonWorkbook(sourceData = null) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('비교 결과');
    let exportData = [];
    let columns = [];

    const searchInput = document.getElementById('inputSearch');
    const prodSearchInput = document.getElementById('inputProdSearch');
    const prodTypeSelect = document.getElementById('selectProdType');

    const searchTerm = (searchInput ? searchInput.value : "").trim().toUpperCase();
    const prodSearchTerm = (prodSearchInput ? prodSearchInput.value : "").trim().toUpperCase();
    const prodTypeFilter = (prodTypeSelect ? prodTypeSelect.value : "").trim().toUpperCase();

    let rawList = sourceData || comparisonResult || window.comparisonResult || window.displayData || [];
    let filteredResults = Array.isArray(rawList) ? rawList : [];

    if (searchTerm || prodSearchTerm || prodTypeFilter) {
        filteredResults = filteredResults.filter(r => {
            const cntr = (r.cntrNo || "").toUpperCase();
            const prod = (r.prodName || "").toUpperCase();
            const type = (r.prodType || "").toUpperCase();
            let match = true;
            if (searchTerm && !cntr.includes(searchTerm)) match = false;
            if (prodSearchTerm && !prod.includes(prodSearchTerm)) match = false;
            if (prodTypeFilter && type !== prodTypeFilter) match = false;
            return match;
        });
    }

    const curFilter = window.currentFilter || 'all';

    if (curFilter === 'entry' || curFilter === 'entry_unclassified') {
        columns = [
            { header: '선사', key: 'carrier', width: 10 },
            { header: '규격', key: 'cntrType', width: 10 },
            { header: 'F.DEST', key: 'dest', width: 12 },
            { header: 'CTNR NO', key: 'cntrNo', width: 17 },
            { header: 'SEAL', key: 'sealNo', width: 15 },
            { header: '합산중량', key: 'grossWeightCombined', width: 15, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'right' } } },
            { header: '모선항차 / 반입터미널', key: 'origRemark', width: 45 },
            { header: '출항일', key: 'etd', width: 12 },
            { header: '작업일', key: 'workDate', width: 12 },
            { header: '운송사', key: 'transporter', width: 12 }
        ];

        const aggregated = new Map();
        filteredResults.forEach(item => {
            if (window.holdContainerMap && window.holdContainerMap.has(item.cntrNo)) return;

            let isUnclassified = false;
            let cleanTrans = (item.transporter || "").toString().replace(/\(빨강\)|\(파랑\)|\(초록\)|\(주황\)/g, "").trim();
            if (!cleanTrans || cleanTrans === "-" || cleanTrans === "정보없음" || cleanTrans === "미분류" || cleanTrans === "미지정") {
                isUnclassified = true;
                cleanTrans = "미분류";
            }

            if (curFilter === 'entry' && isUnclassified) return;
            if (curFilter === 'entry_unclassified' && !isUnclassified) return;

            const key = (item.cntrNo || "").trim().toUpperCase();
            if (!key || item.badgeClass === 'missing') return;

            const carrierVal = (item.carrierName && item.carrierName.val !== undefined) ? item.carrierName.val : (item.carrierName || item.carrier || "");
            const cntrTypeVal = (item.cntrType && item.cntrType.val !== undefined) ? item.cntrType.val : (item.cntrType || item.cntrSize || "");
            const destVal = (item.destination && item.destination.val !== undefined) ? item.destination.val : (item.destination || item.dest || "");
            const wMixedVal = (item.weights && item.weights.mixed !== undefined) ? (item.weights.mixed === null ? 0 : (parseFloat(item.weights.mixed) || 0)) : (parseFloat(item.mixedWeight || item.weight) || 0);
            const wOrigVal = (item.weights && item.weights.orig !== undefined) ? (item.weights.orig === null ? 0 : (parseFloat(item.weights.orig) || 0)) : (parseFloat(item.origWeight) || 0);
            const wDownVal = (item.weights && item.weights.down !== undefined) ? (item.weights.down === null ? 0 : (parseFloat(item.weights.down) || 0)) : (parseFloat(item.downWeight) || 0);
            const isMismatchVal = item.weights ? !!item.weights.isMismatch : false;

            if (!aggregated.has(key)) {
                aggregated.set(key, {
                    carrier: carrierVal,
                    cntrType: cntrTypeVal,
                    dest: destVal,
                    cntrNo: item.cntrNo,
                    sealNo: item.sealNo || "",
                    mixedWeight: wMixedVal,
                    origWeight: wOrigVal,
                    downWeight: wDownVal,
                    isMismatch: isMismatchVal,
                    issueModels: [],
                    origRemark: item.origRemark || "",
                    etd: item.etd || "",
                    workDate: item.workDate || "-",
                    transporter: cleanTrans
                });
                const entry = aggregated.get(key);
                if (item.weights && item.weights.mixed === null) {
                    entry.issueModels.push(`${item.prodName}: 제품정보없음`);
                } else if (isMismatchVal) {
                    const diff = (wMixedVal - wOrigVal).toFixed(2);
                    entry.issueModels.push(`${item.prodName}: 무게정보다름(차이값:${diff > 0 ? '+' : ''}${diff})`);
                }
            } else {
                const existing = aggregated.get(key);
                existing.mixedWeight += wMixedVal;
                existing.origWeight += wOrigVal;
                existing.downWeight += wDownVal;

                if (item.weights && item.weights.mixed === null) existing.issueModels.push(`${item.prodName}: 제품정보없음`);
                if (isMismatchVal) {
                    existing.isMismatch = true;
                    const diff = (wMixedVal - wOrigVal).toFixed(2);
                    existing.issueModels.push(`${item.prodName}: 무게정보다름(차이값:${diff > 0 ? '+' : ''}${diff})`);
                }
            }
        });
        exportData = Array.from(aggregated.values());
        exportData.sort((a, b) => (a.transporter || '').localeCompare(b.transporter || ''));
    } else {
        columns = [
            { header: '작업구분', key: 'type', width: 15 },
            { header: '컨테이너번호', key: 'cntrNo', width: 20 },
            { header: '제품구분', key: 'prodType', width: 10 },
            { header: '사업부', key: 'division', width: 12 },
            { header: '제품모델명', key: 'prodName', width: 30 },
            { header: '계획수량', key: 'planQty', width: 10 },
            { header: '적재수량', key: 'loadQty', width: 10 },
            { header: '팬딩수량', key: 'pendingQty', width: 10 },
            { header: '잔여수량', key: 'remainQty', width: 10 },
            { header: '컨테이너규격', key: 'cntrSize', width: 15 },
            { header: '제품크기', key: 'dims', width: 15 },
            { header: '선사', key: 'carrier', width: 15 },
            { header: '도착지', key: 'dest', width: 15 },
            { header: '무게(계획)', key: 'mixedWeight', width: 15 },
            { header: '상세사유', key: 'detail', width: 50 },
            { header: '작업명', key: 'jobName', width: 20 },
            { header: '선적일', key: 'eta', width: 15 },
            { header: '출항일', key: 'etd', width: 15 },
            { header: '리마크', key: 'origRemark', width: 40 }
        ];

        let filtered = filteredResults;
        if (curFilter === 'hold') {
            filtered = filteredResults.filter(r => window.holdContainerMap && window.holdContainerMap.has(r.cntrNo));
        } else {
            filtered = filteredResults.filter(r => !(window.holdContainerMap && window.holdContainerMap.has(r.cntrNo)));
            if (curFilter === 'error') {
                filtered = filtered.filter(r => typeof getContainerStatus === 'function' ? getContainerStatus(filteredResults, r.cntrNo) === 'error' : true);
            } else if (curFilter === 'missing') {
                const chkFilterMissingExtra = document.getElementById('chkFilterMissingExtra');
                const chkFilterMissingMissing = document.getElementById('chkFilterMissingMissing');
                const showMissingExtra = chkFilterMissingExtra ? chkFilterMissingExtra.checked : true;
                const showMissingMissing = chkFilterMissingMissing ? chkFilterMissingMissing.checked : true;

                filtered = filtered.filter(r => {
                    const s = typeof getContainerStatus === 'function' ? getContainerStatus(filteredResults, r.cntrNo) : '';
                    if (s === 'extra') return showMissingExtra;
                    if (s === 'missing') return showMissingMissing;
                    return false;
                });
            } else if (curFilter === 'success') {
                filtered = filtered.filter(r => typeof getContainerStatus === 'function' ? getContainerStatus(filteredResults, r.cntrNo) === 'success' : true);
            }
        }

        // 추가 필터: 화면의 완료/작업중/대기 및 천마/BNI/기타 세부 체크박스 상태를 반영하여 필터링
        const chkFilterCompleted = document.getElementById('chkFilterCompleted');
        const chkFilterProgress = document.getElementById('chkFilterProgress');
        const chkFilterPending = document.getElementById('chkFilterPending');
        const chkFilterChunma = document.getElementById('chkFilterChunma');
        const chkFilterBni = document.getElementById('chkFilterBni');
        const chkFilterOtherTrans = document.getElementById('chkFilterOtherTrans');

        const showCompleted = chkFilterCompleted ? chkFilterCompleted.checked : false;
        const showProgress = chkFilterProgress ? chkFilterProgress.checked : false;
        const showPending = chkFilterPending ? chkFilterPending.checked : false;
        const showChunma = chkFilterChunma ? chkFilterChunma.checked : false;
        const showBni = chkFilterBni ? chkFilterBni.checked : false;
        const showOther = chkFilterOtherTrans ? chkFilterOtherTrans.checked : false;

        const anyStatusChecked = showCompleted || showProgress || showPending;
        const anyTransChecked = showChunma || showBni || showOther;

        if (curFilter === 'success' || curFilter === 'all') {
            const cntrGroup = {};
            filtered.forEach(r => {
                if (!cntrGroup[r.cntrNo]) cntrGroup[r.cntrNo] = [];
                cntrGroup[r.cntrNo].push(r);
            });

            const cntrStatus = {};
            const cntrTrans = {};

            for (const cntrNo in cntrGroup) {
                const rows = cntrGroup[cntrNo];
                
                // 상태 판별
                const allCompleted = rows.every(r => (r.type || '').includes('완료'));
                const allPending = rows.every(r => (r.type || '').includes('대기'));
                if (allCompleted) {
                    cntrStatus[cntrNo] = 'completed';
                } else if (allPending) {
                    cntrStatus[cntrNo] = 'pending';
                } else {
                    cntrStatus[cntrNo] = 'progress';
                }

                // 운송사 판별
                const isChunma = rows.some(r => (r.transporter || '').includes('천마'));
                const isBni = rows.some(r => (r.transporter || '').includes('BNI'));
                if (isChunma) {
                    cntrTrans[cntrNo] = 'chunma';
                } else if (isBni) {
                    cntrTrans[cntrNo] = 'bni';
                } else {
                    cntrTrans[cntrNo] = 'other';
                }
            }

            filtered = filtered.filter(r => {
                // 상태 필터 체크
                let passStatus = true;
                if (anyStatusChecked) {
                    const status = cntrStatus[r.cntrNo];
                    if (status === 'completed') passStatus = showCompleted;
                    else if (status === 'progress') passStatus = showProgress;
                    else if (status === 'pending') passStatus = showPending;
                }

                if (!passStatus) return false;

                // 운송사 필터 체크
                let passTrans = true;
                if (anyTransChecked) {
                    const trans = cntrTrans[r.cntrNo];
                    if (trans === 'chunma') passTrans = showChunma;
                    else if (trans === 'bni') passTrans = showBni;
                    else if (trans === 'other') passTrans = showOther;
                }
                return passTrans;
            });
        }
        exportData = filtered.map(r => ({
            type: r.type || '',
            cntrNo: r.cntrNo || '',
            division: r.division || '',
            prodType: r.prodType || '',
            prodName: r.prodName || '',
            planQty: (r.qtyInfo && r.qtyInfo.plan !== undefined) ? r.qtyInfo.plan : (r.planQty || 0),
            loadQty: (r.qtyInfo && r.qtyInfo.load !== undefined) ? r.qtyInfo.load : (r.loadQty || 0),
            pendingQty: (r.qtyInfo && r.qtyInfo.pending !== undefined) ? r.qtyInfo.pending : (r.pendingQty || 0),
            remainQty: (r.qtyInfo && r.qtyInfo.remain !== undefined) ? r.qtyInfo.remain : (r.remainQty || 0),
            cntrSize: (r.cntrType && r.cntrType.val !== undefined) ? r.cntrType.val : (r.cntrType || r.cntrSize || ''),
            dims: r.dims || '',
            carrier: (r.carrierName && r.carrierName.val !== undefined) ? r.carrierName.val : (r.carrierName || r.carrier || ''),
            dest: (r.destination && r.destination.val !== undefined) ? r.destination.val : (r.destination || r.dest || ''),
            mixedWeight: (r.weights && r.weights.mixed !== undefined) ? (parseFloat(r.weights.mixed) || 0) : (parseFloat(r.mixedWeight || r.weight) || 0),
            tags: Array.isArray(r.tags) ? r.tags.map(t => typeof t === 'object' ? `[${t.text || t.val || ''}]` : `[${t}]`).join(', ') : (r.tags || ''),
            detail: (r.detail || '').toString().replace(/<[^>]*>/g, ''),
            jobName: r.jobName || '',
            eta: r.eta || '',
            etd: r.etd || '',
            origRemark: r.origRemark || '',
            transporter: r.transporter || ''
        }));
    }

    ws.columns = columns;

    const applyHeaderStyle = (row) => {
        row.height = 30;
        row.eachCell({ includeEmpty: false }, (cell) => {
            cell.font = { name: 'LG Smart_Korean Regular', bold: true, color: { argb: 'FF000000' }, size: 10 };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
            cell.border = {
                top: { style: 'medium', color: { argb: 'FF000000' } },
                bottom: { style: 'medium', color: { argb: 'FF000000' } },
                left: { style: 'thin', color: { argb: 'FFDDDDDD' } },
                right: { style: 'thin', color: { argb: 'FFDDDDDD' } }
            };
        });
    };

    applyHeaderStyle(ws.getRow(1));
    let lastTransporter = null;

    exportData.forEach((data, idx) => {
        if (curFilter === 'entry' || curFilter === 'entry_unclassified') {
            if (lastTransporter !== null && lastTransporter !== data.transporter) {
                const headerRow = ws.addRow({
                    carrier: '선사', cntrType: '규격', dest: 'F.DEST', cntrNo: 'CTNR NO', sealNo: 'SEAL',
                    grossWeightCombined: '합산중량', origRemark: '모선항차 / 반입터미널', etd: '출항일', workDate: '작업일', transporter: '운송사'
                });
                applyHeaderStyle(headerRow);
            }
            lastTransporter = data.transporter;

            const cntrKeyExcel = (data.cntrNo || '').trim().toUpperCase();
            const popInfoExcel = (window.popWeightMap && window.popWeightMap[cntrKeyExcel]) ? window.popWeightMap[cntrKeyExcel] : null;
            const popWeightExcel = popInfoExcel ? (parseFloat(popInfoExcel.weight) || 0) : 0;
            const hasPopExcel = popWeightExcel > 0;

            if (hasPopExcel) {
                data.origRemark = `(POP : ${popWeightExcel.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}kg) ` + (data.origRemark || '');
                data.transporter = `${data.transporter}\n(POP : ${popWeightExcel.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}kg 포함)`;
            }

            const choiceExcel = (window.userSelectedWeights && window.userSelectedWeights[cntrKeyExcel]) ? window.userSelectedWeights[cntrKeyExcel] : null;
            if (!choiceExcel && (data.mixedWeight === null || (data.issueModels && data.issueModels.length > 0))) {
                let mismatchText = (data.issueModels || []).join('\n');
                if (hasPopExcel) mismatchText += `\n+POP: ${popWeightExcel.toFixed(2)}kg`;
                data.grossWeightCombined = mismatchText;
            } else {
                const wOrig = parseFloat(data.origWeight) || 0;
                const wDown = parseFloat(data.downWeight) || 0;
                const wMixed = parseFloat(data.mixedWeight) || 0;
                let baseWeightToUse = wMixed;
                let choiceNote = "";
                if (choiceExcel === 'orig') { baseWeightToUse = wOrig; choiceNote = " (원본선택)"; }
                else if (choiceExcel === 'down') { baseWeightToUse = wDown; choiceNote = " (전산선택)"; }
                const totalWeightFinal = baseWeightToUse + popWeightExcel;
                if (hasPopExcel) {
                    data.grossWeightCombined = `${totalWeightFinal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${choiceNote}\n(기본 ${baseWeightToUse.toFixed(2)} + POP ${popWeightExcel.toFixed(2)})`;
                } else {
                    data.grossWeightCombined = `${totalWeightFinal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${choiceNote}`;
                }
            }
        }

        const row = ws.addRow(data);
        row.height = (curFilter === 'entry' || curFilter === 'entry_unclassified') ? 35 : 18;

        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const columnKey = columns[colNumber - 1] ? columns[colNumber - 1].key : '';
            cell.font = { name: 'LG Smart_Korean Regular', size: 10 };
            if (columnKey === 'cntrNo') {
                const trans = (data.transporter || "").toString();
                if (trans.includes('천마')) cell.font = { name: 'LG Smart_Korean Regular', size: 10, bold: true, color: { argb: 'FFE74C3C' } };
                else if (trans.includes('BNI')) cell.font = { name: 'LG Smart_Korean Regular', size: 10, bold: true, color: { argb: 'FF3498DB' } };
            }
            cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        });

        if (curFilter === 'entry' || curFilter === 'entry_unclassified') {
            const weightCell = row.getCell('grossWeightCombined');
            if (weightCell) weightCell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
            const destCell = row.getCell('dest');
            if (destCell && !/^(US|CA)/i.test(String(data.dest))) destCell.font = { name: 'LG Smart_Korean Regular', color: { argb: 'FFFF0000' }, bold: true, size: 10 };
        } else {
            ['mixedWeight', 'planQty', 'loadQty'].forEach(key => {
                const cell = row.getCell(key);
                if (cell) {
                    cell.alignment = { horizontal: 'right', vertical: 'middle' };
                    cell.numFmt = '#,##0.00';
                }
            });
            const detailCell = row.getCell('detail');
            if (detailCell) detailCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
            const pt = (data.prodType || '').toUpperCase();
            if (pt === 'H' || pt === 'Q') {
                const hqColor = pt === 'H' ? 'FF7C3AED' : 'FF0D9488';
                const ptCell = row.getCell('prodType');
                const pnCell = row.getCell('prodName');
                if (ptCell) ptCell.font = { name: 'LG Smart_Korean Regular', size: 10, bold: true, color: { argb: hqColor } };
                if (pnCell) pnCell.font = { name: 'LG Smart_Korean Regular', size: 10, bold: true, color: { argb: hqColor } };
            }
        }
    });

    return wb;
}

/**
 * [추가] ArrayBuffer를 안전하고 빠르게 Base64로 변환
 */
function bufToBase64(buffer) {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(buffer).toString('base64');
    }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }
    return window.btoa(binary);
}

// 초기 데이터 로드 (setActiveTab 밖으로 이동 - initializeApp에서 수행되므로 전역 호출은 비활성화)
// loadCarrierMap();
// loadDynamicRules();

// --- HTML 이메일 서식 생성 공통 함수 ---
function generateEntryMailHtml(transporterName) {
    try {
        if (!displayData || displayData.length === 0) {
            alert('displayData가 비어있습니다.');
            return null;
        }

        const targetData = displayData.filter(item => {
            if (!item.transporter) return false;

            // 보류 필터
            const ck = (item.cntrNo || "").trim().toUpperCase();
            if (holdContainerMap.has(ck)) return false;

            const hasChoice = !!userSelectedWeights[item.cntrNo];
            const isCriticalMismatch = item.isCriticalWeightMismatch === true;

            // 오류 필터
            if (item.badgeClass === 'missing' || item.hasMissingModel === true || isCriticalMismatch) {
                return false;
            }

            if (item.isErrorRow === true && !hasChoice) {
                return false;
            }

            const cleanTrans = item.transporter.replace(/\(빨강\)|\(파랑\)/g, "").trim();
            const match = cleanTrans === transporterName;
            return match;
        });

        if (targetData.length === 0) {
            alert(transporterName + ' 조건에 맞는 전송 가능 데이터가 0건입니다.\n(오류/누락/중량미선택 건은 제외됨)');
            return null;
        }

        let htmlContent = `
            <div style="font-family: 'Malgun Gothic', 'Dotum', sans-serif; font-size: 13px; color: #334155;">
                <div style="margin-bottom: 20px; padding: 15px; background-color: #f1f5f9; border-radius: 8px; border: 1px solid #e2e8f0;">
                    <strong style="color: #475569;">수신:</strong> <span style="color: #2563eb; font-weight: bold;">[설정된 수신 주소]</span><br>
                    <strong style="color: #475569;">제목:</strong> [반입정보] ${transporterName} ...
                </div>
                <h3 style="margin-top: 25px; margin-bottom: 15px; color: #1e293b; border-left: 4px solid #4361ee; padding-left: 12px; font-size: 1.1rem;">${transporterName} 반입정보</h3>
                <table style="width: 100%; border-collapse: collapse; border: 1px solid #cbd5e1; text-align: center; font-size: 12px; table-layout: auto;">
                    <thead>
                        <tr style="background-color: #f8fafc; color: #334155; font-weight: bold;">
                            <th style="padding: 10px; border: 1px solid #cbd5e1; white-space: nowrap;">선사</th>
                            <th style="padding: 10px; border: 1px solid #cbd5e1; white-space: nowrap;">규격</th>
                            <th style="padding: 10px; border: 1px solid #cbd5e1; white-space: nowrap;">F.DEST</th>
                            <th style="padding: 10px; border: 1px solid #cbd5e1; white-space: nowrap;">CTNR NO</th>
                            <th style="padding: 10px; border: 1px solid #cbd5e1; white-space: nowrap;">SEAL</th>
                            <th style="padding: 10px; border: 1px solid #cbd5e1; text-align: right; white-space: nowrap;">G/W</th>
                            <th style="padding: 10px; border: 1px solid #cbd5e1;">모선항차 / 반입터미널</th>
                            <th style="padding: 10px; border: 1px solid #cbd5e1; white-space: nowrap;">출항일</th>
                            <th style="padding: 10px; border: 1px solid #cbd5e1; white-space: nowrap;">작업일</th>
                            <th style="padding: 10px; border: 1px solid #cbd5e1; white-space: nowrap;">운송사</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        targetData.forEach(item => {
            const carrier = item.carrierName ? (item.carrierName.val || item.carrierName) : '-';
            const type = item.cntrType ? (item.cntrType.val || item.cntrType) : '-';
            const dest = item.destination ? (item.destination.val || item.destination) : '-';
            const cntrKeyMail = (item.cntrNo || '').trim().toUpperCase();
            const popInfoMail = popWeightMap[cntrKeyMail];
            const popWeightMail = popInfoMail ? (parseFloat(popInfoMail.weight) || 0) : 0;
            const hasPopMail = popWeightMail > 0;

            const choiceMail = userSelectedWeights[cntrKeyMail];
            const baseWeightMail = item.selectedTotalWeight || (item.weights ? (parseFloat(item.weights.mixed) || 0) : 0);
            const weight = (baseWeightMail + popWeightMail).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const choiceNoteMail = choiceMail ? ` (${choiceMail === 'orig' ? '원본' : '전산'}선택)` : '';

            let remarkMail = item.origRemark || '-';
            if (hasPopMail) {
                remarkMail = `<span style="color:#ea580c; font-weight:bold;">(POP : ${popWeightMail.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}kg)</span> ` + remarkMail;
            }

            let displayEtd = item.etd || '-';
            if (displayEtd instanceof Date || (typeof displayEtd === 'string' && displayEtd.includes('GMT'))) {
                try {
                    const d = new Date(displayEtd);
                    displayEtd = `${d.getMonth() + 1}월 ${d.getDate()}일`;
                } catch (e) { }
            }

            const today = new Date();
            const displayWorkDate = `${today.getMonth() + 1}월 ${today.getDate()}일`;

            let displayTransporter = item.transporter || '-';
            if (hasPopMail) {
                displayTransporter += `<br><span style="color:#ea580c; font-size:11px; font-weight:bold;">(POP : ${popWeightMail.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}kg 포함)</span>`;
            }

            htmlContent += `
                <tr style="border: 1px solid #cbd5e1;">
                    <td style="padding: 6px; border: 1px solid #cbd5e1; color: ${carrier === 'ONE' ? '#db2777' : '#059669'}; font-weight: bold;">${carrier}</td>
                    <td style="padding: 6px; border: 1px solid #cbd5e1;">${type}</td>
                    <td style="padding: 6px; border: 1px solid #cbd5e1;">${dest}</td>
                    <td style="padding: 6px; border: 1px solid #cbd5e1; font-weight: bold; color: #0f172a;">${item.cntrNo || '-'}</td>
                    <td style="padding: 6px; border: 1px solid #cbd5e1;">${item.sealNo || '-'}</td>
                    <td style="padding: 6px; border: 1px solid #cbd5e1; text-align: right;">${weight}${choiceNoteMail}</td>
                    <td style="padding: 6px; border: 1px solid #cbd5e1;">${remarkMail}</td>
                    <td style="padding: 6px; border: 1px solid #cbd5e1;">${displayEtd}</td>
                    <td style="padding: 6px; border: 1px solid #cbd5e1;">${displayWorkDate}</td>
                    <td style="padding: 6px; border: 1px solid #cbd5e1;">${displayTransporter}</td>
                </tr>
            `;
        });

        htmlContent += `
                    </tbody>
                </table>
                <p style="margin-top: 10px; color: #64748b; font-size: 12px;">총 ${targetData.length}건</p>
            </div>
        `;
        return { html: htmlContent, count: targetData.length, targetData: targetData };
    } catch (err) {
        alert('HTML 생성 중 에러 발생: ' + err.message);
        console.error(err);
        return null;
    }
}

// --- HTML 이메일 복사 기능 ---
async function copyEntryToClipboard(transporterName) {
    const result = generateEntryMailHtml(transporterName);
    if (!result) {
        // generateEntryMailHtml 내부에서 alert가 뜰 것이므로 여기선 그냥 리턴
        return;
    }
    const htmlContent = result.html;

    // Fallback 로직을 포함한 클립보드 복사
    try {
        if (navigator.clipboard && window.ClipboardItem) {
            const clipboardItem = new ClipboardItem({
                'text/html': new Blob([htmlContent], { type: 'text/html' }),
                'text/plain': new Blob(['HTML 포맷으로 복사되었습니다.'], { type: 'text/plain' })
            });
            await navigator.clipboard.write([clipboardItem]);
            alert(`${transporterName} 메일 서식이 복사되었습니다.\n아웃룩이나 이메일 본문에 붙여넣기(Ctrl + V) 하세요.`);
        } else {
            throw new Error("ClipboardItem API not supported");
        }
    } catch (err) {
        console.warn('Modern clipboard API failed, trying fallback...', err);
        const tempDiv = document.createElement('div');
        tempDiv.contentEditable = true;
        tempDiv.innerHTML = htmlContent;
        tempDiv.style.position = 'fixed';
        tempDiv.style.left = '-9999px';
        document.body.appendChild(tempDiv);

        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(tempDiv);
        selection.removeAllRanges();
        selection.addRange(range);

        try {
            document.execCommand('copy');
            alert(`${transporterName} 메일 서식이 복사되었습니다. (Fallback Mode)`);
        } catch (fallbackErr) {
            console.error('Fallback clipboard copy failed:', fallbackErr);
            alert('복사 중 오류가 발생했습니다.');
        } finally {
            document.body.removeChild(tempDiv);
            selection.removeAllRanges();
        }
    }
}

// --- 이메일 설정 및 발송 관리 ---
const emailSettingsModal = document.getElementById('emailSettingsModal');
const btnOpenEmailSettings = document.getElementById('btnOpenEmailSettings');
const closeEmailSettingsBtn = document.getElementById('closeEmailSettingsBtn');
const closeEmailSettingsBottomBtn = document.getElementById('closeEmailSettingsBottomBtn');
const btnSaveEmailConfig = document.getElementById('btnSaveEmailConfig');

// 미리보기 모달 엘리먼트
const emailPreviewModal = document.getElementById('emailPreviewModal');
const closeEmailPreviewBtn = document.getElementById('closeEmailPreviewBtn');
const closeEmailPreviewBottomBtn = document.getElementById('closeEmailPreviewBottomBtn');
const btnConfirmSendEmail = document.getElementById('btnConfirmSendEmail');
const emailPreviewContent = document.getElementById('emailPreviewContent');
const previewToAddress = document.getElementById('previewToAddress');

// 전역 변수로 현재 발송 대기 데이터 저장
let currentPendingEmail = null;

// 모달 토글
if (btnOpenEmailSettings) {
    btnOpenEmailSettings.addEventListener('click', async () => {
        emailSettingsModal.style.display = 'block';
        await loadEmailConfig();
    });
}
[closeEmailSettingsBtn, closeEmailSettingsBottomBtn].forEach(btn => {
    if (btn) {
        btn.onclick = async () => {
            // 모달을 닫을 때 이메일 설정을 자동으로 파일에 저장합니다. (사용자가 닫기 버튼만 눌러도 자동 저장)
            await saveEmailConfig(false);
            emailSettingsModal.style.display = 'none';
        };
    }
});

// 미리보기 모달 닫기
[closeEmailPreviewBtn, closeEmailPreviewBottomBtn].forEach(btn => {
    if (btn) btn.onclick = () => {
        emailPreviewModal.style.display = 'none';
        // 전체화면 상태였다면 리셋
        const content = emailPreviewModal.querySelector('.modal-content');
        if (content) content.classList.remove('fullscreen-modal');
    };
});

// 전체화면 토글
const btnToggleEmailFullscreen = document.getElementById('btnToggleEmailFullscreen');
if (btnToggleEmailFullscreen) {
    btnToggleEmailFullscreen.addEventListener('click', () => {
        const content = emailPreviewModal.querySelector('.modal-content');
        const icon = btnToggleEmailFullscreen.querySelector('i');
        if (content.style.width === '100%' && content.style.height === '100%') {
            content.style.width = '1400px';
            content.style.height = '90vh';
            content.style.maxWidth = '98%';
            icon.className = 'fas fa-expand';
        } else {
            content.style.width = '100%';
            content.style.height = '100%';
            content.style.maxWidth = '100%';
            icon.className = 'fas fa-compress';
        }
    });
}

async function loadEmailConfig() {
    try {
        const res = await fetch(`${API_BASE}/api/email/config`);
        const data = await res.json();
        if (data.success && data.config) {
            document.getElementById('emailSmtpHost').value = data.config.host || '';
            document.getElementById('emailSmtpPort').value = data.config.port || 465;
            document.getElementById('emailSmtpSecure').checked = data.config.secure !== false;
            document.getElementById('emailSmtpUser').value = data.config.user || '';
            document.getElementById('emailSmtpPass').value = data.config.pass || '';
            // 분리된 수신 주소 로드
            if (document.getElementById('emailChunmaTo')) {
                document.getElementById('emailChunmaTo').value = data.config.toChunma || '';
            }
            if (document.getElementById('emailBniTo')) {
                document.getElementById('emailBniTo').value = data.config.toBni || '';
            }
            if (document.getElementById('emailChunmaSubject')) {
                document.getElementById('emailChunmaSubject').value = data.config.subjectChunma || '';
            }
            if (document.getElementById('emailBniSubject')) {
                document.getElementById('emailBniSubject').value = data.config.subjectBni || '';
            }
        }
    } catch (err) {
        console.error('이메일 설정 로드 실패:', err);
    }
}

async function saveEmailConfig(showSuccessAlert = true) {
    const hostEl = document.getElementById('emailSmtpHost');
    const portEl = document.getElementById('emailSmtpPort');
    const secureEl = document.getElementById('emailSmtpSecure');
    const userEl = document.getElementById('emailSmtpUser');
    const passEl = document.getElementById('emailSmtpPass');
    const toChunmaEl = document.getElementById('emailChunmaTo');
    const toBniEl = document.getElementById('emailBniTo');
    const subjectChunmaEl = document.getElementById('emailChunmaSubject');
    const subjectBniEl = document.getElementById('emailBniSubject');

    const config = {
        host: hostEl ? hostEl.value : '',
        port: portEl ? (parseInt(portEl.value) || 465) : 465,
        secure: secureEl ? secureEl.checked : true,
        user: userEl ? userEl.value : '',
        pass: passEl ? passEl.value : '',
        toChunma: toChunmaEl ? toChunmaEl.value : '',
        toBni: toBniEl ? toBniEl.value : '',
        subjectChunma: subjectChunmaEl ? subjectChunmaEl.value : '',
        subjectBni: subjectBniEl ? subjectBniEl.value : ''
    };

    try {
        const res = await fetch(`${API_BASE}/api/email/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        const data = await res.json();
        if (data.success) {
            if (showSuccessAlert) alert('이메일 설정이 성공적으로 저장되었습니다.');
            return true;
        } else {
            if (showSuccessAlert) alert('저장 실패: ' + data.message);
            return false;
        }
    } catch (err) {
        if (showSuccessAlert) console.error('이메일 설정 자동 저장 실패:', err);
        return false;
    }
}

if (btnSaveEmailConfig) {
    btnSaveEmailConfig.addEventListener('click', async () => {
        const success = await saveEmailConfig(true);
        if (success) emailSettingsModal.style.display = 'none';
    });
}

// --- 이메일 설정 서버 동기화 (업로드/다운로드) ---
const btnUploadEmailConfig = document.getElementById('btnUploadEmailConfig');
if (btnUploadEmailConfig) {
    btnUploadEmailConfig.addEventListener('click', async () => {
        if (!confirm('현재 화면의 설정을 서버 DB에 백업하시겠습니까?\n(나중에 다른 PC에서 동일하게 불러올 수 있습니다.)')) return;

        try {
            // 먼저 설정을 서버에 저장(파일)한 후, 서버가 그 파일을 읽어서 DB에 올리도록 요청
            const resp = await fetch(`${API_BASE}/api/sync/email-config`, { method: 'POST' });
            const data = await resp.json();
            if (data.success) {
                alert('✅ 백업 성공! 이메일 설정이 서버 DB에 백업되었습니다.');
            } else {
                alert('❌ 백업 실패: ' + data.message);
            }
        } catch (err) {
            alert('백업 중 오류 발생: ' + err.message);
        }
    });
}

const btnDownloadEmailConfig = document.getElementById('btnDownloadEmailConfig');
if (btnDownloadEmailConfig) {
    btnDownloadEmailConfig.addEventListener('click', async () => {
        if (!confirm('서버 DB에서 설정을 불러와 현재 설정을 덮어쓰시겠습니까?')) return;

        try {
            const resp = await fetch(`${API_BASE}/api/sync/email-config`);
            const data = await resp.json();
            if (data.success && data.config) {
                // 내려받은 설정을 로컬 파일로 먼저 저장
                const saveResp = await fetch(`${API_BASE}/api/email/config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data.config)
                });
                const saveData = await saveResp.json();

                if (saveData.success) {
                    alert('✅ 복구 성공! 서버에서 백업 설정을 불러왔습니다.');
                    await loadEmailConfig(); // 화면 갱신
                } else {
                    alert('❌ 복구 실패(저장오류): ' + saveData.message);
                }
            } else {
                alert('❌ 복구 실패: ' + (data.message || '데이터를 찾을 수 없습니다.'));
            }
        } catch (err) {
            alert('복구 중 오류 발생: ' + err.message);
        }
    });
}

// 즉시 발송 함수
async function sendEntryMailDirect(transporterName) {
    try {
        const result = generateEntryMailHtml(transporterName);
        if (!result) return;

        const today = new Date();
        const dateStr = `${today.getMonth() + 1}/${today.getDate()}`;

        let subject = '';
        try {
            const cfgRes = await fetch(`${API_BASE}/api/email/config`);
            const cfgData = await cfgRes.json();
            if (cfgData.config) {
                targetEmail = (transporterName === '천마') ? cfgData.config.toChunma : cfgData.config.toBni;
                subject = (transporterName === '천마') ? cfgData.config.subjectChunma : cfgData.config.subjectBni;
            }
        } catch (e) {
            console.error('설정 로드 실패:', e);
        }

        if (!targetEmail || !targetEmail.includes('@')) {
            alert(`메일 설정에서 [${transporterName} 메일 받는 사람] 주소를 입력하고 저장한 뒤 다시 시도해 주세요.`);
            return;
        }

        // 제목 형식이 없으면 기본값 사용
        if (!subject || subject.trim() === "") {
            subject = `[반입정보] ${transporterName} - {date} 작업분 ({count}건)`;
        }

        // 예약어 치환
        subject = subject.replace(/{date}/g, dateStr)
            .replace(/{count}/g, result.count)
            .replace(/{transporter}/g, transporterName);

        currentPendingEmail = {
            to: targetEmail,
            subject: subject,
            html: result.html,
            transporterName: transporterName,
            targetData: result.targetData
        };

        // 수신 정보를 HTML 상단에 추가하여 미리보기 구성
        const previewHtml = `
            <div style="margin-bottom: 25px; padding: 15px; background: #f0f7ff; border-radius: 10px; border: 1px solid #cfe2ff; font-family: sans-serif;">
                <div style="margin-bottom: 5px;"><strong style="color: #0056b3;">[발송 대상 정보]</strong></div>
                <div style="font-size: 0.95rem; color: #334155;">
                    • <b>받는 사람:</b> <span style="color: #2563eb;">${targetEmail}</span><br>
                    • <b>메일 제목:</b> ${subject}
                </div>
            </div>
            <hr style="border: 0; border-top: 1px dashed #e2e8f0; margin: 25px 0;">
            ${result.html}
        `;

        emailPreviewContent.innerHTML = previewHtml;
        emailPreviewModal.style.display = 'block';

    } catch (err) {
        alert('발송 준비 중 오류가 발생했습니다: ' + err.message);
        console.error(err);
    }
}

// 미리보기 모달에서 최종 발송 버튼 클릭 시
if (btnConfirmSendEmail) {
    btnConfirmSendEmail.onclick = async () => {
        if (!currentPendingEmail) return;

        const { to, subject, html, transporterName } = currentPendingEmail;

        emailPreviewModal.style.display = 'none'; // 모달 닫기

        const btn = (transporterName === '천마' ? btnSendChunma : btnSendBni);
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 발송 중...';
        btn.disabled = true;

        try {
            const res = await fetch(`${API_BASE}/api/send-email`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    to: to,
                    subject: subject,
                    html: html
                })
            });
            const data = await res.json();

            if (data.success) {
                alert(`${transporterName} 메일이 ${to} 로 성공적으로 발송되었습니다.`);
            } else {
                alert('발송 실패: ' + data.message);
            }
        } catch (err) {
            alert('발송 프로세스 중 오류가 발생했습니다: ' + err.message);
        } finally {
            if (btn) {
                btn.innerHTML = (transporterName === '천마' ?
                    '<i class="fas fa-paper-plane" style="margin-right: 4px;"></i>천마 즉시 발송' :
                    '<i class="fas fa-paper-plane" style="margin-right: 4px;"></i>BNI 즉시 발송');
                btn.disabled = false;
            }
            currentPendingEmail = null;
        }
    };
}

if (btnCopyChunma) {
    btnCopyChunma.addEventListener('click', () => copyEntryToClipboard('천마'));
}
if (btnSendChunma) {
    btnSendChunma.addEventListener('click', () => sendEntryMailDirect('천마'));
}

if (btnCopyBni) {
    btnCopyBni.addEventListener('click', () => copyEntryToClipboard('BNI'));
}
if (btnSendBni) {
    btnSendBni.addEventListener('click', () => sendEntryMailDirect('BNI'));
}

// 엑셀로 열기 로직
const btnOpenEmailPreviewExcel = document.getElementById('btnOpenEmailPreviewExcel');
if (btnOpenEmailPreviewExcel) {
    btnOpenEmailPreviewExcel.addEventListener('click', async () => {
        if (!currentPendingEmail || !currentPendingEmail.targetData) return;
        
        try {
            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('반입정보');

            // 헤더 추가
            ws.columns = [
                { header: '선사', key: 'carrier', width: 10 },
                { header: '규격', key: 'type', width: 10 },
                { header: 'F.DEST', key: 'dest', width: 12 },
                { header: 'CTNR NO', key: 'cntrNo', width: 18 },
                { header: 'SEAL', key: 'sealNo', width: 15 },
                { header: 'G/W', key: 'weight', width: 15 },
                { header: '모선항차 / 반입터미널', key: 'remark', width: 55 },
                { header: '출항일', key: 'etd', width: 12 },
                { header: '작업일', key: 'workDate', width: 12 },
                { header: '운송사', key: 'transporter', width: 25 }
            ];

            // 데이터 채우기
            currentPendingEmail.targetData.forEach(item => {
                const carrier = item.carrierName ? (item.carrierName.val || item.carrierName) : '-';
                const type = item.cntrType ? (item.cntrType.val || item.cntrType) : '-';
                const dest = item.destination ? (item.destination.val || item.destination) : '-';
                const cntrKeyMail = (item.cntrNo || '').trim().toUpperCase();
                const popInfoMail = popWeightMap[cntrKeyMail];
                const popWeightMail = popInfoMail ? (parseFloat(popInfoMail.weight) || 0) : 0;
                const hasPopMail = popWeightMail > 0;

                const choiceMail = userSelectedWeights[cntrKeyMail];
                const baseWeightMail = item.selectedTotalWeight || (item.weights ? (parseFloat(item.weights.mixed) || 0) : 0);
                const weightStr = (baseWeightMail + popWeightMail).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (choiceMail ? ` (${choiceMail === 'orig' ? '원본' : '전산'}선택)` : '');

                let remarkVal = item.origRemark || '-';
                let remarkRich = null;
                if (hasPopMail) {
                    remarkRich = {
                        richText: [
                            { font: { color: { argb: 'FFEA580C' }, bold: true }, text: `(POP : ${popWeightMail.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}kg) ` },
                            { font: { color: { argb: 'FF000000' } }, text: remarkVal }
                        ]
                    };
                }

                let displayEtd = item.etd || '-';
                if (displayEtd instanceof Date || (typeof displayEtd === 'string' && displayEtd.includes('GMT'))) {
                    try {
                        const d = new Date(displayEtd);
                        displayEtd = `${d.getMonth() + 1}월 ${d.getDate()}일`;
                    } catch (e) { }
                }

                const today = new Date();
                const displayWorkDate = `${today.getMonth() + 1}월 ${today.getDate()}일`;

                let transVal = item.transporter || '-';
                let transRich = null;
                if (hasPopMail) {
                    transRich = {
                        richText: [
                            { font: { color: { argb: 'FF000000' } }, text: transVal + '\n' },
                            { font: { color: { argb: 'FFEA580C' }, bold: true, size: 10 }, text: `(POP : ${popWeightMail.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}kg 포함)` }
                        ]
                    };
                }

                const row = ws.addRow({
                    carrier: carrier,
                    type: type,
                    dest: dest,
                    cntrNo: item.cntrNo || '-',
                    sealNo: item.sealNo || '-',
                    weight: weightStr,
                    remark: remarkRich || remarkVal,
                    etd: displayEtd,
                    workDate: displayWorkDate,
                    transporter: transRich || transVal
                });

                // 각 셀의 기본 정렬(가운데) 및 테두리 설정
                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                    cell.border = {
                        top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                        bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
                    };
                    
                    if (colNumber === 6) {
                        cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
                    } else {
                        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
                    }

                    // 선사 색상 처리 (첫 번째 열)
                    if (colNumber === 1) {
                        cell.font = {
                            bold: true,
                            color: { argb: carrier === 'ONE' ? 'FFDB2777' : 'FF059669' }
                        };
                    }
                    
                    // 컨테이너 번호 처리 (네 번째 열)
                    if (colNumber === 4) {
                        cell.font = Object.assign(cell.font || {}, { bold: true, color: { argb: 'FF0F172A' } });
                    }
                });
            });

            // 헤더 스타일 설정
            ws.getRow(1).eachCell((cell) => {
                cell.font = { bold: true, color: { argb: 'FF334155' } };
                cell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFF8FAFC' }
                };
                cell.alignment = { vertical: 'middle', horizontal: 'center' };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                    left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                    bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                    right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
                };
            });

            const buffer = await wb.xlsx.writeBuffer();
            
            const now = new Date();
            const dateStr = `${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2,'0')}${now.getDate().toString().padStart(2,'0')}`;
            const fileName = `${currentPendingEmail.transporterName}_반입정보_미리보기_${dateStr}.xlsx`;
            
            if (window.isElectron && window.electronAPI && window.electronAPI.openTempExcel) {
                const result = await window.electronAPI.openTempExcel(buffer, fileName);
                if (!result.success) {
                    alert('엑셀 파일을 여는 데 실패했습니다: ' + result.error);
                }
            } else {
                // 브라우저 환경 등 Electron 밖일 경우 fallback (다운로드)
                const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                saveAs(blob, fileName);
            }
        } catch (err) {
            console.error('엑셀 열기 실패:', err);
            alert('엑셀 파일을 생성하는 중 오류가 발생했습니다.');
        }
    });
}

// 이미지 다운로드 로직
const btnDownloadEmailPreviewImage = document.getElementById('btnDownloadEmailPreviewImage');
if (btnDownloadEmailPreviewImage) {
    btnDownloadEmailPreviewImage.addEventListener('click', async () => {
        if (!currentPendingEmail || !currentPendingEmail.transporterName) return;
        
        try {
            // 스크롤 영역 잘림 방지를 위한 임시 스타일 변경
            const originalOverflow = emailPreviewContent.style.overflow;
            const originalHeight = emailPreviewContent.style.height;
            const originalMaxHeight = emailPreviewContent.style.maxHeight;

            emailPreviewContent.style.overflow = 'visible';
            emailPreviewContent.style.height = 'auto';
            emailPreviewContent.style.maxHeight = 'none';

            const canvas = await html2canvas(emailPreviewContent, {
                scale: 2, // 고해상도
                useCORS: true,
                backgroundColor: '#ffffff',
                windowWidth: emailPreviewContent.scrollWidth,
                windowHeight: emailPreviewContent.scrollHeight
            });

            // 스타일 원상 복구
            emailPreviewContent.style.overflow = originalOverflow;
            emailPreviewContent.style.height = originalHeight;
            emailPreviewContent.style.maxHeight = originalMaxHeight;

            const imgData = canvas.toDataURL('image/png');
            
            const a = document.createElement('a');
            a.href = imgData;
            
            const now = new Date();
            const dateStr = `${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2,'0')}${now.getDate().toString().padStart(2,'0')}`;
            a.download = `${currentPendingEmail.transporterName}_반입정보_미리보기_${dateStr}.png`;
            
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } catch (err) {
            console.error('이미지 다운로드 실패:', err);
            alert('이미지 다운로드 중 오류가 발생했습니다.');
        }
    });
}

// --- 검색 기능 이벤트 리스너 ---
const inputSearch = document.getElementById('inputSearch');
if (inputSearch) {
    inputSearch.addEventListener('input', () => {
        if (comparisonResult.length > 0) displayResults(comparisonResult);
    });
}
const inputProdSearch = document.getElementById('inputProdSearch');
if (inputProdSearch) {
    inputProdSearch.addEventListener('input', () => {
        if (comparisonResult.length > 0) displayResults(comparisonResult);
    });
}
const btnResetSearch = document.getElementById('btnResetSearch');
if (btnResetSearch) {
    btnResetSearch.addEventListener('click', () => {
        if (inputSearch) inputSearch.value = '';
        if (inputProdSearch) inputProdSearch.value = '';
        if (selectProdType) selectProdType.value = '';
        if (comparisonResult.length > 0) displayResults(comparisonResult);
    });
}

const selectProdType = document.getElementById('selectProdType');
if (selectProdType) {
    selectProdType.addEventListener('change', () => {
        if (comparisonResult.length > 0) displayResults(comparisonResult);
    });
}

/**
 * 검색 필터 상태에 따라 초기화 버튼 색상을 변경하고 검색 건수를 표시함
 */
function refreshSearchUI() {
    const btnReset = document.getElementById('btnResetSearch');
    const inSearch = document.getElementById('inputSearch');
    const inProdSearch = document.getElementById('inputProdSearch');
    const selProdType = document.getElementById('selectProdType');
    const resultCountSpan = document.getElementById('searchResultCount');

    if (!btnReset) return;

    const hasValue = (inSearch && inSearch.value.trim() !== '') ||
        (inProdSearch && inProdSearch.value.trim() !== '') ||
        (selProdType && selProdType.value !== '');

    if (hasValue) {
        // 검색 값이 있으면 버튼 강조 (인디고 색상)
        btnReset.style.backgroundColor = '#6366f1';
        btnReset.style.color = 'white';
        btnReset.style.borderColor = '#4f46e5';
    } else {
        // 검색 값이 없으면 기본 스타일
        btnReset.style.backgroundColor = 'white';
        btnReset.style.color = '#475569';
        btnReset.style.borderColor = '#cbd5e1';
    }

    if (resultCountSpan) {
        if (hasValue && typeof displayData !== 'undefined' && displayData.length >= 0) {
            // 컨테이너 개수 기준으로 표시
            const uniqueCntrs = new Set(displayData.map(d => d.cntrNo)).size;
            resultCountSpan.textContent = `${uniqueCntrs}건 검색됨`;
            resultCountSpan.style.display = 'inline';
        } else {
            resultCountSpan.style.display = 'none';
        }
    }
}
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        const inputSearch = document.getElementById('inputSearch');
        if (inputSearch) {
            e.preventDefault();
            inputSearch.focus();
            inputSearch.select();
        }
    }
});

// --- DB 기능 이벤트 리스너 (위에서 통합 처리됨) ---

function updateSelectionUI() {
    const selectedCountSpan = document.getElementById('selectedCount');
    const selectionBar = document.getElementById('selectionBar');
    const selectAllChk = document.getElementById('selectAll');

    if (selectedCountSpan) selectedCountSpan.textContent = selectedItems.size;

    if (selectionBar) {
        // 검색 기능은 컨테이너 데이터(comparisonResult)가 있을 때 계속 표시되어야 함 (사용자 입력 유지 목적)
        const isDbSearchTab = (currentFilter === 'dbSearch');
        selectionBar.style.display = (!isDbSearchTab && (comparisonResult.length > 0)) ? 'flex' : 'none';
    }

    if (selectAllChk && displayData.length > 0) {
        let allVisibleSelected = true;
        for (let i = 0; i < displayData.length; i++) {
            const key = `${displayData[i].cntrNo}_${displayData[i].prodName}_${i}`;
            if (!selectedItems.has(key)) {
                allVisibleSelected = false;
                break;
            }
        }
        selectAllChk.checked = allVisibleSelected;
    } else if (selectAllChk) {
        selectAllChk.checked = false;
    }

    // 보류 탭인 경우 버튼 텍스트 변경
    const btnBulkHold = document.getElementById('btnBulkHold');
    if (btnBulkHold) {
        if (currentFilter === 'hold') {
            btnBulkHold.innerHTML = '<i class="fas fa-play-circle" style="margin-right: 4px;"></i> 선택항목 보류해제';
            btnBulkHold.style.background = '#f8fafc';
            btnBulkHold.style.color = '#475569';
        } else {
            btnBulkHold.innerHTML = '<i class="fas fa-pause-circle" style="margin-right: 4px;"></i> 선택항목 보류등록';
            btnBulkHold.style.background = ''; // CSS 클래스 기본값 사용
            btnBulkHold.style.color = '';
        }
    }
}

const selectAllChk = document.getElementById('selectAll');
if (selectAllChk) {
    selectAllChk.onclick = () => {
        if (selectAllChk.checked) {
            displayData.forEach((res, i) => {
                const itemKey = `${res.cntrNo}_${res.prodName}_${i}`;
                selectedItems.add(itemKey);
            });
        } else {
            selectedItems.clear();
        }
        displayResults(comparisonResult);
        updateSelectionUI();
    };
}

// --- 원격 DB 동기화 토글 스위치 동작 ---
const chkRemoteSync = document.getElementById('chkRemoteSync');
const remoteSyncStatusText = document.getElementById('remoteSyncStatusText');
if (chkRemoteSync) {
    const sliderBg = chkRemoteSync.nextElementSibling;
    const sliderDot = sliderBg ? sliderBg.nextElementSibling : null;
    function updateToggleVisual() {
        if (chkRemoteSync.checked) {
            if (sliderBg) sliderBg.style.backgroundColor = '#0284c7';
            if (sliderDot) sliderDot.style.transform = 'translateX(20px)';
            if (remoteSyncStatusText) { remoteSyncStatusText.textContent = 'ON'; remoteSyncStatusText.style.color = '#0284c7'; }
        } else {
            if (sliderBg) sliderBg.style.backgroundColor = '#cbd5e1';
            if (sliderDot) sliderDot.style.transform = 'translateX(0)';
            if (remoteSyncStatusText) { remoteSyncStatusText.textContent = 'OFF'; remoteSyncStatusText.style.color = '#94a3b8'; }
        }
    }
    updateToggleVisual();
    chkRemoteSync.addEventListener('change', updateToggleVisual);
}

// --- 제품 마스터 데이터 정리 (오래된/미사용 데이터) ---
const btnCleanOldMaster = document.getElementById('btnCleanOldMaster');
if (btnCleanOldMaster) {
    btnCleanOldMaster.onclick = async () => {
        // Electron renderer에서 prompt()는 지원되지 않거나 불안정하므로 confirm()으로 대체
        const days = '30';
        if (!confirm(`최근 ${days}일 동안 한 번도 사용되지 않았고 업데이트도 없는 제품을 마스터 DB에서 삭제하시겠습니까?\n(20만건 이상의 대량 DB 관리를 위해 권장됩니다.)`)) return;

        try {
            const resp = await fetch(`${API_BASE}/api/master-data/clean`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ days: parseInt(days) })
            });
            const data = await resp.json();
            alert(data.message);
            loadProductMaster();
            if (window.updateDbGlobalStats) window.updateDbGlobalStats();
        } catch (err) {
            alert('데이터 정리 중 오류 발생: ' + err.message);
        }
    };
}


const btnResetMasterDb = document.getElementById('btnResetMasterDb');
if (btnResetMasterDb) {
    btnResetMasterDb.onclick = async () => {
        // prompt() 대신 이중 confirm()으로 안전하게 확인
        if (!confirm('정말로 DB의 모든 마스터 데이터를 삭제하고 초기화하시겠습니까?')) return;
        if (!confirm('다시 한번 확인합니다. 이 작업은 되돌릴 수 없습니다. 진행하시겠습니까?')) return;

        try {
            const resp = await fetch(`${API_BASE}/api/master-data/reset`, { method: 'POST' });
            const data = await resp.json();
            alert(data.message);
            loadProductMaster();
            if (window.updateDbGlobalStats) window.updateDbGlobalStats();
        } catch (err) {
            alert('초기화 중 오류 발생: ' + err.message);
        }
    };
}

/* =========================================================================
 *  AUTOMATIC DB SAVING FOR SUCCESS CONTAINERS
 * ========================================================================= */
async function autoSaveSuccessContainers(results) {
    if (!results || results.length === 0) return;

    // 정상 컨테이너 항목만 추출 (보류 제외)
    // getContainerStatus는 내부적으로 rows.every/some을 사용하므로 동일 컨테이너의 모든 행이 성공인 경우만 'success' 반환
    const itemsToSave = results.filter(r => {
        const ck = (r.cntrNo || "").trim().toUpperCase();
        if (holdContainerMap.has(ck)) return false;
        return getContainerStatus(results, r.cntrNo) === 'success';
    });

    if (itemsToSave.length === 0) {
        console.log("📡 [Auto-Save] 저장할 정상 컨테이너 항목이 없습니다.");
        return;
    }

    console.log(`📡 [Auto-Save] ${itemsToSave.length}개의 정상 항목 자동 저장 시도...`);

    try {
        const enableRemoteSync = document.getElementById('chkRemoteSync')?.checked ?? true;
        const resp = await fetch(`${API_BASE}/api/save-to-db`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: itemsToSave, enableRemoteSync })
        });
        const resData = await resp.json();

        if (resData.success) {
            const msg = resData.message || `정상 컨테이너 ${resData.count}건이 자동 저장되었습니다.`;
            showToast(`✅ ${msg}`);
            if (typeof updateDbGlobalStats === 'function') updateDbGlobalStats();
        } else {
            console.error('❌ [Auto-Save] 저장 실패:', resData.message);
        }
    } catch (err) {
        console.error('❌ [Auto-Save] 서버 통신 오류:', err.message);
    }
}

const btnRefreshPhotos = document.getElementById('btnRefreshPhotos');
if (btnRefreshPhotos) {
    btnRefreshPhotos.onclick = async () => {
        const icon = btnRefreshPhotos.querySelector('i');
        if (icon) icon.classList.add('fa-spin');
        btnRefreshPhotos.disabled = true;

        try {
            if (window.fetchContainerPhotoCounts) {
                await window.fetchContainerPhotoCounts();
            }
            if (typeof displayResults === 'function' && typeof comparisonResult !== 'undefined' && Array.isArray(comparisonResult)) {
                displayResults(comparisonResult);
            }
            // 사진보관함 모달이 열려있다면 내부 목록도 새로고침
            const modal = document.getElementById('photoGalleryModal');
            if (modal && modal.style.display !== 'none' && typeof window.loadPhotoGallery === 'function') {
                await window.loadPhotoGallery(window.currentGalleryTargetCntr);
            }
            if (typeof showToast === 'function') {
                showToast('📸 최신 사진 업로드 현황이 새로고침되었습니다.');
            }
        } catch (err) {
            console.error("사진 현황 새로고침 오류:", err);
            if (typeof showToast === 'function') {
                showToast('⚠️ 새로고침 중 오류가 발생했습니다.');
            }
        } finally {
            if (icon) icon.classList.remove('fa-spin');
            btnRefreshPhotos.disabled = false;
        }
    };
}

const btnBulkHold = document.getElementById('btnBulkHold');
if (btnBulkHold) {
    btnBulkHold.onclick = async () => {
        if (selectedItems.size === 0) {
            alert(currentFilter === 'hold' ? '보류 해제할 항목을 선택해주세요.' : '보류 등록할 항목을 선택해주세요.');
            return;
        }

        const selectedCntrNos = new Set();
        displayData.forEach((res, i) => {
            const key = `${res.cntrNo}_${res.prodName}_${i}`;
            if (selectedItems.has(key)) {
                selectedCntrNos.add(res.cntrNo);
            }
        });

        if (selectedCntrNos.size === 0) return;

        const isUnHoldAction = (currentFilter === 'hold');
        const confirmMsg = isUnHoldAction
            ? `선택한 ${selectedCntrNos.size}대의 컨테이너를 모두 보류 해제하시겠습니까?`
            : `선택한 ${selectedCntrNos.size}대의 컨테이너를 모두 보류 등록하시겠습니까?`;

        if (!confirm(confirmMsg)) return;

        try {
            btnBulkHold.disabled = true;
            btnBulkHold.innerHTML = isUnHoldAction
                ? '<i class="fas fa-spinner fa-spin"></i> 해제 중...'
                : '<i class="fas fa-spinner fa-spin"></i> 보류 중...';

            let successCount = 0;
            for (const cntrNo of selectedCntrNos) {
                if (isUnHoldAction) {
                    // 보류 해제 (DELETE)
                    const resp = await fetch(`${API_BASE}/api/sync/holds/${cntrNo}`, { method: 'DELETE' });
                    if (resp.ok) {
                        holdContainerMap.delete(cntrNo);
                        successCount++;
                    }
                } else {
                    // 보류 등록 (POST)
                    if (!holdContainerMap.has(cntrNo)) {
                        const resp = await fetch(`${API_BASE}/api/sync/holds`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ cntrNo, reason: '일괄 보류 등록' })
                        });
                        if (resp.ok) {
                            holdContainerMap.set(cntrNo, '일괄 보류 등록');
                            successCount++;
                        }
                    } else {
                        successCount++;
                    }
                }
            }

            alert(`${selectedCntrNos.size}대의 컨테이너 ${isUnHoldAction ? '해제' : '보류 등록'}가 완료되었습니다.`);
            selectedItems.clear();
            updateSelectionUI();
            displayResults(comparisonResult, false);
        } catch (err) {
            console.error("일괄 보류 처리 중 오류:", err);
            alert('처리 중 오류 발생: ' + err.message);
        } finally {
            btnBulkHold.disabled = false;
            updateSelectionUI(); // 버튼 텍스트 원상복구
        }
    };
}

// --- DB 검색 실행 ---
const btnDbExec = document.getElementById('btnDbSearchExec');
const btnDbDownloadExcel = document.getElementById('btnDbDownloadExcel');

if (btnDbExec) {
    btnDbExec.onclick = () => executeDbSearch();
}

if (btnDbDownloadExcel) {
    btnDbDownloadExcel.onclick = () => downloadDbResultsAsExcel();
}

if (btnDbViewExcel) {
    btnDbViewExcel.onclick = async () => {
        if (!lastDbSearchResults || lastDbSearchResults.length === 0) {
            alert("조회된 데이터가 없습니다.");
            return;
        }
        const originalText = btnDbViewExcel.innerHTML;
        btnDbViewExcel.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 생성 중...';
        btnDbViewExcel.disabled = true;

        try {
            const wb = await generateDbResultsWorkbook();
            const buffer = await wb.xlsx.writeBuffer();
            const dateStr = new Date().toISOString().split('T')[0];
            const fileName = `DB_조회_결과_${dateStr}.xlsx`;

            const base64 = bufToBase64(buffer);
            await fetch(`${API_BASE}/api/open-excel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ buffer: base64, fileName: fileName })
            });
        } catch (err) {
            console.error('❌ 바로보기 오류:', err);
            alert(`엑셀을 여는 중 오류가 발생했습니다: ${err.message}`);
        } finally {
            btnDbViewExcel.innerHTML = originalText;
            btnDbViewExcel.disabled = false;
        }
    };
}

/**
 * [분리] DB 조회 결과 Workbook 생성 로직
 */
async function generateDbResultsWorkbook() {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('DB 조회 결과');

    const columns = [
        { header: '작업구분', key: 'type', width: 15 },
        { header: '컨테이너번호', key: 'cntrNo', width: 20 },
        { header: '씰정보', key: 'sealNo', width: 15 },
        { header: '제품구분', key: 'prodType', width: 10 },
        { header: '사업부', key: 'division', width: 12 },
        { header: '제품모델명', key: 'prodName', width: 30 },
        { header: '계획수량', key: 'planQty', width: 10 },
        { header: '적재수량', key: 'loadQty', width: 10 },
        { header: '팬딩수량', key: 'pendingQty', width: 10 },
        { header: '잔여수량', key: 'remainQty', width: 10 },
        { header: '단위', key: 'packingQty', width: 10 },
        { header: '컨테이너규격', key: 'cntrSize', width: 15 },
        { header: '제품크기', key: 'dims', width: 15 },
        { header: '선사', key: 'carrier', width: 15 },
        { header: '도착지', key: 'dest', width: 15 },
        { header: '무게', key: 'weight', width: 12 },
        { header: '운송사', key: 'transporter', width: 15 },
        { header: '작업명', key: 'jobName', width: 25 },
        { header: '선적일(ETA)', key: 'eta', width: 12 },
        { header: '출항일(ETD)', key: 'etd', width: 12 },
        { header: '리마크', key: 'remark', width: 45 },
        { header: '저장시각', key: 'savedAt', width: 22 }
    ];

    ws.columns = columns;

    const headerRow = ws.getRow(1);
    headerRow.height = 30;
    headerRow.eachCell((cell) => {
        cell.font = { name: 'LG Smart_Korean Regular', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });

    const exportData = lastDbSearchResults.map(r => ({
        type: r.type,
        cntrNo: r.cntrNo,
        sealNo: r.sealNo || '-',
        prodType: r.prodType,
        division: r.division,
        prodName: r.prodName,
        planQty: r.qtyInfo.plan,
        loadQty: r.qtyInfo.load,
        pendingQty: r.qtyInfo.pending,
        remainQty: r.qtyInfo.remain,
        packingQty: r.qtyInfo.packing,
        cntrSize: r.cntrType.val,
        dims: r.dims,
        carrier: r.carrierName.val,
        dest: r.destination.val,
        weight: r.weights.mixed,
        transporter: r.transporter,
        jobName: r.jobName || '-',
        eta: r.eta || '-',
        etd: r.etd || '-',
        remark: r.origRemark || '-',
        savedAt: r.dbSavedAt ? new Date(r.dbSavedAt).toLocaleString() : '-'
    }));

    exportData.forEach(data => {
        const row = ws.addRow(data);
        row.eachCell((cell) => {
            cell.font = { name: 'LG Smart_Korean Regular', size: 10 };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            cell.border = {
                top: { style: 'thin', color: { argb: 'FFEEEEEE' } },
                left: { style: 'thin', color: { argb: 'FFEEEEEE' } },
                bottom: { style: 'thin', color: { argb: 'FFEEEEEE' } },
                right: { style: 'thin', color: { argb: 'FFEEEEEE' } }
            };
        });
    });

    return wb;
}

/**
 * DB 조회 결과를 엑셀로 내보냄
 */
async function downloadDbResultsAsExcel() {
    if (!lastDbSearchResults || lastDbSearchResults.length === 0) {
        alert("내보낼 검색 결과 데이터가 없습니다. 먼저 검색을 실행해주세요.");
        return;
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('DB 조회 결과');

    const columns = [
        { header: '작업구분', key: 'type', width: 15 },
        { header: '컨테이너번호', key: 'cntrNo', width: 20 },
        { header: '씰정보', key: 'sealNo', width: 15 },
        { header: '제품구분', key: 'prodType', width: 10 },
        { header: '사업부', key: 'division', width: 12 },
        { header: '제품모델명', key: 'prodName', width: 30 },
        { header: '계획수량', key: 'planQty', width: 10 },
        { header: '적재수량', key: 'loadQty', width: 10 },
        { header: '팬딩수량', key: 'pendingQty', width: 10 },
        { header: '잔여수량', key: 'remainQty', width: 10 },
        { header: '단위', key: 'packingQty', width: 10 },
        { header: '컨테이너규격', key: 'cntrSize', width: 15 },
        { header: '제품크기', key: 'dims', width: 15 },
        { header: '선사', key: 'carrier', width: 15 },
        { header: '도착지', key: 'dest', width: 15 },
        { header: '무게', key: 'weight', width: 12 },
        { header: '운송사', key: 'transporter', width: 15 },
        { header: '작업명', key: 'jobName', width: 25 },
        { header: '선적일(ETA)', key: 'eta', width: 12 },
        { header: '출항일(ETD)', key: 'etd', width: 12 },
        { header: '리마크', key: 'remark', width: 45 },
        { header: '저장시각', key: 'savedAt', width: 22 }
    ];

    ws.columns = columns;

    // 헤더 스타일
    const headerRow = ws.getRow(1);
    headerRow.height = 30;
    headerRow.eachCell((cell) => {
        cell.font = { name: 'LG Smart_Korean Regular', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF10B981' } // Green header
        };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' }
        };
    });

    // 데이터 변환
    const exportData = lastDbSearchResults.map(r => ({
        type: r.type,
        cntrNo: r.cntrNo,
        sealNo: r.sealNo || '-',
        prodType: r.prodType,
        division: r.division,
        prodName: r.prodName,
        planQty: r.qtyInfo.plan,
        loadQty: r.qtyInfo.load,
        pendingQty: r.qtyInfo.pending,
        remainQty: r.qtyInfo.remain,
        packingQty: r.qtyInfo.packing,
        cntrSize: r.cntrType.val,
        dims: r.dims,
        carrier: r.carrierName.val,
        dest: r.destination.val,
        weight: r.weights.mixed,
        transporter: r.transporter,
        jobName: r.jobName || '-',
        eta: r.eta || '-',
        etd: r.etd || '-',
        remark: r.origRemark || '-',
        savedAt: r.dbSavedAt ? new Date(r.dbSavedAt).toLocaleString() : '-'
    }));

    // 데이터 추가
    exportData.forEach(data => {
        const row = ws.addRow(data);
        row.eachCell((cell) => {
            cell.font = { name: 'LG Smart_Korean Regular', size: 10 };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            cell.border = {
                top: { style: 'thin', color: { argb: 'FFEEEEEE' } },
                left: { style: 'thin', color: { argb: 'FFEEEEEE' } },
                bottom: { style: 'thin', color: { argb: 'FFEEEEEE' } },
                right: { style: 'thin', color: { argb: 'FFEEEEEE' } }
            };
        });
    });

    try {
        const buf = await wb.xlsx.writeBuffer();
        const dateStr = new Date().toISOString().split('T')[0];
        saveAs(new Blob([buf]), `DB_조회_결과_${dateStr}.xlsx`);
    } catch (err) {
        console.error("엑셀 저장 중 오류:", err);
        alert("엑셀 파일 생성 중 오류가 발생했습니다.");
    }
}

async function executeDbSearch(confirm = false) {
    console.log("🔍 [DB Search] executeDbSearch 시작...");

    const filterCntr = document.getElementById('dbFilterCntr')?.value.trim() || '';
    const filterDest = document.getElementById('dbFilterDest')?.value.trim() || '';
    const filterCarrier = document.getElementById('dbFilterCarrier')?.value.trim() || '';
    const filterStart = document.getElementById('dbFilterStartDate')?.value || '';
    const filterEnd = document.getElementById('dbFilterEndDate')?.value || '';

    const rb = getResultBody();
    if (!rb) {
        console.warn("⚠️ resultBody를 찾을 수 없어 업데이트를 중단합니다.");
        return;
    }
    rb.innerHTML = '<tr><td colspan="13" style="text-align:center; padding: 2rem; color: #4361ee;"><i class="fas fa-spinner fa-spin"></i> DB에서 데이터를 검색 중입니다...</td></tr>';

    try {
        const queryParams = new URLSearchParams();
        if (filterCntr) queryParams.append('cntr_no', filterCntr);
        if (filterDest) queryParams.append('dest', filterDest);
        if (filterCarrier) queryParams.append('carrier', filterCarrier);
        if (filterStart) queryParams.append('start', filterStart);
        if (filterEnd) queryParams.append('end', filterEnd);
        if (confirm) queryParams.append('confirm', 'true');

        const response = await fetch(`${API_BASE}/api/db-search?${queryParams.toString()}`);
        const data = await response.json();
        console.log("📡 [DB Search] Raw Response Data:", data);

        if (data.success) {
            // 컨펌이 필요한 경우 (데이터가 많음)
            if (data.requireConfirm) {
                if (window.confirm(`검색 결과가 총 ${data.totalCount.toLocaleString()}건입니다. \n모두 불러오시겠습니까? \n(데이터가 많을 경우 로딩 시간이 길어질 수 있습니다.)`)) {
                    return executeDbSearch(true);
                } else {
                    if (rb) rb.innerHTML = '<tr><td colspan="13" style="text-align:center; padding: 2.5rem; color: #64748b;">조회가 취소되었습니다.</td></tr>';
                    return;
                }
            }

            if (data.results.length === 0) {
                if (rb) rb.innerHTML = '<tr><td colspan="13" style="text-align:center; padding: 2rem; color: #64748b;">조건에 일치하는 검색 결과가 없습니다.</td></tr>';
                displayData = [];
                updateSelectionUI();

                const dbSummary = document.getElementById('dbSearchResultSummary');
                if (dbSummary) dbSummary.style.display = 'none';
            } else {
                // DB 결과를 comparisonResult 형태로 매핑하여 renderChunk 렌더링에 알맞게 변환
                const mappedData = data.results.map(row => ({
                    dbId: row.id, // DB 레코드 ID 저장
                    source: 'db',
                    type: '✔ DB 조회결과',
                    badgeClass: 'success',
                    cntrNo: row.cntr_no,
                    sealNo: row.seal_no || '-',
                    prodName: row.prod_name,
                    prodType: row.prod_type || '-',
                    division: row.division || '-',
                    cntrType: { val: row.cntr_type || '-', orig: '-', isMismatch: false },
                    carrierName: { val: row.carrier || '-', orig: '-', isMismatch: false },
                    destination: { val: row.destination || '-', orig: '-', isMismatch: false },
                    weights: {
                        mixed: parseFloat(row.weight_mixed) || 0,
                        orig: parseFloat(row.weight_orig) || 0,
                        down: parseFloat(row.weight_down) || 0,
                        isMismatch: Math.abs((parseFloat(row.weight_mixed) || 0) - (parseFloat(row.weight_orig) || 0)) > 0.01
                    },
                    dims: row.dims || '-',
                    transporter: row.transporter || '-',
                    tags: [],
                    adj1: row.adj1 || '-',
                    adj1Color: row.adj1_color || 'inherit',
                    origRemark: row.job_remark || row.remark || '-',
                    etd: row.job_etd || row.etd || '-',
                    eta: row.job_eta || row.eta || '-',
                    jobName: row.job_name_master || row.job_name || '-',
                    qtyInfo: {
                        plan: row.qty_plan || 0,
                        load: row.qty_load || 0,
                        pending: row.qty_pending || 0,
                        remain: row.qty_remain || 0,
                        packing: row.qty_packing || 0,
                        origPlan: row.qty_plan || 0,
                        isMismatch: false
                    },
                    isErrorRow: false,
                    messages: [`DB 저장일시: ${row.saved_at ? new Date(row.saved_at).toLocaleString() : '알수없음'}`],
                    dbSavedAt: row.saved_at
                }));

                // 수량 요약 표시 (컨테이너 기준)
                const uniqueCntrs = new Set(mappedData.map(d => d.cntrNo));
                const dbSummary = document.getElementById('dbSearchResultSummary');
                const dbTotalItems = document.getElementById('dbTotalItems');
                const dbTotalCntrs = document.getElementById('dbTotalCntrs');
                const dbBulkActions = document.getElementById('dbBulkActions');

                if (dbSummary && dbTotalItems && dbTotalCntrs) {
                    dbSummary.style.display = 'flex';
                    dbTotalItems.textContent = mappedData.length.toLocaleString();
                    dbTotalCntrs.textContent = uniqueCntrs.size.toLocaleString();
                }

                if (dbBulkActions) {
                    dbBulkActions.style.display = 'flex';
                    const dbSelectedCount = document.getElementById('dbSelectedCount');
                    if (dbSelectedCount) dbSelectedCount.textContent = '0';
                    const chkDbAll = document.getElementById('chkDbAll');
                    if (chkDbAll) chkDbAll.checked = false;
                }

                // DB 조회 결과를 전역 변수에 저장하여 탭 전환 시에도 유지되도록 함
                lastDbSearchResults = mappedData;
                displayResults(mappedData, true);
            }
        } else {
            if (rb) rb.innerHTML = `<tr><td colspan="13" style="text-align:center; padding: 2rem; color: #ef4444;">오류: ${data.message}</td></tr>`;
        }
    } catch (err) {
        if (rb) rb.innerHTML = `<tr><td colspan="13" style="text-align:center; padding: 2rem; color: #ef4444;">통신 오류: ${err.message}</td></tr>`;
    }
}

// DB 벌크 삭제 실행 함수 추가
async function executeDbBulkDelete() {
    const selectedIds = [];
    document.querySelectorAll('.db-row-chk:checked').forEach(chk => {
        selectedIds.push(parseInt(chk.dataset.id));
    });

    if (selectedIds.length === 0) {
        alert('삭제할 항목을 선택해주세요.');
        return;
    }

    if (!confirm(`선택한 ${selectedIds.length}건의 데이터를 DB에서 영구 삭제하시겠습니까?`)) return;

    try {
        const resp = await fetch(`${API_BASE}/api/db-bulk-delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: selectedIds })
        });
        const result = await resp.json();
        if (result.success) {
            alert(result.message);
            // 현재 화면의 데이터에서 삭제된 항목 필터링
            displayData = displayData.filter(d => !selectedIds.includes(d.dbId));
            lastDbSearchResults = displayData; // 전역 유지 변수도 갱신
            displayResults(displayData, true);

            // 요약 업데이트
            const uniqueCntrs = new Set(displayData.map(d => d.cntrNo));
            const dbTotalItems = document.getElementById('dbTotalItems');
            const dbTotalCntrs = document.getElementById('dbTotalCntrs');
            const dbSelectedCount = document.getElementById('dbSelectedCount');
            const chkDbAll = document.getElementById('chkDbAll');

            if (dbTotalItems) dbTotalItems.textContent = displayData.length.toLocaleString();
            if (dbTotalCntrs) dbTotalCntrs.textContent = uniqueCntrs.size.toLocaleString();
            if (dbSelectedCount) dbSelectedCount.textContent = '0';
            if (chkDbAll) chkDbAll.checked = false;

            updateDbGlobalStats(); // 전체 통계 갱신
        } else {
            alert('삭제 실패: ' + result.message);
        }
    } catch (err) {
        alert('통신 오류: ' + err.message);
    }
}

// 이벤트 리스너 설정
const btnBulkDelete = document.getElementById('btnDbBulkDelete');
if (btnBulkDelete) {
    btnBulkDelete.onclick = executeDbBulkDelete;
}

const chkDbAll = document.getElementById('chkDbAll');
if (chkDbAll) {
    chkDbAll.onchange = (e) => {
        const checked = e.target.checked;
        document.querySelectorAll('.db-row-chk').forEach(chk => {
            chk.checked = checked;
        });
        const dbSelectedCount = document.getElementById('dbSelectedCount');
        if (dbSelectedCount) dbSelectedCount.textContent = checked ? displayData.length : '0';
    };
}


async function updateDbGlobalStats() {
    try {
        console.log("📡 [DB Stats] Fetching global stats...");
        const resp = await fetch(`${API_BASE}/api/db-stats`);
        const data = await resp.json();
        console.log("📡 [DB Stats] Data received:", data);
        if (data.success && data.stats) {
            // 신규 클라우드 동기화 데이터 수량 표시
            const cloudCarrierCnt = document.getElementById('cloudCarrierCnt');
            const cloudRuleCnt = document.getElementById('cloudRuleCnt');
            const cloudMasterCnt = document.getElementById('cloudMasterCnt');

            if (cloudCarrierCnt) cloudCarrierCnt.textContent = (data.stats.total_carriers || 0).toLocaleString();
            if (cloudRuleCnt) cloudRuleCnt.textContent = (data.stats.total_rules || 0).toLocaleString();
            if (cloudMasterCnt) cloudMasterCnt.textContent = (data.stats.total_master || 0).toLocaleString();

            // 기존 DB 통계 표시
            const dbGlobalCntrs = document.getElementById('dbGlobalCntrs');
            const dbGlobalSize = document.getElementById('dbGlobalSize');
            if (dbGlobalCntrs) dbGlobalCntrs.textContent = (parseInt(data.stats.total_cntrs) || 0).toLocaleString();
            if (dbGlobalSize) dbGlobalSize.textContent = data.stats.total_size || '0 KB';
        }
    } catch (err) {
        console.error('❌ [DB Stats] Failed to update global stats:', err);
    }
}

// 클라우드 상태 새로고침 버튼 리스너
const btnRefreshCloudStats = document.getElementById('btnRefreshCloudStats');
if (btnRefreshCloudStats) {
    btnRefreshCloudStats.addEventListener('click', () => {
        const icon = btnRefreshCloudStats.querySelector('.fa-sync-alt');
        if (icon) icon.classList.add('fa-spin');

        const promises = [
            updateDbGlobalStats(),
            typeof loadProductMaster === 'function' ? loadProductMaster() : Promise.resolve(),
            typeof window.loadCarrierMap === 'function' ? window.loadCarrierMap() : Promise.resolve(),
            typeof window.loadDynamicRules === 'function' ? window.loadDynamicRules() : Promise.resolve()
        ];

        Promise.all(promises).finally(() => {
            setTimeout(() => {
                if (icon) icon.classList.remove('fa-spin');
            }, 600);
        });
    });
}

// 외부 모듈에서 호출할 수 있도록 전역 공개
window.updateDbGlobalStats = updateDbGlobalStats;

// --- 대화형 업데이트 필요 목록 팝업 (제품 클릭 시 수정창 연동) ---
function showInteractiveUpdateNeededPopup(missingSet, mismatchSet) {
    const existing = document.getElementById('interactiveUpdateNeededPopup');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-ov';
    overlay.id = 'interactiveUpdateNeededPopup';
    Object.assign(overlay.style, {
        position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
        backgroundColor: 'rgba(0, 0, 0, 0.5)', display: 'flex', justifyContent: 'center',
        alignItems: 'center', zIndex: '9999', backdropFilter: 'blur(3px)'
    });

    const modal = document.createElement('div');
    Object.assign(modal.style, {
        backgroundColor: 'white', padding: '24px', borderRadius: '16px',
        width: '520px', maxWidth: '90vw', maxHeight: '85vh', display: 'flex',
        flexDirection: 'column', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)'
    });

    let bodyHtml = "";

    if (missingSet && missingSet.size > 0) {
        bodyHtml += `
            <div style="margin-bottom: 20px;">
                <h4 style="margin: 0 0 8px 0; color: #ef4444; font-size: 0.95rem; font-weight: 700; display: flex; align-items: center; gap: 6px;">
                    <i class="fas fa-plus-circle"></i> 마스터에 없는 제품 (${missingSet.size}건)
                </h4>
                <div style="font-size:0.8rem; color:#94a3b8; margin-bottom:8px;">* 제품명을 클릭하면 즉시 신규 제품 추가 창이 열립니다.</div>
                <div style="max-height: 180px; overflow-y: auto; border: 1px solid #fee2e2; background: #fff5f5; border-radius: 8px; padding: 6px; display: flex; flex-direction: column; gap: 2px;">
                    ${Array.from(missingSet).map(name => `
                        <div class="interactive-prod-item" 
                             style="padding: 8px 12px; font-weight: 600; color: #b91c1c; cursor: pointer; border-radius: 6px; font-size: 0.88rem; transition: background 0.2s;"
                             onmouseover="this.style.backgroundColor='#fee2e2';"
                             onmouseout="this.style.backgroundColor='transparent';"
                             onclick="window.handleInteractiveProdClick('${name.replace(/'/g, "\\'")}', true)"
                             title="신규 제품으로 등록">
                             ${name}
                        </div>
                    `).join('')}
                </div>
            </div>`;
    }

    if (mismatchSet && mismatchSet.size > 0) {
        bodyHtml += `
            <div style="margin-bottom: 20px;">
                <h4 style="margin: 0 0 8px 0; color: #7c3aed; font-size: 0.95rem; font-weight: 700; display: flex; align-items: center; gap: 6px;">
                    <i class="fas fa-exclamation-triangle"></i> 중량/CBM/크기 불일치 제품 (${mismatchSet.size}건)
                </h4>
                <div style="font-size:0.8rem; color:#94a3b8; margin-bottom:8px;">* 제품명을 클릭하면 즉시 해당 제품의 수정 창이 열립니다.</div>
                <div style="max-height: 220px; overflow-y: auto; border: 1px solid #f3e8ff; background: #faf5ff; border-radius: 8px; padding: 6px; display: flex; flex-direction: column; gap: 6px;">
                    ${Array.from(mismatchSet).map(name => {
                        const trimmedName = name.trim();
                        const details = weightMismatchDetails[trimmedName] || {};
                        let diffHtml = '';
                        if (details.hasWeightDiff) {
                            diffHtml += `
                                <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 4px; font-size: 0.78rem; color: #4b5563; font-weight: 400;">
                                    <span>⚖️ 중량: DB <strong>${details.dbWeight}</strong>kg ↔ 전산 <strong>${details.downWeight.toFixed(2)}</strong>kg</span>
                                    <button onclick="event.stopPropagation(); window.applyDownWeightToMaster('${name.replace(/'/g, "\\'")}', ${details.downWeight})"
                                            class="btn"
                                            style="padding: 2px 8px; font-size: 0.72rem; background: #7c3aed; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; line-height: 1.2;">
                                        중량 반영
                                    </button>
                                </div>`;
                        }
                        if (details.hasCbmDiff) {
                            diffHtml += `
                                <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 4px; font-size: 0.78rem; color: #4b5563; font-weight: 400;">
                                    <span>📦 CBM: DB <strong>${details.dbCbm.toFixed(3)}</strong> ↔ 전산 <strong>${details.downCbm.toFixed(3)}</strong></span>
                                    <button onclick="event.stopPropagation(); window.applyDownCbmToMaster('${name.replace(/'/g, "\\'")}', ${details.downCbm})"
                                            class="btn"
                                            style="padding: 2px 8px; font-size: 0.72rem; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; line-height: 1.2;">
                                        CBM 반영
                                    </button>
                                </div>`;
                        }
                        return `
                            <div class="interactive-prod-item" 
                                 style="padding: 8px 12px; border-radius: 6px; border-bottom: 1px solid #e9d5ff; transition: background 0.2s; display: flex; flex-direction: column;"
                                 onmouseover="this.style.backgroundColor='#f3e8ff';"
                                 onmouseout="this.style.backgroundColor='transparent';">
                                 <div style="font-weight: 700; color: #6d28d9; cursor: pointer; font-size: 0.88rem; display: inline-block; align-self: flex-start;"
                                      onclick="window.handleInteractiveProdClick('${name.replace(/'/g, "\\'")}', false)"
                                      title="제품 마스터 정보 수정">
                                     ${name}
                                 </div>
                                 ${diffHtml}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>`;
    }

    modal.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px;">
            <h3 style="margin: 0; font-size: 1.15rem; color: #1e293b; font-weight: 800;">제품정보 업데이트 필요 목록</h3>
            <button onclick="this.closest('.modal-ov').remove();" style="background:none; border:none; color:#94a3b8; cursor:pointer; font-size:1.3rem;"><i class="fas fa-times"></i></button>
        </div>
        <div style="flex: 1; overflow-y: auto; margin-bottom: 20px;">
            ${bodyHtml}
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center;">
            <button id="btnCopyListAsText" class="btn" style="padding: 0.5rem 1rem; font-size: 0.88rem; background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; border-radius: 8px; display: flex; align-items: center; gap: 6px;">
                <i class="fas fa-copy"></i> 전체 텍스트로 복사
            </button>
            <button id="btnCloseInteractivePopup" class="btn primary" style="padding: 0.5rem 1.25rem; font-size: 0.88rem; border-radius: 8px;">닫기</button>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Click handler for product items
    window.handleInteractiveProdClick = (prodName, isNew) => {
        overlay.remove();
        window.openPmEditModal(prodName);
    };

    window.applyDownWeightToMaster = async (prodName, newWeight) => {
        const product = productMaster.find(p => p.name === prodName);
        if (!product) {
            alert('제품 마스터에서 해당 제품을 찾을 수 없습니다.');
            return;
        }

        const payload = {
            prodName: prodName,
            prodType: product.prodType || product.type || '',
            weight: parseFloat(newWeight) || 0,
            width: parseFloat(product.width) || 0,
            depth: parseFloat(product.depth) || 0,
            height: parseFloat(product.height) || 0,
            cbm: parseFloat(product.cbm) || 0
        };

        try {
            const response = await fetch(`${API_BASE}/api/master-data/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json();
            if (result.success) {
                if (typeof showToast === 'function') {
                    showToast(`⚖️ ${prodName}의 중량이 ${newWeight.toFixed(2)}kg으로 업데이트되었습니다.`);
                } else {
                    alert(`${prodName}의 중량이 ${newWeight.toFixed(2)}kg으로 업데이트되었습니다.`);
                }

                if (typeof loadProductMaster === 'function') {
                    await loadProductMaster();
                }
                if (typeof reCompareFilteredData === 'function') {
                    reCompareFilteredData();
                }

                overlay.remove();
                setTimeout(() => {
                    const hasMissing = missingProductsSet && missingProductsSet.size > 0;
                    const hasMismatch = weightMismatchSet && weightMismatchSet.size > 0;
                    if (hasMissing || hasMismatch) {
                        showInteractiveUpdateNeededPopup(missingProductsSet, weightMismatchSet);
                    }
                }, 100);
            } else {
                alert('저장 실패: ' + result.message);
            }
        } catch (err) {
            alert('통신 오류: ' + err.message);
        }
    };

    window.applyDownCbmToMaster = async (prodName, newCbm) => {
        const product = productMaster.find(p => p.name === prodName);
        if (!product) {
            alert('제품 마스터에서 해당 제품을 찾을 수 없습니다.');
            return;
        }

        const payload = {
            prodName: prodName,
            prodType: product.prodType || product.type || '',
            weight: parseFloat(product.weight) || 0,
            width: parseFloat(product.width) || 0,
            depth: parseFloat(product.depth) || 0,
            height: parseFloat(product.height) || 0,
            cbm: parseFloat(newCbm) || 0
        };

        try {
            const response = await fetch(`${API_BASE}/api/master-data/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json();
            if (result.success) {
                if (typeof showToast === 'function') {
                    showToast(`📦 ${prodName}의 CBM이 ${newCbm.toFixed(3)}으로 업데이트되었습니다.`);
                } else {
                    alert(`${prodName}의 CBM이 ${newCbm.toFixed(3)}으로 업데이트되었습니다.`);
                }

                if (typeof loadProductMaster === 'function') {
                    await loadProductMaster();
                }
                if (typeof reCompareFilteredData === 'function') {
                    reCompareFilteredData();
                }

                overlay.remove();
                setTimeout(() => {
                    const hasMissing = missingProductsSet && missingProductsSet.size > 0;
                    const hasMismatch = weightMismatchSet && weightMismatchSet.size > 0;
                    if (hasMissing || hasMismatch) {
                        showInteractiveUpdateNeededPopup(missingProductsSet, weightMismatchSet);
                    }
                }, 100);
            } else {
                alert('저장 실패: ' + result.message);
            }
        } catch (err) {
            alert('통신 오류: ' + err.message);
        }
    };

    // Close button
    document.getElementById('btnCloseInteractivePopup').onclick = () => {
        overlay.remove();
    };

    // Outer click close
    overlay.onclick = (e) => {
        if (e.target === overlay) overlay.remove();
    };

    // Copy to clipboard
    document.getElementById('btnCopyListAsText').onclick = () => {
        const textParts = [];
        if (missingSet && missingSet.size > 0) {
            textParts.push(`=== 마스터에 없는 제품 (${missingSet.size}건) ===`);
            missingSet.forEach(n => textParts.push(n));
        }
        if (mismatchSet && mismatchSet.size > 0) {
            if (textParts.length > 0) textParts.push('');
            textParts.push(`=== 중량/크기 불일치 제품 (${mismatchSet.size}건) ===`);
            mismatchSet.forEach(n => {
                const trimmed = n.trim();
                const details = weightMismatchDetails[trimmed];
                if (details) {
                    let detailStr = trimmed;
                    if (details.hasWeightDiff) {
                        detailStr += ` (중량 DB:${details.dbWeight}kg ↔ 전산:${details.downWeight.toFixed(2)}kg)`;
                    }
                    if (details.hasCbmDiff) {
                        detailStr += ` (CBM DB:${details.dbCbm.toFixed(3)} ↔ 전산:${details.downCbm.toFixed(3)})`;
                    }
                    textParts.push(detailStr);
                } else {
                    textParts.push(n);
                }
            });
        }
        navigator.clipboard.writeText(textParts.join('\n')).then(() => {
            if (typeof showToast === 'function') {
                showToast('📋 목록이 클립보드에 복사되었습니다.');
            } else {
                alert('목록이 복사되었습니다.');
            }
        });
    };
}

// --- 드래그/복사 가능한 팝업창 (텍스트 에리어 기반) ---
function showCopyablePopup(title, content) {
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    overlay.style.display = 'flex';
    overlay.style.justifyContent = 'center';
    overlay.style.alignItems = 'center';
    overlay.style.zIndex = '9999';

    const modal = document.createElement('div');
    modal.style.backgroundColor = 'white';
    modal.style.padding = '20px';
    modal.style.borderRadius = '12px';
    modal.style.width = '500px';
    modal.style.maxWidth = '90vw';
    modal.style.boxShadow = '0 10px 25px rgba(0,0,0,0.2)';

    modal.innerHTML = `
        <h3 style="margin-top:0; margin-bottom:15px; font-size:1.2rem; color:#1e293b;">${title}</h3>
        <p style="font-size:0.9rem; color:#64748b; margin-bottom:10px;">아래 목록을 드래그하거나 전체 선택(Ctrl+A)하여 복사할 수 있습니다.</p>
        <textarea style="width:100%; height:300px; padding:10px; border:1px solid #e2e8f0; border-radius:8px; font-family:monospace; font-size:0.9rem; resize:none;" readonly>${content}</textarea>
        <div style="text-align:right; margin-top:15px;">
            <button id="btnCloseCopyPopup" class="btn primary" style="padding:0.6rem 1.5rem; font-size:0.95rem;">닫기</button>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.getElementById('btnCloseCopyPopup').onclick = () => {
        document.body.removeChild(overlay);
    };

    // 바깥쪽 클릭 시 닫기
    overlay.onclick = (e) => {
        if (e.target === overlay) document.body.removeChild(overlay);
    };
}

/* =========================================================================
 *  EMAIL HISTORY LOGIC
 * ========================================================================= */
async function loadEmailHistory() {
    const tableBody = document.getElementById('emailHistoryTableBody');
    if (!tableBody) return;

    tableBody.innerHTML = '<tr><td colspan="4" style="padding: 20px; text-align: center; color: #4361ee;"><i class="fas fa-spinner fa-spin"></i> 이력을 불러오고 있습니다...</td></tr>';

    try {
        const response = await fetch(`${API_BASE}/api/email/history`);
        const data = await response.json();

        if (data.success) {
            if (data.history.length === 0) {
                tableBody.innerHTML = '<tr><td colspan="4" style="padding: 20px; text-align: center; color: #94a3b8;">최근 발송 이력이 없습니다.</td></tr>';
                return;
            }

            tableBody.innerHTML = data.history.map(item => {
                const dateStr = new Date(item.sent_at).toLocaleString('ko-KR', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                });
                const escapedSubject = (item.subject || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                const escapedRecipient = (item.recipient || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                return `
                    <tr style="border-bottom: 1px solid #f1f5f9;">
                        <td style="padding: 10px; color: #64748b; white-space: nowrap;">${dateStr}</td>
                        <td style="padding: 10px; color: #1e293b; font-weight: 500; word-break: break-all; line-height: 1.4;" title="${escapedRecipient}">${item.recipient}</td>
                        <td style="padding: 10px; color: #1e293b; word-break: break-all; line-height: 1.4;" title="${escapedSubject}">${item.subject || '(제목 없음)'}</td>
                        <td style="padding: 10px; text-align: center;">
                            <div style="display: flex; gap: 4px; justify-content: center;">
                                <button onclick="window.viewEmailHistoryDetail(${item.id})" class="btn" style="padding: 4px 8px; font-size: 0.75rem; background: #f1f5f9; color: #4361ee; border: 1px solid #dbeafe;">보기</button>
                                <button onclick="window.deleteEmailHistory(${item.id}, event)" class="btn" style="padding: 4px 8px; font-size: 0.75rem; background: #fff1f2; color: #e11d48; border: 1px solid #fecaca;">삭제</button>
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');
        } else {
            tableBody.innerHTML = `<tr><td colspan="4" style="padding: 20px; text-align: center; color: #ef4444;">오류: ${data.message}</td></tr>`;
        }
    } catch (err) {
        tableBody.innerHTML = `<tr><td colspan="4" style="padding: 20px; text-align: center; color: #ef4444;">통신 오류: ${err.message}</td></tr>`;
    }
}

window.viewEmailHistoryDetail = async (id) => {
    const overlay = document.getElementById('emailHistoryDetailOverlay');
    const content = document.getElementById('emailHistoryDetailContent');
    if (!overlay || !content) return;

    content.innerHTML = '<div style="text-align:center; padding:50px;"><i class="fas fa-spinner fa-spin fa-2x"></i> 로딩 중...</div>';
    overlay.style.display = 'flex';

    try {
        const response = await fetch(`${API_BASE}/api/email/history/${id}`);
        const data = await response.json();

        if (data.success) {
            const detail = data.detail;
            content.innerHTML = `
                <div style="margin-bottom: 20px; padding-bottom: 15px; border-bottom: 2px solid #f1f5f9;">
                    <div style="margin-bottom: 8px;"><strong style="color: #64748b; width: 80px; display: inline-block;">수신인:</strong> <span style="font-weight: 600;">${detail.recipient}</span></div>
                    <div style="margin-bottom: 8px;"><strong style="color: #64748b; width: 80px; display: inline-block;">제목:</strong> <span style="font-weight: 600;">${detail.subject}</span></div>
                    <div><strong style="color: #64748b; width: 80px; display: inline-block;">발송일시:</strong> <span>${new Date(detail.sent_at).toLocaleString()}</span></div>
                </div>
                <div class="mail-body-content" style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px;">
                    ${detail.content}
                </div>
            `;
        } else {
            content.innerHTML = `<div style="color: #ef4444; padding: 50px; text-align: center;">${data.message}</div>`;
        }
    } catch (err) {
        content.innerHTML = `<div style="color: #ef4444; padding: 50px; text-align: center;">통신 오류: ${err.message}</div>`;
    }
};

window.deleteEmailHistory = async (id, event) => {
    event.stopPropagation();
    if (!confirm('해당 발송 기록을 삭제하시겠습니까?')) return;

    try {
        const response = await fetch(`${API_BASE}/api/email/history/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
            loadEmailHistory();
        } else {
            alert('삭제 실패: ' + data.message);
        }
    } catch (err) {
        alert('삭제 통신 오류: ' + err.message);
    }
};

// --- Email History Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
    const btnOpenHistory = document.getElementById('btnOpenEmailHistory');
    const btnOpenHistoryEntry = document.getElementById('btnOpenEmailHistoryEntry');
    const modalHistory = document.getElementById('emailHistoryModal');
    const closeBtns = [
        document.getElementById('closeEmailHistoryBtn'),
        document.getElementById('closeEmailHistoryBottomBtn')
    ];

    if (btnOpenHistory) {
        btnOpenHistory.addEventListener('click', () => {
            modalHistory.style.display = 'block';
            loadEmailHistory();
        });
    }
    if (btnOpenHistoryEntry) {
        btnOpenHistoryEntry.addEventListener('click', () => {
            modalHistory.style.display = 'block';
            loadEmailHistory();
        });
    }

    closeBtns.forEach(btn => {
        if (btn) btn.addEventListener('click', () => modalHistory.style.display = 'none');
    });

    const overlayDetail = document.getElementById('emailHistoryDetailOverlay');
    const closeDetailBtns = [
        document.getElementById('btnCloseEmailHistoryDetail'),
        document.getElementById('btnHistoryDetailClose')
    ];

    closeDetailBtns.forEach(btn => {
        if (btn) btn.addEventListener('click', () => overlayDetail.style.display = 'none');
    });

    window.addEventListener('click', (e) => {
        if (e.target === modalHistory) modalHistory.style.display = 'none';
        if (e.target === overlayDetail) overlayDetail.style.display = 'none';
    });
});

/* =========================================================================
 *  PRODUCT MASTER SEARCH (WITH HISTORY)
 * ========================================================================= */
let productSearchHistory = [];

function openProductSearchModal() {
    const modal = document.getElementById('productSearchModal');
    if (modal) {
        modal.style.display = 'block';
        setTimeout(() => {
            const input = document.getElementById('inputProductSearch');
            if (input) input.focus();
        }, 50);
    }
}

function closeProductSearchModal() {
    const modal = document.getElementById('productSearchModal');
    if (modal) modal.style.display = 'none';
}

function renderProductSearchHistory() {
    const body = document.getElementById('productSearchHistoryBody');
    const count = document.getElementById('productSearchHistoryCount');
    if (!body) return;

    if (productSearchHistory.length === 0) {
        body.innerHTML = `<tr><td colspan="6" style="padding: 3rem; text-align: center; color: #94a3b8; font-style: italic;">제품명을 검색하면 여기에 정보가 요약되어 쌓입니다.</td></tr>`;
        if (count) count.textContent = '0';
        return;
    }

    if (count) count.textContent = productSearchHistory.length;

    body.innerHTML = productSearchHistory.map((item, index) => `
        <tr style="border-bottom: 1px solid #e2e8f0; background: white; transition: background 0.2s;">
            <td style="padding: 12px; font-weight: 600; color: #1e293b;">${item.name}</td>
            <td style="padding: 12px; text-align: center; color: #64748b; font-size: 0.85rem;">${item.prodType || '-'}</td>
            <td style="padding: 12px; text-align: right; font-weight: 700; color: #059669;">${(parseFloat(item.weight) || 0).toLocaleString()} kg</td>
            <td style="padding: 12px; text-align: center; color: #475569; font-family: monospace; font-size: 0.85rem;">${item.width || 0} × ${item.depth || 0} × ${item.height || 0}</td>
            <td style="padding: 12px; text-align: right; color: #0284c7; font-weight: 500;">${(parseFloat(item.cbm) || 0).toFixed(3)}</td>
            <td style="padding: 12px; text-align: center;">
                <div style="display: flex; gap: 4px; justify-content: center;">
                    <button onclick="window.openPmEditModal('${item.name.replace(/'/g, "\\'")}')" class="btn" style="padding: 4px 8px; font-size: 0.8rem; background: #f0f9ff; color: #0284c7; border: 1px solid #bae6fd; border-radius: 6px;">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button onclick="window.removeFromProductSearchHistory(${index})" class="btn" style="padding: 4px 8px; font-size: 0.8rem; background: #fff1f2; color: #e11d48; border: 1px solid #fecaca; border-radius: 6px;">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

window.removeFromProductSearchHistory = (index) => {
    productSearchHistory.splice(index, 1);
    renderProductSearchHistory();
};

function addToProductSearchHistory(product) {
    // 중복 방지 (이미 있으면 기존 항목 제거 후 최상단 배치)
    const existingIndex = productSearchHistory.findIndex(p => p.name === product.name);
    if (existingIndex !== -1) {
        productSearchHistory.splice(existingIndex, 1);
    }
    productSearchHistory.unshift(product);
    renderProductSearchHistory();
}

// --- 제품 마스터 개별 추가/수정 (Add/Edit) 로직 ---
window.openPmEditModal = (productName = null) => {
    const modal = document.getElementById('productMasterEditModal');
    const title = document.getElementById('pmEditModalTitle');
    const inputName = document.getElementById('pmEditName');
    const inputType = document.getElementById('pmEditType');
    const inputWeight = document.getElementById('pmEditWeight');
    const inputWidth = document.getElementById('pmEditWidth');
    const inputDepth = document.getElementById('pmEditDepth');
    const inputHeight = document.getElementById('pmEditHeight');
    const inputCbm = document.getElementById('pmEditCbm');

    // 폼 초기화
    document.getElementById('pmEditForm').reset();
    inputName.readOnly = false;
    inputName.style.backgroundColor = '#fff';

    if (productName) {
        const product = productMaster.find(p => p.name === productName);
        if (product) {
            title.innerHTML = '<i class="fas fa-edit" style="margin-right: 8px;"></i> 제품 마스터 수정';
            inputName.value = product.name;
            inputName.readOnly = true;
            inputName.style.backgroundColor = '#f1f5f9';
            inputType.value = product.prodType || product.type || '';
            inputWeight.value = product.weight || '';
            inputWidth.value = product.width || '';
            inputDepth.value = product.depth || '';
            inputHeight.value = product.height || '';
            inputCbm.value = product.cbm || '';
        } else {
            // DB에 없는 제품명(신규 제품)일 경우 제품명을 선입력하고 등록 모드로 전환
            title.innerHTML = '<i class="fas fa-plus" style="margin-right: 8px;"></i> 신규 제품 추가';
            inputName.value = productName;
            inputName.readOnly = false;
            inputName.style.backgroundColor = '#fff';
        }
    } else {
        title.innerHTML = '<i class="fas fa-plus" style="margin-right: 8px;"></i> 신규 제품 추가';
    }

    if (modal) modal.style.display = 'block';
};

window.closePmEditModal = () => {
    const modal = document.getElementById('productMasterEditModal');
    if (modal) modal.style.display = 'none';
};

// CBM 자동계산 및 이벤트 리스너 등록
document.addEventListener('DOMContentLoaded', () => {
    const btnCalcCbm = document.getElementById('btnCalcCbm');
    if (btnCalcCbm) {
        btnCalcCbm.addEventListener('click', () => {
            const w = parseFloat(document.getElementById('pmEditWidth').value) || 0;
            const d = parseFloat(document.getElementById('pmEditDepth').value) || 0;
            const h = parseFloat(document.getElementById('pmEditHeight').value) || 0;
            const cbm = (w * d * h) / 1000000;
            document.getElementById('pmEditCbm').value = cbm.toFixed(3);
        });
    }

    const closeBtns = [
        document.getElementById('closePmEditBtn'),
        document.getElementById('closePmEditBottomBtn')
    ];
    closeBtns.forEach(btn => {
        if (btn) btn.addEventListener('click', window.closePmEditModal);
    });

    const btnSavePmEdit = document.getElementById('btnSavePmEdit');
    if (btnSavePmEdit) {
        btnSavePmEdit.addEventListener('click', async () => {
            const name = document.getElementById('pmEditName').value.trim();
            if (!name) return alert('제품명을 입력해주세요.');

            const payload = {
                prodName: name,
                prodType: document.getElementById('pmEditType').value.trim(),
                weight: parseFloat(document.getElementById('pmEditWeight').value) || 0,
                width: parseFloat(document.getElementById('pmEditWidth').value) || 0,
                depth: parseFloat(document.getElementById('pmEditDepth').value) || 0,
                height: parseFloat(document.getElementById('pmEditHeight').value) || 0,
                cbm: parseFloat(document.getElementById('pmEditCbm').value) || 0
            };

            btnSavePmEdit.disabled = true;
            btnSavePmEdit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...';

            try {
                const response = await fetch(`${API_BASE}/api/master-data/save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const result = await response.json();
                if (result.success) {
                    alert('성공적으로 저장되었습니다.');
                    window.closePmEditModal();

                    if (typeof loadProductMaster === 'function') {
                        await loadProductMaster();

                        // 히스토리에 있는 항목이면 뷰 업데이트
                        const pIdx = productSearchHistory.findIndex(p => p.name === payload.prodName);
                        if (pIdx !== -1) {
                            productSearchHistory[pIdx] = {
                                name: payload.prodName,
                                prodType: payload.prodType,
                                weight: payload.weight,
                                width: payload.width,
                                depth: payload.depth,
                                height: payload.height,
                                cbm: payload.cbm
                            };
                            renderProductSearchHistory();
                        }

                        // 변경 사항이 비교 결과 및 대시보드에 즉시 적용되도록 대조 작업 재실행
                        if (typeof reCompareFilteredData === 'function') {
                            reCompareFilteredData();
                        }
                    }
                } else {
                    alert('저장 실패: ' + result.message);
                }
            } catch (err) {
                alert('통신 오류: ' + err.message);
            } finally {
                btnSavePmEdit.disabled = false;
                btnSavePmEdit.innerHTML = '저장';
            }
        });
    }

    const btnOpenAdd = document.getElementById('btnOpenProductMasterAdd');
    if (btnOpenAdd) {
        btnOpenAdd.addEventListener('click', () => window.openPmEditModal(null));
    }
});

// 자동완성 선택 처리
window.handleProductSuggestionSelect = (name) => {
    const product = productMaster.find(p => p.name === name);
    if (product) {
        addToProductSearchHistory(product);
        const input = document.getElementById('inputProductSearch');
        if (input) input.value = '';
        const suggestions = document.getElementById('productSearchSuggestions');
        if (suggestions) suggestions.style.display = 'none';
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const btnOpen = document.getElementById('btnOpenProductMaster');
    const inputSearch = document.getElementById('inputProductSearch');
    const suggestions = document.getElementById('productSearchSuggestions');
    const btnClear = document.getElementById('btnClearProductSearchHistory');

    if (btnOpen) btnOpen.onclick = openProductSearchModal;

    const closeBtns = [
        document.getElementById('closeProductSearchBtn'),
        document.getElementById('closeProductSearchBottomBtn')
    ];
    closeBtns.forEach(btn => {
        if (btn) btn.onclick = closeProductSearchModal;
    });

    if (btnClear) {
        btnClear.onclick = () => {
            if (productSearchHistory.length === 0) return;
            if (confirm('전체 검색 목록을 비우시겠습니까?')) {
                productSearchHistory = [];
                renderProductSearchHistory();
            }
        };
    }

    if (inputSearch) {
        inputSearch.addEventListener('input', (e) => {
            const query = e.target.value.trim().toUpperCase();
            if (query.length < 1) {
                suggestions.style.display = 'none';
                return;
            }

            // 전역 productMaster에서 필터링
            if (!productMaster || productMaster.length === 0) return;

            const matches = productMaster.filter(p =>
                (p.name || "").toUpperCase().includes(query)
            ).slice(0, 15);

            if (matches.length > 0) {
                suggestions.innerHTML = matches.map(p => {
                    const cleanName = p.name.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
                    return `
                    <div class="suggestion-item" 
                         style="padding: 12px 20px; cursor: pointer; border-bottom: 1px solid #f1f5f9; transition: background 0.2s;"
                         onclick="window.handleProductSuggestionSelect('${cleanName}')">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-weight: 700; color: #1e293b; font-size: 1rem;">${p.name}</span>
                            <span style="background: #ecfdf5; color: #059669; padding: 2px 8px; border-radius: 6px; font-size: 0.85rem; font-weight: 800;">
                                ${(parseFloat(p.weight) || 0).toLocaleString()}kg
                            </span>
                        </div>
                        <div style="font-size: 0.8rem; color: #64748b; margin-top: 4px; display: flex; gap: 10px;">
                            <span><i class="fas fa-tag"></i> ${p.prodType || '-'}</span>
                            <span><i class="fas fa-ruler-combined"></i> ${p.width}×${p.depth}×${p.height}</span>
                            <span><i class="fas fa-cube"></i> ${p.cbm} CBM</span>
                        </div>
                    </div>
                `}).join('');
                suggestions.style.display = 'block';

                // 마우스 효과
                suggestions.querySelectorAll('.suggestion-item').forEach(it => {
                    it.onmouseover = () => it.style.backgroundColor = '#ecfdf5';
                    it.onmouseout = () => it.style.backgroundColor = 'white';
                });
            } else {
                suggestions.style.display = 'none';
            }
        });

        inputSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const query = inputSearch.value.trim().toUpperCase();
                // 완전히 일치하는 항목이 있으면 자동 추가
                const bestMatch = productMaster.find(p => (p.name || "").toUpperCase() === query);
                if (bestMatch) {
                    addToProductSearchHistory(bestMatch);
                    inputSearch.value = '';
                    suggestions.style.display = 'none';
                } else if (suggestions.style.display === 'block') {
                    // 첫 번째 제안 항목 선택
                    const firstSuggestion = suggestions.querySelector('.suggestion-item');
                    if (firstSuggestion) firstSuggestion.click();
                }
            }
            if (e.key === 'Escape') {
                suggestions.style.display = 'none';
            }
        });
    }

    // 전역 클릭 핸들러 (모달 외곽 및 제안창 닫기)
    window.addEventListener('click', (e) => {
        if (e.target.id === 'productSearchModal') closeProductSearchModal();
        if (suggestions && !suggestions.contains(e.target) && e.target !== inputSearch) {
            suggestions.style.display = 'none';
        }
    });

    // ESC 키로 모달 닫기
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const modal = document.getElementById('productSearchModal');
            if (modal && modal.style.display === 'block') closeProductSearchModal();
        }
    });
});

// 제외된 컨테이너 모달 설정 및 렌더링 함수
(function setupExcludedModal() {
    const modal = document.getElementById('excludedModal');
    const cardExcluded = document.getElementById('cardExcluded');
    const btnClose = document.getElementById('closeExcludedModalBtn');
    const btnCloseBottom = document.getElementById('closeExcludedModalBottom');

    if (cardExcluded) {
        cardExcluded.addEventListener('click', () => {
            if (modal) {
                renderExcludedModalTable();
                modal.style.display = 'block';
            }
        });
    }

    const closeModal = () => {
        if (modal) modal.style.display = 'none';
    };

    if (btnClose) btnClose.addEventListener('click', closeModal);
    if (btnCloseBottom) btnCloseBottom.addEventListener('click', closeModal);
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }

    // ESC 키로 닫기 지원
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal && modal.style.display === 'block') {
            closeModal();
        }
    });
})();

function renderExcludedModalTable() {
    const tbody = document.getElementById('excludedContainersBody');
    if (!tbody) return;

    if (!excludedList || excludedList.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" style="padding: 20px; text-align: center; color: #94a3b8;">
                    제외된 컨테이너가 없습니다.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = excludedList.map(item => {
        let cntrColor = '#1e293b'; // 기본 색상
        if (item.transporter === '천마(빨강)' || (item.transporter && item.transporter.includes('천마'))) {
            cntrColor = '#e74c3c';
        } else if (item.transporter === 'BNI(파랑)' || (item.transporter && item.transporter.includes('BNI'))) {
            cntrColor = '#3498db';
        }

        return `
            <tr style="border-bottom: 1px solid #e2e8f0; height: 35px;">
                <td style="padding: 8px; text-align: center; font-weight: 600; color: ${cntrColor};">${item.cntrNo}</td>
                <td style="padding: 8px; text-align: center; color: #475569;">${item.sheetName}</td>
                <td style="padding: 8px; text-align: center; color: #475569;">${item.rowNumber}행</td>
                <td style="padding: 8px; text-align: center; color: #475569; font-weight: 600;">${item.qty != null ? item.qty : '-'}</td>
                <td style="padding: 8px; text-align: left; color: #1e293b; font-family: monospace;">${item.prodName}</td>
            </tr>
        `;
    }).join('');
}

// =========================================================================
//  기존 DB 데이터 조회 팝업 모달 비즈니스 로직
// =========================================================================
let lastModalDbSearchResults = [];

// 모달 DB 조회 실행 함수
async function executeModalDbSearch(confirm = false) {
    console.log("🔍 [Modal DB Search] executeModalDbSearch 시작...");

    const filterCntr = document.getElementById('modalDbFilterCntr')?.value.trim() || '';
    const filterDest = document.getElementById('modalDbFilterDest')?.value.trim() || '';
    const filterCarrier = document.getElementById('modalDbFilterCarrier')?.value.trim() || '';
    const filterStart = document.getElementById('modalDbFilterStartDate')?.value || '';
    const filterEnd = document.getElementById('modalDbFilterEndDate')?.value || '';

    const tb = document.getElementById('modalDbSearchResultTableBody');
    if (!tb) return;
    
    tb.innerHTML = '<tr><td colspan="12" style="text-align:center; padding: 3rem; color: #86198f;"><i class="fas fa-spinner fa-spin"></i> DB에서 데이터를 검색 중입니다...</td></tr>';

    try {
        const queryParams = new URLSearchParams();
        if (filterCntr) queryParams.append('cntr_no', filterCntr);
        if (filterDest) queryParams.append('dest', filterDest);
        if (filterCarrier) queryParams.append('carrier', filterCarrier);
        if (filterStart) queryParams.append('start', filterStart);
        if (filterEnd) queryParams.append('end', filterEnd);
        if (confirm) queryParams.append('confirm', 'true');

        const response = await fetch(`${API_BASE}/api/db-search?${queryParams.toString()}`);
        const data = await response.json();

        if (data.success) {
            if (data.requireConfirm) {
                if (window.confirm(`검색 결과가 총 ${data.totalCount.toLocaleString()}건입니다. \n모두 불러오시겠습니까? \n(데이터가 많을 경우 로딩 시간이 길어질 수 있습니다.)`)) {
                    return executeModalDbSearch(true);
                } else {
                    tb.innerHTML = '<tr><td colspan="12" style="text-align:center; padding: 2.5rem; color: #64748b;">조회가 취소되었습니다.</td></tr>';
                    return;
                }
            }

            if (data.results.length === 0) {
                tb.innerHTML = '<tr><td colspan="12" style="text-align:center; padding: 3rem; color: #64748b;">조건에 일치하는 검색 결과가 없습니다.</td></tr>';
                lastModalDbSearchResults = [];
                const dbSummary = document.getElementById('modalDbSearchResultSummary');
                if (dbSummary) dbSummary.style.display = 'none';
            } else {
                lastModalDbSearchResults = data.results;
                
                // 요약 표시
                const uniqueCntrs = new Set(data.results.map(d => d.cntr_no));
                const dbSummary = document.getElementById('modalDbSearchResultSummary');
                const dbTotalItems = document.getElementById('modalDbTotalItems');
                const dbTotalCntrs = document.getElementById('modalDbTotalCntrs');
                const dbBulkActions = document.getElementById('modalDbBulkActions');

                if (dbSummary && dbTotalItems && dbTotalCntrs) {
                    dbSummary.style.display = 'flex';
                    dbTotalItems.textContent = data.results.length.toLocaleString();
                    dbTotalCntrs.textContent = uniqueCntrs.size.toLocaleString();
                }

                if (dbBulkActions) {
                    dbBulkActions.style.display = 'flex';
                    const dbSelectedCount = document.getElementById('modalDbSelectedCount');
                    if (dbSelectedCount) dbSelectedCount.textContent = '0';
                    const chkDbAll = document.getElementById('modalChkDbAll');
                    if (chkDbAll) chkDbAll.checked = false;
                }

                // 테이블 렌더링
                renderModalDbTable(data.results);
            }
        } else {
            tb.innerHTML = `<tr><td colspan="12" style="text-align:center; padding: 3rem; color: #ef4444;">오류: ${data.message}</td></tr>`;
        }
    } catch (err) {
        tb.innerHTML = `<tr><td colspan="12" style="text-align:center; padding: 3rem; color: #ef4444;">통신 오류: ${err.message}</td></tr>`;
    }
}

// 모달용 테이블 동적 생성
function renderModalDbTable(rows) {
    const tb = document.getElementById('modalDbSearchResultTableBody');
    if (!tb) return;
    tb.innerHTML = '';

    const CHUNK_SIZE = 100;
    let currentIndex = 0;

    function renderChunk() {
        const fragment = document.createDocumentFragment();
        const end = Math.min(currentIndex + CHUNK_SIZE, rows.length);

        for (let i = currentIndex; i < end; i++) {
            const row = rows[i];
            const tr = document.createElement('tr');
            
            let cntrColor = 'inherit';
            if (row.transporter === '천마(빨강)') cntrColor = '#e74c3c';
            else if (row.transporter === 'BNI(파랑)') cntrColor = '#3498db';

            tr.innerHTML = `
                <td style="text-align: center;">
                    <input type="checkbox" class="modal-db-row-chk" data-id="${row.id}" style="width: 15px; height: 15px; cursor: pointer;">
                </td>
                <td style="text-align: center;"><span class="badge success">${row.type}</span></td>
                <td style="color: ${cntrColor}; font-weight: bold; text-align: center;">${row.cntr_no}</td>
                <td style="text-align: center;">${row.prod_type || '-'}</td>
                <td style="text-align: center;">${row.division || '-'}</td>
                <td><strong>${row.prod_name}</strong></td>
                <td style="text-align: center;">${row.qty_plan || 0} / ${row.qty_load || 0} / ${row.qty_remain || 0}</td>
                <td style="text-align: center;">${row.dims || '-'}</td>
                <td style="text-align: center;">${row.carrier || '-'} / ${(() => {
                    if (!row.destination || row.destination === '-') return '<span>-</span>';
                    const info = typeof getDestinationInfo === 'function' ? getDestinationInfo(row.destination) : { kr: '' };
                    const lines = [
                        `[도착지 위치 안내]`,
                        `• 코드: ${row.destination}`,
                        `• 지역: ${info.kr || '-'}`
                    ];
                    if (info.en) {
                        lines.push(`• 영문: ${info.en}`);
                    }
                    const tooltip = lines.join('\n').replace(/"/g, '&quot;');
                    return `<span title="${tooltip}" style="cursor:help;">${row.destination}</span>`;
                })()}</td>
                <td style="text-align: right; font-weight: 500;">${row.weight_mixed ? parseFloat(row.weight_mixed).toLocaleString() : '0'}</td>
                <td style="text-align: center;"><span class="badge" style="background: ${row.transporter && row.transporter.includes('천마') ? '#fee2e2; color: #b91c1c' : '#dbeafe; color: #1d4ed8'}; padding: 4px 8px; font-weight: 600;">${row.transporter || '-'}</span></td>
                <td style="text-align: center;">
                    <button class="btn-icon-delete" style="background:none; border:none; color:#ef4444; cursor:pointer; padding:5px;" title="DB에서 삭제" onclick="window.deleteModalDbRecord(${row.id}, this)">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </td>
            `;

            // 체크박스 클릭 핸들러 바인딩
            const chk = tr.querySelector('.modal-db-row-chk');
            if (chk) {
                chk.onclick = (e) => {
                    e.stopPropagation();
                    const total = document.querySelectorAll('.modal-db-row-chk').length;
                    const checked = document.querySelectorAll('.modal-db-row-chk:checked').length;
                    document.getElementById('modalDbSelectedCount').textContent = checked;
                    document.getElementById('modalChkDbAll').checked = (total === checked);
                };
            }

            fragment.appendChild(tr);
        }

        tb.appendChild(fragment);
        currentIndex += CHUNK_SIZE;

        if (currentIndex < rows.length) {
            requestAnimationFrame(renderChunk);
        }
    }

    renderChunk();
}

// 모달 DB 개별 항목 삭제
window.deleteModalDbRecord = async function(id, btnElement) {
    if (!confirm('이 레코드를 데이터베이스에서 영구적으로 삭제하시겠습니까?')) return;
    
    try {
        const resp = await fetch(`${API_BASE}/api/db-record/${id}`, { method: 'DELETE' });
        const result = await resp.json();
        if (result.success) {
            alert('삭제되었습니다.');
            // 목록에서 필터링
            lastModalDbSearchResults = lastModalDbSearchResults.filter(d => d.id !== id);
            renderModalDbTable(lastModalDbSearchResults);

            // 요약 수치 갱신
            const uniqueCntrs = new Set(lastModalDbSearchResults.map(d => d.cntr_no));
            const dbTotalItems = document.getElementById('modalDbTotalItems');
            const dbTotalCntrs = document.getElementById('modalDbTotalCntrs');
            const dbSelectedCount = document.getElementById('modalDbSelectedCount');
            const chkDbAll = document.getElementById('modalChkDbAll');

            if (dbTotalItems) dbTotalItems.textContent = lastModalDbSearchResults.length.toLocaleString();
            if (dbTotalCntrs) dbTotalCntrs.textContent = uniqueCntrs.size.toLocaleString();
            if (dbSelectedCount) dbSelectedCount.textContent = '0';
            if (chkDbAll) chkDbAll.checked = false;

            updateDbGlobalStats(); // 전체 통계(DB 갯수 등) 갱신
        } else {
            alert('삭제 실패: ' + result.message);
        }
    } catch(err) {
        alert('통신 오류: ' + err.message);
    }
};

// 모달 DB 벌크 삭제
async function executeModalDbBulkDelete() {
    const selectedIds = [];
    document.querySelectorAll('.modal-db-row-chk:checked').forEach(chk => {
        selectedIds.push(parseInt(chk.dataset.id));
    });

    if (selectedIds.length === 0) {
        alert('삭제할 항목을 선택해주세요.');
        return;
    }

    if (!confirm(`선택한 ${selectedIds.length}건의 데이터를 DB에서 영구 삭제하시겠습니까?`)) return;

    try {
        const resp = await fetch(`${API_BASE}/api/db-bulk-delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: selectedIds })
        });
        const result = await resp.json();
        if (result.success) {
            alert(result.message);
            
            // 데이터 필터링
            lastModalDbSearchResults = lastModalDbSearchResults.filter(d => !selectedIds.includes(d.id));
            renderModalDbTable(lastModalDbSearchResults);

            // 요약 수치 갱신
            const uniqueCntrs = new Set(lastModalDbSearchResults.map(d => d.cntr_no));
            const dbTotalItems = document.getElementById('modalDbTotalItems');
            const dbTotalCntrs = document.getElementById('modalDbTotalCntrs');
            const dbSelectedCount = document.getElementById('modalDbSelectedCount');
            const chkDbAll = document.getElementById('modalChkDbAll');

            if (dbTotalItems) dbTotalItems.textContent = lastModalDbSearchResults.length.toLocaleString();
            if (dbTotalCntrs) dbTotalCntrs.textContent = uniqueCntrs.size.toLocaleString();
            if (dbSelectedCount) dbSelectedCount.textContent = '0';
            if (chkDbAll) chkDbAll.checked = false;

            updateDbGlobalStats();
        } else {
            alert('삭제 실패: ' + result.message);
        }
    } catch (err) {
        alert('통신 오류: ' + err.message);
    }
}

// 모달 DB 엑셀 다운로드용 워크북 생성
async function generateModalDbResultsWorkbook() {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('DB 조회 결과');

    const columns = [
        { header: '작업구분', key: 'type', width: 15 },
        { header: '컨테이너번호', key: 'cntrNo', width: 20 },
        { header: '씰정보', key: 'sealNo', width: 15 },
        { header: '제품구분', key: 'prodType', width: 10 },
        { header: '사업부', key: 'division', width: 12 },
        { header: '제품모델명', key: 'prodName', width: 30 },
        { header: '계획수량', key: 'planQty', width: 10 },
        { header: '적재수량', key: 'loadQty', width: 10 },
        { header: '팬딩수량', key: 'pendingQty', width: 10 },
        { header: '잔여수량', key: 'remainQty', width: 10 },
        { header: '단위', key: 'packingQty', width: 10 },
        { header: '컨테이너규격', key: 'cntrSize', width: 15 },
        { header: '제품크기', key: 'dims', width: 15 },
        { header: '선사', key: 'carrier', width: 15 },
        { header: '도착지', key: 'dest', width: 15 },
        { header: '무게', key: 'weight', width: 12 },
        { header: '운송사', key: 'transporter', width: 15 },
        { header: '작업명', key: 'jobName', width: 25 },
        { header: '선적일(ETA)', key: 'eta', width: 12 },
        { header: '출항일(ETD)', key: 'etd', width: 12 },
        { header: '리마크', key: 'remark', width: 45 },
        { header: '저장시각', key: 'savedAt', width: 22 }
    ];

    ws.columns = columns;

    const headerRow = ws.getRow(1);
    headerRow.height = 30;
    headerRow.eachCell((cell) => {
        cell.font = { name: 'LG Smart_Korean Regular', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF86198F' } }; // 자주색 헤더 테마
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });

    const exportData = lastModalDbSearchResults.map(row => ({
        type: row.type,
        cntrNo: row.cntr_no,
        sealNo: row.seal_no || '-',
        prodType: row.prod_type || '-',
        division: row.division || '-',
        prodName: row.prod_name,
        planQty: row.qty_plan || 0,
        loadQty: row.qty_load || 0,
        pendingQty: row.qty_pending || 0,
        remainQty: row.qty_remain || 0,
        packingQty: row.qty_packing || 0,
        cntrSize: row.cntr_type || '-',
        dims: row.dims || '-',
        carrier: row.carrier || '-',
        dest: row.destination || '-',
        weight: row.weight_mixed || 0,
        transporter: row.transporter || '-',
        jobName: row.job_name_master || row.job_name || '-',
        eta: row.job_eta || row.eta || '-',
        etd: row.job_etd || row.etd || '-',
        remark: row.job_remark || row.remark || '-',
        savedAt: row.saved_at ? new Date(row.saved_at).toLocaleString() : '-'
    }));

    exportData.forEach(data => {
        const row = ws.addRow(data);
        row.eachCell((cell) => {
            cell.font = { name: 'LG Smart_Korean Regular', size: 10 };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            cell.border = {
                top: { style: 'thin', color: { argb: 'FFEEEEEE' } },
                left: { style: 'thin', color: { argb: 'FFEEEEEE' } },
                bottom: { style: 'thin', color: { argb: 'FFEEEEEE' } },
                right: { style: 'thin', color: { argb: 'FFEEEEEE' } }
            };
        });
    });

    return wb;
}

// 모달 DB 엑셀 다운로드
async function downloadModalDbResultsAsExcel() {
    if (!lastModalDbSearchResults || lastModalDbSearchResults.length === 0) {
        alert("내보낼 검색 결과 데이터가 없습니다. 먼저 검색을 실행해주세요.");
        return;
    }

    try {
        const wb = await generateModalDbResultsWorkbook();
        const buf = await wb.xlsx.writeBuffer();
        const dateStr = new Date().toISOString().split('T')[0];
        saveAs(new Blob([buf]), `DB_조회_결과_${dateStr}.xlsx`);
    } catch (err) {
        console.error("엑셀 저장 중 오류:", err);
        alert("엑셀 파일 생성 중 오류가 발생했습니다.");
    }
}

// 모달 DB 엑셀 바로보기
async function viewModalDbResultsInExcel() {
    const btnView = document.getElementById('modalBtnDbViewExcel');
    if (!lastModalDbSearchResults || lastModalDbSearchResults.length === 0) {
        alert("조회된 데이터가 없습니다.");
        return;
    }
    const originalText = btnView.innerHTML;
    btnView.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 생성 중...';
    btnView.disabled = true;

    try {
        const wb = await generateModalDbResultsWorkbook();
        const buffer = await wb.xlsx.writeBuffer();
        const dateStr = new Date().toISOString().split('T')[0];
        const fileName = `DB_조회_결과_${dateStr}.xlsx`;

        const base64 = bufToBase64(buffer);
        await fetch(`${API_BASE}/api/open-excel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ buffer: base64, fileName: fileName })
        });
    } catch (err) {
        console.error('❌ 바로보기 오류:', err);
        alert(`엑셀을 여는 중 오류가 발생했습니다: ${err.message}`);
    } finally {
        btnView.innerHTML = originalText;
        btnView.disabled = false;
    }
}

// 이벤트 리스너 바인딩
const modalBtnDbExec = document.getElementById('modalBtnDbSearchExec');
if (modalBtnDbExec) {
    modalBtnDbExec.onclick = () => executeModalDbSearch();
}

const modalBtnDbDownloadExcel = document.getElementById('modalBtnDbDownloadExcel');
if (modalBtnDbDownloadExcel) {
    modalBtnDbDownloadExcel.onclick = () => downloadModalDbResultsAsExcel();
}

const modalBtnDbViewExcel = document.getElementById('modalBtnDbViewExcel');
if (modalBtnDbViewExcel) {
    modalBtnDbViewExcel.onclick = () => viewModalDbResultsInExcel();
}

const modalBtnBulkDelete = document.getElementById('modalBtnDbBulkDelete');
if (modalBtnBulkDelete) {
    modalBtnBulkDelete.onclick = executeModalDbBulkDelete;
}

const modalChkDbAll = document.getElementById('modalChkDbAll');
if (modalChkDbAll) {
    modalChkDbAll.addEventListener('change', (e) => {
        const checked = e.target.checked;
        document.querySelectorAll('.modal-db-row-chk').forEach(chk => {
            chk.checked = checked;
        });
        const count = checked ? document.querySelectorAll('.modal-db-row-chk').length : 0;
        const dbSelectedCount = document.getElementById('modalDbSelectedCount');
        if (dbSelectedCount) dbSelectedCount.textContent = count;
    });
}

// ==========================================
// 파레트 재고 관리 (Palette Inventory) 로직
// ==========================================
const btnOpenPalette = document.getElementById('btnOpenPalette');
const paletteInventoryModal = document.getElementById('paletteInventoryModal');
const closePaletteModalBtn = document.getElementById('closePaletteModalBtn');
const paletteTableBody = document.getElementById('paletteTableBody');
const newPaletteType = document.getElementById('newPaletteType');
const btnAddPaletteType = document.getElementById('btnAddPaletteType');
const btnEditPaletteMode = document.getElementById('btnEditPaletteMode');
const btnCopyPaletteImage = document.getElementById('btnCopyPaletteImage');
const btnSavePaletteImage = document.getElementById('btnSavePaletteImage');

const paletteDateInput = document.getElementById('paletteDateInput');
const paletteCaptureDateStr = document.getElementById('paletteCaptureDateStr');

let paletteTypes = [];
let paletteEditMode = false;
let paletteDailyData = {}; // { 'YYYY-MM-DD': { '20P': 465, ... } }
let currentPaletteDate = ''; // 'YYYY-MM-DD'
let paletteDataMap = {}; // Current displayed map

function loadPaletteData() {
    // Load types
    const savedTypes = localStorage.getItem('paletteTypes');
    if (savedTypes) {
        try { paletteTypes = JSON.parse(savedTypes); }
        catch (e) { paletteTypes = ['20P', '18P', 'EL18P', '15P', '13P']; }
    } else {
        paletteTypes = ['20P', '18P', 'EL18P', '15P', '13P'];
    }
    
    // Load daily data
    const savedDaily = localStorage.getItem('paletteDailyData');
    if (savedDaily) {
        try { paletteDailyData = JSON.parse(savedDaily); }
        catch (e) { paletteDailyData = {}; }
    } else {
        paletteDailyData = {};
    }
}

function savePaletteTypes() {
    localStorage.setItem('paletteTypes', JSON.stringify(paletteTypes));
}

function savePaletteDailyData() {
    if (currentPaletteDate) {
        paletteDailyData[currentPaletteDate] = paletteDataMap;
        localStorage.setItem('paletteDailyData', JSON.stringify(paletteDailyData));
    }
}

function changePaletteDate(dateStr) {
    currentPaletteDate = dateStr;
    if (paletteDateInput) paletteDateInput.value = dateStr;
    
    if (paletteCaptureDateStr) {
        const parts = dateStr.split('-');
        paletteCaptureDateStr.textContent = `(${parts[0]}년 ${parseInt(parts[1], 10)}월 ${parseInt(parts[2], 10)}일)`;
    }
    
    paletteDataMap = paletteDailyData[dateStr] || {};
    renderPaletteTable();
}

if (paletteDateInput) {
    paletteDateInput.addEventListener('change', (e) => {
        if (e.target.value) {
            changePaletteDate(e.target.value);
        }
    });
}

function calculatePaletteVehicles(type, qty) {
    if (!qty || isNaN(qty)) return '';
    let divisor = 90;
    if (type === '20P' || type === '18P') {
        divisor = 75;
    }
    return Math.round(qty / divisor);
}

function renderPaletteTable() {
    if (!paletteTableBody) return;
    paletteTableBody.innerHTML = '';
    
    paletteTypes.forEach((type, index) => {
        const qty = paletteDataMap[type] || '';
        const vehicle = calculatePaletteVehicles(type, qty);
        
        const tr = document.createElement('tr');
        
        // 구분
        const tdType = document.createElement('td');
        tdType.style.padding = '12px 10px';
        tdType.style.borderBottom = '1px solid #e2e8f0';
        tdType.style.borderRight = '1px solid #f1f5f9';
        tdType.style.fontWeight = '700';
        tdType.style.color = '#334155';
        
        if (paletteEditMode) {
            tdType.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span>${type}</span>
                    <button class="btn-delete-palette" data-idx="${index}" style="background:none; border:none; color:#ef4444; cursor:pointer;"><i class="fas fa-trash-alt"></i></button>
                </div>
            `;
        } else {
            tdType.textContent = type;
        }
        
        // 수량
        const tdQty = document.createElement('td');
        tdQty.style.padding = '10px';
        tdQty.style.borderBottom = '1px solid #e2e8f0';
        tdQty.style.borderRight = '1px solid #f1f5f9';
        tdQty.style.textAlign = 'center';
        
        const inputQty = document.createElement('input');
        inputQty.type = 'number';
        inputQty.value = qty;
        inputQty.style.width = '100%';
        inputQty.style.border = '1px solid transparent';
        inputQty.style.textAlign = 'center';
        inputQty.style.fontSize = '15px';
        inputQty.style.fontWeight = '600';
        inputQty.style.color = '#0f172a';
        inputQty.style.outline = 'none';
        inputQty.style.background = 'transparent';
        inputQty.placeholder = '-';
        inputQty.style.borderRadius = '4px';
        
        inputQty.addEventListener('focus', () => { inputQty.style.border = '1px solid #cbd5e1'; inputQty.style.background = '#f8fafc'; });
        inputQty.addEventListener('blur', () => { inputQty.style.border = '1px solid transparent'; inputQty.style.background = 'transparent'; });
        
        // 차량 텍스트
        const tdVehicle = document.createElement('td');
        tdVehicle.style.padding = '12px 10px';
        tdVehicle.style.borderBottom = '1px solid #e2e8f0';
        tdVehicle.style.textAlign = 'center';
        tdVehicle.style.fontWeight = '600';
        tdVehicle.style.color = '#10b981';
        tdVehicle.style.fontSize = '15px';
        tdVehicle.textContent = vehicle;
        
        inputQty.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            paletteDataMap[type] = isNaN(val) ? '' : val;
            tdVehicle.textContent = calculatePaletteVehicles(type, paletteDataMap[type]);
            savePaletteDailyData();
        });
        
        inputQty.addEventListener('paste', (e) => {
            e.preventDefault();
            const pasteData = (e.clipboardData || window.clipboardData).getData('text');
            if (!pasteData) return;
            
            const lines = pasteData.split(/\r?\n/).map(s => s.trim()).filter(s => s !== '');
            for (let i = 0; i < lines.length && (index + i) < paletteTypes.length; i++) {
                const targetType = paletteTypes[index + i];
                const val = parseFloat(lines[i].replace(/,/g, ''));
                paletteDataMap[targetType] = isNaN(val) ? '' : val;
            }
            savePaletteDailyData();
            renderPaletteTable();
        });
        
        tdQty.appendChild(inputQty);
        tr.appendChild(tdType);
        tr.appendChild(tdQty);
        tr.appendChild(tdVehicle);
        
        // Hover effect
        tr.addEventListener('mouseenter', () => { tr.style.backgroundColor = '#f8fafc'; });
        tr.addEventListener('mouseleave', () => { tr.style.backgroundColor = 'transparent'; });
        
        paletteTableBody.appendChild(tr);
    });

    if (paletteEditMode) {
        document.querySelectorAll('.btn-delete-palette').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = e.currentTarget.getAttribute('data-idx');
                const typeToDelete = paletteTypes[idx];
                paletteTypes.splice(idx, 1);
                // Also remove from map
                delete paletteDataMap[typeToDelete];
                savePaletteTypes();
                savePaletteDailyData();
                renderPaletteTable();
            });
        });
    }
}

if (btnOpenPalette) {
    btnOpenPalette.addEventListener('click', () => {
        loadPaletteData();
        paletteEditMode = false;
        if (btnEditPaletteMode) btnEditPaletteMode.textContent = '편집 모드';
        
        const today = new Date();
        const yy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        changePaletteDate(`${yy}-${mm}-${dd}`);
        
        if (paletteInventoryModal) paletteInventoryModal.style.display = 'flex';
    });
}

if (closePaletteModalBtn) {
    closePaletteModalBtn.addEventListener('click', () => {
        if (paletteInventoryModal) paletteInventoryModal.style.display = 'none';
    });
}

if (paletteInventoryModal) {
    paletteInventoryModal.addEventListener('click', (e) => {
        if (e.target === paletteInventoryModal) {
            paletteInventoryModal.style.display = 'none';
        }
    });
}

if (btnAddPaletteType) {
    btnAddPaletteType.addEventListener('click', () => {
        const type = (newPaletteType.value || '').trim();
        if (!type) return;
        if (paletteTypes.includes(type)) {
            alert('이미 존재하는 구분입니다.');
            return;
        }
        paletteTypes.push(type);
        savePaletteTypes();
        newPaletteType.value = '';
        renderPaletteTable();
    });
}

if (btnEditPaletteMode) {
    btnEditPaletteMode.addEventListener('click', () => {
        paletteEditMode = !paletteEditMode;
        btnEditPaletteMode.textContent = paletteEditMode ? '완료' : '편집 모드';
        renderPaletteTable();
    });
}

async function capturePaletteTable() {
    const target = document.getElementById('paletteCaptureArea');
    if (!target) return null;
    
    // 캡처 시 인풋 박스 값을 확실히 렌더링하기 위해 span으로 임시 교체
    const inputs = target.querySelectorAll('input');
    const placeholders = [];
    inputs.forEach(input => {
        const span = document.createElement('span');
        span.textContent = input.value || '-'; // 빈 칸이면 '-' 표기
        span.style.display = 'inline-block';
        span.style.width = '100%';
        span.style.textAlign = 'center';
        span.style.fontSize = '15px';
        span.style.fontWeight = '600';
        span.style.color = '#0f172a';
        
        const parent = input.parentNode;
        parent.insertBefore(span, input);
        input.style.display = 'none';
        
        placeholders.push({ input, span });
    });

    try {
        const canvas = await html2canvas(target, {
            scale: 2,
            useCORS: true,
            backgroundColor: '#ffffff'
        });
        
        return new Promise((resolve) => {
            canvas.toBlob((blob) => {
                resolve(blob);
            }, 'image/png');
        });
    } catch (e) {
        console.error(e);
        return null;
    } finally {
        placeholders.forEach(p => {
            p.input.style.display = '';
            p.span.remove();
        });
    }
}

if (btnCopyPaletteImage) {
    btnCopyPaletteImage.addEventListener('click', async () => {
        btnCopyPaletteImage.disabled = true;
        const origText = btnCopyPaletteImage.innerHTML;
        btnCopyPaletteImage.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 복사중...';
        
        try {
            const blob = await capturePaletteTable();
            if (!blob) throw new Error('캡처 실패');
            
            if (window.isElectron && window.electronAPI && typeof window.electronAPI.writeImageToClipboard === 'function') {
                const reader = new FileReader();
                reader.onload = async function () {
                    await window.electronAPI.writeImageToClipboard(reader.result);
                    alert('📋 이미지가 클립보드에 복사되었습니다.\n카카오톡에 Ctrl+V로 붙여넣기 하세요.');
                };
                reader.readAsDataURL(blob);
            } else if (navigator.clipboard && window.ClipboardItem) {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                alert('📋 이미지가 클립보드에 복사되었습니다.\n카카오톡에 Ctrl+V로 붙여넣기 하세요.');
            } else {
                throw new Error('브라우저에서 이미지 클립보드 복사를 지원하지 않습니다.');
            }
        } catch (err) {
            console.error(err);
            alert('복사 중 오류가 발생했습니다.');
        } finally {
            btnCopyPaletteImage.disabled = false;
            btnCopyPaletteImage.innerHTML = origText;
        }
    });
}

if (btnSavePaletteImage) {
    btnSavePaletteImage.addEventListener('click', async () => {
        btnSavePaletteImage.disabled = true;
        const origText = btnSavePaletteImage.innerHTML;
        btnSavePaletteImage.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장중...';
        
        try {
            const blob = await capturePaletteTable();
            if (!blob) throw new Error('캡처 실패');
            
            const today = new Date();
            const dateStr = `${today.getFullYear()}${(today.getMonth()+1).toString().padStart(2,'0')}${today.getDate().toString().padStart(2,'0')}`;
            saveAs(blob, `파레트재고_${dateStr}.png`);
        } catch (err) {
            console.error(err);
            alert('저장 중 오류가 발생했습니다.');
        } finally {
            btnSavePaletteImage.disabled = false;
            btnSavePaletteImage.innerHTML = origText;
        }
    });
}

// --- Login Screen Logic ---
function initLoginScreen() {
    const loginOverlay = document.getElementById('loginOverlay');
    const loginId = document.getElementById('loginId');
    const loginPw = document.getElementById('loginPw');
    const btnLogin = document.getElementById('btnLogin');
    const loginErrorMsg = document.getElementById('loginErrorMsg');
    const saveIdCheckbox = document.getElementById('saveIdCheckbox');
    
    if (!loginOverlay || !btnLogin || !loginId || !loginPw) return;

    // Check if there is a saved ID in localStorage
    const savedId = localStorage.getItem('excelcompare_saved_id');
    if (savedId) {
        loginId.value = savedId;
        if (saveIdCheckbox) saveIdCheckbox.checked = true;
        setTimeout(() => loginPw.focus(), 150);
    } else {
        setTimeout(() => loginId.focus(), 150);
    }

    function attemptLogin() {
        const id = loginId.value.trim();
        const pw = loginPw.value.trim();
        
        console.log('[Login Attempt] ID:', id);

        if (id === 'admin' && pw === 'z456qwe12!@') {
            // Success
            if (loginErrorMsg) loginErrorMsg.style.display = 'none';
            loginOverlay.style.transition = 'opacity 0.3s ease';
            loginOverlay.style.opacity = '0';
            
            // Handle Save ID
            if (saveIdCheckbox && saveIdCheckbox.checked) {
                localStorage.setItem('excelcompare_saved_id', id);
            } else {
                localStorage.removeItem('excelcompare_saved_id');
            }
            
            setTimeout(() => {
                loginOverlay.style.display = 'none';
            }, 300);
        } else {
            // Fail
            if (loginErrorMsg) loginErrorMsg.style.display = 'block';
            loginPw.value = ''; // clear password on fail
            loginPw.focus();
        }
    }

    btnLogin.onclick = attemptLogin;

    // Allow Enter key to submit
    loginId.onkeydown = (e) => {
        if (e.key === 'Enter') {
            if (loginPw.value) attemptLogin();
            else loginPw.focus();
        }
    };

    loginPw.onkeydown = (e) => {
        if (e.key === 'Enter') attemptLogin();
    };
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLoginScreen);
} else {
    initLoginScreen();
}

/* =========================================================================
 *  PRE-WORK AVAILABILITY ANALYSIS (사전 작업 가용성 & 재고 분석 모듈)
 * ========================================================================= */
let rawAvailabilityItems = [];       // 원본 엑셀에서 추출한 전체 작업 행 데이터
let processedAvailabilityData = [];   // 재고 대조 및 상태 판정이 완료된 분석 데이터
let currentAvailSheetFilter = 'all';  // 'all', '직선적당일', '법인당일', '혼적당일', '재작업당일', 'possible', 'impossible'
let currentAvailStatusFilter = 'all'; // 'all', 'OK', 'BLOCK_WARN', 'SHORTAGE', 'NO_STOCK'
let currentAvailSearchQuery = '';
let currentAvailSearchField = 'all';
let selectedAvailRows = new Set();    // 체크박스 선택된 항목 키 Set

// 실행 함수: 전산파일 없이 원본 3개 시트 + 창고재고 대조
window.runPreWorkAvailabilityCheck = async function(isSilent = false) {
    let allRows = [];

    // 1. 이미 originalData(Array)가 메모리에 있는 경우 바로 사용
    if (originalData && Array.isArray(originalData) && originalData.length > 0) {
        allRows = originalData;
    } else {
        const origPath = (pathOriginal && pathOriginal.value.trim() !== "") ? pathOriginal.value.trim() : (localStorage.getItem('pathOrig') || '');
        if (origPath) {
            try {
                await reloadLatestFile('original');
                if (originalData && Array.isArray(originalData) && originalData.length > 0) {
                    allRows = originalData;
                }
            } catch (e) {
                console.error("원본 파일 로드 실패:", e);
            }
        }
    }

    if (!allRows || allRows.length === 0) {
        if (!isSilent) alert("원본 엑셀 파일(직선적/법인/혼적당일)을 먼저 선택해주세요.");
        return;
    }

    if (!isSilent && (!warehouseStockLoaded || Object.keys(warehouseStockQtyMap).length === 0)) {
        const proceed = confirm("창고 재고 파일이 아직 등록되지 않았습니다.\n(재고 파일 없이 진행 시 계획 수량만 표시되며 재고 상태는 '미확인'으로 표시됩니다.)\n\n계속 분석을 진행하시겠습니까?");
        if (!proceed) return;
    }

    const btn = document.getElementById('btnRunAvailability');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:4px;"></i>분석 중...';
    }

    try {
        rawAvailabilityItems = allRows;
        processAvailabilityData(allRows);
        renderAvailabilityDashboard();
        renderAvailabilityTable();
        switchMainTab('availability');
    } catch (err) {
        console.error("작업 가용성 분석 실패:", err);
        if (!isSilent) alert("작업 가용성 분석 중 오류가 발생했습니다: " + err.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-clipboard-check" style="font-size: 0.85rem;"></i><span>작업 분석</span>';
        }
    }
};

// 재고 대조 및 상태 판정 처리
function processAvailabilityData(rows) {
    selectedAvailRows.clear();

    // 1. 동일 작업(시트+작업명+컨테이너+도착지+선사+규격) 내에서 동일 제품(cleanName)끼리 계획수량(qty) 합산
    const mergedRowsMap = new Map();
    rows.forEach(r => {
        const sheetName = (r.sheetName || "").trim();
        const jobName = (r.jobName || "").trim() || '-';
        const cntrNo = (r.cntrNo || "").trim();
        const dest = (r.dest || "").trim() || '-';
        const carrier = (r.carrier || "").trim() || '-';
        const cntrType = (r.cntrType || "").trim() || '-';
        const remark = (r.remark || "").trim() || '-';
        const adj1 = (r.adj1 || "").trim() || (r.rawRow && r.rawRow[21] ? String(r.rawRow[21]).trim() : "-");
        const adj2 = (r.adj2 || "").trim() || (r.rawRow && r.rawRow[22] ? String(r.rawRow[22]).trim() : "-");
        const prodName = (r.prodName || "").trim();
        const cleanName = prodName.toUpperCase();
        const qty = parseInt(r.qty) || 0;

        const mergeKey = `${sheetName}__${jobName}__${cntrNo}__${dest}__${carrier}__${cntrType}__${cleanName}`;

        if (!mergedRowsMap.has(mergeKey)) {
            mergedRowsMap.set(mergeKey, {
                ...r,
                sheetName,
                jobName,
                cntrNo,
                dest,
                carrier,
                cntrType,
                remark,
                adj1,
                adj2,
                prodName,
                cleanName,
                qty: qty
            });
        } else {
            const existing = mergedRowsMap.get(mergeKey);
            existing.qty += qty;
            if ((!existing.prodType || existing.prodType === '-') && r.prodType) existing.prodType = r.prodType;
            if ((!existing.division || existing.division === '-') && r.division) existing.division = r.division;
            if ((!existing.adj1 || existing.adj1 === '-') && adj1 !== '-') existing.adj1 = adj1;
            if ((!existing.adj2 || existing.adj2 === '-') && adj2 !== '-') existing.adj2 = adj2;
            if ((!existing.remark || existing.remark === '-') && remark !== '-') existing.remark = remark;
        }
    });

    const consolidatedRows = Array.from(mergedRowsMap.values());

    // 당일 전체 작업 기준 모델(cleanName)별 총소요 계획 수량 사전 집계
    const totalModelReqMap = new Map();
    consolidatedRows.forEach(r => {
        const cName = r.cleanName;
        const q = r.qty || 0;
        totalModelReqMap.set(cName, (totalModelReqMap.get(cName) || 0) + q);
    });

    processedAvailabilityData = consolidatedRows.map((r, idx) => {
        const prodName = r.prodName;
        const cleanName = r.cleanName;
        const sheetName = r.sheetName;
        const qty = r.qty;
        const totalModelReq = totalModelReqMap.get(cleanName) || qty;
        const cntrNo = r.cntrNo;
        const jobName = r.jobName;
        const dest = r.dest;
        const carrier = r.carrier;
        const cntrType = r.cntrType;
        const remark = r.remark;
        const adj1 = r.adj1 || '-';
        const adj2 = r.adj2 || '-';

        // 제품구분(prodType) 및 사업부(division) 추출
        let rawProdType = (r.prodType || "").trim();
        let division = (r.division || "").trim();
        let prodType = rawProdType;

        // 원본 G열이 3자리 사업부 코드(CVZ, CNZ, CDZ, DFZ 등)인 경우 사업부로 할당
        const isDivCode = /^[A-Z]{2}Z$/i.test(rawProdType) || ["DFZ", "CVZ", "CNZ", "CDZ"].includes(rawProdType.toUpperCase());
        if (isDivCode && !division) {
            division = rawProdType;
            prodType = '';
        }

        // 창고 재고 조회
        const stockInfo = warehouseStockQtyMap[cleanName];
        let hasStock = !!stockInfo;
        let physical = 0, good = 0, oqc = 0, longTerm = 0, bin = 0, pending = 0, block = 0;

        if (stockInfo) {
            physical = stockInfo.physical || 0;
            good = stockInfo.good !== undefined ? stockInfo.good : (stockInfo.available || 0);
            oqc = stockInfo.oqc || 0;
            longTerm = stockInfo.longTerm || 0;
            bin = stockInfo.bin || 0;
            pending = stockInfo.pending || 0;
            block = stockInfo.block || (oqc + longTerm + bin);
            if (!division && stockInfo.division) {
                division = stockInfo.division;
            }
        }

        // 창고 재고 리스트에서 사업부 보완
        if (!division && warehouseAllStockList && Array.isArray(warehouseAllStockList)) {
            const stockMatch = warehouseAllStockList.find(s => (s.modelName || '').trim().toUpperCase() === cleanName);
            if (stockMatch && stockMatch.division) {
                division = stockMatch.division;
            }
        }

        // 제품 마스터에서 제품구분 및 사업부 보완
        if (productMaster && Array.isArray(productMaster)) {
            const pmMatch = productMaster.find(p => (p.name || '').trim().toUpperCase() === cleanName);
            if (pmMatch) {
                if (!prodType || prodType === '-') prodType = pmMatch.prodType || pmMatch.type || '';
                if (!division || division === '-') division = pmMatch.division || pmMatch.ba || '';
            }
        }

        if (!prodType) prodType = '-';
        if (!division) division = '-';

        // 1. 정상/가용 재고 로케이션 목록 수집 (창고 전체 재고에서 추출)
        let stockLocs = [];
        if (warehouseAllStockList && Array.isArray(warehouseAllStockList)) {
            const locMatches = warehouseAllStockList.filter(item => (item.modelName || '').trim().toUpperCase() === cleanName);
            locMatches.forEach(item => {
                const locName = (item.location || '미지정').trim();
                const goodQty = item.goodQty !== undefined ? item.goodQty : 0;
                const pendingQty = item.pendingQty !== undefined ? item.pendingQty : 0;
                const totalWork = goodQty + pendingQty;
                const finalQty = totalWork > 0 ? totalWork : (item.physicalQty || 0);
                if (finalQty > 0) {
                    stockLocs.push(`[${locName}] ${finalQty.toLocaleString()} EA`);
                }
            });
        }

        // 2. 블록 로케이션 상세 목록 수집
        let blockLocs = [];
        if (warehouseHoldStockList && Array.isArray(warehouseHoldStockList)) {
            const locList = warehouseHoldStockList.filter(h => (h.modelName || "").trim().toUpperCase() === cleanName);
            locList.forEach(loc => {
                let tags = [];
                if (loc.oqcHold > 0) tags.push(`OQC ${loc.oqcHold}EA`);
                if (loc.longTermHold > 0) tags.push(`롱텀 ${loc.longTermHold}EA`);
                if (loc.binBlock > 0) tags.push(`BIN ${loc.binBlock}EA`);
                if (tags.length > 0) {
                    blockLocs.push(`[${loc.location || '-'}] ${tags.join(', ')}`);
                }
            });
        }

        // 상태 판정 (당일 전체 작업 총소요 수량 기준 대조)
        let status = 'OK';
        let statusLabel = '작업가능';
        let statusClass = 'ok';
        let shortage = 0;

        const isNonAsset = cleanName === 'NONASSET.ITEM' || cleanName.includes('NONASSET');

        if (isNonAsset) {
            hasStock = true;
            good = qty;
            physical = qty;
            status = 'OK';
            statusLabel = '작업가능';
            statusClass = 'ok';
            shortage = 0;
            if (stockLocs.length === 0) {
                stockLocs = ['전산재고 미관리(작업가능)'];
            }
        } else if (!hasStock && (!warehouseStockLoaded || Object.keys(warehouseStockQtyMap).length === 0)) {
            status = 'NO_STOCK';
            statusLabel = '재고 미확인';
            statusClass = 'unknown';
        } else if (!hasStock || (good === 0 && physical === 0)) {
            status = 'NO_STOCK';
            statusLabel = '재고 없음';
            statusClass = 'danger';
            shortage = totalModelReq;
        } else if (good < totalModelReq) {
            // 가용재고가 모든 작업의 총합보다 부족할 경우: 일부작업가능
            status = 'PARTIAL_OK';
            shortage = totalModelReq - good;
            statusLabel = `일부작업가능 (부족 ${shortage.toLocaleString()}EA)`;
            statusClass = 'partial';
        } else if (block > 0) {
            status = 'BLOCK_WARN';
            statusLabel = `블록주의 (${block.toLocaleString()}EA)`;
            statusClass = 'warn';
        } else {
            // 가용재고가 모든 작업의 총합을 넘어서면: 작업가능
            status = 'OK';
            statusLabel = '작업가능';
            statusClass = 'ok';
        }

        return {
            id: `avail_${idx}`,
            sheetName,
            jobName,
            cntrNo: (!cntrNo || cntrNo === '미지정' || cntrNo.includes('WAIT')) ? '미지정' : cntrNo,
            dest,
            carrier,
            cntrType,
            prodName,
            cleanName,
            prodType,
            division,
            qty,
            totalModelReq,
            good,
            oqc,
            longTerm,
            bin,
            pending,
            block,
            physical,
            shortage,
            status,
            statusLabel,
            statusClass,
            isNonAsset,
            stockLocs,
            blockLocs,
            adj1,
            adj2,
            remark,
            transporter: r.transporter || '',
            rawRow: r
        };
    });
}

// 작업 가용성 대시보드 통계 렌더링
function renderAvailabilityDashboard() {
    if (!processedAvailabilityData || processedAvailabilityData.length === 0) return;

    // 전체 고유 작업(컨테이너 그룹) 단위로 그룹핑
    const uniqueJobGroupMap = new Map();
    processedAvailabilityData.forEach(item => {
        const groupKey = `${item.sheetName}__${item.jobName}__${item.cntrNo}__${item.dest}__${item.carrier}__${item.cntrType}`;
        if (!uniqueJobGroupMap.has(groupKey)) {
            uniqueJobGroupMap.set(groupKey, {
                sheetName: item.sheetName,
                items: []
            });
        }
        uniqueJobGroupMap.get(groupKey).items.push(item);
    });

    const totalUniqueJobs = uniqueJobGroupMap.size;
    const totalQty = processedAvailabilityData.reduce((acc, d) => acc + d.qty, 0);
    const uniqueModels = new Set(processedAvailabilityData.map(d => d.cleanName)).size;

    let directJobCount = 0;
    let corpJobCount = 0;
    let mixedJobCount = 0;
    let reworkJobCount = 0;
    let possibleGroupCount = 0;
    let partialGroupCount = 0;
    let blockWarnGroupCount = 0;
    let noStockGroupCount = 0;

    uniqueJobGroupMap.forEach(group => {
        if (group.sheetName.includes('직선적')) directJobCount++;
        else if (group.sheetName.includes('법인')) corpJobCount++;
        else if (group.sheetName.includes('혼적')) mixedJobCount++;
        else if (group.sheetName.includes('재작업')) reworkJobCount++;

        const hasNoStock = group.items.some(it => it.status === 'NO_STOCK');
        const hasPartial = group.items.some(it => it.status === 'PARTIAL_OK');
        const hasWarn = group.items.some(it => it.status === 'BLOCK_WARN');

        if (hasNoStock) noStockGroupCount++;
        else if (hasPartial) partialGroupCount++;
        else if (hasWarn) blockWarnGroupCount++;
        else possibleGroupCount++;
    });

    const impossibleGroupCount = partialGroupCount + blockWarnGroupCount + noStockGroupCount;

    // 대시보드 상단 수량 카드 렌더링
    const elTotal = document.getElementById('valAvailTotalJobs');
    const elTotalSub = document.getElementById('subAvailTotalItems');
    if (elTotal) elTotal.innerHTML = `${totalUniqueJobs.toLocaleString()} <span class="unit">건</span>`;
    if (elTotalSub) elTotalSub.textContent = `품목 ${uniqueModels.toLocaleString()}개 / ${totalQty.toLocaleString()} EA`;

    const elOk = document.getElementById('valAvailSuccessJobs');
    const elOkSub = document.getElementById('subAvailSuccessItems');
    if (elOk) elOk.innerHTML = `${possibleGroupCount.toLocaleString()} <span class="unit">건</span>`;
    if (elOkSub) elOkSub.textContent = `가용재고 충분 & 블록 0`;

    const elWarn = document.getElementById('valAvailBlockWarnJobs');
    const elWarnSub = document.getElementById('subAvailBlockWarnItems');
    if (elWarn) elWarn.innerHTML = `${blockWarnGroupCount.toLocaleString()} <span class="unit">건</span>`;
    const totalBlockQty = processedAvailabilityData.reduce((acc, d) => acc + d.block, 0);
    if (elWarnSub) elWarnSub.textContent = `블록재고 ${totalBlockQty.toLocaleString()} EA 감지`;

    const elShort = document.getElementById('valAvailShortageJobs');
    const elShortSub = document.getElementById('subAvailShortageItems');
    if (elShort) elShort.innerHTML = `${partialGroupCount.toLocaleString()} <span class="unit">건</span>`;
    const partialModels = Array.from(new Set(processedAvailabilityData.filter(d => d.status === 'PARTIAL_OK').map(d => d.cleanName)));
    if (elShortSub) elShortSub.textContent = `일부작업가능 ${partialModels.length}개 모델 감지`;

    const elNoStock = document.getElementById('valAvailNoStockJobs');
    const elNoStockSub = document.getElementById('subAvailNoStockItems');
    if (elNoStock) elNoStock.innerHTML = `${noStockGroupCount.toLocaleString()} <span class="unit">건</span>`;
    if (elNoStockSub) elNoStockSub.textContent = `창고재고 파일 내 미확인`;

    const elSheetAll = document.getElementById('cntAvailSheetAll');
    const elSheetDirect = document.getElementById('cntAvailSheetDirect');
    const elSheetCorp = document.getElementById('cntAvailSheetCorp');
    const elSheetMixed = document.getElementById('cntAvailSheetMixed');
    const elSheetRework = document.getElementById('cntAvailSheetRework');
    const elSheetImpossible = document.getElementById('cntAvailSheetImpossible');
    const elSheetPossible = document.getElementById('cntAvailSheetPossible');

    if (elSheetAll) elSheetAll.textContent = totalUniqueJobs;
    if (elSheetDirect) elSheetDirect.textContent = directJobCount;
    if (elSheetCorp) elSheetCorp.textContent = corpJobCount;
    if (elSheetMixed) elSheetMixed.textContent = mixedJobCount;
    if (elSheetRework) elSheetRework.textContent = reworkJobCount;
    if (elSheetPossible) elSheetPossible.textContent = possibleGroupCount;
    if (elSheetImpossible) elSheetImpossible.textContent = impossibleGroupCount;
}

// 상세 테이블 렌더링 (작업/컨테이너 단위 Rowspan 병합 & 다중 조건 필터링)
function renderAvailabilityTable() {
    const tbody = document.getElementById('availTableBody');
    if (!tbody) return;

    // 1. 먼저 전체 데이터를 작업 단위(Group)로 매핑
    const allGroupsMap = new Map();
    processedAvailabilityData.forEach(item => {
        const groupKey = `${item.sheetName}__${item.jobName}__${item.cntrNo}__${item.dest}__${item.carrier}__${item.cntrType}`;
        if (!allGroupsMap.has(groupKey)) {
            allGroupsMap.set(groupKey, {
                groupKey,
                sheetName: item.sheetName,
                jobName: item.jobName,
                cntrNo: item.cntrNo,
                dest: item.dest,
                carrier: item.carrier,
                cntrType: item.cntrType,
                transporter: item.transporter || '',
                remark: item.remark,
                items: []
            });
        }
        allGroupsMap.get(groupKey).items.push(item);
    });

    let groups = Array.from(allGroupsMap.values());

    // 2. 시트 및 '불가능/가능 작업만' 필터 적용 (그룹 단위)
    if (currentAvailSheetFilter === 'impossible') {
        groups = groups.filter(g => {
            const hasNoStock = g.items.some(it => it.status === 'NO_STOCK');
            const hasPartial = g.items.some(it => it.status === 'PARTIAL_OK');
            const hasBlockWarn = g.items.some(it => it.status === 'BLOCK_WARN');
            return hasNoStock || hasPartial || hasBlockWarn;
        });
    } else if (currentAvailSheetFilter === 'possible') {
        groups = groups.filter(g => {
            const hasNoStock = g.items.some(it => it.status === 'NO_STOCK');
            const hasPartial = g.items.some(it => it.status === 'PARTIAL_OK');
            const hasBlockWarn = g.items.some(it => it.status === 'BLOCK_WARN');
            return !hasNoStock && !hasPartial && !hasBlockWarn;
        });
    } else if (currentAvailSheetFilter !== 'all') {
        groups = groups.filter(g => g.sheetName.includes(currentAvailSheetFilter));
    }

    // 3. 상태 필터 적용 (품목 단위가 아닌 그룹 내 조건 포함 여부)
    if (currentAvailStatusFilter !== 'all') {
        groups = groups.filter(g => {
            if (currentAvailStatusFilter === 'OK') return g.items.every(it => it.status === 'OK');
            if (currentAvailStatusFilter === 'PARTIAL_OK') return g.items.some(it => it.status === 'PARTIAL_OK');
            if (currentAvailStatusFilter === 'BLOCK_WARN') return g.items.some(it => it.status === 'BLOCK_WARN');
            if (currentAvailStatusFilter === 'SHORTAGE') return g.items.some(it => it.status === 'SHORTAGE' || it.status === 'PARTIAL_OK');
            if (currentAvailStatusFilter === 'NO_STOCK') return g.items.some(it => it.status === 'NO_STOCK');
            return true;
        });
    }

    // 4. 다중 조건 텍스트 검색 필터 적용
    const q = (currentAvailSearchQuery || "").trim().toLowerCase();
    if (q) {
        groups = groups.filter(g => {
            if (currentAvailSearchField === 'jobName') {
                return (g.jobName || '').toLowerCase().includes(q);
            } else if (currentAvailSearchField === 'cntrNo') {
                return (g.cntrNo || '').toLowerCase().includes(q);
            } else if (currentAvailSearchField === 'model') {
                return g.items.some(it => (it.prodName || '').toLowerCase().includes(q) || (it.cleanName || '').toLowerCase().includes(q));
            } else if (currentAvailSearchField === 'dest') {
                return (g.dest || '').toLowerCase().includes(q);
            } else if (currentAvailSearchField === 'carrier') {
                return (g.carrier || '').toLowerCase().includes(q);
            } else {
                // 통합 검색 ('all')
                const inGroupMeta = (g.sheetName || '').toLowerCase().includes(q) ||
                                    (g.jobName || '').toLowerCase().includes(q) ||
                                    (g.cntrNo || '').toLowerCase().includes(q) ||
                                    (g.dest || '').toLowerCase().includes(q) ||
                                    (g.carrier || '').toLowerCase().includes(q) ||
                                    (g.cntrType || '').toLowerCase().includes(q) ||
                                    (g.remark || '').toLowerCase().includes(q);
                const inItems = g.items.some(it => (it.prodName || '').toLowerCase().includes(q) || 
                                                  (it.cleanName || '').toLowerCase().includes(q) ||
                                                  (it.statusLabel || '').toLowerCase().includes(q) ||
                                                  (it.division || '').toLowerCase().includes(q) ||
                                                  (it.adj1 || '').toLowerCase().includes(q) ||
                                                  (it.adj2 || '').toLowerCase().includes(q));
                return inGroupMeta || inItems;
            }
        });
    }

    if (groups.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="20" style="padding: 40px; text-align: center; color: #94a3b8;">
                    <i class="fas fa-search" style="font-size: 2.2rem; color: #cbd5e1; margin-bottom: 10px; display: block;"></i>
                    조건에 해당하는 분석 결과가 없습니다.
                </td>
            </tr>
        `;
        return;
    }

    const fragment = document.createDocumentFragment();
    groups.forEach((group, gIdx) => {
        const N = group.items.length;
        const totalPlanQty = group.items.reduce((acc, it) => acc + it.qty, 0);

        // 그룹 종합 상태 판정
        const hasNoStock = group.items.some(it => it.status === 'NO_STOCK');
        const hasPartial = group.items.some(it => it.status === 'PARTIAL_OK');
        const hasBlockWarn = group.items.some(it => it.status === 'BLOCK_WARN');
        const allNoStock = group.items.every(it => it.status === 'NO_STOCK');

        let groupStatus = 'OK';
        let groupStatusLabel = '작업가능';
        let groupStatusClass = 'ok';
        if (hasNoStock) {
            groupStatus = 'NO_STOCK';
            groupStatusLabel = '재고부족';
            groupStatusClass = 'danger';
        } else if (hasPartial) {
            groupStatus = 'PARTIAL_OK';
            groupStatusLabel = '일부작업가능';
            groupStatusClass = 'partial';
        } else if (hasBlockWarn) {
            groupStatus = 'BLOCK_WARN';
            groupStatusLabel = '블록주의';
            groupStatusClass = 'warn';
        } else if (allNoStock) {
            groupStatus = 'NO_STOCK';
            groupStatusLabel = '미확인';
            groupStatusClass = 'unknown';
        }

        let sheetTagClass = 'direct';
        if (group.sheetName.includes('법인')) sheetTagClass = 'corp';
        else if (group.sheetName.includes('혼적')) sheetTagClass = 'mixed';
        else if (group.sheetName.includes('재작업')) sheetTagClass = 'rework';

        // 그룹 내 모든 블록 로케이션 취합
        const allLocs = [];
        group.items.forEach(it => {
            if (it.blockLocs && it.blockLocs.length > 0) {
                it.blockLocs.forEach(loc => {
                    const desc = `[${it.prodName}] ${loc}`;
                    if (!allLocs.includes(desc)) allLocs.push(desc);
                });
            }
        });
        const groupBlockLocText = allLocs.length > 0 ? allLocs.join('\n') : (group.remark !== '-' ? group.remark : '-');

        const isGroupAllChecked = group.items.every(it => selectedAvailRows.has(it.id));
        const zebraClass = (gIdx % 2 === 0) ? 'avail-group-even' : 'avail-group-odd';
        const groupBorderClass = hasNoStock ? 'avail-group-shortage' : (hasPartial ? 'avail-group-partial' : (hasBlockWarn ? 'avail-group-warn' : ''));

        // 컨테이너 번호 색상 판정 (천마: 빨강 #dc2626, BNI: 파랑 #2563eb, 기타: #0f172a, 미지정: #94a3b8)
        const trans = (group.transporter || (group.items[0] && group.items[0].transporter) || '').trim();
        let cntrColor = '#0f172a';
        let transTitle = '클릭하여 컨테이너번호 복사';

        if (group.cntrNo === '미지정') {
            cntrColor = '#94a3b8';
        } else if (trans.includes('천마') || trans.includes('빨강')) {
            cntrColor = '#dc2626'; // 빨강 (천마)
            transTitle = '천마(빨강) - 클릭하여 복사';
        } else if (trans.includes('BNI') || trans.includes('파랑')) {
            cntrColor = '#2563eb'; // 파랑 (BNI)
            transTitle = 'BNI(파랑) - 클릭하여 복사';
        } else {
            cntrColor = '#0f172a'; // 일반
        }

        group.items.forEach((item, idx) => {
            const tr = document.createElement('tr');
            tr.className = `avail-row ${zebraClass} ${groupBorderClass} ${idx === 0 ? 'avail-group-first' : ''}`;
            if (item.status === 'SHORTAGE' || item.status === 'NO_STOCK') tr.classList.add('item-shortage');

            let html = '';

            // 첫 번째 행에서만 공통 컬럼들을 rowspan으로 병합 출력
            if (idx === 0) {
                html += `
                    <td rowspan="${N}" class="merged-cell text-center" style="vertical-align: middle; background: inherit; text-align: center;">
                        <input type="checkbox" ${isGroupAllChecked ? 'checked' : ''} 
                               onchange="window.toggleSelectAvailGroup('${group.groupKey.replace(/'/g, "\\'")}', event)" 
                               style="width: 15px; height: 15px; cursor: pointer;" title="해당 작업 전체 선택">
                    </td>
                    <td rowspan="${N}" class="merged-cell text-center" style="vertical-align: middle; background: inherit; text-align: center;">
                        <span class="tag-avail-sheet ${sheetTagClass}">${group.sheetName}</span>
                    </td>
                    <td rowspan="${N}" class="merged-cell text-center" style="vertical-align: middle; background: inherit; text-align: center;">
                        <div style="font-weight: 700; color: #0f172a; font-size: 0.84rem; text-align: center;" title="${group.jobName}">${group.jobName}</div>
                        <div style="display: flex; align-items: center; justify-content: center; gap: 4px; margin-top: 3px; flex-wrap: wrap;">
                            <span class="avail-item-count-badge">${N}개 모델 / 총 ${totalPlanQty.toLocaleString()} EA</span>
                            <span class="badge-avail-status ${groupStatusClass}" style="font-size: 0.68rem; padding: 1px 5px;">${groupStatusLabel}</span>
                        </div>
                    </td>
                    <td rowspan="${N}" class="merged-cell text-center" style="vertical-align: middle; background: inherit; text-align: center; color: ${cntrColor}; font-weight: ${group.cntrNo === '미지정' ? '500' : '800'};">
                        <strong onclick="window.copyToClipboard('${group.cntrNo}', '컨테이너')" style="cursor: pointer; color: ${cntrColor};" title="${transTitle}">${group.cntrNo}</strong>
                        ${typeof window.renderContainerPhotoBtn === 'function' ? window.renderContainerPhotoBtn(group.cntrNo) : ''}
                    </td>
                    <td rowspan="${N}" class="merged-cell text-center" style="vertical-align: middle; background: inherit; text-align: center; font-weight: 600;">${group.dest}</td>
                    <td rowspan="${N}" class="merged-cell text-center" style="vertical-align: middle; background: inherit; text-align: center;">${group.carrier}</td>
                    <td rowspan="${N}" class="merged-cell text-center" style="vertical-align: middle; background: inherit; text-align: center;">${group.cntrType}</td>
                `;
            }

            // 품목별 개별 열 출력 (모든 행)
            const prodType = item.prodType && item.prodType !== '-' ? item.prodType : '';
            const division = item.division && item.division !== '-' ? item.division : '';
            const prodTypeClass = prodType === 'Q' ? 'q-type' : (prodType === 'H' ? 'h-type' : '');
            let divClass = '';
            if (division.includes('CVZ')) divClass = 'cvz-type';
            else if (division.includes('CNZ')) divClass = 'cnz-type';
            else if (division.includes('CDZ')) divClass = 'cdz-type';

            html += `
                <td class="text-center" style="vertical-align: middle; background: inherit;">
                    ${prodType ? `<span class="tag-prod-type ${prodTypeClass}">${prodType}</span>` : '<span style="color:#cbd5e1;">-</span>'}
                </td>
                <td class="text-center" style="vertical-align: middle; background: inherit;">
                    ${division ? `<span class="tag-prod-division ${divClass}">${division}</span>` : '<span style="color:#cbd5e1;">-</span>'}
                </td>
                <td style="cursor: pointer; vertical-align: middle; background: inherit;" 
                    onclick="window.copyToClipboard('${item.prodName.replace(/'/g, "\\'")}', '제품명')"
                    title="클릭하여 제품명 복사 (마우스 오버 시 로케이션별 재고 확인)">
                    <div style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
                        <span class="product-name-hoverable" 
                              onmouseenter="window.handleProductMouseEnter('${item.prodName.replace(/'/g, "\\'")}', this, '${(item.prodType || '').replace(/'/g, "\\'")}')" 
                              onmouseleave="window.handleProductMouseLeave()"
                              style="color: ${item.prodType === 'H' ? '#7c3aed' : item.prodType === 'Q' ? '#0d9488' : '#0f172a'}; font-weight: 700;">
                            ${item.prodName}
                        </span>
                        ${getDongTag(item.prodName, item.prodType)}
                        ${getYuTag(item.prodName, item.prodType)}
                        ${item.status === 'PARTIAL_OK' ? `<span class="badge" style="background: #fff7ed; color: #c2410c; border: 1px solid #fed7aa; font-size: 0.65rem; padding: 1px 4px; font-weight: 700;" title="당일 전체 작업 총 소요: ${item.totalModelReq.toLocaleString()} EA / 가용재고: ${item.good.toLocaleString()} EA / 부족: ${item.shortage.toLocaleString()} EA">총소요 ${item.totalModelReq.toLocaleString()}EA (부족 ${item.shortage.toLocaleString()})</span>` : ''}
                        ${item.status === 'NO_STOCK' ? `<span class="badge" style="background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; font-size: 0.65rem; padding: 1px 4px; font-weight: 700;" title="가용 재고 없음">재고없음</span>` : ''}
                    </div>
                </td>
                <td style="text-align: right; vertical-align: middle; font-weight: 800; color: #1e293b; font-size: 0.88rem; background: inherit;">
                    <div>${item.qty.toLocaleString()}</div>
                    ${item.status === 'PARTIAL_OK' ? `<div style="font-size: 0.66rem; color: #c2410c; font-weight: 600;" title="당일 전체 작업 총 필요 수량: ${item.totalModelReq.toLocaleString()} EA">총 ${item.totalModelReq.toLocaleString()}EA</div>` : ''}
                </td>
                <td style="text-align: right; vertical-align: middle; font-weight: 700; color: ${item.good >= item.totalModelReq ? '#16a34a' : (item.good > 0 ? '#d97706' : '#dc2626')}; font-size: 0.88rem; background: inherit;" title="창고 가용재고 (당일 총필요 ${item.totalModelReq.toLocaleString()} EA)">
                    ${item.good.toLocaleString()}
                </td>
                <td style="text-align: right; vertical-align: middle; color: ${item.oqc > 0 ? '#dc2626; font-weight: 800;' : '#94a3b8;'} background: inherit;">${item.oqc > 0 ? item.oqc.toLocaleString() : '-'}</td>
                <td style="text-align: right; vertical-align: middle; color: ${item.longTerm > 0 ? '#8b5cf6; font-weight: 800;' : '#94a3b8;'} background: inherit;">${item.longTerm > 0 ? item.longTerm.toLocaleString() : '-'}</td>
                <td style="text-align: right; vertical-align: middle; color: ${item.bin > 0 ? '#db2777; font-weight: 800;' : '#94a3b8;'} background: inherit;">${item.bin > 0 ? item.bin.toLocaleString() : '-'}</td>
                <td style="text-align: right; vertical-align: middle; color: ${item.pending > 0 ? '#d97706; font-weight: 700;' : '#94a3b8;'} background: inherit;">${item.pending > 0 ? item.pending.toLocaleString() : '-'}</td>
                <td style="text-align: center; vertical-align: middle; background: inherit;">
                    <span class="badge-avail-status ${item.statusClass}">${item.statusLabel}</span>
                </td>
                <td style="vertical-align: middle; font-size: 0.74rem; color: #334155; max-width: 120px; line-height: 1.35; background: inherit;" title="${item.adj1 || '-'}">
                    <div style="white-space: pre-line;">${item.adj1 && item.adj1 !== '-' ? item.adj1 : '<span style="color:#cbd5e1;">-</span>'}</div>
                </td>
                <td style="vertical-align: middle; font-size: 0.74rem; color: #334155; max-width: 120px; line-height: 1.35; background: inherit;" title="${item.adj2 || '-'}">
                    <div style="white-space: pre-line;">${item.adj2 && item.adj2 !== '-' ? item.adj2 : '<span style="color:#cbd5e1;">-</span>'}</div>
                </td>
            `;

            // 마지막 열: 블록 로케이션 및 비고 (첫 행에서 rowspan으로 1회만 병합 출력)
            if (idx === 0) {
                html += `
                    <td rowspan="${N}" class="merged-cell" style="vertical-align: middle; font-size: 0.74rem; color: #475569; max-width: 220px; line-height: 1.35; background: inherit;" title="${groupBlockLocText.replace(/"/g, '&quot;')}">
                        <div style="max-height: ${Math.max(45, N * 24)}px; overflow-y: auto; white-space: pre-line;">
                            ${groupBlockLocText}
                        </div>
                    </td>
                `;
            }

            tr.innerHTML = html;
            fragment.appendChild(tr);
        });
    });

    tbody.innerHTML = '';
    tbody.appendChild(fragment);
}

// 작업 그룹 전체 선택 토글
window.toggleSelectAvailGroup = function(groupKey, event) {
    const isChecked = event.target.checked;
    processedAvailabilityData.forEach(item => {
        const itKey = `${item.sheetName}__${item.jobName}__${item.cntrNo}__${item.dest}__${item.carrier}__${item.cntrType}__${item.remark}__${item.adj1}__${item.adj2}`;
        if (itKey === groupKey) {
            if (isChecked) selectedAvailRows.add(item.id);
            else selectedAvailRows.delete(item.id);
        }
    });
    renderAvailabilityTable();
};

// 개별 체크박스 토글
window.toggleSelectAvailRow = function(rowId, event) {
    if (event.target.checked) selectedAvailRows.add(rowId);
    else selectedAvailRows.delete(rowId);
};

// 시트 필터 전환
window.filterAvailBySheet = function(sheet) {
    currentAvailSheetFilter = sheet;
    const tabs = document.querySelectorAll('.avail-sheet-tab');
    tabs.forEach(t => {
        if (t.dataset.sheet === sheet) t.classList.add('active');
        else t.classList.remove('active');
    });
    renderAvailabilityTable();
};

// 상태 필터 전환
window.filterAvailByStatus = function(status) {
    currentAvailStatusFilter = status;
    const btns = document.querySelectorAll('.avail-status-btn');
    btns.forEach(b => {
        if (b.dataset.status === status) b.classList.add('active');
        else b.classList.remove('active');
    });
    renderAvailabilityTable();
};

// 텍스트 검색
window.searchAvailability = function() {
    const searchInput = document.getElementById('availSearchInput');
    const searchSelect = document.getElementById('availSearchField');
    if (searchInput) currentAvailSearchQuery = searchInput.value;
    if (searchSelect) currentAvailSearchField = searchSelect.value;
    renderAvailabilityTable();
};

// 검색 및 필터 초기화
window.resetAvailFilters = function() {
    currentAvailSheetFilter = 'all';
    currentAvailStatusFilter = 'all';
    currentAvailSearchQuery = '';
    currentAvailSearchField = 'all';

    const tabs = document.querySelectorAll('.avail-sheet-tab');
    tabs.forEach(t => {
        if (t.dataset.sheet === 'all') t.classList.add('active');
        else t.classList.remove('active');
    });

    const btns = document.querySelectorAll('.avail-status-btn');
    btns.forEach(b => {
        if (b.dataset.status === 'all') b.classList.add('active');
        else b.classList.remove('active');
    });

    const searchInput = document.getElementById('availSearchInput');
    if (searchInput) searchInput.value = '';

    const searchSelect = document.getElementById('availSearchField');
    if (searchSelect) searchSelect.value = 'all';

    renderAvailabilityTable();
};

// 엑셀 내보내기 (ExcelJS 기반)
window.exportAvailabilityToExcel = async function() {
    if (!processedAvailabilityData || processedAvailabilityData.length === 0) {
        alert("내보낼 작업 가용성 분석 데이터가 없습니다.");
        return;
    }

    try {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'ExcelCompare';
        workbook.created = new Date();

        const worksheet = workbook.addWorksheet('작업가용성_상세내역');

        worksheet.columns = [
            { header: '시트구분', key: 'sheetName', width: 12 },
            { header: '작업명', key: 'jobName', width: 22 },
            { header: '컨테이너번호', key: 'cntrNo', width: 18 },
            { header: '도착지', key: 'dest', width: 10 },
            { header: '선사', key: 'carrier', width: 10 },
            { header: '규격', key: 'cntrType', width: 10 },
            { header: '제품구분', key: 'prodType', width: 10 },
            { header: '사업부', key: 'division', width: 12 },
            { header: '제품모델명', key: 'prodName', width: 30 },
            { header: '계획수량', key: 'qty', width: 12 },
            { header: '가용재고(양품)', key: 'good', width: 14 },
            { header: 'OQC홀드', key: 'oqc', width: 12 },
            { header: '롱텀홀드', key: 'longTerm', width: 12 },
            { header: 'BIN블록', key: 'bin', width: 12 },
            { header: '팬딩재고', key: 'pending', width: 12 },
            { header: '부족수량', key: 'shortage', width: 12 },
            { header: '판정상태', key: 'statusLabel', width: 16 },
            { header: '구분1', key: 'adj1', width: 20 },
            { header: '구분2', key: 'adj2', width: 20 },
            { header: '블록 로케이션 및 비고', key: 'blockLocs', width: 35 }
        ];

        const headerRow = worksheet.getRow(1);
        headerRow.height = 26;
        headerRow.eachCell(cell => {
            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: '1E293B' }
            };
            cell.font = { color: { argb: 'FFFFFF' }, bold: true, size: 10 };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });

        processedAvailabilityData.forEach(d => {
            const row = worksheet.addRow({
                sheetName: d.sheetName,
                jobName: d.jobName,
                cntrNo: d.cntrNo,
                dest: d.dest,
                carrier: d.carrier,
                cntrType: d.cntrType,
                prodType: d.prodType || '-',
                division: d.division || '-',
                prodName: d.prodName,
                qty: d.qty,
                good: d.good,
                oqc: d.oqc,
                longTerm: d.longTerm,
                bin: d.bin,
                pending: d.pending,
                shortage: d.shortage > 0 ? d.shortage : 0,
                statusLabel: d.statusLabel,
                adj1: d.adj1 && d.adj1 !== '-' ? d.adj1 : '',
                adj2: d.adj2 && d.adj2 !== '-' ? d.adj2 : '',
                blockLocs: d.blockLocs && d.blockLocs.length > 0 ? d.blockLocs.join(' | ') : (d.remark !== '-' ? d.remark : '')
            });

            if (d.status === 'SHORTAGE') {
                row.eachCell(cell => {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } };
                });
            } else if (d.status === 'BLOCK_WARN') {
                row.eachCell(cell => {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FAF5FF' } };
                });
            }
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const dateStr = new Date().toISOString().split('T')[0];
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        saveAs(blob, `작업가용성_분석내역_${dateStr}.xlsx`);
    } catch (err) {
        console.error("엑셀 내보내기 실패:", err);
        alert("엑셀 내보내기 중 오류가 발생했습니다: " + err.message);
    }
};

// 엑셀 바로보기
window.openAvailabilityInExcel = async function() {
    if (!processedAvailabilityData || processedAvailabilityData.length === 0) {
        alert("열람할 작업 가용성 분석 데이터가 없습니다.");
        return;
    }

    try {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'ExcelCompare';
        workbook.created = new Date();

        const worksheet = workbook.addWorksheet('작업가용성_상세내역');

        worksheet.columns = [
            { header: '시트구분', key: 'sheetName', width: 12 },
            { header: '작업명', key: 'jobName', width: 22 },
            { header: '컨테이너번호', key: 'cntrNo', width: 18 },
            { header: '도착지', key: 'dest', width: 10 },
            { header: '선사', key: 'carrier', width: 10 },
            { header: '규격', key: 'cntrType', width: 10 },
            { header: '제품구분', key: 'prodType', width: 10 },
            { header: '사업부', key: 'division', width: 12 },
            { header: '제품모델명', key: 'prodName', width: 30 },
            { header: '계획수량', key: 'qty', width: 12 },
            { header: '가용재고(양품)', key: 'good', width: 14 },
            { header: 'OQC홀드', key: 'oqc', width: 12 },
            { header: '롱텀홀드', key: 'longTerm', width: 12 },
            { header: 'BIN블록', key: 'bin', width: 12 },
            { header: '팬딩재고', key: 'pending', width: 12 },
            { header: '부족수량', key: 'shortage', width: 12 },
            { header: '판정상태', key: 'statusLabel', width: 16 },
            { header: '구분1', key: 'adj1', width: 20 },
            { header: '구분2', key: 'adj2', width: 20 },
            { header: '블록 로케이션 및 비고', key: 'blockLocs', width: 35 }
        ];

        const headerRow = worksheet.getRow(1);
        headerRow.height = 26;
        headerRow.eachCell(cell => {
            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: '1E293B' }
            };
            cell.font = { color: { argb: 'FFFFFF' }, bold: true, size: 10 };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });

        processedAvailabilityData.forEach(d => {
            worksheet.addRow({
                sheetName: d.sheetName,
                jobName: d.jobName,
                cntrNo: d.cntrNo,
                dest: d.dest,
                carrier: d.carrier,
                cntrType: d.cntrType,
                prodType: d.prodType || '-',
                division: d.division || '-',
                prodName: d.prodName,
                qty: d.qty,
                good: d.good,
                oqc: d.oqc,
                longTerm: d.longTerm,
                bin: d.bin,
                pending: d.pending,
                shortage: d.shortage > 0 ? d.shortage : 0,
                statusLabel: d.statusLabel,
                adj1: d.adj1 && d.adj1 !== '-' ? d.adj1 : '',
                adj2: d.adj2 && d.adj2 !== '-' ? d.adj2 : '',
                blockLocs: d.blockLocs && d.blockLocs.length > 0 ? d.blockLocs.join(' | ') : (d.remark !== '-' ? d.remark : '')
            });
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const dateStr = new Date().toISOString().split('T')[0];
        const fileName = `작업가용성_분석내역_${dateStr}.xlsx`;
        const base64 = bufToBase64(buffer);

        await fetch(`${API_BASE}/api/open-excel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ buffer: base64, fileName: fileName })
        });
    } catch (err) {
        console.error("엑셀 바로보기 실패:", err);
        alert("엑셀 바로보기 실행 중 오류가 발생했습니다: " + err.message);
    }
};

window.handleAvailSearch = function(query) {
    currentAvailSearchQuery = (query || '').trim();
    renderAvailabilityTable();
};

window.handleAvailSearchFieldChange = function(field) {
    currentAvailSearchField = field || 'all';
    renderAvailabilityTable();
};

// 메신저 공지용 텍스트 클립보드 복사
window.copyAvailabilityNotice = function() {
    if (!processedAvailabilityData || processedAvailabilityData.length === 0) {
        alert("복사할 작업 가용성 분석 데이터가 없습니다.");
        return;
    }

    const totalJobs = processedAvailabilityData.length;
    const totalQty = processedAvailabilityData.reduce((acc, d) => acc + d.qty, 0);
    const okItems = processedAvailabilityData.filter(d => d.status === 'OK');
    const blockWarnItems = processedAvailabilityData.filter(d => d.status === 'BLOCK_WARN');
    const shortageItems = processedAvailabilityData.filter(d => d.status === 'SHORTAGE');

    const lines = [];
    lines.push(`📋 [출하 작업 가용성 및 재고 분석 현황]`);
    lines.push(`- 총 계획 작업: ${totalJobs}건 (${totalQty.toLocaleString()} EA)`);
    lines.push(`- 🟢 작업 가능: ${okItems.length}건`);
    lines.push(`- 🟣 블록 주의(홀드/롱텀/빈): ${blockWarnItems.length}건`);
    lines.push(`- 🔴 재고 부족(출하불가): ${shortageItems.length}건`);
    lines.push(``);

    if (shortageItems.length > 0) {
        lines.push(`🚨 [재고 부족 품목 (${shortageItems.length}건)]`);
        shortageItems.forEach((item, i) => {
            lines.push(`${i + 1}. [${item.sheetName}] ${item.jobName} / ${item.prodName}`);
            lines.push(`   ▶ 계획: ${item.qty}EA | 가용: ${item.good}EA (부족: ${item.shortage}EA)`);
        });
        lines.push(``);
    }

    if (blockWarnItems.length > 0) {
        lines.push(`⚠️ [블록 주의 품목 (홀드/롱텀/빈블럭 감지)]`);
        blockWarnItems.forEach((item, i) => {
            const blockDesc = [];
            if (item.oqc > 0) blockDesc.push(`OQC ${item.oqc}EA`);
            if (item.longTerm > 0) blockDesc.push(`롱텀 ${item.longTerm}EA`);
            if (item.bin > 0) blockDesc.push(`BIN ${item.bin}EA`);
            lines.push(`${i + 1}. [${item.sheetName}] ${item.jobName} / ${item.prodName}`);
            lines.push(`   ▶ 계획: ${item.qty}EA | 가용: ${item.good}EA | 블록: ${blockDesc.join(', ')}`);
            if (item.blockLocs && item.blockLocs.length > 0) {
                lines.push(`   ▶ 위치: ${item.blockLocs.join(', ')}`);
            }
        });
    }

    const textToCopy = lines.join('\n');
    navigator.clipboard.writeText(textToCopy).then(() => {
        alert("📋 작업 가용성 분석 현황 요약이 클립보드에 복사되었습니다!\n사내 메신저(Ctrl+V)나 카카오톡에 붙여넣어 공유하세요.");
    }).catch(err => {
        console.error("클립보드 복사 실패:", err);
        alert("클립보드 복사에 실패했습니다.");
    });
};

// [폴더 액션 6] 선택한 폴더 사진 ZIP 일괄 다운로드
window.handleDownloadSelectedFolders = function() {
    const keys = Array.from(window.selectedFolderKeys);
    if (keys.length === 0) return;
    const cntrNos = Array.from(new Set(keys.map(k => k.split('|')[0])));
    const startDate = document.getElementById('photoGalleryStartDate')?.value || '';
    const endDate = document.getElementById('photoGalleryEndDate')?.value || '';

    let url = `${API_BASE}/api/photos/download?cntrNos=${encodeURIComponent(cntrNos.join(','))}`;
    if (startDate) url += `&startDate=${encodeURIComponent(startDate)}`;
    if (endDate) url += `&endDate=${encodeURIComponent(endDate)}`;

    const a = document.createElement('a');
    a.href = url;
    a.download = `container_folders_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
};

// 1. 선택한 사진 삭제 (휴지통 이동)
window.handleDeleteSelectedPhotos = async function() {
    const ids = Array.from(window.selectedPhotoIds);
    if (ids.length === 0) {
        alert("삭제할 사진을 선택해 주세요.");
        return;
    }
    if (!confirm(`선택한 ${ids.length}장의 사진을 삭제(휴지통 이동)하시겠습니까?`)) {
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'trash_photos',
                ids: ids
            })
        });
        const data = await res.json();
        if (data.success) {
            window.clearGalleryPhotoSelection();
            await window.loadPhotoGallery(window.currentGalleryTargetCntr);
            if (window.fetchContainerPhotoCounts) window.fetchContainerPhotoCounts();
        } else {
            alert(`삭제 실패: ${data.error || data.message}`);
        }
    } catch (err) {
        console.error("Delete photos error:", err);
        alert("삭제 중 오류가 발생했습니다: " + err.message);
    }
};

// 2. 씰 지정 / 씰 해제 일괄 토글
window.handleBatchToggleSealPhoto = async function() {
    const ids = Array.from(window.selectedPhotoIds);
    if (ids.length === 0) {
        alert("사진을 선택해 주세요.");
        return;
    }
    const selectedPhotos = window.currentGalleryPhotos.filter(p => window.selectedPhotoIds.has(String(p.id)));
    const hasNormal = selectedPhotos.some(p => p.photo_type !== 'seal');
    const targetType = hasNormal ? 'seal' : 'normal';

    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'update_photo_type',
                ids: ids,
                photoType: targetType
            })
        });
        const data = await res.json();
        if (data.success) {
            await window.loadPhotoGallery(window.currentGalleryTargetCntr);
        } else {
            alert(`씰 상태 변경 실패: ${data.error || data.message}`);
        }
    } catch (err) {
        console.error("Toggle seal error:", err);
        alert("오류가 발생했습니다: " + err.message);
    }
};

// 3. 작업 조(팀) 변경 모달 & 실행
window.selectedTargetTeamId = null;
window.handleOpenChangeTeamModal = async function() {
    const isFolderMode = window.selectedFolderKeys && window.selectedFolderKeys.size > 0;
    const count = isFolderMode ? window.selectedFolderKeys.size : window.selectedPhotoIds.size;
    if (count === 0) {
        alert("작업 조를 변경할 폴더 또는 사진을 선택해 주세요.");
        return;
    }
    const countEl = document.getElementById('changeTeamPhotoCount');
    if (countEl) countEl.textContent = isFolderMode ? `${count}개 폴더` : `${count}장`;

    try {
        const res = await fetch(`${API_BASE}/api/teams`);
        const data = await res.json();
        const teams = data.teams || [];
        const groupEl = document.getElementById('changeTeamListGroup');
        if (groupEl) {
            let html = `
                <div class="ctnr-team-item selected" onclick="window.selectTargetTeam(null, this)">
                    <span>미지정 조</span>
                    <i class="fas fa-check" style="display:inline-block;"></i>
                </div>
            `;
            window.selectedTargetTeamId = null;
            teams.forEach(t => {
                html += `
                    <div class="ctnr-team-item" onclick="window.selectTargetTeam(${t.id}, this)">
                        <span>${t.name}</span>
                        <i class="fas fa-check" style="display:none;"></i>
                    </div>
                `;
            });
            groupEl.innerHTML = html;
        }
        document.getElementById('modalChangePhotoTeam').style.display = 'flex';
    } catch (e) {
        alert("조 목록을 불러오지 못했습니다: " + e.message);
    }
};

window.selectTargetTeam = function(teamId, el) {
    window.selectedTargetTeamId = teamId;
    document.querySelectorAll('#changeTeamListGroup .ctnr-team-item').forEach(item => {
        item.classList.remove('selected');
        const icon = item.querySelector('.fa-check');
        if (icon) icon.style.display = 'none';
    });
    if (el) {
        el.classList.add('selected');
        const icon = el.querySelector('.fa-check');
        if (icon) icon.style.display = 'inline-block';
    }
};

window.closeChangeTeamModal = function() {
    const m = document.getElementById('modalChangePhotoTeam');
    if (m) m.style.display = 'none';
};

window.executeChangeTeam = async function() {
    const isFolderMode = window.selectedFolderKeys && window.selectedFolderKeys.size > 0;
    
    if (isFolderMode) {
        const keys = Array.from(window.selectedFolderKeys);
        const cntrNos = Array.from(new Set(keys.map(k => k.split('|')[0])));
        try {
            const res = await fetch(`${API_BASE}/api/photos`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'change_team_folder',
                    cntrNos: cntrNos,
                    teamId: window.selectedTargetTeamId
                })
            });
            const data = await res.json();
            if (data.success) {
                window.closeChangeTeamModal();
                window.clearAllGallerySelection();
                await window.loadPhotoGallery();
            } else {
                alert(`조 변경 실패: ${data.error || data.message}`);
            }
        } catch (e) {
            alert("조 변경 중 오류: " + e.message);
        }
        return;
    }

    const ids = Array.from(window.selectedPhotoIds);
    if (ids.length === 0) return;

    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'change_team',
                ids: ids,
                teamId: window.selectedTargetTeamId
            })
        });
        const data = await res.json();
        if (data.success) {
            window.closeChangeTeamModal();
            await window.loadPhotoGallery(window.currentGalleryTargetCntr);
        } else {
            alert(`조 변경 실패: ${data.error || data.message}`);
        }
    } catch (err) {
        console.error("Change team error:", err);
        alert("조 변경 중 오류가 발생했습니다: " + err.message);
    }
};

// 4. 컨테이너 이동 모달 & 실행
window.handleOpenMoveModal = function() {
    const count = window.selectedPhotoIds.size;
    if (count === 0) {
        alert("이동할 사진을 선택해 주세요.");
        return;
    }
    const countEl = document.getElementById('movePhotoCount');
    if (countEl) countEl.textContent = count;
    const inputEl = document.getElementById('inputTargetMoveCntr');
    if (inputEl) {
        inputEl.value = '';
        setTimeout(() => inputEl.focus(), 100);
    }
    document.getElementById('modalMovePhotoContainer').style.display = 'flex';
};

window.closeMoveModal = function() {
    const m = document.getElementById('modalMovePhotoContainer');
    if (m) m.style.display = 'none';
};

window.executeMoveContainer = async function() {
    const ids = Array.from(window.selectedPhotoIds);
    const targetCntr = document.getElementById('inputTargetMoveCntr')?.value?.trim()?.toUpperCase();
    if (!targetCntr) {
        alert("이동할 대상 컨테이너 번호를 입력해 주세요.");
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'move_container',
                ids: ids,
                targetCntrNo: targetCntr
            })
        });
        const data = await res.json();
        if (data.success) {
            window.closeMoveModal();
            window.clearGalleryPhotoSelection();
            await window.loadPhotoGallery(window.currentGalleryTargetCntr);
            if (window.fetchContainerPhotoCounts) window.fetchContainerPhotoCounts();
        } else {
            alert(`이동 실패: ${data.error || data.message}`);
        }
    } catch (err) {
        console.error("Move container error:", err);
        alert("이동 중 오류가 발생했습니다: " + err.message);
    }
};

// 5. 사진 ZIP 다운로드 (선택된 사진 일괄 ZIP 다운로드)
window.handleDownloadSelectedPhotos = function() {
    const ids = Array.from(window.selectedPhotoIds);
    if (ids.length === 0) {
        alert("다운로드할 사진을 선택해 주세요.");
        return;
    }
    const downloadUrl = `${API_BASE}/api/photos/download?ids=${encodeURIComponent(ids.join(','))}`;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `container_photos_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
};

// 6. 로컬 폴더 복사 모달 & 실행 (CTNR 조별 하위 폴더 자동 분류 완벽 지원)
window.handleOpenLocalCopyModal = function() {
    const isFolderMode = window.selectedFolderKeys && window.selectedFolderKeys.size > 0;
    let selectedContainers = new Set();
    let selectedPhotos = [];
    const allPhotos = window.currentGalleryPhotos || [];

    if (isFolderMode) {
        const keys = Array.from(window.selectedFolderKeys);
        keys.forEach(k => selectedContainers.add(k.split('|')[0].toUpperCase().trim()));
        selectedPhotos = allPhotos.filter(p => selectedContainers.has((p.cntr_no || '').toUpperCase().trim()));
    } else {
        selectedPhotos = allPhotos.filter(p => window.selectedPhotoIds && window.selectedPhotoIds.has(p.id));
        selectedPhotos.forEach(p => {
            if (p.cntr_no) selectedContainers.add(p.cntr_no.toUpperCase().trim());
        });
    }

    const containerCount = selectedContainers.size || (isFolderMode ? window.selectedFolderKeys.size : 0);
    const photoCount = selectedPhotos.length;

    if (containerCount === 0 && photoCount === 0) {
        alert("복사할 폴더 또는 사진을 선택해 주세요.");
        return;
    }

    const countEl = document.getElementById('localCopyPhotoCount');
    if (countEl) countEl.textContent = `${containerCount}개`;

    // 팀 목록 확인하여 힌트 표시
    const teamSet = new Set();
    selectedPhotos.forEach(p => {
        let tm = (p.team_name || '').trim();
        const m = tm.match(/^(\d+조)/);
        if (m) tm = m[1];
        else if (tm.includes('재작업')) tm = '재작업';
        else if (!tm) tm = '기타';
        teamSet.add(tm);
    });
    const teamListStr = Array.from(teamSet).join(', ');
    const hintTextEl = document.getElementById('localCopyTeamHintText');
    if (hintTextEl) {
        hintTextEl.textContent = teamSet.size > 0 ? `[${teamListStr}] 선택됨 - 마지막 저장 경로가 자동 적용됩니다.` : `마지막 저장 경로가 자동 적용됩니다.`;
    }

    const inputEl = document.getElementById('inputLocalCopyPath');
    if (inputEl) {
        const savedPath = localStorage.getItem('lastPhotoLocalCopyPath');
        inputEl.value = savedPath || 'X:\\26.08\\27\\야간';
    }

    const chkByTeam = document.getElementById('chkByTeamFolder');
    if (chkByTeam) {
        const savedByTeam = localStorage.getItem('lastPhotoLocalCopyByTeam');
        chkByTeam.checked = (savedByTeam === null) ? true : (savedByTeam === 'true');
    }

    const btnExec = document.getElementById('btnExecuteLocalCopy');
    if (btnExec) {
        btnExec.disabled = false;
        btnExec.innerHTML = '<i class="fas fa-copy"></i> 복사 시작';
    }

    window.updateLocalCopyPreview();

    const m = document.getElementById('modalLocalCopyPhoto');
    if (m) m.style.display = 'flex';
};

window.updateLocalCopyPreview = function() {
    const isFolderMode = window.selectedFolderKeys && window.selectedFolderKeys.size > 0;
    const inputEl = document.getElementById('inputLocalCopyPath');
    let basePath = (inputEl ? inputEl.value.trim() : '') || 'X:\\26.08\\27\\야간';
    if (basePath && !basePath.endsWith('\\') && !basePath.endsWith('/')) {
        basePath += '\\';
    }

    const chkByTeam = document.getElementById('chkByTeamFolder');
    const byTeam = chkByTeam ? chkByTeam.checked : true;
    localStorage.setItem('lastPhotoLocalCopyByTeam', byTeam ? 'true' : 'false');

    const previewTitle = document.getElementById('localCopyPreviewTitle');
    const previewList = document.getElementById('localCopyPreviewList');
    if (!previewList) return;

    const allPhotos = window.currentGalleryPhotos || [];
    let selectedPhotos = [];
    if (isFolderMode) {
        const keys = Array.from(window.selectedFolderKeys);
        const cntrNos = new Set(keys.map(k => k.split('|')[0].toUpperCase().trim()));
        selectedPhotos = allPhotos.filter(p => cntrNos.has((p.cntr_no || '').toUpperCase().trim()));
    } else {
        selectedPhotos = allPhotos.filter(p => window.selectedPhotoIds && window.selectedPhotoIds.has(p.id));
    }

    const teamMap = {};
    selectedPhotos.forEach(p => {
        let tName = (p.team_name || '').trim();
        const m = tName.match(/^(\d+조)/);
        if (m) tName = m[1];
        else if (tName.includes('재작업')) tName = '재작업';
        else if (!tName) tName = '기타';

        if (!teamMap[tName]) teamMap[tName] = new Set();
        teamMap[tName].add((p.cntr_no || '기타').toUpperCase().trim());
    });

    const teamNames = Object.keys(teamMap).sort((a, b) => {
        const numA = parseInt(a);
        const numB = parseInt(b);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        if (!isNaN(numA)) return -1;
        if (!isNaN(numB)) return 1;
        return a.localeCompare(b);
    });

    const totalContainers = new Set(selectedPhotos.map(p => (p.cntr_no || '기타').toUpperCase().trim())).size;

    if (byTeam) {
        if (previewTitle) {
            previewTitle.textContent = `조별 자동 분류 미리보기 (${teamNames.length}개 조 / 총 ${totalContainers}개 컨테이너)`;
        }
        if (teamNames.length === 0) {
            previewList.innerHTML = `<div style="color: #64748b; font-size: 0.78rem; text-align: center; padding: 6px;">선택된 컨테이너가 없습니다.</div>`;
        } else {
            previewList.innerHTML = teamNames.map(tm => {
                const count = teamMap[tm].size;
                const pathStr = `${basePath}${tm}\\`;
                return `
                    <div style="display: flex; justify-content: space-between; align-items: center; background: #131d2e; border: 1px solid #1e293b; border-radius: 8px; padding: 8px 12px; font-size: 0.8rem;">
                        <div style="display: flex; align-items: center; gap: 6px; color: #fbbf24; font-weight: 800;">
                            <i class="fas fa-tag"></i> <span>${tm} (${count}개)</span>
                        </div>
                        <div style="color: #94a3b8; font-family: monospace; font-size: 0.78rem; word-break: break-all; text-align: right; margin-left: 10px;">
                            ${pathStr}
                        </div>
                    </div>
                `;
            }).join('');
        }
    } else {
        if (previewTitle) {
            previewTitle.textContent = `기준 폴더 직하위 복사 (총 ${totalContainers}개 컨테이너)`;
        }
        previewList.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; background: #131d2e; border: 1px solid #1e293b; border-radius: 8px; padding: 8px 12px; font-size: 0.8rem;">
                <div style="display: flex; align-items: center; gap: 6px; color: #38bdf8; font-weight: 800;">
                    <i class="fas fa-folder-open"></i> <span>직하위 저장 (총 ${totalContainers}개)</span>
                </div>
                <div style="color: #94a3b8; font-family: monospace; font-size: 0.78rem; word-break: break-all; text-align: right; margin-left: 10px;">
                    ${basePath}
                </div>
            </div>
        `;
    }
};

window.handleBrowseLocalFolder = async function() {
    const inputEl = document.getElementById('inputLocalCopyPath');
    const btn = document.getElementById('btnBrowseLocalFolder');
    const currentVal = (inputEl ? inputEl.value.trim() : '') || 'X:\\26.08\\27\\야간';

    const originalBtnHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 폴더 선택 중...';
    }

    try {
        if (window.isElectron && window.electronAPI && typeof window.electronAPI.selectFolder === 'function') {
            try {
                const res = await window.electronAPI.selectFolder(currentVal);
                if (res && res.success && res.path && !res.cancelled) {
                    if (inputEl) inputEl.value = res.path;
                    localStorage.setItem('lastPhotoLocalCopyPath', res.path);
                    window.updateLocalCopyPreview();
                }
                return;
            } catch (ipcErr) {
                console.warn("Electron selectFolder IPC error, fallback to API:", ipcErr);
            }
        }

        const res = await fetch(`${API_BASE}/api/photos/select-local-folder?initialPath=${encodeURIComponent(currentVal)}`);
        const data = await res.json();
        if (data.success && data.path && !data.cancelled) {
            if (inputEl) inputEl.value = data.path;
            localStorage.setItem('lastPhotoLocalCopyPath', data.path);
            window.updateLocalCopyPreview();
        } else if (data.error) {
            alert(`폴더 선택 실패: ${data.error}`);
        }
    } catch (e) {
        console.warn("Folder dialog failed:", e);
        alert(`폴더 선택 창을 여는 중 오류가 발생했습니다: ${e.message}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalBtnHtml || '<i class="fas fa-folder-open"></i> 찾아보기...';
        }
    }
};

window.localCopyAbortController = null;
window.isLocalCopying = false;

window.closeLocalCopyModal = function() {
    if (window.isLocalCopying && window.localCopyAbortController) {
        if (confirm("현재 진행 중인 로컬 복사 작업을 취소(중단)하시겠습니까?")) {
            try {
                window.localCopyAbortController.abort();
            } catch (e) {}
            window.isLocalCopying = false;
            window.localCopyAbortController = null;
        } else {
            return;
        }
    }

    const btnExec = document.getElementById('btnExecuteLocalCopy');
    if (btnExec) {
        btnExec.disabled = false;
        btnExec.innerHTML = '<i class="fas fa-copy"></i> 복사 시작';
    }

    const m = document.getElementById('modalLocalCopyPhoto');
    if (m) m.style.display = 'none';
};

window.executeLocalCopy = async function() {
    const isFolderMode = window.selectedFolderKeys && window.selectedFolderKeys.size > 0;
    let ids = [];

    if (isFolderMode) {
        const keys = Array.from(window.selectedFolderKeys);
        const cntrNos = new Set(keys.map(k => k.split('|')[0].toUpperCase().trim()));
        const photos = (window.currentGalleryPhotos || []).filter(p => cntrNos.has((p.cntr_no || '').toUpperCase().trim()));
        ids = photos.map(p => p.id);
    } else {
        ids = Array.from(window.selectedPhotoIds || []);
    }

    const targetPath = document.getElementById('inputLocalCopyPath')?.value?.trim();
    const conflictAction = document.querySelector('input[name="localCopyConflict"]:checked')?.value || 'overwrite';
    const byTeamFolder = document.getElementById('chkByTeamFolder')?.checked ?? true;

    if (!targetPath) {
        alert("대상 로컬 폴더 기준 경로를 입력해 주세요.");
        return;
    }
    if (ids.length === 0) {
        alert("복사할 대상 사진이 없습니다.");
        return;
    }
    localStorage.setItem('lastPhotoLocalCopyPath', targetPath);

    const btnExec = document.getElementById('btnExecuteLocalCopy');
    if (btnExec) {
        btnExec.disabled = true;
        btnExec.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 복사 중...';
    }

    window.isLocalCopying = true;
    window.localCopyAbortController = new AbortController();

    try {
        const res = await fetch(`${API_BASE}/api/photos/local-copy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: window.localCopyAbortController.signal,
            body: JSON.stringify({
                ids: ids,
                targetPath: targetPath,
                conflictAction: conflictAction,
                byTeamFolder: byTeamFolder
            })
        });
        const data = await res.json();
        if (data.success) {
            window.closeLocalCopyModal();
            alert(`✅ ${data.message}`);
        } else {
            alert(`❌ 로컬 복사 실패: ${data.error || data.message}`);
        }
    } catch (err) {
        if (err.name === 'AbortError' || (window.localCopyAbortController && window.localCopyAbortController.signal.aborted)) {
            console.log("Local copy was cancelled by user.");
            alert("로컬 복사 작업이 취소되었습니다.");
        } else {
            console.error("Local copy error:", err);
            alert("로컬 복사 중 오류가 발생했습니다: " + err.message);
        }
    } finally {
        window.isLocalCopying = false;
        window.localCopyAbortController = null;
        if (btnExec) {
            btnExec.disabled = false;
            btnExec.innerHTML = '<i class="fas fa-copy"></i> 복사 시작';
        }
    }
};

// 7. 구글드라이브 백업 & 로컬 용량 정리 (NDJSON 스트리밍)
window.gdriveAbortController = null;
window.handleUploadToGDriveAndCleanLocal = async function() {
    const isFolderMode = window.selectedFolderKeys && window.selectedFolderKeys.size > 0;
    let ids = [];

    if (isFolderMode) {
        const keys = Array.from(window.selectedFolderKeys);
        const cntrNos = new Set(keys.map(k => k.split('|')[0]));
        const photos = (window.currentGalleryPhotos || []).filter(p => cntrNos.has((p.cntr_no || '').toUpperCase().trim()));
        ids = photos.map(p => p.id);
    } else {
        ids = Array.from(window.selectedPhotoIds || []);
    }

    if (ids.length === 0) {
        alert("구글드라이브에 백업할 사진 또는 폴더를 선택해 주세요.");
        return;
    }

    if (!confirm(`선택한 사진 ${ids.length}장을 구글드라이브에 안전 백업하고 로컬 디스크 용량을 확보(PC에서 원본 삭제)하시겠습니까?`)) {
        return;
    }

    const modal = document.getElementById('modalGDriveProgress');
    if (modal) modal.style.display = 'flex';

    const statusEl = document.getElementById('gdriveStatusText');
    const barEl = document.getElementById('gdriveProgressBar');
    const pctEl = document.getElementById('gdriveProgressPercent');
    const countEl = document.getElementById('gdriveProgressCount');
    const uploadedEl = document.getElementById('gdriveUploadedCount');
    const skippedEl = document.getElementById('gdriveSkippedCount');
    const cleanedEl = document.getElementById('gdriveCleanedCount');
    const freedEl = document.getElementById('gdriveFreedMB');

    if (statusEl) statusEl.textContent = '구글드라이브 업로드 연결 중...';
    if (barEl) barEl.style.width = '0%';
    if (pctEl) pctEl.textContent = '0%';
    if (countEl) countEl.textContent = `0 / ${ids.length}`;
    if (uploadedEl) uploadedEl.textContent = '0';
    if (skippedEl) skippedEl.textContent = '0';
    if (cleanedEl) cleanedEl.textContent = '0';
    if (freedEl) freedEl.textContent = '0.0';

    window.gdriveAbortController = new AbortController();

    try {
        const response = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'upload_gdrive',
                ids: ids
            }),
            signal: window.gdriveAbortController.signal
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const evt = JSON.parse(line);
                    if (evt.type === 'start') {
                        if (statusEl) statusEl.textContent = `총 ${evt.total}장 처리 시작 (이미 백업됨: ${evt.alreadyDoneCount || 0}장)`;
                    } else if (evt.type === 'progress') {
                        if (barEl) barEl.style.width = `${evt.percent}%`;
                        if (pctEl) pctEl.textContent = `${evt.percent}%`;
                        if (countEl) countEl.textContent = `${evt.current} / ${evt.total}`;
                        if (statusEl) statusEl.textContent = `[${evt.status}] ${evt.currentFile || ''}`;
                        if (uploadedEl && evt.uploadedCount !== undefined) uploadedEl.textContent = evt.uploadedCount;
                        if (skippedEl && evt.skippedCount !== undefined) skippedEl.textContent = evt.skippedCount;
                        if (cleanedEl && evt.cleanedCount !== undefined) cleanedEl.textContent = evt.cleanedCount;
                        if (freedEl && evt.freedMB !== undefined) freedEl.textContent = evt.freedMB;
                    } else if (evt.type === 'done') {
                        if (barEl) barEl.style.width = '100%';
                        if (pctEl) pctEl.textContent = '100%';
                        if (statusEl) statusEl.textContent = evt.message || '구글드라이브 백업 및 로컬 정리 완료!';
                        if (uploadedEl && evt.uploadedCount !== undefined) uploadedEl.textContent = evt.uploadedCount;
                        if (skippedEl && evt.skippedCount !== undefined) skippedEl.textContent = evt.skippedCount;
                        if (cleanedEl && evt.cleanedCount !== undefined) cleanedEl.textContent = evt.cleanedCount;
                        if (freedEl && evt.freedMB !== undefined) freedEl.textContent = evt.freedMB;
                    }
                } catch (pe) {}
            }
        }

        await window.loadPhotoGallery(window.currentGalleryTargetCntr);
    } catch (err) {
        if (err.name === 'AbortError') {
            if (statusEl) statusEl.textContent = '사용자에 의해 작업이 중지되었습니다.';
        } else {
            if (statusEl) statusEl.textContent = `오류 발생: ${err.message}`;
        }
    }
};

window.stopGDriveUpload = function() {
    if (window.gdriveAbortController) {
        window.gdriveAbortController.abort();
        window.gdriveAbortController = null;
    }
};

window.closeGDriveProgressModal = function() {
    const modal = document.getElementById('modalGDriveProgress');
    if (modal) modal.style.display = 'none';
};

// CTNR 작업 구분 3단 탭 전환 (진행 중 / 완료 / 휴지통)
window.setGalleryTabState = function(tab) {
    window.galleryTabState = tab;
    const btnActive = document.getElementById('tabBtnActive');
    const btnCompleted = document.getElementById('tabBtnCompleted');
    const btnTrash = document.getElementById('tabBtnTrash');
    const titleEl = document.getElementById('galleryHeaderTitle');
    const subtitleEl = document.getElementById('galleryHeaderSubtitle');

    if (btnActive) btnActive.classList.toggle('active', tab === 'ACTIVE');
    if (btnCompleted) btnCompleted.classList.toggle('active', tab === 'COMPLETED');
    if (btnTrash) btnTrash.classList.toggle('active', tab === 'TRASH');

    if (tab === 'ACTIVE') {
        if (titleEl) titleEl.textContent = '진행 중인 작업 사진 보관함';
        if (subtitleEl) subtitleEl.textContent = '현장에서 업로드된 진행 중인 컨테이너 적재 사진을 조회하고 완료 처리합니다.';
    } else if (tab === 'COMPLETED') {
        if (titleEl) titleEl.textContent = '완료된 작업 사진 보관함';
        if (subtitleEl) subtitleEl.textContent = '작업 완료 처리된 컨테이너 적재 사진을 조회하고 관리합니다.';
    } else if (tab === 'TRASH') {
        if (titleEl) titleEl.textContent = '휴지통 사진 보관함';
        if (subtitleEl) subtitleEl.textContent = '삭제된 컨테이너 사진을 조회하고 복구하거나 영구 삭제합니다.';
    }

    window.loadPhotoGallery(window.currentGalleryTargetCntr);
};

// 뷰 모드 전환 (바둑판 / 크게)
window.setGalleryViewMode = function(mode) {
    window.galleryViewMode = mode;
    const btnGrid = document.getElementById('btnViewGrid');
    const btnLarge = document.getElementById('btnViewLarge');
    if (btnGrid) btnGrid.classList.toggle('active', mode === 'GRID');
    if (btnLarge) btnLarge.classList.toggle('active', mode === 'LARGE');
    window.renderGalleryPhotos();
};

// 통일된 사진 정렬 함수 (오름차순/내림차순 자연 정렬 및 드롭다운 실시간 동기화)
window.sortPhotoList = function(photoArray, sortBy) {
    const sortMode = sortBy || window.gallerySortBy || document.getElementById('gallerySortSelect')?.value || 'NAME_ASC';
    window.gallerySortBy = sortMode;
    const sortSelect = document.getElementById('gallerySortSelect');
    if (sortSelect && sortSelect.value !== sortMode) {
        sortSelect.value = sortMode;
    }

    return [...photoArray].sort((a, b) => {
        const pathA = (a.photo_path || a.filename || '').split('/').pop().split('\\').pop() || '';
        const pathB = (b.photo_path || b.filename || '').split('/').pop().split('\\').pop() || '';
        if (sortMode === 'NAME_ASC') {
            return pathA.localeCompare(pathB, undefined, { numeric: true, sensitivity: 'base' });
        } else if (sortMode === 'NAME_DESC') {
            return pathB.localeCompare(pathA, undefined, { numeric: true, sensitivity: 'base' });
        } else if (sortMode === 'UPLOAD_DESC') {
            return new Date(b.uploaded_at || 0).getTime() - new Date(a.uploaded_at || 0).getTime();
        } else if (sortMode === 'UPLOAD_ASC') {
            return new Date(a.uploaded_at || 0).getTime() - new Date(b.uploaded_at || 0).getTime();
        }
        return pathA.localeCompare(pathB, undefined, { numeric: true, sensitivity: 'base' });
    });
};

// 정렬 변경 (사용자 수동 변경 시 플래그 설정)
window.setGallerySort = function(sortBy) {
    window.userCustomGallerySort = true;
    window.gallerySortBy = sortBy;
    const sortSelect = document.getElementById('gallerySortSelect');
    if (sortSelect) sortSelect.value = sortBy;
    window.renderGalleryPhotos();
};

// ==================== 사진 및 폴더 선택 & 하단 플로팅 액션바 관리 ====================
window.selectedPhotoIds = window.selectedPhotoIds || new Set();
window.selectedFolderKeys = window.selectedFolderKeys || new Set();

// 1. 사진 전체 선택 (사진 상세 뷰)
window.toggleSelectAllPhotos = function(checked) {
    let targetList = window.currentGalleryPhotos || [];
    if (window.currentGalleryTargetCntr) {
        const targetCntrUpper = window.currentGalleryTargetCntr.toUpperCase().trim();
        targetList = targetList.filter(p => (p.cntr_no || '').toUpperCase().trim() === targetCntrUpper);
    }

    if (checked === undefined) {
        const allSelected = targetList.length > 0 && targetList.every(p => window.selectedPhotoIds.has(String(p.id)));
        checked = !allSelected;
    }

    if (checked) {
        targetList.forEach(p => window.selectedPhotoIds.add(String(p.id)));
    } else {
        targetList.forEach(p => window.selectedPhotoIds.delete(String(p.id)));
    }

    document.querySelectorAll('.ctnr-photo-card, .ctnr-card-large').forEach(card => {
        const id = card.getAttribute('data-photo-id');
        if (id) {
            const isSel = window.selectedPhotoIds.has(id);
            if (isSel) card.classList.add('selected');
            else card.classList.remove('selected');
            const chk = card.querySelector('.ctnr-photo-chk');
            if (chk) chk.checked = isSel;
            const selectChk = card.querySelector('.ctnr-photo-select-chk');
            if (selectChk) {
                if (isSel) selectChk.classList.add('selected');
                else selectChk.classList.remove('selected');
            }
        }
    });

    const selectAllBtn = document.getElementById('btnGallerySelectAllInView');
    if (selectAllBtn && window.currentGalleryTargetCntr) {
        const targetCntrUpper = window.currentGalleryTargetCntr.toUpperCase().trim();
        const currentPhotos = (window.currentGalleryPhotos || []).filter(p => (p.cntr_no || '').toUpperCase().trim() === targetCntrUpper);
        const selCount = currentPhotos.filter(p => window.selectedPhotoIds.has(String(p.id))).length;
        const allSel = currentPhotos.length > 0 && selCount === currentPhotos.length;
        selectAllBtn.innerHTML = allSel ? '<i class="fas fa-check-square"></i> 전체 해제' : `<i class="far fa-check-square"></i> 전체 선택 (${selCount}/${currentPhotos.length})`;
    }

    window.updateGalleryActionBar();
};

// 2. 개별 사진 선택
window.togglePhotoSelect = function(id, e) {
    if (e) e.stopPropagation();
    const strId = String(id);
    if (window.selectedPhotoIds.has(strId)) {
        window.selectedPhotoIds.delete(strId);
    } else {
        window.selectedPhotoIds.add(strId);
    }
    
    const isSel = window.selectedPhotoIds.has(strId);
    const cards = document.querySelectorAll(`[data-photo-id="${strId}"]`);
    cards.forEach(card => {
        if (isSel) card.classList.add('selected');
        else card.classList.remove('selected');
        const chk = card.querySelector('.ctnr-photo-chk');
        if (chk) chk.checked = isSel;
        const selectChk = card.querySelector('.ctnr-photo-select-chk');
        if (selectChk) {
            if (isSel) selectChk.classList.add('selected');
            else selectChk.classList.remove('selected');
        }
    });

    const selectAllChk = document.getElementById('gallerySelectAllChk');
    if (selectAllChk) {
        selectAllChk.checked = window.currentGalleryPhotos.length > 0 && window.selectedPhotoIds.size === window.currentGalleryPhotos.length;
    }

    window.updateGalleryActionBar();
};

// 카드 클릭 시 (선택 모드면 토글, 아니면 뷰어 오픈)
window.handleCardClick = function(photoId, event) {
    if (window.selectedPhotoIds.size > 0) {
        window.togglePhotoSelect(photoId, event);
    } else {
        window.openPhotoLightboxById(photoId);
    }
};

// 3. 개별 폴더 선택 (메인 폴더 뷰)
window.toggleFolderSelect = function(folderKey, e) {
    if (e) e.stopPropagation();
    const key = String(folderKey);
    if (window.selectedFolderKeys.has(key)) {
        window.selectedFolderKeys.delete(key);
    } else {
        window.selectedFolderKeys.add(key);
    }

    const cards = document.querySelectorAll(`[data-folder-key="${key}"]`);
    cards.forEach(card => {
        if (window.selectedFolderKeys.has(key)) card.classList.add('selected');
        else card.classList.remove('selected');
        const chk = card.querySelector('.ctnr-folder-chk');
        if (chk) chk.checked = window.selectedFolderKeys.has(key);
    });

    window.updateGalleryActionBar();
    window.refreshFolderHeaderSelectState();
};

// 폴더 카드 클릭 시
window.handleFolderCardClick = function(folderKey, cntrNo, workDateStr, event) {
    if (window.selectedFolderKeys.size > 0) {
        window.toggleFolderSelect(folderKey, event);
    } else {
        window.openContainerFolderPhotos(cntrNo, workDateStr);
    }
};

// 날짜 그룹 전체 선택 / 해제
window.toggleDateGroupFolders = function(dateStr, e) {
    if (e) e.stopPropagation();
    const targetFolders = [];
    document.querySelectorAll(`[data-date-group="${dateStr}"] [data-folder-key]`).forEach(el => {
        const k = el.getAttribute('data-folder-key');
        if (k) targetFolders.push(k);
    });

    if (targetFolders.length === 0) return;
    const allSelected = targetFolders.length > 0 && targetFolders.every(k => window.selectedFolderKeys.has(k));

    if (allSelected) {
        targetFolders.forEach(k => window.selectedFolderKeys.delete(k));
    } else {
        targetFolders.forEach(k => window.selectedFolderKeys.add(k));
    }

    document.querySelectorAll(`[data-date-group="${dateStr}"] [data-folder-key]`).forEach(card => {
        const k = card.getAttribute('data-folder-key');
        const isSel = window.selectedFolderKeys.has(k);
        if (isSel) card.classList.add('selected');
        else card.classList.remove('selected');
        const chk = card.querySelector('.ctnr-folder-chk');
        if (chk) chk.checked = isSel;
    });

    window.updateGalleryActionBar();
    window.refreshFolderHeaderSelectState();
};

// 조(Team) 그룹 전체 선택 / 해제
window.toggleTeamGroupFolders = function(dateStr, teamName, e) {
    if (e) e.stopPropagation();
    const targetFolders = [];
    document.querySelectorAll(`[data-date-group="${dateStr}"][data-team-group="${teamName}"] [data-folder-key]`).forEach(el => {
        const k = el.getAttribute('data-folder-key');
        if (k) targetFolders.push(k);
    });

    if (targetFolders.length === 0) return;
    const allSelected = targetFolders.length > 0 && targetFolders.every(k => window.selectedFolderKeys.has(k));

    if (allSelected) {
        targetFolders.forEach(k => window.selectedFolderKeys.delete(k));
    } else {
        targetFolders.forEach(k => window.selectedFolderKeys.add(k));
    }

    document.querySelectorAll(`[data-date-group="${dateStr}"][data-team-group="${teamName}"] [data-folder-key]`).forEach(card => {
        const k = card.getAttribute('data-folder-key');
        const isSel = window.selectedFolderKeys.has(k);
        if (isSel) card.classList.add('selected');
        else card.classList.remove('selected');
        const chk = card.querySelector('.ctnr-folder-chk');
        if (chk) chk.checked = isSel;
    });

    window.updateGalleryActionBar();
    window.refreshFolderHeaderSelectState();
};

// 날짜/조 헤더 선택 카운트 텍스트 갱신
window.refreshFolderHeaderSelectState = function() {
    document.querySelectorAll('.ctnr-date-card').forEach(dateCard => {
        const dateStr = dateCard.getAttribute('data-date-str');
        if (!dateStr) return;
        const totalItems = dateCard.querySelectorAll('[data-folder-key]').length;
        let selCount = 0;
        dateCard.querySelectorAll('[data-folder-key]').forEach(el => {
            const k = el.getAttribute('data-folder-key');
            if (window.selectedFolderKeys.has(k)) selCount++;
        });

        const chk = dateCard.querySelector('.ctnr-date-btn-select-all input[type="checkbox"]');
        const textSpan = dateCard.querySelector('.ctnr-date-btn-select-all span');
        const dayNum = parseInt(dateStr.split('-')[2] || '0', 10);
        if (chk) chk.checked = (totalItems > 0 && selCount === totalItems);
        if (textSpan) textSpan.textContent = `${dayNum}일 전체 선택 (${selCount}/${totalItems})`;
    });

    document.querySelectorAll('.ctnr-team-card').forEach(teamCard => {
        const totalItems = teamCard.querySelectorAll('[data-folder-key]').length;
        let selCount = 0;
        teamCard.querySelectorAll('[data-folder-key]').forEach(el => {
            const k = el.getAttribute('data-folder-key');
            if (window.selectedFolderKeys.has(k)) selCount++;
        });
        const btn = teamCard.querySelector('.ctnr-team-btn-select-all');
        if (btn) {
            btn.textContent = (totalItems > 0 && selCount === totalItems) ? '전체 해제' : '전체 선택';
        }
    });
};

// 전체 선택 해제 (폴더 및 사진 공통)
window.clearAllGallerySelection = function() {
    window.selectedPhotoIds.clear();
    window.selectedFolderKeys.clear();

    const selectAllChk = document.getElementById('gallerySelectAllChk');
    if (selectAllChk) selectAllChk.checked = false;

    document.querySelectorAll('.ctnr-photo-card.selected, .ctnr-card-large.selected, .ctnr-folder-item.selected, .ctnr-photo-select-chk.selected').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.ctnr-photo-chk, .ctnr-folder-chk').forEach(c => c.checked = false);

    window.refreshFolderHeaderSelectState();
    window.updateGalleryActionBar();
};
window.clearGalleryPhotoSelection = window.clearAllGallerySelection;

// 하단 플로팅 액션바 상태 및 모드 업데이트 (폴더 모드 vs 사진 모드)
window.updateGalleryActionBar = function() {
    const bar = document.getElementById('photoGalleryActionBar');
    if (!bar) return;

    const folderCount = window.selectedFolderKeys ? window.selectedFolderKeys.size : 0;
    const photoCount = window.selectedPhotoIds ? window.selectedPhotoIds.size : 0;
    const countBadge = document.getElementById('actionSelectedCount');
    const labelBadge = document.getElementById('actionSelectedLabel');
    const photoGroup = document.getElementById('photoActionButtonsGroup');
    const folderGroup = document.getElementById('folderActionButtonsGroup');

    // 1. 폴더 선택 모드
    if (folderCount > 0 && !window.currentGalleryTargetCntr) {
        bar.style.display = 'flex';
        if (countBadge) countBadge.textContent = folderCount;
        if (labelBadge) labelBadge.textContent = '폴더 선택됨';
        if (photoGroup) photoGroup.style.display = 'none';
        if (folderGroup) folderGroup.style.display = 'flex';

        const isTrash = window.galleryTabState === 'TRASH';
        const isCompleted = window.galleryTabState === 'COMPLETED';

        const btnTrash = document.getElementById('btnFolderActionTrash');
        const btnComplete = document.getElementById('btnFolderActionComplete');
        const btnCompleteText = document.getElementById('btnFolderActionCompleteText');
        const btnDuplicates = document.getElementById('btnFolderActionDuplicates');

        if (isTrash) {
            if (btnTrash) btnTrash.style.display = 'none';
            if (btnComplete) {
                btnComplete.style.display = 'inline-flex';
                btnComplete.className = 'ctnr-act-btn btn-purple-light';
            }
            if (btnCompleteText) btnCompleteText.textContent = '복구';
            if (btnDuplicates) btnDuplicates.style.display = 'none';
        } else if (isCompleted) {
            if (btnTrash) btnTrash.style.display = 'inline-flex';
            if (btnComplete) {
                btnComplete.style.display = 'inline-flex';
                btnComplete.className = 'ctnr-act-btn btn-amber-light';
            }
            if (btnCompleteText) btnCompleteText.textContent = '완료 취소';
            if (btnDuplicates) btnDuplicates.style.display = 'none';
        } else {
            if (btnTrash) btnTrash.style.display = 'inline-flex';
            if (btnComplete) {
                btnComplete.style.display = 'inline-flex';
                btnComplete.className = 'ctnr-act-btn btn-emerald-light';
            }
            if (btnCompleteText) btnCompleteText.textContent = '완료 처리';
            if (btnDuplicates) btnDuplicates.style.display = 'inline-flex';
        }
        return;
    }

    // 2. 사진 선택 모드
    if (photoCount > 0) {
        bar.style.display = 'flex';
        if (countBadge) countBadge.textContent = photoCount;
        if (labelBadge) labelBadge.textContent = '사진 선택됨';
        if (photoGroup) photoGroup.style.display = 'flex';
        if (folderGroup) folderGroup.style.display = 'none';

        const sealText = document.getElementById('btnActionSealText');
        const selectedPhotos = (window.currentGalleryPhotos || []).filter(p => window.selectedPhotoIds.has(String(p.id)));
        const hasNormal = selectedPhotos.some(p => p.photo_type !== 'seal');
        if (sealText) {
            sealText.textContent = hasNormal ? '씰 지정' : '씰 해제';
        }
        return;
    }

    // 3. 아무것도 선택 안 됨
    bar.style.display = 'none';
};

// [폴더 액션 1] 선택한 폴더 일괄 삭제 (휴지통 이동)
window.handleDeleteSelectedFolders = async function() {
    const keys = Array.from(window.selectedFolderKeys);
    if (keys.length === 0) return;
    const cntrNos = Array.from(new Set(keys.map(k => k.split('|')[0])));

    if (!confirm(`선택한 ${cntrNos.length}개 컨테이너 폴더와 모든 사진을 삭제(휴지통 이동)하시겠습니까?`)) {
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'trash_folder',
                cntrNos: cntrNos
            })
        });
        const data = await res.json();
        if (data.success) {
            window.clearAllGallerySelection();
            await window.loadPhotoGallery();
            if (window.fetchContainerPhotoCounts) window.fetchContainerPhotoCounts();
        } else {
            alert(`삭제 실패: ${data.error || data.message}`);
        }
    } catch (err) {
        alert("폴더 삭제 중 오류가 발생했습니다: " + err.message);
    }
};

// [폴더 액션 2] 선택한 폴더 일괄 완료 처리 / 완료 취소 / 복구
window.handleToggleSelectedFoldersCompletion = async function() {
    const keys = Array.from(window.selectedFolderKeys);
    if (keys.length === 0) return;
    const cntrNos = Array.from(new Set(keys.map(k => k.split('|')[0])));

    const isTrash = window.galleryTabState === 'TRASH';
    const isCompleted = window.galleryTabState === 'COMPLETED';

    if (isTrash) {
        // 복구 처리
        if (!confirm(`선택한 ${cntrNos.length}개 컨테이너 폴더를 복구하시겠습니까?`)) return;
        try {
            const res = await fetch(`${API_BASE}/api/photos`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'restore_folder', cntrNos: cntrNos })
            });
            const data = await res.json();
            if (data.success) {
                window.clearAllGallerySelection();
                await window.loadPhotoGallery();
                if (window.fetchContainerPhotoCounts) window.fetchContainerPhotoCounts();
            } else {
                alert(`복구 실패: ${data.error || data.message}`);
            }
        } catch (e) {
            alert("복구 중 오류가 발생했습니다: " + e.message);
        }
        return;
    }

    const targetCompleted = !isCompleted;
    const actionName = targetCompleted ? '완료 처리' : '완료 취소(진행 중으로 되돌리기)';

    // 완료 처리 시 씰 사진 누락 여부 사전 검사
    if (targetCompleted) {
        const folders = (window.currentGalleryFolders || []).filter(f => cntrNos.includes(f.cntrNo));
        const missingCntrs = window.checkMissingSealPhotos(folders);
        if (missingCntrs.length > 0) {
            window.pendingSealWarningAction = async () => {
                await window.executeFolderCompletionDirect(cntrNos, targetCompleted);
            };
            window.openMissingSealWarningModal(missingCntrs);
            return;
        }
    }

    if (!confirm(`선택한 ${cntrNos.length}개 컨테이너 작업을 ${actionName}하시겠습니까?`)) return;
    await window.executeFolderCompletionDirect(cntrNos, targetCompleted);
};

window.executeFolderCompletionDirect = async function(cntrNos, targetCompleted) {
    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'toggle_complete_folder',
                cntrNos: cntrNos,
                isCompleted: targetCompleted
            })
        });
        const data = await res.json();
        if (data.success) {
            window.clearAllGallerySelection();
            await window.loadPhotoGallery();
        } else {
            alert(`상태 변경 실패: ${data.error || data.message}`);
        }
    } catch (e) {
        alert("상태 변경 중 오류: " + e.message);
    }
};

// [폴더 액션 3] 선택한 폴더 중복 사진 정리
window.handleCleanupSelectedFoldersDuplicates = async function() {
    const keys = Array.from(window.selectedFolderKeys);
    if (keys.length === 0) return;
    const cntrNos = Array.from(new Set(keys.map(k => k.split('|')[0])));

    if (!confirm(`선택한 ${cntrNos.length}개 폴더 내의 중복 업로드된 사진을 자동으로 감지하여 정리(휴지통 이동)하시겠습니까?`)) {
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/photos/duplicates`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cntrNos: cntrNos })
        });
        const data = await res.json();
        if (data.success) {
            alert(data.message || `성공적으로 중복 사진 ${data.cleanedCount}장을 정리했습니다.`);
            window.clearAllGallerySelection();
            await window.loadPhotoGallery();
        } else {
            alert(`중복 정리 실패: ${data.error || data.message}`);
        }
    } catch (e) {
        alert("중복 사진 정리 중 오류: " + e.message);
    }
};

// [폴더 액션 4] 선택한 폴더 조 변경 모달 열기
window.handleOpenChangeTeamModalForFolders = function() {
    const keys = Array.from(window.selectedFolderKeys);
    if (keys.length === 0) return;
    const countEl = document.getElementById('changeTeamPhotoCount');
    if (countEl) countEl.textContent = `${keys.length}개 폴더`;

    window.handleOpenChangeTeamModal();
};

// [폴더 액션 5] 선택한 폴더 로컬 복사 모달 열기
window.handleOpenLocalCopyModalForFolders = function() {
    const keys = Array.from(window.selectedFolderKeys);
    if (keys.length === 0) return;
    const countEl = document.getElementById('localCopyPhotoCount');
    if (countEl) countEl.textContent = `${keys.length}개 폴더`;

    window.handleOpenLocalCopyModal();
};

// [폴더 액션 6] 선택한 폴더 사진 ZIP 일괄 다운로드
window.handleDownloadSelectedFolders = function() {
    const keys = Array.from(window.selectedFolderKeys);
    if (keys.length === 0) return;
    const cntrNos = Array.from(new Set(keys.map(k => k.split('|')[0])));
    const startDate = document.getElementById('photoGalleryStartDate')?.value || '';
    const endDate = document.getElementById('photoGalleryEndDate')?.value || '';

    let url = `${API_BASE}/api/photos/download?cntrNos=${encodeURIComponent(cntrNos.join(','))}`;
    if (startDate) url += `&startDate=${encodeURIComponent(startDate)}`;
    if (endDate) url += `&endDate=${encodeURIComponent(endDate)}`;

    const a = document.createElement('a');
    a.href = url;
    a.download = `container_folders_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
};

// 1. 선택한 사진 삭제 (휴지통 이동)
window.handleDeleteSelectedPhotos = async function() {
    const ids = Array.from(window.selectedPhotoIds);
    if (ids.length === 0) {
        alert("삭제할 사진을 선택해 주세요.");
        return;
    }
    if (!confirm(`선택한 ${ids.length}장의 사진을 삭제(휴지통 이동)하시겠습니까?`)) {
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'trash_photos',
                ids: ids
            })
        });
        const data = await res.json();
        if (data.success) {
            window.clearGalleryPhotoSelection();
            await window.loadPhotoGallery(window.currentGalleryTargetCntr);
            if (window.fetchContainerPhotoCounts) window.fetchContainerPhotoCounts();
        } else {
            alert(`삭제 실패: ${data.error || data.message}`);
        }
    } catch (err) {
        console.error("Delete photos error:", err);
        alert("삭제 중 오류가 발생했습니다: " + err.message);
    }
};

// 2. 씰 지정 / 씰 해제 일괄 토글
window.handleBatchToggleSealPhoto = async function() {
    const ids = Array.from(window.selectedPhotoIds);
    if (ids.length === 0) {
        alert("사진을 선택해 주세요.");
        return;
    }
    const selectedPhotos = window.currentGalleryPhotos.filter(p => window.selectedPhotoIds.has(String(p.id)));
    const hasNormal = selectedPhotos.some(p => p.photo_type !== 'seal');
    const targetType = hasNormal ? 'seal' : 'normal';

    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'update_photo_type',
                ids: ids,
                photoType: targetType
            })
        });
        const data = await res.json();
        if (data.success) {
            await window.loadPhotoGallery(window.currentGalleryTargetCntr);
        } else {
            alert(`씰 상태 변경 실패: ${data.error || data.message}`);
        }
    } catch (err) {
        console.error("Toggle seal error:", err);
        alert("오류가 발생했습니다: " + err.message);
    }
};

// 3. 작업 조(팀) 변경 모달 & 실행
window.selectedTargetTeamId = null;
window.handleOpenChangeTeamModal = async function() {
    const isFolderMode = window.selectedFolderKeys && window.selectedFolderKeys.size > 0;
    const count = isFolderMode ? window.selectedFolderKeys.size : window.selectedPhotoIds.size;
    if (count === 0) {
        alert("작업 조를 변경할 폴더 또는 사진을 선택해 주세요.");
        return;
    }
    const countEl = document.getElementById('changeTeamPhotoCount');
    if (countEl) countEl.textContent = isFolderMode ? `${count}개 폴더` : `${count}장`;

    try {
        const res = await fetch(`${API_BASE}/api/teams`);
        const data = await res.json();
        const teams = data.teams || [];
        const groupEl = document.getElementById('changeTeamListGroup');
        if (groupEl) {
            let html = `
                <div class="ctnr-team-item selected" onclick="window.selectTargetTeam(null, this)">
                    <span>미지정 조</span>
                    <i class="fas fa-check" style="display:inline-block;"></i>
                </div>
            `;
            window.selectedTargetTeamId = null;
            teams.forEach(t => {
                html += `
                    <div class="ctnr-team-item" onclick="window.selectTargetTeam(${t.id}, this)">
                        <span>${t.name}</span>
                        <i class="fas fa-check" style="display:none;"></i>
                    </div>
                `;
            });
            groupEl.innerHTML = html;
        }
        document.getElementById('modalChangePhotoTeam').style.display = 'flex';
    } catch (e) {
        alert("조 목록을 불러오지 못했습니다: " + e.message);
    }
};

window.selectTargetTeam = function(teamId, el) {
    window.selectedTargetTeamId = teamId;
    document.querySelectorAll('#changeTeamListGroup .ctnr-team-item').forEach(item => {
        item.classList.remove('selected');
        const icon = item.querySelector('.fa-check');
        if (icon) icon.style.display = 'none';
    });
    if (el) {
        el.classList.add('selected');
        const icon = el.querySelector('.fa-check');
        if (icon) icon.style.display = 'inline-block';
    }
};

window.closeChangeTeamModal = function() {
    const m = document.getElementById('modalChangePhotoTeam');
    if (m) m.style.display = 'none';
};

window.executeChangeTeam = async function() {
    const isFolderMode = window.selectedFolderKeys && window.selectedFolderKeys.size > 0;
    
    if (isFolderMode) {
        const keys = Array.from(window.selectedFolderKeys);
        const cntrNos = Array.from(new Set(keys.map(k => k.split('|')[0])));
        try {
            const res = await fetch(`${API_BASE}/api/photos`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'change_team_folder',
                    cntrNos: cntrNos,
                    teamId: window.selectedTargetTeamId
                })
            });
            const data = await res.json();
            if (data.success) {
                window.closeChangeTeamModal();
                window.clearAllGallerySelection();
                await window.loadPhotoGallery();
            } else {
                alert(`조 변경 실패: ${data.error || data.message}`);
            }
        } catch (e) {
            alert("조 변경 중 오류: " + e.message);
        }
        return;
    }

    const ids = Array.from(window.selectedPhotoIds);
    if (ids.length === 0) return;

    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'change_team',
                ids: ids,
                teamId: window.selectedTargetTeamId
            })
        });
        const data = await res.json();
        if (data.success) {
            window.closeChangeTeamModal();
            await window.loadPhotoGallery(window.currentGalleryTargetCntr);
        } else {
            alert(`조 변경 실패: ${data.error || data.message}`);
        }
    } catch (err) {
        console.error("Change team error:", err);
        alert("조 변경 중 오류가 발생했습니다: " + err.message);
    }
};

// 4. 컨테이너 이동 모달 & 실행
window.handleOpenMoveModal = function() {
    const count = window.selectedPhotoIds.size;
    if (count === 0) {
        alert("이동할 사진을 선택해 주세요.");
        return;
    }
    const countEl = document.getElementById('movePhotoCount');
    if (countEl) countEl.textContent = count;
    const inputEl = document.getElementById('inputTargetMoveCntr');
    if (inputEl) {
        inputEl.value = '';
        setTimeout(() => inputEl.focus(), 100);
    }
    document.getElementById('modalMovePhotoContainer').style.display = 'flex';
};

window.closeMoveModal = function() {
    const m = document.getElementById('modalMovePhotoContainer');
    if (m) m.style.display = 'none';
};

window.executeMoveContainer = async function() {
    const ids = Array.from(window.selectedPhotoIds);
    const targetCntr = document.getElementById('inputTargetMoveCntr')?.value?.trim()?.toUpperCase();
    if (!targetCntr) {
        alert("이동할 대상 컨테이너 번호를 입력해 주세요.");
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'move_container',
                ids: ids,
                targetCntrNo: targetCntr
            })
        });
        const data = await res.json();
        if (data.success) {
            window.closeMoveModal();
            window.clearGalleryPhotoSelection();
            await window.loadPhotoGallery(window.currentGalleryTargetCntr);
            if (window.fetchContainerPhotoCounts) window.fetchContainerPhotoCounts();
        } else {
            alert(`이동 실패: ${data.error || data.message}`);
        }
    } catch (err) {
        console.error("Move container error:", err);
        alert("이동 중 오류가 발생했습니다: " + err.message);
    }
};

// 5. 사진 ZIP 다운로드 (선택된 사진 일괄 ZIP 다운로드)
window.handleDownloadSelectedPhotos = function() {
    const ids = Array.from(window.selectedPhotoIds);
    if (ids.length === 0) {
        alert("다운로드할 사진을 선택해 주세요.");
        return;
    }
    const downloadUrl = `${API_BASE}/api/photos/download?ids=${encodeURIComponent(ids.join(','))}`;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `container_photos_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
};

// 7. 구글드라이브 백업 & 로컬 용량 정리 (CTNR 100% 동일 NDJSON 스트리밍)
window.gdriveAbortController = null;
window.lastGDriveTargetIds = [];
window.isGDriveUploading = false;

window.handleUploadToGDriveAndCleanLocal = async function(isResumeAction = false) {
    const isFolderMode = window.selectedFolderKeys && window.selectedFolderKeys.size > 0;
    let ids = [];

    if (isResumeAction && window.lastGDriveTargetIds.length > 0) {
        ids = window.lastGDriveTargetIds;
    } else if (isFolderMode) {
        const keys = Array.from(window.selectedFolderKeys);
        const cntrNos = new Set(keys.map(k => k.split('|')[0]));
        const photos = (window.currentGalleryPhotos || []).filter(p => cntrNos.has((p.cntr_no || '').toUpperCase().trim()));
        ids = photos.map(p => p.id);
    } else if (window.selectedPhotoIds && window.selectedPhotoIds.size > 0) {
        ids = Array.from(window.selectedPhotoIds);
    } else {
        // 선택된 것이 없으면 현재 탭 전체 사진 대상
        ids = (window.currentGalleryPhotos || []).map(p => p.id);
    }

    if (ids.length === 0) {
        alert("구글드라이브로 백업할 사진이 없습니다.");
        return;
    }

    window.lastGDriveTargetIds = ids;

    if (!isResumeAction) {
        const countText = (window.selectedPhotoIds && window.selectedPhotoIds.size > 0)
            ? `선택한 사진 ${ids.length}장` 
            : (isFolderMode ? `선택한 컨테이너 폴더의 사진 ${ids.length}장` : `현재 탭의 전체 사진 ${ids.length}장`);

        if (!confirm(`[☁️ 구글드라이브 백업 & 로컬 용량 정리]\n\n${countText}을(를) 구글드라이브로 안전 백업하고, 업로드 확인 후 로컬 PC의 디스크 공간을 정리하시겠습니까?\n(※ 이전에 이미 완료된 파일은 자동 스킵되며, 남은 파일만 이어서 진행됩니다.)`)) {
            return;
        }
    }

    const modal = document.getElementById('modalGDriveProgress');
    if (modal) {
        modal.style.setProperty('display', 'flex', 'important');
    }

    const statusEl = document.getElementById('gdriveStatusText');
    const statusSubEl = document.getElementById('gdriveStatusSub');
    const barEl = document.getElementById('gdriveProgressBar');
    const countEl = document.getElementById('gdriveProgressCount');
    const totalCountEl = document.getElementById('gdriveProgressTotalCount');
    const alreadyDoneTag = document.getElementById('gdriveAlreadyDoneTag');
    const uploadedEl = document.getElementById('gdriveUploadedCount');
    const skippedEl = document.getElementById('gdriveSkippedCount');
    const cleanedEl = document.getElementById('gdriveCleanedCount');
    const freedEl = document.getElementById('gdriveFreedMB');
    const btnStop = document.getElementById('btnStopGDrive');
    const btnClose = document.getElementById('btnCloseGDrive');
    const btnResume = document.getElementById('btnResumeGDrive');
    const spinner = document.getElementById('gdriveSpinner');

    if (statusEl) statusEl.textContent = '작업 준비 중...';
    if (statusSubEl) statusSubEl.textContent = '안전하게 업로드 및 디스크 정리 중...';
    if (barEl) barEl.style.width = '0%';
    if (countEl) countEl.textContent = '0';
    if (totalCountEl) totalCountEl.textContent = `${ids.length} 장`;
    if (alreadyDoneTag) alreadyDoneTag.style.display = 'none';
    if (uploadedEl) uploadedEl.textContent = '0장';
    if (skippedEl) skippedEl.textContent = '0장';
    if (cleanedEl) cleanedEl.textContent = '0장';
    if (freedEl) freedEl.textContent = '0.0';

    if (btnStop) btnStop.style.display = 'inline-flex';
    if (btnClose) btnClose.style.display = 'none';
    if (btnResume) btnResume.style.display = 'none';
    if (spinner) spinner.className = 'fas fa-spinner fa-spin';

    window.isGDriveUploading = true;
    window.gdriveAbortController = new AbortController();

    let lastProgressEvent = null;

    try {
        const response = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'upload_gdrive',
                ids: ids
            }),
            signal: window.gdriveAbortController.signal
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText.slice(0, 150)}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const evt = JSON.parse(line.trim());
                    lastProgressEvent = evt;

                    if (evt.type === 'start') {
                        if (totalCountEl) totalCountEl.textContent = `${evt.total} 장`;
                        if (alreadyDoneTag && evt.alreadyDoneCount > 0) {
                            alreadyDoneTag.style.display = 'inline-block';
                            alreadyDoneTag.textContent = `기존 완료 (총 ${evt.alreadyDoneCount}장 스킵)`;
                        }
                    } else if (evt.type === 'progress') {
                        if (barEl) barEl.style.width = `${evt.percent}%`;
                        if (countEl) countEl.textContent = evt.current;
                        if (totalCountEl) totalCountEl.textContent = `${evt.total} 장`;
                        if (statusEl) statusEl.textContent = evt.currentFile || '';
                        if (uploadedEl && evt.uploadedCount !== undefined) uploadedEl.textContent = `${evt.uploadedCount}장`;
                        if (skippedEl && evt.skippedCount !== undefined) skippedEl.textContent = `${evt.skippedCount}장`;
                        if (cleanedEl && evt.cleanedCount !== undefined) cleanedEl.textContent = `${evt.cleanedCount}장`;
                        if (freedEl && evt.freedMB !== undefined) freedEl.textContent = evt.freedMB;
                    } else if (evt.type === 'done') {
                        if (barEl) barEl.style.width = '100%';
                        if (statusEl) statusEl.textContent = '모든 파일 백업 및 정리 완료';
                        if (statusSubEl) statusSubEl.textContent = '작업 완료됨';
                        if (uploadedEl && evt.uploadedCount !== undefined) uploadedEl.textContent = `${evt.uploadedCount}장`;
                        if (skippedEl && evt.skippedCount !== undefined) skippedEl.textContent = `${evt.skippedCount}장`;
                        if (cleanedEl && evt.cleanedCount !== undefined) cleanedEl.textContent = `${evt.cleanedCount}장`;
                        if (freedEl && evt.freedMB !== undefined) freedEl.textContent = evt.freedMB;

                        if (btnStop) btnStop.style.display = 'none';
                        if (btnClose) btnClose.style.display = 'inline-block';
                        if (btnResume) btnResume.style.display = 'none';
                        if (spinner) spinner.className = 'fas fa-check-circle text-emerald-400';

                        setTimeout(() => {
                            alert(evt.message || '🎉 구글드라이브 백업 및 로컬 용량 정리가 완료되었습니다!');
                            window.clearAllGallerySelection();
                            window.loadPhotoGallery(window.currentGalleryTargetCntr);
                        }, 400);
                    } else if (evt.type === 'error') {
                        console.warn('[GDrive Upload Warning]', evt.filename, evt.error);
                    }
                } catch (pe) {}
            }
        }

    } catch (err) {
        if (err.name === 'AbortError') {
            if (statusEl) statusEl.textContent = '사용자에 의해 백업 작업이 중지되었습니다.';
            if (statusSubEl) statusSubEl.textContent = '작업 중지됨';
            if (btnResume) btnResume.style.display = 'inline-flex';
        } else {
            console.error("GDrive upload error:", err);
            if (statusEl) statusEl.textContent = `오류 발생: ${err.message}`;
            if (statusSubEl) statusSubEl.textContent = '오류 중단';
            if (btnResume) btnResume.style.display = 'inline-flex';
            alert(`구글드라이브 업로드 중 오류가 발생했습니다:\n${err.message}`);
        }
    } finally {
        window.isGDriveUploading = false;
        window.gdriveAbortController = null;
        if (btnStop) btnStop.style.display = 'none';
        if (btnClose) btnClose.style.display = 'inline-block';
        if (spinner) spinner.className = 'fas fa-cloud-upload-alt';
        window.loadPhotoGallery(window.currentGalleryTargetCntr);
    }
};

window.stopGDriveUpload = function() {
    if (window.gdriveAbortController) {
        window.gdriveAbortController.abort();
        window.gdriveAbortController = null;
    }
};

window.handleResumeGDriveExport = function() {
    window.handleUploadToGDriveAndCleanLocal(true);
};

window.closeGDriveProgressModal = function() {
    if (window.isGDriveUploading) {
        if (!confirm("백업이 아직 진행 중입니다. 정말 중단하고 닫으시겠습니까?")) return;
        window.stopGDriveUpload();
    }
    const modal = document.getElementById('modalGDriveProgress');
    if (modal) modal.style.display = 'none';
};

// 8. 씰 사진 누락 판별 및 경고 모달
window.pendingSealWarningAction = null;
window.checkMissingSealPhotos = function(folders) {
    const missingCntrs = [];
    folders.forEach(f => {
        const hasSeal = f.photos && f.photos.some(p => p.photo_type === 'seal');
        if (!hasSeal && f.photos && f.photos.length > 0) {
            missingCntrs.push(f.cntrNo);
        }
    });
    return missingCntrs;
};

window.openMissingSealWarningModal = function(missingCntrs) {
    const modal = document.getElementById('modalMissingSealWarning');
    const listEl = document.getElementById('missingSealCntrList');
    if (!modal || !listEl) return;

    listEl.innerHTML = missingCntrs.map(c => `<div>• ${c}</div>`).join('');
    modal.style.display = 'flex';
};

window.closeMissingSealWarningModal = function() {
    const modal = document.getElementById('modalMissingSealWarning');
    if (modal) modal.style.display = 'none';
    window.pendingSealWarningAction = null;
};

window.executeActionAfterSealWarning = function() {
    const modal = document.getElementById('modalMissingSealWarning');
    if (modal) modal.style.display = 'none';
    if (typeof window.pendingSealWarningAction === 'function') {
        window.pendingSealWarningAction();
        window.pendingSealWarningAction = null;
    }
};

// 8-1. 중복 사진 감지 및 일괄 정리 (CTNR 동일)
window.currentDuplicatePhotoIds = [];
window.isFetchingDuplicates = false;

window.fetchFolderDuplicates = async function(cntrNo) {
    if (!cntrNo) return;
    const banner = document.getElementById('duplicatePhotoBanner');
    const countText = document.getElementById('duplicateCountText');

    try {
        window.isFetchingDuplicates = true;
        const res = await fetch(`${API_BASE}/api/photos/duplicates?cntrNo=${encodeURIComponent(cntrNo)}`);
        const data = await res.json();

        if (data.success && data.duplicatesCount > 0 && Array.isArray(data.duplicateGroups)) {
            const dupIds = [];
            data.duplicateGroups.forEach(g => {
                if (Array.isArray(g.duplicatePhotoIds)) {
                    dupIds.push(...g.duplicatePhotoIds.map(String));
                }
            });
            window.currentDuplicatePhotoIds = dupIds;

            if (banner && countText) {
                countText.textContent = data.duplicatesCount;
                banner.style.display = 'flex';
            }

            // 사진 카드 중복 배지 실시간 동기화
            document.querySelectorAll('.ctnr-card-large').forEach(card => {
                const pId = card.getAttribute('data-photo-id');
                const imgWrapper = card.querySelector('.ctnr-card-img-wrapper');
                if (imgWrapper && pId) {
                    const existingTag = imgWrapper.querySelector('.ctnr-card-duplicate-tag');
                    if (dupIds.includes(String(pId))) {
                        if (!existingTag) {
                            const tag = document.createElement('span');
                            tag.className = 'ctnr-card-duplicate-tag';
                            tag.title = '완전히 동일한 중복 사진 (정리 대상)';
                            tag.textContent = '중복';
                            imgWrapper.appendChild(tag);
                        }
                    } else if (existingTag) {
                        existingTag.remove();
                    }
                }
            });
        } else {
            window.currentDuplicatePhotoIds = [];
            if (banner) banner.style.display = 'none';
        }
    } catch (err) {
        console.warn("fetchFolderDuplicates error:", err);
        window.currentDuplicatePhotoIds = [];
        if (banner) banner.style.display = 'none';
    } finally {
        window.isFetchingDuplicates = false;
    }
};

window.handleCleanupSingleFolderDuplicates = async function() {
    const cntrNo = window.currentGalleryTargetCntr;
    if (!cntrNo) {
        alert("정리할 컨테이너 폴더가 선택되지 않았습니다.");
        return;
    }

    if (!confirm(`'${cntrNo}' 컨테이너 폴더 내의 모든 중복 사진을 정리(휴지통 이동)하시겠습니까?`)) {
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/photos/duplicates?cntrNo=${encodeURIComponent(cntrNo)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cntrNo: cntrNo })
        });
        const data = await res.json();

        if (data.success) {
            alert(`성공적으로 중복 사진 ${data.cleanedCount}장을 정리(휴지통 이동)했습니다.`);
            window.currentDuplicatePhotoIds = [];
            const banner = document.getElementById('duplicatePhotoBanner');
            if (banner) banner.style.display = 'none';
            await window.loadPhotoGallery(cntrNo);
        } else {
            alert(data.error || "중복 사진 정리 중 오류가 발생했습니다.");
        }
    } catch (err) {
        console.error("Error cleaning folder duplicates:", err);
        alert("중복 사진 정리 중 통신 오류가 발생했습니다: " + err.message);
    }
};

// 9. 사진 인플레이스(In-place) 회전 (-90, 180, 90) - CTNR 동일 0ms 즉시 회전 방식
window.photoRotationOffsets = window.photoRotationOffsets || {};

window.handleRotatePhotos = async function(degrees, singlePhotoId) {
    const targetIds = singlePhotoId ? [String(singlePhotoId)] : Array.from(window.selectedPhotoIds);
    if (targetIds.length === 0) {
        alert("회전할 사진을 1장 이상 선택해 주세요.");
        return;
    }

    // 1. [0ms 즉시 반응] 선택된 사진 카드 DOM의 img에 즉시 CSS rotate 적용
    targetIds.forEach(id => {
        const currentDeg = (window.photoRotationOffsets[id] || 0) + degrees;
        window.photoRotationOffsets[id] = currentDeg;

        const cards = document.querySelectorAll(`[data-photo-id="${id}"]`);
        cards.forEach(card => {
            const img = card.querySelector('img');
            if (img) {
                img.style.transition = 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
                img.style.transform = `rotate(${currentDeg}deg)`;
            }
        });
    });

    // 2. 백그라운드 비동기 서버 저장
    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'rotate',
                ids: targetIds,
                degrees: degrees
            })
        });
        const data = await res.json();
        if (data.success) {
            const now = Date.now();
            targetIds.forEach(id => {
                const p = window.currentGalleryPhotos.find(item => String(item.id) === String(id));
                if (p) p.cacheBuster = now;

                const cards = document.querySelectorAll(`[data-photo-id="${id}"]`);
                cards.forEach(card => {
                    const img = card.querySelector('img');
                    if (img) {
                        const rawSrc = img.src.split('&cb=')[0].split('?cb=')[0];
                        const sep = rawSrc.includes('?') ? '&' : '?';
                        const newSrc = `${rawSrc}${sep}cb=${now}`;

                        const preload = new Image();
                        preload.onload = () => {
                            img.src = newSrc;
                            delete window.photoRotationOffsets[id];
                            img.style.transition = 'none';
                            img.style.transform = 'none';
                        };
                        preload.src = newSrc;
                    }
                });
            });
        } else {
            console.error("Rotate failed on server:", data.error);
            targetIds.forEach(id => {
                const currentDeg = (window.photoRotationOffsets[id] || 0) - degrees;
                window.photoRotationOffsets[id] = currentDeg;
                const cards = document.querySelectorAll(`[data-photo-id="${id}"]`);
                cards.forEach(card => {
                    const img = card.querySelector('img');
                    if (img) {
                        img.style.transform = currentDeg ? `rotate(${currentDeg}deg)` : 'none';
                    }
                });
            });
            alert(`사진 회전 실패: ${data.error || data.message}`);
        }
    } catch (err) {
        console.error("Rotate network error:", err);
        targetIds.forEach(id => {
            const currentDeg = (window.photoRotationOffsets[id] || 0) - degrees;
            window.photoRotationOffsets[id] = currentDeg;
            const cards = document.querySelectorAll(`[data-photo-id="${id}"]`);
            cards.forEach(card => {
                const img = card.querySelector('img');
                if (img) {
                    img.style.transform = currentDeg ? `rotate(${currentDeg}deg)` : 'none';
                }
            });
        });
        alert("사진 회전 중 통신 오류가 발생했습니다: " + err.message);
    }
};

// 상세에서 폴더 목록으로 뒤로가기
window.goBackToFolderList = function() {
    window.currentGalleryTargetCntr = '';
    const searchEl = document.getElementById('photoGallerySearchCntr');
    if (searchEl) searchEl.value = '';
    window.loadPhotoGallery('');
};

// 필터 초기화
window.resetGalleryFilters = function() {
    const formatYMD = (d) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    const startDateEl = document.getElementById('photoGalleryStartDate');
    const endDateEl = document.getElementById('photoGalleryEndDate');
    const searchEl = document.getElementById('photoGallerySearchCntr');
    const teamEl = document.getElementById('photoGalleryTeamFilter');
    const typeEl = document.getElementById('photoGalleryTypeFilter');

    if (startDateEl) startDateEl.value = formatYMD(yesterday);
    if (endDateEl) endDateEl.value = formatYMD(today);
    if (searchEl) searchEl.value = '';
    if (teamEl) teamEl.value = 'all';
    if (typeEl) typeEl.value = 'all';

    window.galleryTabState = 'ACTIVE';
    document.querySelectorAll('.ctnr-tab-btn').forEach(btn => btn.classList.remove('active'));
    const activeTabBtn = document.getElementById('tabBtnActive');
    if (activeTabBtn) activeTabBtn.classList.add('active');

    window.currentGalleryTargetCntr = '';
    window.clearAllGallerySelection();
    window.loadPhotoGallery('');
};

// 모달 닫기
window.closePhotoGalleryModal = function() {
    const modal = document.getElementById('photoGalleryModal');
    if (modal) modal.style.display = 'none';
    if (typeof window.clearAllGallerySelection === 'function') {
        window.clearAllGallerySelection();
    }
};

// 1. 사진 보관함 모달 오픈
window.openPhotoGalleryModal = function(initialCntrNo = '') {
    const modal = document.getElementById('photoGalleryModal');
    if (!modal) return;

    // 사진함 열릴 때 이전 선택 상태(폴더 및 사진 선택) 및 수동 정렬 플래그 완벽 초기화
    window.userCustomGallerySort = false;

    if (typeof window.clearAllGallerySelection === 'function') {
        window.clearAllGallerySelection();
    } else {
        if (window.selectedFolderKeys) window.selectedFolderKeys.clear();
        if (window.selectedPhotoIds) window.selectedPhotoIds.clear();
    }

    modal.style.display = 'flex';

    const formatYMD = (d) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };

    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    const startDateEl = document.getElementById('photoGalleryStartDate');
    const endDateEl = document.getElementById('photoGalleryEndDate');
    const searchEl = document.getElementById('photoGallerySearchCntr');

    if (startDateEl && !startDateEl.value) startDateEl.value = formatYMD(yesterday);
    if (endDateEl && !endDateEl.value) endDateEl.value = formatYMD(today);
    if (searchEl) searchEl.value = initialCntrNo || '';

    window.currentGalleryTargetCntr = (initialCntrNo || '').trim().toUpperCase();
    window.loadPhotoGallery(window.currentGalleryTargetCntr);
};

// 특정 컨테이너 전용 사진 퀵 오픈
window.openContainerPhotoModal = function(cntrNo, event) {
    if (event) event.stopPropagation();
    if (!cntrNo) return;
    const cleanNo = cntrNo.trim().toUpperCase();

    window.userCustomGallerySort = false;

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cleanNo).catch(() => {});
    }
    window.openPhotoGalleryModal(cleanNo);
};

// 2. 사진 목록 로드 (서버 API 호출)
window.loadPhotoGallery = async function(targetCntr = null) {
    const loadingEl = document.getElementById('photoGalleryLoading');
    const listEl = document.getElementById('photoGalleryList');
    const summaryEl = document.getElementById('photoGallerySummary');
    const searchInputEl = document.getElementById('photoGallerySearchCntr');

    let searchCntr = '';
    if (targetCntr !== null && targetCntr !== undefined) {
        searchCntr = String(targetCntr).trim().toUpperCase();
        if (searchInputEl) searchInputEl.value = searchCntr;
    } else {
        searchCntr = (searchInputEl?.value || '').trim().toUpperCase();
    }
    window.currentGalleryTargetCntr = searchCntr;

    const startDate = document.getElementById('photoGalleryStartDate')?.value || '';
    const endDate = document.getElementById('photoGalleryEndDate')?.value || '';
    const typeFilter = document.getElementById('photoGalleryTypeFilter')?.value || 'all';

    if (loadingEl) loadingEl.style.display = 'flex';
    if (listEl) listEl.innerHTML = '';

    try {
        let url = `${API_BASE}/api/photos?`;
        const queryParams = [];

        // 탭 상태 필터
        if (window.galleryTabState === 'COMPLETED') {
            queryParams.push('showCompleted=true');
        } else if (window.galleryTabState === 'TRASH') {
            queryParams.push('showTrash=true');
        } else {
            queryParams.push('showCompleted=false');
        }

        // 컨테이너 번호 검색 시 날짜 제약 없이 모든 일자의 사진 로드
        if (searchCntr) {
            queryParams.push(`cntrNo=${encodeURIComponent(searchCntr)}`);
        } else {
            if (startDate) queryParams.push(`startDate=${encodeURIComponent(startDate)}`);
            if (endDate) queryParams.push(`endDate=${encodeURIComponent(endDate)}`);
        }
        if (typeFilter !== 'all') queryParams.push(`photoType=${encodeURIComponent(typeFilter)}`);

        url += queryParams.join('&');

        const res = await fetch(url);
        const data = await res.json();

        if (loadingEl) loadingEl.style.display = 'none';

        if (!data.success || !data.photos || data.photos.length === 0) {
            window.currentGalleryPhotos = [];
            window.currentGalleryFolders = [];
            window.selectedPhotoIds.clear();
            const tabName = window.galleryTabState === 'COMPLETED' ? '완료된' : (window.galleryTabState === 'TRASH' ? '휴지통' : '진행 중인');
            if (listEl) {
                listEl.innerHTML = `
                    <div style="text-align: center; padding: 100px 20px; color: #64748b;">
                        <i class="fas fa-camera-retro" style="font-size: 3.5rem; margin-bottom: 16px; opacity: 0.4;"></i>
                        <div style="font-size: 1.1rem; font-weight: 800; color: #94a3b8;">${tabName} 컨테이너 사진이 없습니다.</div>
                        <div style="font-size: 0.85rem; margin-top: 8px; color: #64748b;">현장 CTNR 앱에서 사진이 등록되면 실시간으로 조회할 수 있습니다.</div>
                    </div>
                `;
            }
            if (summaryEl) summaryEl.textContent = '조회된 사진: 0장 (0개 컨테이너)';
            const badgeBox = document.getElementById('galleryCntrBadgeBox');
            if (badgeBox) badgeBox.style.display = 'none';
            const btnBack = document.getElementById('btnGalleryBack');
            if (btnBack) btnBack.style.display = 'none';
            return;
        }

        let loadedPhotos = data.photos || [];
        const teamFilter = document.getElementById('photoGalleryTeamFilter')?.value || 'all';
        if (teamFilter && teamFilter !== 'all') {
            loadedPhotos = loadedPhotos.filter(p => (p.team_name || '').includes(teamFilter));
        }

        window.currentGalleryPhotos = loadedPhotos;
        if (typeof window.clearAllGallerySelection === 'function') {
            window.clearAllGallerySelection();
        } else {
            if (window.selectedPhotoIds) window.selectedPhotoIds.clear();
            if (window.selectedFolderKeys) window.selectedFolderKeys.clear();
        }
        window.renderGalleryPhotos();

    } catch (err) {
        console.error("loadPhotoGallery error:", err);
        if (loadingEl) loadingEl.style.display = 'none';
        if (listEl) listEl.innerHTML = `<div style="text-align:center; color:#ef4444; padding:50px; font-weight:700;">사진 목록을 가져오는 중 오류가 발생했습니다: ${err.message}</div>`;
    }
};

// 작업일자 계산 유틸리티 (13시 기준 이전일/당일 구분 - CTNR 동일)
function getGalleryWorkDateString(d) {
    const workDate = new Date(d);
    if (workDate.getHours() < 13) {
        workDate.setDate(workDate.getDate() - 1);
    }
    const y = workDate.getFullYear();
    const m = String(workDate.getMonth() + 1).padStart(2, '0');
    const day = String(workDate.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function formatKoreanDate(dateStr) {
    try {
        const [y, m, d] = dateStr.split('-').map(Number);
        const dateObj = new Date(y, m - 1, d);
        const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
        const dayName = dayNames[dateObj.getDay()];
        return `${y}년 ${String(m).padStart(2, '0')}월 ${String(d).padStart(2, '0')}일 (${dayName})`;
    } catch (e) {
        return dateStr;
    }
}

// 특정 컨테이너 폴더 진입
window.openContainerFolderPhotos = function(cntrNo, workDateStr) {
    window.currentGalleryTargetCntr = (cntrNo || '').trim().toUpperCase();
    const searchEl = document.getElementById('photoGallerySearchCntr');
    if (searchEl) searchEl.value = window.currentGalleryTargetCntr;

    // CTNR 호환: 씰 사진이 있으면 최신 씰 사진이 맨 앞에 오도록 내림차순(NAME_DESC), 없으면 오름차순(NAME_ASC)
    const targetPhotos = (window.currentGalleryPhotos || []).filter(p => (p.cntr_no || '').toUpperCase().trim() === window.currentGalleryTargetCntr);
    const hasSeal = targetPhotos.some(p => p.photo_type === 'seal');
    window.gallerySortBy = hasSeal ? 'NAME_DESC' : 'NAME_ASC';
    const sortSelect = document.getElementById('gallerySortSelect');
    if (sortSelect) sortSelect.value = window.gallerySortBy;

    window.renderGalleryPhotos();
};

// 컨테이너 완료 상태 변경 액션
window.toggleCompleteFolder = async function(cntrNo, isCompleted, e) {
    if (e) e.stopPropagation();

    // 완료 처리 시 씰 사진 누락 여부 사전 검사
    if (isCompleted) {
        const folder = (window.currentGalleryFolders || []).find(f => f.cntrNo === cntrNo);
        if (folder) {
            const missing = window.checkMissingSealPhotos([folder]);
            if (missing.length > 0) {
                window.pendingSealWarningAction = async () => {
                    await window.executeSingleFolderCompletion(cntrNo, isCompleted);
                };
                window.openMissingSealWarningModal([cntrNo]);
                return;
            }
        }
    }

    const msg = isCompleted 
        ? `'${cntrNo}' 컨테이너 작업을 [완료] 상태로 변경하시겠습니까?`
        : `'${cntrNo}' 컨테이너 작업을 [진행 중] 상태로 되돌리시겠습니까?`;
    if (!confirm(msg)) return;

    await window.executeSingleFolderCompletion(cntrNo, isCompleted);
};

window.executeSingleFolderCompletion = async function(cntrNo, isCompleted) {
    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'toggle_complete_folder',
                cntrNo,
                isCompleted
            })
        });
        const data = await res.json();
        if (data.success) {
            await window.loadPhotoGallery(window.currentGalleryTargetCntr);
            if (window.fetchContainerPhotoCounts) window.fetchContainerPhotoCounts();
        } else {
            alert(`상태 변경 실패: ${data.error}`);
        }
    } catch (err) {
        console.error("toggleCompleteFolder error:", err);
        alert("통신 오류가 발생했습니다: " + err.message);
    }
};

window.trashFolder = async function(cntrNo, e) {
    if (e) e.stopPropagation();
    if (!confirm(`'${cntrNo}' 컨테이너 사진을 휴지통으로 이동하시겠습니까?`)) return;

    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'trash_folder',
                cntrNo
            })
        });
        const data = await res.json();
        if (data.success) {
            await window.loadPhotoGallery(window.currentGalleryTargetCntr);
            if (window.fetchContainerPhotoCounts) window.fetchContainerPhotoCounts();
        } else {
            alert(`삭제 실패: ${data.error}`);
        }
    } catch (err) {
        console.error("trashFolder error:", err);
        alert("통신 오류가 발생했습니다: " + err.message);
    }
};

window.restoreFolder = async function(cntrNo, e) {
    if (e) e.stopPropagation();
    if (!confirm(`'${cntrNo}' 컨테이너 사진을 복구하시겠습니까?`)) return;

    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'restore_folder',
                cntrNo
            })
        });
        const data = await res.json();
        if (data.success) {
            await window.loadPhotoGallery(window.currentGalleryTargetCntr);
            if (window.fetchContainerPhotoCounts) window.fetchContainerPhotoCounts();
        } else {
            alert(`복구 실패: ${data.error}`);
        }
    } catch (err) {
        console.error("restoreFolder error:", err);
        alert("통신 오류가 발생했습니다: " + err.message);
    }
};

// 운송사 구분 헬퍼 (천마: 빨강, BNI: 인디고/파랑, 기타: 다크)
function getGalleryCarrierInfo(transporter = '', teamName = '') {
    const t = (transporter || '').trim();
    const team = (teamName || '').trim();
    if (t.includes('천마') || (!t && team.includes('천마'))) {
        return { name: '천마', colorClass: 'carrier-chunma' };
    }
    if (t.includes('BNI') || t.includes('비엔아이') || (!t && (team.includes('BNI') || team.includes('비엔아이')))) {
        return { name: 'BNI', colorClass: 'carrier-bni' };
    }
    const clean = t.split('(')[0] || '';
    return { name: clean, colorClass: 'carrier-default' };
}

// ===================================================================
// [신규] 컨테이너 작업 제품 리스트 & 수량 실시간 조회 엔진
// ===================================================================
window.containerProductInfoCache = new Map();

window.getContainerProductsInfo = async function(cntrNo) {
    if (!cntrNo) return null;
    const key = cntrNo.toUpperCase().trim();
    if (window.containerProductInfoCache.has(key)) {
        return window.containerProductInfoCache.get(key);
    }

    // 1. 현재 로드된 클라이언트 데이터에서 검색
    let foundRows = [];
    if (Array.isArray(window.processedData) && window.processedData.length > 0) {
        foundRows = window.processedData.filter(r => (r.cntrNo || r.cntr_no || '').toUpperCase().trim() === key);
    }
    if (foundRows.length === 0 && Array.isArray(window.containerTableData) && window.containerTableData.length > 0) {
        foundRows = window.containerTableData.filter(r => (r.cntrNo || r.cntr_no || '').toUpperCase().trim() === key);
    }
    if (foundRows.length === 0 && Array.isArray(window.processedAvailabilityData) && window.processedAvailabilityData.length > 0) {
        foundRows = window.processedAvailabilityData.filter(r => (r.cntrNo || r.cntr_no || '').toUpperCase().trim() === key);
    }

    if (foundRows.length > 0) {
        const first = foundRows[0];
        const totalQty = foundRows.reduce((sum, r) => sum + (Number(r.qty || r.qty_plan || r.qty_load || 0) || 0), 0);
        const info = {
            cntrNo: key,
            carrier: first.carrier || first.shipping_line || '-',
            dest: first.dest || first.destination || '-',
            cntrType: first.cntrType || first.cntr_type || first.spec || '-',
            remark: first.remark || first.admin_comment || first.specialNotes || '',
            transporter: first.transporter || '',
            modelCount: foundRows.length,
            totalQty: totalQty,
            products: foundRows.map(r => {
                let dims = r.dims || r.dimensions || '';
                if ((!dims || dims === '-' || dims === '0x0x0') && Array.isArray(productMaster) && productMaster.length > 0) {
                    const cleanName = (r.prodName || r.prod_name || r.model || '').toUpperCase().trim();
                    const m = productMaster.find(pm => (pm.prod_name || pm.model || '').toUpperCase().trim() === cleanName);
                    if (m && m.dims) dims = m.dims;
                }
                return {
                    prodName: r.prodName || r.prod_name || r.model || '-',
                    qty: Number(r.qty || r.qty_plan || r.qty_load || 0) || 0,
                    division: r.division || '-',
                    prodType: r.prodType || r.prod_type || r.jobType || r.job_type || '-',
                    dims: dims || '',
                    weight: r.weight || 0,
                    status: r.status || 'OK'
                };
            })
        };
        window.containerProductInfoCache.set(key, info);
        return info;
    }

    // 2. 서버 DB (/api/containers/info) 폴백 조회
    try {
        const res = await fetch(`${API_BASE}/api/containers/info?cntrNo=${encodeURIComponent(key)}`);
        const data = await res.json();
        if (data.success && Array.isArray(data.products) && data.products.length > 0) {
            const first = data.products[0];
            const totalQty = data.products.reduce((sum, r) => sum + (Number(r.qty_plan || r.qty_load || 0) || 0), 0);
            const info = {
                cntrNo: key,
                carrier: first.carrier || '-',
                dest: first.destination || first.dest || '-',
                cntrType: first.cntr_type || '-',
                remark: first.remark || '',
                transporter: first.transporter || '',
                modelCount: data.products.length,
                totalQty: totalQty,
                products: data.products.map(r => {
                    let dims = r.dims || '';
                    if ((!dims || dims === '-' || dims === '0x0x0') && Array.isArray(productMaster) && productMaster.length > 0) {
                        const cleanName = (r.prod_name || '').toUpperCase().trim();
                        const m = productMaster.find(pm => (pm.prod_name || pm.model || '').toUpperCase().trim() === cleanName);
                        if (m && m.dims) dims = m.dims;
                    }
                    return {
                        prodName: r.prod_name || '-',
                        qty: Number(r.qty_plan || r.qty_load || 0) || 0,
                        division: r.division || '-',
                        prodType: r.prod_type || r.prodType || r.job_type || '-',
                        dims: dims || '',
                        weight: r.weight || 0,
                        status: 'OK'
                    };
                })
            };
            window.containerProductInfoCache.set(key, info);
            return info;
        }
    } catch (e) {
        console.warn("Failed to fetch container info for", key, e);
    }

    return null;
};

window.updateGalleryProductSummary = async function(cntrNo) {
    const btn = document.getElementById('btnGalleryProductSummary');
    const popover = document.getElementById('galleryProductPopover');
    if (!btn || !cntrNo) {
        if (btn) btn.style.display = 'none';
        if (popover) popover.style.display = 'none';
        return;
    }

    const info = await window.getContainerProductsInfo(cntrNo);
    if (!info || !info.products || info.products.length === 0) {
        btn.style.display = 'none';
        if (popover) popover.style.display = 'none';
        return;
    }

    btn.style.display = 'inline-flex';
    const textEl = document.getElementById('galleryProductSummaryText');
    if (textEl) {
        textEl.textContent = `${info.modelCount}모델 ${info.totalQty.toLocaleString()}개`;
    }

    const popCntr = document.getElementById('popoverCntrNo');
    const popMeta = document.getElementById('popoverHeaderMeta');
    const popBody = document.getElementById('popoverProductBody');
    const popFooter = document.getElementById('popoverFooterRemark');

    if (popCntr) popCntr.textContent = info.cntrNo;
    if (popMeta) {
        const metaParts = [];
        if (info.cntrType && info.cntrType !== '-') metaParts.push(info.cntrType);
        if (info.carrier && info.carrier !== '-') metaParts.push(info.carrier);
        if (info.dest && info.dest !== '-') metaParts.push(info.dest);
        popMeta.textContent = metaParts.length > 0 ? `(${metaParts.join(' / ')})` : '';
    }

    if (popBody) {
        let phtml = '';
        info.products.forEach((p, idx) => {
            const ptUpper = (p.prodType || '').trim().toUpperCase();
            const typeClass = ptUpper === 'Q' ? 'type-q' : ptUpper === 'F' ? 'type-f' : ptUpper === 'H' ? 'type-h' : ptUpper === 'W' ? 'type-w' : '';
            const typeTag = (p.prodType && p.prodType !== '-') ? `<span class="popover-prod-type ${typeClass}">${p.prodType}</span>` : '<span class="popover-prod-type" style="visibility:hidden;">-</span>';
            const divTag = (p.division && p.division !== '-') ? `<span class="popover-prod-div">${p.division}</span>` : '<span class="popover-prod-div" style="visibility:hidden;">-</span>';
            const dimsTag = (p.dims && p.dims !== '-' && p.dims !== '0x0x0' && p.dims.trim()) ? `<span class="popover-prod-dims" title="제품 규격">${p.dims}</span>` : '';
            phtml += `
                <div class="popover-prod-item">
                    <span class="popover-prod-idx">${idx + 1}.</span>
                    ${typeTag}
                    ${divTag}
                    <span class="popover-prod-title ${typeClass}" title="${p.prodName}">${p.prodName}</span>
                    ${dimsTag}
                    <span class="popover-prod-qty">${p.qty.toLocaleString()}개</span>
                </div>
            `;
        });
        popBody.innerHTML = phtml;
    }

    if (popFooter) {
        if (info.remark && info.remark.trim() && info.remark !== '-') {
            popFooter.style.display = 'block';
            popFooter.innerHTML = `💬 <strong>비고:</strong> ${info.remark.trim()}`;
        } else {
            popFooter.style.display = 'none';
        }
    }
};

window.toggleGalleryProductPopover = function(e) {
    if (e) e.stopPropagation();
    const popover = document.getElementById('galleryProductPopover');
    if (!popover) return;
    if (popover.style.display === 'none' || !popover.style.display) {
        popover.style.display = 'block';
    } else {
        popover.style.display = 'none';
    }
};

window.closeGalleryProductPopover = function() {
    const popover = document.getElementById('galleryProductPopover');
    if (popover) popover.style.display = 'none';
};

window.updateLightboxProductSummary = async function(cntrNo) {
    const btn = document.getElementById('btnLightboxProductSummary');
    const popover = document.getElementById('lightboxProductPopover');
    if (!btn || !cntrNo) {
        if (btn) btn.style.display = 'none';
        if (popover) popover.style.display = 'none';
        return;
    }

    const info = await window.getContainerProductsInfo(cntrNo);
    if (!info || !info.products || info.products.length === 0) {
        btn.style.display = 'none';
        if (popover) popover.style.display = 'none';
        return;
    }

    btn.style.display = 'inline-flex';
    const textEl = document.getElementById('lightboxProductSummaryText');
    if (textEl) {
        textEl.textContent = `${info.modelCount}모델 ${info.totalQty.toLocaleString()}개`;
    }

    const popCntr = document.getElementById('lbPopoverCntrNo');
    const popMeta = document.getElementById('lbPopoverHeaderMeta');
    const popBody = document.getElementById('lbPopoverProductBody');
    const popFooter = document.getElementById('lbPopoverFooterRemark');

    if (popCntr) popCntr.textContent = info.cntrNo;
    if (popMeta) {
        const metaParts = [];
        if (info.cntrType && info.cntrType !== '-') metaParts.push(info.cntrType);
        if (info.carrier && info.carrier !== '-') metaParts.push(info.carrier);
        if (info.dest && info.dest !== '-') metaParts.push(info.dest);
        popMeta.textContent = metaParts.length > 0 ? `(${metaParts.join(' / ')})` : '';
    }

    if (popBody) {
        let phtml = '';
        info.products.forEach((p, idx) => {
            const ptUpper = (p.prodType || '').trim().toUpperCase();
            const typeClass = ptUpper === 'Q' ? 'type-q' : ptUpper === 'F' ? 'type-f' : ptUpper === 'H' ? 'type-h' : ptUpper === 'W' ? 'type-w' : '';
            const typeTag = (p.prodType && p.prodType !== '-') ? `<span class="popover-prod-type ${typeClass}">${p.prodType}</span>` : '<span class="popover-prod-type" style="visibility:hidden;">-</span>';
            const divTag = (p.division && p.division !== '-') ? `<span class="popover-prod-div">${p.division}</span>` : '<span class="popover-prod-div" style="visibility:hidden;">-</span>';
            const dimsTag = (p.dims && p.dims !== '-' && p.dims !== '0x0x0' && p.dims.trim()) ? `<span class="popover-prod-dims" title="제품 규격">${p.dims}</span>` : '';
            phtml += `
                <div class="popover-prod-item">
                    <span class="popover-prod-idx">${idx + 1}.</span>
                    ${typeTag}
                    ${divTag}
                    <span class="popover-prod-title ${typeClass}" title="${p.prodName}">${p.prodName}</span>
                    ${dimsTag}
                    <span class="popover-prod-qty">${p.qty.toLocaleString()}개</span>
                </div>
            `;
        });
        popBody.innerHTML = phtml;
    }

    if (popFooter) {
        if (info.remark && info.remark.trim() && info.remark !== '-') {
            popFooter.style.display = 'block';
            popFooter.innerHTML = `💬 <strong>비고:</strong> ${info.remark.trim()}`;
        } else {
            popFooter.style.display = 'none';
        }
    }
};

window.toggleLightboxProductPopover = function(e) {
    if (e) e.stopPropagation();
    const popover = document.getElementById('lightboxProductPopover');
    if (!popover) return;
    if (popover.style.display === 'none' || !popover.style.display) {
        popover.style.display = 'block';
    } else {
        popover.style.display = 'none';
    }
};

window.closeLightboxProductPopover = function() {
    const popover = document.getElementById('lightboxProductPopover');
    if (popover) popover.style.display = 'none';
};

// 3. 사진 렌더링 (CTNR 날짜/조별 폴더 목록 뷰 및 컨테이너 4열 상세 뷰)
window.renderGalleryPhotos = function() {
    const listEl = document.getElementById('photoGalleryList');
    const summaryEl = document.getElementById('photoGallerySummary');
    const badgeBox = document.getElementById('galleryCntrBadgeBox');
    const badgeCntrText = document.getElementById('galleryCurrentCntrText');
    const badgeCount = document.getElementById('galleryCurrentCountBadge');
    const btnBack = document.getElementById('btnGalleryBack');

    if (!listEl) return;

    const allPhotos = [...window.currentGalleryPhotos];

    // 1. 특정 컨테이너가 선택된 경우 -> 해당 컨테이너의 4열 대형 사진 그리드 렌더링
    if (window.currentGalleryTargetCntr) {
        const targetCntrUpper = window.currentGalleryTargetCntr.toUpperCase().trim();
        const matchedPhotos = allPhotos.filter(p => (p.cntr_no || '').toUpperCase().trim() === targetCntrUpper);

        // 씰 사진 유무에 따른 스마트 기본 정렬:
        // 씰 사진이 있을 경우 -> 파일이름 내림차순 (NAME_DESC, 씰 사진 및 마지막 번호 사진이 상단에 노출)
        // 씰 사진이 없을 경우 -> 파일이름 오름차순 (NAME_ASC, 01번부터 순차 노출)
        const hasSeal = matchedPhotos.some(p => p.photo_type === 'seal');
        if (!window.userCustomGallerySort) {
            window.gallerySortBy = hasSeal ? 'NAME_DESC' : 'NAME_ASC';
            const sortSelect = document.getElementById('gallerySortSelect');
            if (sortSelect) sortSelect.value = window.gallerySortBy;
        }

        const photos = window.sortPhotoList(matchedPhotos, window.gallerySortBy);

        // 단일 컨테이너 진입 시 중복 사진 자동 검사 트리거 및 제품 품목 요약 업데이트
        window.fetchFolderDuplicates(targetCntrUpper);
        window.updateGalleryProductSummary(targetCntrUpper);

        if (summaryEl) summaryEl.textContent = `조회된 사진: ${photos.length}장 (컨테이너 ${targetCntrUpper})`;
        if (badgeBox) badgeBox.style.display = 'inline-flex';
        if (badgeCntrText) badgeCntrText.textContent = targetCntrUpper;
        if (badgeCount) badgeCount.textContent = `${photos.length}장`;
        if (btnBack) btnBack.style.display = 'inline-flex';

        const selCount = photos.filter(p => window.selectedPhotoIds.has(String(p.id))).length;
        const allSel = photos.length > 0 && selCount === photos.length;
        let selectAllBtn = document.getElementById('btnGallerySelectAllInView');
        if (!selectAllBtn && badgeBox) {
            selectAllBtn = document.createElement('button');
            selectAllBtn.id = 'btnGallerySelectAllInView';
            selectAllBtn.className = 'ctnr-team-btn-select-all';
            selectAllBtn.style.marginLeft = '8px';
            selectAllBtn.onclick = () => window.toggleSelectAllPhotos();
            badgeBox.appendChild(selectAllBtn);
        }
        if (selectAllBtn) {
            selectAllBtn.style.display = 'inline-flex';
            selectAllBtn.innerHTML = allSel ? '<i class="fas fa-check-square"></i> 전체 해제' : `<i class="far fa-check-square"></i> 전체 선택 (${selCount}/${photos.length})`;
        }

        if (photos.length === 0) {
            listEl.innerHTML = `<div style="text-align:center; padding:80px 20px; color:#94a3b8; font-weight:700;">'${targetCntrUpper}' 컨테이너에 등록된 사진이 없습니다.</div>`;
            return;
        }

        let html = '<div class="ctnr-grid-large">';
        photos.forEach((p, idx) => {
            const isSeal = p.photo_type === 'seal';
            const isDuplicate = (window.currentDuplicatePhotoIds || []).includes(String(p.id)) || (window.currentDuplicatePhotoIds || []).includes(Number(p.id));
            const rawPath = (p.photo_path || '').split('?')[0];
            const fileName = rawPath.split('/').pop() || '';
            const itemCache = p.cacheBuster || window.photoGalleryCacheBuster || '';
            const cacheParam = itemCache ? `&cb=${itemCache}` : '';
            const photoUrl = `${API_BASE}/api/photos/view?filename=${encodeURIComponent(rawPath)}${cacheParam}`;
            const uploader = p.uploader_name || '작업자';
            const uploadTimeStr = p.uploaded_at ? new Date(p.uploaded_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
            const isChecked = window.selectedPhotoIds.has(String(p.id));
            const currentDeg = (window.photoRotationOffsets && window.photoRotationOffsets[String(p.id)]) ? window.photoRotationOffsets[String(p.id)] : 0;
            const rotateStyle = currentDeg ? `transform: rotate(${currentDeg}deg);` : '';
            const pCarrierInfo = getGalleryCarrierInfo(p.transporter, p.team_name);

            html += `
                <div class="ctnr-card-large ${isChecked ? 'selected' : ''}" data-photo-id="${p.id}" onclick="window.handleCardClick('${p.id}', event)">
                    <div class="ctnr-card-img-wrapper">
                        <div class="ctnr-photo-select-chk ${isChecked ? 'selected' : ''}" onclick="window.togglePhotoSelect('${p.id}', event)" title="사진 선택">
                            <i class="fas fa-check"></i>
                        </div>
                        ${(p.gdrive_file_id || p.gdrive_url) ? `<span class="ctnr-card-cloud-tag" title="구글드라이브 안전 보관 사진 (PC 용량 정리 완료)">☁️</span>` : ''}
                        ${isDuplicate ? `<span class="ctnr-card-duplicate-tag" title="완전히 동일한 중복 사진 (정리 대상)">중복</span>` : ''}
                        ${isSeal ? `<span class="ctnr-card-seal-tag"><i class="fas fa-camera"></i> 씰</span>` : ''}
                        <img src="${photoUrl}" alt="${p.cntr_no}" style="${rotateStyle}" loading="lazy" onerror="this.src='https://placehold.co/600x800/11111a/94a3b8?text=Image+Load+Fail'">
                        <div class="ctnr-card-gradient-overlay"></div>
                    </div>
                    <div class="ctnr-card-bottom-info">
                        <div class="ctnr-card-title ${pCarrierInfo.colorClass}">${p.cntr_no || '-'}</div>
                        <div class="ctnr-card-filename-box" title="${fileName}">${fileName}</div>
                        <div class="ctnr-card-footer-info">
                            <span><i class="fas fa-user" style="margin-right:4px;"></i>${uploader}</span>
                            <span>${uploadTimeStr}</span>
                        </div>
                    </div>
                </div>
            `;
        });
        html += '</div>';
        listEl.innerHTML = html;
        window.updateGalleryActionBar();
        return;
    }

    // 2. 특정 컨테이너가 지정되지 않은 메인 사진함 화면 -> 날짜별/조별 폴더 계층 목록 렌더링
    const dupBanner = document.getElementById('duplicatePhotoBanner');
    if (dupBanner) dupBanner.style.display = 'none';
    window.currentDuplicatePhotoIds = [];

    if (badgeBox) badgeBox.style.display = 'none';
    if (btnBack) btnBack.style.display = 'none';
    const selAllBtn = document.getElementById('btnGallerySelectAllInView');
    if (selAllBtn) selAllBtn.style.display = 'none';

    // 폴더 그룹핑 (cntrNo + workDateStr)
    const folderGroup = {};
    allPhotos.forEach(p => {
        if (!p.cntr_no) return;
        const cntrNo = p.cntr_no.toUpperCase().trim();
        const workDateStr = getGalleryWorkDateString(p.uploaded_at ? new Date(p.uploaded_at) : new Date());
        const key = `${cntrNo}_${workDateStr}`;
        if (!folderGroup[key]) {
            folderGroup[key] = {
                cntrNo,
                workDateStr,
                photos: [],
                transporter: p.transporter || '',
                teamName: p.team_name || '미지정 조',
                uploaderName: p.uploader_name || '작업자',
                lastUploadedAt: new Date(p.uploaded_at || 0)
            };
        }
        folderGroup[key].photos.push(p);
        const pTime = new Date(p.uploaded_at || 0);
        if (pTime > folderGroup[key].lastUploadedAt) {
            folderGroup[key].lastUploadedAt = pTime;
        }
    });

    const folderList = Object.values(folderGroup);
    window.currentGalleryFolders = folderList;
    const uniqueCntrs = new Set(folderList.map(f => f.cntrNo));
    if (summaryEl) {
        summaryEl.textContent = `총 ${folderList.length}개 폴더 (${uniqueCntrs.size}개 컨테이너 · ${allPhotos.length}장)`;
    }

    if (folderList.length === 0) {
        listEl.innerHTML = `<div style="text-align:center; padding:80px 20px; color:#94a3b8; font-weight:700;">조회된 사진 폴더가 없습니다.</div>`;
        return;
    }

    // 날짜별 그룹핑
    const dateMap = {};
    folderList.forEach(f => {
        if (!dateMap[f.workDateStr]) dateMap[f.workDateStr] = [];
        dateMap[f.workDateStr].push(f);
    });

    const sortedDates = Object.keys(dateMap).sort((a, b) => b.localeCompare(a));
    const isTrashTab = window.galleryTabState === 'TRASH';
    const isCompletedTab = window.galleryTabState === 'COMPLETED';

    let html = '<div class="ctnr-folders-wrapper">';
    sortedDates.forEach(dateStr => {
        const dateFolders = dateMap[dateStr];
        const totalDatePhotos = dateFolders.reduce((sum, f) => sum + f.photos.length, 0);
        const dayNum = parseInt(dateStr.split('-')[2] || '0', 10);
        const dateSelectedCount = dateFolders.filter(f => window.selectedFolderKeys && window.selectedFolderKeys.has(`${f.cntrNo}|${f.workDateStr}`)).length;
        const allDateSelected = (dateFolders.length > 0 && dateSelectedCount === dateFolders.length);

        // 조(Team)별 그룹핑
        const teamMap = {};
        dateFolders.forEach(f => {
            const tName = f.teamName || '미지정 조';
            if (!teamMap[tName]) teamMap[tName] = [];
            teamMap[tName].push(f);
        });

        const sortedTeamNames = Object.keys(teamMap).sort((a, b) => a.localeCompare(b, 'ko-KR'));

        html += `
            <div class="ctnr-date-card" data-date-str="${dateStr}">
                <!-- Date Section Header -->
                <div class="ctnr-date-header" data-date-group="${dateStr}">
                    <div class="ctnr-date-title-box">
                        <div class="ctnr-date-title">
                            <i class="fas fa-calendar-alt" style="color:#0284c7;"></i>
                            <span>${formatKoreanDate(dateStr)} 작업</span>
                        </div>
                        <button class="ctnr-date-btn-select-all" onclick="window.toggleDateGroupFolders('${dateStr}', event)">
                            <input type="checkbox" style="cursor:pointer; margin:0;" ${allDateSelected ? 'checked' : ''} onclick="event.stopPropagation()" onchange="window.toggleDateGroupFolders('${dateStr}', event)">
                            <span>${dayNum}일 전체 선택 (${dateSelectedCount}/${dateFolders.length})</span>
                        </button>
                        <button class="btn-date-report" onclick="window.openReportModal('${dateStr}', event)" title="${dateStr} 작업 보고서 보기">
                            <i class="fas fa-file-alt"></i> ${dayNum}일 보고서
                        </button>
                        <span class="ctnr-date-info-summary">
                            컨테이너 <strong>${dateFolders.length}개</strong> · 총 <strong>${totalDatePhotos}장</strong>
                        </span>
                    </div>
                </div>

                <!-- Team Sub-sections -->
                ${sortedTeamNames.map(tName => {
                    const tFolders = teamMap[tName];
                    const tPhotosCount = tFolders.reduce((sum, f) => sum + f.photos.length, 0);
                    const tSelectedCount = tFolders.filter(f => window.selectedFolderKeys && window.selectedFolderKeys.has(`${f.cntrNo}|${f.workDateStr}`)).length;
                    const allTeamSelected = (tFolders.length > 0 && tSelectedCount === tFolders.length);

                    return `
                        <div class="ctnr-team-card" data-date-group="${dateStr}" data-team-group="${tName}">
                            <div class="ctnr-team-header">
                                <div class="ctnr-team-title">
                                    <i class="fas fa-user-friends"></i>
                                    <span>${tName}</span>
                                    <span class="ctnr-team-summary">(${tFolders.length}개 컨테이너 · ${tPhotosCount}장)</span>
                                </div>
                                <button class="ctnr-team-btn-select-all" onclick="window.toggleTeamGroupFolders('${dateStr}', '${tName}', event)">
                                    ${allTeamSelected ? '전체 해제' : '전체 선택'}
                                </button>
                            </div>
                            <div class="ctnr-folders-grid">
                                ${tFolders.map(f => {
                                    const folderKey = `${f.cntrNo}|${f.workDateStr}`;
                                    const isFolderSelected = window.selectedFolderKeys && window.selectedFolderKeys.has(folderKey);
                                    const carrierInfo = getGalleryCarrierInfo(f.transporter, f.teamName);
                                    
                                    const dt = f.lastUploadedAt ? new Date(f.lastUploadedAt) : null;
                                    const timeStr = dt && !isNaN(dt.getTime())
                                        ? `${String(dt.getMonth() + 1).padStart(2, '0')}.${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
                                        : '';
                                    
                                    const hasSeal = f.photos && f.photos.some(p => p.photo_type === 'seal');
                                    const gdriveCnt = f.photos ? f.photos.filter(p => !!p.gdrive_file_id).length : 0;
                                    const isAllGDrive = f.photos && f.photos.length > 0 && gdriveCnt === f.photos.length;

                                    let actionBtnsHtml = '';
                                    if (isTrashTab) {
                                        actionBtnsHtml = `
                                            <button class="ctnr-folder-action-btn ctnr-btn-restore" onclick="window.restoreFolder('${f.cntrNo}', event)" title="폴더 복구">
                                                <i class="fas fa-redo"></i>
                                            </button>
                                        `;
                                    } else if (isCompletedTab) {
                                        actionBtnsHtml = `
                                            <button class="ctnr-folder-action-btn ctnr-btn-undo" onclick="window.toggleCompleteFolder('${f.cntrNo}', false, event)" title="진행 중인 작업으로 되돌리기">
                                                <i class="fas fa-undo"></i>
                                            </button>
                                            <button class="ctnr-folder-action-btn ctnr-btn-trash" onclick="window.trashFolder('${f.cntrNo}', event)" title="휴지통으로 이동">
                                                <i class="fas fa-trash-alt"></i>
                                            </button>
                                        `;
                                    } else {
                                        actionBtnsHtml = `
                                            <button class="ctnr-folder-action-btn ctnr-btn-complete" onclick="window.toggleCompleteFolder('${f.cntrNo}', true, event)" title="작업 완료 처리">
                                                <i class="fas fa-check"></i>
                                            </button>
                                            <button class="ctnr-folder-action-btn ctnr-btn-trash" onclick="window.trashFolder('${f.cntrNo}', event)" title="휴지통으로 이동">
                                                <i class="fas fa-trash-alt"></i>
                                            </button>
                                        `;
                                    }

                                    return `
                                        <div class="ctnr-folder-item ${isFolderSelected ? 'selected' : ''}" data-folder-key="${folderKey}" onclick="window.handleFolderCardClick('${folderKey}', '${f.cntrNo}', '${f.workDateStr}', event)" title="클릭하여 '${f.cntrNo}' 사진 ${f.photos.length}장 보기">
                                            <div class="ctnr-folder-top-row">
                                                <div class="ctnr-folder-left-info">
                                                    <input type="checkbox" class="ctnr-folder-chk" ${isFolderSelected ? 'checked' : ''} onclick="event.stopPropagation()" onchange="window.toggleFolderSelect('${folderKey}', event)">
                                                    <i class="fas fa-folder" style="color:#00c0fa; font-size:1rem; margin:0 4px 0 2px;"></i>
                                                    <strong class="ctnr-folder-name ${carrierInfo.colorClass}">${f.cntrNo}</strong>
                                                    ${carrierInfo.name ? `<span class="ctnr-folder-carrier-tag ${carrierInfo.colorClass}">[${carrierInfo.name}]</span>` : ''}
                                                </div>
                                                <div style="display:flex; align-items:center; gap:5px;">
                                                    ${isAllGDrive ? `<span style="font-size:0.75rem;" title="모든 사진이 구글드라이브에 안전 보관 중입니다 (로컬 용량 정리됨).">☁️</span>` : ''}
                                                    ${!hasSeal ? `<span title="씰(Seal) 사진이 등록되지 않았습니다." class="camera-pulse"><i class="fas fa-camera"></i></span>` : ''}
                                                    <span class="ctnr-folder-count-badge"><i class="far fa-image" style="font-size:0.72rem; opacity:0.75;"></i>${f.photos.length}장</span>
                                                </div>
                                            </div>
                                            <div class="ctnr-folder-bottom-row">
                                                <span class="ctnr-folder-team-info" title="조: ${f.teamName} (${f.uploaderName})">조: ${f.teamName} (${f.uploaderName})</span>
                                                <div class="ctnr-folder-bottom-right">
                                                    <span>${timeStr}</span>
                                                    ${actionBtnsHtml}
                                                </div>
                                            </div>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    });
    html += '</div>';
    listEl.innerHTML = html;
    window.updateGalleryActionBar();
};

window.filterPhotoGallery = function() {
    window.loadPhotoGallery(document.getElementById('photoGallerySearchCntr')?.value || '');
};

// 4. 고기능 라이트박스 뷰어
window.openPhotoLightboxById = function(photoId) {
    let photos = [...window.currentGalleryPhotos];
    if (window.currentGalleryTargetCntr) {
        const targetCntrUpper = window.currentGalleryTargetCntr.toUpperCase().trim();
        photos = photos.filter(p => (p.cntr_no || '').toUpperCase().trim() === targetCntrUpper);
    }
    photos = window.sortPhotoList(photos);

    if (!photos || photos.length === 0) return;
    const targetIdx = photos.findIndex(p => String(p.id) === String(photoId));
    if (targetIdx === -1) return;

    lightboxPhotos = photos;
    currentLightboxIndex = targetIdx;
    window.renderLightboxPhoto();
};

window.openPhotoLightboxFromSorted = function(idx) {
    let photos = [...window.currentGalleryPhotos];
    if (window.currentGalleryTargetCntr) {
        const targetCntrUpper = window.currentGalleryTargetCntr.toUpperCase().trim();
        photos = photos.filter(p => (p.cntr_no || '').toUpperCase().trim() === targetCntrUpper);
    }
    photos = window.sortPhotoList(photos);

    if (!photos || photos.length === 0) return;
    lightboxPhotos = photos;
    currentLightboxIndex = (idx >= 0 && idx < photos.length) ? idx : 0;
    window.renderLightboxPhoto();
};

window.renderLightboxPhoto = function() {
    const modal = document.getElementById('photoLightboxModal');
    const img = document.getElementById('lightboxImg');
    const cntrEl = document.getElementById('lightboxCntrNo');
    const sealEl = document.getElementById('lightboxSealBadge');
    const filenameEl = document.getElementById('lightboxFilename');
    const idxEl = document.getElementById('lightboxIndexInfo');
    const uploaderEl = document.getElementById('lightboxMetaUploader');
    const timeEl = document.getElementById('lightboxMetaTime');
    const teamEl = document.getElementById('lightboxMetaTeam');
    const remarkEl = document.getElementById('lightboxMetaRemark');

    if (!modal || !img || !lightboxPhotos || lightboxPhotos.length === 0) return;

    const photo = lightboxPhotos[currentLightboxIndex];
    if (!photo) return;

    modal.style.display = 'flex';

    // 줌 및 회전 초기화
    isLightboxDragging = false;
    lightboxScale = 1;
    lightboxRotation = 0;
    lightboxPan = { x: 0, y: 0 };
    window.applyLightboxTransform();

    const photoUrl = `${API_BASE}/api/photos/view?filename=${encodeURIComponent(photo.photo_path)}`;
    img.src = photoUrl;

    const fileName = (photo.photo_path || '').split('/').pop() || '';

    if (cntrEl) cntrEl.textContent = photo.cntr_no || '-';
    if (sealEl) sealEl.style.display = (photo.photo_type === 'seal') ? 'inline-block' : 'none';
    if (filenameEl) {
        filenameEl.textContent = fileName;
        filenameEl.title = fileName;
    }
    if (idxEl) idxEl.textContent = `(${currentLightboxIndex + 1} / ${lightboxPhotos.length})`;
    
    if (uploaderEl) uploaderEl.innerHTML = `<i class="fas fa-user"></i> ${photo.uploader_name || '작업자'}`;
    if (timeEl) {
        const upTime = photo.uploaded_at ? new Date(photo.uploaded_at).toLocaleString() : '-';
        timeEl.innerHTML = `<i class="far fa-clock"></i> ${upTime}`;
    }
    if (teamEl) teamEl.innerHTML = `<i class="fas fa-users"></i> ${photo.team_name || '미지정 조'}`;
    if (remarkEl) {
        remarkEl.textContent = photo.remark ? `비고: ${photo.remark}` : '';
    }

    if (photo && photo.cntr_no) {
        window.updateLightboxProductSummary(photo.cntr_no);
    } else {
        window.closeLightboxProductPopover();
        const lbBtn = document.getElementById('btnLightboxProductSummary');
        if (lbBtn) lbBtn.style.display = 'none';
    }
};

window.applyLightboxTransform = function() {
    const img = document.getElementById('lightboxImg');
    const canvas = document.getElementById('lightboxCanvas');
    if (!img) return;
    img.style.transform = `translate(${lightboxPan.x}px, ${lightboxPan.y}px) scale(${lightboxScale}) rotate(${lightboxRotation}deg)`;
    img.style.transition = isLightboxDragging ? 'none' : 'transform 0.15s ease-out';
    if (canvas) {
        canvas.style.cursor = (lightboxScale > 1) ? (isLightboxDragging ? 'grabbing' : 'grab') : 'zoom-in';
    }
};

window.lightboxZoom = function(factor) {
    lightboxScale = Math.max(0.5, Math.min(8, lightboxScale * factor));
    if (lightboxScale <= 1) {
        lightboxPan = { x: 0, y: 0 };
    }
    window.applyLightboxTransform();
};

window.lightboxResetZoom = function() {
    isLightboxDragging = false;
    lightboxScale = 1;
    lightboxRotation = 0;
    lightboxPan = { x: 0, y: 0 };
    window.applyLightboxTransform();
};

window.lightboxRotate = function(deg) {
    const photo = lightboxPhotos[currentLightboxIndex];
    if (photo) {
        window.handleRotatePhotos(deg, photo.id);
    }
    lightboxRotation = (lightboxRotation + deg) % 360;
    window.applyLightboxTransform();
};

window.lightboxRename = async function() {
    const photo = lightboxPhotos[currentLightboxIndex];
    if (!photo) return;
    const oldName = (photo.photo_path || '').split('/').pop() || '';
    const newName = prompt('수정할 새 파일명을 입력하세요:', oldName);
    if (!newName || newName.trim() === oldName) return;

    try {
        const res = await fetch(`${API_BASE}/api/photos/rename`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ photoId: photo.id, newFilename: newName.trim() })
        });
        const data = await res.json();
        if (data.success) {
            photo.photo_path = data.photoPath;
            window.renderLightboxPhoto();
            await window.loadPhotoGallery(window.currentGalleryTargetCntr);
        } else {
            alert(`파일명 변경 실패: ${data.error}`);
        }
    } catch (e) {
        alert("파일명 변경 중 오류: " + e.message);
    }
};

window.lightboxToggleSeal = async function() {
    const photo = lightboxPhotos[currentLightboxIndex];
    if (!photo) return;
    const newType = (photo.photo_type === 'seal') ? 'normal' : 'seal';
    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'update_photo_type', ids: [photo.id], photoType: newType })
        });
        const data = await res.json();
        if (data.success) {
            photo.photo_type = newType;
            window.renderLightboxPhoto();
            await window.loadPhotoGallery(window.currentGalleryTargetCntr);
        }
    } catch (e) {
        alert("씰 상태 변경 실패: " + e.message);
    }
};

window.lightboxMove = function() {
    const photo = lightboxPhotos[currentLightboxIndex];
    if (!photo) return;
    window.selectedPhotoIds.clear();
    window.selectedPhotoIds.add(String(photo.id));
    window.handleOpenMoveModal();
};

window.lightboxDelete = async function() {
    const photo = lightboxPhotos[currentLightboxIndex];
    if (!photo) return;
    if (!confirm(`현재 사진을 삭제(휴지통 이동)하시겠습니까?`)) return;
    try {
        const res = await fetch(`${API_BASE}/api/photos`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'trash_photos', ids: [photo.id] })
        });
        const data = await res.json();
        if (data.success) {
            lightboxPhotos.splice(currentLightboxIndex, 1);
            if (lightboxPhotos.length === 0) {
                window.closePhotoLightbox();
            } else {
                if (currentLightboxIndex >= lightboxPhotos.length) {
                    currentLightboxIndex = lightboxPhotos.length - 1;
                }
                window.renderLightboxPhoto();
            }
            await window.loadPhotoGallery(window.currentGalleryTargetCntr);
        }
    } catch (e) {
        alert("삭제 중 오류: " + e.message);
    }
};

window.lightboxPrev = function() {
    if (!lightboxPhotos || lightboxPhotos.length <= 1) return;
    currentLightboxIndex = (currentLightboxIndex - 1 + lightboxPhotos.length) % lightboxPhotos.length;
    window.renderLightboxPhoto();
};

window.lightboxNext = function() {
    if (!lightboxPhotos || lightboxPhotos.length <= 1) return;
    currentLightboxIndex = (currentLightboxIndex + 1) % lightboxPhotos.length;
    window.renderLightboxPhoto();
};

window.closePhotoLightbox = function() {
    const modal = document.getElementById('photoLightboxModal');
    if (modal) modal.style.display = 'none';
    window.closeLightboxProductPopover();
};

window.lightboxDownload = function() {
    const photo = lightboxPhotos[currentLightboxIndex];
    if (!photo) return;
    const downloadUrl = `${API_BASE}/api/photos/view?filename=${encodeURIComponent(photo.photo_path)}&download=1`;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = photo.photo_path.split('/').pop() || 'photo.jpg';
    document.body.appendChild(a);
    a.click();
    a.remove();
};

// 라이트박스 드래그 & 마우스 휠 줌 & 키보드 단축키 초기화
(function initLightboxEvents() {
    const attachEvents = () => {
        const canvas = document.getElementById('lightboxCanvas');
        const img = document.getElementById('lightboxImg');

        let hasDragged = false;
        let dragStartClient = { x: 0, y: 0 };

        if (canvas && !canvas._bound) {
            canvas._bound = true;

            // 마우스 휠 줌
            canvas.addEventListener('wheel', (e) => {
                const modal = document.getElementById('photoLightboxModal');
                if (modal && modal.style.display !== 'none') {
                    e.preventDefault();
                    if (e.deltaY < 0) window.lightboxZoom(1.15);
                    else window.lightboxZoom(0.85);
                }
            }, { passive: false });

            // 마우스 다운 (확대된 상태에서만 패닝 드래그 시작)
            canvas.addEventListener('mousedown', (e) => {
                if (e.button === 0) {
                    e.preventDefault();
                    dragStartClient = { x: e.clientX, y: e.clientY };
                    hasDragged = false;

                    if (lightboxScale > 1) {
                        isLightboxDragging = true;
                        lightboxDragStart = { x: e.clientX - lightboxPan.x, y: e.clientY - lightboxPan.y };
                        window.applyLightboxTransform();
                    }
                }
            });

            // 클릭 (단순 클릭 시 2.5배율 확대 또는 1배율 리셋 토글)
            canvas.addEventListener('click', (e) => {
                if (hasDragged) return;
                if (lightboxScale > 1) {
                    window.lightboxResetZoom();
                } else {
                    lightboxScale = 2.5;
                    lightboxPan = { x: 0, y: 0 };
                    window.applyLightboxTransform();
                }
            });

            window.addEventListener('mousemove', (e) => {
                if (isLightboxDragging && lightboxScale > 1) {
                    e.preventDefault();
                    const dx = e.clientX - dragStartClient.x;
                    const dy = e.clientY - dragStartClient.y;
                    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                        hasDragged = true;
                    }
                    lightboxPan.x = e.clientX - lightboxDragStart.x;
                    lightboxPan.y = e.clientY - lightboxDragStart.y;
                    window.applyLightboxTransform();
                }
            });

            const stopDrag = () => {
                if (isLightboxDragging) {
                    isLightboxDragging = false;
                    window.applyLightboxTransform();
                }
            };

            window.addEventListener('mouseup', stopDrag);
            window.addEventListener('mouseleave', stopDrag);
            window.addEventListener('blur', stopDrag);
        }

        window.addEventListener('keydown', (e) => {
            const lbModal = document.getElementById('photoLightboxModal');
            if (lbModal && lbModal.style.display !== 'none') {
                if (e.key === 'Escape') window.closePhotoLightbox();
                else if (e.key === 'ArrowLeft') window.lightboxPrev();
                else if (e.key === 'ArrowRight') window.lightboxNext();
                else if (e.key === '+' || e.key === '=') window.lightboxZoom(1.25);
                else if (e.key === '-') window.lightboxZoom(0.8);
                else if (e.key === '0') window.lightboxResetZoom();
                return;
            }

            const copyModal = document.getElementById('modalLocalCopyPhoto');
            if (copyModal && copyModal.style.display !== 'none') {
                if (e.key === 'Escape') window.closeLocalCopyModal();
                return;
            }

            const gModal = document.getElementById('photoGalleryModal');
            if (gModal && gModal.style.display !== 'none') {
                if (e.key === 'Escape') window.closePhotoGalleryModal();
                return;
            }
        });

        const btnOpenPhotoGallery = document.getElementById('btnOpenPhotoGallery');
        if (btnOpenPhotoGallery && !btnOpenPhotoGallery._bound) {
            btnOpenPhotoGallery._bound = true;
            btnOpenPhotoGallery.onclick = () => window.openPhotoGalleryModal();
        }

        const btnOpenReportModal = document.getElementById('btnOpenReportModal');
        if (btnOpenReportModal && !btnOpenReportModal._bound) {
            btnOpenReportModal._bound = true;
            btnOpenReportModal.onclick = () => window.openReportModal();
        }

        // 팝오버 외부 클릭 시 자동 닫기 리스너
        document.addEventListener('click', (e) => {
            const gPop = document.getElementById('galleryProductPopover');
            const gBtn = document.getElementById('btnGalleryProductSummary');
            if (gPop && gPop.style.display !== 'none') {
                if (!gPop.contains(e.target) && (!gBtn || !gBtn.contains(e.target))) {
                    gPop.style.display = 'none';
                }
            }

            const lbPop = document.getElementById('lightboxProductPopover');
            const lbBtn = document.getElementById('btnLightboxProductSummary');
            if (lbPop && lbPop.style.display !== 'none') {
                if (!lbPop.contains(e.target) && (!lbBtn || !lbBtn.contains(e.target))) {
                    lbPop.style.display = 'none';
                }
            }
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attachEvents);
    } else {
        attachEvents();
    }
})();


    // ====================================================
    // [작업 완료 보고서 (ReportModal) CTNR 동일 제어 로직]
    // ====================================================
    (function initReportEvents() {
        const attachEvents = () => {
        };
        window.currentReportData = null;
    window.currentReportText = '';
    window.reportViewMode = 'full';
    window.cancelMode = 'cancel';
    window.selectedManualTeam = '1조(BNI)';
    window.editingReportItem = null;

    function formatReportYMD(d) {
        if (!d) return '';
        const dateObj = new Date(d);
        if (isNaN(dateObj.getTime())) return '';
        const year = dateObj.getFullYear();
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const day = String(dateObj.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    window.openReportModal = function(targetDate = null, event = null) {
        if (event) event.stopPropagation();
        const modal = document.getElementById('reportModal');
        if (!modal) return;

        const dateInput = document.getElementById('reportTargetDate');
        if (targetDate) {
            if (dateInput) dateInput.value = targetDate;
        } else if (!dateInput?.value) {
            const now = new Date();
            if (now.getHours() < 13) {
                now.setDate(now.getDate() - 1);
            }
            if (dateInput) dateInput.value = formatReportYMD(now);
        }

        modal.style.display = 'flex';
        window.loadReportData();
    };

    window.closeReportModal = function() {
        const modal = document.getElementById('reportModal');
        if (modal) modal.style.display = 'none';
    };

    window.navigateReportDate = function(dir) {
        const dateInput = document.getElementById('reportTargetDate');
        if (!dateInput || !dateInput.value) return;

        const cur = new Date(dateInput.value);
        cur.setDate(cur.getDate() + dir);
        dateInput.value = formatReportYMD(cur);
        window.loadReportData();
    };

    window.setReportViewMode = function(mode) {
        window.reportViewMode = mode;
        const btnFull = document.getElementById('btnReportViewFull');
        const btnCompact = document.getElementById('btnReportViewCompact');
        if (btnFull) btnFull.classList.toggle('active', mode === 'full');
        if (btnCompact) btnCompact.classList.toggle('active', mode === 'compact');
        if (window.currentReportData) {
            window.renderReportUI(window.currentReportData);
        }
    };

    window.loadReportData = async function() {
        const dateInput = document.getElementById('reportTargetDate');
        const targetDate = dateInput?.value || formatReportYMD(new Date());

        const loadingEl = document.getElementById('reportLoading');
        const contentEl = document.getElementById('reportContentArea');
        const summaryTitleEl = document.getElementById('reportSummaryTitle');
        const carrierCountsEl = document.getElementById('reportCarrierCounts');
        const statusBadgeEl = document.getElementById('reportSavedStatusBadge');

        if (loadingEl) loadingEl.style.display = 'block';
        if (contentEl) contentEl.innerHTML = '';
        if (summaryTitleEl) summaryTitleEl.textContent = `📅 ${targetDate} 작업 분량 조회 중...`;
        if (carrierCountsEl) carrierCountsEl.innerHTML = '';
        if (statusBadgeEl) statusBadgeEl.style.display = 'none';

        try {
            const res = await fetch(`${API_BASE}/api/reports/generate?startDate=${encodeURIComponent(targetDate)}&endDate=${encodeURIComponent(targetDate)}`);
            const data = await res.json();

            if (loadingEl) loadingEl.style.display = 'none';

            if (!data.success || !data.reportData || data.reportData.length === 0) {
                window.currentReportData = [];
                window.currentReportText = '';
                if (summaryTitleEl) summaryTitleEl.textContent = `📅 ${targetDate} 작업 분량 (작업 내역 없음)`;
                if (contentEl) {
                    contentEl.innerHTML = `
                        <div style="text-align: center; padding: 80px 20px; color: #94a3b8;">
                            <i class="fas fa-file-excel" style="font-size: 3rem; margin-bottom: 14px; opacity: 0.35;"></i>
                            <div style="font-size: 1.1rem; font-weight: 800; color: #64748b;">${targetDate} 작업 데이터가 없습니다.</div>
                            <div style="font-size: 0.85rem; margin-top: 6px; color: #94a3b8;">[+ 항목 추가] 버튼으로 작업을 수동 등록하거나 이전/다음 날짜를 조회해 보세요.</div>
                        </div>
                    `;
                }
                return;
            }

            window.currentReportData = data.reportData;
            window.currentReportText = data.reportText || '';
            window.upcomingRosterText = data.upcomingRosterText || '';
            window.renderReportUI(data.reportData);

            // 저장된 보고서 상태 확인
            checkSavedReportStatus(targetDate);

        } catch (err) {
            console.error("loadReportData error:", err);
            if (loadingEl) loadingEl.style.display = 'none';
            if (contentEl) {
                contentEl.innerHTML = `<div style="text-align:center; color:#ef4444; padding:50px; font-weight:700;">보고서 생성 중 오류가 발생했습니다: ${err.message}</div>`;
            }
        }
    };

    async function checkSavedReportStatus(targetDate) {
        try {
            const res = await fetch(`${API_BASE}/api/reports/saved?workDate=${encodeURIComponent(targetDate)}`);
            const data = await res.json();
            const statusBadgeEl = document.getElementById('reportSavedStatusBadge');
            const statusTextEl = document.getElementById('reportSavedStatusText');
            if (data.success && statusBadgeEl && statusTextEl) {
                const savedTimeStr = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
                statusTextEl.textContent = `${data.workDate} ${savedTimeStr} DB 저장본 (${data.savedBy || '관리자'})`;
                statusBadgeEl.style.display = 'flex';
            }
        } catch (e) {
            // ignore
        }
    }

    window.editingHeaderDate = null;
    window.editCarrierCounts = {};
    window.editRemarkVal = '';

    window.handleEditReportHeader = function(dateStr, e) {
        if (e) e.stopPropagation();
        window.editingHeaderDate = dateStr;
        const dateGroup = (window.currentReportData || []).find(dg => (dg.dateStr || dg.date) === dateStr);
        if (!dateGroup) return;

        const activeCarrierCounts = {};
        (dateGroup.uploaders || []).forEach(u => {
            (u.containers || []).forEach(c => {
                if (c.isCancelled || (c.adminComment || '').includes('[취소]') || (c.adminComment || '').includes('[작업취소]') || (c.adminComment || '').includes('[작업제외]')) return;
                const cTrans = (c.transporter || '').trim();
                let cName = '기타';
                if (cTrans.includes('천마') || u.teamName.includes('천마')) cName = '천마';
                else if (cTrans.includes('BNI') || cTrans.includes('비엔아이') || u.teamName.includes('BNI') || u.teamName.includes('비엔아이')) cName = 'BNI';
                activeCarrierCounts[cName] = (activeCarrierCounts[cName] || 0) + 1;
            });
        });

        window.editCarrierCounts = { ...(dateGroup.customCarrierCounts || activeCarrierCounts) };
        if (window.editCarrierCounts['BNI'] === undefined) window.editCarrierCounts['BNI'] = 0;
        if (window.editCarrierCounts['천마'] === undefined) window.editCarrierCounts['천마'] = 0;
        window.editRemarkVal = dateGroup.customRemark || '';
        window.renderReportUI(window.currentReportData);
    };

    window.saveReportHeaderEdit = function(dateStr) {
        const dateGroup = (window.currentReportData || []).find(dg => (dg.dateStr || dg.date) === dateStr);
        if (dateGroup) {
            dateGroup.customCarrierCounts = { ...window.editCarrierCounts };
            dateGroup.customRemark = (window.editRemarkVal || '').trim();
        }
        window.editingHeaderDate = null;
        window.renderReportUI(window.currentReportData);
    };

    window.cancelReportHeaderEdit = function() {
        window.editingHeaderDate = null;
        window.renderReportUI(window.currentReportData);
    };

    window.renderReportUI = function(reportData) {
        const contentEl = document.getElementById('reportContentArea');
        const summaryTitleEl = document.getElementById('reportSummaryTitle');
        const carrierCountsEl = document.getElementById('reportCarrierCounts');
        if (!contentEl) return;

        let totalContainers = 0;
        const globalCarrierMap = {};

        let html = '';

        reportData.forEach((dateGroup) => {
            const dateStr = dateGroup.dateStr || dateGroup.date;
            const uploaders = dateGroup.uploaders || [];
            let dateContainerCount = 0;
            const dateCarrierMap = { 'BNI': 0, '천마': 0, '재작업': 0 };

            uploaders.forEach(u => {
                (u.containers || []).forEach(c => {
                    const isCancelled = c.isCancelled || (c.adminComment || '').includes('[작업취소]') || (c.adminComment || '').includes('[취소]');
                    const isExcluded = (c.adminComment || '').includes('[작업제외]');
                    if (!isCancelled && !isExcluded) {
                        dateContainerCount++;
                        totalContainers++;
                        const cTrans = (c.transporter || '').trim();
                        let cName = '기타';
                        if (cTrans.includes('재작업') || (c.category || '').includes('재작업') || (c.adminComment || '').includes('재작업')) cName = '재작업';
                        else if (cTrans.includes('천마')) cName = '천마';
                        else if (cTrans.includes('BNI') || cTrans.includes('비엔아이')) cName = 'BNI';
                        else if (u.teamName.includes('천마')) cName = '천마';
                        else if (u.teamName.includes('BNI') || u.teamName.includes('비엔아이')) cName = 'BNI';

                        dateCarrierMap[cName] = (dateCarrierMap[cName] || 0) + 1;
                        globalCarrierMap[cName] = (globalCarrierMap[cName] || 0) + 1;
                    }
                });
            });

            const finalCarrierCounts = dateGroup.customCarrierCounts || dateCarrierMap;
            const displayTotal = Object.values(finalCarrierCounts).reduce((a, b) => a + (Number(b) || 0), 0);
            const bniCount = finalCarrierCounts['BNI'] !== undefined ? finalCarrierCounts['BNI'] : (dateCarrierMap['BNI'] || 0);
            const chunmaCount = finalCarrierCounts['천마'] !== undefined ? finalCarrierCounts['천마'] : (dateCarrierMap['천마'] || 0);
            const reworkCount = finalCarrierCounts['재작업'] !== undefined ? finalCarrierCounts['재작업'] : (dateCarrierMap['재작업'] || 0);

            const reworkHtml = reworkCount > 0 ? ` , <span class="report-carrier-rework">재작업: ${reworkCount}개</span>` : '';
            const otherEntries = Object.entries(finalCarrierCounts).filter(([k]) => k !== 'BNI' && k !== '천마' && k !== '재작업' && finalCarrierCounts[k] > 0);
            const otherCarriersHtml = otherEntries.map(([k, v]) => ` , <span style="color: #64748b; font-weight: 900;">${k}: ${v}개</span>`).join('');

            const numTeams = uploaders.length;
            const gridColsStyle = numTeams === 1 ? 'style="grid-template-columns: 1fr;"' : (numTeams === 2 ? 'style="grid-template-columns: repeat(2, 1fr);"' : 'style="grid-template-columns: repeat(3, 1fr);"');

            html += `
                <div class="report-date-group-card">
                    <!-- 상단 헤더: 날짜 좌측 + 우측 총합계 뱃지 바 (CTNR 100% 동일) -->
                    <div class="report-date-group-header">
                        <h3 class="report-date-group-title">
                            <i class="fas fa-calendar-alt" style="color: #0284c7;"></i>
                            ${dateStr} 작업 분량
                        </h3>

                        ${window.editingHeaderDate === dateStr ? `
                            <div style="display: flex; align-items: center; gap: 8px; background: #ffffff; border: 1px solid #cbd5e1; padding: 4px 12px; border-radius: 9999px; font-size: 0.82rem; font-weight: 700; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                                <span>총합계: ${Object.values(window.editCarrierCounts).reduce((a, b) => a + (Number(b) || 0), 0)}개</span>
                                <span style="color: #cbd5e1;">|</span>
                                <span style="color: #4f46e5; font-weight: 900;">BNI:</span>
                                <input type="number" style="width: 44px; padding: 2px 4px; border: 1px solid #cbd5e1; border-radius: 4px; text-align: center; font-weight: 900;" value="${window.editCarrierCounts['BNI'] || 0}" onchange="window.editCarrierCounts['BNI'] = parseInt(this.value) || 0; window.renderReportUI(window.currentReportData)">
                                <span style="color: #e11d48; font-weight: 900;">천마:</span>
                                <input type="number" style="width: 44px; padding: 2px 4px; border: 1px solid #cbd5e1; border-radius: 4px; text-align: center; font-weight: 900;" value="${window.editCarrierCounts['천마'] || 0}" onchange="window.editCarrierCounts['천마'] = parseInt(this.value) || 0; window.renderReportUI(window.currentReportData)">
                                <span style="color: #cbd5e1;">|</span>
                                <span>비고:</span>
                                <input type="text" style="width: 90px; padding: 2px 6px; border: 1px solid #cbd5e1; border-radius: 4px; font-weight: 700;" value="${window.editRemarkVal || ''}" placeholder="없음" onchange="window.editRemarkVal = this.value">
                                <button type="button" style="background: #0284c7; color: white; border: none; border-radius: 50%; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer;" onclick="window.saveReportHeaderEdit('${dateStr}')"><i class="fas fa-check"></i></button>
                                <button type="button" style="background: #e2e8f0; color: #475569; border: none; border-radius: 50%; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer;" onclick="window.cancelReportHeaderEdit()"><i class="fas fa-times"></i></button>
                            </div>
                        ` : `
                            <div class="report-header-total-badge">
                                <span>총합계: ${displayTotal}개 작업완료</span>
                                <span class="report-carrier-counts-wrap">
                                    ( <span class="report-carrier-bni">BNI: ${bniCount}개</span> , <span class="report-carrier-chunma">천마: ${chunmaCount}개</span>${reworkHtml}${otherCarriersHtml} )
                                </span>
                                ${dateGroup.customRemark ? `<span style="border-left: 1px solid #cbd5e1; padding-left: 8px; margin-left: 4px; color: #475569; font-size: 0.8rem; font-weight: 700;">비고: ${dateGroup.customRemark}</span>` : ''}
                                <button type="button" class="btn-edit-report-header" onclick="window.handleEditReportHeader('${dateStr}', event)" title="총합계 및 비고 수정">
                                    <i class="fas fa-pencil-alt"></i>
                                </button>
                            </div>
                        `}
                    </div>

                    <div class="report-team-columns" ${gridColsStyle}>
                        ${uploaders.map(team => {
                            const cntrs = team.containers || [];
                            const activeCntrs = cntrs.filter(c => !c.isCancelled && !(c.adminComment || '').includes('[작업취소]') && !(c.adminComment || '').includes('[작업제외]'));
                            return `
                                <div class="report-team-card">
                                    <div class="report-team-header">
                                        <span class="report-team-title">
                                            <span class="report-team-dot"></span>
                                            ${team.teamName}
                                        </span>
                                        <span class="report-team-count-badge">합계 ${activeCntrs.length}개</span>
                                    </div>
                                    <div class="report-cntr-list">
                                        ${cntrs.map(c => {
                                            const cTrans = (c.transporter || '').trim();
                                            const isRework = cTrans.includes('재작업') || (c.category || '').includes('재작업') || (c.adminComment || '').includes('재작업');
                                            const isChunma = !isRework && (cTrans.includes('천마') || (cTrans === '' && team.teamName.includes('천마')));
                                            const isBni = !isRework && (cTrans.includes('BNI') || cTrans.includes('비엔아이') || (cTrans === '' && (team.teamName.includes('BNI') || team.teamName.includes('비엔아이'))));
                                            const carrierColorClass = isRework ? 'carrier-rework' : (isChunma ? 'carrier-chunma' : (isBni ? 'carrier-bni' : 'carrier-default'));

                                            const isCancelled = c.isCancelled || (c.adminComment || '').includes('[작업취소]') || (c.adminComment || '').includes('[취소]');
                                            const isExcluded = (c.adminComment || '').includes('[작업제외]');
                                            const cardStateClass = isExcluded ? 'is-excluded' : (isCancelled ? 'is-cancelled' : '');

                                            const totalQty = (c.products || []).reduce((sum, p) => sum + (p.qty || 0), 0);
                                            const modelCount = (c.products || []).length;
                                            const cleanAdminComment = (c.adminComment || '').replace(/\[작업취소\]/g, '').replace(/\[작업제외\]/g, '').replace(/\[취소\]/g, '').trim();
                                            const typeText = c.jobType || cleanAdminComment || '';
                                            const typeLabel = typeText ? `<span class="report-bracket-red" style="margin-left: 6px;">(</span> <strong style="color: #0f172a; font-weight: 800;">${typeText}</strong> <span class="report-bracket-red">)</span>` : '';

                                            const statusTag = isExcluded 
                                                ? '<span class="report-status-tag" style="background:rgba(124, 58, 237, 0.12); color:#7c3aed; border:1px solid rgba(124, 58, 237, 0.3); margin-left:2px;">[작업제외]</span>'
                                                : isCancelled 
                                                ? '<span class="report-status-tag" style="background:rgba(225,29,72,0.15); color:#e11d48; border:1px solid rgba(225,29,72,0.3); margin-left:2px;">[작업취소]</span>'
                                                : (isRework 
                                                ? '<span class="report-status-tag" style="background:rgba(217,119,6,0.15); color:#d97706; border:1px solid rgba(217,119,6,0.3); margin-left:2px;">[재작업]</span>'
                                                : '');

                                            const displayRemark = (c.remark || c.lastRemark || '').replace(/^지연사유:\s*/, '').trim();

                                            return `
                                                <div class="report-cntr-card ${cardStateClass}">
                                                    <div class="report-cntr-top">
                                                        <div class="report-cntr-title-group">
                                                            <strong class="report-cntr-no ${carrierColorClass}">${c.cntrNo}</strong>
                                                            ${statusTag}
                                                            <button type="button" class="report-card-action-btn" onclick="window.handleEditReportItem('${c.cntrNo}', '${team.teamName}', '${dateStr}', ${c.jobId || 'null'}, ${c.manualEntryId || 'null'})" title="항목 수정">✏️</button>
                                                            <button type="button" class="report-card-action-btn delete" onclick="window.handleDeleteReportItem('${c.cntrNo}', '${team.teamName}', '${dateStr}', ${c.jobId || 'null'}, ${c.manualEntryId || 'null'})" title="항목 취소 / 삭제">🗑️</button>
                                                        </div>
                                                        <span class="report-timeline-badge">${c.durationMinutes || 45}분 (${c.startTimeStr || '19:00'}~${c.endTimeStr || '19:45'})</span>
                                                    </div>

                                                    <div class="report-cntr-summary-line">
                                                        <span>${modelCount}모델, ${totalQty.toLocaleString()}개</span>
                                                        ${typeLabel}
                                                    </div>

                                                    ${displayRemark ? `
                                                        <div class="report-delay-box">
                                                            <span class="report-delay-icon">💬</span>
                                                            <div class="report-delay-text">
                                                                <span class="report-delay-label">지연사유:</span> ${displayRemark}
                                                            </div>
                                                        </div>
                                                    ` : ''}

                                                    ${window.reportViewMode === 'full' ? `
                                                        ${(c.products && c.products.length > 0) ? `
                                                            <div class="report-prod-list">
                                                                ${c.products.map(p => `
                                                                    <div class="report-prod-item">
                                                                        <span class="report-prod-name" title="[${p.division || 'CVZ'}] ${p.name}">- [${p.division || 'CVZ'}] ${p.name}</span>
                                                                        <span class="report-prod-qty">${(p.qty || 0).toLocaleString()}개</span>
                                                                    </div>
                                                                `).join('')}
                                                            </div>
                                                        ` : ''}

                                                        ${(c.emptyBoxes && c.emptyBoxes.length > 0) ? `
                                                            <div class="report-prod-list" style="margin-top:4px;">
                                                                ${c.emptyBoxes.map(eb => `
                                                                    <div class="report-prod-item" style="color:#b45309;">
                                                                        <span class="report-prod-name">- 📦 [공박스] ${eb.name}</span>
                                                                        <span class="report-prod-qty" style="color:#b45309;">${(eb.qty || 0).toLocaleString()}개</span>
                                                                    </div>
                                                                `).join('')}
                                                            </div>
                                                        ` : ''}
                                                    ` : ''}
                                                </div>
                                            `;
                                        }).join('')}
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        });

        contentEl.innerHTML = html;

        const firstDate = reportData[0]?.dateStr || reportData[0]?.date || '';
        if (summaryTitleEl) {
            summaryTitleEl.textContent = `📅 ${firstDate} 작업 분량 - 총합계: ${totalContainers}개 작업완료`;
        }

        if (carrierCountsEl) {
            const orderedKeys = ['BNI', '천마', '재작업'];
            Object.keys(globalCarrierMap).forEach(k => {
                if (!orderedKeys.includes(k) && globalCarrierMap[k] > 0) {
                    orderedKeys.push(k);
                }
            });

            carrierCountsEl.innerHTML = orderedKeys.map(k => {
                const count = globalCarrierMap[k] || 0;
                if (count === 0 && k !== 'BNI' && k !== '천마') return '';

                let badgeClass = 'badge-other';
                let iconColor = '#16a34a';
                if (k === 'BNI') {
                    badgeClass = 'badge-bni';
                    iconColor = '#4f46e5';
                } else if (k === '천마') {
                    badgeClass = 'badge-chunma';
                    iconColor = '#e11d48';
                } else if (k === '재작업') {
                    badgeClass = 'badge-rework';
                    iconColor = '#d97706';
                }

                return `
                    <span class="report-carrier-badge ${badgeClass}">
                        <i class="fas fa-tag" style="color: ${iconColor}; font-size: 0.72rem; margin-right: 4px;"></i>
                        <span>${k}:</span> <strong>${count}개</strong>
                    </span>
                `;
            }).join('');
        }
    };

    // --- 보고서 저장 (Save Report) ---
    window.handleSaveReport = async function() {
        if (!window.currentReportData || window.currentReportData.length === 0) {
            alert("저장할 보고서 데이터가 없습니다.");
            return;
        }

        const dateInput = document.getElementById('reportTargetDate');
        const targetDate = dateInput?.value || formatReportYMD(new Date());

        try {
            const res = await fetch(`${API_BASE}/api/reports/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workDate: targetDate,
                    reportText: window.currentReportText || '',
                    reportData: window.currentReportData,
                    savedBy: '관리자'
                })
            });

            const data = await res.json();
            if (data.success) {
                const statusBadgeEl = document.getElementById('reportSavedStatusBadge');
                const statusTextEl = document.getElementById('reportSavedStatusText');
                if (statusBadgeEl && statusTextEl) {
                    const savedTimeStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
                    statusTextEl.textContent = `${targetDate} ${savedTimeStr} DB 저장 완료 (${data.savedBy})`;
                    statusBadgeEl.style.display = 'flex';
                }
                alert(`✅ ${data.message || '보고서가 성공적으로 DB에 저장되었습니다.'}`);
            } else {
                alert(`저장 실패: ${data.error || '알 수 없는 오류'}`);
            }
        } catch (err) {
            console.error("handleSaveReport error:", err);
            alert(`보고서 저장 중 오류가 발생했습니다: ${err.message}`);
        }
    };

    // --- 저장된 보고서 불러오기 (Load Saved Report) ---
    window.handleLoadSavedReport = async function() {
        const dateInput = document.getElementById('reportTargetDate');
        const targetDate = dateInput?.value || formatReportYMD(new Date());

        try {
            const res = await fetch(`${API_BASE}/api/reports/saved?workDate=${encodeURIComponent(targetDate)}`);
            const data = await res.json();

            if (!data.success || !data.reportData || data.reportData.length === 0) {
                alert(data.message || `${targetDate}에 DB 저장된 보고서가 없습니다.`);
                return;
            }

            window.currentReportData = data.reportData;
            window.currentReportText = data.reportText || '';
            window.renderReportUI(data.reportData);

            const statusBadgeEl = document.getElementById('reportSavedStatusBadge');
            const statusTextEl = document.getElementById('reportSavedStatusText');
            if (statusBadgeEl && statusTextEl) {
                const savedTimeStr = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
                statusTextEl.textContent = `${data.workDate} ${savedTimeStr} DB 저장본 (${data.savedBy || '관리자'})`;
                statusBadgeEl.style.display = 'flex';
            }

            alert(`📂 ${targetDate} DB 저장본을 성공적으로 불러왔습니다!`);
        } catch (err) {
            console.error("handleLoadSavedReport error:", err);
            alert(`저장된 보고서 불러오기 중 오류: ${err.message}`);
        }
    };

    // --- 작업취소 / 작업제외 관리 모달 (CancelManageModal) ---
    window.openCancelManageModal = function() {
        const modal = document.getElementById('cancelManageModal');
        if (!modal) return;
        window.renderCancelManageList();
        modal.style.display = 'flex';
    };

    window.closeCancelManageModal = function() {
        const modal = document.getElementById('cancelManageModal');
        if (modal) modal.style.display = 'none';
        window.loadReportData();
    };

    window.setCancelMode = function(mode) {
        window.cancelMode = mode;
        const btnCancel = document.getElementById('btnCancelModeCancel');
        const btnExclude = document.getElementById('btnCancelModeExclude');
        const tipEl = document.getElementById('cancelModeTipText');

        if (btnCancel) btnCancel.classList.toggle('active', mode === 'cancel');
        if (btnExclude) btnExclude.classList.toggle('active', mode === 'exclude');
        if (tipEl) {
            tipEl.textContent = mode === 'cancel' ? '[작업취소]' : '[작업제외]';
            tipEl.style.color = mode === 'cancel' ? '#e11d48' : '#d97706';
        }
    };

    window.renderCancelManageList = function() {
        const area = document.getElementById('cancelManageListArea');
        if (!area || !window.currentReportData || window.currentReportData.length === 0) {
            if (area) area.innerHTML = '<div style="text-align:center; padding:30px; color:#94a3b8;">관리할 컨테이너 데이터가 없습니다.</div>';
            return;
        }

        let html = '';
        window.currentReportData.forEach(dg => {
            (dg.uploaders || []).forEach(team => {
                const cntrs = team.containers || [];
                html += `
                    <div class="cancel-team-group">
                        <div class="cancel-team-header">
                            <span>● ${team.teamName}</span>
                            <span style="font-size:0.75rem; color:#64748b;">총 ${cntrs.length}개 항목</span>
                        </div>
                        <div class="cancel-cntr-grid">
                            ${cntrs.map(c => {
                                const isExcluded = (c.adminComment || '').includes('[작업제외]');
                                const isCancelled = !isExcluded && (c.isCancelled || (c.adminComment || '').includes('[작업취소]') || (c.adminComment || '').includes('[취소]'));
                                const isChecked = isCancelled || isExcluded;
                                const itemClass = isExcluded ? 'is-excluded' : (isCancelled ? 'is-cancelled' : '');

                                return `
                                    <div class="cancel-cntr-item ${itemClass}">
                                        <label style="display:flex; align-items:center; gap:8px; cursor:pointer; flex:1; min-width:0;">
                                            <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="window.handleToggleCancelCntr('${c.cntrNo}', ${c.jobId || 'null'}, ${c.manualEntryId || 'null'})" style="cursor:pointer;">
                                            <div style="min-width:0; flex:1;">
                                                <div style="font-weight:900; font-size:0.82rem; color:#0f172a; display:flex; align-items:center; gap:4px;">
                                                    <span>${c.cntrNo}</span>
                                                    ${isExcluded ? '<span style="background:#7c3aed; color:#fff; font-size:0.65rem; padding:1px 4px; border-radius:4px;">작업제외</span>' : (isCancelled ? '<span style="background:#e11d48; color:#fff; font-size:0.65rem; padding:1px 4px; border-radius:4px;">작업취소</span>' : '')}
                                                </div>
                                                <div style="font-size:0.7rem; color:#64748b; margin-top:2px;">${(c.products || []).length}모델 · ${c.jobType || ''}</div>
                                            </div>
                                        </label>
                                        ${isChecked ? `
                                            <div style="display:flex; gap:3px;">
                                                <button type="button" class="btn-toggle-cancel-type" style="${isCancelled ? 'background:#e11d48; color:#fff;' : ''}" onclick="window.handleSetCancelType('${c.cntrNo}', 'cancel', ${c.jobId || 'null'}, ${c.manualEntryId || 'null'})">취소</button>
                                                <button type="button" class="btn-toggle-cancel-type" style="${isExcluded ? 'background:#7c3aed; color:#fff;' : ''}" onclick="window.handleSetCancelType('${c.cntrNo}', 'exclude', ${c.jobId || 'null'}, ${c.manualEntryId || 'null'})">제외</button>
                                            </div>
                                        ` : ''}
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            });
        });

        area.innerHTML = html;
    };

    window.handleToggleCancelCntr = async function(cntrNo, jobId = null, manualEntryId = null) {
        const dateInput = document.getElementById('reportTargetDate');
        const targetDate = dateInput?.value || formatReportYMD(new Date());

        try {
            await fetch(`${API_BASE}/api/reports/toggle-cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId, manualEntryId, cntrNo, workDate: targetDate, mode: window.cancelMode })
            });
            await window.loadReportData();
            window.renderCancelManageList();
        } catch (e) {
            console.error("handleToggleCancelCntr error:", e);
        }
    };

    window.handleSetCancelType = async function(cntrNo, cancelType, jobId = null, manualEntryId = null) {
        const dateInput = document.getElementById('reportTargetDate');
        const targetDate = dateInput?.value || formatReportYMD(new Date());

        try {
            await fetch(`${API_BASE}/api/reports/toggle-cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId, manualEntryId, cntrNo, workDate: targetDate, cancelType })
            });
            await window.loadReportData();
            window.renderCancelManageList();
        } catch (e) {
            console.error("handleSetCancelType error:", e);
        }
    };

    function resolveReportTransporter(transporterStr, teamName, categoryStr, adminCommentStr) {
        const raw = (transporterStr || '').trim();
        const cat = (categoryStr || '').trim();
        const adm = (adminCommentStr || '').trim();
        const tName = (teamName || '').trim();

        if (raw === 'BNI' || raw === '천마' || raw === '재작업' || raw === '기타') {
            return raw;
        }
        if (raw.includes('재작업') || cat.includes('재작업') || adm.includes('재작업')) {
            return '재작업';
        }
        if (raw.includes('BNI') || raw.includes('비엔아이') || raw.toLowerCase().includes('bni')) {
            return 'BNI';
        }
        if (raw.includes('천마') || raw.includes('천마물류')) {
            return '천마';
        }
        if (raw.includes('기타')) {
            return '기타';
        }
        if (tName.includes('BNI') || tName.includes('비엔아이')) {
            return 'BNI';
        }
        if (tName.includes('천마')) {
            return '천마';
        }
        if (tName.includes('재작업')) {
            return '재작업';
        }
        return '천마';
    }

    // --- 수동 항목 추가 및 수정 모달 (AddManualModal) ---
    window.openAddManualModal = function(itemToEdit = null) {
        const modal = document.getElementById('addManualReportModal');
        if (!modal) return;

        window.editingReportItem = itemToEdit;
        const titleEl = document.getElementById('addManualModalTitle');
        const submitBtnTextEl = document.getElementById('addManualSubmitBtnText');
        const editIdEl = document.getElementById('manualEditId');
        const cntrNoEl = document.getElementById('manualCntrNo');
        const transpEl = document.getElementById('manualTransporter');
        const catEl = document.getElementById('manualCategory');
        const durEl = document.getElementById('manualDuration');
        const remarkEl = document.getElementById('manualRemark');
        const isCancelEl = document.getElementById('manualIsCancelled');

        if (itemToEdit) {
            const resolvedTeam = itemToEdit.teamName || '1조(BNI)';
            const resolvedTransporter = resolveReportTransporter(
                itemToEdit.transporter, 
                resolvedTeam, 
                itemToEdit.category, 
                itemToEdit.adminComment
            );

            if (titleEl) titleEl.textContent = '보고서 항목 수정';
            if (submitBtnTextEl) submitBtnTextEl.textContent = '수정 완료';
            if (editIdEl) editIdEl.value = itemToEdit.manualEntryId || '';
            if (cntrNoEl) cntrNoEl.value = itemToEdit.cntrNo || '';
            if (transpEl) transpEl.value = resolvedTransporter;
            if (catEl) catEl.value = itemToEdit.category || itemToEdit.adminComment || '';
            if (durEl) durEl.value = itemToEdit.durationMinutes || 45;
            if (remarkEl) remarkEl.value = (itemToEdit.remark || itemToEdit.lastRemark || '').replace(/^지연사유:\s*/, '');
            if (isCancelEl) isCancelEl.checked = itemToEdit.isCancelled || false;
            window.selectManualTeam(resolvedTeam, false);

            // populate product rows
            const prodRowsEl = document.getElementById('manualProductRows');
            if (prodRowsEl) prodRowsEl.innerHTML = '';
            (itemToEdit.products || []).forEach(p => {
                window.addManualProductRow(p.division || 'CVZ', p.name || '', p.qty || 0);
            });
            if (!itemToEdit.products || itemToEdit.products.length === 0) {
                window.addManualProductRow('CVZ', '', 0);
            }

            // populate empty box rows
            const ebRowsEl = document.getElementById('manualEmptyBoxRows');
            if (ebRowsEl) ebRowsEl.innerHTML = '';
            (itemToEdit.emptyBoxes || []).forEach(eb => {
                window.addManualEmptyBoxRow(eb.name || '', eb.qty || 0);
            });

        } else {
            if (titleEl) titleEl.textContent = '보고서 전용 수동 항목 추가';
            if (submitBtnTextEl) submitBtnTextEl.textContent = '항목 저장';
            if (editIdEl) editIdEl.value = '';
            if (cntrNoEl) cntrNoEl.value = '';
            if (transpEl) transpEl.value = 'BNI';
            if (catEl) catEl.value = '';
            if (durEl) durEl.value = 45;
            if (remarkEl) remarkEl.value = '';
            if (isCancelEl) isCancelEl.checked = false;
            window.selectManualTeam('1조(BNI)', true);

            const prodRowsEl = document.getElementById('manualProductRows');
            if (prodRowsEl) {
                prodRowsEl.innerHTML = '';
                window.addManualProductRow('CVZ', '', 0);
            }
            const ebRowsEl = document.getElementById('manualEmptyBoxRows');
            if (ebRowsEl) ebRowsEl.innerHTML = '';
        }

        window.updateManualInsertIndexOptions();
        modal.style.display = 'flex';
    };

    window.closeAddManualModal = function() {
        const modal = document.getElementById('addManualReportModal');
        if (modal) modal.style.display = 'none';
        window.editingReportItem = null;
    };

    window.selectManualTeam = function(teamName, autoUpdateTransporter = true) {
        window.selectedManualTeam = teamName;
        document.querySelectorAll('.btn-team-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.team === teamName);
        });
        const transpEl = document.getElementById('manualTransporter');
        if (transpEl && autoUpdateTransporter) {
            transpEl.value = teamName.includes('BNI') || teamName.includes('비엔아이') ? 'BNI' : '천마';
        }
        window.updateManualInsertIndexOptions();
    };

    window.updateManualInsertIndexOptions = function() {
        const select = document.getElementById('manualInsertIndex');
        if (!select) return;

        let cntrsInTeam = [];
        if (window.currentReportData && window.currentReportData[0]) {
            const selected = (window.selectedManualTeam || '').replace(/[\(\)\s]/g, '');
            const teamObj = window.currentReportData[0].uploaders?.find(u => {
                const uName = (u.teamName || '').replace(/[\(\)\s]/g, '');
                return uName.includes(selected) || selected.includes(uName);
            });
            cntrsInTeam = teamObj?.containers || [];
        }

        let html = '<option value="end">맨 마지막 (자동 계산)</option>';
        if (cntrsInTeam.length > 0) {
            html += `<option value="0">1번째 작업 (맨 처음 - ${cntrsInTeam[0].cntrNo} 앞)</option>`;
            for (let i = 1; i < cntrsInTeam.length; i++) {
                const prev = cntrsInTeam[i - 1];
                const next = cntrsInTeam[i];
                html += `<option value="${i}">${i + 1}번째 작업 (${prev.cntrNo} 와 ${next.cntrNo} 사이)</option>`;
            }
        }
        select.innerHTML = html;
    };

    function parseExcelProductText(text) {
        if (!text) return [];
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        const results = [];

        for (const line of lines) {
            let cols = [];
            if (line.includes('\t')) {
                cols = line.split('\t').map(c => c.trim()).filter(c => c.length > 0);
            } else {
                cols = line.split(/\s{2,}|\t/).map(c => c.trim()).filter(c => c.length > 0);
            }

            if (cols.length >= 3) {
                let qtyIdx = -1;
                for (let i = cols.length - 1; i >= 0; i--) {
                    const num = parseInt(cols[i].replace(/[개,EAea\s]/g, ''), 10);
                    if (!isNaN(num) && num > 0) {
                        qtyIdx = i;
                        break;
                    }
                }

                if (qtyIdx !== -1) {
                    const qty = parseInt(cols[qtyIdx].replace(/[개,EAea\s]/g, ''), 10) || 0;
                    let name = '';
                    let div = 'DFZ';

                    if (cols.length === 3) {
                        div = cols[0];
                        name = cols[1];
                    } else if (cols.length === 4) {
                        div = cols[1];
                        name = cols[2];
                    } else if (cols.length >= 5) {
                        div = cols[2];
                        name = cols[3];
                    }
                    if (name && qty > 0) {
                        results.push({ division: div, name: name, qty: qty });
                        continue;
                    }
                }
            } else if (cols.length === 2) {
                const numVal = parseInt(cols[1].replace(/[개,EAea\s]/g, ''), 10);
                if (!isNaN(numVal) && numVal > 0) {
                    const subMatch = cols[0].match(/^([A-Za-z0-9]{2,5})\s+([A-Za-z0-9\.\-_]+)$/);
                    if (subMatch) {
                        results.push({ division: subMatch[1], name: subMatch[2], qty: numVal });
                    } else {
                        results.push({ division: 'DFZ', name: cols[0], qty: numVal });
                    }
                    continue;
                }
            }

            const m3 = line.match(/^([A-Za-z0-9]+)\s+([A-Za-z0-9\.\-_]+)\s+([\d,]+)(?:개)?$/);
            if (m3) {
                const qty = parseInt(m3[3].replace(/,/g, ''), 10) || 0;
                results.push({ division: m3[1], name: m3[2], qty: qty });
                continue;
            }

            const m2 = line.match(/^([A-Za-z0-9\.\-_]+)\s+([\d,]+)(?:개)?$/);
            if (m2) {
                const qty = parseInt(m2[2].replace(/,/g, ''), 10) || 0;
                results.push({ division: 'DFZ', name: m2[1], qty: qty });
                continue;
            }
        }
        return results;
    }

    window.addManualProductRow = function(division = 'CVZ', name = '', qty = 0) {
        const container = document.getElementById('manualProductRows');
        if (!container) return;

        const row = document.createElement('div');
        row.className = 'manual-product-row';
        row.innerHTML = `
            <input type="text" class="form-input prod-div font-bold" style="width: 80px;" placeholder="구분" value="${division}">
            <input type="text" class="form-input prod-name font-bold" style="flex: 1;" placeholder="모델명 (예: LPGU6319Y)" value="${name}">
            <input type="number" class="form-input prod-qty font-bold" style="width: 80px;" placeholder="수량" value="${qty || ''}">
            <button type="button" class="report-card-action-btn delete" onclick="window.removeManualProductRow(this)" title="행 삭제">
                <i class="fas fa-trash-alt"></i>
            </button>
        `;

        row.querySelectorAll('input').forEach(inp => {
            inp.addEventListener('paste', function(e) {
                window.handlePasteExcelToManual(e, row);
            });
        });

        container.appendChild(row);
    };

    window.removeManualProductRow = function(btn) {
        const row = btn.closest('.manual-product-row');
        if (row) row.remove();
    };

    window.addManualEmptyBoxRow = function(name = '', qty = 0) {
        const container = document.getElementById('manualEmptyBoxRows');
        if (!container) return;

        const row = document.createElement('div');
        row.className = 'manual-product-row';
        row.innerHTML = `
            <input type="text" class="form-input eb-name font-bold" style="flex: 1;" placeholder="공박스명 (예: 대형박스)" value="${name}">
            <input type="number" class="form-input eb-qty font-bold" style="width: 90px;" placeholder="수량" value="${qty || ''}">
            <button type="button" class="report-card-action-btn delete" onclick="window.removeManualEmptyBoxRow(this)" title="행 삭제">
                <i class="fas fa-trash-alt"></i>
            </button>
        `;
        container.appendChild(row);
    };

    window.removeManualEmptyBoxRow = function(btn) {
        const row = btn.closest('.manual-product-row');
        if (row) row.remove();
    };

    window.handlePasteExcelToManual = function(e, targetRow = null) {
        const text = e.clipboardData?.getData('Text') || (window.clipboardData && window.clipboardData.getData('Text'));
        if (!text) return;

        const parsedProducts = parseExcelProductText(text);
        if (parsedProducts.length === 0) return;

        e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();

        const container = document.getElementById('manualProductRows');
        if (!container) return;

        if (parsedProducts.length === 1 && targetRow) {
            const divInput = targetRow.querySelector('.prod-div');
            const nameInput = targetRow.querySelector('.prod-name');
            const qtyInput = targetRow.querySelector('.prod-qty');
            if (divInput) divInput.value = parsedProducts[0].division;
            if (nameInput) nameInput.value = parsedProducts[0].name;
            if (qtyInput) qtyInput.value = parsedProducts[0].qty;
        } else {
            const existingRows = container.querySelectorAll('.manual-product-row');
            if (existingRows.length === 1) {
                const firstInput = existingRows[0].querySelector('.prod-name');
                if (!firstInput?.value.trim()) {
                    container.innerHTML = '';
                }
            } else if (targetRow) {
                const nameInput = targetRow.querySelector('.prod-name');
                if (!nameInput?.value.trim()) {
                    targetRow.remove();
                }
            }
            parsedProducts.forEach(p => {
                window.addManualProductRow(p.division, p.name, p.qty);
            });
        }
    };

    window.submitManualReportItem = async function(event) {
        if (event) event.preventDefault();

        const editId = document.getElementById('manualEditId')?.value;
        const cntrNo = document.getElementById('manualCntrNo')?.value.trim().toUpperCase();
        const transporter = document.getElementById('manualTransporter')?.value;
        const category = document.getElementById('manualCategory')?.value.trim();
        const durationMinutes = parseInt(document.getElementById('manualDuration')?.value, 10) || 45;
        const remark = document.getElementById('manualRemark')?.value.trim();
        const isCancelled = document.getElementById('manualIsCancelled')?.checked;
        const insertIndex = document.getElementById('manualInsertIndex')?.value;

        if (!cntrNo) {
            alert("컨테이너 번호를 입력해주세요.");
            return;
        }

        const prodRows = document.querySelectorAll('#manualProductRows .manual-product-row');
        const products = [];
        prodRows.forEach(r => {
            const div = r.querySelector('.prod-div')?.value.trim() || 'CVZ';
            const name = r.querySelector('.prod-name')?.value.trim().toUpperCase();
            const qty = parseInt(r.querySelector('.prod-qty')?.value, 10) || 0;
            if (name && qty > 0) {
                products.push({ division: div, name, qty });
            }
        });

        if (products.length === 0) {
            alert("최소 1개 이상의 유효한 제품 모델명과 수량을 입력해주세요.");
            return;
        }

        const ebRows = document.querySelectorAll('#manualEmptyBoxRows .manual-product-row');
        const emptyBoxes = [];
        ebRows.forEach(r => {
            const name = r.querySelector('.eb-name')?.value.trim().toUpperCase();
            const qty = parseInt(r.querySelector('.eb-qty')?.value, 10) || 0;
            if (name && qty > 0) {
                emptyBoxes.push({ name, qty });
            }
        });

        const dateInput = document.getElementById('reportTargetDate');
        const targetDate = dateInput?.value || formatReportYMD(new Date());

        const finalCategory = isCancelled 
            ? (category ? `${category} [작업취소]` : '[작업취소]')
            : category;

        // 작업 위치(순서) 기반 업로드 시점 계산
        let calculatedFirstUploadedAt = undefined;
        if (insertIndex !== undefined && insertIndex !== 'end' && !isNaN(parseInt(insertIndex, 10))) {
            const idx = parseInt(insertIndex, 10);
            const selected = (window.selectedManualTeam || '').replace(/[\(\)\s]/g, '');
            const teamObj = window.currentReportData?.[0]?.uploaders?.find(u => {
                const uName = (u.teamName || '').replace(/[\(\)\s]/g, '');
                return uName.includes(selected) || selected.includes(uName);
            });
            const cntrsInTeam = teamObj?.containers || [];
            if (cntrsInTeam.length > 0) {
                if (idx === 0) {
                    const firstTime = new Date(cntrsInTeam[0].firstUploadedAt || new Date()).getTime();
                    calculatedFirstUploadedAt = new Date(firstTime - 60000).toISOString();
                } else if (idx < cntrsInTeam.length) {
                    const prevTime = new Date(cntrsInTeam[idx - 1].firstUploadedAt || new Date()).getTime();
                    const nextTime = new Date(cntrsInTeam[idx].firstUploadedAt || new Date()).getTime();
                    const midTime = prevTime + Math.floor((nextTime - prevTime) / 2) || (prevTime + 1000);
                    calculatedFirstUploadedAt = new Date(midTime).toISOString();
                } else {
                    const lastTime = new Date(cntrsInTeam[cntrsInTeam.length - 1].firstUploadedAt || new Date()).getTime();
                    calculatedFirstUploadedAt = new Date(lastTime + 60000).toISOString();
                }
            }
        }

        try {
            if (editId || (window.editingReportItem && window.editingReportItem.manualEntryId) || !window.editingReportItem) {
                // 신규 수동 추가 또는 수동 항목 수정
                const targetManualId = editId ? parseInt(editId, 10) : (window.editingReportItem?.manualEntryId ? parseInt(window.editingReportItem.manualEntryId, 10) : undefined);
                const res = await fetch(`${API_BASE}/api/reports/manual-entry`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: targetManualId,
                        workDate: targetDate,
                        teamName: window.selectedManualTeam,
                        cntrNo,
                        category: finalCategory,
                        transporter,
                        durationMinutes,
                        remark,
                        products,
                        emptyBoxes,
                        firstUploadedAt: calculatedFirstUploadedAt
                    })
                });
                const data = await res.json();
                if (!data.success) {
                    alert(`저장 실패: ${data.error || data.message}`);
                    return;
                }
            } else {
                // 기존 DB 컨테이너 수정
                const res = await fetch(`${API_BASE}/api/reports/update-container`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jobId: window.editingReportItem?.jobId,
                        cntrNo,
                        workDate: targetDate,
                        durationMinutes,
                        remark,
                        category: finalCategory,
                        transporter,
                        emptyBoxes
                    })
                });
                const data = await res.json();
                if (!data.success) {
                    alert(`저장 실패: ${data.error || data.message}`);
                    return;
                }
            }

            window.closeAddManualModal();
            await window.loadReportData();
            alert("✅ 보고서 항목이 성공적으로 저장되었습니다!");

        } catch (err) {
            console.error("submitManualReportItem error:", err);
            alert(`항목 저장 중 오류: ${err.message}`);
        }
    };

    window.handleEditReportItem = function(cntrNo, teamName, dateStr, jobId = null, manualEntryId = null) {
        if (!window.currentReportData) return;
        let foundCntr = null;
        window.currentReportData.forEach(dg => {
            dg.uploaders?.forEach(u => {
                const c = u.containers?.find(x => {
                    if (manualEntryId) {
                        return Number(x.manualEntryId) === Number(manualEntryId);
                    }
                    if (jobId) {
                        return Number(x.jobId) === Number(jobId) && x.cntrNo === cntrNo;
                    }
                    return x.cntrNo === cntrNo;
                });
                if (c) foundCntr = { ...c, teamName: u.teamName };
            });
        });

        if (foundCntr) {
            window.openAddManualModal(foundCntr);
        }
    };

    window.handleDeleteReportItem = async function(cntrNo, teamName, dateStr, jobId = null, manualEntryId = null) {
        if (!confirm(`'${cntrNo}' 컨테이너 항목을 삭제 또는 [작업취소] 처리하시겠습니까?`)) {
            return;
        }

        try {
            if (manualEntryId) {
                // 수동 항목 영구 삭제
                await fetch(`${API_BASE}/api/reports/manual-entry?id=${manualEntryId}`, { method: 'DELETE' });
            } else {
                // 기존 컨테이너 [작업취소] 토글
                await fetch(`${API_BASE}/api/reports/toggle-cancel`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobId, cntrNo, workDate: dateStr, cancelType: 'cancel' })
                });
            }
            await window.loadReportData();
            alert(`'${cntrNo}' 항목 처리가 완료되었습니다.`);
        } catch (e) {
            console.error("handleDeleteReportItem error:", e);
            alert(`삭제 처리 중 오류: ${e.message}`);
        }
    };

    window.copyReportPreset = function(preset) {
        if (!window.currentReportData || window.currentReportData.length === 0) {
            alert("복사할 보고서 데이터가 없습니다.");
            return;
        }

        const text = buildClientReportText(window.currentReportData, preset);
        if (!text) {
            alert("보고서 텍스트 생성에 실패했습니다.");
            return;
        }

        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => {
                const presetName = preset === 'summary' ? '콤팩트 요약' : (preset === 'anomaly' ? '특이사항/지연' : '기본 상세');
                alert(`✅ [${presetName} 보고서] 텍스트가 클립보드에 복사되었습니다!\n메신저(카카오톡 등)에 바로 붙여넣기(Ctrl+V) 하세요.`);
            }).catch(err => {
                copyTextFallback(text);
            });
        } else {
            copyTextFallback(text);
        }
    };

    function buildClientReportText(dataArray, preset = 'full') {
        if (!dataArray || dataArray.length === 0) return '';
        const lines = [];

        if (preset === 'summary') {
            lines.push(`📋 [작업 현황 간략 요약 보고]`);
        } else if (preset === 'anomaly') {
            lines.push(`🚨 [작업 특이사항 및 비고 집중 보고]`);
        } else {
            lines.push(`📋 [일자별 작업 현황 보고서]`);
        }

        dataArray.forEach((dateGroup) => {
            lines.push(`📅 ${dateGroup.dateStr || dateGroup.date} 작업 분량`);
            const activeCarrierCounts = {};
            dateGroup.uploaders?.forEach((u) => {
                u.containers?.forEach((c) => {
                    const isCancelled = c.isCancelled || (c.adminComment || '').includes('[작업취소]') || (c.adminComment || '').includes('[취소]');
                    const isExcluded = (c.adminComment || '').includes('[작업제외]');
                    if (!isCancelled && !isExcluded) {
                        const cTrans = (c.transporter || '').trim();
                        let cName = '기타';
                        if (cTrans.includes('재작업') || (c.category || '').includes('재작업') || (c.adminComment || '').includes('재작업')) cName = '재작업';
                        else if (cTrans.includes('천마')) cName = '천마';
                        else if (cTrans.includes('BNI') || cTrans.includes('비엔아이')) cName = 'BNI';
                        else if (u.teamName.includes('천마')) cName = '천마';
                        else if (u.teamName.includes('BNI') || u.teamName.includes('비엔아이')) cName = 'BNI';
                        activeCarrierCounts[cName] = (activeCarrierCounts[cName] || 0) + 1;
                    }
                });
            });
            const displayTotal = Object.values(activeCarrierCounts).reduce((a, b) => a + b, 0);
            const carrierEntries = Object.entries(activeCarrierCounts);
            const carrierStr = carrierEntries.length > 0 ? ` ( ${carrierEntries.map(([k, v]) => `${k}: ${v}개`).join(', ')} )` : '';
            lines.push(`총합계: ${displayTotal}개 작업완료${carrierStr}\n`);

            if (preset === 'anomaly') {
                let anomalyCount = 0;
                dateGroup.uploaders?.forEach((team) => {
                    const teamAnomalies = (team.containers || []).filter((cntr) => 
                        (cntr.adminComment && cntr.adminComment.trim()) || 
                        (cntr.lastRemark && cntr.lastRemark.trim()) ||
                        (cntr.remark && cntr.remark.trim())
                    );

                    if (teamAnomalies.length > 0) {
                        lines.push(`■ ${team.teamName}`);
                        teamAnomalies.forEach((cntr) => {
                            anomalyCount++;
                            const adminCommentNote = cntr.adminComment ? ` (코멘트: ${cntr.adminComment})` : '';
                            const remarkNote = (cntr.lastRemark || cntr.remark || '').replace(/^지연사유:\s*/, '').trim();
                            lines.push(`- ${cntr.cntrNo}${adminCommentNote}`);
                            if (remarkNote) {
                                lines.push(`  💬 지연사유: ${remarkNote}`);
                            }
                        });
                        lines.push(``);
                    }
                });

                if (anomalyCount === 0) {
                    lines.push(`특이사항 및 지연/취소 건이 없습니다. (전 건 정상 작업 완료)`);
                }
                return;
            }

            dateGroup.uploaders?.forEach((team) => {
                const activeCntrs = (team.containers || []).filter(c => !c.isCancelled && !(c.adminComment || '').includes('[작업취소]') && !(c.adminComment || '').includes('[작업제외]'));
                lines.push(`■ ${team.teamName} (합계 ${activeCntrs.length}개)`);

                team.containers?.forEach((cntr) => {
                    const isCancelled = cntr.isCancelled || (cntr.adminComment || '').includes('[작업취소]') || (cntr.adminComment || '').includes('[취소]');
                    const isExcluded = (cntr.adminComment || '').includes('[작업제외]');
                    const cancelTag = isExcluded ? ' [작업제외]' : (isCancelled ? ' [작업취소]' : '');

                    const adminCommentNote = cntr.adminComment ? ` (${cntr.adminComment})` : '';
                    const totalQty = cntr.totalQty ? cntr.totalQty.toLocaleString() : (cntr.products || []).reduce((s, p) => s + (p.qty || 0), 0).toLocaleString();
                    const modelCount = cntr.modelCount || (cntr.products || []).length;
                    
                    if (preset === 'summary') {
                        lines.push(`- ${cntr.cntrNo} (${modelCount}모델, ${totalQty}개${adminCommentNote}${cancelTag}) ${cntr.startTimeStr ? `[${cntr.durationMinutes || 45}분 (${cntr.startTimeStr}~${cntr.endTimeStr})]` : ''}`);
                        if (cntr.lastRemark && cntr.lastRemark.trim()) {
                            lines.push(`  💬 ${cntr.lastRemark.trim()}`);
                        }
                    } else {
                        lines.push(`${cntr.cntrNo} (${modelCount}모델, ${totalQty}개${adminCommentNote}${cancelTag}) [${cntr.durationMinutes || 45}분 (${cntr.startTimeStr || '19:00'}~${cntr.endTimeStr || '19:45'})]`);

                        if (cntr.lastRemark && cntr.lastRemark.trim()) {
                            lines.push(`- 💬 ${cntr.lastRemark.trim()}`);
                        }
                        if (cntr.products) {
                            for (const p of cntr.products) {
                                lines.push(`- [${p.division || 'CVZ'}] ${p.name} ${(p.qty || 0).toLocaleString()}개`);
                            }
                        }
                        if (cntr.emptyBoxes && cntr.emptyBoxes.length > 0) {
                            for (const eb of cntr.emptyBoxes) {
                                lines.push(`- 📦 [공박스] ${eb.name} ${(eb.qty || 0).toLocaleString()}개`);
                            }
                        }
                        lines.push(``);
                    }
                });
                if (preset === 'summary') {
                    lines.push(``);
                }
            });
        });

        return lines.join('\n');
    }

    function copyTextFallback(text) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            alert("✅ 보고서 텍스트가 클립보드에 복사되었습니다!");
        } catch (e) {
            alert("클립보드 복사에 실패했습니다.");
        }
        document.body.removeChild(textArea);
    }

    window.copyReportImage = async function() {
        const captureArea = document.getElementById('reportCaptureArea');
        if (!captureArea) return;
        if (typeof html2canvas !== 'function') {
            alert("html2canvas 라이브러리를 불러올 수 없습니다.");
            return;
        }

        try {
            const canvas = await html2canvas(captureArea, {
                scale: 2,
                useCORS: true,
                backgroundColor: '#ffffff'
            });

            canvas.toBlob(async (blob) => {
                if (!blob) {
                    alert("이미지 생성에 실패했습니다.");
                    return;
                }
                try {
                    if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
                        await navigator.clipboard.write([
                            new ClipboardItem({ 'image/png': blob })
                        ]);
                        alert("🖼️ 보고서 고해상도 이미지가 클립보드에 복사되었습니다!\n메신저에 바로 붙여넣기(Ctrl+V) 하세요.");
                    } else {
                        const dataUrl = canvas.toDataURL('image/png');
                        const imgWin = window.open('');
                        imgWin.document.write(`<img src="${dataUrl}" style="max-width:100%;">`);
                    }
                } catch (err) {
                    console.error("Clipboard write error:", err);
                    const dataUrl = canvas.toDataURL('image/png');
                    const imgWin = window.open('');
                    imgWin.document.write(`<img src="${dataUrl}" style="max-width:100%;">`);
                }
            }, 'image/png');
        } catch (err) {
            console.error("copyReportImage error:", err);
            alert("이미지 캡처 중 오류가 발생했습니다: " + err.message);
        }
    };

    window.downloadReportImage = async function() {
        const captureArea = document.getElementById('reportCaptureArea');
        if (!captureArea) return;
        if (typeof html2canvas !== 'function') {
            alert("html2canvas 라이브러리를 불러올 수 없습니다.");
            return;
        }

        const dateInput = document.getElementById('reportTargetDate');
        const targetDate = dateInput?.value || formatReportYMD(new Date());

        try {
            const canvas = await html2canvas(captureArea, {
                scale: 2,
                useCORS: true,
                backgroundColor: '#ffffff'
            });

            const link = document.createElement('a');
            link.download = `작업완료보고서_${targetDate.replace(/-/g, '')}.png`;
            link.href = canvas.toDataURL('image/png');
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (err) {
            console.error("downloadReportImage error:", err);
            alert("이미지 다운로드 중 오류가 발생했습니다: " + err.message);
        }
    };

    // ====================================================
    // 조별 작업수량 요약 모달 (CTNR 100% 동일 TeamSummaryModal)
    // ====================================================
    const SUMMARY_CATEGORIES = ['식기', '콤프', '오븐', '횡적', '세탁기', 'SK냉장고', '다모델 SK냉장고', '냉장고', '에어컨', '기타'];

    function getTeamSummaryJobCategory(cntr) {
        const jobTypeStr = (cntr.adminComment || '') + ' ' + (cntr.jobType || '');
        if (jobTypeStr.includes('횡적')) return '횡적';

        let hasOven = false;
        let hasWasher = false;
        let hasDishwasher = false;
        let hasAircon = false;
        let hasComp = false;
        let hasFridge = false;
        let hasSKFridge = false;

        const uniqueModels = new Set();

        for (const p of (cntr.products || [])) {
            if (p.division === 'ZZZ') continue;
            const name = (p.model_name || p.name || '').trim();
            if (name) uniqueModels.add(name);

            if (p.division === 'CVZ') hasOven = true;
            if (p.division === 'DFZ') hasWasher = true;
            if (p.division === 'CDZ') hasDishwasher = true;
            if (p.division === 'DMZ') hasAircon = true;
            if (p.division === 'DHZ') hasComp = true;
            if (p.division === 'CNZ') {
                hasFridge = true;
                const nameUpper = name.toUpperCase();
                if (nameUpper.startsWith('SK')) {
                    hasSKFridge = true;
                }
            }
        }

        if (hasOven) return '오븐';
        if (hasWasher) return '세탁기';
        if (hasDishwasher) return '식기';
        if (hasAircon) return '에어컨';
        if (hasComp) return '콤프';
        if (hasSKFridge) {
            const modelCount = uniqueModels.size || cntr.modelCount || (cntr.products ? cntr.products.length : 1);
            if (modelCount >= 7) {
                return '다모델 SK냉장고';
            }
            return 'SK냉장고';
        }
        if (hasFridge) return '냉장고';

        return '기타';
    }

    window.openTeamSummaryModal = function() {
        const modal = document.getElementById('teamSummaryModal');
        if (!modal) return;

        const dateInput = document.getElementById('reportTargetDate');
        const targetDate = dateInput?.value || (window.currentReportData?.[0]?.dateStr || formatReportYMD(new Date()));
        
        const dayShiftInput = document.getElementById('teamSummaryDayShiftInput');
        if (dayShiftInput) {
            const savedCount = localStorage.getItem(`dayShiftCount_${targetDate}`);
            dayShiftInput.value = savedCount !== null && savedCount.trim() !== '' ? savedCount : '';
        }

        window.renderTeamSummaryModal();
        modal.style.display = 'flex';
    };

    window.closeTeamSummaryModal = function() {
        const modal = document.getElementById('teamSummaryModal');
        if (modal) modal.style.display = 'none';
    };

    window.renderTeamSummaryModal = function() {
        const reportData = window.currentReportData || [];
        const tbody = document.getElementById('teamSummaryTableBody');
        const tfoot = document.getElementById('teamSummaryTableFoot');
        const emptyTbody = document.getElementById('emptyBoxSummaryTableBody');
        const emptyTfoot = document.getElementById('emptyBoxSummaryTableFoot');

        // 1. 조별 통계 집계
        const teamMap = new Map();
        const carrierSummary = { '천마': 0, 'BNI': 0, '재작업': 0, '기타': 0 };
        const emptyBoxMap = new Map();

        reportData.forEach((dateGroup) => {
            (dateGroup.uploaders || []).forEach((team) => {
                if (!teamMap.has(team.teamName)) {
                    const initCounts = {};
                    SUMMARY_CATEGORIES.forEach(cat => initCounts[cat] = 0);
                    initCounts['total'] = 0;
                    teamMap.set(team.teamName, initCounts);
                }

                const counts = teamMap.get(team.teamName);

                (team.containers || []).forEach((cntr) => {
                    const isExcluded = (cntr.adminComment || '').includes('[작업제외]');
                    const isCancelled = !isExcluded && (cntr.isCancelled || (cntr.adminComment || '').includes('[취소]') || (cntr.adminComment || '').includes('[작업취소]'));

                    if (!isExcluded && !isCancelled) {
                        const cat = getTeamSummaryJobCategory(cntr);
                        if (counts[cat] !== undefined) counts[cat]++;
                        else counts['기타']++;
                        counts['total']++;

                        // Carrier summary
                        let carrier = '기타';
                        const cTrans = (cntr.transporter || '').trim();
                        if (cTrans.includes('재작업') || (cntr.category || '').includes('재작업') || (cntr.adminComment || '').includes('재작업')) carrier = '재작업';
                        else if (cTrans.includes('천마')) carrier = '천마';
                        else if (cTrans.includes('BNI') || cTrans.includes('비엔아이')) carrier = 'BNI';
                        else if (team.teamName.includes('천마')) carrier = '천마';
                        else if (team.teamName.includes('BNI') || team.teamName.includes('비엔아이')) carrier = 'BNI';
                        carrierSummary[carrier] = (carrierSummary[carrier] || 0) + 1;

                        // Empty box summary
                        (cntr.emptyBoxes || []).forEach(box => {
                            if (box.name && box.name.toUpperCase().startsWith('MAY')) {
                                const qty = parseInt(box.qty, 10) || 0;
                                if (qty > 0) {
                                    emptyBoxMap.set(box.name, (emptyBoxMap.get(box.name) || 0) + qty);
                                }
                            }
                        });
                    }
                });
            });
        });

        const teams = Array.from(teamMap.keys()).sort((a, b) => a.localeCompare(b));
        const colTotals = {};
        SUMMARY_CATEGORIES.forEach(cat => colTotals[cat] = 0);
        colTotals['total'] = 0;

        teams.forEach(team => {
            const counts = teamMap.get(team);
            SUMMARY_CATEGORIES.forEach(cat => colTotals[cat] += counts[cat]);
            colTotals['total'] += counts['total'];
        });

        // 렌더링 1: 조별 작업수량 표
        if (tbody) {
            if (teams.length === 0) {
                tbody.innerHTML = `<tr><td colspan="${SUMMARY_CATEGORIES.length + 2}" style="padding: 30px; text-align: center; color: #94a3b8;">데이터가 없습니다.</td></tr>`;
            } else {
                tbody.innerHTML = teams.map(team => {
                    const counts = teamMap.get(team);
                    return `
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 8px 12px; text-align: left; font-weight: 800; color: #1e293b; border-right: 1px solid #f1f5f9;">${team}</td>
                            ${SUMMARY_CATEGORIES.map(cat => `
                                <td style="padding: 8px 6px; text-align: center; ${counts[cat] > 0 ? 'font-weight: 800; color: #334155;' : 'color: #cbd5e1;'}">
                                    ${counts[cat]}
                                </td>
                            `).join('')}
                            <td style="padding: 8px 12px; text-align: center; font-weight: 900; color: #4f46e5; background: #eef2ff; border-left: 1px solid #f1f5f9;">
                                ${counts['total']}
                            </td>
                        </tr>
                    `;
                }).join('');
            }
        }

        if (tfoot) {
            if (teams.length > 0) {
                tfoot.innerHTML = `
                    <tr style="background: #f8fafc; font-weight: 900; border-top: 2px solid #e2e8f0;">
                        <td style="padding: 10px 12px; text-align: left; color: #1e293b; border-right: 1px solid #e2e8f0;">전체 합계</td>
                        ${SUMMARY_CATEGORIES.map(cat => `
                            <td style="padding: 10px 6px; text-align: center; color: #1e293b;">${colTotals[cat]}</td>
                        `).join('')}
                        <td style="padding: 10px 12px; text-align: center; color: #4338ca; background: #e0e7ff; border-left: 1px solid #e2e8f0;">
                            ${colTotals['total']}
                        </td>
                    </tr>
                `;
            } else {
                tfoot.innerHTML = '';
            }
        }

        // 렌더링 2: 공박스 표
        const emptyBoxEntries = Array.from(emptyBoxMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
        const totalEmptyBoxes = emptyBoxEntries.reduce((sum, [_, qty]) => sum + qty, 0);

        if (emptyTbody) {
            if (emptyBoxEntries.length === 0) {
                emptyTbody.innerHTML = `<tr><td colspan="2" style="padding: 24px; text-align: center; color: #94a3b8;">당일 사용된 공박스 내역이 없습니다.</td></tr>`;
            } else {
                emptyTbody.innerHTML = emptyBoxEntries.map(([name, qty]) => `
                    <tr style="border-bottom: 1px solid #f1f5f9;">
                        <td style="padding: 8px 14px; font-weight: 700; color: #334155; border-right: 1px solid #f1f5f9;">${name}</td>
                        <td style="padding: 8px 14px; text-align: center; font-weight: 700; color: #334155;">${qty.toLocaleString()}개</td>
                    </tr>
                `).join('');
            }
        }

        if (emptyTfoot) {
            if (emptyBoxEntries.length > 0) {
                emptyTfoot.innerHTML = `
                    <tr style="background: #f8fafc; font-weight: 900; border-top: 2px solid #e2e8f0;">
                        <td style="padding: 10px 14px; color: #1e293b; border-right: 1px solid #e2e8f0;">전체 합계</td>
                        <td style="padding: 10px 14px; text-align: center; color: #0284c7;">${totalEmptyBoxes.toLocaleString()}개</td>
                    </tr>
                `;
            } else {
                emptyTfoot.innerHTML = '';
            }
        }

        // 저장 변수 및 카톡 텍스트 갱신
        window.currentTeamSummaryData = {
            colTotals,
            carrierSummary,
            emptyBoxEntries,
            totalEmptyBoxes
        };

        window.updateTeamSummaryKakaoText();
    };

    window.updateTeamSummaryKakaoText = async function() {
        const textarea = document.getElementById('teamSummaryKakaoText');
        const dayShiftInput = document.getElementById('teamSummaryDayShiftInput');
        if (!textarea) return;

        const data = window.currentTeamSummaryData || {};
        const colTotals = data.colTotals || {};
        const carrierSummary = data.carrierSummary || {};
        const emptyBoxEntries = data.emptyBoxEntries || [];
        const totalEmptyBoxes = data.totalEmptyBoxes || 0;

        const dateInput = document.getElementById('reportTargetDate');
        const targetDate = dateInput?.value || (window.currentReportData?.[0]?.dateStr || formatReportYMD(new Date()));

        const dayVal = dayShiftInput ? dayShiftInput.value.trim() : '';
        if (targetDate) {
            if (dayVal === '') {
                localStorage.removeItem(`dayShiftCount_${targetDate}`);
            } else {
                localStorage.setItem(`dayShiftCount_${targetDate}`, dayVal);
            }
        }

        let carrierStr = '';
        ['천마', 'BNI', '재작업', '기타'].forEach(c => {
            if (carrierSummary[c] > 0) carrierStr += `${c}${carrierSummary[c]} `;
        });
        carrierStr = carrierStr.trim();

        let categoryStr = '';
        const REPORT_CATEGORIES = ['식기', '콤프', '오븐', '횡적', '세탁기', 'SK냉장고', '냉장고', '에어컨', '기타'];
        REPORT_CATEGORIES.forEach(cat => {
            let count = colTotals[cat] || 0;
            if (cat === 'SK냉장고') {
                count += (colTotals['다모델 SK냉장고'] || 0);
            }
            if (count > 0) {
                const displayLabel = cat === 'SK냉장고' ? 'SK' : cat;
                categoryStr += `${displayLabel}${count} `;
            }
        });
        categoryStr = categoryStr.trim();

        const nightTotal = colTotals['total'] || 0;
        const dayTotalStr = dayVal === '' ? '(미입력)' : dayVal;

        let emptyBoxSuffix = '';
        if (emptyBoxEntries.length > 0) {
            const emptyBoxLines = ['공박스'];
            emptyBoxEntries.forEach(([name, qty]) => {
                emptyBoxLines.push(`${name} ${qty.toLocaleString()}개`);
            });
            emptyBoxLines.push(`합계 ${totalEmptyBoxes.toLocaleString()}개 장입`);
            emptyBoxSuffix = `\n\n${emptyBoxLines.join('\n')}`;
        }

        // 조 운영계획 (CTNR 동일 CockroachDB 근무편성 연동)
        let rosterSuffix = '';
        let rosterText = window.upcomingRosterText;
        if (rosterText === undefined || rosterText === null) {
            try {
                const rRes = await fetch(`${API_BASE}/api/reports/roster-status?date=${encodeURIComponent(targetDate)}`);
                const rData = await rRes.json();
                if (rData && rData.success && rData.formattedText) {
                    window.upcomingRosterText = rData.formattedText;
                    rosterText = rData.formattedText;
                }
            } catch (rErr) {
                console.warn("Failed to fetch roster status:", rErr);
            }
        }

        if (rosterText && rosterText.trim()) {
            rosterSuffix = `\n\n${rosterText.trim()}`;
        }

        const generatedText = `웅동 야간출하\n\n${carrierStr}\n${categoryStr}\n주간${dayTotalStr} 야간${nightTotal} 장입 이상무${emptyBoxSuffix}${rosterSuffix}`;
        textarea.value = generatedText;
    };

    window.copyTeamSummaryKakaoText = async function() {
        const dayShiftInput = document.getElementById('teamSummaryDayShiftInput');
        const dayVal = dayShiftInput ? dayShiftInput.value.trim() : '';
        if (dayVal === '') {
            alert('주간 작업수량을 입력해주세요. (0대인 경우 0 입력)');
            dayShiftInput?.focus();
            return;
        }

        const textarea = document.getElementById('teamSummaryKakaoText');
        if (!textarea) return;

        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(textarea.value);
            } else {
                textarea.select();
                document.execCommand('copy');
            }

            const btnText = document.getElementById('teamSummaryCopyBtnText');
            if (btnText) {
                btnText.textContent = '복사됨!';
                setTimeout(() => { btnText.textContent = '복사하기'; }, 2000);
            }
            alert("📋 카톡 보고서 텍스트가 클립보드에 복사되었습니다!");
        } catch (err) {
            console.error("Failed to copy team summary text:", err);
            alert("복사 중 오류가 발생했습니다. 텍스트를 직접 드래그하여 복사해주세요.");
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attachEvents);
    } else {
        attachEvents();
    }
})();


