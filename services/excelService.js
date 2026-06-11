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

const excelParser = require('../js/modules/excelParser');

async function parseOriginalExcel(fileInput, targetSheets = ["직선적당일", "법인당일", "혼적당일"], source = "original") {
    return excelParser.parseOriginalExcel(fileInput, {}, targetSheets, source, {
        stopOnEmptyRow: true,
        legacyCntrDetection: true,
        includeExtraFields: false
    });
}

async function parseDownloadExcel(fileInput) {
    return excelParser.parseDownloadExcel(fileInput, {});
}

module.exports = {
    parseMasterExcel,
    parseOriginalExcel,
    parseDownloadExcel
};