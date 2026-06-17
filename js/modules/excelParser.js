// --------------------------------------------------
// excelParser.js - 공통 엑셀 파싱 모듈 (프론트엔드/백엔드 공유)
// --------------------------------------------------

let ExcelJS;
if (typeof window !== 'undefined' && window.ExcelJS) {
    ExcelJS = window.ExcelJS;
} else if (typeof require !== 'undefined') {
    try {
        ExcelJS = require('exceljs');
    } catch (e) {
        // Ignored in environments where exceljs is not installed or loaded differently
    }
}

// 목적지 추출 공통 함수
function extractDestination(text) {
    if (!text) return "";
    return text.split('/')[0].trim();
}

// 색상 기반 운송사 추출 함수
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

const _colLetterToIndex = (letters) => {
    if (!letters) return undefined;
    letters = letters.toUpperCase();
    let idx = 0;
    for (let i = 0; i < letters.length; i++) {
        idx = idx * 26 + (letters.charCodeAt(i) - 64);
    }
    return idx;
};

// Workbook 로드 헬퍼 함수
async function loadWorkbook(fileInput) {
    if (fileInput && typeof fileInput.worksheets !== 'undefined') {
        return fileInput; // 이미 Workbook 객체인 경우
    }
    const workbook = new ExcelJS.Workbook();
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(fileInput)) {
        await workbook.xlsx.load(fileInput);
    } else if (fileInput instanceof Uint8Array || fileInput instanceof ArrayBuffer) {
        await workbook.xlsx.load(new Uint8Array(fileInput));
    } else if (typeof fileInput === 'string') {
        await workbook.xlsx.readFile(fileInput);
    } else {
        await workbook.xlsx.load(fileInput);
    }
    return workbook;
}

/**
 * 원본/재작업 엑셀 파싱 공통 함수
 */
async function parseOriginalExcel(fileInput, mapping = {}, targetSheets = ["직선적당일", "법인당일", "혼적당일"], source = "original", options = {}) {
    const workbook = await loadWorkbook(fileInput);
    const parsedData = [];

    // 옵션 기본값 설정
    const stopOnEmptyRow = options.stopOnEmptyRow !== false; // 기본값 true (백엔드 기본 동작)
    const legacyCntrDetection = options.legacyCntrDetection !== false; // 기본값 true (백엔드 기본 동작)
    const includeExtraFields = options.includeExtraFields === true; // 기본값 false (백엔드 기본 동작)

    const COL = { 
        JOB_NAME: _colLetterToIndex(mapping.jobName) || 1, 
        DEST: _colLetterToIndex(mapping.dest) || 5, 
        PROD_TYPE: _colLetterToIndex(mapping.prodType) || 7, 
        PROD_NAME: _colLetterToIndex(mapping.prodName) || 9, 
        QTY: _colLetterToIndex(mapping.qty) || 10, 
        CNTR_TYPE_FALLBACK: 12, 
        CARRIER_FALLBACK: 13, 
        CNTR_TYPE: _colLetterToIndex(mapping.cntrType) || 14, 
        CARRIER: _colLetterToIndex(mapping.carrier) || 15, 
        ETA: _colLetterToIndex(mapping.eta) || 16, 
        ETD: _colLetterToIndex(mapping.etd) || 17, 
        REMARK: _colLetterToIndex(mapping.remark) || 18, 
        WORK_DATE: 19, 
        CNTR_NO: _colLetterToIndex(mapping.cntrNo) || 20, 
        ADJ1: 21, 
        ADJ2: 22 
    };

    if (source === 'rework' && workbook.worksheets.length > 1) {
        const hasReworkSheet = workbook.worksheets.some(ws => (ws.name || "").trim().includes('재작업'));
        if (!hasReworkSheet) {
            throw new Error("시트명이 재작업으로 된 시트가 없습니다.");
        }
    }

    workbook.worksheets.forEach((worksheet, sheetIndex) => {
        const sheetName = (worksheet.name || "").trim();
        const isTarget = targetSheets.some(s => s.trim().toLowerCase() === sheetName.toLowerCase()) ||
            (source === 'rework' && (sheetName.includes('재작업') || workbook.worksheets.length === 1));

        if (isTarget) {
            let lastValidCntrNo = "";
            let lastFontColor = null;
            let lastValidJobName = "";
            let lastValidWorkDate = "";
            let lastValidDest = "";
            let lastValidE = "", lastValidN = "", lastValidO = "";
            let lastValidP = "", lastValidQ = "", lastValidR = "";
            let dataStarted = false;
            let emptyRowCount = 0;
            let lastRowNumber = 0;

            for (let i = 1; i <= worksheet.rowCount; i++) {
                try {
                    const row = worksheet.getRow(i);
                    if (!row || !row.values || row.values.length === 0) {
                        if (dataStarted) {
                            if (stopOnEmptyRow) {
                                break;
                            }
                        }
                        if (!dataStarted && i >= 10) {
                            break;
                        }
                        continue;
                    }

                    if (dataStarted && lastRowNumber > 0 && (i - lastRowNumber > 1)) {
                        emptyRowCount += (i - lastRowNumber - 1);
                    }
                    lastRowNumber = i;

                    const safeGetText = (col) => {
                        const cell = row.getCell(col);
                        if (!cell) return "";
                        if (cell.value instanceof Date) {
                            const d = cell.value;
                            if (d.getFullYear() < 1900) {
                                return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
                            }
                            return `${d.getMonth() + 1}월 ${d.getDate()}일`;
                        }
                        try {
                            let txt = "";
                            try { txt = cell.text; } catch (e) { txt = ""; }
                            if (txt !== undefined && txt !== null) {
                                if (txt === "" && cell.value && typeof cell.value === 'object' && 'formula' in cell.value) {
                                    const result = cell.value.result;
                                    return (result !== undefined && result !== null) ? String(result).trim() : "";
                                }
                                return String(txt).trim();
                            }
                            if (cell.value !== undefined && cell.value !== null) {
                                if (typeof cell.value === 'object') {
                                    if ('formula' in cell.value) {
                                        const result = cell.value.result;
                                        return (result !== undefined && result !== null) ? String(result).trim() : "";
                                    } else if ('richText' in cell.value) {
                                        return cell.text || "";
                                    }
                                    return "";
                                }
                                return String(cell.value).trim();
                            }
                            return "";
                        } catch (e) {
                            return "";
                        }
                    };

                    let currentJobName = safeGetText(COL.JOB_NAME);
                    let cellP = safeGetText(COL.ETA);

                    if (currentJobName && currentJobName !== lastValidJobName) {
                        lastValidDest = "";
                        lastValidE = "";
                        lastValidN = "";
                        lastValidO = "";
                        lastValidP = "";
                        lastValidQ = "";
                        lastValidR = "";
                        lastValidCntrNo = "";
                        lastFontColor = null;
                        lastValidJobName = currentJobName;
                        lastValidWorkDate = "";
                    }

                    if (cellP) {
                        lastValidP = cellP;
                    }

                    let cellProd = safeGetText(COL.PROD_NAME);
                    let cellDest = safeGetText(COL.DEST);
                    let cellCntrNo = safeGetText(COL.CNTR_NO);
                    let cellR = safeGetText(COL.REMARK);

                    if (cellR) {
                        if (lastValidR) {
                            if (!lastValidR.includes(cellR)) {
                                lastValidR = lastValidR + " | " + cellR;
                            }
                        } else {
                            lastValidR = cellR;
                        }
                    }

                    if (i === 1 && (cellProd === '품목명' || cellProd === '품명' || cellProd.toLowerCase().includes('product'))) {
                        continue;
                    }

                    if (!dataStarted) {
                        if (cellProd) {
                            dataStarted = true;
                        } else {
                            if (i >= 5) {
                                break;
                            }
                            continue;
                        }
                    } else {
                        if (!cellProd) {
                            if (stopOnEmptyRow) {
                                break;
                            } else {
                                emptyRowCount++;
                                continue;
                            }
                        } else {
                            if (!stopOnEmptyRow && emptyRowCount > 0) {
                                emptyRowCount = 0;
                            }
                        }
                    }

                    let cellQ = safeGetText(COL.ETD);
                    let cellWorkDate = safeGetText(COL.WORK_DATE);

                    let currentFontColor = null;
                    try {
                        const cellCntr = row.getCell(COL.CNTR_NO);
                        currentFontColor = cellCntr.font && cellCntr.font.color ? cellCntr.font.color.argb : null;
                    } catch (e) { }

                    const isNewCntr = legacyCntrDetection 
                        ? /^[A-Za-z]{3}U\d{7}$/i.test(cellCntrNo)
                        : (/^[A-Za-z]{3}[A-Za-z]U?\d{7}$/i.test(cellCntrNo) || (cellCntrNo.length >= 8 && isNaN(Number(cellCntrNo))));

                    if (isNewCntr) {
                        if (cellCntrNo !== lastValidCntrNo) {
                            lastValidDest = "";
                            lastValidE = "";
                            lastValidN = "";
                            lastValidO = "";
                            lastValidQ = "";
                            lastValidR = "";
                            lastValidWorkDate = "";
                        }
                        lastValidCntrNo = cellCntrNo;
                        lastFontColor = currentFontColor;
                    }

                    const extractedDest = extractDestination(cellDest);
                    const isDestValid = /^[A-Za-z0-9]{5}$/.test(extractedDest);

                    if (isDestValid) {
                        lastValidDest = extractedDest;
                        lastValidE = cellDest;
                    }

                    // Reset 이후에 최종적으로 값을 업데이트해야 함 (기존 로직 순서 맞춤)
                    if (cellP) lastValidP = cellP;
                    if (cellQ) lastValidQ = cellQ;
                    if (cellWorkDate) lastValidWorkDate = cellWorkDate;

                    let cntrNo;
                    let fontColor = currentFontColor;
                    if (legacyCntrDetection) {
                        cntrNo = cellCntrNo;
                        if (!isNewCntr && lastValidCntrNo && cellProd) {
                            cntrNo = lastValidCntrNo;
                            fontColor = lastFontColor;
                        }
                    } else {
                        cntrNo = isNewCntr ? cellCntrNo : lastValidCntrNo;
                        fontColor = isNewCntr ? currentFontColor : lastFontColor;
                    }

                    if (!cntrNo || cntrNo.toUpperCase().includes("WAIT")) continue;

                    let qty = 0;
                    try {
                        const cellQty = row.getCell(COL.QTY);
                        if (cellQty && cellQty.master && cellQty.address !== cellQty.master.address) {
                            qty = 0;
                        } else {
                            if (legacyCntrDetection) {
                                // Legacy backend behavior
                                qty = parseInt(cellQty.value) || 0;
                            } else {
                                // New frontend behavior
                                try {
                                    qty = parseInt(cellQty.value);
                                    if (isNaN(qty) || qty === 0) throw new Error();
                                } catch (e) {
                                    qty = parseInt(safeGetText(COL.QTY)) || 0;
                                }
                            }
                        }
                    } catch (outerErr) {
                        qty = 0;
                    }
                    if (qty <= 0) continue;

                    let transporter = "미분류";
                    if (cntrNo.includes("천마")) {
                        transporter = "천마(빨강)";
                    } else if (cntrNo.includes("BNI")) {
                        transporter = "BNI(파랑)";
                    } else {
                        transporter = getTransporterFromColor(fontColor);
                    }

                    let rawCntrType = safeGetText(COL.CNTR_TYPE) || lastValidN || safeGetText(COL.CNTR_TYPE_FALLBACK) || "-";
                    let rawCarrier = safeGetText(COL.CARRIER) || lastValidO || safeGetText(COL.CARRIER_FALLBACK) || "-";
                    if (rawCarrier && !isNaN(Number(rawCarrier.replace(/,/g, '')))) rawCarrier = "-";

                    if (rawCntrType !== "-") lastValidN = rawCntrType;
                    if (rawCarrier !== "-") lastValidO = rawCarrier;

                    let adj1Color = null;
                    try { adj1Color = row.getCell(COL.ADJ1).font?.color?.argb || null; } catch (e) { }

                    let rawRowVals = [];
                    try {
                        rawRowVals = row.values ? [...row.values] : [];
                    } catch (e) { }

                    if (!rawRowVals[COL.DEST]) rawRowVals[COL.DEST] = lastValidE;
                    if (!rawRowVals[COL.CNTR_TYPE]) rawRowVals[COL.CNTR_TYPE] = lastValidN;
                    if (!rawRowVals[COL.CARRIER]) rawRowVals[COL.CARRIER] = lastValidO;
                    if (!rawRowVals[COL.ETA]) rawRowVals[COL.ETA] = lastValidP;
                    if (!rawRowVals[COL.ETD]) rawRowVals[COL.ETD] = lastValidQ;
                    if (!rawRowVals[COL.REMARK]) rawRowVals[COL.REMARK] = lastValidR;
                    if (!rawRowVals[COL.CNTR_NO]) rawRowVals[COL.CNTR_NO] = lastValidCntrNo;

                    const item = {
                        sheetName: worksheet.name,
                        jobName: lastValidJobName,
                        dest: lastValidDest || lastValidE,
                        prodType: safeGetText(COL.PROD_TYPE) || "-",
                        prodName: cellProd,
                        qty: qty,
                        cntrType: rawCntrType,
                        carrier: rawCarrier,
                        remark: lastValidR,
                        eta: lastValidP,
                        etd: safeGetText(COL.ETD) || lastValidQ,
                        adj1: safeGetText(COL.ADJ1),
                        adj2: safeGetText(COL.ADJ2),
                        cntrNo: cntrNo,
                        transporter: transporter,
                        source: source,
                        tags: [],
                        rawRow: rawRowVals
                    };

                    if (includeExtraFields) {
                        item.rowNumber = i;
                        item.adj1Color = adj1Color;
                        item.workDate = lastValidWorkDate;
                    }

                    parsedData.push(item);
                } catch (rowErr) {
                    console.error(`❌ Sheet ${worksheet.name}, Row ${i} 파싱 중 오류:`, rowErr.message);
                }
            }
        }
    });
    return parsedData;
}

/**
 * 전산 엑셀 파싱 공통 함수
 */
async function parseDownloadExcel(fileInput, mapping = {}) {
    const workbook = await loadWorkbook(fileInput);
    const parsedData = [];
    const worksheet = workbook.worksheets[0];
    if (!worksheet) return [];

    const headers = worksheet.getRow(1);
    const colMap = {};
    headers.eachCell((cell, colNumber) => {
        const rawText = String(cell.text || "").trim().toUpperCase();
        const title = rawText.replace(/[\s\._-]/g, ""); 
        
        if (title.includes("BUSINESSAREA") || title.includes("사업부")) colMap.division = colNumber;
        if (title.includes("LOADINGTYPE") || title.includes("LOADTYPE")) colMap.loadType = colNumber;
        if (title.includes("CONTAINERNO")) colMap.cntrNo = colNumber;
        if (title.includes("STATUSDESCRIPTION") || title.includes("STATUS")) colMap.status = colNumber;
        if (title.includes("OQCSTATUS")) colMap.oqc = colNumber;
        if (title.includes("OQCPENDING") || title.includes("PENDINGQTY")) colMap.pendingQty = colNumber;
        if (title === "MODEL" || title === "PRODNAME" || title === "모델") colMap.prodName = colNumber;
        if (title.includes("LOADPLANQTY") || title.includes("PLANQTY")) colMap.planQty = colNumber;
        if (title.includes("LOADEDQTY") || title.includes("STACKEDQTY") || title.includes("LOADINGQTY")) colMap.loadQty = colNumber;
        if (title.includes("VOLUME")) colMap.volume = colNumber;
        if (title.includes("WEIGHT") || title.includes("GROSSWEIGHT")) colMap.grossWeight = colNumber;
        
        if (title.includes("CONTAINERSPEC") || title.includes("CONTAINERSIZE") || title.includes("CNTRTYPE")) colMap.cntrType = colNumber;
        
        if (title === "SHIPPINGLINE" || title === "선사") {
            colMap.carrierCode = colNumber;
        } else if (title === "SHIPPINGLINENAME" || title === "선사명") {
            colMap.carrierName = colNumber;
        }
        
        if (title === "CARRIER") {
            colMap.truckCarrierCode = colNumber;
        } else if (title === "CARRIERNAME") {
            colMap.truckCarrierName = colNumber;
        }
        
        if (title.includes("PORTCODE") || title.includes("LOADINGPORT")) colMap.port = colNumber;
        if (title === "FDEST" || title === "DESTINATION" || title === "도착지") colMap.dest = colNumber;
        if (title.includes("LOADPLANNO") || title.includes("INSTRUCTIONNO")) colMap.loadPlanNo = colNumber;
        
        if (title === "LOADREMARK") {
            colMap.remark = colNumber;
        } else if (title === "REMARK" && !colMap.remark) {
            colMap.remark = colNumber;
        }
        
        if (title.includes("SEALNO")) colMap.sealNo = colNumber;
        if (title.includes("PACKINGQUANTITY") || title.includes("PACKQTY")) colMap.packingQty = colNumber;
        if (title.includes("REMAINQTY")) colMap.remainQty = colNumber;
    });

    const DCOL = {
        DIVISION: _colLetterToIndex(mapping.dl_division) || colMap.division || 1,
        LOAD_TYPE: _colLetterToIndex(mapping.dl_loadType) || colMap.loadType || 2,
        CNTR_NO: colMap.cntrNo || 3,           
        STATUS: _colLetterToIndex(mapping.dl_status) || colMap.status || 4,
        OQC: _colLetterToIndex(mapping.dl_oqc) || colMap.oqc || 6,
        PENDING_QTY: _colLetterToIndex(mapping.dl_pendingQty) || colMap.pendingQty || 7,
        PROD_NAME: colMap.prodName || 9,        
        PLAN_QTY: _colLetterToIndex(mapping.dl_planQty) || colMap.planQty || 10,
        LOAD_QTY: _colLetterToIndex(mapping.dl_loadQty) || colMap.loadQty || 11,
        VOLUME: _colLetterToIndex(mapping.dl_volume) || colMap.volume || 12,
        WEIGHT: _colLetterToIndex(mapping.dl_weight) || colMap.grossWeight || 13,
        PACKING_QTY: _colLetterToIndex(mapping.dl_packingQty) || colMap.packingQty || 65,
        REMAIN_QTY: _colLetterToIndex(mapping.dl_remainQty) || colMap.remainQty || 15,
        CNTR_TYPE: colMap.cntrType || 18,       
        CARRIER_CODE: _colLetterToIndex(mapping.dl_carrierCode) || colMap.carrierCode || 19,
        CARRIER_NAME: _colLetterToIndex(mapping.dl_carrierName) || colMap.carrierName || 20,
        TRUCK_CARRIER_CODE: _colLetterToIndex(mapping.dl_truckCode) || colMap.truckCarrierCode || 23,
        TRUCK_CARRIER_NAME: _colLetterToIndex(mapping.dl_truckName) || colMap.truckCarrierName || 24,
        PORT: _colLetterToIndex(mapping.dl_port) || colMap.port || 27,
        DEST: _colLetterToIndex(mapping.dl_dest) || colMap.dest || 28,
        LOAD_PLAN_NO: _colLetterToIndex(mapping.dl_loadPlanNo) || colMap.loadPlanNo || 31,
        REMARK: colMap.remark || 41,            
        SEAL_NO: _colLetterToIndex(mapping.dl_sealNo) || colMap.sealNo || 17
    };

    // --- 전산 파일 레이아웃 변경 감지 및 알림 (브라우저 환경전용) ---
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        const _indexToColLetter = (index) => {
            if (!index || index <= 0) return "";
            let temp = index;
            let letter = "";
            while (temp > 0) {
                let modulo = (temp - 1) % 26;
                letter = String.fromCharCode(65 + modulo) + letter;
                temp = Math.floor((temp - modulo) / 26);
            }
            return letter;
        };

        const DCOL_LABELS = {
            DIVISION: '사업부',
            LOAD_TYPE: '작업구분',
            CNTR_NO: '컨테이너 번호',
            STATUS: '상태',
            OQC: 'OQC상태',
            PENDING_QTY: '보류수량',
            PROD_NAME: '품목명',
            PLAN_QTY: '계획수량',
            LOAD_QTY: '적재수량',
            VOLUME: 'CBM',
            WEIGHT: '중량',
            PACKING_QTY: '포장수량',
            REMAIN_QTY: '잔여수량',
            CNTR_TYPE: '규격(컨테이너)',
            CARRIER_CODE: '선사코드',
            CARRIER_NAME: '선사명',
            TRUCK_CARRIER_CODE: '트럭코드',
            TRUCK_CARRIER_NAME: '트럭명',
            PORT: '상차지',
            DEST: '도착지',
            LOAD_PLAN_NO: '작업지시번호',
            REMARK: '비고',
            SEAL_NO: '씰번호'
        };

        const currentTargetMapping = {};
        for (const key in DCOL) {
            currentTargetMapping[key] = _indexToColLetter(DCOL[key]);
        }

        try {
            const prevTargetMappingStr = localStorage.getItem('lastTargetMapping');
            const prevTargetMapping = prevTargetMappingStr ? JSON.parse(prevTargetMappingStr) : null;
            
            if (prevTargetMapping) {
                const keyFieldsToNotify = ['CNTR_NO', 'PROD_NAME', 'PLAN_QTY', 'LOAD_QTY', 'WEIGHT', 'REMARK', 'SEAL_NO', 'DEST', 'CARRIER_NAME', 'CARRIER_CODE', 'TRUCK_CARRIER_NAME', 'PORT', 'CNTR_TYPE'];
                const changes = [];
                
                keyFieldsToNotify.forEach(key => {
                    const prevCol = prevTargetMapping[key];
                    const currCol = currentTargetMapping[key];
                    if (prevCol && currCol && prevCol !== currCol) {
                        changes.push(`${DCOL_LABELS[key] || key} (${prevCol}열 ➡️ ${currCol}열)`);
                    }
                });

                if (changes.length > 0) {
                    const notifyDiv = document.createElement('div');
                    notifyDiv.style.position = 'fixed';
                    notifyDiv.style.top = '24px';
                    notifyDiv.style.right = '24px';
                    notifyDiv.style.zIndex = '999999';
                    notifyDiv.style.backgroundColor = 'rgba(255, 255, 255, 0.95)';
                    notifyDiv.style.backdropFilter = 'blur(10px)';
                    notifyDiv.style.borderLeft = '5px solid #3b82f6';
                    notifyDiv.style.boxShadow = '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)';
                    notifyDiv.style.borderRadius = '8px';
                    notifyDiv.style.padding = '16px 20px';
                    notifyDiv.style.maxWidth = '400px';
                    notifyDiv.style.fontFamily = "'Pretendard', -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
                    notifyDiv.style.animation = 'slideIn 0.3s ease-out';
                    
                    notifyDiv.innerHTML = `
                        <div style="display: flex; align-items: flex-start; gap: 14px;">
                            <div style="color: #3b82f6; font-size: 1.3rem; margin-top: 2px;"><i class="fas fa-exclamation-triangle"></i></div>
                            <div style="flex: 1;">
                                <h4 style="margin: 0 0 6px 0; font-size: 0.95rem; font-weight: 700; color: #1e293b; letter-spacing: -0.3px;">전산 엑셀 열 배치 변경 감지!</h4>
                                <p style="margin: 0 0 10px 0; font-size: 0.82rem; color: #64748b; line-height: 1.4;">업로드된 전산 파일의 열 위치 변경을 자동 인식하여 정상 매핑했습니다.</p>
                                <div style="display: flex; flex-direction: column; gap: 5px; background: rgba(241, 245, 249, 0.8); padding: 8px 12px; border-radius: 6px; border: 1px solid #e2e8f0; font-size: 0.78rem; color: #334155; font-weight: 600;">
                                    ${changes.map(c => `<div><i class="fas fa-check" style="color: #10b981; margin-right: 4px;"></i> ${c}</div>`).join('')}
                                </div>
                            </div>
                            <button onclick="this.parentElement.parentElement.remove()" style="background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 1rem; padding: 0 2px;"><i class="fas fa-times"></i></button>
                        </div>
                    `;
                    document.body.appendChild(notifyDiv);
                    
                    if (!document.getElementById('notify-keyframe-style')) {
                        const style = document.createElement('style');
                        style.id = 'notify-keyframe-style';
                        style.innerHTML = `
                            @keyframes slideIn {
                                from { transform: translateX(120%); opacity: 0; }
                                to { transform: translateX(0); opacity: 1; }
                            }
                        `;
                        document.head.appendChild(style);
                    }
                    
                    setTimeout(() => {
                        notifyDiv.style.transition = 'opacity 0.5s ease-out, transform 0.5s ease-out';
                        notifyDiv.style.opacity = '0';
                        notifyDiv.style.transform = 'translateX(20px)';
                        setTimeout(() => notifyDiv.remove(), 500);
                    }, 8000);
                }
            }
            localStorage.setItem('lastTargetMapping', JSON.stringify(currentTargetMapping));
        } catch (e) {
            console.error("Target mapping verification failed", e);
        }
    }

    worksheet.eachRow((row, rowNumber) => {
        try {
            if (rowNumber <= 1) return;
            if (!row || !row.values || row.values.length === 0) return;

            const safeGetText = (col) => {
                const cell = row.getCell(col);
                if (!cell) return "";
                if (cell.value instanceof Date) {
                    const d = cell.value;
                    if (d.getFullYear() < 1900) {
                        return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
                    }
                    return `${d.getMonth() + 1}월 ${d.getDate()}일`;
                }
                try {
                    let txt = "";
                    try { txt = cell.text; } catch (e) { txt = ""; }
                    if (txt !== undefined && txt !== null) {
                        if (txt === "" && cell.value && typeof cell.value === 'object' && 'formula' in cell.value) {
                            const result = cell.value.result;
                            return (result !== undefined && result !== null) ? String(result).trim() : "";
                        }
                        return String(txt).trim();
                    }
                    if (cell.value !== undefined && cell.value !== null) {
                        if (typeof cell.value === 'object') {
                            if ('formula' in cell.value) {
                                const result = cell.value.result;
                                return (result !== undefined && result !== null) ? String(result).trim() : "";
                            } else if ('richText' in cell.value) {
                                return cell.text || "";
                            }
                            return "";
                        }
                        return String(cell.value).trim();
                    }
                    return "";
                } catch (e) {
                    return "";
                }
            };

            let cntrNo = safeGetText(DCOL.CNTR_NO);
            if (!cntrNo) return;

            parsedData.push({
                cntrNo: cntrNo,
                division: safeGetText(DCOL.DIVISION),
                loadType: safeGetText(DCOL.LOAD_TYPE),
                status: safeGetText(DCOL.STATUS),
                oqc: safeGetText(DCOL.OQC),
                pendingQty: Number(row.getCell(DCOL.PENDING_QTY).value) || 0,
                prodName: safeGetText(DCOL.PROD_NAME),
                planQty: Number(row.getCell(DCOL.PLAN_QTY).value) || 0,
                loadQty: Number(row.getCell(DCOL.LOAD_QTY).value) || 0,
                remainQty: Number(row.getCell(DCOL.REMAIN_QTY).value) || 0,
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
        } catch (rowErr) {
            console.error(`❌ Download Sheet, Row ${rowNumber} 파싱 중 오류:`, rowErr.message);
        }
    });
    return parsedData;
}

// 브라우저에서 사용할 수 있도록 노출
if (typeof window !== 'undefined') {
    window.excelParser = {
        parseOriginalExcel,
        parseDownloadExcel,
        extractDestination,
        getTransporterFromColor
    };
}
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports = {
        parseOriginalExcel,
        parseDownloadExcel,
        extractDestination,
        getTransporterFromColor
    };
}
