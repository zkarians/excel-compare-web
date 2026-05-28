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

        // Ensure default mapping exists synchronously to prevent race conditions during load
        this.profiles['default'] = {
            id: 'default',
            name: '기본 프로필 (Standard)',
            mapping: {}
        };
        this.standardFields.forEach(f => {
            this.profiles['default'].mapping[f.id] = f.defaultCol;
        });

        this.init();
    }

    async init() {
        await this.loadProfiles();
        this.initUI();
    }

    async loadProfiles() {
        try {
            const resp = await fetch('/api/mappings');
            const data = await resp.json();
            if (data.success && data.profiles && Object.keys(data.profiles).length > 0) {
                this.profiles = data.profiles;
                this.activeProfileId = data.activeProfileId || 'default';
            }
        } catch (e) {
            console.error("Failed to load mapping profiles from server", e);
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

    async saveProfiles() {
        const dataObj = {
            profiles: this.profiles,
            activeProfileId: this.activeProfileId
        };

        try {
            await fetch('/api/mappings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(dataObj)
            });
        } catch (e) {
            console.error("Failed to save mapping profiles to server", e);
        }
    }

    getActiveMapping() {
        if (!this.profiles || !this.activeProfileId || !this.profiles[this.activeProfileId]) {
            if (this.profiles && this.profiles['default']) {
                return this.profiles['default'].mapping || {};
            }
            return {};
        }
        return this.profiles[this.activeProfileId].mapping || {};
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
                const inputs = this.modal.querySelectorAll('.mapping-col-input');
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
        const containerOrig = document.getElementById('mappingFieldsOriginal');
        const containerDown = document.getElementById('mappingFieldsDownload');
        if (!containerOrig || !containerDown) return;

        containerOrig.innerHTML = '';
        containerDown.innerHTML = '';
        
        const currentMapping = this.profiles[this.activeProfileId].mapping;

        this.standardFields.forEach(f => {
            // Determine if original or download field
            // "[원본]" or "[원본/전산]" fields go to Original, "[전산]" fields go to Download
            const isOrig = f.name.includes('[원본]');
            
            const card = document.createElement('div');
            card.className = 'mapping-card';
            card.style.display = 'flex';
            card.style.alignItems = 'center';
            card.style.justifyContent = 'space-between';
            card.style.padding = '6px 10px';
            card.style.background = 'white';
            card.style.border = '1px solid #e2e8f0';
            card.style.borderRadius = '6px';
            card.style.boxShadow = '0 1px 2px rgba(0,0,0,0.02)';
            card.style.gap = '10px';
            card.style.transition = 'all 0.15s ease';
            
            // Hover styling
            card.addEventListener('mouseenter', () => {
                card.style.borderColor = isOrig ? '#bfdbfe' : '#e9d5ff';
                card.style.background = isOrig ? '#f0f7ff' : '#faf5ff';
                card.style.transform = 'translateY(-1px)';
                card.style.boxShadow = '0 3px 6px rgba(0,0,0,0.04)';
            });
            card.addEventListener('mouseleave', () => {
                card.style.borderColor = '#e2e8f0';
                card.style.background = 'white';
                card.style.transform = 'none';
                card.style.boxShadow = '0 1px 2px rgba(0,0,0,0.02)';
            });

            // Clean display name (remove brackets like [원본], [전산], [원본/전산])
            const cleanName = f.name.replace(/\[(원본|전산|원본\/전산)\]\s*/g, '');
            
            const infoDiv = document.createElement('div');
            infoDiv.style.display = 'flex';
            infoDiv.style.flexDirection = 'column';
            infoDiv.style.flex = '1';
            infoDiv.style.minWidth = '0';
            
            const nameSpan = document.createElement('span');
            nameSpan.style.fontWeight = '600';
            nameSpan.style.fontSize = '0.82rem';
            nameSpan.style.color = '#1e293b';
            nameSpan.style.whiteSpace = 'nowrap';
            nameSpan.style.overflow = 'hidden';
            nameSpan.style.textOverflow = 'ellipsis';
            nameSpan.textContent = cleanName;
            nameSpan.title = f.name;
            
            const idSpan = document.createElement('span');
            idSpan.style.fontSize = '0.68rem';
            idSpan.style.color = '#94a3b8';
            idSpan.style.fontFamily = 'monospace';
            idSpan.textContent = f.id;
            
            infoDiv.appendChild(nameSpan);
            infoDiv.appendChild(idSpan);
            
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'mapping-col-input';
            input.dataset.fieldId = f.id;
            input.value = currentMapping[f.id] || '';
            input.placeholder = `예: ${f.defaultCol}`;
            input.style.width = '90px';
            input.style.padding = '4px 8px';
            input.style.borderRadius = '5px';
            input.style.border = '1px solid #cbd5e1';
            input.style.fontSize = '0.82rem';
            input.style.fontWeight = 'bold';
            input.style.textAlign = 'center';
            input.style.textTransform = 'uppercase';
            input.style.transition = 'all 0.15s ease';
            
            // Input focus styles
            input.addEventListener('focus', () => {
                input.style.outline = 'none';
                input.style.borderColor = isOrig ? '#3b82f6' : '#8b5cf6';
                input.style.boxShadow = isOrig ? '0 0 0 3px rgba(59, 130, 246, 0.15)' : '0 0 0 3px rgba(139, 92, 246, 0.15)';
            });
            input.addEventListener('blur', () => {
                input.style.borderColor = '#cbd5e1';
                input.style.boxShadow = 'none';
            });
            
            card.appendChild(infoDiv);
            card.appendChild(input);
            
            if (isOrig) {
                containerOrig.appendChild(card);
            } else {
                containerDown.appendChild(card);
            }
        });
    }
}

// Initialize and attach to window
document.addEventListener('DOMContentLoaded', () => {
    window.mappingManager = new MappingManager();
});
