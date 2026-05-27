// mappingManager.js

class MappingManager {
    constructor() {
        this.profiles = {};
        this.activeProfileId = 'default';
        this.standardFields = [
            // 원본 파일 (Original)
            { id: 'jobName', name: '[원본] 작업명', defaultCol: 'A' },
            { id: 'dest', name: '[원본] 목적지', defaultCol: 'E' },
            { id: 'prodType', name: '[원본] 등급(제품구분)', defaultCol: 'G' },
            { id: 'prodName', name: '[원본/전산] 품목명', defaultCol: 'I' },
            { id: 'qty', name: '[원본] 수량', defaultCol: 'J' },
            { id: 'cntrType', name: '[원본/전산] 규격(컨테이너)', defaultCol: 'N' },
            { id: 'carrier', name: '[원본] 선사', defaultCol: 'O' },
            { id: 'eta', name: '[원본] ETA', defaultCol: 'P' },
            { id: 'etd', name: '[원본] ETD', defaultCol: 'Q' },
            { id: 'remark', name: '[원본/전산] 비고', defaultCol: 'R' },
            { id: 'cntrNo', name: '[원본/전산] 컨테이너 번호', defaultCol: 'T' },
            
            // 전산 파일 (Download) - 헤더 텍스트 매핑용으로 defaultCol 대신 매핑될 텍스트 지정 가능하지만,
            // 통일성을 위해 일단 열 알파벳을 기본으로 할 수도 있음. 사용자가 A, B 등으로 덮어쓰면 그걸 우선 사용.
            { id: 'dl_division', name: '[전산] 사업부 (열)', defaultCol: 'A' },
            { id: 'dl_loadType', name: '[전산] 작업구분 (열)', defaultCol: 'B' },
            { id: 'dl_status', name: '[전산] 상태 (열)', defaultCol: 'D' },
            { id: 'dl_oqc', name: '[전산] OQC상태 (열)', defaultCol: 'F' },
            { id: 'dl_pendingQty', name: '[전산] 보류수량 (열)', defaultCol: 'G' },
            { id: 'dl_planQty', name: '[전산] 계획수량 (열)', defaultCol: 'J' },
            { id: 'dl_loadQty', name: '[전산] 적재수량 (열)', defaultCol: 'K' },
            { id: 'dl_volume', name: '[전산] CBM (열)', defaultCol: 'L' },
            { id: 'dl_weight', name: '[전산] 중량 (열)', defaultCol: 'M' },
            { id: 'dl_remainQty', name: '[전산] 잔여수량 (열)', defaultCol: 'O' },
            { id: 'dl_sealNo', name: '[전산] 씰번호 (열)', defaultCol: 'Q' },
            { id: 'dl_carrierCode', name: '[전산] 선사코드 (열)', defaultCol: 'S' },
            { id: 'dl_carrierName', name: '[전산] 선사명 (열)', defaultCol: 'T' },
            { id: 'dl_truckCode', name: '[전산] 트럭코드 (열)', defaultCol: 'W' },
            { id: 'dl_truckName', name: '[전산] 트럭명 (열)', defaultCol: 'X' },
            { id: 'dl_port', name: '[전산] 상차지 (열)', defaultCol: 'AA' },
            { id: 'dl_dest', name: '[전산] 도착지 (열)', defaultCol: 'AB' },
            { id: 'dl_loadPlanNo', name: '[전산] 작업지시번호 (열)', defaultCol: 'AE' },
            { id: 'dl_packingQty', name: '[전산] 포장수량 (열)', defaultCol: 'BM' },
        ];
        this.loadProfiles();
        this.initUI();
    }

    loadProfiles() {
        try {
            const data = localStorage.getItem('mappingProfiles');
            if (data) {
                const parsed = JSON.parse(data);
                this.profiles = parsed.profiles || {};
                this.activeProfileId = parsed.activeProfileId || 'default';
            }
        } catch (e) {
            console.error("Failed to load mapping profiles", e);
        }

        // Ensure default exists
        if (!this.profiles['default']) {
            this.profiles['default'] = {
                id: 'default',
                name: '기본 프로필 (Standard)',
                mapping: {}
            };
            this.standardFields.forEach(f => {
                this.profiles['default'].mapping[f.id] = f.defaultCol;
            });
        }
    }

    saveProfiles() {
        const dataStr = JSON.stringify({
            profiles: this.profiles,
            activeProfileId: this.activeProfileId
        }, null, 2);

        try {
            localStorage.setItem('mappingProfiles', dataStr);
        } catch (e) {
            console.error("Failed to save mapping profiles", e);
        }
    }

    getActiveMapping() {
        return this.profiles[this.activeProfileId].mapping;
    }

    initUI() {
        this.modal = document.getElementById('mappingSettingsModal');
        this.btnOpen = document.getElementById('btnOpenMappingSettings');
        this.btnClose = document.getElementById('closeMappingSettingsBtn');
        this.btnCloseBottom = document.getElementById('closeMappingSettingsBottomBtn');
        
        this.selectProfile = document.getElementById('mappingProfileSelect');
        this.btnNew = document.getElementById('btnNewMappingProfile');
        this.btnDelete = document.getElementById('btnDeleteMappingProfile');
        this.inputName = document.getElementById('mappingProfileNameInput');
        this.btnSaveName = document.getElementById('btnSaveMappingProfileName');
        this.tbodyFields = document.getElementById('mappingFieldsBody');
        this.btnSaveSettings = document.getElementById('btnSaveMappingProfileSettings');

        if (this.btnOpen) {
            this.btnOpen.addEventListener('click', () => {
                this.refreshSelect();
                this.renderFields();
                this.modal.style.display = 'block';
            });
        }

        [this.btnClose, this.btnCloseBottom].forEach(btn => {
            if (btn) btn.addEventListener('click', () => this.modal.style.display = 'none');
        });

        if (this.selectProfile) {
            this.selectProfile.addEventListener('change', (e) => {
                this.activeProfileId = e.target.value;
                this.renderFields();
                this.saveProfiles();
            });
        }

        if (this.btnNew) {
            this.btnNew.addEventListener('click', () => {
                const newId = 'profile_' + Date.now();
                this.profiles[newId] = {
                    id: newId,
                    name: '새 프로필',
                    mapping: { ...this.profiles['default'].mapping }
                };
                this.activeProfileId = newId;
                this.refreshSelect();
                this.renderFields();
                this.saveProfiles();
            });
        }

        if (this.btnDelete) {
            this.btnDelete.addEventListener('click', () => {
                if (this.activeProfileId === 'default') {
                    alert('기본 프로필은 삭제할 수 없습니다.');
                    return;
                }
                if (confirm('현재 프로필을 삭제하시겠습니까?')) {
                    delete this.profiles[this.activeProfileId];
                    this.activeProfileId = 'default';
                    this.refreshSelect();
                    this.renderFields();
                    this.saveProfiles();
                }
            });
        }

        if (this.btnSaveName) {
            this.btnSaveName.addEventListener('click', () => {
                const newName = this.inputName.value.trim();
                if (newName) {
                    this.profiles[this.activeProfileId].name = newName;
                    this.refreshSelect();
                    this.saveProfiles();
                    alert('이름이 변경되었습니다.');
                }
            });
        }

        if (this.btnSaveSettings) {
            this.btnSaveSettings.addEventListener('click', () => {
                const inputs = this.tbodyFields.querySelectorAll('.mapping-col-input');
                const newMapping = {};
                inputs.forEach(input => {
                    newMapping[input.dataset.fieldId] = input.value.trim().toUpperCase();
                });
                this.profiles[this.activeProfileId].mapping = newMapping;
                this.saveProfiles();
                alert('매핑 설정이 저장되었습니다.\n변경된 양식으로 엑셀을 업로드하면 바로 적용됩니다.');
                this.modal.style.display = 'none';
            });
        }
    }

    refreshSelect() {
        if (!this.selectProfile) return;
        this.selectProfile.innerHTML = '';
        Object.values(this.profiles).forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            if (p.id === this.activeProfileId) opt.selected = true;
            this.selectProfile.appendChild(opt);
        });
        this.inputName.value = this.profiles[this.activeProfileId].name;
    }

    renderFields() {
        if (!this.tbodyFields) return;
        this.tbodyFields.innerHTML = '';
        const currentMapping = this.profiles[this.activeProfileId].mapping;

        this.standardFields.forEach(f => {
            const tr = document.createElement('tr');
            
            const td1 = document.createElement('td');
            td1.style.padding = '10px';
            td1.style.borderBottom = '1px solid #cbd5e1';
            td1.innerHTML = `<strong>${f.name}</strong> <br><span style="font-size:0.75rem;color:#64748b;">내부 필드: ${f.id}</span>`;
            
            const td2 = document.createElement('td');
            td2.style.padding = '10px';
            td2.style.borderBottom = '1px solid #cbd5e1';
            
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'mapping-col-input';
            input.dataset.fieldId = f.id;
            input.value = currentMapping[f.id] || '';
            input.placeholder = `예: ${f.defaultCol} (또는 열 이름)`;
            input.style.width = '100%';
            input.style.padding = '0.5rem';
            input.style.borderRadius = '6px';
            input.style.border = '1px solid #cbd5e1';
            
            td2.appendChild(input);
            
            tr.appendChild(td1);
            tr.appendChild(td2);
            this.tbodyFields.appendChild(tr);
        });
    }
}

// Initialize and attach to window
document.addEventListener('DOMContentLoaded', () => {
    window.mappingManager = new MappingManager();
});
