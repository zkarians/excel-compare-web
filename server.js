const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const nodemailer = require('nodemailer');

// Electron Writable Data Path - Web Server friendly fallback
const DATA_DIR = process.env.APP_DATA_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_CONFIG_FILE = path.join(DATA_DIR, 'db_config.json');
const MAIL_CONFIG_FILE = path.join(DATA_DIR, 'mail_config.json');

// pg re-integrated with safe error handling
let pool = null;
let isConnecting = false;
let currentDbConfig = {
    user: process.env.PGUSER || 'u0_a354',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'u0_a354',
    password: process.env.PGPASSWORD || '',
    port: Number(process.env.PGPORT) || 5432,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000, // 연결 시도 타임아웃 15초
    idleTimeoutMillis: 600000,    // 10분 동안 활동 없으면 연결 해제 (기존 5분에서 증가)
    max: 20,                       // 동시 연결 수 상향
    keepAlive: true,               // TCP Keep-Alive 활성화 (연결 끊김 방지 핵심)
    application_name: 'ExcelCompareApp'
};

// --- DB 연결 유틸리티 ---
async function getPool() {
    if (!pool) {
        if (isConnecting) {
            console.log("⏳ [DB] 이미 연결 중입니다. 대기...");
            await new Promise(resolve => setTimeout(resolve, 1000));
            return getPool();
        }
        console.log("🔌 [DB] 풀이 초기화되지 않았습니다. 연결을 시도합니다.");
        const result = await connectToDb(currentDbConfig);
        if (!result.success) {
            throw new Error(`DB 연결 실패: ${result.message}`);
        }
    }
    return pool;
}

// Load saved config if exists
if (fs.existsSync(DB_CONFIG_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8'));
        currentDbConfig = { ...currentDbConfig, ...saved };
        console.log("💾 [DB] 저장된 설정 로드됨:", currentDbConfig.host);
    } catch (e) {
        console.error("❌ [DB] 설정 로드 실패:", e.message);
    }
}

const { Pool } = require('pg');

async function connectToDb(config) {
    if (isConnecting) return { success: false, message: "이미 연결 시도 중입니다." };
    isConnecting = true;

    try {
        if (pool) {
            console.log("🔄 [DB] 기존 연결 풀 종료 중...");
            const oldPool = pool;
            pool = null;
            try {
                if (!oldPool.ending) {
                    await oldPool.end();
                }
            } catch (e) {
                console.warn("⚠️ [DB] 기존 풀 종료 중 오류 (무시):", e.message);
            }
        }

        currentDbConfig = { ...currentDbConfig, ...config };

        // 민감 정보 마스킹 후 출력
        const logConfig = { ...currentDbConfig };
        if (logConfig.password) logConfig.password = '********';
        console.log("🔌 [DB] 새로운 연결 시도:", logConfig.host);

        // 보안상 비밀번호가 포함된 설정 파일 저장
        fs.writeFileSync(DB_CONFIG_FILE, JSON.stringify(currentDbConfig, null, 2));

        const newPool = new Pool(currentDbConfig);

        newPool.on('error', (err) => {
            console.error('❌ [DB] Pool error (심각):', err.message);
            // 치명적인 오류(연결 종료 등) 발생 시 풀을 null로 만들어 재연결 유도
            if (err.message.includes('terminated') || err.message.includes('closed') || err.message.includes('ended')) {
                console.warn('⚠️ [DB] 연결이 끊겼습니다. 다음 요청 시 재연결을 시도합니다.');
                pool = null;
            }
        });

        newPool.on('connect', () => {
            console.log('✅ [DB] 새로운 클라이언트가 연결되었습니다.');
        });

        // 연결 테스트
        const client = await newPool.connect();
        try {
            console.log("✅ [DB] 연결 테스트 성공!");
            pool = newPool; // 테스트 성공 시에만 전역 pool에 할당
            await initDb();
            return { success: true, message: `Connected to ${currentDbConfig.host}` };
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("❌ [DB] 초기 연결 및 테이블 생성 실패:", err.message);
        pool = null; // 실패 시 확실히 null 유지
        return { success: false, message: err.message };
    } finally {
        isConnecting = false;
    }
}

// Initial connection
connectToDb(currentDbConfig);

async function initDb() {
    if (!pool) return;
    const client = await pool.connect();
    try {
        // 1. 제품 마스터
        await client.query(`
            CREATE TABLE IF NOT EXISTS product_master_sync (
                prod_name TEXT PRIMARY KEY,
                prod_type TEXT,
                weight NUMERIC DEFAULT 0,
                width NUMERIC DEFAULT 0,
                depth NUMERIC DEFAULT 0,
                height NUMERIC DEFAULT 0,
                cbm NUMERIC DEFAULT 0,
                updated_at TIMESTAMP DEFAULT NOW(),
                last_used_at TIMESTAMP
            )
        `);
        await client.query(`ALTER TABLE product_master_sync ADD COLUMN IF NOT EXISTS cbm NUMERIC DEFAULT 0`);
        await client.query(`ALTER TABLE product_master_sync ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP`);

        // 2. 컨테이너 보류
        await client.query(`
            CREATE TABLE IF NOT EXISTS container_holds (
                cntr_no TEXT PRIMARY KEY,
                hold_reason TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // 3. POP 무게
        await client.query(`
            CREATE TABLE IF NOT EXISTS container_pops (
                cntr_no TEXT PRIMARY KEY,
                weight NUMERIC DEFAULT 0,
                memo TEXT,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // 4. 선사 매핑
        await client.query(`
            CREATE TABLE IF NOT EXISTS carrier_mappings (
                code TEXT PRIMARY KEY,
                names JSONB,
                updated_at TIMESTAMP DEFAULT NOW(),
                id SERIAL
            )
        `);

        // 5. 자동분류 규칙
        await client.query(`
            CREATE TABLE IF NOT EXISTS auto_classify_rules (
                id TEXT PRIMARY KEY,
                is_active BOOLEAN DEFAULT TRUE,
                group_name TEXT,
                condition_operator TEXT DEFAULT 'AND',
                conditions JSONB,
                target_field TEXT,
                target_value TEXT,
                tag_color TEXT,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        // 하위 호환성: 기존 테이블에 없는 컬럼들 추가
        await client.query(`ALTER TABLE auto_classify_rules ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`);
        await client.query(`ALTER TABLE auto_classify_rules ADD COLUMN IF NOT EXISTS group_name TEXT`);
        await client.query(`ALTER TABLE auto_classify_rules ADD COLUMN IF NOT EXISTS condition_operator TEXT DEFAULT 'AND'`);
        await client.query(`ALTER TABLE auto_classify_rules ADD COLUMN IF NOT EXISTS conditions JSONB`);
        await client.query(`ALTER TABLE auto_classify_rules ADD COLUMN IF NOT EXISTS target_field TEXT`);
        await client.query(`ALTER TABLE auto_classify_rules ADD COLUMN IF NOT EXISTS target_value TEXT`);
        await client.query(`ALTER TABLE auto_classify_rules ADD COLUMN IF NOT EXISTS tag_color TEXT`);
        await client.query(`ALTER TABLE auto_classify_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);

        await client.query(`ALTER TABLE carrier_mappings ADD COLUMN IF NOT EXISTS names JSONB`);
        await client.query(`ALTER TABLE carrier_mappings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);

        // 6. 작업 JOB 정보
        await client.query(`
            CREATE TABLE IF NOT EXISTS container_jobs (
                id SERIAL PRIMARY KEY,
                job_name TEXT,
                eta TEXT,
                etd TEXT,
                remark TEXT,
                saved_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // 7. 앱 설정 (이메일 등)
        await client.query(`
            CREATE TABLE IF NOT EXISTS app_configs (
                key TEXT PRIMARY KEY,
                value JSONB,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // 8. 보낸 메일 이력
        await client.query(`
            CREATE TABLE IF NOT EXISTS sent_emails (
                id SERIAL PRIMARY KEY,
                recipient TEXT,
                subject TEXT,
                content TEXT,
                sent_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // 9. 데이터 비교 결과
        await client.query(`
            CREATE TABLE IF NOT EXISTS container_results (
                id SERIAL PRIMARY KEY,
                job_id INTEGER REFERENCES container_jobs(id) ON DELETE SET NULL,
                job_name TEXT,
                cntr_no TEXT,
                seal_no TEXT,
                prod_name TEXT,
                qty_plan INTEGER,
                qty_load INTEGER,
                qty_pending INTEGER DEFAULT 0,
                qty_remain INTEGER DEFAULT 0,
                qty_packing INTEGER DEFAULT 0,
                cntr_type TEXT,
                carrier TEXT,
                destination TEXT,
                weight_mixed NUMERIC,
                etd TEXT,
                eta TEXT,
                remark TEXT,
                saved_at TIMESTAMP DEFAULT NOW(),
                prod_type TEXT,
                division TEXT,
                dims TEXT,
                weight_orig NUMERIC,
                weight_down NUMERIC,
                transporter TEXT,
                adj1 TEXT,
                adj1_color TEXT,
                adj2 TEXT,
                UNIQUE (job_name, cntr_no, prod_name, qty_plan)
            )
        `);

        await client.query(`ALTER TABLE container_results ADD COLUMN IF NOT EXISTS adj2 TEXT`);
        await client.query(`ALTER TABLE container_results ADD COLUMN IF NOT EXISTS qty_pending INTEGER DEFAULT 0`);
        await client.query(`ALTER TABLE container_results ADD COLUMN IF NOT EXISTS qty_remain INTEGER DEFAULT 0`);
        await client.query(`ALTER TABLE container_results ADD COLUMN IF NOT EXISTS qty_packing INTEGER DEFAULT 0`);

        // UPSERT를 위한 유니크 인덱스 강제 생성 (이미 존재하면 건너뜀)
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_container_results_upsert 
            ON container_results (job_name, cntr_no, prod_name, qty_plan)
        `);

        // 8. ID 시퀀스 복구 및 동기화 (Self-healing)
        try {
            for (const tableName of ['container_jobs', 'container_results', 'sent_emails']) {
                // 시퀀스 존재 확인
                const seqName = `${tableName}_id_seq`;
                const seqExists = await client.query(`SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'S'`, [seqName]);

                if (seqExists.rows.length === 0) {
                    await client.query(`CREATE SEQUENCE IF NOT EXISTS ${seqName}`);
                    console.log(`🏗️ [DB] 시퀀스 생성: ${seqName}`);
                }

                // 컬럼에 DEFAULT 설정이 없는 경우 추가
                await client.query(`
                    DO $$ 
                    BEGIN 
                        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = '${tableName}' AND column_name = 'id' AND column_default IS NOT NULL) THEN
                            ALTER TABLE ${tableName} ALTER COLUMN id SET DEFAULT nextval('${seqName}');
                            ALTER SEQUENCE ${seqName} OWNED BY ${tableName}.id;
                        END IF;
                    END $$;
                `);

                // 마지막 값 동기화
                const resSeq = await client.query(`SELECT pg_get_serial_sequence('${tableName}', 'id') as seq`);
                const actualSeq = resSeq.rows[0].seq || seqName;
                await client.query(`SELECT setval('${actualSeq}', COALESCE((SELECT MAX(id) FROM ${tableName}), 0) + 1, false)`);
            }
        } catch (seqErr) {
            console.warn("⚠️ [DB] 시퀀스 복구/동기화 중 경고:", seqErr.message);
        }

        console.log("✅ [DB] 모든 테이블(9종) 및 시퀀스 준비 완료");
    } finally {
        client.release();
    }
}

const ExcelJS = require('exceljs');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

// Body Parsers
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Electron Writable Data Path - Web Server friendly fallback
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const RULES_FILE = path.join(DATA_DIR, 'rules.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// Middleware
app.use(cors({
    origin: (origin, callback) => {
        // 로컬, 파일, 클라우드타입, 그리고 사용자 DDNS 허용
        if (!origin || origin === 'null' ||
            origin.includes('localhost') ||
            origin.includes('127.0.0.1') ||
            origin.includes('file://') ||
            origin.includes('cloudtype.app') ||
            origin.includes('maizen.iptime.org')) {
            callback(null, true);
        } else {
            callback(new Error('CORS policy violation'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// --- DB Configuration & Sync Endpoints ---

// Get current DB config (mask password)
app.get('/api/db/config', (req, res) => {
    const config = { ...currentDbConfig };
    if (config.password) config.password = '********';
    res.json({ success: true, config });
});

// Set DB config and reconnect
app.post('/api/db/config', async (req, res) => {
    const { host, user, password, port, database, ssl } = req.body || {};
    const newConfig = {};
    if (host) newConfig.host = host;
    if (user) newConfig.user = user;
    if (password) newConfig.password = password;
    if (port) newConfig.port = Number(port);
    if (database) newConfig.database = database;
    if (ssl !== undefined) newConfig.ssl = ssl;

    const result = await connectToDb(newConfig);
    res.json(result);
});

// Sync logic: Cloud <-> Phone
async function syncData(sourceConfig, targetConfig, tables) {
    const sourcePool = new Pool({ ...sourceConfig, connectionTimeoutMillis: 5000 });
    const targetPool = new Pool({ ...targetConfig, connectionTimeoutMillis: 5000 });
    const results = [];

    try {
        for (const tableName of tables) {
            console.log(`[Sync] Processing ${tableName}...`);
            try {
                const res = await sourcePool.query(`SELECT * FROM ${tableName}`);
                const rows = res.rows;

                if (rows.length > 0) {
                    let pk = 'id';
                    if (['product_master_sync'].includes(tableName)) pk = 'prod_name';
                    if (['container_holds', 'container_pops'].includes(tableName)) pk = 'cntr_no';
                    if (['carrier_mappings'].includes(tableName)) pk = 'code';
                    if (['auto_classify_rules', 'container_jobs', 'container_results'].includes(tableName)) pk = 'id';

                    // Filter columns: skip surrogate 'id' if 'id' is not the primary key
                    const columns = Object.keys(rows[0]).filter(c => c !== 'id' || pk === 'id');
                    const colNames = columns.join(', ');

                    const updateClause = columns.filter(c => c !== pk).map(c => `${c} = EXCLUDED.${c}`).join(', ');

                    for (let i = 0; i < rows.length; i += 200) {
                        const batch = rows.slice(i, i + 200);
                        const values = [];
                        const placeholdersRows = [];
                        batch.forEach((row, rowIndex) => {
                            const offset = rowIndex * columns.length;
                            const placeholders = columns.map((_, colIndex) => `$${offset + colIndex + 1}`).join(', ');
                            placeholdersRows.push(`(${placeholders})`);
                            values.push(...columns.map(c => {
                                const val = row[c];
                                return (typeof val === 'object' && val !== null && !(val instanceof Date)) ? JSON.stringify(val) : val;
                            }));
                        });
                        const query = `INSERT INTO ${tableName} (${colNames}) VALUES ${placeholdersRows.join(', ')} ON CONFLICT (${pk}) DO UPDATE SET ${updateClause || `${pk}=EXCLUDED.${pk}`}`;
                        await targetPool.query(query, values);
                    }
                }
                results.push({ table: tableName, count: rows.length, success: true });
            } catch (err) {
                console.error(`[Sync] Error in ${tableName}:`, err.message);
                results.push({ table: tableName, error: err.message, success: false });
            }
        }

        // 데이터 전송 후 수동 PK 삽입에 따른 시퀀스 불일치 해결
        try {
            const resJobs = await targetPool.query(`SELECT pg_get_serial_sequence('container_jobs', 'id') as seq`);
            if (resJobs.rows[0].seq) {
                await targetPool.query(`SELECT setval('${resJobs.rows[0].seq}', COALESCE((SELECT MAX(id) FROM container_jobs), 0) + 1, false)`);
            }

            const resResults = await targetPool.query(`SELECT pg_get_serial_sequence('container_results', 'id') as seq`);
            if (resResults.rows[0].seq) {
                await targetPool.query(`SELECT setval('${resResults.rows[0].seq}', COALESCE((SELECT MAX(id) FROM container_results), 0) + 1, false)`);
            }
            console.log(`[Sync] sequences recalculated for target database.`);
        } catch (seqErr) {
            console.warn(`[Sync] Failed to reset sequences (ignoring):`, seqErr.message);
        }
    } finally {
        await sourcePool.end();
        await targetPool.end();
    }
    return results;
}

const CLOUD_CONFIG = {
    user: 'root', host: 'svc.sel3.cloudtype.app', database: 'excel_compare',
    password: 'z456qwe12!@', port: 30554, ssl: false
};

app.post('/api/db/sync', async (req, res) => {
    const { direction, phoneConfig, tables } = req.body || {};
    const targetTables = tables || [
        'product_master_sync', 'container_holds', 'container_pops',
        'carrier_mappings', 'auto_classify_rules', 'container_jobs', 'container_results'
    ];
    let source, target;
    if (direction === 'to_phone') {
        source = CLOUD_CONFIG;
        target = phoneConfig;
    } else {
        source = phoneConfig;
        target = CLOUD_CONFIG;
    }
    try {
        const syncResults = await syncData(source, target, targetTables);
        res.json({ success: true, results: syncResults });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

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

// Redundant master-data endpoint removed (Moved below with DB logic)


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

// 제품 마스터 데이터 가져오기 API (DB 우선)
app.get('/api/master-data', async (req, res) => {
    try {
        console.log(`📡 [API] 마스터 데이터 조회 요청 (DB 우선)`);

        let masterData = [];
        let fetchedFromDb = false;

        if (pool) {
            try {
                const result = await pool.query('SELECT prod_name as name, prod_type as "prodType", weight, width, depth, height, cbm, last_used_at as "lastUsedAt" FROM product_master_sync ORDER BY prod_name ASC');
                masterData = result.rows;
                fetchedFromDb = true;
                console.log(`🐘 [DB] 제품 마스터 ${masterData.length}건 조회 완료`);
            } catch (dbErr) {
                console.error("❌ [DB] 제품 마스터 조회 실패 (파일 폴백 시도):", dbErr.message);
                // DB 조회 실패 시 에러를 던지지 않고 파일 폴백으로 넘어감
            }
        }

        // DB 조회에 실패했거나 데이터가 없는 경우 파일에서 읽어옴
        if (masterData.length === 0) {
            try {
                console.log(`📂 [API] DB에 데이터가 없거나 조회 실패하여 파일에서 파싱을 시도합니다.`);
                masterData = await parseMasterExcel();

                // 파일에서 읽어왔다면 백그라운드에서 DB에 저장 시도 (다음번 조회를 위해)
                // 단, DB 연결 자체가 풀(pool)이 살아있을 때만 시도
                if (pool && masterData.length > 0) {
                    saveMasterDataToDb(masterData).catch(err => console.error("❌ [DB] 초기 데이터 저장 실패:", err));
                }
            } catch (fileErr) {
                console.error("❌ [FILE] 마스터 파일 파싱 실패:", fileErr.message);
            }
        }

        // 만약 두 방법 모두 실패하여 데이터가 최종적으로 0건이라면, 
        // 성공 응답 대신 명확한 에러를 주어 프론트엔드가 기존 데이터를 지우지 않게 함
        if (masterData.length === 0) {
            return res.status(503).json({
                success: false,
                message: "제품 마스터 데이터를 DB나 파일에서 불러올 수 없습니다. 연결 상태를 확인해주세요."
            });
        }

        res.json({ success: true, masterData });
    } catch (err) {
        console.error("❌ 마스터 조회 오류:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 제품 마스터 DB 저장 헬퍼 함수
async function saveMasterDataToDb(masterData) {
    let pool;
    try {
        pool = await getPool();
    } catch (e) {
        console.error("❌ [DB] 마스터 저장 실패 (연결 불가):", e.message);
        return;
    }

    // 중복 제거
    const uniqueMap = new Map();
    masterData.forEach(item => {
        if (item.name && item.name.trim() !== "") {
            uniqueMap.set(item.name.trim(), item);
        }
    });
    const finalData = Array.from(uniqueMap.values());
    console.log(`🐘 [DB] 마스터 데이터 저장 시작 (총 ${finalData.length}건)`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // await client.query('DELETE FROM product_master_sync'); // Upsert 방식으로 변경 (기존 데이터 유지)

        const BATCH_SIZE = 1000;
        for (let i = 0; i < finalData.length; i += BATCH_SIZE) {
            const batch = finalData.slice(i, i + BATCH_SIZE);
            const values = [];
            const placeholders = [];

            batch.forEach((item, index) => {
                const offset = index * 7;
                placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`);
                values.push(
                    item.name.trim(),
                    item.prodType || item.type || '',
                    item.weight || 0,
                    item.width || 0,
                    item.depth || 0,
                    item.height || 0,
                    item.cbm || 0
                );
            });

            const query = `
                INSERT INTO product_master_sync
                (prod_name, prod_type, weight, width, depth, height, cbm)
                VALUES ${placeholders.join(', ')}
                ON CONFLICT (prod_name) DO UPDATE SET
                    prod_type = EXCLUDED.prod_type,
                    weight = EXCLUDED.weight,
                    width = EXCLUDED.width,
                    depth = EXCLUDED.depth,
                    height = EXCLUDED.height,
                    cbm = EXCLUDED.cbm,
                    updated_at = NOW()
            `;
            await client.query(query, values);
        }
        await client.query('COMMIT');
        console.log(`✅ [DB] 마스터 데이터 ${finalData.length}건 동기화 완료 (Upsert)`);
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("❌ DB 저장 오류:", err);
        throw err;
    } finally {
        if (client) client.release();
    }
}

// 마스터 데이터 정리 (오래된 데이터 삭제)
app.post('/api/master-data/clean', async (req, res) => {
    const { days } = req.body;
    try {
        const pool = await getPool();
        const thresholdDays = parseInt(days) || 30;
        const result = await pool.query(
            "DELETE FROM product_master_sync WHERE (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 day' * $1) AND updated_at < NOW() - INTERVAL '1 day' * $1",
            [thresholdDays]
        );
        res.json({
            success: true,
            message: `${thresholdDays}일 이상 업데이트되지 않은 데이터 ${result.rowCount}건을 삭제했습니다.`
        });
    } catch (err) {
        console.error("❌ 데이터 정리 오류:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 마스터 데이터 전체 삭제 (초기화용)
app.post('/api/master-data/reset', async (req, res) => {
    try {
        const pool = await getPool();
        await pool.query("DELETE FROM product_master_sync");
        res.json({ success: true, message: "제품 마스터 DB가 완전히 초기화되었습니다." });
    } catch (err) {
        console.error("❌ 데이터 초기화 오류:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 마스터 개별 추가/수정 (Upsert)
app.post('/api/master-data/save', async (req, res) => {
    try {
        const { prodName, prodType, weight, width, depth, height, cbm } = req.body;
        if (!prodName) {
            return res.status(400).json({ success: false, message: '제품명은 필수입니다.' });
        }

        const pool = await getPool();
        const query = `
            INSERT INTO product_master_sync (prod_name, prod_type, weight, width, depth, height, cbm, updated_at, last_used_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
            ON CONFLICT (prod_name) DO UPDATE 
            SET prod_type = EXCLUDED.prod_type,
                weight = EXCLUDED.weight,
                width = EXCLUDED.width,
                depth = EXCLUDED.depth,
                height = EXCLUDED.height,
                cbm = EXCLUDED.cbm,
                updated_at = NOW(),
                last_used_at = NOW()
        `;
        const values = [
            prodName.trim(),
            prodType || '',
            parseFloat(weight) || 0,
            parseFloat(width) || 0,
            parseFloat(depth) || 0,
            parseFloat(height) || 0,
            parseFloat(cbm) || 0
        ];

        await pool.query(query, values);
        res.json({ success: true, message: '제품 정보가 성공적으로 저장되었습니다.' });
    } catch (err) {
        console.error('❌ 마스터 개별 저장 오류:', err);
        res.status(500).json({ success: false, message: 'DB 저장 오류: ' + err.message });
    }
});

// 마스터 데이터 직접 업로드 API (DB 동기화 포함)
app.post('/api/upload-master', upload.single('masterFile'), async (req, res) => {
    try {
        console.log(`📂 [API] 마스터 데이터 업데이트 요청 (DB 저장 방식)`);
        if (!req.file) {
            return res.status(400).json({ success: false, message: '마스터 파일이 누락되었습니다.' });
        }

        // 1. 파일에서 데이터 파싱 (메모리 효율적인 XLSX 사용)
        const data = await parseMasterExcel(req.file.buffer);
        console.log(`✅ [API] 마스터 파일 파싱 성공 (${data.length}건)`);

        // 2. DB에 즉시 동기화
        try {
            const pool = await getPool();
            await saveMasterDataToDb(data);
        } catch (e) {
            console.warn("⚠️ [API] 마스터 DB 동기화 대기 (연결 실패):", e.message);
        }

        // 3. 파일 유지 (백업용)
        const MASTER_DATA_FILE = path.join(DATA_DIR, 'product_master.xlsx');
        fs.writeFileSync(MASTER_DATA_FILE, req.file.buffer);

        res.json({
            success: true,
            message: '마스터 데이터가 성공적으로 DB와 동기화되었습니다.',
            masterData: data
        });
    } catch (err) {
        console.error("❌ 마스터 업로드 오류:", err);
        res.status(500).json({
            success: false,
            message: `마스터 파일을 처리하는 중 오류가 발생했습니다: ${err.message}`
        });
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
    try {
        const pool = await getPool();
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
    const { mapping } = req.body;
    if (!mapping) return res.status(400).json({ success: false, message: "데이터가 없습니다." });

    try {
        const pool = await getPool();
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
    try {
        const pool = await getPool();
        console.log("📂 [API] 자동분류 규칙 로드 중...");
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
        console.error("❌ [API] 규칙 로드 오류:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/sync/rules', async (req, res) => {
    const { rules } = req.body;
    if (!rules || !Array.isArray(rules)) return res.status(400).json({ success: false, message: "데이터가 올바르지 않습니다." });

    try {
        const pool = await getPool();
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

// 4. 컨테이너 보류(Hold) 클라우드 동기화
app.get('/api/sync/holds', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.query('SELECT cntr_no as "cntrNo", hold_reason as "reason" FROM container_holds ORDER BY created_at DESC');
        res.json({ success: true, holds: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/sync/holds', async (req, res) => {
    const { cntrNo, reason } = req.body;
    if (!cntrNo) return res.status(400).json({ success: false, message: "컨테이너 번호가 없습니다." });

    try {
        const pool = await getPool();
        await pool.query(
            'INSERT INTO container_holds (cntr_no, hold_reason) VALUES ($1, $2) ON CONFLICT (cntr_no) DO UPDATE SET hold_reason = EXCLUDED.hold_reason',
            [cntrNo.trim().toUpperCase(), reason || '']
        );
        res.json({ success: true, message: "보류 목록에 등록되었습니다." });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/sync/holds/:cntrNo', async (req, res) => {
    const { cntrNo } = req.params;
    if (!cntrNo) return res.status(400).json({ success: false, message: "컨테이너 번호가 없습니다." });

    try {
        const pool = await getPool();
        await pool.query('DELETE FROM container_holds WHERE cntr_no = $1', [cntrNo.trim().toUpperCase()]);
        res.json({ success: true, message: "보류가 해제되었습니다." });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. 제품 마스터 클라우드 동기화
app.get('/api/sync/product-master', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.query('SELECT prod_name as name, prod_type as type, weight, width, depth, height FROM product_master_sync ORDER BY prod_name ASC');
        res.json({ success: true, masterData: result.rows });
    } catch (err) {
        console.error("❌ 제품 마스터 다운로드 오류:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});
app.post('/api/sync/product-master', async (req, res) => {
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
        const pool = await getPool();
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
    const items = req.body.items;
    if (!items || !Array.isArray(items)) {
        return res.status(400).json({ success: false, message: "저장할 데이터가 없습니다." });
    }

    try {
        const pool = await getPool();
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

            // 2. 개별 품목(Item) 저장 (UPSERT 적용: 4가지 키가 같으면 업데이트)
            const insertQuery = `
                INSERT INTO container_results (
                    job_id, job_name, cntr_no, seal_no, prod_name, qty_plan, qty_load, 
                    qty_pending, qty_remain, qty_packing,
                    cntr_type, carrier, destination, weight_mixed, etd, eta, remark,
                    prod_type, division, dims, weight_orig, weight_down, transporter, 
                    adj1, adj1_color, adj2, saved_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, NOW())
                ON CONFLICT (job_name, cntr_no, prod_name, qty_plan) DO UPDATE SET
                    job_id = EXCLUDED.job_id,
                    seal_no = EXCLUDED.seal_no,
                    qty_load = EXCLUDED.qty_load,
                    qty_pending = EXCLUDED.qty_pending,
                    qty_remain = EXCLUDED.qty_remain,
                    qty_packing = EXCLUDED.qty_packing,
                    cntr_type = EXCLUDED.cntr_type,
                    carrier = EXCLUDED.carrier,
                    destination = EXCLUDED.destination,
                    weight_mixed = EXCLUDED.weight_mixed,
                    etd = EXCLUDED.etd,
                    eta = EXCLUDED.eta,
                    remark = EXCLUDED.remark,
                    prod_type = EXCLUDED.prod_type,
                    division = EXCLUDED.division,
                    dims = EXCLUDED.dims,
                    weight_orig = EXCLUDED.weight_orig,
                    weight_down = EXCLUDED.weight_down,
                    transporter = EXCLUDED.transporter,
                    adj1 = EXCLUDED.adj1,
                    adj1_color = EXCLUDED.adj1_color,
                    adj2 = EXCLUDED.adj2,
                    saved_at = NOW()
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
                    item.qtyInfo?.pending || 0,
                    item.qtyInfo?.remain || 0,
                    item.qtyInfo?.packing || 0,
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
                    item.adj1_color || item.adj1Color || '',
                    item.adj2 || ''
                ]);

                // 제품 마스터 사용 기록 업데이트 (last_used_at)
                if (item.prodName && item.prodName.trim() !== "") {
                    await client.query(
                        "UPDATE product_master_sync SET last_used_at = NOW() WHERE prod_name = $1",
                        [item.prodName.trim()]
                    );
                }
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
    try {
        const pool = await getPool();
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

        queryBase += " ORDER BY r.saved_at DESC, r.cntr_no ASC, r.id ASC";
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
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// DB 벌크 삭제 API
app.post('/api/db-bulk-delete', async (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: "삭제할 ID 목록이 없습니다." });
    }
    try {
        const pool = await getPool();
        await pool.query('DELETE FROM container_results WHERE id = ANY($1)', [ids]);
        res.json({ success: true, message: `${ids.length}건의 레코드가 삭제되었습니다.` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// DB 레코드 삭제 API
app.delete('/api/db-record/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await getPool();
        await pool.query('DELETE FROM container_results WHERE id = $1', [id]);
        res.json({ success: true, message: "레코드가 삭제되었습니다." });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// DB 레코드 수정 API
app.put('/api/db-record/:id', async (req, res) => {
    const { id } = req.params;
    const { cntr_no, prod_name, qty_plan, qty_load, cntr_type, carrier, destination, weight_mixed, adj1 } = req.body;
    try {
        const pool = await getPool();
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
    try {
        const pool = await getPool();
        const statsQuery = `
            SELECT 
                (SELECT COUNT(DISTINCT cntr_no) FROM container_results WHERE cntr_no IS NOT NULL AND cntr_no != '') as total_cntrs,
                (SELECT COUNT(*) FROM container_results) as total_items,
                (SELECT COUNT(*) FROM carrier_mappings) as total_carriers,
                (SELECT COUNT(*) FROM auto_classify_rules) as total_rules,
                (SELECT COUNT(*) FROM product_master_sync) as total_master,
                COALESCE(pg_size_pretty(
                    (SELECT COALESCE(pg_total_relation_size('container_results'), 0)) + 
                    (SELECT COALESCE(pg_total_relation_size('container_jobs'), 0)) +
                    (SELECT COALESCE(pg_total_relation_size('carrier_mappings'), 0)) +
                    (SELECT COALESCE(pg_total_relation_size('auto_classify_rules'), 0)) +
                    (SELECT COALESCE(pg_total_relation_size('product_master_sync'), 0))
                ), '0 KB') as total_size
        `;
        const result = await pool.query(statsQuery);
        res.json({ success: true, stats: result.rows[0] });
    } catch (err) {
        console.error("❌ DB 통계 조회 오류:", err.message);
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

// --- POP 샘플 무게 등록 API (DB 연동) ---
// GET: 전체 POP 무게 목록 반환
app.get('/api/pop-weights', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.query('SELECT cntr_no, weight, memo FROM container_pops');
        const data = {};
        result.rows.forEach(row => {
            data[row.cntr_no] = { weight: parseFloat(row.weight), memo: row.memo || '' };
        });
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST: POP 무게 등록/업데이트 { cntrNo, weight, memo }
app.post('/api/pop-weights', async (req, res) => {
    try {
        const pool = await getPool();
        const { cntrNo, weight, memo } = req.body;
        const key = (cntrNo || '').trim().toUpperCase();
        if (!key) return res.status(400).json({ success: false, message: '컨테이너 번호가 필요합니다.' });
        const w = parseFloat(weight);
        if (isNaN(w) || w <= 0) return res.status(400).json({ success: false, message: '올바른 무게를 입력해주세요.' });

        await pool.query(`
            INSERT INTO container_pops (cntr_no, weight, memo, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (cntr_no) DO UPDATE SET
                weight = EXCLUDED.weight,
                memo = EXCLUDED.memo,
                updated_at = NOW()
        `, [key, w, memo || '']);

        const result = await pool.query('SELECT cntr_no, weight, memo FROM container_pops');
        const data = {};
        result.rows.forEach(row => {
            data[row.cntr_no] = { weight: parseFloat(row.weight), memo: row.memo || '' };
        });

        console.log(`📦 [POP-DB] 등록: ${key} → +${w}kg`);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// DELETE: POP 무게 해제 ?cntrNo=XXXX
app.delete('/api/pop-weights', async (req, res) => {
    try {
        const pool = await getPool();
        const key = ((req.query.cntrNo || '')).trim().toUpperCase();
        if (!key) return res.status(400).json({ success: false, message: '컨테이너 번호가 필요합니다.' });

        await pool.query('DELETE FROM container_pops WHERE cntr_no = $1', [key]);

        const result = await pool.query('SELECT cntr_no, weight, memo FROM container_pops');
        const data = {};
        result.rows.forEach(row => {
            data[row.cntr_no] = { weight: parseFloat(row.weight), memo: row.memo || '' };
        });

        console.log(`🗑️ [POP-DB] 해제: ${key}`);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- Email Sending API ---
app.get('/api/email/config', (req, res) => {
    let config = { host: '', port: 465, secure: true, user: '', pass: '', from: '', toChunma: '', toBni: '', subjectChunma: '', subjectBni: '' };
    if (fs.existsSync(MAIL_CONFIG_FILE)) {
        try {
            config = JSON.parse(fs.readFileSync(MAIL_CONFIG_FILE, 'utf8'));
            if (config.pass) config.pass = '********'; // Mask password
        } catch (e) { }
    }
    res.json({ success: true, config });
});

app.post('/api/email/config', (req, res) => {
    const { host, port, secure, user, pass, from, toChunma, toBni } = req.body;
    let currentConfig = {};
    if (fs.existsSync(MAIL_CONFIG_FILE)) {
        try { currentConfig = JSON.parse(fs.readFileSync(MAIL_CONFIG_FILE, 'utf8')); } catch (e) { }
    }

    const newConfig = {
        host: host || currentConfig.host,
        port: port || currentConfig.port,
        secure: secure !== undefined ? secure : currentConfig.secure,
        user: user || currentConfig.user,
        pass: (pass && pass !== '********') ? pass : currentConfig.pass,
        from: from || currentConfig.from,
        toChunma: req.body.toChunma || '',
        toBni: req.body.toBni || '',
        subjectChunma: req.body.subjectChunma || '',
        subjectBni: req.body.subjectBni || ''
    };

    try {
        fs.writeFileSync(MAIL_CONFIG_FILE, JSON.stringify(newConfig, null, 2));
        res.json({ success: true, message: '이메일 설정이 저장되었습니다.' });
    } catch (e) {
        res.status(500).json({ success: false, message: '설정 저장 실패: ' + e.message });
    }
});

// --- 이메일 설정 클라우드 동기화 API ---
app.get('/api/sync/email-config', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.query("SELECT value FROM app_configs WHERE key = 'mail_config'");
        if (result.rows.length === 0) {
            return res.json({ success: false, message: "클라우드에 저장된 설정이 없습니다." });
        }
        res.json({ success: true, config: result.rows[0].value });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/sync/email-config', async (req, res) => {
    try {
        const pool = await getPool();
        // 실제 비밀번호가 포함된 로컬 파일 읽기
        if (!fs.existsSync(MAIL_CONFIG_FILE)) {
            return res.status(400).json({ success: false, message: "로컬 설정 파일이 없습니다." });
        }
        const config = JSON.parse(fs.readFileSync(MAIL_CONFIG_FILE, 'utf8'));

        await pool.query(`
            INSERT INTO app_configs (key, value, updated_at)
            VALUES ('mail_config', $1, NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `, [config]);

        res.json({ success: true, message: "이메일 설정이 클라우드에 업로드되었습니다." });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/send-email', async (req, res) => {
    const { to, subject, html } = req.body;

    if (!fs.existsSync(MAIL_CONFIG_FILE)) {
        return res.status(400).json({ success: false, message: '이메일 설정이 되어있지 않습니다.' });
    }

    try {
        const mailConfig = JSON.parse(fs.readFileSync(MAIL_CONFIG_FILE, 'utf8'));
        const transporter = nodemailer.createTransport({
            host: mailConfig.host,
            port: mailConfig.port,
            secure: mailConfig.secure,
            auth: {
                user: mailConfig.user,
                pass: mailConfig.pass
            }
        });

        const info = await transporter.sendMail({
            from: mailConfig.from || mailConfig.user,
            to,
            subject,
            html
        });

        console.log('📧 메일 발송 성공:', info.messageId);

        // --- 보낸 메일 DB 저장 로직 추가 ---
        try {
            const pool = await getPool();
            await pool.query(
                'INSERT INTO sent_emails (recipient, subject, content) VALUES ($1, $2, $3)',
                [to, subject || '(제목 없음)', html]
            );
            console.log('📝 보낸 메일이 DB에 저장되었습니다.');
        } catch (dbErr) {
            console.warn('⚠️ 보낸 메일 DB 저장 대기 (연결 실패):', dbErr.message);
            // 메일 발송 자체는 성공했으므로 응답에는 실패를 포함하지 않음
        }

        res.json({ success: true, message: '메일이 발송되었습니다.' });
    } catch (error) {
        console.error('❌ 메일 발송 실패:', error);
        res.status(500).json({ success: false, message: '발송 실패: ' + error.message });
    }
});

// --- 보낸 메일 이력 조회 API ---
app.get('/api/email/history', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.query('SELECT id, recipient, subject, sent_at FROM sent_emails ORDER BY sent_at DESC LIMIT 100');
        res.json({ success: true, history: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- 보낸 메일 상세 내용 조회 API ---
app.get('/api/email/history/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await getPool();
        const result = await pool.query('SELECT * FROM sent_emails WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "기록을 찾을 수 없습니다." });
        }
        res.json({ success: true, detail: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- 보낸 메일 기록 삭제 API ---
app.delete('/api/email/history/:id', async (req, res) => {
    if (!pool) return res.status(500).json({ success: false, message: "DB 모듈이 없습니다." });
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM sent_emails WHERE id = $1', [id]);
        res.json({ success: true, message: "기록이 삭제되었습니다." });
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

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 API 서버가 http://0.0.0.0:${port} 에서 실행 중입니다.`);
    console.log(`🌐 로컬 접속: http://localhost:${port}`);
    console.log(`📱 네트워크 접속: http://192.168.0.24:${port}`);
});
