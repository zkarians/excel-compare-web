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
let masterFileBuffer = null; // 마스터 파일 버퍼

// 창고재고 관련 전역 상태
let warehouseStockDongPrefixes = new Set(); // 창고재고 파일에서 파싱한 (동) 태그 접두어 집합
let warehouseStockLoaded = false; // 창고재고 파일 업로드 여부

// POP 샘플 무게 전역 상태 { "CNTR_NO": { weight: 150.5, memo: "샘플" } }
let popWeightMap = {};

let originalData = [];
let downloadData = [];
let comparisonResult = [];
let displayData = []; // 현재 화면에 표시 중인 (필터링된) 전체 데이터
let lastDbSearchResults = []; // 마지막 DB 검색 결과 (탭 전환 시 유지용)
let currentFilter = 'success';
let selectedItems = new Set(); // DB 저장을 위해 선택된 항목

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
const btnCompare = document.getElementById('btnCompare');
const btnClearRework = document.getElementById('btnClearRework');
const processStatus = document.getElementById('processStatus');
const dashboardContainer = document.getElementById('dashboardContainer');
const resultsContainer = document.getElementById('resultsContainer');
const btnLoadExcel = document.getElementById('btnLoadExcel'); // Added from instruction
const btnDownloadResult = document.getElementById('btnDownloadResult');
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
const chkFullyCompletedOnly = document.getElementById('chkFullyCompletedOnly');
const btnCopyChunma = document.getElementById('btnCopyChunma');
const btnCopyBni = document.getElementById('btnCopyBni');
const btnSendChunma = document.getElementById('btnSendChunma');
const btnSendBni = document.getElementById('btnSendBni');

// DB Sync Elements
const dbSettingsModal = document.getElementById('dbSettingsModal');
const btnOpenDbSettings = document.getElementById('btnOpenDbSettings');
const closeDbSettingsBtn = document.getElementById('closeDbSettingsBtn');
const closeDbSettingsBottomBtn = document.getElementById('closeDbSettingsBottomBtn');
const phoneDbIp = document.getElementById('phoneDbIp');
const phoneDbPort = document.getElementById('phoneDbPort');
const btnSavePhoneIp = document.getElementById('btnSavePhoneIp');
const switchToCloud = document.getElementById('switchToCloud');
const switchToPhone = document.getElementById('switchToPhone');
const syncToPhone = document.getElementById('syncToPhone');
const syncToCloud = document.getElementById('syncToCloud');
const currentDbHost = document.getElementById('currentDbHost');
const currentDbStatus = document.getElementById('currentDbStatus');
const syncProgress = document.getElementById('syncProgress');
const syncStatusText = document.getElementById('syncStatusText');
const syncProgressBar = document.getElementById('syncProgressBar');

/* =========================================================================
 *  MAIN NAVIGATION TABS ( Selection vs Results )
 * ========================================================================= */
function switchMainTab(tabId) {
    const mainTabBtnSelection = document.getElementById('mainTabBtnSelection');
    const mainTabBtnResults = document.getElementById('mainTabBtnResults');
    const tabContentSelection = document.getElementById('tabContentSelection');
    const tabContentResults = document.getElementById('tabContentResults');

    if (tabId === 'selection') {
        if (mainTabBtnSelection) mainTabBtnSelection.classList.add('active');
        if (mainTabBtnResults) mainTabBtnResults.classList.remove('active');
        if (tabContentSelection) tabContentSelection.classList.add('active');
        if (tabContentResults) tabContentResults.classList.remove('active');
    } else {
        if (mainTabBtnSelection) mainTabBtnSelection.classList.remove('active');
        if (mainTabBtnResults) mainTabBtnResults.classList.add('active');
        if (tabContentSelection) tabContentSelection.classList.remove('active');
        if (tabContentResults) tabContentResults.classList.add('active');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const btnSelection = document.getElementById('mainTabBtnSelection');
    const btnResults = document.getElementById('mainTabBtnResults');
    if (btnSelection) btnSelection.addEventListener('click', () => switchMainTab('selection'));
    if (btnResults) btnResults.addEventListener('click', () => switchMainTab('results'));
});


/* =========================================================================
 *  INITIALIZATION
 * ========================================================================= */

// 초기화: 이전 저장 데이터 및 서버 상태 확인
async function initializeApp() {
    // 마스터 데이터 일괄 로드
    await Promise.all([
        loadCarrierMap(),
        loadDynamicRules(),
        loadProductMaster(),
        loadCustomFields(),
        loadHoldContainers()
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
        const btnSaveToDB = document.getElementById('btnSaveToDB');

        if (!data.success) {
            console.warn('DB Not Available:', data.message);
            updateDbConfigUI(false, data.message);

            // 폰 DB가 먹통일 때 사용자에게 즉시 알려주고 클라우드 전환 제안
            if (data.message.includes('timeout') || data.message.includes('ECONNREFUSED')) {
                const useCloud = confirm("현재 폰 DB(Phone)에 접속할 수 없습니다.\n[안전망] Cloudtype DB로 즉시 전환하여 작업을 계속하시겠습니까?");
                if (useCloud) {
                    document.getElementById('switchToCloud').click();
                }
            }

            if (tabDbSearch) {
                tabDbSearch.title = `DB 연결 실패: ${data.message}`;
                tabDbSearch.style.opacity = '0.7';
            }
            if (btnSaveToDB) {
                btnSaveToDB.title = `DB 연결 실패: ${data.message}`;
                btnSaveToDB.style.opacity = '0.7';
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
            if (btnSaveToDB) {
                btnSaveToDB.style.display = '';
                btnSaveToDB.style.opacity = '1';
                btnSaveToDB.title = '선택항목을 DB에 저장';
            }
        }
        // 로컬 전용 기능 노출 제어 (Electron 혹은 localhost일 때만 표시)
        const isLocal = window.isElectron || window.location.hostname === 'localhost';
        if (isLocal) {
            document.querySelectorAll('.local-only-feature').forEach(el => {
                if (el.tagName === 'DIV' && el.style.alignItems === 'center') {
                    el.style.display = 'flex';
                } else {
                    el.style.display = 'block';
                }
            });
            // Electron 전용 네이티브 피커 노출
            document.querySelectorAll('.electron-only-picker').forEach(el => el.style.display = 'inline-block');
        }
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

    // Electron 환경에서 디스크에 저장된 경로 정보가 있다면 우선 사용
    if (window.electronAPI) {
        const diskOrig = await window.electronAPI.getFilePath('original');
        const diskRework = await window.electronAPI.getFilePath('rework');
        const diskDown = await window.electronAPI.getFilePath('download');
        if (diskOrig) savedPathOrig = diskOrig;
        if (diskRework) savedPathRework = diskRework;
        if (diskDown) savedPathDown = diskDown;
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
            statusOriginal.textContent = "상태: 원본 경로 로드됨";
            statusOriginal.style.color = '#059669';
            // Electron API에도 다시 동기화
            if (window.electronAPI) window.electronAPI.saveFilePath('original', savedPathOrig);
        } else {
            localStorage.removeItem('pathOrig');
        }
    }

    if (savedPathRework) {
        if (await isPathValid(savedPathRework)) {
            pathRework.value = savedPathRework;
            statusRework.textContent = "상태: 재작업 경로 로드됨";
            statusRework.style.color = '#059669';
            if (btnClearRework) btnClearRework.style.display = 'inline-block';
            if (window.electronAPI) window.electronAPI.saveFilePath('rework', savedPathRework);
        } else {
            localStorage.removeItem('pathRework');
        }
    }

    if (savedPathDown) {
        if (await isPathValid(savedPathDown)) {
            pathDownload.value = savedPathDown;
            statusDownload.textContent = "상태: 전산 경로 로드됨";
            statusDownload.style.color = '#059669';
            if (window.electronAPI) window.electronAPI.saveFilePath('download', savedPathDown);
        } else {
            localStorage.removeItem('pathDown');
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

    // DB Settings IP/Port Load
    const savedPhoneIp = localStorage.getItem('phoneDbIp');
    const savedPhonePort = localStorage.getItem('phoneDbPort');
    if (savedPhoneIp && phoneDbIp) {
        phoneDbIp.value = savedPhoneIp;
    }
    if (savedPhonePort && phoneDbPort) {
        phoneDbPort.value = savedPhonePort;
    }

    checkReadyStatus();
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

btnSavePhoneIp.addEventListener('click', () => {
    const ip = phoneDbIp.value.trim();
    const port = phoneDbPort.value.trim();
    if (!ip || !port) return alert("주소와 포트를 입력하세요.");
    localStorage.setItem('phoneDbIp', ip);
    localStorage.setItem('phoneDbPort', port);
    alert("폰 접속 정보(DDNS/IP)가 저장되었습니다.");
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
    if (!ip) return alert("폰 주소를 먼저 설정하고 저장해주세요.");
    if (!confirm(`폰 DB(${ip}:${port})로 전환하시겠습니까?`)) return;

    const resp = await fetch(`${API_BASE}/api/db/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: ip, user: 'u0_a286', port: Number(port), database: 'u0_a286', password: '', ssl: false })
    });
    const data = await resp.json();
    alert(data.message);
    updateDbConfigUI(data.success, data.message);
    loadProductMaster(); // 마스터 새로고침
});

async function startSync(direction) {
    const ip = phoneDbIp.value.trim();
    const port = phoneDbPort.value.trim() || '5432';
    if (!ip) return alert("폰 주소가 필요합니다.");
    const msg = direction === 'to_phone' ? "클라우드 ➜ 폰 전송을 시작하시겠습니까?" : "폰 ➜ 클라우드 백업을 시작하시겠습니까?";
    if (!confirm(msg)) return;

    syncProgress.style.display = 'block';
    syncProgressBar.style.width = '0%';
    syncStatusText.textContent = "동기화 준비 중...";

    const phoneConfig = { host: ip, user: 'u0_a286', port: Number(port), database: 'u0_a286', password: '', ssl: false };

    try {
        const resp = await fetch(`${API_BASE}/api/db/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ direction, phoneConfig })
        });
        const data = await resp.json();
        if (data.success) {
            syncProgressBar.style.width = '100%';
            syncStatusText.textContent = "동기화 완료!";
            let resultMsg = "✅ 동기화 결과:\n";
            data.results.forEach(r => {
                resultMsg += `- ${r.table}: ${r.success ? `${r.count}건 완료` : `실패(${r.error})`}\n`;
            });
            alert(resultMsg);
        } else {
            throw new Error(data.message);
        }
    } catch (err) {
        alert("동기화 실패: " + err.message);
        syncStatusText.textContent = "실패: " + err.message;
    } finally {
        setTimeout(() => { syncProgress.style.display = 'none'; }, 3000);
    }
}

syncToPhone.addEventListener('click', () => startSync('to_phone'));
syncToCloud.addEventListener('click', () => startSync('to_cloud'));

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
    if (!text) return "";
    // frontend(app_main.js)와 동일하게 '/' 기준으로 파싱하여 첫번째 항목 반환
    return text.split('/')[0].trim();
}

// 색상 기반 운송사 추출 함수 복구
function getTransporterFromColor(fontColor) {
    if (!fontColor || typeof fontColor !== 'string') return "미분류";

    let colorStr = fontColor.toUpperCase().trim();
    if (colorStr.length === 8) {
        // ARGB format
        let r = parseInt(colorStr.substring(2, 4), 16);
        let g = parseInt(colorStr.substring(4, 6), 16);
        let b = parseInt(colorStr.substring(6, 8), 16);
        if (r > Math.max(g, b) + 20) return "천마(빨강)";
        if (b > Math.max(r, g) + 20) return "BNI(파랑)";
    } else {
        // Simple string matching fallback
        if (colorStr.includes("FF0000") && !colorStr.includes("FF0000FF")) return "천마(빨강)";
        if (colorStr.includes("0000FF") || colorStr.includes("0070C0")) return "BNI(파랑)";
    }
    return "미분류";
}

// 브라우저 환경용 엑셀 읽기 함수 복구
async function readExcelFile(file, type) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = new ExcelJS.Workbook();
                try {
                    await workbook.xlsx.load(data);
                } catch (excelErr) {
                    alert('엑셀 파일을 읽는 데 실패했습니다. 파일이 열려있거나 손상되었을 수 있습니다.\n\n상세: ' + excelErr.message);
                    if (window.electronAPI && window.electronAPI.logFrontendError) {
                        window.electronAPI.logFrontendError(`[ExcelJS Load Error] ${excelErr.message}`);
                    }
                    resolve([]); return;
                }

                let results = [];
                if (type === 'original' || type === 'rework') {
                    const targetSheets = type === 'original' ? ["직선적당일", "법인당일", "혼적당일"] : ["재작업당일"];

                    workbook.worksheets.forEach(ws => {
                        const sheetName = (ws.name || "").trim();
                        if (targetSheets.includes(sheetName)) {
                            // original 파싱 로직 (services/excelService.js의 parseOriginalExcel과 유사하게 구현)
                            let lastValidCntrNo = "";
                            let lastFontColor = null;
                            let lastValidJobName = "";
                            let lastValidDest = "";
                            let lastValidE = "", lastValidN = "", lastValidO = "";
                            let lastValidP = "", lastValidQ = "", lastValidR = "";
                            let dataStarted = false;

                            const COL = { JOB_NAME: 1, DEST: 5, PROD_TYPE: 7, PROD_NAME: 9, QTY: 10, CNTR_TYPE_FALLBACK: 12, CARRIER_FALLBACK: 13, CNTR_TYPE: 14, CARRIER: 15, ETA: 16, ETD: 17, REMARK: 18, CNTR_NO: 20, ADJ1: 21, ADJ2: 22 };

                            ws.eachRow((row, i) => {
                                const safeGetText = (col) => {
                                    const cell = row.getCell(col);
                                    if (!cell) return "";
                                    if (cell.value instanceof Date) {
                                        const d = cell.value;
                                        if (d.getFullYear() < 1900) return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
                                        return `${d.getMonth() + 1}월 ${d.getDate()}일`;
                                    }
                                    try {
                                        let txt = "";
                                        try { txt = cell.text; } catch (e) { txt = ""; }
                                        if (txt !== null && txt !== undefined) return String(txt).trim();
                                        if (cell.value !== null && cell.value !== undefined) return String(cell.value).trim();
                                        return "";
                                    } catch (e) { return ""; }
                                };

                                let currentJobName = safeGetText(COL.JOB_NAME);
                                let cellP = safeGetText(COL.ETA);

                                if (currentJobName && currentJobName !== lastValidJobName) {
                                    lastValidDest = ""; lastValidE = ""; lastValidN = ""; lastValidO = ""; lastValidP = ""; lastValidQ = ""; lastValidR = ""; lastValidCntrNo = ""; lastFontColor = null; lastValidJobName = currentJobName;
                                }

                                if (cellP) {
                                    lastValidP = cellP;
                                }

                                let cellProd = safeGetText(COL.PROD_NAME);
                                // 헤더 행일 수 있는 경우 무시 (row 1이 무조건 헤더가 아닐 수 있으므로)
                                if (i === 1 && (cellProd === '품목명' || cellProd === '품명' || cellProd.toLowerCase().includes('product'))) {
                                    return;
                                }

                                if (!dataStarted) { if (cellProd) dataStarted = true; else return; }
                                if (!cellProd) return;

                                let cellDest = safeGetText(COL.DEST);
                                let cellCntrNo = safeGetText(COL.CNTR_NO);

                                // 컨테이너 번호 감지 및 상속 로직 개선
                                // 1. 유효한 컨테이너 번호 형식(ISO 등)이거나
                                // 2. 숫자가 아닌 문자가 포함된 8자 이상의 문자열이면 새로운 컨테이너로 간주
                                // (사용자 요청: 아래쪽의 단순 숫자(4, 0 등)는 새로운 컨테이너가 아니라 위쪽 번호를 상속받아야 함)
                                const isNewCntr = /^[A-Za-z]{3}[A-Za-z]U?\d{7}$/i.test(cellCntrNo) ||
                                    (cellCntrNo.length >= 8 && isNaN(Number(cellCntrNo)));

                                if (isNewCntr) {
                                    if (cellCntrNo !== lastValidCntrNo) {
                                        lastValidDest = ""; lastValidE = ""; lastValidN = ""; lastValidO = ""; lastValidQ = ""; lastValidR = "";
                                    }
                                    lastValidCntrNo = cellCntrNo;
                                    try { lastFontColor = row.getCell(COL.CNTR_NO).font?.color?.argb || null; } catch (e) { }
                                }

                                const extractedDest = extractDestination(cellDest);
                                if (/^[A-Za-z0-9]{5}$/.test(extractedDest)) { lastValidDest = extractedDest; lastValidE = cellDest; }

                                let cellQ = safeGetText(COL.ETD), cellR = safeGetText(COL.REMARK);
                                if (cellQ) lastValidQ = cellQ; if (cellR) lastValidR = cellR;

                                // 최종 컨테이너 번호 결정 (새 번호가 아니면 마지막 유효 번호 사용)
                                let cntrNo = isNewCntr ? cellCntrNo : lastValidCntrNo;
                                if (!cntrNo || cntrNo.toUpperCase().includes("WAIT")) return;

                                let qty = parseInt(row.getCell(COL.QTY).value) || 0;
                                if (qty <= 0) return;

                                let transporter = "미분류";
                                if (cntrNo.includes("천마")) transporter = "천마(빨강)";
                                else if (cntrNo.includes("BNI")) transporter = "BNI(파랑)";
                                else transporter = getTransporterFromColor(isNewCntr ? (row.getCell(COL.CNTR_NO).font?.color?.argb || null) : lastFontColor);

                                let rawCntrType = safeGetText(COL.CNTR_TYPE) || lastValidN || safeGetText(COL.CNTR_TYPE_FALLBACK) || "-";
                                let rawCarrier = safeGetText(COL.CARRIER) || lastValidO || safeGetText(COL.CARRIER_FALLBACK) || "-";
                                if (rawCarrier && !isNaN(Number(rawCarrier.replace(/,/g, '')))) rawCarrier = "-";

                                if (rawCntrType !== "-") lastValidN = rawCntrType;
                                if (rawCarrier !== "-") lastValidO = rawCarrier;

                                let adj1Color = null;
                                try { adj1Color = row.getCell(COL.ADJ1).font?.color?.argb || null; } catch (e) { }

                                results.push({
                                    sheetName: ws.name, jobName: lastValidJobName, dest: lastValidDest || lastValidE, prodType: safeGetText(COL.PROD_TYPE), prodName: cellProd, qty, cntrType: rawCntrType, carrier: rawCarrier, remark: lastValidR, eta: lastValidP, etd: cellQ || lastValidQ, adj1: safeGetText(COL.ADJ1), adj1Color, adj2: safeGetText(COL.ADJ2), cntrNo, transporter, source: type, tags: [], rawRow: row.values ? [...row.values] : []
                                });
                            });
                        }
                    });
                } else {
                    // download 파싱 로직
                    const ws = workbook.worksheets[0];
                    const DCOL = {
                        DIVISION: 1,      // 사업부 (A열)
                        LOAD_TYPE: 2,
                        CNTR_NO: 3,
                        STATUS: 4,
                        OQC: 6,
                        PENDING_QTY: 7,
                        PROD_NAME: 9,
                        PLAN_QTY: 10,
                        LOAD_QTY: 11,
                        VOLUME: 12,
                        WEIGHT: 13,
                        PACKING_QTY: 14,
                        SEAL_NO: 18,
                        CNTR_TYPE: 19,
                        CARRIER_CODE: 20,
                        CARRIER_NAME: 21,
                        PORT: 28,
                        DEST: 29,
                        LOAD_PLAN_NO: 32,
                        REMARK: 40
                    };

                    ws.eachRow((row, i) => {
                        if (i <= 1) return;
                        const safeGetText = (col) => {
                            const cell = row.getCell(col);
                            if (!cell) return "";
                            if (cell.value instanceof Date) {
                                const d = cell.value;
                                if (d.getFullYear() < 1900) return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
                                return `${d.getMonth() + 1}월 ${d.getDate()}일`;
                            }
                            return (cell.text || String(cell.value || "")).trim();
                        };

                        let cntrNo = safeGetText(DCOL.CNTR_NO);
                        if (!cntrNo) return;

                        results.push({
                            cntrNo,
                            division: safeGetText(DCOL.DIVISION),
                            loadType: safeGetText(DCOL.LOAD_TYPE),
                            status: safeGetText(DCOL.STATUS),
                            oqc: safeGetText(DCOL.OQC),
                            pendingQty: Number(row.getCell(DCOL.PENDING_QTY).value) || 0,
                            prodName: safeGetText(DCOL.PROD_NAME),
                            planQty: Number(row.getCell(DCOL.PLAN_QTY).value) || 0,
                            loadQty: Number(row.getCell(DCOL.LOAD_QTY).value) || 0,
                            volume: Number(row.getCell(DCOL.VOLUME).value) || 0,
                            grossWeight: Number(row.getCell(DCOL.WEIGHT).value) || 0,
                            cntrType: safeGetText(DCOL.CNTR_TYPE),
                            carrierCode: safeGetText(DCOL.CARRIER_CODE),
                            carrierName: safeGetText(DCOL.CARRIER_NAME),
                            port: safeGetText(DCOL.PORT),
                            dest: extractDestination(safeGetText(DCOL.DEST)),
                            packingQty: Number(row.getCell(DCOL.PACKING_QTY).value) || 0,
                            loadPlanNo: safeGetText(DCOL.LOAD_PLAN_NO),
                            remark: safeGetText(DCOL.REMARK),
                            sealNo: safeGetText(DCOL.SEAL_NO),
                            rawRow: row.values ? [...row.values] : []
                        });
                    });
                }
                resolve(results);
            } catch (err) { reject(err); }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}




// 파일 업로드 (Files 저장)
fileOriginal.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
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
        }
    }
    checkReadyStatus();
});

fileDownload.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
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
        }
    }
    checkReadyStatus();
});

// 재작업 파일 업로드
fileRework.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
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
        }
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
    if (val) {
        localStorage.setItem('pathOrig', val);
        if (window.electronAPI) {
            window.electronAPI.saveFilePath('original', val);
        }
        statusOriginal.textContent = "상태: 경로 입력됨 (자동 로드)";
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
    if (val) {
        localStorage.setItem('pathRework', val);
        if (window.electronAPI) {
            window.electronAPI.saveFilePath('rework', val);
        }
        statusRework.textContent = "상태: 경로 입력됨 (자동 로드)";
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
    if (val) {
        localStorage.setItem('pathDown', val);
        if (window.electronAPI) {
            window.electronAPI.saveFilePath('download', val);
        }
        statusDownload.textContent = "상태: 경로 입력됨 (자동 로드)";
        statusDownload.style.color = '#059669';
    } else {
        localStorage.removeItem('pathDown');
        if (window.electronAPI) window.electronAPI.saveFilePath('download', null);
        statusDownload.textContent = "상태: 대기 중";
        statusDownload.style.color = '#64748b';
    }
    checkReadyStatus();
});

pathRework.addEventListener('input', () => {
    const val = pathRework.value.trim();
    if (val) {
        localStorage.setItem('pathRework', val);
        if (window.electronAPI) {
            window.electronAPI.saveFilePath('rework', val);
        }
        statusRework.textContent = "상태: 재작업 경로 입력됨";
        statusRework.style.color = '#059669';
        if (btnClearRework) btnClearRework.style.display = 'inline-block';
    } else {
        localStorage.removeItem('pathRework');
        if (!reworkFile && btnClearRework) btnClearRework.style.display = 'none';
        statusRework.textContent = "상태: 대기 중";
        statusRework.style.color = '#64748b';
    }
    checkReadyStatus();
});

if (btnClearRework) {
    btnClearRework.addEventListener('click', () => {
        reworkFile = null;
        pathRework.value = "";
        fileRework.value = ""; // Reset the input file so it can trigger 'change' again
        localStorage.removeItem('pathRework');
        statusRework.textContent = "상태: 대기 중";
        statusRework.style.color = '#64748b';
        btnClearRework.style.display = 'none';
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
                warehouseStockLoaded = true;

                statusWarehouseStock.innerHTML = `<i class="fas fa-check-circle" style="color:#16a34a; margin-right:4px;"></i>상태: 업로드 완료 (${result.fileName})`;
                statusWarehouseStock.style.color = '#16a34a';
                lastWarehouseStock.textContent = `고유제품 ${result.totalProducts}개 분석 완료`;
                if (btnClearWarehouseStock) btnClearWarehouseStock.style.display = 'inline-block';

                // (동) 배지 업데이트
                if (dongTagBadge && dongPrefixCount) {
                    dongPrefixCount.textContent = result.dongPrefixes.length;
                    dongTagBadge.style.display = 'inline-flex';
                    dongTagBadge.style.alignItems = 'center';
                    dongTagBadge.style.gap = '4px';
                }

                console.log(`✅ 창고재고 파싱 완료: (동) 접두어 ${result.dongPrefixes.length}개`);

                // 이미 비교 결과가 있으면 (동) 태그 즉시 재적용
                if (comparisonResult && comparisonResult.length > 0) {
                    displayResults(comparisonResult, false);
                }
            } else {
                throw new Error(result.message);
            }
        } catch (err) {
            console.error('❌ 창고재고 파일 파싱 실패:', err);
            statusWarehouseStock.innerHTML = `<i class="fas fa-exclamation-circle" style="color:#ef4444; margin-right:4px;"></i>상태: 파싱 실패`;
            statusWarehouseStock.style.color = '#ef4444';
            warehouseStockLoaded = false;
            warehouseStockDongPrefixes = new Set();
            alert(`창고재고 파일 파싱 실패: ${err.message}`);
        }
    });

    if (btnClearWarehouseStock) {
        btnClearWarehouseStock.addEventListener('click', () => {
            warehouseStockDongPrefixes = new Set();
            warehouseStockLoaded = false;
            fileWarehouseStock.value = '';
            statusWarehouseStock.textContent = '상태: 대기 중 (미사용)';
            statusWarehouseStock.style.color = '#64748b';
            lastWarehouseStock.textContent = '';
            btnClearWarehouseStock.style.display = 'none';
            if (dongTagBadge) dongTagBadge.style.display = 'none';
            // 비교 결과 재렌더링 ((동) 태그 제거)
            if (comparisonResult && comparisonResult.length > 0) {
                displayResults(comparisonResult, false);
            }
            console.log('🗑️ 창고재고 파일 해제됨');
        });
    }
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
    const statusEl = type === 'original' ? statusOriginal : statusDownload;
    const originalText = statusEl.textContent;

    try {
        statusEl.textContent = `상태: ${type === 'original' ? '원본' : '전산'} 데이터 불러오는 중...`;
        statusEl.style.color = '#3b82f6';

        // 1. Electron IPC로 저장된 파일 경로 가져오기
        let filePath = null;
        if (window.electronAPI) {
            filePath = await window.electronAPI.getFilePath(type);
        }

        // 2. IPC 경로가 없으면 입력창 경로 사용
        if (!filePath) {
            filePath = type === 'original'
                ? pathOriginal.value.trim()
                : pathDownload.value.trim();
        }

        if (!filePath) {
            throw new Error('저장된 파일 경로가 없습니다. 먼저 파일을 직접 선택해주세요.');
        }

        // 3. 서버에서 해당 경로의 최신 파일을 raw buffer(base64)로 받아오기
        const response = await fetch(`${API_BASE}/api/load-file-raw?path=${encodeURIComponent(filePath)}&t=${Date.now()}`);

        if (!response.ok) {
            let errorMsg = `서버 오류 (${response.status})`;
            const errText = await response.text();
            try {
                const errData = JSON.parse(errText);
                errorMsg = errData.message || errorMsg;
            } catch (e) {
                if (errText.includes('<!DOCTYPE')) {
                    errorMsg = "서버가 올바른 응답을 주지 않았습니다. (서버 재시작이 필요할 수 있습니다)";
                } else {
                    errorMsg = errText || errorMsg;
                }
            }
            throw new Error(errorMsg);
        }

        const result = await response.json();

        if (result.success) {
            // base64 -> ArrayBuffer -> Blob -> File로 변환
            const binaryStr = atob(result.base64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const fileName = result.fileName || (type === 'original' ? 'original.xlsx' : 'download.xlsx');
            const file = new File([blob], fileName, { type: blob.type });

            // 브라우저의 readExcelFile 함수로 파싱 (직접 선택과 100% 동일한 결과)
            const parsedData = await readExcelFile(file, type);

            if (type === 'original') {
                originalData = parsedData.filter(item => (item.qty || 0) > 0);
                statusOriginal.textContent = `상태: 최신 원본 파일 불러오기 성공 (${originalData.length}건)`;
                statusOriginal.style.color = '#059669';
                originalFile = { name: localStorage.getItem('lastOrigName') || fileName, isReloaded: true };
                // 경로 저장
                localStorage.setItem('pathOrig', filePath);
                if (window.electronAPI) window.electronAPI.saveFilePath('original', filePath);
            } else {
                downloadData = parsedData;
                statusDownload.textContent = `상태: 최신 전산 파일 불러오기 성공 (${downloadData.length}건)`;
                statusDownload.style.color = '#059669';
                downloadFile = { name: localStorage.getItem('lastDownName') || fileName, isReloaded: true };
                // 경로 저장
                localStorage.setItem('pathDown', filePath);
                if (window.electronAPI) window.electronAPI.saveFilePath('download', filePath);
            }
            checkReadyStatus();
        } else {
            throw new Error(result.message);
        }
    } catch (err) {
        console.error(`❌ ${type} 불러오기 실패:`, err);
        statusEl.textContent = `상태: ${type === 'original' ? '원본' : '전산'} 불러오기 실패 (${err.message})`;
        statusEl.style.color = '#ef4444';
        setTimeout(() => {
            statusEl.textContent = originalText;
            statusEl.style.color = '#64748b';
        }, 3000);
    }
}

btnReloadOriginal.addEventListener('click', () => reloadLatestFile('original'));
btnReloadDownload.addEventListener('click', () => reloadLatestFile('download'));

// 공통 자동 불러오기 로직
async function handleAutoLoad(type) {
    const inputEl = type === 'original' ? pathOriginal : pathDownload;
    const statusEl = type === 'original' ? statusOriginal : statusDownload;
    const lastEl = type === 'original' ? lastOrig : lastDown;
    const reloadBtn = type === 'original' ? btnReloadOriginal : btnReloadDownload;
    const storageKey = type === 'original' ? 'dirOrig' : 'dirDown';

    let pathVal = inputEl.value.trim();
    let dirPath = "";

    if (pathVal) {
        // 입력값에서 디렉토리 추출 (파일일 경우를 대비)
        const lastSlash = Math.max(pathVal.lastIndexOf('/'), pathVal.lastIndexOf('\\'));
        // 확장자가 있으면(.xlsx 등) 파일로 간주하고 디렉토리만 추출
        if (pathVal.toLowerCase().endsWith('.xlsx') || pathVal.toLowerCase().endsWith('.xls')) {
            dirPath = lastSlash !== -1 ? pathVal.substring(0, lastSlash) : pathVal;
        } else {
            dirPath = pathVal; // 이미 디렉토리인 경우
        }
    } else {
        dirPath = localStorage.getItem(storageKey);
    }

    if (!dirPath) {
        alert("폴더 경로를 입력하거나 파일을 먼저 선택해주세요.");
        inputEl.focus();
        return;
    }

    try {
        // 클라우드 버전에서 로컬 경로(Y:\, C:\ 등) 접근 시도 감지 및 경고
        const isLocalPath = /^[a-zA-Z]:\\/.test(dirPath) || dirPath.startsWith('\\\\');
        const isRemoteServer = !window.isElectron && window.location.hostname !== 'localhost';

        if (isLocalPath && isRemoteServer) {
            alert("⚠️ 현재 웹(클라우드) 버전에서는 내 컴퓨터의 로컬 폴더(Y:, C: 등)에 직접 접근할 수 없습니다.\n\n" +
                "로컬 폴더 자동 불러오기 기능을 사용하려면:\n" +
                "1. 일렉트론(내 PC 실행용) 프로그램을 사용하시거나\n" +
                "2. 파일을 아래 '파일 선택' 버튼으로 직접 업로드해 주세요.");
            return;
        }

        statusEl.textContent = `상태: ${type === 'original' ? '원본' : '전산'} 최신 파일 탐색 중...`;
        statusEl.style.color = '#3b82f6';

        const response = await fetch(`${API_BASE}/api/load-latest-from-dir?dirPath=${encodeURIComponent(dirPath)}&t=${Date.now()}`);

        if (!response.ok) {
            let errMsg = `파일을 찾을 수 없습니다. 경로를 확인해주세요.`;
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

            const parsed = await readExcelFile(file, type);
            if (type === 'original') {
                originalData = parsed.filter(item => (item.qty || 0) > 0);
                originalFile = { name: result.fileName, path: result.fullPath, isAutoLoaded: true, isReloaded: true };
                localStorage.setItem('lastOrigName', result.fileName);
            } else {
                downloadData = parsed;
                downloadFile = { name: result.fileName, path: result.fullPath, isAutoLoaded: true, isReloaded: true };
                localStorage.setItem('lastDownName', result.fileName);
            }

            statusEl.textContent = `상태: 최신 파일 로드 성공 (${result.fileName})`;
            statusEl.style.color = '#059669';
            lastEl.textContent = `최근 사용: ${result.fileName}`;
            reloadBtn.style.display = 'inline-block';

            if (result.fullPath && window.electronAPI) {
                window.electronAPI.saveFilePath(type, result.fullPath);
                localStorage.setItem(type === 'original' ? 'pathOrig' : 'pathDown', result.fullPath);
                localStorage.setItem(storageKey, dirPath);
            }

            checkReadyStatus();
            alert(`${type === 'original' ? '원본' : '전산'} 최신 파일 '${result.fileName}'을 불러왔습니다.`);
        } else {
            throw new Error(result.message);
        }
    } catch (err) {
        console.error(`❌ ${type} 자동 로드 실패:`, err);
        statusEl.textContent = `상태: 로드 실패 (${err.message})`;
        statusEl.style.color = '#ef4444';
        alert(`불러오기 실패: ${err.message}`);
    }
}

btnAutoLoadOrig.addEventListener('click', () => handleAutoLoad('original'));
btnAutoLoadDown.addEventListener('click', () => handleAutoLoad('download'));

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
        const allNew = rows.every(r => r.qtyInfo.origPlan === null);
        const allMissing = rows.every(r => r.badgeClass === 'missing');
        const hasError = rows.some(r => r.isErrorRow || r.badgeClass === 'diff');

        if (allNew) {
            const allNewNonAssetOnly = rows.every(r => r.badgeClass === 'success');
            if (allNewNonAssetOnly) successCntrs.add(cntrNo);
            else extraCntrs.add(cntrNo);
        } else if (allMissing) {
            missingCntrs.add(cntrNo);
        } else if (hasError || rows.some(r => r.badgeClass === 'new' || r.badgeClass === 'missing')) {
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
    const valUpdate = document.getElementById('valUpdate');
    const holdCountEl = document.getElementById('holdCount');

    if (valTotalCntr) valTotalCntr.textContent = cntrSet.size;
    if (valSuccessCntr) valSuccessCntr.textContent = successCntrs.size;
    if (valErrorCntr) valErrorCntr.textContent = errorCntrs.size;
    if (valDownExtraCntr) valDownExtraCntr.textContent = extraCntrs.size;
    if (valOrigExtraCntr) valOrigExtraCntr.textContent = missingCntrs.size;
    if (holdCountEl) holdCountEl.textContent = holdCntrs.size;
    if (valUpdate) valUpdate.textContent = (missingProductsSet ? missingProductsSet.size : 0) + (weightMismatchSet ? weightMismatchSet.size : 0);

    // 운송사 통계
    let chunmaCount = 0;
    let bniCount = 0;
    let unknownCount = 0;

    cntrSet.forEach(cntrNo => {
        const rows = comparisonResult.filter(r => r.cntrNo === cntrNo);
        const trans = rows[0].transporter;
        if (trans.includes('천마')) chunmaCount++;
        else if (trans.includes('BNI')) bniCount++;
        else unknownCount++;
    });

    const valChunma = document.getElementById('valChunma');
    const valBni = document.getElementById('valBni');
    const valUnknownTransporter = document.getElementById('valUnknownTransporter');

    if (valChunma) valChunma.textContent = chunmaCount;
    if (valBni) valBni.textContent = bniCount;
    if (valUnknownTransporter) valUnknownTransporter.textContent = unknownCount;

    // 제품정보 업데이트 필요 카드 클릭 이벤트 (드래그/복사 가능한 팝업)
    const updateCard = document.querySelector('.summary-card.update-needed');
    if (updateCard && !updateCard._hasClickHandler) {
        updateCard.style.cursor = 'pointer';
        updateCard.addEventListener('click', () => {
            const items = [];
            if (missingProductsSet && missingProductsSet.size > 0) {
                items.push('=== 마스터에 없는 제품 (' + missingProductsSet.size + '건) ===');
                missingProductsSet.forEach(name => items.push(name));
            }
            if (weightMismatchSet && weightMismatchSet.size > 0) {
                items.push('');
                items.push('=== 중량/크기 불일치 제품 (' + weightMismatchSet.size + '건) ===');
                weightMismatchSet.forEach(name => items.push(name));
            }
            if (items.length === 0) {
                alert('업데이트가 필요한 제품이 없습니다.');
                return;
            }
            showCopyablePopup('제품정보 업데이트 필요 목록', items.join('\n'));
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

// Electron 네이티브 파일 피커 바인딩
(function setupNativePickers() {
    if (!window.electronAPI) return;

    const pickers = [
        { btn: 'btnNativePickerOrig', type: 'original', storageKey: 'dirOrig' },
        { btn: 'btnNativePickerRework', type: 'rework', storageKey: 'dirRework' },
        { btn: 'btnNativePickerWarehouse', type: 'warehouse', storageKey: 'dirWarehouse' },
        { btn: 'btnNativePickerDown', type: 'download', storageKey: 'dirDown' }
    ];

    pickers.forEach(p => {
        const btn = document.getElementById(p.btn);
        if (!btn) return;

        btn.addEventListener('click', async () => {
            const lastDir = localStorage.getItem(p.storageKey);
            const filePath = await window.electronAPI.selectFile(p.type, lastDir);

            if (filePath) {
                // 폴더 경로 업데이트
                const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
                const dirPath = lastSlash !== -1 ? filePath.substring(0, lastSlash) : filePath;
                localStorage.setItem(p.storageKey, dirPath);

                // 파일 로드 시도
                if (p.type === 'warehouse') {
                    // 창고재고는 별도 로직 (서버 사이드 파싱)
                    loadNativeWarehouseFile(filePath);
                } else {
                    reloadNativeFileFromPath(p.type, filePath);
                }
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
                reworkFile = file;
                localStorage.setItem('pathRework', filePath);
                document.getElementById('pathRework').value = filePath;
                document.getElementById('lastRework').textContent = `최근 사용: ${result.fileName}`;
                document.getElementById('btnClearRework').style.display = 'inline-block';
            }

            statusEl.textContent = `상태: 로드 성공 (${result.fileName})`;
            statusEl.style.color = '#059669';
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
                warehouseStockLoaded = true;
                statusEl.innerHTML = `<i class="fas fa-check-circle" style="color:#16a34a; margin-right:4px;"></i>상태: 완료 (${result.fileName})`;
                document.getElementById('lastWarehouseStock').textContent = `고유제품 ${result.totalProducts}개 분석 완료`;
                document.getElementById('btnClearWarehouseStock').style.display = 'inline-block';
                if (document.getElementById('dongTagBadge')) {
                    document.getElementById('dongPrefixCount').textContent = result.dongPrefixes.length;
                    document.getElementById('dongTagBadge').style.display = 'inline-flex';
                }
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

        setProcessStatus("데이터 처리 준비 중...", 10);
        userSelectedWeights = {}; // 새로운 비교 시작 시 초기화

        let finalOrigList = [];
        let finalDownList = [];
        let finalReworkList = [];

        // 1. 원본 데이터 로드
        if (originalFile && originalFile.isReloaded) {
            finalOrigList = originalData;
        } else if (originalFile) {
            finalOrigList = await readExcelFile(originalFile, 'original');
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

        // 2. 전산 데이터 로드
        if (downloadFile && (downloadFile.isReloaded || downloadFile.isAutoLoaded)) {
            finalDownList = downloadData;
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

        // 3. 재작업 데이터 로드
        if (reworkFile) {
            finalReworkList = await readExcelFile(reworkFile, 'rework'); // 재작업 파일은 '재작업당일' 시트를 읽어야 함
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

        // 재작업 데이터가 있으면 원본 데이터에 합침
        if (finalReworkList.length > 0) {
            finalReworkList.forEach(item => { item.source = 'rework'; });
            finalOrigList = [...finalOrigList, ...finalReworkList];
            console.log(`✅ 재작업 데이터 ${finalReworkList.length}건이 원본에 통합되었습니다.`);
        }

        setProcessStatus("데이터 비교 알고리즘 실행 중...", 80);

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

        setProcessStatus("화면 업데이트 중...", 95);

        // 5. 결과 표시 (기본값을 '정상컨테이너만 보기'로 변경)
        updateDashboard();
        setActiveTab('success');
        switchMainTab('results'); // 결과 탭으로 자동 전환


        // 대시보드 및 결과 영역 표시
        dashboardContainer.style.display = 'flex';
        resultsContainer.style.display = 'block';

        setProcessStatus("모든 처리가 완료되었습니다!", 100, true);

        // 결과 영역으로 스크롤
        resultsContainer.scrollIntoView({ behavior: 'smooth' });

    } catch (err) {
        console.error("비교 중 오류:", err);
        alert(`비교 중 오류가 발생했습니다: ${err.message}\n\n스택:\n${err.stack}`);
        setProcessStatus("오류 발생", 0);
    }
});

// 비교 로직 메인
// Helper to categorize a container's rows (matches updateDashboard logic)
function getContainerStatus(results, cntrNo) {
    const rows = results.filter(r => r.cntrNo === cntrNo);
    const allNew = rows.every(r => r.qtyInfo.origPlan === null && !r.isApproved);
    const allMissing = rows.every(r => r.badgeClass === 'missing' && !r.isApproved);
    const hasError = rows.some(r => (r.isErrorRow || r.badgeClass === 'diff') && !r.isApproved);

    if (allNew) return 'extra';
    if (allMissing) return 'missing';
    if (hasError || rows.some(r => (r.badgeClass === 'extra' || r.badgeClass === 'missing') && !r.isApproved)) return 'error';
    return 'success';
}

function displayResults(results, isDbMode = false) {

    // (동) 태그 헬퍼: 창고재고 업로드 시 + 마스터 prodType Q/H 이면 + 동일접두어 존재 시 표시
    const getDongTag = (prodName, masterProdType) => {
        if (!warehouseStockLoaded || warehouseStockDongPrefixes.size === 0) return '';
        const pt = (masterProdType || '').toUpperCase().trim();
        if (pt !== 'Q' && pt !== 'H') return '';
        const nameUpper = (prodName || '').toUpperCase().trim();
        const dotIdx = nameUpper.lastIndexOf('.');
        if (dotIdx === -1) return '';
        const prefix = nameUpper.substring(0, dotIdx);
        if (warehouseStockDongPrefixes.has(prefix)) {
            return `<span style="display:inline-block; margin-left:4px; font-size:0.72rem; color:#fff; background:#7c3aed; border-radius:4px; padding:1px 5px; font-weight:700; vertical-align:middle; line-height:1.4;">동</span>`;
        }
        return '';
    };

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
            if (manualApprovedItems.has(approvalKey)) {
                r.type = '승인(정상)';
                r.badgeClass = 'success';
                r.cssClass = 'row-success-manual';
                r.isErrorRow = false;
                r.isApproved = true;
                r.adj1 = '원본파일없음 (기존오류원인)';
                r.detail = '<span style="color: #059669; font-weight: bold;">[사용자 수동 승인완료]</span>';
            } else {
                r.isApproved = false;
            }
        });

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
                displayData = results.filter(r => getContainerStatus(fullResultsForStatus, r.cntrNo) === 'success');
                if (chkFullyCompletedOnly && chkFullyCompletedOnly.checked) {
                    const incompleteCntrs = new Set(displayData.filter(r => r.type === '대기' || r.type === '작업중').map(r => r.cntrNo));
                    displayData = displayData.filter(r => !incompleteCntrs.has(r.cntrNo));

                    // 완료된 컨테이너 수 표시
                    const uniqueCntrs = new Set(displayData.map(r => r.cntrNo));
                    const countSpan = document.getElementById('fullyCompletedCount');
                    if (countSpan) {
                        countSpan.textContent = `(${uniqueCntrs.size}건)`;
                        countSpan.style.display = 'inline';
                    }
                } else {
                    const countSpan = document.getElementById('fullyCompletedCount');
                    if (countSpan) countSpan.style.display = 'none';
                }
            } else if (currentFilter === 'missing') {
                displayData = results.filter(r => {
                    const status = getContainerStatus(fullResultsForStatus, r.cntrNo);
                    return status === 'extra' || status === 'missing';
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
                    const isTargetTrans = (currentFilter === 'entry') ? (cleanTrans !== "미분류") : (cleanTrans === "미분류");

                    if (!isTargetTrans) return;
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
                            noWeightInfo: []   // DB 중량 정보 없는 모델
                        };

                        if (item.badgeClass === 'missing') newItem.mismatchDetails.missingInDown.push({ name: item.prodName, qty: (item.qtyInfo ? item.qtyInfo.origPlan : '-') });
                        else if (item.badgeClass === 'extra') newItem.mismatchDetails.missingInOrig.push({ name: item.prodName, qty: (item.qtyInfo ? item.qtyInfo.plan : '-') });
                        else if (item.badgeClass === 'noproduct') newItem.mismatchDetails.noWeightInfo.push({ name: item.prodName });
                        else if (item.badgeClass === 'update') newItem.mismatchDetails.weightDiffs.push({ name: item.prodName, db: item.unitWeight, current: item.currentUnitWeight });

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
                        else if (item.badgeClass === 'update') existing.mismatchDetails.weightDiffs.push({ name: item.prodName, db: item.unitWeight, current: item.currentUnitWeight });

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

                    // 요약 집계 시 오류건(붉은색 건)은 배제
                    const isError = item.isErrorRow || item.hasMissingModel || item.badgeClass === 'missing' || item.isCriticalWeightMismatch;
                    if (!isError) {
                        totalWeight += item.selectedTotalWeight;
                    }

                    return item;
                });

                const actualCounts = {};
                displayData.forEach(item => {
                    // 요약 집계 시 오류건은 배제 (메일 복사 시와 일치시킴)
                    const isError = item.isErrorRow || item.hasMissingModel || item.badgeClass === 'missing' || item.isCriticalWeightMismatch;
                    if (isError) return;

                    const t = item.transporter;
                    if (t) actualCounts[t] = (actualCounts[t] || 0) + 1;
                });

                const summaryContent = Object.entries(actualCounts)
                    .sort((a, b) => {
                        if (a[0] === '미분류') return 1;
                        if (b[0] === '미분류') return -1;
                        return a[0].localeCompare(b[0]);
                    })
                    .map(([name, count]) => `${name} ${count}개`)
                    .join(' / ');

                document.getElementById('entrySummaryContent').textContent = summaryContent || "결과 없음";
                document.getElementById('entryTotalWeight').textContent = totalWeight.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                document.getElementById('entrySummary').style.display = 'flex';

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
                const tagRows = [];
                for (let j = 0; j < res.tags.length; j += 4) {
                    const chunk = res.tags.slice(j, j + 4).map(tag => {
                        const fullText = typeof tag === 'object' ? tag.text : tag;
                        const displayChars = (fullText || "").substring(0, 2);
                        const type = typeof tag === 'object' ? (tag.type || '') : '';
                        return `<span class="tag-badge ${type}" title="${fullText}">${displayChars}</span>`;
                    }).join('');
                    tagRows.push(`<div style="display: flex; gap: 2px; justify-content: center;">${chunk}</div>`);
                }
                tagsHtml = tagRows.join('');
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
                    <td style="text-align: center; color: ${/^(US|CA)/i.test(res.destination.val) ? 'inherit' : '#ef4444'}; font-weight: ${/^(US|CA)/i.test(res.destination.val) ? 'normal' : 'bold'};">${res.destination.val}</td>
                    <td style="color: ${effectiveCntrColor}; ${hasPop ? 'font-style:italic;' : ''}">
                        <div style="display: flex; align-items: center; gap: 4px;">
                            <strong onclick="window.copyToClipboard('${res.cntrNo.replace(/'/g, "\\'")}', '컨테이너')" 
                                    style="cursor: pointer; text-decoration: underline dotted #cbd5e1; text-underline-offset: 3px;"
                                    title="클릭하여 컨테이너 복사"
                                    class="copyable-item">${res.cntrNo}</strong>
                            ${hasPop ? `<span style="display:inline-block;margin-left:3px;font-size:0.65rem;background:#fff7ed;color:#ea580c;border:1px solid #fed7aa;border-radius:4px;padding:0px 4px;vertical-align:middle;">POP</span>` : ''}
                        </div>
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
                                          style="cursor: pointer; padding: 4px 10px; border-radius: 6px; font-size: 0.8rem; font-weight: 800; line-height: 1.2; box-shadow: 0 4px 6px -1px rgba(239, 68, 68, 0.2);"
                                          onclick="window.openWeightMismatchPopup('${res.cntrNo}')">
                                        <i class="fas fa-exclamation-triangle" style="margin-right: 4px;"></i>중량<br>상이
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
                    trError.innerHTML = `<td colspan="10" style="padding: 4px 12px; font-size: 0.85rem; color: #b91c1c; border-bottom: 2px solid #fca5a5;">
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
                    ${(currentFilter === 'error' || currentFilter === 'missing') ? `
                        <td class="col-manage" style="text-align: center;">
                            ${(() => {
                            const isHType = (res.prodType || '').toUpperCase() === 'H';
                            const isMissingOrExtra = res.badgeClass === 'missing' || res.badgeClass === 'extra' || res.rowBadge === 'extra';

                            if (res.isApproved) {
                                return `<button class="btn btn-secondary" style="padding: 2px 6px; font-size: 0.75rem;" onclick="window.cancelApproveHItem('${res.cntrNo}', '${res.prodName}')">승인취소</button>`;
                            }
                            if (isHType && isMissingOrExtra) {
                                return `<button class="btn btn-primary" style="padding: 2px 6px; font-size: 0.75rem; background-color: #7c3aed; border-color: #7c3aed;" onclick="window.approveHItem('${res.cntrNo}', '${res.prodName}')">승인</button>`;
                            }
                            return '-';
                        })()}
                        </td>
                    ` : ''}
                    <td class="col-work"><span class="badge ${res.badgeClass}">${res.type}</span></td>
                    <td class="col-cntr" style="padding-top: 4px; padding-bottom: 4px;">
                        <div style="display: flex; align-items: center; gap: 6px; color: ${cntrColor}; border-bottom: ${tagsHtml ? '1px dashed #cbd5e1' : 'none'}; padding-bottom: ${tagsHtml ? '3px' : '0'}; margin-bottom: ${tagsHtml ? '4px' : '0'}; line-height: 1;">
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
                        </div>
                        ${tagsHtml ? `<div style="display: flex; flex-direction: column; gap: 2px; justify-content: center; line-height: 1;">${tagsHtml}</div>` : ''}
                    </td>
                    <td class="col-type" style="${(res.prodType || '').toUpperCase() === 'H' ? 'color: #7c3aed; font-weight: 700;' : (res.prodType || '').toUpperCase() === 'Q' ? 'color: #0d9488; font-weight: 700;' : ''}">${res.prodType || '-'}</td>
                    <td class="col-div">${res.division || '-'}</td>
                    <td class="col-model" 
                        onclick="window.copyToClipboard('${res.prodName.replace(/'/g, "\\'")}', '제품명')"
                        style="cursor: pointer; ${(res.prodType || '').toUpperCase() === 'H' ? 'color: #7c3aed; font-weight: 700;' : (res.prodType || '').toUpperCase() === 'Q' ? 'color: #0d9488; font-weight: 700;' : ''}"
                        title="클릭하여 제품명 복사"
                        class="copyable-item">
                        ${res.prodName}${getDongTag(res.prodName, res.prodType)}
                    </td>
                    <td class="col-qty" style="font-size: 0.9em;">${renderQtyMismatch(res.qtyInfo)}</td>
                    <td class="col-spec">${renderMismatch(res.cntrType.orig, res.cntrType.val, res.cntrType.isMismatch)}</td>
                    <td class="col-dims">${res.dims || '-'}</td>
                    <td class="col-carrier">${renderMismatch(res.carrierName.orig, res.carrierName.val, res.carrierName.isMismatch)}</td>
                    <td class="col-dest">${res.destination.orig === null ? `<span>${res.destination.val}</span>` : renderMismatch(res.destination.orig, res.destination.val, res.destination.isMismatch)}</td>
                    <td class="col-gw">
                        ${(() => {
                        if (res.badgeClass === 'noproduct') {
                            return `<div style="text-align: center; color: #ef4444; font-weight: 800;">정보없음</div>`;
                        }
                        const mRaw = parseFloat(res.weights.mixed);
                        const oRaw = parseFloat(res.weights.orig);
                        const dRaw = parseFloat(res.weights.down) || 0;
                        if (isNaN(mRaw) || isNaN(oRaw)) {
                            return `<div style="text-align: center; color: #ef4444; font-weight: 800;">정보없음</div>`;
                        }
                        const diffAbs = Math.abs(mRaw - oRaw);
                        if (diffAbs < 1) {
                            return `<div style="text-align: center; color: #94a3b8; font-weight: 400;">-</div>`;
                        }
                        const diffStr = diffAbs.toFixed(2);
                        return `<div style="color: #64748b; font-size: 0.8rem; font-weight: 400;">${dRaw.toLocaleString()}</div>
                                <div style="text-align: center; color: #ef4444; font-weight: 800;">${diffStr}</div>`;
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
                        tr.addEventListener('click', () => {
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

                    tr.addEventListener('click', () => {
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
                ${(isDbSearchTab || isErrorTab) ? '<th class="col-manage">관리</th>' : ''}
                <th class="col-work">작업구분</th>
                <th class="col-cntr">컨테이너번호</th>
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
    attach('cardExtra', 'missing');
    attach('cardMissing', 'missing');
}

initTabListeners();
const tabDbSearchObj = document.getElementById('tabDbSearch');
if (tabDbSearchObj) {
    tabDbSearchObj.addEventListener('click', () => setActiveTab('dbSearch'));
}

if (chkFullyCompletedOnly) {
    chkFullyCompletedOnly.addEventListener('change', () => {
        if (comparisonResult.length > 0) displayResults(comparisonResult);
    });
}

// 결과 엑셀 다운로드 버튼 리스너 (displayResults 밖으로 이동)
btnDownloadResult.addEventListener('click', async () => {
    if (!comparisonResult || comparisonResult.length === 0) {
        alert("내보낼 데이터가 없습니다. 먼저 비교를 실행해주세요.");
        return;
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('비교 결과');

    // 현재 필터 및 검색어에 따라 내보낼 데이터와 헤더 결정
    let exportData = [];
    let columns = [];

    // 현재 UI에 적용된 검색어 및 필터 가져오기
    const searchInput = document.getElementById('inputSearch');
    const prodSearchInput = document.getElementById('inputProdSearch');
    const prodTypeSelect = document.getElementById('selectProdType');

    const searchTerm = (searchInput ? searchInput.value : "").trim().toUpperCase();
    const prodSearchTerm = (prodSearchInput ? prodSearchInput.value : "").trim().toUpperCase();
    const prodTypeFilter = (prodTypeSelect ? prodTypeSelect.value : "").trim().toUpperCase();

    // 1. 기초 데이터 필터링 (검색어 반영)
    let filteredResults = comparisonResult;
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

    if (currentFilter === 'entry' || currentFilter === 'entry_unclassified') {
        // 반입정보 형식
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

        // displayResults와 동일한 집계 로직 적용 (검색어 필터링된 데이터 기반)
        const aggregated = new Map();
        filteredResults.forEach(item => {
            // 보류 건은 반입정보에서도 제외 (사용자 요청)
            if (holdContainerMap.has(item.cntrNo)) return;

            let isUnclassified = false;
            let cleanTrans = (item.transporter || "").toString().replace(/\(빨강\)|\(파랑\)|\(초록\)|\(주황\)/g, "").trim();
            if (!cleanTrans || cleanTrans === "-" || cleanTrans === "정보없음" || cleanTrans === "미분류" || cleanTrans === "미지정") {
                isUnclassified = true;
                cleanTrans = "미분류";
            }

            if (currentFilter === 'entry' && isUnclassified) return;
            if (currentFilter === 'entry_unclassified' && !isUnclassified) return;

            const key = (item.cntrNo || "").trim().toUpperCase();
            if (!key || item.badgeClass === 'missing') return;

            if (!aggregated.has(key)) {
                aggregated.set(key, {
                    carrier: item.carrierName.val,
                    cntrType: item.cntrType.val,
                    dest: item.destination.val,
                    cntrNo: item.cntrNo,
                    sealNo: item.sealNo || "",
                    mixedWeight: item.weights.mixed === null ? 0 : (parseFloat(item.weights.mixed) || 0),
                    origWeight: item.weights.orig === null ? 0 : (parseFloat(item.weights.orig) || 0),
                    downWeight: item.weights.down === null ? 0 : (parseFloat(item.weights.down) || 0),
                    isMismatch: item.weights.isMismatch,
                    issueModels: [],
                    origRemark: item.origRemark || "",
                    etd: item.etd || "",
                    workDate: item.workDate || "-",
                    transporter: cleanTrans
                });
                const entry = aggregated.get(key);
                if (item.weights.mixed === null) {
                    entry.issueModels.push(`${item.prodName}: 제품정보없음`);
                } else if (item.weights.isMismatch) {
                    const diff = (parseFloat(item.weights.mixed) - parseFloat(item.weights.orig)).toFixed(2);
                    entry.issueModels.push(`${item.prodName}: 무게정보다름(차이값:${diff > 0 ? '+' : ''}${diff})`);
                }
            } else {
                const existing = aggregated.get(key);
                // Accumulate weights
                existing.mixedWeight += (parseFloat(item.weights.mixed) || 0);
                existing.origWeight += (parseFloat(item.weights.orig) || 0);
                existing.downWeight += (parseFloat(item.weights.down) || 0);

                if (item.weights.mixed === null) {
                    existing.issueModels.push(`${item.prodName}: 제품정보없음`);
                }

                if (item.weights.isMismatch) {
                    existing.isMismatch = true;
                    const diff = (parseFloat(item.weights.mixed) - parseFloat(item.weights.orig)).toFixed(2);
                    existing.issueModels.push(`${item.prodName}: 무게정보다름(차이값:${diff > 0 ? '+' : ''}${diff})`);
                }
            }
        });
        exportData = Array.from(aggregated.values());
        exportData.sort((a, b) => a.transporter.localeCompare(b.transporter));
    } else {
        // 일반 결과 형식
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
        if (currentFilter === 'hold') {
            filtered = filteredResults.filter(r => holdContainerMap.has(r.cntrNo));
        } else {
            // 보류 건은 다른 모든 탭에서 배제
            filtered = filteredResults.filter(r => !holdContainerMap.has(r.cntrNo));

            if (currentFilter === 'error') {
                filtered = filtered.filter(r => getContainerStatus(comparisonResult, r.cntrNo) === 'error');
            } else if (currentFilter === 'missing') {
                filtered = filtered.filter(r => {
                    const s = getContainerStatus(comparisonResult, r.cntrNo);
                    return s === 'extra' || s === 'missing';
                });
            } else if (currentFilter === 'success') {
                filtered = filtered.filter(r => getContainerStatus(comparisonResult, r.cntrNo) === 'success');
            }
            // 'all', 'dbSearch' 등인 경우 추가 필터 없이 검색어 필터만 유지 (또는 탭 기본 필터)
        }

        // 추가 필터: '모든 모델 작업완료 컨테이너만' 체크 시 (UI와 동일하게 적용)
        if (chkFullyCompletedOnly && chkFullyCompletedOnly.checked && (currentFilter === 'success' || currentFilter === 'all')) {
            const incompleteCntrs = new Set(filtered.filter(r => {
                return r.type === '대기' || r.type === '작업중';
            }).map(r => r.cntrNo));

            filtered = filtered.filter(r => !incompleteCntrs.has(r.cntrNo));
        }
        exportData = filtered.map(r => ({
            type: r.type,
            cntrNo: r.cntrNo,
            division: r.division,
            prodType: r.prodType,
            prodName: r.prodName,
            planQty: r.qtyInfo.plan,
            loadQty: r.qtyInfo.load,
            pendingQty: r.qtyInfo.pending,
            remainQty: r.qtyInfo.remain,
            cntrSize: r.cntrType.val,
            dims: r.dims,
            carrier: r.carrierName.val,
            dest: r.destination.val,
            mixedWeight: parseFloat(r.weights.mixed) || 0,
            tags: r.tags.map(t => `[${t.text}]`).join(', '),
            detail: r.detail.replace(/<[^>]*>/g, ''), // HTML 태그 제거
            jobName: r.jobName || '',
            eta: r.eta || '',
            etd: r.etd || '',
            origRemark: r.origRemark || '',
            transporter: r.transporter // 색상 반영을 위해 추가
        }));
    }

    ws.columns = columns;

    // 헤더 스타일 정의 함수
    const applyHeaderStyle = (row) => {
        row.height = 30; // 헤더 높이 늘림
        row.eachCell({ includeEmpty: false }, (cell) => {
            cell.font = { name: 'LG Smart_Korean Regular', bold: true, color: { argb: 'FF000000' }, size: 10 };

            // 기존 파란색 배경 제거, 심플한 구조로 변경
            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFEEEEEE' } // 연한 회색으로 첫번째 사진과 유사하게
            };

            cell.alignment = { vertical: 'middle', horizontal: 'center' };
            cell.border = { // 위아래 두꺼운 선 (Image 1 스타일)
                top: { style: 'medium', color: { argb: 'FF000000' } },
                bottom: { style: 'medium', color: { argb: 'FF000000' } },
                left: { style: 'thin', color: { argb: 'FFDDDDDD' } },
                right: { style: 'thin', color: { argb: 'FFDDDDDD' } }
            };
        });
    };

    // 첫 번째 헤더 스타일 적용
    applyHeaderStyle(ws.getRow(1));

    let lastTransporter = null;

    // 데이터 추가 및 스타일 적용
    exportData.forEach((data, idx) => {
        // [변경] 반입정보 형식 재작성 (G/W 에 원본/계획 병기)
        if (currentFilter === 'entry' || currentFilter === 'entry_unclassified') {
            if (lastTransporter !== null && lastTransporter !== data.transporter) {
                const headerRow = ws.addRow({
                    carrier: '선사',
                    cntrType: '규격',
                    dest: 'F.DEST',
                    cntrNo: 'CTNR NO',
                    sealNo: 'SEAL',
                    grossWeightCombined: '합산중량',
                    origRemark: '모선항차 / 반입터미널',
                    etd: '출항일',
                    workDate: '작업일',
                    transporter: '운송사'
                });
                applyHeaderStyle(headerRow);
            }
            lastTransporter = data.transporter;

            // --- POP 무게 합산 ---
            const cntrKeyExcel = (data.cntrNo || '').trim().toUpperCase();
            const popInfoExcel = popWeightMap[cntrKeyExcel];
            const popWeightExcel = popInfoExcel ? (parseFloat(popInfoExcel.weight) || 0) : 0;
            const hasPopExcel = popWeightExcel > 0;

            if (hasPopExcel) {
                // 원본 리마크에 POP 라벨 추가
                data.origRemark = `(POP : ${popWeightExcel.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}kg) ` + (data.origRemark || '');
                // 운송사 옆에 메시지 추가
                data.transporter = `${data.transporter}\n(POP : ${popWeightExcel.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}kg 포함)`;
            }

            const choiceExcel = userSelectedWeights[cntrKeyExcel];

            if (!choiceExcel && (data.mixedWeight === null || (data.issueModels && data.issueModels.length > 0))) {
                // 제품정보없음이 포함되어 있거나 중량불일치가 있는 경우 (그리고 사용자가 중량을 선택하지 않은 경우)
                let mismatchText = (data.issueModels || []).join('\n');
                if (hasPopExcel) mismatchText += `\n+POP: ${popWeightExcel.toFixed(2)}kg`;
                data.grossWeightCombined = mismatchText;
            } else {
                const wOrig = parseFloat(data.origWeight) || 0;
                const wDown = parseFloat(data.downWeight) || 0;
                const wMixed = parseFloat(data.mixedWeight) || 0;

                let baseWeightToUse = wMixed;
                let choiceNote = "";

                if (choiceExcel === 'orig') {
                    baseWeightToUse = wOrig;
                    choiceNote = " (원본선택)";
                } else if (choiceExcel === 'down') {
                    baseWeightToUse = wDown;
                    choiceNote = " (전산선택)";
                }

                const totalWeightFinal = baseWeightToUse + popWeightExcel;

                if (hasPopExcel) {
                    data.grossWeightCombined = `${totalWeightFinal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${choiceNote}\n(기본 ${baseWeightToUse.toFixed(2)} + POP ${popWeightExcel.toFixed(2)})`;
                } else {
                    data.grossWeightCombined = `${totalWeightFinal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${choiceNote}`;
                }
            }
        }

        const row = ws.addRow(data);
        row.height = (currentFilter === 'entry' || currentFilter === 'entry_unclassified') ? 35 : 18; // G/W 멀티라인을 위해 행 높이 증가

        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            cell.font = { name: 'LG Smart_Korean Regular', size: 9 };
            cell.alignment = cell.alignment || { vertical: 'middle', horizontal: 'center', wrapText: true };
            cell.border = {
                bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } } // 얇은 가로줄
            };

            if ((currentFilter === 'entry' || currentFilter === 'entry_unclassified') && columns[colNumber - 1].key === 'grossWeightCombined') {
                cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
                // 원본/계획 둘 중 하나가 달라 불일치 발생 시 색상 칠성 등은 ExcelJS richText로 할 수 있으나 여기선 텍스트로 표기
            }
        });

        // 테두리 및 폰트 추가
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const columnKey = columns[colNumber - 1].key;
            cell.font = { name: 'LG Smart_Korean Regular', size: 10 };

            // 컨테이너 번호 색상 반영 (천마=빨강, BNI=파랑)
            if (columnKey === 'cntrNo') {
                const trans = (data.transporter || "").toString();
                if (trans.includes('천마')) {
                    cell.font = { name: 'LG Smart_Korean Regular', size: 10, bold: true, color: { argb: 'FFE74C3C' } };
                } else if (trans.includes('BNI')) {
                    cell.font = { name: 'LG Smart_Korean Regular', size: 10, bold: true, color: { argb: 'FF3498DB' } };
                }
            }

            cell.border = {
                top: { style: 'thin' },
                left: { style: 'thin' },
                bottom: { style: 'thin' },
                right: { style: 'thin' }
            };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; // 리마크, 운송사 멀티라인 반영
        });

        // 숫자 컬럼 우측 정렬 및 특수 스타일
        if (currentFilter === 'entry' || currentFilter === 'entry_unclassified') {
            const gwCell = row.getCell('grossWeightCombined');
            gwCell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };

            // F.DEST 색상 강조 (US/CA 제외 빨간색)
            const destCell = row.getCell('dest');
            if (!/^(US|CA)/i.test(String(data.dest))) {
                destCell.font = { name: 'LG Smart_Korean Regular', color: { argb: 'FFFF0000' }, bold: true, size: 10 };
            }
        } else {
            ['mixedWeight', 'planQty', 'loadQty'].forEach(key => {
                const cell = row.getCell(key);
                cell.alignment = { horizontal: 'right', vertical: 'middle' };
                cell.numFmt = '#,##0.00';
            });
            // 일반 결과 탭에서는 상세 사유가 중요하므로 wrapText: true 유지
            row.getCell('detail').alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };

            // H/Q 제품구분 색상 강조 (엑셀)
            const pt = (data.prodType || '').toUpperCase();
            if (pt === 'H' || pt === 'Q') {
                const hqColor = pt === 'H' ? 'FF7C3AED' : 'FF0D9488'; // H=보라, Q=틸
                const prodTypeCell = row.getCell('prodType');
                const prodNameCell = row.getCell('prodName');
                prodTypeCell.font = { name: 'LG Smart_Korean Regular', size: 10, bold: true, color: { argb: hqColor } };
                prodNameCell.font = { name: 'LG Smart_Korean Regular', size: 10, bold: true, color: { argb: hqColor } };
            }
        }
    });

    const buffer = await wb.xlsx.writeBuffer();
    const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const fileName = currentFilter === 'entry' ? `반입정보_${timestamp}.xlsx` : (currentFilter === 'entry_unclassified' ? `반입정보_미분류_${timestamp}.xlsx` : `비교결과_${timestamp}.xlsx`);

    if (window.electronAPI && window.electronAPI.saveExcel) {
        // 일렉트론 네이티브 저장 창 사용 (중복 이름 방지 및 경로 선택 가능)
        const res = await window.electronAPI.saveExcel(buffer, fileName);
        if (res.success) {
            console.log('✅ 파일 저장 완료:', res.filePath);
            // 저장 후 자동으로 파일을 열어줌 (사용자 편의)
            try {
                await fetch(`${API_BASE}/api/open-excel-path`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filePath: res.filePath })
                });
            } catch (e) {
                console.warn('파일 자동 열기 실패:', e);
            }
        }
    } else {
        // 브라우저 환경 대비용
        saveAs(new Blob([buffer]), fileName);
    }
});

// 초기 데이터 로드 (setActiveTab 밖으로 이동)
loadCarrierMap();
loadDynamicRules();

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
        return { html: htmlContent, count: targetData.length };
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
    if (btn) btn.onclick = () => emailSettingsModal.style.display = 'none';
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

if (btnSaveEmailConfig) {
    btnSaveEmailConfig.addEventListener('click', async () => {
        const config = {
            host: document.getElementById('emailSmtpHost').value,
            port: parseInt(document.getElementById('emailSmtpPort').value),
            secure: document.getElementById('emailSmtpSecure').checked,
            user: document.getElementById('emailSmtpUser').value,
            pass: document.getElementById('emailSmtpPass').value,
            toChunma: document.getElementById('emailChunmaTo').value,
            toBni: document.getElementById('emailBniTo').value,
            subjectChunma: document.getElementById('emailChunmaSubject').value,
            subjectBni: document.getElementById('emailBniSubject').value
        };

        try {
            const res = await fetch(`${API_BASE}/api/email/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });
            const data = await res.json();
            if (data.success) {
                alert('이메일 설정이 저장되었습니다.');
                emailSettingsModal.style.display = 'none';
            } else {
                alert('저장 실패: ' + data.message);
            }
        } catch (err) {
            alert('서버 통신 오류가 발생했습니다.');
        }
    });
}

// --- 이메일 설정 클라우드 동기화 (업로드/다운로드) ---
const btnUploadEmailConfig = document.getElementById('btnUploadEmailConfig');
if (btnUploadEmailConfig) {
    btnUploadEmailConfig.addEventListener('click', async () => {
        if (!confirm('현재 화면의 설정을 클라우드 DB에 백업하시겠습니까?\n(나중에 다른 PC에서 동일하게 불러올 수 있습니다.)')) return;

        try {
            // 먼저 설정을 서버에 저장(파일)한 후, 서버가 그 파일을 읽어서 DB에 올리도록 요청
            const resp = await fetch(`${API_BASE}/api/sync/email-config`, { method: 'POST' });
            const data = await resp.json();
            if (data.success) {
                alert('✅ 백업 성공! 이메일 설정이 클라우드 DB에 저장되었습니다.');
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
        if (!confirm('클라우드 DB에서 설정을 불러와 현재 설정을 덮어쓰시겠습니까?')) return;

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
                    alert('✅ 복구 성공! 클라우드 설정을 불러왔습니다.');
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

        // 2. 미리보기 데이터 설정 및 모달 오픈
        currentPendingEmail = {
            to: targetEmail,
            subject: subject,
            html: result.html,
            transporterName: transporterName
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

const btnSaveToDB = document.getElementById('btnSaveToDB');
if (btnSaveToDB) {
    btnSaveToDB.onclick = async () => {
        if (selectedItems.size === 0) {
            alert('저장할 항목을 선택해주세요.');
            return;
        }

        if (!confirm(`${selectedItems.size}개의 항목을 데이터베이스에 저장하시겠습니까?`)) return;

        const itemsToSave = [];
        displayData.forEach((res, i) => {
            const key = `${res.cntrNo}_${res.prodName}_${i}`;
            if (selectedItems.has(key)) itemsToSave.push(res);
        });

        try {
            btnSaveToDB.disabled = true;
            btnSaveToDB.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...';

            const resp = await fetch(`${API_BASE}/api/save-to-db`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: itemsToSave })
            });
            const resData = await resp.json();

            if (resData.success) {
                alert(`${resData.count}개의 항목이 성공적으로 저장되었습니다.`);
                selectedItems.clear();
                updateSelectionUI();
                displayResults(comparisonResult);
                updateDbGlobalStats();
            } else {
                alert('저장 실패: ' + resData.message);
            }
        } catch (err) {
            alert('서버 통신 오류: ' + err.message);
        } finally {
            btnSaveToDB.disabled = false;
            btnSaveToDB.innerHTML = '<i class="fas fa-save" style="margin-right: 4px;"></i> 선택항목 DB 저장';
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
if (btnDbExec) {
    btnDbExec.onclick = () => executeDbSearch();
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
                return `
                    <tr style="border-bottom: 1px solid #f1f5f9;">
                        <td style="padding: 10px; color: #64748b; white-space: nowrap;">${dateStr}</td>
                        <td style="padding: 10px; color: #1e293b; font-weight: 500;">${item.recipient}</td>
                        <td style="padding: 10px; color: #1e293b; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.subject || '(제목 없음)'}</td>
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
                <button onclick="window.removeFromProductSearchHistory(${index})" class="btn" style="padding: 4px 8px; font-size: 0.8rem; background: #fff1f2; color: #e11d48; border: 1px solid #fecaca; border-radius: 6px;">
                    <i class="fas fa-times"></i>
                </button>
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
