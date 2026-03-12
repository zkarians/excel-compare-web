// --------------------------------------------------
// carrier.js - 선사(Carrier) 설정 및 맵핑 관련 로직
// --------------------------------------------------
let carrierMap = {};

async function loadCarrierMap() {
    // 1. 기본 선사 맵핑 정의 (최신 기준)
    const defaultMap = {
        "MSK": ["머스크", "MAERSK", "MSK", "한국머스크", "KR055242", "MAEU", "MSKU"],
        "HMM": ["현대", "HYUNDAI", "HMM", "현대상선", "HMMU"],
        "ONE": ["ONE", "오션", "OCEAN", "ONEU", "오션네트워크익스프레스코리아"],
        "CQN": ["CQN", "천경", "CKLINE", "CKLU"],
        "CMA": ["CMA", "CGM", "씨엠에이", "CMDU"],
        "MSC": ["MSC", "엠에스씨", "MSCU", "엠에스씨코리아"],
        "COS": ["COSCO", "COS", "코스코", "COSU"],
        "PIL": ["PIL", "피아이엘", "PCIU"],
        "YML": ["YML", "양밍", "YANGMING", "YMLU", "양밍한국"],
        "EMC": ["EVERGREEN", "EVG", "장금", "EVER", "EGLV", "EMC", "(주)에버그린코리아", "에버그린코리아", "SINOKOR", "SNKO"],
        "OOL": ["OOCL", "오오씨엘", "OOL", "(주)오오씨엘코리아", "오오씨엘코리아", "OOCU"],
        "ESL": ["ESL", "에미레이트", "EMIRATES", "에미레이트쉬핑코리아"],
        "FEO": ["FEO", "동해해운", "동해", "FESCO", "FESU"],
        "SML": ["SML", "SM", "에스엠", "SMLU"],
        "HPL": ["HPL", "HAPAG", "하팍", "HLFU"],
        "ZIM": ["ZIM", "짐라인", "ZIMU"],
        "WSL": ["협운인터네셔널", "WSL", "협운"],
        "HLC": ["하파그로이드코리아", "하팍로이드", "HLC", "HLAG"],
        "SKR": ["장금상선", "SKR", "장금", "SINOKOR", "SNKO"],
        "DYS": ["동영해운", "DYS", "동영"],
        "KMD": ["고려해운", "고려", "KMD", "KMTC"],
        "IAL": ["인터아시아", "INTERASIA", "INTER ASIA", "IAL", "IAAU"],
        "TSL": ["TSLINE", "TSL", "덕상티에스라인즈", "덕상티에스"]
    };

    try {
        // 1순위: DB에서 조회
        const response = await fetch(`${API_BASE}/api/sync/carriers`);
        if (response.ok) {
            const data = await response.json();
            if (data.success && data.mapping && Object.keys(data.mapping).length > 0) {
                carrierMap = data.mapping;
                return;
            }
        }
    } catch (err) {
        console.error("DB 선사 로딩 실패:", err);
    }

    // 2순위: DB가 비어있거나 통신 실패 시 (기존 로컬스토리지 방식 및 필수 병합)
    const savedMap = localStorage.getItem('carrierMapPrefs');
    if (savedMap) {
        carrierMap = JSON.parse(savedMap);

        // 새로운 키가 없는 경우 자동 병합
        let needsUpdate = false;
        const requiredKeys = ["EMC", "OOL", "ESL", "FEO", "DYS", "KMD", "IAL", "TSL", "SKR"];

        requiredKeys.forEach(key => {
            if (!carrierMap[key]) {
                carrierMap[key] = defaultMap[key];
                needsUpdate = true;
            }
        });

        if (needsUpdate) {
            saveCarrierMap();
        } else {
            // 수정된 내용이 없더라도 DB와 동기화 시도
            saveCarrierMap();
        }
    } else {
        carrierMap = defaultMap;
        saveCarrierMap();
    }
}

async function saveCarrierMap() {
    localStorage.setItem('carrierMapPrefs', JSON.stringify(carrierMap));
    try {
        await fetch(`${API_BASE}/api/sync/carriers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mapping: carrierMap })
        });
        if (window.updateDbGlobalStats) window.updateDbGlobalStats();
    } catch (err) {
        console.error("DB 선사 저장 실패:", err);
    }
}

function normalizeCarrier(name) {
    if (!name) return "-";
    const upperName = name.toUpperCase().trim();
    for (const [code, names] of Object.entries(carrierMap)) {
        if (upperName.includes(code) || names.some(n => upperName.includes(n.toUpperCase()))) {
            return code; // MSK, HMM 등 영문 코드 반환
        }
    }
    return name; // 매칭되는게 없으면 그대로 반환
}

function renderCarrierSettings() {
    const tbody = document.getElementById('carrierSettingsBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    for (const [code, names] of Object.entries(carrierMap)) {
        const tr = document.createElement('tr');
        const displayNames = names.join(', ');
        tr.innerHTML = `
            <td style="font-weight: 700; color: #334155;">${code}</td>
            <td style="color: #64748b; font-size: 0.85rem;">${displayNames}</td>
            <td style="text-align: center; white-space: nowrap;">
                <button class="btn btn-primary btn-edit-carrier" data-code="${code}" style="padding: 0.2rem 0.6rem; font-size: 0.75rem; border-radius: 4px; margin-right: 4px;">수정</button>
                <button class="btn btn-danger btn-delete-carrier" data-code="${code}" style="padding: 0.2rem 0.6rem; font-size: 0.75rem; border-radius: 4px;">삭제</button>
            </td>
        `;
        tbody.appendChild(tr);
    }

    // 수정 버튼 리스너
    document.querySelectorAll('.btn-edit-carrier').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const code = e.target.getAttribute('data-code');
            const names = carrierMap[code];

            document.getElementById('editOriginalCode').value = code;
            document.getElementById('inputRawCode').value = code;
            document.getElementById('inputMappedName').value = names.join(', ');

            // 버튼 전환
            document.getElementById('btnAddCarrier').style.display = 'none';
            document.getElementById('btnUpdateCarrier').style.display = 'inline-block';
            document.getElementById('btnCancelEdit').style.display = 'inline-block';

            document.getElementById('inputRawCode').focus();
        });
    });

    // 삭제 버튼 리스너
    document.querySelectorAll('.btn-delete-carrier').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const codeToDelete = e.target.getAttribute('data-code');
            if (confirm(`'${codeToDelete}' 매핑을 삭제하시겠습니까?`)) {
                delete carrierMap[codeToDelete];
                saveCarrierMap();
                renderCarrierSettings();
            }
        });
    });
}

// 수정 완료 버튼
document.getElementById('btnUpdateCarrier')?.addEventListener('click', () => {
    const originalCode = document.getElementById('editOriginalCode').value;
    const newCode = document.getElementById('inputRawCode').value.trim().toUpperCase();
    const newNamesRaw = document.getElementById('inputMappedName').value.trim();

    if (!newCode || !newNamesRaw) {
        alert("원문 코드와 바뀔 이름들을 모두 입력해주세요.");
        return;
    }

    // 이름들 분리 (쉼표 및 공백 처리)
    const newNames = newNamesRaw.split(',').map(n => n.trim()).filter(n => n !== "");

    // 원래 키와 다르면 기존 키 삭제
    if (originalCode !== newCode) {
        delete carrierMap[originalCode];
    }

    carrierMap[newCode] = newNames;

    saveCarrierMap();
    renderCarrierSettings();
    resetSettingsInput();
    alert("수정되었습니다.");
});

// 취소 버튼
document.getElementById('btnCancelEdit')?.addEventListener('click', () => {
    resetSettingsInput();
});

function resetSettingsInput() {
    const editCode = document.getElementById('editOriginalCode');
    const inputRaw = document.getElementById('inputRawCode');
    const inputMapped = document.getElementById('inputMappedName');
    const btnAdd = document.getElementById('btnAddCarrier');
    const btnUpdate = document.getElementById('btnUpdateCarrier');
    const btnCancel = document.getElementById('btnCancelEdit');

    if (editCode) editCode.value = '';
    if (inputRaw) inputRaw.value = '';
    if (inputMapped) inputMapped.value = '';
    if (btnAdd) btnAdd.style.display = 'inline-block';
    if (btnUpdate) btnUpdate.style.display = 'none';
    if (btnCancel) btnCancel.style.display = 'none';
}

// 모달 로직
const settingsModal = document.getElementById('settingsModal');
document.getElementById('btnOpenSettings')?.addEventListener('click', async () => {
    await loadCarrierMap();
    renderCarrierSettings();
    if (settingsModal) settingsModal.style.display = 'block';
});

document.querySelectorAll('.close-btn, .close-btn-bottom').forEach(btn => {
    btn.addEventListener('click', () => {
        if (settingsModal) settingsModal.style.display = 'none';
        // 창을 닫을 때 현재 데이터를 기준으로 다시 비교 실행 (데이터가 있을 때만)
        if (typeof originalData !== 'undefined' && originalData.length > 0 && typeof downloadData !== 'undefined' && downloadData.length > 0) {
            comparisonResult = compareData(originalData, downloadData);
            updateDashboard();
            displayResults(comparisonResult);
        }
    });
});

window.addEventListener('click', (event) => {
    if (event.target == settingsModal) {
        if (settingsModal) settingsModal.style.display = 'none';
        if (typeof originalData !== 'undefined' && originalData.length > 0 && typeof downloadData !== 'undefined' && downloadData.length > 0) {
            comparisonResult = compareData(originalData, downloadData);
            updateDashboard();
            displayResults(comparisonResult);
        }
    }
});

// 새로운 선사 맵핑 추가 로직
document.getElementById('btnAddCarrier')?.addEventListener('click', () => {
    const rawCode = document.getElementById('inputRawCode').value.trim().toUpperCase();
    const mappedNameRaw = document.getElementById('inputMappedName').value.trim();

    if (!rawCode || !mappedNameRaw) {
        alert("원문 코드와 표출될 이름을 모두 입력해주세요.");
        return;
    }

    const newNames = mappedNameRaw.split(',').map(n => n.trim()).filter(n => n !== "");

    // 이미 존재하는 코드인지 확인
    if (carrierMap[rawCode]) {
        alert("이미 존재하는 코드입니다. 수정 기능을 이용해주세요.");
        return;
    } else {
        // 새 코드 생성
        carrierMap[rawCode] = newNames;
    }

    saveCarrierMap();
    renderCarrierSettings();

    // 입력창 초기화
    document.getElementById('inputRawCode').value = '';
    document.getElementById('inputMappedName').value = '';
});

// --- Export ---
window.carrierMap = carrierMap;
window.loadCarrierMap = loadCarrierMap;
window.saveCarrierMap = saveCarrierMap;
window.normalizeCarrier = normalizeCarrier;
window.renderCarrierSettings = renderCarrierSettings;
window.resetSettingsInput = resetSettingsInput;