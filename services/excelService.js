const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

// 목적지 추출 공통 함수
function extractDestination(text) {
    if (!text) return "";
    // frontend(app_main.js)와 동일하게 '/' 기준으로 파싱하여 첫번째 항목 반환
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

// 제품 마스터 엑셀 파싱 함수
async function parseMasterExcel(optionalBuffer = null) {
    let masterPath = "";
    let workbook;

    const DATA_DIR = process.env.APP_DATA_PATH || path.join(__dirname, '..', 'data');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    if (optionalBuffer) {
        console.log(`🔍 [parseMasterExcel] 제공된 버퍼로 파싱을 시작합니다.`);
        workbook = XLSX.read(optionalBuffer);
    } else {
        // 1. First check if a custom master file exists in the user's AppData directory
        const customMasterPath = path.join(DATA_DIR, 'product_master.xlsx');
        const bundledMasterPath = path.join(__dirname, '..', 'master_data', 'product_master.xlsx');

        masterPath = customMasterPath;
        if (!fs.existsSync(customMasterPath)) {
            if (!fs.existsSync(bundledMasterPath)) {
                throw new Error("마스터 데이터(product_master.xlsx) 파일이 존재하지 않습니다.");
            }
            masterPath = bundledMasterPath;
            console.log(`📂 [parseMasterExcel] 기본 마스터 데이터 사용: ${bundledMasterPath}`);
        } else {
            console.log(`📂 [parseMasterExcel] 커스텀 마스터 데이터 발견: ${customMasterPath}`);
        }

        console.log(`🔍 [parseMasterExcel] 파일 읽기 시작: ${masterPath}`);
        workbook = XLSX.readFile(masterPath);
    }

    const productsJsonPath = path.join(DATA_DIR, 'products.json');

    const worksheet = workbook.Sheets[workbook.SheetNames[0]];

    // header: 1 means return array of arrays
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    const data = [];

    // Skip header (row 0)
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;

        const name = row[0]; // A: 품명
        if (name) {
            data.push({
                name: String(name).trim(),
                weight: parseFloat(row[1]) || 0,     // B: 중량
                width: parseFloat(row[2]) || 0,      // C: 가로
                depth: parseFloat(row[3]) || 0,      // D: 세로
                height: parseFloat(row[4]) || 0,     // E: 높이
                cbm: parseFloat(row[5]) || 0,        // F: CBM
                prodType: String(row[6] || "-").trim() || "-" // G: 제품구분
            });
        }
    }
    console.log(`✅ [parseMasterExcel] 파싱 완료: ${data.length}건`);

    // 2. products.json(사용자 업데이트 중량)으로 덮어쓰기 (핵심!)
    // /api/update로 저장한 중량이 다음 비교 시에도 반영되도록 함
    if (fs.existsSync(productsJsonPath)) {
        try {
            const updatedProducts = JSON.parse(fs.readFileSync(productsJsonPath, 'utf8'));
            if (Array.isArray(updatedProducts) && updatedProducts.length > 0) {
                // 업데이트된 제품명 → { weight, width, depth, height } 맵 생성
                const updateMap = new Map();
                updatedProducts.forEach(p => {
                    if (p.name) updateMap.set(String(p.name).trim().toUpperCase(), p);
                });

                let patchCount = 0;
                data.forEach((prod, idx) => {
                    const key = prod.name.toUpperCase();
                    if (updateMap.has(key)) {
                        const patch = updateMap.get(key);
                        // 중량이 업데이트된 경우에만 반영
                        if (patch.weight !== undefined && patch.weight > 0) {
                            data[idx].weight = parseFloat(patch.weight) || prod.weight;
                        }
                        if (patch.width !== undefined && patch.width > 0) data[idx].width = parseFloat(patch.width) || prod.width;
                        if (patch.depth !== undefined && patch.depth > 0) data[idx].depth = parseFloat(patch.depth) || prod.depth;
                        if (patch.height !== undefined && patch.height > 0) data[idx].height = parseFloat(patch.height) || prod.height;
                        patchCount++;
                    }
                });
                console.log(`📦 [parseMasterExcel] products.json 업데이트 반영: ${patchCount}건 / 전체 ${data.length}건`);
            }
        } catch (e) {
            console.warn('⚠️ [parseMasterExcel] products.json 읽기 실패 (무시):', e.message);
        }
    }

    return data;
}
// Excel 읽기 유틸리티 함수 (app.js 로직 이관)
async function parseOriginalExcel(fileInput, targetSheets = ["직선적당일", "법인당일", "혼적당일"], source = "original") {
    const workbook = new ExcelJS.Workbook();
    if (Buffer.isBuffer(fileInput)) {
        await workbook.xlsx.load(fileInput);
    } else {
        await workbook.xlsx.readFile(fileInput);
    }
    let parsedData = [];


    // Excel Column Index Constants (1-indexed for ExcelJS)
    const COL = {
        JOB_NAME: 1,    // 작업명 (A열)
        DEST: 5,        // 목적지 (E열)
        PROD_TYPE: 7,   // 등급 (G열)
        PROD_NAME: 9,   // 품목명 (I열)
        QTY: 10,        // 수량 (J열)
        CNTR_TYPE_FALLBACK: 12, // 규격 (L열)
        CARRIER_FALLBACK: 13,   // 선사 (M열)
        CNTR_TYPE: 14,  // N열 (규격)
        CARRIER: 15,    // O열 (선사)
        ETA: 16,        // P열 
        ETD: 17,        // Q열
        REMARK: 18,     // 비고 (R열)
        CNTR_NO: 20,    // 장비번호 (T열)
        ADJ1: 21,       // U열
        ADJ2: 22        // V열
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
        console.log(`📄 [parseOriginalExcel] 시트 발견: "${sheetName}" (대상여부: ${isTarget}, Source: ${source})`);

        if (isTarget) {
            console.log(`🔍 [parseOriginalExcel] "${sheetName}" 시트 데이터 분석 시작...`);
            let lastValidCntrNo = "";
            let lastFontColor = null;
            let lastValidJobName = "";
            let lastValidDest = "";
            let lastValidE = "";
            let lastValidN = "";
            let lastValidO = "";
            let lastValidP = "";
            let lastValidQ = "";
            let lastValidR = "";
            let dataStarted = false;
            let emptyRowCount = 0;
            let hasNewDest = false; // 새로 추가된 목적지인지 추적하는 플래그

            for (let i = 1; i <= worksheet.rowCount; i++) {
                try {
                    const row = worksheet.getRow(i);
                    if (!row || !row.values || row.values.length === 0) {
                        if (dataStarted) {
                            break; // 데이터 블록이 끝났으므로 파싱 완전 종료
                        }

                        // 사용자가 지정한 '빈 시트 판별' 로직: 1~10행까지 데이터가 전혀 없으면 빈 시트 취급
                        if (!dataStarted && i >= 10) {
                            console.log(`⚠️ [parseOriginalExcel] 시트 [${worksheet.name}] 데이터 없음 (10행까지 비어있음). 건너뜁니다.`);
                            break;
                        }
                        continue;
                    }

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
                            if (cell.text !== undefined && cell.text !== null) return String(cell.text).trim();
                            if (cell.value !== undefined && cell.value !== null) return String(cell.value).trim();
                            return "";
                        } catch (e) {
                            return "";
                        }
                    };

                    // 안정적인 컬럼 위치 기반 추출 (기본)
                    let currentJobName = safeGetText(COL.JOB_NAME);
                    let cellP = safeGetText(COL.ETA);

                    // A열(작업명) 추출 - 빈 줄이라도 A열이 있으면 우선 갱신
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
                    }

                    // P열(선적일) 추출 - 품명 체크 이전에 우선 갱신
                    if (cellP) {
                        lastValidP = cellP;
                    }

                    let cellProd = safeGetText(COL.PROD_NAME);
                    let cellDest = safeGetText(COL.DEST);
                    let cellCntrNo = safeGetText(COL.CNTR_NO);

                    // 첫 행이 헤더일 경우 건너뜀 (헤더가 아니라 실제 데이터라면 그대로 진행)
                    if (i === 1 && (cellProd === '품목명' || cellProd === '품명' || cellProd.toLowerCase().includes('product'))) {
                        continue;
                    }

                    // 데이터 시작 여부 판단: 품목명(I열)이 있으면 시작
                    if (!dataStarted) {
                        if (cellProd) {
                            dataStarted = true;
                        } else {
                            if (i >= 5) { // 3줄 -> 5줄로 완화
                                console.log(`Sheet [${worksheet.name}] is considered EMPTY (no data started by row ${i}). Skipping.`);
                                break;
                            }
                            continue; // 아직 데이터 시작 전이면 건너뜀
                        }
                    } else {
                        // 데이터가 시작된 후, 품목명(cellProd)이 비어있으면 해당 표가 끝났으므로 시트 파싱 종료 (연결된 행만 읽기)
                        if (!cellProd) {
                            break;
                        }
                    }

                    let cellE = safeGetText(COL.DEST);
                    let cellN = safeGetText(COL.CNTR_TYPE);
                    let cellO = safeGetText(COL.CARRIER);
                    let cellQ = safeGetText(COL.ETD);
                    let cellR = safeGetText(COL.REMARK);

                    let currentFontColor = null;
                    try {
                        const cellCntr = row.getCell(COL.CNTR_NO);
                        currentFontColor = cellCntr.font && cellCntr.font.color ? cellCntr.font.color.argb : null;
                    } catch (e) {
                        console.warn(`Row ${i}: Failed to get font color`);
                    }

                    // Q열, R열 데이터 추출
                    if (cellQ) lastValidQ = cellQ;
                    if (cellR) lastValidR = cellR;

                    // 작업명(A열)이 명시적으로 존재하고 이전 작업명과 다르다면, 완전히 새로운 그룹(오더) 시작
                    if (currentJobName && currentJobName !== lastValidJobName) {
                        lastValidDest = "";
                        lastValidE = "";
                        lastValidN = "";
                        lastValidO = "";
                        lastValidP = "";
                        lastValidQ = "";
                        lastValidR = "";
                        lastValidCntrNo = ""; // 이전 그룹의 컨테이너 번호도 끊어줌
                        lastFontColor = null;
                        lastValidJobName = currentJobName;
                    }

                    // 컨테이너 번호 유효성 검사 (규칙: 영어3글자 + U + 숫자7자리)
                    const isNewCntr = /^[A-Za-z]{3}U\d{7}$/i.test(cellCntrNo);

                    if (isNewCntr) {
                        // 같은 작업명 내에서도 새 컨테이너가 시작되면 해당 컨테이너의 속성들을 받기 위해 초기화
                        if (cellCntrNo !== lastValidCntrNo) {
                            lastValidDest = "";
                            lastValidE = "";
                            lastValidN = "";
                            lastValidO = "";
                            // lastValidP(선적일)는 컨테이너 교체 시 초기화 제거
                            lastValidQ = "";
                            lastValidR = "";
                        }
                        lastValidCntrNo = cellCntrNo;
                        lastFontColor = currentFontColor;
                    }

                    // 목적지 추출 및 유효성 검사 (영어+숫자 5자리)
                    const extractedDest = extractDestination(cellDest);
                    const isDestValid = /^[A-Za-z0-9]{5}$/.test(extractedDest);

                    if (isDestValid) {
                        lastValidDest = extractedDest;
                        lastValidE = cellDest;
                        // 작업명이 이미 상단에서 갱신되었으므로 여기서는 갱신할 필요 없음
                    } else {
                        // 목적지가 없거나 유효하지 않은 경우
                        // 작업명이 아예 없거나(병합된 셀) 이전과 같다면 이전 상속값 유지 (아무것도 안 함)
                        // 작업명이 다르다면 상단에서 이미 초기화되었으므로 따로 처리할 필요 없음
                    }

                    /* cellN and cellO logic moved down to resolve fallbacks */
                    if (cellP) lastValidP = cellP;
                    if (cellQ) lastValidQ = cellQ;
                    if (cellR) lastValidR = cellR;

                    let cntrNo = cellCntrNo;
                    let fontColor = currentFontColor;

                    // 컨테이너 번호가 유효하지 않거나(Wait 등) 빈 값일 경우 상속
                    if (!isNewCntr && lastValidCntrNo && cellProd) {
                        cntrNo = lastValidCntrNo;
                        fontColor = lastFontColor;
                    }

                    if (!cntrNo) continue;

                    let qty = 0;
                    try {
                        const cellQty = row.getCell(COL.QTY);
                        qty = parseInt(cellQty.value) || 0;
                    } catch (e) {
                        qty = parseInt(safeGetText(COL.QTY)) || 0;
                    }
                    if (qty <= 0) continue;

                    // 운송사 판단: 텍스트 우선(천마, BNI 등), 그 다음이 폰트 색상
                    let transporter = "미분류";
                    const cntrText = String(cellCntrNo || "").toUpperCase();
                    if (cntrText.includes("천마")) {
                        transporter = "천마(빨강)";
                    } else if (cntrText.includes("BNI")) {
                        transporter = "BNI(파랑)";
                    } else {
                        // 텍스트에 없다면 폰트 컬러로 판단 (상속된 fontColor 포함)
                        transporter = getTransporterFromColor(fontColor);
                    }

                    let adj1 = safeGetText(COL.ADJ1);
                    let adj2 = safeGetText(COL.ADJ2);

                    let rawCntrType = safeGetText(COL.CNTR_TYPE);
                    if (!rawCntrType) {
                        if (lastValidN) {
                            rawCntrType = lastValidN;
                        } else {
                            rawCntrType = safeGetText(COL.CNTR_TYPE_FALLBACK);
                        }
                    }
                    if (!rawCntrType) rawCntrType = "-";

                    let rawCarrier = safeGetText(COL.CARRIER);
                    if (!rawCarrier) {
                        if (lastValidO) {
                            rawCarrier = lastValidO;
                        } else {
                            let fallbackCarrier = safeGetText(COL.CARRIER_FALLBACK);
                            // If the fallback is purely a number, it's likely a quantity from a different column format
                            if (fallbackCarrier && !isNaN(Number(fallbackCarrier.replace(/,/g, '')))) {
                                rawCarrier = ""; // Ignore numerical fallback
                            } else {
                                rawCarrier = fallbackCarrier;
                            }
                        }
                    }
                    if (!rawCarrier) rawCarrier = "-";

                    // Update lastValid state so grouped rows inherit correctly
                    // Even if the first row relied on a fallback column
                    if (rawCntrType !== "-") lastValidN = rawCntrType;
                    if (rawCarrier !== "-") lastValidO = rawCarrier;

                    // 동적 필드를 위해 rawRow 제공 및 상속된 값 반영
                    let rawRowVals = [];
                    try {
                        rawRowVals = row.values ? [...row.values] : [];
                    } catch (e) {
                        console.warn(`Row ${i}: Failed to clone values`);
                    }

                    if (!rawRowVals[COL.DEST]) rawRowVals[COL.DEST] = lastValidE;
                    if (!rawRowVals[COL.CNTR_TYPE]) rawRowVals[COL.CNTR_TYPE] = lastValidN;
                    if (!rawRowVals[COL.CARRIER]) rawRowVals[COL.CARRIER] = lastValidO;
                    if (!rawRowVals[COL.ETA]) rawRowVals[COL.ETA] = lastValidP;
                    if (!rawRowVals[COL.ETD]) rawRowVals[COL.ETD] = lastValidQ;
                    if (!rawRowVals[COL.REMARK]) rawRowVals[COL.REMARK] = lastValidR;
                    if (!rawRowVals[COL.CNTR_NO]) rawRowVals[COL.CNTR_NO] = lastValidCntrNo;

                    parsedData.push({
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
                        adj1: adj1,
                        adj2: adj2,
                        cntrNo: cntrNo,
                        transporter: transporter,
                        source: source,
                        tags: [],
                        rawRow: rawRowVals
                    });
                } catch (rowErr) {
                    console.error(`❌ Sheet ${worksheet.name}, Row ${i} 파싱 중 오류:`, rowErr.message);
                }
            }
            console.log(`✅ [parseOriginalExcel] 시트 [${worksheet.name}] 분석 완료: ${parsedData.length}건 추출됨`);
        }
    });
    return parsedData;
}

async function parseDownloadExcel(fileInput) {
    const workbook = new ExcelJS.Workbook();
    if (Buffer.isBuffer(fileInput)) {
        await workbook.xlsx.load(fileInput);
    } else {
        await workbook.xlsx.readFile(fileInput);
    }
    let parsedData = [];
    const worksheet = workbook.worksheets[0];
    if (!worksheet) return [];

    // --- Dynamic Column Mapping for Download file ---
    const headers = worksheet.getRow(1);
    const colMap = {};
    headers.eachCell((cell, colNumber) => {
        const title = String(cell.text || "").trim().toUpperCase();
        if (title.includes("BUSINESS AREA") || title.includes("사업부")) colMap.division = colNumber;
        if (title.includes("LOADING TYPE") || title.includes("LOAD TYPE")) colMap.loadType = colNumber;
        if (title.includes("CONTAINER NO")) colMap.cntrNo = colNumber;
        if (title.includes("STATUS DESCRIPTION") || title.includes("STATUS")) colMap.status = colNumber;
        if (title.includes("OQC STATUS")) colMap.oqc = colNumber;
        if (title.includes("OQC PENDING") || title.includes("PENDING QTY")) colMap.pendingQty = colNumber;
        if (title.includes("MODEL") || title.includes("PROD NAME")) colMap.prodName = colNumber;
        if (title.includes("LOAD PLAN QTY") || title.includes("PLAN QTY")) colMap.planQty = colNumber;
        if (title.includes("LOADED QTY") || title.includes("STACKED QTY") || title.includes("LOADING QTY")) colMap.loadQty = colNumber;
        if (title.includes("VOLUME")) colMap.volume = colNumber;
        if (title.includes("WEIGHT") || title.includes("GROSS WEIGHT")) colMap.grossWeight = colNumber;
        if (title.includes("CONTAINER SIZE") || title.includes("CNTR TYPE")) colMap.cntrType = colNumber;
        if (title.includes("CARRIER CODE")) colMap.carrierCode = colNumber;
        if (title.includes("CARRIER NAME")) colMap.carrierName = colNumber;
        if (title.includes("PORT CODE")) colMap.port = colNumber;
        if (title.includes("F.DEST") || title.includes("VESSEL F.DEST") || title.includes("DESTINATION")) colMap.dest = colNumber;
        if (title.includes("INSTRUCTION NO") || title.includes("LOAD PLAN NO")) colMap.loadPlanNo = colNumber;
        if (title.includes("REMARK")) colMap.remark = colNumber;
        if (title.includes("SEAL NO")) colMap.sealNo = colNumber;
        if (title.includes("PACKING QUANTITY") || title.includes("PACK QTY")) colMap.packingQty = colNumber;
        if (title.includes("REMAIN QTY")) colMap.remainQty = colNumber;
    });

    // Fallback and Default column mapping (in case header detection fails for some columns)
    const DCOL = {
        DIVISION: colMap.division || 1, // 사업부 (A열)
        LOAD_TYPE: colMap.loadType || 2,
        CNTR_NO: colMap.cntrNo || 3,
        STATUS: colMap.status || 4,
        OQC: colMap.oqc || 6,
        PENDING_QTY: colMap.pendingQty || 7, // 팬딩적재 (G열)
        PROD_NAME: colMap.prodName || 9,
        PLAN_QTY: colMap.planQty || 10,   // 계획수량 (J열)
        LOAD_QTY: colMap.loadQty || 11,   // 적재수량 (K열)
        VOLUME: colMap.volume || 12,
        WEIGHT: colMap.grossWeight || 13,
        PACKING_QTY: colMap.packingQty || 14, // 단위 (N열 = Packing Quantity)
        REMAIN_QTY: colMap.remainQty || 16,   // 잔여수량 (P열)
        CNTR_TYPE: colMap.cntrType || 19,
        CARRIER_CODE: colMap.carrierCode || 20,
        CARRIER_NAME: colMap.carrierName || 21,
        PORT: colMap.port || 28,
        DEST: colMap.dest || 29,
        LOAD_PLAN_NO: colMap.loadPlanNo || 32,
        REMARK: colMap.remark || 40,
        SEAL_NO: colMap.sealNo || 18
    };

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
                    if (cell.text !== undefined && cell.text !== null && cell.text !== "") return String(cell.text).trim();
                    if (cell.value !== undefined && cell.value !== null) return String(cell.value).trim();
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

module.exports = {
    parseMasterExcel,
    parseOriginalExcel,
    parseDownloadExcel
};