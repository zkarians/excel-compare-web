const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
// pg re-integrated with safe error handling
let pool = null;
try {
    const { Pool } = require('pg');
    const dbConfig = {
        user: process.env.PGUSER || 'root',
        host: process.env.PGHOST || 'svc.sel3.cloudtype.app',
        database: process.env.PGDATABASE || 'excel_compare',
        password: process.env.PGPASSWORD || 'z456qwe12!@',
        port: Number(process.env.PGPORT) || 30554,
        ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 15000,
        idleTimeoutMillis: 30000,
        max: 5
    };
    pool = new Pool(dbConfig);

    // Pool 에러 핸들러 추가 (비정상 종료 방지)
    pool.on('error', (err, client) => {
        console.error('❌ [DB] Unexpected error on idle client:', err);
    });

    console.log("🐘 [DB] pg 모듈 로드 및 Pool 설정 완료 (Timeout 15s)");
} catch (e) {
    console.warn("⚠️ [DB] pg 모듈을 찾을 수 없거나 DB 설정 오류: DB 기능을 사용할 수 없습니다.");
}

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

// Electron Writable Data Path - Web Server friendly fallback
const DATA_DIR = process.env.APP_DATA_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const RULES_FILE = path.join(DATA_DIR, 'rules.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const POP_WEIGHTS_FILE = path.join(DATA_DIR, 'pop_weights.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Middleware
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || origin === 'null' || origin.includes('localhost') || origin.includes('file://')) {
            callback(null, true);
        } else {
            callback(new Error('CORS policy violation'));
        }
    },
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health Check API
app.get('/api/health', (req, res) => {
    res.json({ success: true, status: 'ok', time: new Date().toISOString() });
});

// DB 연결 상태 확인 API
app.get('/api/db-status', async (req, res) => {
    if (!pool) {
        return res.json({ success: false, message: 'DB 클라이언트 초기화 실패' });
    }
    try {
        const client = await pool.connect();
        client.release();
        res.json({ success: true, message: 'DB 연결 성공' });
    } catch (err) {
        res.json({ success: false, message: 'DB 연결 실패: ' + err.message });
    }
});


// POST 기능 진단용 엔드포인트
app.post('/api/debug-test', (req, res) => {
    res.json({ success: true, message: 'POST 요청 성공', received: req.body });
});

// --- API Routes (Before Static Files) ---

const { parseMasterExcel, parseOriginalExcel, parseDownloadExcel } = require('./services/excelService');

// 제품 마스터 데이터 가져오기 API
app.get('/api/master-data', async (req, res) => {
    try {
        const data = await parseMasterExcel();
        res.json({ success: true, masterData: data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 파일 읽기 전용 엔드포인트
app.post('/api/read-excel', async (req, res) => {
    const { origPath, downPath, reworkPath } = req.body;

    try {
        console.log(`📂 [API] 파일 읽기 요청: \n - 원본: ${origPath} \n - 전산: ${downPath} \n - 재작업: ${reworkPath || "없음"}`);

        let originalData = await parseOriginalExcel(origPath);
        console.log(`✅ [API] 원본 데이터 파싱 완료: ${originalData.length}건`);

        // 재작업 파일이 있으면 추가 파싱하여 합침
        if (reworkPath && reworkPath.trim() !== "") {
            console.log(`🔍 [API] 재작업 경로 처리 시도: "${reworkPath}"`);
            if (fs.existsSync(reworkPath)) {
                console.log(`📂 [API] 재작업 파일 실존 확인됨. 파싱 시작...`);
                const reworkData = await parseOriginalExcel(reworkPath, ["재작업당일"], "rework");
                console.log(`✅ [API] 재작업 데이터 파싱 완료: ${reworkData.length}건`);
                originalData = originalData.concat(reworkData);
            } else {
                console.error(`❌ [API] 재작업 파일 경로를 찾을 수 없음: "${reworkPath}"`);
            }
        } else {
            console.log(`ℹ️ [API] 재작업 경로가 입력되지 않았습니다.`);
        }

        originalData = originalData.filter(item => item.qty > 0);

        const downloadData = await parseDownloadExcel(downPath);

        // 경로로 읽었을 때도 서버 uploads 폴더에 백업
        try {
            fs.copyFileSync(origPath, path.join(UPLOADS_DIR, 'latest_original.xlsx'));
            fs.copyFileSync(downPath, path.join(UPLOADS_DIR, 'latest_download.xlsx'));
            if (reworkPath && fs.existsSync(reworkPath)) {
                fs.copyFileSync(reworkPath, path.join(UPLOADS_DIR, 'latest_rework.xlsx'));
            }
        } catch (copyErr) {
            console.warn("⚠️ [경로읽기] 최신 파일 백업 실패:", copyErr.message);
        }

        res.json({ success: true, originalData, downloadData });
    } catch (err) {
        console.error("❌ 파일 읽기 오류:", err);
        res.status(500).json({ success: false, message: `파일을 읽을 수 없습니다: ${err.message}` });
    }
});

// 파일 업로드 기반 읽기 엔드포인트
app.post('/api/upload-excel', upload.fields([{ name: 'originalFile' }, { name: 'downloadFile' }, { name: 'reworkFile' }]), async (req, res) => {
    try {
        console.log(`📂 [API] 파일 업로드 파싱 요청`);

        if (!req.files && !fs.existsSync(path.join(UPLOADS_DIR, 'latest_original.xlsx'))) {
            return res.status(400).json({ success: false, message: '업로드된 파일이 전혀 없습니다.' });
        }

        let originalData = [];
        let downloadData = [];

        // 1. 원본 파일 로직 (업로드된 게 있으면 쓰고, 없으면 기존 캐시 파일 사용)
        if (req.files && req.files.originalFile) {
            const originalFileBuffer = req.files.originalFile[0].buffer;
            fs.writeFileSync(path.join(UPLOADS_DIR, 'latest_original.xlsx'), originalFileBuffer);
            originalData = await parseOriginalExcel(originalFileBuffer);
        } else if (fs.existsSync(path.join(UPLOADS_DIR, 'latest_original.xlsx'))) {
            originalData = await parseOriginalExcel(path.join(UPLOADS_DIR, 'latest_original.xlsx'));
        } else {
            return res.status(400).json({ success: false, message: '원본 파일이 누락되었습니다.' });
        }

        // 재작업 파일 업로드되었으면 파싱하여 합침
        if (req.files && req.files.reworkFile) {
            const reworkFileBuffer = req.files.reworkFile[0].buffer;
            fs.writeFileSync(path.join(UPLOADS_DIR, 'latest_rework.xlsx'), reworkFileBuffer);
            const reworkData = await parseOriginalExcel(reworkFileBuffer, ["재작업당일"], "rework");
            originalData = originalData.concat(reworkData);
        }

        originalData = originalData.filter(item => item.qty > 0);

        // 2. 전산(다운로드) 파일 로직
        if (req.files && req.files.downloadFile) {
            const downloadFileBuffer = req.files.downloadFile[0].buffer;
            fs.writeFileSync(path.join(UPLOADS_DIR, 'latest_download.xlsx'), downloadFileBuffer);
            downloadData = await parseDownloadExcel(downloadFileBuffer);
        } else if (fs.existsSync(path.join(UPLOADS_DIR, 'latest_download.xlsx'))) {
            downloadData = await parseDownloadExcel(path.join(UPLOADS_DIR, 'latest_download.xlsx'));
        } else {
            return res.status(400).json({ success: false, message: '전산 파일이 누락되었습니다.' });
        }

        res.json({ success: true, originalData, downloadData });
    } catch (err) {
        console.error("❌ 파일 업로드 오류:", err);
        res.status(500).json({ success: false, message: `파일을 업로드하고 파싱하는 중 오류가 발생했습니다: ${err.message}` });
    }
});

// 마지막 파일 불러오기 (서버 uploads 폴더에 백업된 파일)
app.get('/api/load-latest', async (req, res) => {
    try {
        const type = req.query.type;
        const filePath = type === 'original'
            ? path.join(UPLOADS_DIR, 'latest_original.xlsx')
            : path.join(UPLOADS_DIR, 'latest_download.xlsx');

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: "저장된 최신 파일이 없습니다." });
        }

        let data;
        if (type === 'original') {
            data = await parseOriginalExcel(filePath);
            data = data.filter(item => item.qty > 0);
        } else {
            data = await parseDownloadExcel(filePath);
        }

        res.json({ success: true, data });
    } catch (err) {
        console.error(`❌ 최근 ${req.query.type} 파일 로드 오류:`, err);
        res.status(500).json({ success: false, message: `파일 로드 중 오류 발생: ${err.message}` });
    }
});

// 지정된 경로의 파일을 raw buffer(base64)로 반환 (브라우저에서 readExcelFile로 직접 파싱하기 위해)
app.get('/api/load-file-raw', async (req, res) => {
    try {
        const filePath = req.query.path;

        if (!filePath) {
            return res.status(400).json({ success: false, message: "파일 경로가 지정되지 않았습니다." });
        }

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: `파일을 찾을 수 없습니다: ${filePath}` });
        }

        const fileBuffer = fs.readFileSync(filePath);
        const base64 = fileBuffer.toString('base64');
        const fileName = path.basename(filePath);

        console.log(`📂 [API] Raw 파일 로드: ${filePath} (${(fileBuffer.length / 1024).toFixed(1)}KB)`);
        res.json({ success: true, base64, fileName });
    } catch (err) {
        console.error(`❌ Raw 파일 로드 오류:`, err);
        res.status(500).json({ success: false, message: `파일 로드 중 오류 발생: ${err.message}` });
    }
});

// 특정 폴더에서 가장 최신 엑셀 파일(EXPORT_...) 찾아서 전산용으로 자동 로드
app.get('/api/load-latest-from-dir', async (req, res) => {
    try {
        const dirPath = req.query.dirPath;
        if (!dirPath || !fs.existsSync(dirPath)) {
            return res.status(404).json({ success: false, message: "입력된 폴더 경로를 찾을 수 없습니다." });
        }

        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.xlsx') && !f.startsWith('~'));
        if (files.length === 0) {
            return res.status(404).json({ success: false, message: "해당 폴더에 엑셀 파일이 없습니다." });
        }

        // 가장 최근에 수정된 파일 찾기
        let latestFile = null;
        let latestTime = 0;

        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = fs.statSync(filePath);
            if (stats.mtimeMs > latestTime) {
                latestTime = stats.mtimeMs;
                latestFile = {
                    name: file,
                    path: filePath
                };
            }
        }

        if (!latestFile) {
            return res.status(404).json({ success: false, message: "최신 파일을 찾을 수 없습니다." });
        }

        console.log(`📂 [API] 폴더에서 자동 로드: ${latestFile.path}`);

        // raw buffer로 반환 (브라우저에서 readExcelFile로 직접 파싱하기 위해)
        const fileBuffer = fs.readFileSync(latestFile.path);
        const base64 = fileBuffer.toString('base64');

        res.json({
            success: true,
            base64,
            fileName: latestFile.name,
            fullPath: latestFile.path
        });

    } catch (err) {
        console.error("❌ 폴더 자동 로드 오류:", err);
        res.status(500).json({ success: false, message: `폴더에서 파일을 찾는 중 오류 발생: ${err.message}` });
    }
});

// 결과 엑셀 파일 임시 저장 후 자동으로 열기
app.post('/api/open-excel', async (req, res) => {
    try {
        const { buffer, fileName } = req.body;
        if (!buffer) {
            return res.status(400).json({ success: false, message: "파일 데이터가 없습니다." });
        }

        const filePath = path.join(UPLOADS_DIR, `auto_open_${fileName}`);
        const fileBuffer = Buffer.from(buffer, 'base64');

        fs.writeFileSync(filePath, fileBuffer);
        console.log(`📂 [API] 자동 열기용 임시 파일 저장: ${filePath}`);

        // 시스템 기본 프로그램으로 파일 열기 (Windows: start, Mac: open, Linux: xdg-open)
        const command = process.platform === 'win32' ? `start "" "${filePath}"` :
            process.platform === 'darwin' ? `open "${filePath}"` :
                `xdg-open "${filePath}"`;

        exec(command, (err) => {
            if (err) {
                console.error("❌ 파일 자동 열기 실패:", err);
                // 파일 열기 실패는 사용자에게 큰 장애는 아니므로 성공 응답은 보냄
            }
        });

        res.json({ success: true, message: "파일이 생성되었고 열기 명령을 전달했습니다." });
    } catch (err) {
        console.error("❌ 자동 열기 API 오류:", err);
        res.status(500).json({ success: false, message: `파일 자동 열기 중 오류 발생: ${err.message}` });
    }
});

// 파일 경로로 직접 열기 API
app.post('/api/open-excel-path', async (req, res) => {
    try {
        const { filePath } = req.body;
        if (!filePath) {
            return res.status(400).json({ success: false, message: "파일 경로가 없습니다." });
        }

        console.log(`📂 [API] 파일 경로 열기 요청: ${filePath}`);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: "파일이 존재하지 않습니다." });
        }

        const command = process.platform === 'win32' ? `start "" "${filePath}"` :
            process.platform === 'darwin' ? `open "${filePath}"` :
                `xdg-open "${filePath}"`;

        exec(command, (err) => {
            if (err) console.error("❌ 파일 열기 실패:", err);
        });

        res.json({ success: true, message: "파일 열기 명령을 전달했습니다." });
    } catch (err) {
        console.error("❌ 파일 경로 열기 오류:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 마스터 데이터 직접 업로드 API
app.post('/api/upload-master', upload.single('masterFile'), async (req, res) => {
    try {
        console.log(`📂 [API] 마스터 데이터 업데이트 요청`);
        if (!req.file) {
            return res.status(400).json({ success: false, message: '마스터 파일이 누락되었습니다.' });
        }

        // Save the uploaded master file into the AppData folder for persistence
        const MASTER_DATA_FILE = path.join(DATA_DIR, 'product_master.xlsx');
        fs.writeFileSync(MASTER_DATA_FILE, req.file.buffer);
        console.log(`✅ [API] 마스터 엑셀. 저장 완료: ${MASTER_DATA_FILE}`);

        // Automatically reload the data from the newly saved file
        const data = await parseMasterExcel();

        res.json({ success: true, message: '마스터 데이터가 성공적으로 업데이트되었습니다.', masterData: data });
    } catch (err) {
        console.error("❌ 마스터 업로드 오류:", err);
        res.status(500).json({ success: false, message: `마스터 파일을 업로드하는 중 오류가 발생했습니다: ${err.message}` });
    }
});

// 규칙 로드 API
app.get('/api/rules', (req, res) => {
    try {
        if (!fs.existsSync(RULES_FILE)) {
            return res.json({ success: true, rules: [] });
        }
        const data = fs.readFileSync(RULES_FILE, 'utf8');
        try {
            const parsed = JSON.parse(data);
            // If the saved data is { rules: [...] }, return the array
            const rules = Array.isArray(parsed) ? parsed : (parsed.rules || []);
            res.json({ success: true, rules });
        } catch (e) {
            res.json({ success: true, rules: [] });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "규칙을 불러올 수 없습니다." });
    }
});

// 규칙 저장 API
app.post('/api/rules', (req, res) => {
    try {
        const rules = req.body.rules || req.body;
        fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf8');
        res.json({ success: true, message: "규칙이 성공적으로 저장되었습니다." });
    } catch (err) {
        res.status(500).json({ success: false, message: "규칙 저장에 실패했습니다." });
    }
});

// --- Cloud Sync API (Rules & Carriers) ---

// 1. 선사 매핑 클라우드 동기화
app.get('/api/sync/carriers', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false, message: "DB 모듈이 없습니다." });
    try {
        const result = await pool.query('SELECT code, names FROM carrier_mappings ORDER BY code ASC');
        const mapping = {};
        result.rows.forEach(row => {
            mapping[row.code] = row.names;
        });
        res.json({ success: true, mapping });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/sync/carriers', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false, message: "DB 모듈이 없습니다." });
    const { mapping } = req.body;
    if (!mapping) return res.status(400).json({ success: false, message: "데이터가 없습니다." });

    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // 기존 데이터 삭제 (또는 병합 로직 선택 - 여기서는 덮어쓰기 방식으로 처리)
            await client.query('DELETE FROM carrier_mappings');
            for (const [code, names] of Object.entries(mapping)) {
                await client.query(
                    'INSERT INTO carrier_mappings (code, names) VALUES ($1, $2)',
                    [code, JSON.stringify(names)]
                );
            }
            await client.query('COMMIT');
            res.json({ success: true, message: "선사 매핑이 클라우드에 업로드되었습니다." });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. 자동분류 규칙 클라우드 동기화
app.get('/api/sync/rules', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false, message: "DB 모듈이 없습니다." });
    try {
        const result = await pool.query('SELECT * FROM auto_classify_rules ORDER BY updated_at DESC');
        const rules = result.rows.map(row => ({
            id: row.id,
            isActive: row.is_active,
            groupName: row.group_name,
            conditionOperator: row.condition_operator,
            conditions: row.conditions,
            targetField: row.target_field,
            targetValue: row.target_value,
            tagColor: row.tag_color
        }));
        res.json({ success: true, rules });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/sync/rules', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false, message: "DB 모듈이 없습니다." });
    const { rules } = req.body;
    if (!rules || !Array.isArray(rules)) return res.status(400).json({ success: false, message: "데이터가 올바르지 않습니다." });

    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM auto_classify_rules');
            for (const rule of rules) {
                await client.query(`
                    INSERT INTO auto_classify_rules 
                    (id, is_active, group_name, condition_operator, conditions, target_field, target_value, tag_color)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `, [
                    rule.id, rule.isActive, rule.groupName, rule.conditionOperator,
                    JSON.stringify(rule.conditions), rule.targetField, rule.targetValue, rule.tagColor
                ]);
            }
            await client.query('COMMIT');
            res.json({ success: true, message: "자동분류 규칙이 클라우드에 업로드되었습니다." });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. 제품 마스터 클라우드 동기화
app.get('/api/sync/product-master', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false, message: "DB 모듈이 없습니다." });
    try {
        const result = await pool.query('SELECT prod_name as name, prod_type as type, weight, width, depth, height FROM product_master_sync ORDER BY prod_name ASC');
        res.json({ success: true, masterData: result.rows });
    } catch (err) {
        console.error("❌ 제품 마스터 다운로드 오류:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});
app.post('/api/sync/product-master', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false, message: "DB 모듈이 없습니다." });
    const { masterData } = req.body;
    if (!masterData || !Array.isArray(masterData)) return res.status(400).json({ success: false, message: "데이터가 올바르지 않습니다." });

    // 클라이언트로부터 온 데이터 중복 제거 (prod_name 기준)
    const uniqueMap = new Map();
    masterData.forEach(item => {
        if (item.name && item.name.trim() !== "") {
            uniqueMap.set(item.name.trim(), item);
        }
    });
    const finalData = Array.from(uniqueMap.values());
    console.log(`📡 [Sync] 제품 마스터 동기화 시작 (원본: ${masterData.length}건, 중복제거 후: ${finalData.length}건)`);

    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM product_master_sync');

            // 성능 개선: 일일이 INSERT 하는 대신 1,000건씩 묶어서 배치 삽입
            const BATCH_SIZE = 1000;
            for (let i = 0; i < finalData.length; i += BATCH_SIZE) {
                const batch = finalData.slice(i, i + BATCH_SIZE);
                const values = [];
                const placeholders = [];

                batch.forEach((item, index) => {
                    const offset = index * 6;
                    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`);
                    values.push(
                        item.name.trim(),
                        item.type || '',
                        item.weight || 0,
                        item.width || 0,
                        item.depth || 0,
                        item.height || 0
                    );
                });

                const query = `
                    INSERT INTO product_master_sync
                    (prod_name, prod_type, weight, width, depth, height)
                    VALUES ${placeholders.join(', ')}
                    ON CONFLICT (prod_name) DO UPDATE SET
                        prod_type = EXCLUDED.prod_type,
                        weight = EXCLUDED.weight,
                        width = EXCLUDED.width,
                        depth = EXCLUDED.depth,
                        height = EXCLUDED.height,
                        updated_at = NOW()
                `;
                await client.query(query, values);
                console.log(`📦 [Sync] ${Math.min(i + BATCH_SIZE, finalData.length)} / ${finalData.length} 건 처리 완료...`);
            }

            await client.query('COMMIT');
            res.json({ success: true, message: "제품 마스터가 클라우드에 업로드되었습니다." });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("❌ 제품 마스터 동기화 오류:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- DB 저장 및 조회 API ---

app.post('/api/save-to-db', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false, message: "DB 모듈이 없습니다." });

    const items = req.body.items;
    if (!items || !Array.isArray(items)) {
        return res.status(400).json({ success: false, message: "저장할 데이터가 없습니다." });
    }

    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Job 정보 그룹화 및 저장 (중복 방지)
            // job_name, eta, etd, remark가 같은 건은 하나의 job으로 묶음
            const jobsMap = new Map();
            items.forEach(item => {
                const jobKey = `${item.jobName || ''}_${item.eta || ''}_${item.etd || ''}_${item.origRemark || ''}`;
                if (!jobsMap.has(jobKey)) {
                    jobsMap.set(jobKey, {
                        jobName: item.jobName || '',
                        eta: item.eta || '',
                        etd: item.etd || '',
                        remark: item.origRemark || ''
                    });
                }
            });

            const jobIdsMap = new Map();
            for (const [key, job] of jobsMap.entries()) {
                // 기존에 동일한 Job이 있는지 확인 (최근 1시간 내 동일 정보면 재사용 또는 신규 생성)
                const jobCheck = await client.query(
                    "SELECT id FROM container_jobs WHERE job_name = $1 AND eta = $2 AND etd = $3 AND remark = $4 ORDER BY saved_at DESC LIMIT 1",
                    [job.jobName, job.eta, job.etd, job.remark]
                );

                let jobId;
                if (jobCheck.rows.length > 0) {
                    jobId = jobCheck.rows[0].id;
                } else {
                    const jobInsert = await client.query(
                        "INSERT INTO container_jobs (job_name, eta, etd, remark) VALUES ($1, $2, $3, $4) RETURNING id",
                        [job.jobName, job.eta, job.etd, job.remark]
                    );
                    jobId = jobInsert.rows[0].id;
                }
                jobIdsMap.set(key, jobId);
            }

            // 2. 개별 품목(Item) 저장
            const insertQuery = `
                INSERT INTO container_results (
                    job_id, job_name, cntr_no, seal_no, prod_name, qty_plan, qty_load, 
                    cntr_type, carrier, destination, weight_mixed, etd, eta, remark,
                    prod_type, division, dims, weight_orig, weight_down, transporter, 
                    adj1, adj1_color, saved_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, NOW())
            `;

            for (const item of items) {
                const jobKey = `${item.jobName || ''}_${item.eta || ''}_${item.etd || ''}_${item.origRemark || ''}`;
                const jobId = jobIdsMap.get(jobKey);

                await client.query(insertQuery, [
                    jobId,
                    item.jobName || '',
                    item.cntrNo || '',
                    item.sealNo || '',
                    item.prodName || '',
                    item.qtyInfo?.plan || 0,
                    item.qtyInfo?.load || 0,
                    item.cntrType?.val || '',
                    item.carrierName?.val || '',
                    item.destination?.val || '',
                    item.weights?.mixed || 0,
                    item.etd || '',
                    item.eta || '',
                    item.origRemark || '',
                    item.prodType || '',
                    item.division || '',
                    item.dims || '',
                    item.weights?.orig || 0,
                    item.weights?.down || 0,
                    item.transporter || '',
                    item.adj1 || '',
                    item.adj1_color || item.adj1Color || ''
                ]);
            }
            await client.query('COMMIT');
            res.json({ success: true, count: items.length });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("❌ DB 저장 오류:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/db-search', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false, message: "DB 모듈이 없습니다." });

    const { cntr_no, dest, carrier, start, end } = req.query;

    // container_results를 기준으로 하되 container_jobs와 JOIN하여 최신 헤더 정보를 가져옴
    let queryBase = `
        SELECT r.*, j.eta as job_eta, j.etd as job_etd, j.remark as job_remark, j.job_name as job_name_master
        FROM container_results r
        LEFT JOIN container_jobs j ON r.job_id = j.id
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    if (cntr_no) {
        queryBase += ` AND (r.cntr_no ILIKE $${paramIndex} OR r.seal_no ILIKE $${paramIndex})`;
        params.push(`%${cntr_no}%`);
        paramIndex++;
    }
    if (dest) {
        queryBase += ` AND r.destination ILIKE $${paramIndex}`;
        params.push(`%${dest}%`);
        paramIndex++;
    }
    if (carrier) {
        queryBase += ` AND r.carrier ILIKE $${paramIndex}`;
        params.push(`%${carrier}%`);
        paramIndex++;
    }
    if (start) {
        queryBase += ` AND r.saved_at >= $${paramIndex}`;
        params.push(start + " 00:00:00");
        paramIndex++;
    }
    if (end) {
        queryBase += ` AND r.saved_at <= $${paramIndex}`;
        params.push(end + " 23:59:59");
        paramIndex++;
    }

    queryBase += " ORDER BY r.saved_at DESC";
    console.log(`🔎 [DB] 검색 요청: \n - 쿼리: ${queryBase} \n - 파라미터: ${JSON.stringify(params)}`);

    try {
        // 먼저 개수만 조회
        const countQuery = `SELECT COUNT(*) as total FROM (${queryBase}) as subquery`;
        const countResult = await pool.query(countQuery, params);
        const totalCount = parseInt(countResult.rows[0].total);

        // 요청에 confirm=true가 있으면 데이터 조회, 없으면 개수만 반환
        if (req.query.confirm === 'true' || totalCount <= 500) {
            const result = await pool.query(queryBase, params);
            res.json({ success: true, results: result.rows, totalCount });
        } else {
            res.json({ success: true, results: [], totalCount, requireConfirm: true });
        }
    } catch (err) {
        console.error("❌ DB 조회 오류:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// DB 벌크 삭제 API
app.post('/api/db-bulk-delete', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false, message: "DB 모듈이 없습니다." });
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: "삭제할 ID 목록이 없습니다." });
    }
    try {
        await pool.query('DELETE FROM container_results WHERE id = ANY($1)', [ids]);
        res.json({ success: true, message: `${ids.length}건의 레코드가 삭제되었습니다.` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// DB 레코드 삭제 API
app.delete('/api/db-record/:id', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false, message: "DB 모듈이 없습니다." });
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM container_results WHERE id = $1', [id]);
        res.json({ success: true, message: "레코드가 삭제되었습니다." });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// DB 레코드 수정 API
app.put('/api/db-record/:id', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false, message: "DB 모듈이 없습니다." });
    const { id } = req.params;
    const { cntr_no, prod_name, qty_plan, qty_load, cntr_type, carrier, destination, weight_mixed, adj1 } = req.body;
    try {
        await pool.query(`
            UPDATE container_results 
            SET cntr_no = $1, prod_name = $2, qty_plan = $3, qty_load = $4, 
                cntr_type = $5, carrier = $6, destination = $7, weight_mixed = $8, adj1 = $9
            WHERE id = $10
        `, [cntr_no, prod_name, qty_plan, qty_load, cntr_type, carrier, destination, weight_mixed, adj1, id]);
        res.json({ success: true, message: "레코드가 수정되었습니다." });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// DB 전체 통계 API
app.get('/api/db-stats', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false, message: "DB 모듈이 없습니다." });
    try {
        const statsQuery = `
            SELECT 
                (SELECT COUNT(DISTINCT cntr_no) FROM container_results) as total_cntrs,
                (SELECT COUNT(*) FROM container_results) as total_items,
                (SELECT COUNT(*) FROM carrier_mappings) as total_carriers,
                (SELECT COUNT(*) FROM auto_classify_rules) as total_rules,
                (SELECT COUNT(*) FROM product_master_sync) as total_master,
                COALESCE(pg_size_pretty(
                    pg_total_relation_size('container_results') + 
                    pg_total_relation_size('container_jobs') +
                    pg_total_relation_size('carrier_mappings') +
                    pg_total_relation_size('auto_classify_rules') +
                    pg_total_relation_size('product_master_sync')
                ), '0 KB') as total_size
        `;
        const result = await pool.query(statsQuery);
        res.json({ success: true, stats: result.rows[0] });
    } catch (err) {
        console.error("❌ DB 통계 조회 오류:", err);
        // 테이블이 아직 없는 경우 등을 위해 기본값 반환
        res.json({
            success: true,
            stats: {
                total_cntrs: 0,
                total_items: 0,
                total_size: '0 KB',
                total_carriers: 0,
                total_rules: 0,
                total_master: 0
            }
        });
    }
});


// 품목 정보 (중량/부피) 업데이트 API
app.post('/api/update', async (req, res) => {
    const updates = req.body;
    if (!updates || !Array.isArray(updates)) {
        return res.status(400).json({ success: false, message: "업데이트할 정보가 없습니다." });
    }

    const localFilePath = PRODUCTS_FILE;
    let existingProducts = [];
    if (fs.existsSync(localFilePath)) {
        try {
            existingProducts = JSON.parse(fs.readFileSync(localFilePath, 'utf8'));
        } catch (e) { existingProducts = []; }
    }

    let successCount = 0;
    const now = new Date().toISOString();

    for (const item of updates) {
        const idx = existingProducts.findIndex(p => p.name === item.name);
        if (idx !== -1) {
            existingProducts[idx] = {
                ...existingProducts[idx],
                weight: parseFloat(item.weight) || 0,
                width: parseInt(item.width) || 0,
                depth: parseInt(item.depth) || 0,
                height: parseInt(item.height) || 0,
                updatedAt: now
            };
            successCount++;
        } else {
            existingProducts.push({
                name: item.name,
                weight: parseFloat(item.weight) || 0,
                width: parseInt(item.width) || 0,
                depth: parseInt(item.depth) || 0,
                height: parseInt(item.height) || 0,
                updatedAt: now
            });
            successCount++;
        }
    }

    try {
        fs.writeFileSync(localFilePath, JSON.stringify(existingProducts, null, 2), 'utf8');
        console.log(`✨ [API] 로컬 JSON 업데이트 완료: 성공 ${successCount}건`);
        res.json({ success: true, successCount, message: "로컬 JSON 파일이 성공적으로 업데이트되었습니다." });
    } catch (err) {
        console.error("❌ 로컬 파일 저장 오류:", err.message);
        res.status(500).json({ success: false, message: "파일 저장에 실패했습니다." });
    }
});

// --- 창고재고 파일 파싱 API ---
// 창고재고 파일(ungproduct.xlsx 등)을 업로드하면 H열(인덱스 7)의 제품명을 읽어
// "접두어.접미어" 형식에서 동일 접두어에 다른 접미어가 존재하는 제품들의 집합을 반환
app.post('/api/parse-warehouse-stock', upload.single('warehouseFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: '창고재고 파일이 누락되었습니다.' });
        }

        console.log(`📦 [API] 창고재고 파일 파싱 시작: ${req.file.originalname}`);

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(req.file.buffer);

        const worksheet = workbook.worksheets[0];
        if (!worksheet) {
            return res.status(400).json({ success: false, message: '파일에 시트가 없습니다.' });
        }

        // H열(8번째 열, 1-indexed) 제품명 수집
        const productNamesInWarehouse = new Set();
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber <= 1) return; // 헤더 스킵
            const cell = row.getCell(8); // H열
            const val = cell.text || String(cell.value || '');
            const name = val.trim().toUpperCase();
            if (name && name.includes('.')) {
                productNamesInWarehouse.add(name);
            }
        });

        console.log(`📦 [API] 창고재고: 총 ${productNamesInWarehouse.size}개 고유 제품명 수집`);

        // 접두어별로 그룹화 (마지막 '.' 기준)
        const prefixMap = {};
        for (const name of productNamesInWarehouse) {
            const dotIdx = name.lastIndexOf('.');
            if (dotIdx === -1) continue;
            const prefix = name.substring(0, dotIdx);
            if (!prefixMap[prefix]) prefixMap[prefix] = new Set();
            prefixMap[prefix].add(name);
        }

        // 동일 접두어에 다른 접미어가 2개 이상 존재하는 접두어들만 필터
        // → 이 접두어에 속하는 모든 제품명이 (동) 태그 대상
        const dongPrefixSet = new Set();
        for (const [prefix, names] of Object.entries(prefixMap)) {
            if (names.size >= 2) {
                dongPrefixSet.add(prefix);
            }
        }

        console.log(`📦 [API] (동) 태그 대상 접두어: ${dongPrefixSet.size}개`);

        res.json({
            success: true,
            dongPrefixes: Array.from(dongPrefixSet), // 프론트에서 Set으로 변환하여 사용
            totalProducts: productNamesInWarehouse.size,
            fileName: req.file.originalname
        });
    } catch (err) {
        console.error('❌ [API] 창고재고 파싱 오류:', err);
        res.status(500).json({ success: false, message: `파일 파싱 오류: ${err.message}` });
    }
});

// --- POP 샘플 무게 등록 API ---
// GET: 전체 POP 무게 목록 반환
app.get('/api/pop-weights', (req, res) => {
    try {
        let data = {};
        if (fs.existsSync(POP_WEIGHTS_FILE)) {
            data = JSON.parse(fs.readFileSync(POP_WEIGHTS_FILE, 'utf8'));
        }
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST: POP 무게 등록/업데이트 { cntrNo, weight, memo }
app.post('/api/pop-weights', (req, res) => {
    try {
        const { cntrNo, weight, memo } = req.body;
        const key = (cntrNo || '').trim().toUpperCase();
        if (!key) return res.status(400).json({ success: false, message: '컨테이너 번호가 필요합니다.' });
        const w = parseFloat(weight);
        if (isNaN(w) || w <= 0) return res.status(400).json({ success: false, message: '올바른 무게를 입력해주세요.' });

        let data = {};
        if (fs.existsSync(POP_WEIGHTS_FILE)) {
            data = JSON.parse(fs.readFileSync(POP_WEIGHTS_FILE, 'utf8'));
        }
        data[key] = { weight: w, memo: memo || '', updatedAt: new Date().toISOString() };
        fs.writeFileSync(POP_WEIGHTS_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log(`📦 [POP] 등록: ${key} → +${w}kg`);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// DELETE: POP 무게 해제 ?cntrNo=XXXX
app.delete('/api/pop-weights', (req, res) => {
    try {
        const key = ((req.query.cntrNo || '')).trim().toUpperCase();
        if (!key) return res.status(400).json({ success: false, message: '컨테이너 번호가 필요합니다.' });

        let data = {};
        if (fs.existsSync(POP_WEIGHTS_FILE)) {
            data = JSON.parse(fs.readFileSync(POP_WEIGHTS_FILE, 'utf8'));
        }
        delete data[key];
        fs.writeFileSync(POP_WEIGHTS_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log(`🗑️ [POP] 해제: ${key}`);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Static file serving (re-enabled to allow browser access)
app.use(express.static(__dirname));

// --- 404 Handler ---
app.use((req, res) => {
    res.status(404).json({ success: false, message: "요청하신 경로를 찾을 수 없습니다." });
});

// --- 전역 에러 핸들러 (JSON 응답 보장) ---
app.use((err, req, res, next) => {
    console.error('🔥 [Global Error]:', err);

    // Payload Too Large (413) 등 body-parser 에러 처리
    if (err.type === 'entity.too.large') {
        return res.status(413).json({
            success: false,
            message: `데이터 크기가 너무 큽니다. (최대 50MB 허용). 현재: ${(err.length / 1024 / 1024).toFixed(1)}MB`
        });
    }

    res.status(err.status || 500).json({
        success: false,
        message: err.message || "서버 내부 오류가 발생했습니다."
    });
});

app.listen(port, () => {
    console.log(`🚀 API 서버가 http://localhost:${port} 에서 실행 중입니다.`);
});
