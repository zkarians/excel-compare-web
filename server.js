const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const nodemailer = require('nodemailer');

let sharp = null;
try {
    sharp = require('sharp');
} catch (e) {
    try {
        sharp = require('C:/Program Files (x86)/CTNR/node_modules/sharp');
    } catch (e2) {
        console.warn('⚠️ [Server] Sharp 모듈을 로드하지 못했습니다:', e2.message);
    }
}

let google = null;
try {
    google = require('googleapis').google;
} catch (e) {
    try {
        google = require('C:/Program Files (x86)/CTNR/node_modules/googleapis').google;
    } catch (e2) {
        console.warn('⚠️ [Server] googleapis 모듈을 로드하지 못했습니다:', e2.message);
    }
}

let JSZip = null;
try {
    JSZip = require('jszip');
} catch (e) {
    try {
        JSZip = require('C:/Program Files (x86)/CTNR/node_modules/jszip');
    } catch (e2) {
        console.warn('⚠️ [Server] JSZip 모듈을 로드하지 못했습니다:', e2.message);
    }
}

// Google Drive OAuth 설정 (CTNR 앱 호환)
const GDRIVE_OAUTH_PATH = 'C:\\Program Files (x86)\\CTNR\\gdrive-oauth-client.json';
const GDRIVE_TOKEN_PATH = 'C:\\Program Files (x86)\\CTNR\\gdrive-token.json';
const GDRIVE_FOLDER_ID = '171usj8jgkHcdSO5YKopw0tJ0yhlwQ86_';

function getGoogleDriveClient() {
    if (!google) return null;
    if (!fs.existsSync(GDRIVE_OAUTH_PATH) || !fs.existsSync(GDRIVE_TOKEN_PATH)) return null;
    try {
        const rawOauth = fs.readFileSync(GDRIVE_OAUTH_PATH, 'utf8');
        const credentials = JSON.parse(rawOauth);
        const clientInfo = credentials.installed || credentials.web;
        const oauth2Client = new google.auth.OAuth2(clientInfo.client_id, clientInfo.client_secret);
        const rawToken = fs.readFileSync(GDRIVE_TOKEN_PATH, 'utf8');
        oauth2Client.setCredentials(JSON.parse(rawToken));
        return oauth2Client;
    } catch (e) {
        console.warn('⚠️ [GDrive] OAuth 클라이언트 초기화 실패:', e.message);
        return null;
    }
}

async function uploadToGoogleDrive(localFilePath, fileName, mimeType = 'image/jpeg', parentFolderId = GDRIVE_FOLDER_ID) {
    const auth = getGoogleDriveClient();
    if (!auth) throw new Error('Google Drive 인증 클라이언트를 생성할 수 없습니다.');
    const drive = google.drive({ version: 'v3', auth });
    const fileMetadata = {
        name: fileName,
        parents: [parentFolderId]
    };
    const media = {
        mimeType: mimeType,
        body: fs.createReadStream(localFilePath)
    };
    const response = await drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id, name, webViewLink, webContentLink'
    });
    const fileId = response.data.id;
    const gdriveUrl = `https://lh3.googleusercontent.com/d/${fileId}`;
    return {
        fileId,
        webViewLink: response.data.webViewLink,
        webContentLink: response.data.webContentLink,
        gdriveUrl
    };
}

async function renameGoogleDriveFile(fileId, newFileName) {
    const auth = getGoogleDriveClient();
    if (!auth) return false;
    try {
        const drive = google.drive({ version: 'v3', auth });
        await drive.files.update({
            fileId: fileId,
            requestBody: { name: newFileName }
        });
        return true;
    } catch (e) {
        console.warn(`[GDrive Rename Error] ${fileId}:`, e.message);
        return false;
    }
}

async function downloadFromGoogleDrive(fileId) {
    const auth = getGoogleDriveClient();
    if (!auth) throw new Error('Google Drive 인증 클라이언트를 생성할 수 없습니다.');
    const token = await auth.getAccessToken();
    if (!token || !token.token) throw new Error('Google Drive Access Token을 가져올 수 없습니다.');

    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${token.token}` }
    });
    if (!res.ok) throw new Error(`Google Drive 다운로드 실패 (${res.status} ${res.statusText})`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

async function findGoogleDriveFileByName(fileName) {
    const auth = getGoogleDriveClient();
    if (!auth) return null;
    try {
        const drive = google.drive({ version: 'v3', auth });
        const q = `'${GDRIVE_FOLDER_ID}' in parents and name = '${fileName}' and trashed = false`;
        const res = await drive.files.list({ q, fields: 'files(id, name)', pageSize: 1 });
        if (res.data.files && res.data.files.length > 0) {
            return { fileId: res.data.files[0].id, gdriveUrl: `https://lh3.googleusercontent.com/d/${res.data.files[0].id}` };
        }
    } catch (e) {
        console.warn(`[GDrive Search Warn] ${fileName}:`, e.message);
    }
    return null;
}

// Electron Writable Data Path - Web Server friendly fallback
const DATA_DIR = process.env.APP_DATA_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_CONFIG_FILE = path.join(DATA_DIR, 'db_config.json');
const MAIL_CONFIG_FILE = path.join(DATA_DIR, 'mail_config.json');

// pg re-integrated with safe error handling
let pool = null;
let isConnecting = false;
let currentDbConfig = {
    user: process.env.PGUSER || 'postgres',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'excel',
    password: process.env.PGPASSWORD || 'z456qwe12!@',
    port: Number(process.env.PGPORT) || 5432,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000, // 연결 시도 타임아웃 15초
    idleTimeoutMillis: 600000,    // 10분 동안 활동 없으면 연결 해제 (기존 5분에서 증가)
    max: 20,                       // 동시 연결 수 상향
    keepAlive: true,               // TCP Keep-Alive 활성화 (연결 끊김 방지 핵심)
    application_name: 'ExcelCompareApp'
};

const REMOTE_DB_CONFIG = {
    user: 'postgres',
    host: 'ungdong.iptime.org',
    database: 'excel',
    password: 'z456qwe12!@',
    port: 5432,
    ssl: false,
    connectionTimeoutMillis: 5000,
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

        // 연결 테스트 (단순 소켓 연결이 아닌 실제 쿼리 실행까지 확인)
        const client = await newPool.connect();
        try {
            const testRes = await client.query('SELECT 1');
            if (testRes.rowCount > 0) {
                console.log(`✅ [DB] 연결 및 쿼리 성공! (${currentDbConfig.host})`);
                pool = newPool; // 테스트 성공 시에만 전역 pool에 할당
                await initDb();
                return { success: true, message: `Connected to ${currentDbConfig.host} successfully.` };
            } else {
                throw new Error("정상적인 쿼리 결과를 받지 못했습니다.");
            }
        } finally {
            client.release();
        }
    } catch (err) {
        const configSummary = `Host: ${currentDbConfig.host}, Port: ${currentDbConfig.port}, User: ${currentDbConfig.user}, DB: ${currentDbConfig.database}`;
        console.error("❌ [DB] 초기 연결 및 테이블 생성 실패:", err.message);
        console.error("🔍 [DB] 사용된 설정:", configSummary);
        pool = null; // 실패 시 확실히 null 유지
        return { success: false, message: `${err.message} (${configSummary})` };
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
        await client.query(`ALTER TABLE carrier_mappings ADD COLUMN IF NOT EXISTS id SERIAL`);

        // 6. 작업 JOB 정보
        await client.query(`
            CREATE TABLE IF NOT EXISTS container_jobs (
                id SERIAL PRIMARY KEY,
                job_name TEXT,
                eta TEXT,
                etd TEXT,
                remark TEXT,
                saved_at TIMESTAMP DEFAULT NOW(),
                UNIQUE (job_name, eta, etd)
            )
        `);
        // 하위 호환성: 기존 테이블에 UNIQUE 제약 조건 추가 시도
        try {
            await client.query(`ALTER TABLE container_jobs ADD CONSTRAINT container_jobs_unique_key UNIQUE (job_name, eta, etd)`);
        } catch (e) { /* 이미 존재하거나 데이터 중복 시 무시 */ }

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
                work_date TEXT,
                UNIQUE (job_name, cntr_no, prod_name, qty_plan)
            )
        `);

        await client.query(`ALTER TABLE container_results ADD COLUMN IF NOT EXISTS adj2 TEXT`);
        await client.query(`ALTER TABLE container_results ADD COLUMN IF NOT EXISTS qty_pending INTEGER DEFAULT 0`);
        await client.query(`ALTER TABLE container_results ADD COLUMN IF NOT EXISTS qty_remain INTEGER DEFAULT 0`);
        await client.query(`ALTER TABLE container_results ADD COLUMN IF NOT EXISTS qty_packing INTEGER DEFAULT 0`);
        await client.query(`ALTER TABLE container_results ADD COLUMN IF NOT EXISTS work_date TEXT`);

        // UPSERT를 위한 유니크 인덱스 강제 생성 (이미 존재하면 건너뜀)
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_container_results_upsert 
            ON container_results (job_name, cntr_no, prod_name, qty_plan)
        `);

        // 8. ID 시퀀스 복구 및 동기화 (Self-healing)
        try {
            for (const tableName of ['container_jobs', 'container_results', 'sent_emails']) {
                const seqName = `${tableName}_id_seq`;
                const seqExists = await client.query(`SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'S'`, [seqName]);

                if (seqExists.rows.length === 0) {
                    await client.query(`CREATE SEQUENCE IF NOT EXISTS ${seqName}`);
                    console.log(`🏗️ [DB] 시퀀스 생성: ${seqName}`);
                }

                await client.query(`
                    DO $$ 
                    BEGIN 
                        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = '${tableName}' AND column_name = 'id' AND column_default IS NOT NULL) THEN
                            ALTER TABLE ${tableName} ALTER COLUMN id SET DEFAULT nextval('${seqName}');
                            ALTER SEQUENCE ${seqName} OWNED BY ${tableName}.id;
                        END IF;
                    END $$;
                `);

                const resSeq = await client.query(`SELECT pg_get_serial_sequence('${tableName}', 'id') as seq`);
                const actualSeq = (resSeq.rows[0] && resSeq.rows[0].seq) || seqName;
                await client.query(`SELECT setval('${actualSeq}', COALESCE((SELECT MAX(id) FROM ${tableName}), 0) + 1, false)`);
            }

            // UPSERT용 유니크 인덱스 보강
            await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_container_jobs_upsert ON container_jobs (job_name, eta, etd)`);
            await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_container_results_upsert ON container_results (job_name, cntr_no, prod_name, qty_plan)`);

        } catch (seqErr) {
            console.warn("⚠️ [DB] 시퀀스/인덱스 복구 중 경고:", seqErr.message);
        }

        console.log("✅ [DB] 모든 테이블 및 시퀀스 준비 완료");
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

// Electron Writable Data Path
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const RULES_FILE = path.join(DATA_DIR, 'rules.json');
const MAPPINGS_FILE = path.join(DATA_DIR, 'mapping_profiles.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const CAUTION_MODELS_FILE = path.join(DATA_DIR, 'caution_models.json');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || origin === 'null' || origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('file://') || origin.includes('cloudtype.app') || origin.includes('maizen.iptime.org')) {
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

app.get('/api/db/config', (req, res) => {
    const config = { ...currentDbConfig };
    if (config.password) config.password = '********';
    res.json({ success: true, config });
});

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
async function getColumns(pool, tableName) {
    try {
        const res = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [tableName]);
        return res.rows.map(r => r.column_name);
    } catch (e) { return []; }
}

async function syncData(sourceConfig, targetConfig, tables, options = {}) {
    const sourcePool = new Pool({ ...sourceConfig, connectionTimeoutMillis: 5000 });
    const targetPool = new Pool({ ...targetConfig, connectionTimeoutMillis: 5000 });
    const results = [];

    try {
        // [추가] 동기화 전 타겟 DB 제약조건 자동 보정 (Self-healing)
        try {
            console.log("[Sync] 타겟 DB 제약조건 보정 시도...");
            const pkQueries = [
                `ALTER TABLE product_master_sync ADD PRIMARY KEY (prod_name)`,
                `ALTER TABLE container_holds ADD PRIMARY KEY (cntr_no)`,
                `ALTER TABLE container_pops ADD PRIMARY KEY (cntr_no)`,
                `ALTER TABLE carrier_mappings ADD PRIMARY KEY (code)`,
                `ALTER TABLE auto_classify_rules ADD PRIMARY KEY (id)`,
                `ALTER TABLE app_configs ADD PRIMARY KEY (key)`,
                `ALTER TABLE sent_emails ADD PRIMARY KEY (id)`
            ];
            for (let q of pkQueries) {
                // 이미 존재하면 에러가 발생하지만, 무시하고 진행
                await targetPool.query(q).catch(() => { });
            }
            await targetPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_container_jobs_upsert ON container_jobs (job_name, eta, etd)`).catch(() => { });
            await targetPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_container_results_upsert ON container_results (job_name, cntr_no, prod_name, qty_plan)`).catch(() => { });
        } catch (e) {
            console.warn("⚠️ [Sync] 타겟 DB 제약조건 보정 중 오류 (무시됨):", e.message);
        }

        for (const tableName of tables) {
            console.log(`[Sync] Processing ${tableName}...`);
            // [추가] 동기화 전 타겟 DB 스키마 체크 및 보정 (특히 폰 환경의 carrier_mappings id 누락 방지)
            if (tableName === 'carrier_mappings') {
                await targetPool.query(`ALTER TABLE carrier_mappings ADD COLUMN IF NOT EXISTS id SERIAL`).catch(() => { });
            }
            try {
                let pk = 'id';
                if (tableName === 'product_master_sync') pk = 'prod_name';
                else if (tableName === 'container_holds' || tableName === 'container_pops') pk = 'cntr_no';
                else if (tableName === 'carrier_mappings') pk = 'code';
                else if (tableName === 'container_jobs') pk = 'job_name, eta, etd';
                else if (tableName === 'container_results') pk = 'job_name, cntr_no, prod_name, qty_plan';
                else if (tableName === 'app_configs') pk = 'key';
                const pkCols = pk.split(',').map(c => c.trim());

                // 컬럼 결정 (소스와 목적지 교집합)
                const srcCols = await getColumns(sourcePool, tableName);
                const dstCols = await getColumns(targetPool, tableName);
                let commonCols = srcCols.filter(c => dstCols.includes(c));

                // [추가] 자연 키(Natural Key)를 사용하는 주요 테이블은 동기화 시 id 제외 (기기마다 고유 ID가 충돌하는 것 방지)
                // 작업 리스트와 컨테이너 결과는 id가 아닌 자연 키를 사용하므로 id를 빼서 충돌을 방지합니다.
                if (tableName === 'container_jobs' || tableName === 'container_results') {
                    commonCols = commonCols.filter(c => c !== 'id');
                }
                // container_results는 부모 키인 job_id도 제외 (동기화 후 자동 복구 로직이 처리함)
                if (tableName === 'container_results') {
                    commonCols = commonCols.filter(c => c !== 'job_id');
                }

                if (commonCols.length === 0) {
                    results.push({ table: tableName, count: 0, success: true, message: 'No common columns found' });
                    continue;
                }

                let selectCols = commonCols.join(', ');

                // [추가] 증분 동기화 및 최신 데이터 판별을 위한 타임스탬프 컬럼 찾기
                const tsCol = dstCols.find(c => ['updated_at', 'saved_at', 'created_at', 'sent_at'].includes(c));

                let sourceWhere = '';
                if (options.incrementalOnly && tsCol) {
                    try {
                        const resMax = await targetPool.query(`SELECT MAX(${tsCol}) as last_sync FROM ${tableName}`);
                        const lastSync = resMax.rows[0].last_sync;
                        if (lastSync) {
                            const dateObj = new Date(lastSync);
                            if (!isNaN(dateObj.getTime())) {
                                sourceWhere = `WHERE ${tsCol} > '${dateObj.toISOString()}'`;
                            }
                        }
                    } catch (e) { }
                }

                let resSource = await sourcePool.query(`SELECT ${selectCols} FROM ${tableName} ${sourceWhere}`);
                let rows = resSource.rows;


                    let affectedCount = 0;
                    if (rows.length > 0) {
                        const columns = Object.keys(rows[0]); // commonCols와 같음
                        const colNames = columns.join(', ');
                        const nonPkColumns = columns.filter(c => !pkCols.includes(c.trim()));

                        const updateClause = nonPkColumns.map(c => `${c} = EXCLUDED.${c}`).join(', ');
                        const distinctCheckCols = nonPkColumns.map(c => `${tableName}.${c}`).join(', ');
                        const excludedCheckCols = nonPkColumns.map(c => `EXCLUDED.${c}`).join(', ');

                        // [개선] 데이터가 실제로 다르고 && 서브 데이터(EXCLUDED)의 타임스탬프가 현재 더 최신이거나 현재 값이 NULL인 경우에만 업데이트
                        let conflictWhere = nonPkColumns.length > 0
                            ? `WHERE (${distinctCheckCols}) IS DISTINCT FROM (${excludedCheckCols})`
                            : '';

                        // 증분 동기화(incrementalOnly)가 활성화된 경우에만 타임스탬프 기반 덮어쓰기 방지 작동
                        if (conflictWhere && tsCol && options && options.incrementalOnly) {
                            conflictWhere += ` AND (EXCLUDED.${tsCol} > ${tableName}.${tsCol} OR ${tableName}.${tsCol} IS NULL)`;
                        }

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

                            const query = `
                                INSERT INTO ${tableName} (${colNames}) 
                                VALUES ${placeholdersRows.join(', ')} 
                                ON CONFLICT (${pk}) 
                                DO UPDATE SET ${updateClause || `${pkCols[0]} = EXCLUDED.${pkCols[0]}`}
                                ${conflictWhere}
                            `;
                            const dbRes = await targetPool.query(query, values);
                            affectedCount += (dbRes.rowCount || 0);
                        }
                    }
                    results.push({ table: tableName, count: affectedCount, queriedCount: rows.length, success: true });

                // [추가] container_results 동기화 후 job_id 물리적 관계 복구
                if (tableName === 'container_results' && rows.length > 0) {
                    await targetPool.query(`
                        UPDATE container_results r
                        SET job_id = j.id
                        FROM container_jobs j
                        WHERE r.job_name = j.job_name AND r.eta = j.eta AND r.etd = j.etd
                        AND r.job_id IS DISTINCT FROM j.id
                    `);
                    console.log(`[Sync] Restored job_id relationships for container_results`);
                }
            } catch (err) {
                console.error(`[Sync] Error in ${tableName}:`, err.message);
                results.push({ table: tableName, error: err.message, success: false });
            }
        }

        // 시퀀스 갱신
        const serialTables = ['container_jobs', 'container_results', 'sent_emails'];
        for (const tableName of serialTables) {
            try {
                const resSeq = await targetPool.query(`SELECT pg_get_serial_sequence('${tableName}', 'id') as seq`);
                if (resSeq.rows[0] && resSeq.rows[0].seq) {
                    await targetPool.query(`SELECT setval('${resSeq.rows[0].seq}', COALESCE((SELECT MAX(id) FROM ${tableName}), 0) + 1, false)`);
                }
            } catch (e) { }
        }
    } finally {
        await sourcePool.end().catch(() => { });
        await targetPool.end().catch(() => { });
    }
    return results;
}


const CLOUD_CONFIG = {
    user: 'root', host: 'svc.sel3.cloudtype.app', database: 'excel_compare',
    password: 'z456qwe12!@', port: 30554, ssl: false
};

app.post('/api/db/sync', async (req, res) => {
    const { direction, phoneConfig, pcConfig, tables, options } = req.body || {};
    const targetTables = tables || [
        'product_master_sync', 'container_holds', 'container_pops',
        'carrier_mappings', 'auto_classify_rules', 'container_jobs', 'container_results',
        'sent_emails', 'app_configs'
    ];

    // 클라이언트에서 보낸 하드코딩된 pcConfig 대신 현재 앱이 연결된 DB(currentDbConfig)를 동기화 대상으로 사용
    const LOCAL_PC = currentDbConfig || pcConfig || { host: 'localhost', user: 'postgres', port: 5432, database: 'excel', password: 'z456qwe12!@', ssl: false };

    let source, target;
    if (direction === 'to_phone') {
        source = CLOUD_CONFIG; target = phoneConfig;
    } else if (direction === 'to_cloud') {
        source = phoneConfig; target = CLOUD_CONFIG;
    } else if (direction === 'pc_to_cloud') {
        source = LOCAL_PC; target = CLOUD_CONFIG;
    } else if (direction === 'cloud_to_pc') {
        source = CLOUD_CONFIG; target = LOCAL_PC;
    } else if (direction === 'pc_to_phone') {
        source = LOCAL_PC; target = phoneConfig;
    } else if (direction === 'phone_to_pc') {
        source = phoneConfig; target = LOCAL_PC;
    } else {
        return res.status(400).json({ success: false, message: `알 수 없는 direction: ${direction}` });
    }

    try {
        const syncResults = await syncData(source, target, targetTables, options);
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
    const configInfo = `Host: ${currentDbConfig.host}, DB: ${currentDbConfig.database}, User: ${currentDbConfig.user}`;
    if (!pool) {
        return res.json({ success: false, message: `DB 클라이언트 초기화 실패 (${configInfo})` });
    }
    try {
        const client = await pool.connect();
        client.release();
        res.json({ success: true, message: `DB 연결 성공 (${currentDbConfig.host})` });
    } catch (err) {
        res.json({ success: false, message: `DB 연결 실패: ${err.message} (${configInfo})` });
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
        console.log(`📂[API] 파일 읽기 요청: \n - 원본: ${origPath} \n - 전산: ${downPath} \n - 재작업: ${reworkPath || "없음"} `);

        let originalData = await parseOriginalExcel(origPath);
        console.log(`✅[API] 원본 데이터 파싱 완료: ${originalData.length} 건`);

        // 재작업 파일이 있으면 추가 파싱하여 합침
        if (reworkPath && reworkPath.trim() !== "") {
            console.log(`🔍[API] 재작업 경로 처리 시도: "${reworkPath}"`);
            if (fs.existsSync(reworkPath)) {
                console.log(`📂[API] 재작업 파일 실존 확인됨.파싱 시작...`);
                const reworkData = await parseOriginalExcel(reworkPath, ["재작업당일"], "rework");
                console.log(`✅[API] 재작업 데이터 파싱 완료: ${reworkData.length} 건`);
                originalData = originalData.concat(reworkData);
            } else {
                console.error(`❌[API] 재작업 파일 경로를 찾을 수 없음: "${reworkPath}"`);
            }
        } else {
            console.log(`ℹ️[API] 재작업 경로가 입력되지 않았습니다.`);
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
        res.status(500).json({ success: false, message: `파일을 읽을 수 없습니다: ${err.message} ` });
    }
});

// 파일 업로드 기반 읽기 엔드포인트
app.post('/api/upload-excel', upload.fields([{ name: 'originalFile' }, { name: 'downloadFile' }, { name: 'reworkFile' }]), async (req, res) => {
    try {
        console.log(`📂[API] 파일 업로드 파싱 요청`);

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
        res.status(500).json({ success: false, message: `파일을 업로드하고 파싱하는 중 오류가 발생했습니다: ${err.message} ` });
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
        console.error(`❌ 최근 ${req.query.type} 파일 로드 오류: `, err);
        res.status(500).json({ success: false, message: `파일 로드 중 오류 발생: ${err.message} ` });
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
            return res.status(404).json({ success: false, message: `파일을 찾을 수 없습니다: ${filePath} ` });
        }

        const fileBuffer = fs.readFileSync(filePath);
        const base64 = fileBuffer.toString('base64');
        const fileName = path.basename(filePath);

        console.log(`📂[API] Raw 파일 로드: ${filePath} (${(fileBuffer.length / 1024).toFixed(1)}KB)`);
        res.json({ success: true, base64, fileName });
    } catch (err) {
        console.error(`❌ Raw 파일 로드 오류: `, err);
        res.status(500).json({ success: false, message: `파일 로드 중 오류 발생: ${err.message} ` });
    }
});

// 특정 폴더에서 가장 최신 엑셀 파일(EXPORT_...) 찾아서 전산용으로 자동 로드
app.get('/api/load-latest-from-dir', async (req, res) => {
    try {
        let dirPath = req.query.dirPath ? req.query.dirPath.trim() : '';

        // 경로가 비어있거나 'undefined'/'null'인 경우 마지막 로딩 폴더 폴백 (W:\helpdesk\Downloads 우선)
        if (!dirPath || dirPath === 'null' || dirPath === 'undefined' || dirPath.startsWith('선택된 파일:')) {
            if (fs.existsSync('W:\\helpdesk\\Downloads')) {
                dirPath = 'W:\\helpdesk\\Downloads';
            } else {
                dirPath = path.join(os.homedir(), 'Downloads');
            }
        }

        if (!fs.existsSync(dirPath)) {
            return res.status(404).json({ success: false, message: `입력된 폴더 경로를 찾을 수 없습니다: ${dirPath}` });
        }

        const files = fs.readdirSync(dirPath).filter(f => 
            (f.toLowerCase().endsWith('.xlsx') || f.toLowerCase().endsWith('.xls') || f.toLowerCase().endsWith('.xlsm')) && 
            !f.startsWith('~') && 
            !f.startsWith('.')
        );

        if (files.length === 0) {
            return res.status(404).json({ success: false, message: `'${dirPath}' 폴더에 엑셀 파일이 없습니다.` });
        }

        // 가장 최근에 수정/생성된 파일 찾기
        let latestFile = null;
        let latestTime = 0;

        for (const file of files) {
            try {
                const filePath = path.join(dirPath, file);
                const stats = fs.statSync(filePath);
                const fileTime = Math.max(stats.mtimeMs || 0, stats.birthtimeMs || 0);
                if (fileTime > latestTime) {
                    latestTime = fileTime;
                    latestFile = {
                        name: file,
                        path: filePath
                    };
                }
            } catch (e) {}
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
            fullPath: latestFile.path,
            dirPath: dirPath
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

        const rawName = fileName || '비교결과.xlsx';
        const ext = path.extname(rawName) || '.xlsx';
        const baseName = path.basename(rawName, ext);

        // 시간(밀리초) 및 난수 기반 고유 파일명 생성 -> 기존에 엑셀이 열려 있어도 잠금 충돌(EBUSY) 없이 즉시 새 창으로 열림
        const now = new Date();
        const timeTag = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}_${now.getMilliseconds()}`;
        const uniqueFileName = `${baseName}_${timeTag}${ext}`;
        const filePath = path.join(UPLOADS_DIR, uniqueFileName);
        const fileBuffer = Buffer.from(buffer, 'base64');

        if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        fs.writeFileSync(filePath, fileBuffer);
        console.log(`📂 [API] 자동 열기용 고유 임시 파일 저장: ${filePath}`);

        // 시스템 기본 프로그램으로 파일 열기 (Windows: start, Mac: open, Linux: xdg-open)
        const command = process.platform === 'win32' ? `start "" "${filePath}"` :
            process.platform === 'darwin' ? `open "${filePath}"` :
                `xdg-open "${filePath}"`;

        exec(command, (err) => {
            if (err) {
                console.error("❌ 파일 자동 열기 실패:", err);
            }
        });

        // 3시간 이상 지난 이전 임시 파일(auto_open_*.xlsx) 비동기 정리
        setTimeout(() => {
            try {
                const cutoff = Date.now() - 3 * 3600 * 1000;
                fs.readdir(UPLOADS_DIR, (rErr, files) => {
                    if (rErr || !files) return;
                    files.forEach(f => {
                        if (f.startsWith('auto_open_') || f.includes('_2026')) {
                            const p = path.join(UPLOADS_DIR, f);
                            fs.stat(p, (sErr, st) => {
                                if (!sErr && st && st.mtimeMs < cutoff) {
                                    fs.unlink(p, () => {});
                                }
                            });
                        }
                    });
                });
            } catch (cleanErr) {}
        }, 1000);

        res.json({ success: true, message: "파일이 생성되었고 열기 명령을 전달했습니다.", filePath });
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

        console.log(`📂[API] 파일 경로 열기 요청: ${filePath} `);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: "파일이 존재하지 않습니다." });
        }

        const command = process.platform === 'win32' ? `start "" "${filePath}"` :
            process.platform === 'darwin' ? `open "${filePath}"` :
                `xdg - open "${filePath}"`;

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
        console.log(`📡[API] 마스터 데이터 조회 요청(DB 우선)`);

        let masterData = [];
        let fetchedFromDb = false;

        if (pool) {
            try {
                const result = await pool.query('SELECT prod_name as name, prod_type as "prodType", weight, width, depth, height, cbm, last_used_at as "lastUsedAt" FROM product_master_sync ORDER BY prod_name ASC');
                masterData = result.rows;
                fetchedFromDb = true;
                console.log(`🐘[DB] 제품 마스터 ${masterData.length}건 조회 완료`);
            } catch (dbErr) {
                console.error("❌ [DB] 제품 마스터 조회 실패 (파일 폴백 시도):", dbErr.message);
                // DB 조회 실패 시 에러를 던지지 않고 파일 폴백으로 넘어감
            }
        }

        // DB 조회에 실패했거나 데이터가 없는 경우 파일에서 읽어옴
        if (masterData.length === 0) {
            try {
                console.log(`📂[API] DB에 데이터가 없거나 조회 실패하여 파일에서 파싱을 시도합니다.`);
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

        // 데이터가 0건이더라도 에러(503)를 반환하지 않고, 빈 배열을 반환하여
        // 프론트엔드에서 '0건 로드 완료'로 정상 표시되도록 수정함.
        if (masterData.length === 0) {
            console.warn("⚠️ [API] DB 및 파일 모두에 제품 마스터 데이터가 없습니다 (0건).");
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
    console.log(`🐘[DB] 마스터 데이터 저장 시작(총 ${finalData.length}건)`);

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
                ON CONFLICT(prod_name) DO UPDATE SET
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
        console.log(`✅[DB] 마스터 데이터 ${finalData.length}건 동기화 완료(Upsert)`);
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
            INSERT INTO product_master_sync(prod_name, prod_type, weight, width, depth, height, cbm, updated_at, last_used_at)
        VALUES($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
            ON CONFLICT(prod_name) DO UPDATE 
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
        console.log(`📂[API] 마스터 데이터 업데이트 요청(DB 저장 방식)`);
        if (!req.file) {
            return res.status(400).json({ success: false, message: '마스터 파일이 누락되었습니다.' });
        }

        // 1. 파일에서 데이터 파싱 (메모리 효율적인 XLSX 사용)
        const data = await parseMasterExcel(req.file.buffer);
        console.log(`✅[API] 마스터 파일 파싱 성공(${data.length}건)`);

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
            message: `마스터 파일을 처리하는 중 오류가 발생했습니다: ${err.message} `
        });
    }
});

// 클라이언트가 파싱/매핑한 JSON 데이터로 마스터 DB 동적 업데이트
app.post('/api/upsert-master-json', async (req, res) => {
    try {
        console.log(`📂[API] 마스터 데이터 동적 매핑 업데이트 요청 수신`);
        const { data } = req.body;
        
        if (!data || !Array.isArray(data)) {
            return res.status(400).json({ success: false, message: '유효한 JSON 배열 데이터가 없습니다.' });
        }

        const pool = await getPool();
        let insertCnt = 0;
        let updateCnt = 0;
        let skipCnt = 0;

        // 기존 데이터 가져와서 비교용 맵 생성
        const { rows: existingRows } = await pool.query('SELECT * FROM product_master_sync');
        const dbMap = new Map();
        existingRows.forEach(r => dbMap.set(r.prod_name, r));

        for (const item of data) {
            const prod_name = item.prod_name?.toString().trim();
            if (!prod_name) continue;

            const business_unit = item.business_unit?.toString().trim() || '';
            const prod_type = item.prod_type?.toString().trim() || '';
            const width = parseFloat(item.width) || 0;
            const height = parseFloat(item.height) || 0;
            const depth = parseFloat(item.depth) || 0;
            const weight = parseFloat(item.weight) || 0;
            const cbm = parseFloat(item.cbm) || 0;

            const existing = dbMap.get(prod_name);

            if (!existing) {
                await pool.query(`
                    INSERT INTO product_master_sync 
                    (prod_name, business_unit, prod_type, width, height, depth, weight, cbm, updated_at) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                `, [prod_name, business_unit, prod_type, width, height, depth, weight, cbm]);
                insertCnt++;
            } else {
                const isChanged = 
                    (existing.business_unit || '') !== business_unit ||
                    (existing.prod_type || '') !== prod_type ||
                    Number(existing.width || 0) !== width ||
                    Number(existing.height || 0) !== height ||
                    Number(existing.depth || 0) !== depth ||
                    Number(existing.weight || 0) !== weight ||
                    Number(existing.cbm || 0) !== cbm;

                if (isChanged) {
                    await pool.query(`
                        UPDATE product_master_sync 
                        SET business_unit = $2, prod_type = $3, 
                            width = $4, height = $5, depth = $6, weight = $7, cbm = $8,
                            updated_at = NOW()
                        WHERE prod_name = $1
                    `, [prod_name, business_unit, prod_type, width, height, depth, weight, cbm]);
                    updateCnt++;
                } else {
                    skipCnt++;
                }
            }
        }

        console.log(`✅ [API] 마스터 동적 매핑 업데이트 완료 (신규:${insertCnt}, 업데이트:${updateCnt}, 스킵:${skipCnt})`);
        
        // 새로고침용 최신 데이터 반환
        const { rows: latestRows } = await pool.query('SELECT * FROM product_master_sync');
        // 클라이언트에서 사용하는 형식(name, weight, width...)으로 변환
        const formattedData = latestRows.map(r => ({
            name: r.prod_name,
            weight: Number(r.weight) || 0,
            width: Number(r.width) || 0,
            depth: Number(r.depth) || 0,
            height: Number(r.height) || 0,
            cbm: Number(r.cbm) || 0,
            prodType: r.prod_type || '-'
        }));

        res.json({
            success: true,
            message: `업데이트 완료 (신규: ${insertCnt}, 갱신: ${updateCnt}, 변동없음: ${skipCnt})`,
            masterData: formattedData,
            stats: { insertCnt, updateCnt, skipCnt }
        });

    } catch (err) {
        console.error("❌ 마스터 동적 업로드 오류:", err);
        res.status(500).json({ success: false, message: `DB 업데이트 중 오류 발생: ${err.message}` });
    }
});

// 규칙 로드 API
app.get('/api/rules', async (req, res) => {
    try {
        let rules = [];
        let fetchedFromDb = false;

        try {
            const pool = await getPool();
            const dbRes = await pool.query("SELECT value FROM app_configs WHERE key = 'rules'");
            if (dbRes.rows[0] && dbRes.rows[0].value) {
                rules = JSON.parse(dbRes.rows[0].value);
                fetchedFromDb = true;
                fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf8');
            }
        } catch (dbErr) {
            console.warn("⚠️ [DB] 규칙 DB 조회 실패 (파일 폴백):", dbErr.message);
        }

        if (!fetchedFromDb) {
            if (fs.existsSync(RULES_FILE)) {
                const data = fs.readFileSync(RULES_FILE, 'utf8');
                try {
                    const parsed = JSON.parse(data);
                    rules = Array.isArray(parsed) ? parsed : (parsed.rules || []);
                } catch (e) { }
            }
        }

        res.json({ success: true, rules });
    } catch (err) {
        res.status(500).json({ success: false, message: "규칙을 불러올 수 없습니다." });
    }
});

// 규칙 저장 API
app.post('/api/rules', async (req, res) => {
    try {
        const rules = req.body.rules || req.body;
        fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf8');

        try {
            const pool = await getPool();
            await pool.query(`
                INSERT INTO app_configs (key, value, updated_at)
                VALUES ('rules', $1, NOW())
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
            `, [JSON.stringify(rules)]);
        } catch (dbErr) {
            console.warn("⚠️ [DB] 규칙 DB 저장 실패 (로컬 파일만 저장됨):", dbErr.message);
        }

        res.json({ success: true, message: "규칙이 성공적으로 저장되었습니다." });
    } catch (err) {
        res.status(500).json({ success: false, message: "규칙 저장에 실패했습니다." });
    }
});

// 주의 모델 로드 API
app.get('/api/caution-models', async (req, res) => {
    try {
        let models = [];
        let fetchedFromDb = false;

        try {
            const pool = await getPool();
            const dbRes = await pool.query("SELECT value FROM app_configs WHERE key = 'caution_models'");
            if (dbRes.rows[0] && dbRes.rows[0].value) {
                models = JSON.parse(dbRes.rows[0].value);
                fetchedFromDb = true;
                fs.writeFileSync(CAUTION_MODELS_FILE, JSON.stringify(models, null, 2), 'utf8');
            }
        } catch (dbErr) {
            console.warn("⚠️ [DB] 주의 모델 DB 조회 실패 (파일 폴백):", dbErr.message);
        }

        if (!fetchedFromDb) {
            if (fs.existsSync(CAUTION_MODELS_FILE)) {
                const data = fs.readFileSync(CAUTION_MODELS_FILE, 'utf8');
                try {
                    const parsed = JSON.parse(data);
                    models = Array.isArray(parsed) ? parsed : (parsed.models || []);
                } catch (e) { }
            }
        }

        res.json({ success: true, models });
    } catch (err) {
        res.status(500).json({ success: false, message: "주의 모델 목록을 불러올 수 없습니다." });
    }
});

// 주의 모델 저장 API
app.post('/api/caution-models', async (req, res) => {
    try {
        const models = req.body.models || req.body;
        fs.writeFileSync(CAUTION_MODELS_FILE, JSON.stringify(models, null, 2), 'utf8');

        try {
            const pool = await getPool();
            await pool.query(`
                INSERT INTO app_configs (key, value, updated_at)
                VALUES ('caution_models', $1, NOW())
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
            `, [JSON.stringify(models)]);
        } catch (dbErr) {
            console.warn("⚠️ [DB] 주의 모델 DB 저장 실패 (로컬 파일만 저장됨):", dbErr.message);
        }

        res.json({ success: true, message: "주의 모델 목록이 성공적으로 저장되었습니다." });
    } catch (err) {
        res.status(500).json({ success: false, message: "주의 모델 목록 저장에 실패했습니다." });
    }
});

// 매핑 로드 API
app.get('/api/mappings', (req, res) => {
    try {
        if (!fs.existsSync(MAPPINGS_FILE)) {
            return res.json({ success: true, profiles: null });
        }
        const data = fs.readFileSync(MAPPINGS_FILE, 'utf8');
        try {
            const parsed = JSON.parse(data);
            res.json({ success: true, ...parsed });
        } catch (e) {
            res.json({ success: true, profiles: null });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "매핑 설정을 불러오지 못했습니다." });
    }
});

// 매핑 저장 API
app.post('/api/mappings', (req, res) => {
    try {
        fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(req.body, null, 2), 'utf8');
        res.json({ success: true, message: "매핑 설정이 성공적으로 저장되었습니다." });
    } catch (err) {
        res.status(500).json({ success: false, message: "매핑 설정 저장에 실패했습니다." });
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

// 1-2. 목적지(도착지) 매핑 클라우드 동기화
app.get('/api/sync/destinations', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.query("SELECT config_value FROM app_configs WHERE config_key = 'destination_mappings'");
        if (result.rows.length > 0) {
            const mapping = typeof result.rows[0].config_value === 'string' ? JSON.parse(result.rows[0].config_value) : result.rows[0].config_value;
            return res.json({ success: true, mapping });
        }
        res.json({ success: true, mapping: {} });
    } catch (err) {
        res.json({ success: false, message: err.message, mapping: {} });
    }
});

app.post('/api/sync/destinations', async (req, res) => {
    const { mapping } = req.body;
    if (!mapping) return res.status(400).json({ success: false, message: "데이터가 없습니다." });

    try {
        const pool = await getPool();
        await pool.query(
            "INSERT INTO app_configs (config_key, config_value, updated_at) VALUES ('destination_mappings', $1, NOW()) ON CONFLICT (config_key) DO UPDATE SET config_value = $1, updated_at = NOW()",
            [JSON.stringify(mapping)]
        );
        res.json({ success: true, message: "목적지 매핑이 저장되었습니다." });
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
        VALUES($1, $2, $3, $4, $5, $6, $7, $8)
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
    console.log(`📡[Sync] 제품 마스터 동기화 시작(원본: ${masterData.length}건, 중복제거 후: ${finalData.length}건)`);

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
                    ON CONFLICT(prod_name) DO UPDATE SET
    prod_type = EXCLUDED.prod_type,
        weight = EXCLUDED.weight,
        width = EXCLUDED.width,
        depth = EXCLUDED.depth,
        height = EXCLUDED.height,
        updated_at = NOW()
            `;
                await client.query(query, values);
                console.log(`📦[Sync] ${Math.min(i + BATCH_SIZE, finalData.length)} / ${finalData.length} 건 처리 완료...`);
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
    const enableRemoteSync = req.body.enableRemoteSync !== false; // 기본값 true
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
                const jobKey = `${item.jobName || ''}_${item.eta || ''}_${item.etd || ''}`;
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
                    "SELECT id FROM container_jobs WHERE job_name = $1 AND eta = $2 AND etd = $3 ORDER BY saved_at DESC LIMIT 1",
                    [job.jobName, job.eta, job.etd]
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
                    adj1, adj1_color, adj2, work_date, saved_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, NOW())
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
                    work_date = EXCLUDED.work_date,
                    saved_at = NOW()
            `;

            for (const item of items) {
                const jobKey = `${item.jobName || ''}_${item.eta || ''}_${item.etd || ''}`;
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
                    item.adj2 || '',
                    item.workDate || null
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

            // --- 원격 DB 동기화 (추가) ---
            let remoteSyncMessage = "";
            if (!enableRemoteSync) {
                console.log("⏭️ [Remote DB] 원격 동기화 비활성화 상태 - 건너뜀");
                remoteSyncMessage = " (원격 DB 동기화 OFF)";
            } else try {
                const remotePool = new Pool(REMOTE_DB_CONFIG);
                const remoteClient = await remotePool.connect();
                try {
                    await remoteClient.query('BEGIN');
                    // 로컬과 동일한 로직으로 저장 (이미 insertQuery와 jobIdsMap은 준비됨)
                    for (const [key, job] of jobsMap.entries()) {
                        const jobCheck = await remoteClient.query(
                            "SELECT id FROM container_jobs WHERE job_name = $1 AND eta = $2 AND etd = $3 ORDER BY saved_at DESC LIMIT 1",
                            [job.jobName, job.eta, job.etd]
                        );
                        let jobId;
                        if (jobCheck.rows.length > 0) jobId = jobCheck.rows[0].id;
                        else {
                            const jobInsert = await remoteClient.query(
                                "INSERT INTO container_jobs (job_name, eta, etd, remark) VALUES ($1, $2, $3, $4) RETURNING id",
                                [job.jobName, job.eta, job.etd, job.remark]
                            );
                            jobId = jobInsert.rows[0].id;
                        }
                        jobIdsMap.set(key, jobId); // 원격용 jobId로 맵 업데이트
                    }

                    for (const item of items) {
                        const jobKey = `${item.jobName || ''}_${item.eta || ''}_${item.etd || ''}`;
                        const jobId = jobIdsMap.get(jobKey);
                        await remoteClient.query(insertQuery, [
                            jobId, item.jobName || '', item.cntrNo || '', item.sealNo || '', item.prodName || '',
                            item.qtyInfo?.plan || 0, item.qtyInfo?.load || 0, item.qtyInfo?.pending || 0,
                            item.qtyInfo?.remain || 0, item.qtyInfo?.packing || 0, item.cntrType?.val || '',
                            item.carrierName?.val || '', item.destination?.val || '', item.weights?.mixed || 0,
                            item.etd || '', item.eta || '', item.origRemark || '', item.prodType || '',
                            item.division || '', item.dims || '', item.weights?.orig || 0, item.weights?.down || 0,
                            item.transporter || '', item.adj1 || '', item.adj1_color || item.adj1Color || '',
                            item.adj2 || '', item.workDate || null
                        ]);
                    }
                    await remoteClient.query('COMMIT');
                    console.log("✅ [Remote DB] 동기화 성공");
                } catch (remoteErr) {
                    await remoteClient.query('ROLLBACK');
                    console.error("❌ [Remote DB] 저장 오류:", remoteErr.message);
                    remoteSyncMessage = " (원격 DB 저장 실패)";
                } finally {
                    remoteClient.release();
                    await remotePool.end();
                }
            } catch (connErr) {
                console.error("❌ [Remote DB] 연결 오류:", connErr.message);
                remoteSyncMessage = " (원격 DB 연결 실패)";
            }

            res.json({ success: true, count: items.length, message: `성공${remoteSyncMessage}` });
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
        LEFT JOIN container_jobs j ON r.job_name = j.job_name AND r.eta = j.eta AND r.etd = j.etd
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

// 17-01 ~ 17-03 로케이션 식별 헬퍼 함수
function checkIs17Loc(locationVal) {
    if (!locationVal) return false;
    const loc = String(locationVal).trim().toUpperCase();
    
    // 1. 단순 시작 패턴 (예: "17-01", "17-02-A" 등)
    if (loc.startsWith('17-01') || loc.startsWith('17-02') || loc.startsWith('17-03')) {
        return true;
    }
    
    // 2. 구분자 분할 패턴 (예: "24-1-17-02-0" -> parts[2]="17", parts[3]="02")
    const parts = loc.split('-');
    if (parts.length >= 4) {
        const rowCol = parts[2] + '-' + parts[3];
        if (rowCol === '17-01' || rowCol === '17-02' || rowCol === '17-03') {
            return true;
        }
    }
    
    // 3. 포함 패턴 (예: "-17-01-", "-17-02-", "-17-03-")
    if (loc.includes('-17-01-') || loc.includes('-17-02-') || loc.includes('-17-03-')) {
        return true;
    }
    
    return false;
}

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

        // G열(7번째 열) 제품명 + H열(8번째 열) Physical Qty + I열(9번째 열) Available Qty + O열(15번째 열) OQC BLOCK + P열(16번째 열) Long Term + Q열(17번째 열) Bin 수집 및 합산
        const productNamesInWarehouse = new Set();
        
        // 17 제외 데이터 (기본)
        const blockProductNames = new Set(); // 17 제외 Block Qty > 0 인 제품명 세트
        const stockMap = {}; // 17 제외 제품명별 재고 합산 맵 { name: { physical, block, oqc, longTerm, bin, available } }
        const holdStockList = []; // 17 제외 블록 수량이 존재하는 로케이션별 상세 리스트
        const allStockList = []; // 17 제외 모든 제품의 로케이션별 상세 리스트 (새로 추가)

        // 17 포함 데이터 (전체)
        const blockProductNamesWith17 = new Set(); // 전체 Block Qty > 0 인 제품명 세트
        const stockMapWith17 = {}; // 전체 제품명별 재고 합산 맵
        const holdStockListWith17 = []; // 전체 블록 수량이 존재하는 로케이션별 상세 리스트
        const allStockListWith17 = []; // 전체 모든 제품의 로케이션별 상세 리스트 (새로 추가)

        // 동적 헤더 인덱스 매핑 (기본값 설정)
        let colIdxDivision = 1;  // A열 BA
        let colIdxLocation = 2;  // B열 Bin
        let colIdxModel = 7;     // G열 Model
        let colIdxPhysical = 8;  // H열 Physical Qty
        let colIdxAvailable = 9; // I열 Avl.Qty
        let colIdxPending = 13;  // M열 Pending
        let colIdxOqc = 15;      // O열 OQC Block
        let colIdxLongTerm = 16; // P열 L.Term Block
        let colIdxBin = 17;      // Q열 Bin Block

        const headerRow = worksheet.getRow(1);
        headerRow.eachCell((cell, colNum) => {
            const h = String(cell.value || '').trim().toLowerCase();
            if (h === 'model' || h === '모델' || h === '모델명' || h === '품목코드') colIdxModel = colNum;
            else if (h === 'bin' || h === 'location' || h === '로케이션' || h === 'storage bin') colIdxLocation = colNum;
            else if (h === 'ba' || h === 'division' || h === '사업부') colIdxDivision = colNum;
            else if (h === 'physical qty' || h === 'physical' || h === '전체수량' || h === '실물수량') colIdxPhysical = colNum;
            else if (h === 'avl.qty' || h === 'available qty' || h === '가용수량' || h === '사용가능수량') colIdxAvailable = colNum;
            else if (h === 'pending' || h === '팬딩' || h === '팬딩수량') colIdxPending = colNum;
            else if (h.includes('oqc block') || h === 'oqc' || h.includes('oqc hold')) colIdxOqc = colNum;
            else if (h.includes('term block') || h.includes('long term') || h.includes('l.term')) colIdxLongTerm = colNum;
            else if (h.includes('bin block') || h.includes('bin blk') || h.includes('binblock')) colIdxBin = colNum;
        });

        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber <= 1) return; // 헤더 스킵

            // 모델명 (제품명)
            const cellModel = row.getCell(colIdxModel);
            const val = cellModel.text || String(cellModel.value || '');
            const name = val.trim().toUpperCase();

            if (!name || !name.includes('.')) return;

            productNamesInWarehouse.add(name);

            // 로케이션명
            const locationVal = String(row.getCell(colIdxLocation).value || '').trim();
            const is17Loc = checkIs17Loc(locationVal);

            // Physical Qty (실물 전체수량)
            const rawH = row.getCell(colIdxPhysical).value;
            let physicalQty = 0;
            if (typeof rawH === 'number') {
                physicalQty = rawH;
            } else if (rawH !== null && rawH !== undefined) {
                physicalQty = parseFloat(String(rawH).replace(/,/g, '')) || 0;
            }

            // OQC BLOCK
            const rawO = row.getCell(colIdxOqc).value;
            let oqcQty = 0;
            if (typeof rawO === 'number') {
                oqcQty = rawO;
            } else if (rawO !== null && rawO !== undefined) {
                oqcQty = parseFloat(String(rawO).replace(/,/g, '')) || 0;
            }

            // Long Term Block
            const rawP = row.getCell(colIdxLongTerm).value;
            let longTermQty = 0;
            if (typeof rawP === 'number') {
                longTermQty = rawP;
            } else if (rawP !== null && rawP !== undefined) {
                longTermQty = parseFloat(String(rawP).replace(/,/g, '')) || 0;
            }

            // Bin Block
            const rawQ = row.getCell(colIdxBin).value;
            let binQty = 0;
            if (typeof rawQ === 'number') {
                binQty = rawQ;
            } else if (rawQ !== null && rawQ !== undefined) {
                binQty = parseFloat(String(rawQ).replace(/,/g, '')) || 0;
            }

            const blockQty = oqcQty + longTermQty + binQty;

            // Block 제품 목록 업데이트
            if (blockQty > 0) {
                blockProductNamesWith17.add(name);
                if (!is17Loc) {
                    blockProductNames.add(name);
                }
            }

            // Available Qty (사용가능수량)
            const rawI = row.getCell(colIdxAvailable).value;
            let availableQty = 0;
            if (typeof rawI === 'number') {
                availableQty = rawI;
            } else if (rawI !== null && rawI !== undefined) {
                availableQty = parseFloat(String(rawI).replace(/,/g, '')) || 0;
            }

            // Pending Qty (진짜 팬딩수량 - 13번째 열)
            const rawPending = row.getCell(colIdxPending).value;
            let pendingQty = 0;
            if (typeof rawPending === 'number') {
                pendingQty = rawPending;
            } else if (rawPending !== null && rawPending !== undefined) {
                pendingQty = parseFloat(String(rawPending).replace(/,/g, '')) || 0;
            }

            // 실제 출고 가능한 정상 패스(양품) 수량 = Math.max(0, physicalQty - blockQty - pendingQty)
            const goodQty = Math.max(0, physicalQty - blockQty - pendingQty);

            // 블록 수량이 존재하는 로케이션별 리스트 수집
            if (oqcQty > 0 || longTermQty > 0 || binQty > 0) {
                const holdItem = {
                    division: String(row.getCell(colIdxDivision).value || '').trim(), // 사업부
                    location: locationVal, // 로케이션
                    modelName: name, // 모델명
                    totalQty: physicalQty, // 전체수량
                    availableQty: availableQty, // 사용가능수량
                    goodQty: goodQty, // 출고가능 양품수량
                    pendingQty: pendingQty, // 팬딩수량
                    oqcHold: oqcQty, // OQC Hold
                    longTermHold: longTermQty, // Long term hold
                    binBlock: binQty // Bin block
                };

                holdStockListWith17.push(holdItem);
                if (!is17Loc) {
                    holdStockList.push(holdItem);
                }
            }

            // 전체 재고 데이터 로케이션별 수집 (Good/Pending/Block 포함)
            if (physicalQty > 0) {
                const stockItem = {
                    division: String(row.getCell(colIdxDivision).value || '').trim(),
                    location: locationVal,
                    modelName: name,
                    physicalQty: physicalQty,
                    goodQty: goodQty,       // 정상 패스(양품) 수량
                    pendingQty: pendingQty, // 팬딩 수량
                    availableQty: availableQty,
                    blockQty: blockQty,
                    oqcHold: oqcQty,
                    longTermHold: longTermQty,
                    binBlock: binQty
                };
                allStockListWith17.push(stockItem);
                if (!is17Loc) {
                    allStockList.push(stockItem);
                }
            }

            // 사업부 추출
            const rowDivision = String(row.getCell(colIdxDivision).value || '').trim();

            // 전체 재고 데이터 합산 (17 포함)
            if (!stockMapWith17[name]) {
                stockMapWith17[name] = { division: rowDivision, physical: 0, good: 0, pending: 0, block: 0, oqc: 0, longTerm: 0, bin: 0, available: 0, workTotal: 0 };
            } else if (!stockMapWith17[name].division && rowDivision) {
                stockMapWith17[name].division = rowDivision;
            }
            stockMapWith17[name].physical += physicalQty;
            stockMapWith17[name].good += goodQty;
            stockMapWith17[name].pending += pendingQty;
            stockMapWith17[name].block += blockQty;
            stockMapWith17[name].oqc += oqcQty;
            stockMapWith17[name].longTerm += longTermQty;
            stockMapWith17[name].bin += binQty;
            stockMapWith17[name].available = stockMapWith17[name].physical - stockMapWith17[name].block;
            stockMapWith17[name].workTotal = stockMapWith17[name].good + stockMapWith17[name].pending;

            // 기본 재고 데이터 합산 (17 제외)
            if (!is17Loc) {
                if (!stockMap[name]) {
                    stockMap[name] = { division: rowDivision, physical: 0, good: 0, pending: 0, block: 0, oqc: 0, longTerm: 0, bin: 0, available: 0, workTotal: 0 };
                } else if (!stockMap[name].division && rowDivision) {
                    stockMap[name].division = rowDivision;
                }
                stockMap[name].physical += physicalQty;
                stockMap[name].good += goodQty;
                stockMap[name].pending += pendingQty;
                stockMap[name].block += blockQty;
                stockMap[name].oqc += oqcQty;
                stockMap[name].longTerm += longTermQty;
                stockMap[name].bin += binQty;
                stockMap[name].available = stockMap[name].physical - stockMap[name].block;
                stockMap[name].workTotal = stockMap[name].good + stockMap[name].pending;
            }
        });

        console.log(`📦 [API] 창고재고: 총 ${productNamesInWarehouse.size}개 고유 제품명 수집`);
        console.log(`📦 [API] Block Qty > 0 대상 제품 (17 제외): ${blockProductNames.size}개 / (17 포함): ${blockProductNamesWith17.size}개`);
        console.log(`📦 [API] H재고리스트 추출 대상 (17 제외): ${holdStockList.length}건 / (17 포함): ${holdStockListWith17.length}건`);

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
            blockProductNames: Array.from(blockProductNames), // 17 제외 Block Qty > 0 제품명 목록
            blockProductNamesWith17: Array.from(blockProductNamesWith17), // 17 포함 Block Qty > 0 제품명 목록
            stockMap: stockMap, // 17 제외 제품명별 실물재고, 사용불가재고, 사용가능재고 맵
            stockMapWith17: stockMapWith17, // 17 포함 제품명별 실물재고, 사용불가재고, 사용가능재고 맵
            holdStockList: holdStockList, // 17 제외 oqc, longterm, bin 중 하나라도 0 이상인 행 목록
            holdStockListWith17: holdStockListWith17, // 17 포함 oqc, longterm, bin 중 하나라도 0 이상인 행 목록
            allStockList: allStockList, // 17 제외 전체 로케이션 상세
            allStockListWith17: allStockListWith17, // 17 포함 전체 로케이션 상세
            totalProducts: productNamesInWarehouse.size,
            fileName: req.file.originalname
        });
    } catch (err) {
        console.error('❌ [API] 창고재고 파싱 오류:', err);
        res.status(500).json({ success: false, message: `파일 파싱 오류: ${err.message}` });
    }
});

// --- H재고 리스트 엑셀 내보내기 API ---
app.post('/api/export-hold-stock', async (req, res) => {
    try {
        const { list } = req.body;
        if (!list || !Array.isArray(list)) {
            return res.status(400).send('데이터가 유효하지 않습니다.');
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('H재고리스트');

        // 컬럼 정의
        worksheet.columns = [
            { header: '사업부', key: 'division', width: 12 },
            { header: '로케이션', key: 'location', width: 15 },
            { header: '모델명', key: 'modelName', width: 28 },
            { header: '전체수량', key: 'totalQty', width: 12 },
            { header: '사용가능수량', key: 'availableQty', width: 15 },
            { header: '양품수량', key: 'goodQty', width: 12 },
            { header: '팬딩수량', key: 'pendingQty', width: 12 },
            { header: 'OQC Hold', key: 'oqcHold', width: 12 },
            { header: 'Long Term Hold', key: 'longTermHold', width: 16 },
            { header: 'Bin Block', key: 'binBlock', width: 12 }
        ];

        // 헤더 디자인 서식 지정
        worksheet.getRow(1).eachCell((cell, colNumber) => {
            cell.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
            
            // OQC, Long Term, Bin 컬럼 헤더는 식별 가능한 색상 적용
            if (colNumber === 8) {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'EF4444' } }; // Red
            } else if (colNumber === 9) {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'C2410C' } }; // Dark Orange
            } else if (colNumber === 10) {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '3B82F6' } }; // Blue
            } else {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '475569' } }; // Slate Gray
            }
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
            cell.border = {
                top: { style: 'thin', color: { argb: 'E2E8F0' } },
                bottom: { style: 'medium', color: { argb: 'CBD5E1' } }
            };
        });
        worksheet.getRow(1).height = 26;

        // 데이터 행 추가
        list.forEach((item, index) => {
            const row = worksheet.addRow({
                division: item.division || '',
                location: item.location || '',
                modelName: item.modelName || '',
                totalQty: Number(item.totalQty) || 0,
                availableQty: Number(item.availableQty) || 0,
                goodQty: Number(item.goodQty) || 0,
                pendingQty: Number(item.pendingQty) || 0,
                oqcHold: Number(item.oqcHold) || 0,
                longTermHold: Number(item.longTermHold) || 0,
                binBlock: Number(item.binBlock) || 0
            });

            // 셀 스타일 지정
            row.eachCell((cell, colNumber) => {
                cell.font = { size: 9 };
                cell.border = {
                    bottom: { style: 'thin', color: { argb: 'E2E8F0' } },
                    right: { style: 'thin', color: { argb: 'E2E8F0' } }
                };
                if (colNumber === 3) {
                    cell.alignment = { vertical: 'middle', horizontal: 'left' };
                } else {
                    cell.alignment = { vertical: 'middle', horizontal: 'center' };
                }

                // 블록 수량이 0보다 큰 셀 배경색 및 두꺼운 폰트 강조
                if (colNumber === 8 && Number(cell.value) > 0) {
                    cell.font = { bold: true, color: { argb: 'B91C1C' } };
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEF2F2' } };
                } else if (colNumber === 9 && Number(cell.value) > 0) {
                    cell.font = { bold: true, color: { argb: 'C2410C' } };
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7ED' } };
                } else if (colNumber === 10 && Number(cell.value) > 0) {
                    cell.font = { bold: true, color: { argb: '1D4ED8' } };
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'EFF6FF' } };
                }
            });
            row.height = 20;
        });

        // 엑셀 전송 설정
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=HoldStockList.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('❌ H재고 리스트 엑셀 내보내기 오류:', err);
        res.status(500).send(err.message);
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

// --- 커스텀 필드 클라우드 동기화 API ---
app.get('/api/sync/custom-fields', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.query("SELECT value FROM app_configs WHERE key = 'custom_fields'");
        if (result.rows.length === 0) {
            return res.json({ success: true, customFields: [] });
        }
        res.json({ success: true, customFields: result.rows[0].value });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/sync/custom-fields', async (req, res) => {
    const { customFields } = req.body;
    try {
        const pool = await getPool();
        await pool.query(`
            INSERT INTO app_configs (key, value, updated_at)
            VALUES ('custom_fields', $1, NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `, [JSON.stringify(customFields)]);
        res.json({ success: true, message: "매핑 설정(커스텀 필드)이 클라우드에 업로드되었습니다." });
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

// --- 컨테이너 사진 관련 API ---
const CTNR_UPLOADS_DIR = process.env.CTNR_UPLOAD_DIR || 'C:\\Program Files (x86)\\CTNR\\uploads';

// 0. 컨테이너별 등록된 사진 수 조회 API (카메라 아이콘 노출 및 씰/일반 구분용)
app.get('/api/photos/counts', async (req, res) => {
    try {
        const pool = await getPool();
        const sql = `
            SELECT 
                UPPER(TRIM(cntr_no)) as cntr_no, 
                COUNT(*)::int as total,
                COUNT(CASE WHEN photo_type = 'seal' THEN 1 END)::int as seal,
                COUNT(CASE WHEN photo_type IS NULL OR photo_type != 'seal' THEN 1 END)::int as normal
            FROM container_photos 
            WHERE (is_deleted IS NULL OR is_deleted = false) 
            GROUP BY UPPER(TRIM(cntr_no))
        `;
        const result = await pool.query(sql);
        const counts = {};
        result.rows.forEach(r => {
            if (r.cntr_no) {
                counts[r.cntr_no] = {
                    total: r.total || 0,
                    seal: r.seal || 0,
                    normal: r.normal || 0
                };
            }
        });
        res.json({ success: true, counts });
    } catch (err) {
        console.error("GET /api/photos/counts error:", err);
        res.status(500).json({ success: false, error: err.message, counts: {} });
    }
});

// 1. 사진 목록 조회 API
app.get('/api/photos', async (req, res) => {
    try {
        const pool = await getPool();
        const { cntrNo, startDate, endDate, showTrash, showCompleted, photoType } = req.query;

        const params = [];
        let paramIdx = 1;
        let whereConditions = [];

        if (showTrash === 'true') {
            whereConditions.push(`p.is_deleted = true`);
        } else {
            whereConditions.push(`(p.is_deleted IS NULL OR p.is_deleted = false)`);
            if (showCompleted === 'true') {
                whereConditions.push(`p.is_completed = true`);
            } else if (showCompleted === 'all') {
                // 전체 (완료/진행중 무관)
            } else {
                whereConditions.push(`(p.is_completed IS NULL OR p.is_completed = false)`);
            }
        }

        if (cntrNo) {
            whereConditions.push(`p.cntr_no ILIKE $${paramIdx++}`);
            params.push(`%${cntrNo.trim()}%`);
        }

        if (photoType) {
            whereConditions.push(`p.photo_type = $${paramIdx++}`);
            params.push(photoType);
        }

        if (startDate) {
            whereConditions.push(`p.uploaded_at AT TIME ZONE 'Asia/Seoul' >= $${paramIdx++}::timestamp`);
            params.push(`${startDate} 00:00:00`);
        }

        if (endDate) {
            whereConditions.push(`p.uploaded_at AT TIME ZONE 'Asia/Seoul' <= ($${paramIdx++}::date + INTERVAL '1 day')`);
            params.push(endDate);
        }

        const whereSql = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

        const sql = `
            SELECT 
                p.id, 
                p.job_id, 
                p.cntr_no, 
                p.photo_path, 
                p.remark, 
                p.uploaded_at, 
                p.uploaded_by, 
                p.team_id,
                p.work_duration_minutes,
                p.is_completed,
                p.photo_type,
                p.completed_at, 
                p.gdrive_file_id, 
                p.gdrive_url,
                t.name as team_name,
                COALESCE(NULLIF(p.uploader_name, ''), '작업자') as uploader_name, 
                j.job_name,
                (SELECT transporter FROM container_results WHERE cntr_no = p.cntr_no LIMIT 1) as transporter
            FROM container_photos p
            LEFT JOIN teams t ON p.team_id = t.id
            LEFT JOIN container_jobs j ON p.job_id = j.id
            ${whereSql}
            ORDER BY p.uploaded_at DESC
        `;

        const result = await pool.query(sql, params);

        // 파일 존재 여부 및 mtime 계산
        const photosWithStats = result.rows.map(row => {
            let photoPathWithCacheBuster = row.photo_path;
            let fileExists = false;
            try {
                const filePath = path.join(CTNR_UPLOADS_DIR, row.photo_path);
                if (fs.existsSync(filePath)) {
                    fileExists = true;
                    const stats = fs.statSync(filePath);
                    if (stats.mtimeMs) {
                        photoPathWithCacheBuster = `${row.photo_path}?t=${Math.floor(stats.mtimeMs)}`;
                    }
                }
            } catch (e) {}

            return {
                ...row,
                photo_path: photoPathWithCacheBuster,
                file_exists: fileExists
            };
        });

        res.json({ success: true, photos: photosWithStats });
    } catch (err) {
        console.error("GET /api/photos error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// [추가] 컨테이너별 상세 작업 품목 및 수량 실시간 조회 API
app.get('/api/containers/info', async (req, res) => {
    try {
        const cntrNo = (req.query.cntrNo || '').trim();
        if (!cntrNo) {
            return res.status(400).json({ success: false, error: 'cntrNo is required' });
        }

        const query = `
            SELECT * FROM container_results
            WHERE cntr_no = $1
              AND job_id = (
                  SELECT job_id FROM container_results 
                  WHERE cntr_no = $1 
                  ORDER BY id DESC LIMIT 1
              )
            ORDER BY id ASC
        `;
        let result = await pool.query(query, [cntrNo]);
        let rows = result.rows;

        if (rows.length === 0) {
            const fallback = await pool.query(
                `SELECT * FROM container_results
                 WHERE cntr_no ILIKE $1
                   AND job_id = (
                       SELECT job_id FROM container_results 
                       WHERE cntr_no ILIKE $1 
                       ORDER BY id DESC LIMIT 1
                   )
                 ORDER BY id ASC`,
                [`%${cntrNo}%`]
            );
            rows = fallback.rows;
        }

        res.json({
            success: true,
            cntrNo: cntrNo,
            count: rows.length,
            products: rows
        });
    } catch (err) {
        console.error("GET /api/containers/info error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 조(팀) 목록 조회 API
app.get('/api/teams', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.query('SELECT id, name FROM teams ORDER BY id ASC');
        res.json({ success: true, teams: result.rows });
    } catch (err) {
        console.warn("GET /api/teams fallback default teams:", err.message);
        res.json({
            success: true,
            teams: [
                { id: 1, name: '1조' },
                { id: 2, name: '2조' },
                { id: 3, name: '3조' },
                { id: 4, name: '주간조' },
                { id: 5, name: '야간조' }
            ]
        });
    }
});

// 작업 완료 및 상태 변경 API (CTNR 호환)
app.patch('/api/photos', async (req, res) => {
    try {
        const pool = await getPool();
        const { action, ids, cntrNo, isCompleted, photoType, teamId, targetCntrNo, degrees } = req.body;

        // 1. 선택한 사진 회전 (좌회전 -90, 180도, 우회전 90)
        if (action === 'rotate') {
            if (!Array.isArray(ids) || ids.length === 0) {
                return res.status(400).json({ success: false, error: '회전할 사진 ID가 제공되지 않았습니다.' });
            }
            const deg = Number(degrees) || 90;
            const pRes = await pool.query(
                `SELECT id, photo_path FROM container_photos WHERE id = ANY($1)`,
                [ids]
            );
            let rotatedCount = 0;
            let skippedCount = 0;

            for (const row of pRes.rows) {
                const localPath = path.resolve(CTNR_UPLOADS_DIR, row.photo_path);
                if (fs.existsSync(localPath)) {
                    if (sharp) {
                        try {
                            const buffer = await sharp(localPath).rotate(deg).toBuffer();
                            fs.writeFileSync(localPath, buffer);
                            rotatedCount++;
                        } catch (err) {
                            console.error(`[Rotate Error] ${row.photo_path}:`, err);
                            skippedCount++;
                        }
                    } else {
                        skippedCount++;
                    }
                } else {
                    skippedCount++;
                }
            }

            return res.json({
                success: true,
                rotatedCount,
                skippedCount,
                message: `${rotatedCount}장의 사진을 ${deg}° 회전했습니다.` + (skippedCount > 0 ? ` (${skippedCount}장 건너뜀)` : '')
            });
        }

        // 2. 씰 지정 / 씰 해제 토글
        if (action === 'update_photo_type') {
            if (!Array.isArray(ids) || ids.length === 0) {
                return res.status(400).json({ success: false, error: '사진 ID가 제공되지 않았습니다.' });
            }
            const targetType = (photoType === 'seal' || photoType === 'SEAL') ? 'seal' : 'normal';
            await pool.query(
                `UPDATE container_photos SET photo_type = $1 WHERE id = ANY($2)`,
                [targetType, ids]
            );
            return res.json({
                success: true,
                photo_type: targetType,
                updated_ids: ids,
                message: targetType === 'seal' 
                    ? (ids.length > 1 ? `사진 ${ids.length}장이 씰(Seal) 사진으로 지정되었습니다.` : '씰(Seal) 사진으로 지정되었습니다.')
                    : (ids.length > 1 ? `사진 ${ids.length}장의 씰 지정이 해제되었습니다.` : '일반 사진으로 변경(씰 해제)되었습니다.')
            });
        }

        // 3. 작업 조(Team) 일괄 변경
        if (action === 'change_team') {
            if (!Array.isArray(ids) || ids.length === 0) {
                return res.status(400).json({ success: false, error: '사진 ID가 제공되지 않았습니다.' });
            }
            const targetTeamId = (teamId !== undefined && teamId !== null && teamId !== '' && teamId !== 'null') 
                ? parseInt(String(teamId), 10) 
                : null;

            await pool.query(
                `UPDATE container_photos SET team_id = $1 WHERE id = ANY($2)`,
                [targetTeamId, ids]
            );

            let teamName = '미지정 조';
            if (targetTeamId) {
                try {
                    const tRes = await pool.query(`SELECT name FROM teams WHERE id = $1`, [targetTeamId]);
                    if (tRes.rows.length > 0) teamName = tRes.rows[0].name;
                } catch (e) {}
            }

            return res.json({
                success: true,
                updatedCount: ids.length,
                teamId: targetTeamId,
                teamName,
                message: `사진 ${ids.length}장의 작업 조가 [${teamName}](으)로 변경되었습니다.`
            });
        }

        // 4. 다른 컨테이너로 이동
        if (action === 'move_container') {
            const cleanTargetCntr = (targetCntrNo || '').trim().toUpperCase();
            if (!cleanTargetCntr) {
                return res.status(400).json({ success: false, error: '이동할 목표 컨테이너 번호를 입력해 주세요.' });
            }
            if (!Array.isArray(ids) || ids.length === 0) {
                return res.status(400).json({ success: false, error: '이동할 사진이 선택되지 않았습니다.' });
            }

            const pRes = await pool.query(
                `SELECT id, photo_path, cntr_no FROM container_photos WHERE id = ANY($1) AND (is_deleted IS NOT TRUE)`,
                [ids]
            );

            const targetDir = path.resolve(CTNR_UPLOADS_DIR, cleanTargetCntr);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            let movedCount = 0;
            for (const photo of pRes.rows) {
                const oldLocalPath = path.resolve(CTNR_UPLOADS_DIR, photo.photo_path);
                const filename = path.basename(photo.photo_path);
                const newRelativePath = `${cleanTargetCntr}/${filename}`;
                const newLocalPath = path.resolve(CTNR_UPLOADS_DIR, newRelativePath);

                if (fs.existsSync(oldLocalPath)) {
                    try {
                        fs.renameSync(oldLocalPath, newLocalPath);
                    } catch (err) {
                        try {
                            fs.copyFileSync(oldLocalPath, newLocalPath);
                            fs.unlinkSync(oldLocalPath);
                        } catch (e) {}
                    }
                }

                await pool.query(
                    `UPDATE container_photos SET cntr_no = $1, photo_path = $2 WHERE id = $3`,
                    [cleanTargetCntr, newRelativePath, photo.id]
                );
                movedCount++;
            }

            return res.json({
                success: true,
                movedCount,
                targetCntrNo: cleanTargetCntr,
                message: `사진 ${movedCount}장이 컨테이너 '${cleanTargetCntr}'(으)로 이동되었습니다.`
            });
        }

        // 5. 선택한 사진 삭제 (휴지통 이동)
        if (action === 'trash_photos' || action === 'delete_photos') {
            if (!Array.isArray(ids) || ids.length === 0) {
                return res.status(400).json({ success: false, error: '삭제할 사진이 선택되지 않았습니다.' });
            }
            await pool.query(
                `UPDATE container_photos SET is_deleted = true WHERE id = ANY($1)`,
                [ids]
            );
            return res.json({
                success: true,
                count: ids.length,
                message: `선택한 사진 ${ids.length}장이 휴지통으로 이동되었습니다.`
            });
        }

        // 6. 폴더 단위 완료 토글 (단일 및 다중 지원)
        if (action === 'toggle_complete_folder') {
            const targetCompleted = !!isCompleted;
            const completedAt = targetCompleted ? new Date() : null;
            const targetList = Array.isArray(req.body.cntrNos) ? req.body.cntrNos.map(c => String(c).toUpperCase().trim()) : (cntrNo ? [cntrNo.toUpperCase().trim()] : []);

            if (targetList.length > 0) {
                await pool.query(
                    `UPDATE container_photos 
                     SET is_completed = $1, completed_at = $2 
                     WHERE cntr_no = ANY($3)`,
                    [targetCompleted, completedAt, targetList]
                );
                return res.json({ 
                    success: true, 
                    message: `${targetList.length}개 컨테이너 폴더가 [${targetCompleted ? '완료' : '진행 중'}](으)로 변경되었습니다.` 
                });
            }
        }

        // 7. 개별 사진 완료 토글
        if (action === 'toggle_complete_photos' && Array.isArray(ids) && ids.length > 0) {
            const targetCompleted = !!isCompleted;
            const completedAt = targetCompleted ? new Date() : null;
            await pool.query(
                `UPDATE container_photos 
                 SET is_completed = $1, completed_at = $2 
                 WHERE id = ANY($3)`,
                [targetCompleted, completedAt, ids]
            );
            return res.json({ success: true, message: `선택한 사진 ${ids.length}장 작업 상태가 변경되었습니다.` });
        }

        // 8. 폴더 단위 삭제 / 복구 (단일 및 다중 지원)
        if (action === 'trash_folder') {
            const targetList = Array.isArray(req.body.cntrNos) ? req.body.cntrNos.map(c => String(c).toUpperCase().trim()) : (cntrNo ? [cntrNo.toUpperCase().trim()] : []);
            if (targetList.length > 0) {
                await pool.query(
                    `UPDATE container_photos SET is_deleted = true WHERE cntr_no = ANY($1)`,
                    [targetList]
                );
                return res.json({ success: true, message: `${targetList.length}개 컨테이너 폴더가 휴지통으로 이동되었습니다.` });
            }
        }

        if (action === 'restore_folder') {
            const targetList = Array.isArray(req.body.cntrNos) ? req.body.cntrNos.map(c => String(c).toUpperCase().trim()) : (cntrNo ? [cntrNo.toUpperCase().trim()] : []);
            if (targetList.length > 0) {
                await pool.query(
                    `UPDATE container_photos SET is_deleted = false WHERE cntr_no = ANY($1)`,
                    [targetList]
                );
                return res.json({ success: true, message: `${targetList.length}개 컨테이너 폴더가 복구되었습니다.` });
            }
        }

        // 9. 폴더 단위 작업 조(Team) 일괄 변경
        if (action === 'change_team_folder') {
            const targetList = Array.isArray(req.body.cntrNos) ? req.body.cntrNos.map(c => String(c).toUpperCase().trim()) : (cntrNo ? [cntrNo.toUpperCase().trim()] : []);
            const targetTeamId = (teamId !== undefined && teamId !== null && teamId !== '' && teamId !== 'null') ? parseInt(String(teamId), 10) : null;
            if (targetList.length > 0) {
                await pool.query(
                    `UPDATE container_photos SET team_id = $1 WHERE cntr_no = ANY($2)`,
                    [targetTeamId, targetList]
                );
                let teamName = '미지정 조';
                if (targetTeamId) {
                    try {
                        const tRes = await pool.query(`SELECT name FROM teams WHERE id = $1`, [targetTeamId]);
                        if (tRes.rows.length > 0) teamName = tRes.rows[0].name;
                    } catch (e) {}
                }
                return res.json({
                    success: true,
                    count: targetList.length,
                    teamId: targetTeamId,
                    teamName,
                    message: `${targetList.length}개 폴더의 작업 조가 [${teamName}](으)로 변경되었습니다.`
                });
            }
        }

        // 10. 사진 복구 (휴지통 -> 활성)
        if (action === 'restore' || action === 'restore_photos' || (!action && req.query.ids)) {
            const targetIds = Array.isArray(ids) ? ids : (req.query.ids ? req.query.ids.split(',').map(s => s.trim()).filter(Boolean) : []);
            if (targetIds.length === 0) {
                return res.status(400).json({ success: false, error: '복구할 사진 ID가 제공되지 않았습니다.' });
            }
            await pool.query(
                `UPDATE container_photos SET is_deleted = false WHERE id = ANY($1)`,
                [targetIds]
            );
            return res.json({
                success: true,
                count: targetIds.length,
                message: `선택한 사진 ${targetIds.length}장이 복구되었습니다.`
            });
        }

        // 11. 구글 드라이브 백업 & 로컬 용량 정리 (NDJSON 스트리밍 프로그레스)
        if (action === 'upload_gdrive') {
            const targetIds = Array.isArray(ids) ? ids : [];
            if (targetIds.length === 0) {
                return res.status(400).json({ success: false, error: '백업할 사진 ID가 제공되지 않았습니다.' });
            }

            res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders?.();

            const sendEvent = (evt) => {
                try {
                    res.write(JSON.stringify(evt) + '\n');
                } catch (e) {}
            };

            const pRes = await pool.query(
                `SELECT id, photo_path, cntr_no, gdrive_file_id, gdrive_url 
                 FROM container_photos 
                 WHERE id = ANY($1) AND (is_deleted IS NOT TRUE)`,
                [targetIds]
            );

            const total = pRes.rows.length;
            let uploadedCount = 0;
            let skippedCount = 0;
            let cleanedCount = 0;
            let totalFreedBytes = 0;

            const alreadyDone = pRes.rows.filter(r => !!r.gdrive_file_id).length;
            sendEvent({ type: 'start', total, alreadyDoneCount: alreadyDone });

            let currentIdx = 0;
            for (const photo of pRes.rows) {
                currentIdx++;
                const filename = path.basename(photo.photo_path);
                const localPath = path.resolve(CTNR_UPLOADS_DIR, photo.photo_path);

                try {
                    // 이미 업로드 완료된 경우
                    if (photo.gdrive_file_id) {
                        skippedCount++;
                        // 로컬 파일이 아직 남아있으면 용량 정리
                        if (fs.existsSync(localPath)) {
                            try {
                                const stats = fs.statSync(localPath);
                                totalFreedBytes += stats.size;
                                fs.unlinkSync(localPath);
                                cleanedCount++;
                            } catch (e) {}
                        }
                        const freedMB = (totalFreedBytes / (1024 * 1024)).toFixed(1);
                        sendEvent({
                            type: 'progress',
                            current: currentIdx,
                            total,
                            percent: Math.round((currentIdx / total) * 100),
                            currentFile: filename,
                            status: 'SKIPPED',
                            uploadedCount,
                            skippedCount,
                            cleanedCount,
                            freedMB
                        });
                        continue;
                    }

                    // 로컬 파일이 없는 경우
                    if (!fs.existsSync(localPath)) {
                        skippedCount++;
                        sendEvent({
                            type: 'progress',
                            current: currentIdx,
                            total,
                            percent: Math.round((currentIdx / total) * 100),
                            currentFile: filename,
                            status: 'NOT_FOUND',
                            uploadedCount,
                            skippedCount,
                            cleanedCount
                        });
                        continue;
                    }

                    // Google Drive 업로드 실행
                    let mimeType = 'image/jpeg';
                    if (filename.toLowerCase().endsWith('.png')) mimeType = 'image/png';
                    else if (filename.toLowerCase().endsWith('.webp')) mimeType = 'image/webp';

                    const driveResult = await uploadToGoogleDrive(localPath, filename, mimeType);
                    uploadedCount++;

                    // DB 업데이트
                    await pool.query(
                        `UPDATE container_photos 
                         SET gdrive_file_id = $1, gdrive_url = $2 
                         WHERE id = $3`,
                        [driveResult.fileId, driveResult.gdriveUrl, photo.id]
                    );

                    // 로컬 파일 삭제 (용량 확보)
                    try {
                        const stats = fs.statSync(localPath);
                        totalFreedBytes += stats.size;
                        fs.unlinkSync(localPath);
                        cleanedCount++;
                    } catch (e) {}

                    const freedMB = (totalFreedBytes / (1024 * 1024)).toFixed(1);
                    sendEvent({
                        type: 'progress',
                        current: currentIdx,
                        total,
                        percent: Math.round((currentIdx / total) * 100),
                        currentFile: filename,
                        status: 'UPLOADED',
                        uploadedCount,
                        skippedCount,
                        cleanedCount,
                        freedMB
                    });

                } catch (err) {
                    console.error(`[GDrive Upload Error] ${filename}:`, err);
                    sendEvent({
                        type: 'error',
                        filename,
                        error: err.message
                    });
                }
            }

            const finalFreedMB = (totalFreedBytes / (1024 * 1024)).toFixed(1);
            sendEvent({
                type: 'done',
                uploadedCount,
                skippedCount,
                cleanedCount,
                freedMB: finalFreedMB,
                message: `🎉 구글드라이브 백업 완료! (업로드: ${uploadedCount}장, 스킵: ${skippedCount}장, 정리된 로컬 용량: ${finalFreedMB} MB)`
            });

            return res.end();
        }

        // 12. 사진 복구 (단순 ids 배열 전달 시)
        if (Array.isArray(ids) && ids.length > 0 && !action) {
            await pool.query(
                `UPDATE container_photos SET is_deleted = false WHERE id = ANY($1)`,
                [ids]
            );
            return res.json({ success: true, message: `선택한 사진 ${ids.length}장이 복구되었습니다.` });
        }

        res.status(400).json({ success: false, error: 'Unknown action' });
    } catch (err) {
        console.error("PATCH /api/photos error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 사진 삭제 API (휴지통 이동 및 영구 삭제 지원)
app.delete('/api/photos', async (req, res) => {
    try {
        const pool = await getPool();
        const idsParam = req.query.ids || (req.body && req.body.ids);
        const cntrNosParam = req.query.cntrNos || (req.body && req.body.cntrNos);
        const isPermanent = req.query.permanent === 'true';

        let targetIds = [];
        if (idsParam) {
            targetIds = Array.isArray(idsParam) ? idsParam : String(idsParam).split(',').map(s => s.trim()).filter(Boolean);
        } else if (cntrNosParam) {
            const cntrList = Array.isArray(cntrNosParam) ? cntrNosParam : String(cntrNosParam).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
            const pRes = await pool.query(`SELECT id FROM container_photos WHERE cntr_no = ANY($1)`, [cntrList]);
            targetIds = pRes.rows.map(r => r.id);
        }

        if (targetIds.length === 0) {
            return res.status(400).json({ success: false, error: '삭제할 사진이 지정되지 않았습니다.' });
        }

        if (isPermanent) {
            // 영구 삭제: 로컬 파일 삭제 + DB 레코드 완전 제거
            const pRes = await pool.query(
                `SELECT id, photo_path FROM container_photos WHERE id = ANY($1)`,
                [targetIds]
            );

            for (const row of pRes.rows) {
                const localPath = path.resolve(CTNR_UPLOADS_DIR, row.photo_path);
                if (fs.existsSync(localPath)) {
                    try { fs.unlinkSync(localPath); } catch (e) {}
                }
            }

            await pool.query(`DELETE FROM container_photos WHERE id = ANY($1)`, [targetIds]);
            return res.json({
                success: true,
                count: targetIds.length,
                message: `사진 ${targetIds.length}장이 영구 삭제되었습니다.`
            });
        } else {
            // 휴지통 이동 (Soft Delete)
            await pool.query(
                `UPDATE container_photos SET is_deleted = true WHERE id = ANY($1)`,
                [targetIds]
            );
            return res.json({
                success: true,
                count: targetIds.length,
                message: `선택한 사진 ${targetIds.length}장이 휴지통으로 이동되었습니다.`
            });
        }
    } catch (err) {
        console.error("DELETE /api/photos error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 사진 일괄 ZIP 압축 다운로드 API (JSZip 기반)
app.get('/api/photos/download', async (req, res) => {
    try {
        const pool = await getPool();
        const { ids, cntrNos, startDate, endDate } = req.query;

        if (!ids && !cntrNos) {
            return res.status(400).send('No containers or photo IDs specified');
        }

        let photos = [];
        if (ids) {
            const idList = String(ids).split(',').map(s => s.trim()).filter(Boolean);
            const pRes = await pool.query(
                `SELECT cntr_no, photo_path, gdrive_file_id 
                 FROM container_photos 
                 WHERE id = ANY($1) AND (is_deleted IS NOT TRUE)`,
                [idList]
            );
            photos = pRes.rows;
        } else if (cntrNos) {
            const cntrList = String(cntrNos).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
            let query = `
                SELECT cntr_no, photo_path, gdrive_file_id 
                FROM container_photos 
                WHERE cntr_no = ANY($1) AND (is_deleted IS NOT TRUE)
            `;
            const params = [cntrList];
            let pIdx = 2;

            if (startDate) {
                query += ` AND uploaded_at AT TIME ZONE 'Asia/Seoul' >= $${pIdx++}::timestamp`;
                params.push(`${startDate} 00:00:00`);
            }
            if (endDate) {
                query += ` AND uploaded_at AT TIME ZONE 'Asia/Seoul' <= ($${pIdx++}::date + INTERVAL '1 day')`;
                params.push(endDate);
            }

            const pRes = await pool.query(query, params);
            photos = pRes.rows;
        }

        if (photos.length === 0) {
            return res.status(404).send('다운로드할 사진을 찾을 수 없습니다.');
        }

        if (!JSZip) {
            return res.status(500).send('JSZip 라이브러리를 로드할 수 없습니다.');
        }

        const zip = new JSZip();

        await Promise.all(photos.map(async (photo) => {
            const localPath = path.resolve(CTNR_UPLOADS_DIR, photo.photo_path);
            const folderName = photo.cntr_no || '기타';
            const fileName = path.basename(photo.photo_path);
            const zipEntryPath = `${folderName}/${fileName}`;

            if (fs.existsSync(localPath)) {
                const buffer = fs.readFileSync(localPath);
                zip.file(zipEntryPath, buffer);
            } else if (photo.gdrive_file_id) {
                try {
                    const gBuffer = await downloadFromGoogleDrive(photo.gdrive_file_id);
                    if (gBuffer && gBuffer.length > 0) {
                        zip.file(zipEntryPath, gBuffer);
                    }
                } catch (e) {
                    console.warn(`[ZIP GDrive Warn] ${fileName}:`, e.message);
                }
            }
        }));

        const zipBuffer = await zip.generateAsync({
            type: 'nodebuffer',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 }
        });

        const zipName = `container_photos_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
        res.setHeader('Content-Length', zipBuffer.length);
        return res.send(zipBuffer);

    } catch (err) {
        console.error("GET /api/photos/download error:", err);
        res.status(500).send(`ZIP 생성 중 오류: ${err.message}`);
    }
});

// 윈도우 로컬 폴더 선택기 API (PowerShell FolderBrowserDialog)
app.get('/api/photos/select-local-folder', async (req, res) => {
    try {
        const scratchDir = path.join(DATA_DIR, 'scratch');
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });

        const scriptPath = path.join(scratchDir, 'select_folder.ps1');
        const scriptContent = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$FolderBrowser = New-Object System.Windows.Forms.FolderBrowserDialog
$FolderBrowser.Description = "사진을 복사할 대상 로컬 폴더를 선택해 주세요."
$FolderBrowser.ShowNewFolderButton = $true
$Result = $FolderBrowser.ShowDialog()
if ($Result -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $FolderBrowser.SelectedPath
} else {
    Write-Output "CANCELLED"
}`;
        fs.writeFileSync(scriptPath, scriptContent, 'utf8');

        const cmd = `chcp 65001 >nul && powershell -STA -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
        exec(cmd, { encoding: 'buffer' }, (error, stdoutBuf) => {
            if (error) {
                console.error('PowerShell folder dialog error:', error);
                return res.json({ success: false, error: error.message });
            }
            const result = stdoutBuf.toString('utf8').trim();
            if (result === 'CANCELLED' || !result) {
                return res.json({ success: true, cancelled: true });
            } else {
                return res.json({ success: true, path: result });
            }
        });
    } catch (err) {
        console.error("GET /api/photos/select-local-folder error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 사진 파일명 수정 API (DB + 파일시스템 + Google Drive 이름 변경)
app.patch('/api/photos/rename', async (req, res) => {
    try {
        const pool = await getPool();
        const { photoId, newFilename } = req.body;

        if (!photoId || !newFilename) {
            return res.status(400).json({ success: false, error: '사진 ID와 새 파일명이 필요합니다.' });
        }

        const sanitizedName = newFilename.replace(/[^a-zA-Z0-9_\-\.가-힣ㄱ-ㅎㅏ-ㅣ\s]/g, '_').trim();
        if (!sanitizedName) {
            return res.status(400).json({ success: false, error: '유효하지 않은 파일 이름입니다.' });
        }

        const pRes = await pool.query(
            `SELECT id, photo_path, cntr_no, gdrive_file_id FROM container_photos WHERE id = $1`,
            [photoId]
        );

        if (pRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: '해당 사진을 찾을 수 없습니다.' });
        }

        const photo = pRes.rows[0];
        const oldPath = photo.photo_path;
        const oldExt = path.extname(oldPath);
        const folderPath = path.dirname(oldPath);

        const finalFilename = sanitizedName.toLowerCase().endsWith(oldExt.toLowerCase())
            ? sanitizedName
            : `${sanitizedName}${oldExt}`;

        const newPhotoPath = path.posix.join(folderPath, finalFilename);

        if (oldPath === newPhotoPath) {
            return res.json({ success: true, photoPath: oldPath });
        }

        // 파일시스템 이름 변경
        const oldLocalPath = path.resolve(CTNR_UPLOADS_DIR, oldPath);
        const newLocalPath = path.resolve(CTNR_UPLOADS_DIR, newPhotoPath);

        if (fs.existsSync(oldLocalPath)) {
            try {
                fs.renameSync(oldLocalPath, newLocalPath);
            } catch (err) {
                fs.copyFileSync(oldLocalPath, newLocalPath);
                fs.unlinkSync(oldLocalPath);
            }
        }

        // Google Drive 파일명 변경
        if (photo.gdrive_file_id) {
            renameGoogleDriveFile(photo.gdrive_file_id, finalFilename).catch(() => {});
        }

        // DB 업데이트
        await pool.query(
            `UPDATE container_photos SET photo_path = $1 WHERE id = $2`,
            [newPhotoPath, photoId]
        );

        res.json({
            success: true,
            photoPath: newPhotoPath,
            message: `파일명이 '${finalFilename}'(으)로 성공적으로 변경되었습니다.`
        });

    } catch (err) {
        console.error("PATCH /api/photos/rename error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 중복 사진 조회 GET API (CTNR 동일 기능)
app.get('/api/photos/duplicates', async (req, res) => {
    try {
        const pool = await getPool();
        const cntrNo = req.query.cntrNo;
        const workDate = req.query.workDate;
        if (!cntrNo) {
            return res.status(400).json({ success: false, error: '컨테이너 번호(cntrNo)가 누락되었습니다.' });
        }

        const dbRes = await pool.query(
            `SELECT p.id, p.photo_path, p.uploaded_at, p.cntr_no, p.remark, p.gdrive_file_id
             FROM container_photos p
             WHERE UPPER(TRIM(p.cntr_no)) = UPPER(TRIM($1)) AND (p.is_deleted IS NOT TRUE)
             ORDER BY p.uploaded_at ASC, p.id ASC`,
            [cntrNo]
        );

        const crypto = require('crypto');
        const getFileMd5 = (filePath) => {
            try {
                if (!fs.existsSync(filePath)) return null;
                const buf = fs.readFileSync(filePath);
                return crypto.createHash('md5').update(buf).digest('hex');
            } catch (e) {
                return null;
            }
        };

        const photos = dbRes.rows.filter(photo => {
            if (!workDate) return true;
            return getWorkDateString(new Date(photo.uploaded_at)) === workDate;
        });

        const hashMap = {};
        for (const photo of photos) {
            const fullPath = path.resolve(CTNR_UPLOADS_DIR, photo.photo_path);
            const hash = getFileMd5(fullPath);
            if (hash) {
                if (!hashMap[hash]) hashMap[hash] = [];
                hashMap[hash].push(photo);
            }
        }

        const duplicateGroups = [];
        let duplicatesCount = 0;

        for (const [hash, list] of Object.entries(hashMap)) {
            if (list.length > 1) {
                const original = list[0];
                const duplicates = list.slice(1);
                duplicatesCount += duplicates.length;

                duplicateGroups.push({
                    hash,
                    originalId: original.id,
                    originalPath: original.photo_path,
                    duplicatePhotoIds: duplicates.map(d => d.id),
                    duplicates
                });
            }
        }

        res.json({
            success: true,
            duplicatesCount,
            duplicateGroups
        });
    } catch (err) {
        console.error("GET /api/photos/duplicates error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 중복 사진 정리 POST API (CTNR 동일 기능)
app.post('/api/photos/duplicates', async (req, res) => {
    try {
        const pool = await getPool();
        const singleCntrNo = req.query.cntrNo || (req.body && req.body.cntrNo);
        const { folders, cntrNos } = req.body || {};
        const targetCntrs = [];

        if (Array.isArray(cntrNos) && cntrNos.length > 0) {
            cntrNos.forEach(c => targetCntrs.push(String(c).toUpperCase().trim()));
        } else if (Array.isArray(folders) && folders.length > 0) {
            folders.forEach(f => {
                const c = (typeof f === 'string' ? f.split('|')[0] : f.cntrNo);
                if (c) targetCntrs.push(String(c).toUpperCase().trim());
            });
        } else if (singleCntrNo) {
            targetCntrs.push(String(singleCntrNo).toUpperCase().trim());
        }

        if (targetCntrs.length === 0) {
            return res.status(400).json({ success: false, error: '정리할 컨테이너가 지정되지 않았습니다.' });
        }

        const pRes = await pool.query(
            `SELECT id, photo_path, cntr_no, uploaded_at 
             FROM container_photos 
             WHERE UPPER(TRIM(cntr_no)) = ANY($1) AND (is_deleted IS NOT TRUE)
             ORDER BY uploaded_at ASC, id ASC`,
            [targetCntrs]
        );

        const crypto = require('crypto');
        const getFileMd5 = (filePath) => {
            try {
                if (!fs.existsSync(filePath)) return null;
                const buf = fs.readFileSync(filePath);
                return crypto.createHash('md5').update(buf).digest('hex');
            } catch (e) {
                return null;
            }
        };

        const duplicateIds = [];
        const seenHashMap = {};

        for (const row of pRes.rows) {
            const fullPath = path.resolve(CTNR_UPLOADS_DIR, row.photo_path);
            const hash = getFileMd5(fullPath);
            if (hash) {
                const key = `${row.cntr_no}_${hash}`;
                if (seenHashMap[key]) {
                    duplicateIds.push(row.id);
                } else {
                    seenHashMap[key] = row.id;
                }
            }
        }

        let cleanedCount = 0;
        if (duplicateIds.length > 0) {
            await pool.query(
                `UPDATE container_photos SET is_deleted = true, deleted_at = NOW() WHERE id = ANY($1)`,
                [duplicateIds]
            );
            cleanedCount = duplicateIds.length;
        }

        res.json({
            success: true,
            cleanedCount,
            message: `성공적으로 중복 사진 ${cleanedCount}장을 정리(휴지통 이동)했습니다.`
        });
    } catch (err) {
        console.error("POST /api/photos/duplicates error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 사진 로컬 복사 API (CTNR 호환)
app.post('/api/photos/local-copy', async (req, res) => {
    try {
        const pool = await getPool();
        const { ids, targetPath, conflictAction = 'overwrite' } = req.body;

        if (!Array.isArray(ids) || ids.length === 0 || !targetPath) {
            return res.status(400).json({ success: false, error: '복사할 사진 ID와 대상 경로를 지정해 주세요.' });
        }

        const resolvedTargetDir = path.resolve(targetPath);
        if (!fs.existsSync(resolvedTargetDir)) {
            try {
                fs.mkdirSync(resolvedTargetDir, { recursive: true });
            } catch (e) {
                return res.status(400).json({ success: false, error: `대상 폴더 생성 실패: ${e.message}` });
            }
        }

        const pRes = await pool.query(
            `SELECT cp.cntr_no, cp.photo_path FROM container_photos cp WHERE cp.id = ANY($1) AND (cp.is_deleted IS NOT TRUE)`,
            [ids]
        );

        let copiedCount = 0;
        let skippedCount = 0;

        for (const photo of pRes.rows) {
            const srcPath = path.resolve(CTNR_UPLOADS_DIR, photo.photo_path);
            const filename = path.basename(photo.photo_path);
            const cntrFolder = path.resolve(resolvedTargetDir, photo.cntr_no || '기타');
            if (!fs.existsSync(cntrFolder)) fs.mkdirSync(cntrFolder, { recursive: true });
            const destPath = path.resolve(cntrFolder, filename);

            if (fs.existsSync(destPath) && conflictAction === 'skip') {
                skippedCount++;
                continue;
            }

            if (fs.existsSync(srcPath)) {
                try {
                    fs.copyFileSync(srcPath, destPath);
                    copiedCount++;
                } catch (e) {
                    skippedCount++;
                }
            } else {
                skippedCount++;
            }
        }

        res.json({
            success: true,
            copiedCount,
            skippedCount,
            targetPath: resolvedTargetDir,
            message: `총 ${copiedCount}장의 사진이 '${resolvedTargetDir}'(으)로 복사되었습니다.` + (skippedCount > 0 ? ` (${skippedCount}장 건너뜀)` : '')
        });
    } catch (err) {
        console.error("POST /api/photos/local-copy error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. 사진 스트리밍 서빙 API (CTNR 호환 + Google Drive 자동 다운로드 & 캐싱)
app.get('/api/photos/view', async (req, res) => {
    try {
        const rawFilename = req.query.filename;
        const isDownloadMode = req.query.download === '1';

        if (!rawFilename) {
            return res.status(400).send('Filename is required');
        }

        const filename = rawFilename.split('?')[0];
        const filePath = path.resolve(CTNR_UPLOADS_DIR, filename);

        // Directory traversal 방지
        const relPath = path.relative(CTNR_UPLOADS_DIR, filePath);
        if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
            return res.status(403).send('Forbidden');
        }

        // 1. 로컬 디스크에 파일이 존재하는 경우 즉시 전송
        if (fs.existsSync(filePath)) {
            let contentType = 'image/jpeg';
            if (filePath.toLowerCase().endsWith('.png')) contentType = 'image/png';
            else if (filePath.toLowerCase().endsWith('.webp')) contentType = 'image/webp';
            else if (filePath.toLowerCase().endsWith('.gif')) contentType = 'image/gif';

            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            if (isDownloadMode) {
                res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`);
            }
            return res.sendFile(filePath);
        }

        // 2. 로컬 디스크에 없는 경우: Google Drive에서 다운로드 시도 (완료된 작업 사진 백업)
        try {
            const pool = await getPool();
            let gdriveFileId = null;

            const gRes = await pool.query(
                'SELECT gdrive_url, gdrive_file_id FROM container_photos WHERE photo_path = $1 AND (is_deleted IS NOT TRUE) LIMIT 1',
                [filename]
            );
            if (gRes.rows.length > 0 && gRes.rows[0].gdrive_file_id) {
                gdriveFileId = gRes.rows[0].gdrive_file_id;
            }

            // DB에 gdrive_file_id가 없으면 파일명으로 검색
            if (!gdriveFileId) {
                const baseName = path.basename(filename);
                const found = await findGoogleDriveFileByName(baseName);
                if (found) gdriveFileId = found.fileId;
            }

            if (gdriveFileId) {
                const gdriveBuffer = await downloadFromGoogleDrive(gdriveFileId);
                if (gdriveBuffer && gdriveBuffer.length > 0) {
                    // 로컬 디스크에 캐싱하여 다음 요청부터 즉시 서빙
                    try {
                        const dir = path.dirname(filePath);
                        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                        fs.writeFileSync(filePath, gdriveBuffer);
                        console.log(`[Cache] Google Drive 사진 로컬 캐시 완료: ${filePath}`);
                    } catch (cacheErr) {
                        console.warn('[Cache Error]', cacheErr.message);
                    }

                    res.setHeader('Content-Type', 'image/jpeg');
                    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                    if (isDownloadMode) {
                        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(filename))}"`);
                    }
                    return res.send(gdriveBuffer);
                }
            }
        } catch (gErr) {
            console.warn('[GDrive Fallback Warning]', gErr.message);
        }

        // 3. 메인 서버 / 원격 CTNR 서버에서 fetch 시도 (다른 PC에서 접속 시 메인 PC 사진 자동 동기화 & 로컬 캐싱)
        let customMainHost = null;
        try {
            const hostConfigFile = path.join(DATA_DIR, 'main_server_config.json');
            if (fs.existsSync(hostConfigFile)) {
                const parsed = JSON.parse(fs.readFileSync(hostConfigFile, 'utf8'));
                if (parsed.mainServerHost) customMainHost = parsed.mainServerHost.trim();
            }
        } catch (e) {}

        const adminSessionCookie = Buffer.from(JSON.stringify({ id: '1', username: 'admin', name: '관리자', role: 'ADMIN' })).toString('base64');

        const remoteHosts = [
            customMainHost,
            'http://192.168.10.152:3000',
            'http://10.162.39.58:3000',
            'http://ungdong.iptime.org:3000',
            'http://ungdong.iptime.org:4001',
            'http://idlezero.iptime.org:3000',
            'http://idlezero.iptime.org:4001',
            'http://ungdong.iptime.org:4000',
            'http://idlezero.iptime.org:4000'
        ].filter(Boolean);

        for (const host of remoteHosts) {
            try {
                const remoteUrl = `${host}/api/photos/view?filename=${encodeURIComponent(filename)}`;
                const headers = {
                    'Cookie': `ctnr_session=${adminSessionCookie}`,
                    'User-Agent': 'ExcelCompareClient/1.2.2'
                };
                const remoteRes = await fetch(remoteUrl, { headers, signal: AbortSignal.timeout(3500) });
                if (remoteRes.ok) {
                    const arrayBuffer = await remoteRes.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    const fetchedType = remoteRes.headers.get('content-type') || 'image/jpeg';

                    if (fetchedType.toLowerCase().includes('image') && buffer.length > 0) {
                        try {
                            const dir = path.dirname(filePath);
                            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                            fs.writeFileSync(filePath, buffer);
                            console.log(`[Sync] 원격 서버(${host})로부터 사진 로컬 캐시 성공: ${filePath}`);
                        } catch (e) {}

                        res.setHeader('Content-Type', fetchedType);
                        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                        if (isDownloadMode) {
                            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(filename))}"`);
                        }
                        return res.send(buffer);
                    }
                }
            } catch (remoteErr) {}
        }
        return res.status(404).send('Photo not found');
    } catch (err) {
        console.error("GET /api/photos/view error:", err);
        res.status(500).send('Internal Server Error');
    }
});

// ==========================================
// [REPORT GENERATION ENGINE (CTNR 호환)]
// ==========================================

const REPORT_BREAK_TIMES = [
    { start: 120, end: 130, name: '휴식' },  // 21:00 ~ 21:10
    { start: 240, end: 300, name: '식사' },  // 23:00 ~ 24:00
    { start: 420, end: 430, name: '휴식' },  // 02:00 ~ 02:10
];
const REPORT_SHIFT_START_HOUR = 19;

function getReportWorkDateString(d) {
    const dateObj = new Date(d);
    if (isNaN(dateObj.getTime())) return '';
    if (dateObj.getHours() < 13) {
        dateObj.setDate(dateObj.getDate() - 1);
    }
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatReportOffsetToTime(offsetMinutes) {
    const totalMinutes = (REPORT_SHIFT_START_HOUR * 60 + offsetMinutes) % (24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function advanceReportWorkTime(startOffsetMinutes, durationMinutes) {
    let currentOffset = startOffsetMinutes;
    let remainingWorkMins = Math.max(1, durationMinutes);

    while (true) {
        let insideBreak = false;
        for (const b of REPORT_BREAK_TIMES) {
            if (currentOffset >= b.start && currentOffset < b.end) {
                currentOffset = b.end;
                insideBreak = true;
                break;
            }
        }
        if (!insideBreak) break;
    }

    const actualStartOffset = currentOffset;
    let hasBreak = false;

    while (remainingWorkMins > 0) {
        let isBreak = false;
        for (const b of REPORT_BREAK_TIMES) {
            if (currentOffset >= b.start && currentOffset < b.end) {
                isBreak = true;
                hasBreak = true;
                break;
            }
        }
        if (!isBreak) {
            remainingWorkMins--;
        }
        currentOffset++;
    }

    const actualEndOffset = currentOffset;

    return {
        endOffsetMinutes: actualEndOffset,
        startTimeStr: formatReportOffsetToTime(actualStartOffset),
        endTimeStr: formatReportOffsetToTime(actualEndOffset),
        durationMinutes,
        hasBreak
    };
}

function calculateReportTeamTimeline(containers) {
    let currentOffset = 0;
    return containers.map((item) => {
        const duration = item.durationMinutes && item.durationMinutes > 0 ? item.durationMinutes : 45;
        const result = advanceReportWorkTime(currentOffset, duration);
        currentOffset = result.endOffsetMinutes;
        return {
            ...item,
            durationMinutes: duration,
            startTimeStr: result.startTimeStr,
            endTimeStr: result.endTimeStr,
            hasBreak: result.hasBreak,
            workTimeStr: `${result.startTimeStr}~${result.endTimeStr}`
        };
    });
}

function getNormalizedReportCarrier(transporter, fallbackTeam) {
    const t = (transporter || '').trim();
    if (t) {
        if (t.includes('천마')) return '천마';
        if (t.includes('BNI') || t.includes('비엔아이')) return 'BNI';
        if (t.includes('재작업')) return '재작업';
        if (t.includes('기타') || t.includes('오류')) return '기타';
        return '기타';
    }
    const team = (fallbackTeam || '').trim();
    if (team.includes('천마')) return '천마';
    if (team.includes('BNI') || team.includes('비엔아이')) return 'BNI';
    return '기타';
}

function generateReportJobType(products) {
    if (!products || products.length === 0) return '';
    let totalCdzQty = 0;
    let totalValidQty = 0;
    const uniqueModels = new Set();

    for (const p of products) {
        if (p.division === 'ZZZ') continue;
        uniqueModels.add(p.name);
        totalValidQty += (p.qty || 0);
        if (p.division === 'CDZ') {
            totalCdzQty += (p.qty || 0);
        }
    }

    const isMultiModel = uniqueModels.size >= 6;
    const jobTypes = new Set();

    for (const p of products) {
        if (p.division === 'ZZZ') continue;
        const nameUpper = (p.name || '').toUpperCase();
        let typeName = '';

        switch (p.division) {
            case 'DFZ':
                if (nameUpper.startsWith('WDP')) {
                    typeName = '페데스탈';
                } else {
                    typeName = '세탁기';
                }
                break;
            case 'CVZ':
                if (nameUpper.startsWith('SK')) {
                    typeName = 'SK오븐';
                } else if (p.height !== undefined && p.height > 0 && p.height <= 500) {
                    typeName = '쿡탑';
                } else {
                    typeName = '오븐';
                }
                break;
            case 'CNZ':
                if (nameUpper.startsWith('SK')) {
                    typeName = 'SK냉장고';
                } else {
                    typeName = '냉장고';
                }
                break;
            case 'CDZ':
                if (totalCdzQty > 150) {
                    typeName = '글로벌식기';
                } else {
                    typeName = '식기';
                }
                break;
            case 'DHZ':
                typeName = '콤프';
                break;
            case 'DMZ':
                typeName = '에어컨';
                break;
            default:
                typeName = p.division || '기타';
                break;
        }
        if (typeName) {
            jobTypes.add(typeName);
        }
    }

    if (jobTypes.has('SK오븐') && jobTypes.has('오븐')) {
        jobTypes.delete('오븐');
    }
    if (jobTypes.has('SK냉장고') && jobTypes.has('냉장고')) {
        jobTypes.delete('냉장고');
    }

    // 냉장고와 콤프가 함께 들어가는 작업은 "콤프"로 표기
    if (jobTypes.has('콤프') && (jobTypes.has('냉장고') || jobTypes.has('SK냉장고'))) {
        jobTypes.delete('냉장고');
        jobTypes.delete('SK냉장고');
    }

    let finalType = '';
    const sortedTypes = Array.from(jobTypes);

    if (sortedTypes.length === 1 && sortedTypes[0] === '냉장고' && uniqueModels.size <= 3 && totalValidQty >= 48 && totalValidQty <= 51) {
        finalType = '횡적';
    } else if (sortedTypes.length >= 2) {
        finalType = sortedTypes.join('') + '혼적';
    } else if (sortedTypes.length === 1) {
        finalType = sortedTypes[0];
    }

    if (isMultiModel && finalType) {
        finalType = '다모델 ' + finalType;
    }

    // 일렉오븐 조건: ZZZ 제외 모든 제품이 CVZ(오븐)이고, 높이가 630이상 670이하이며, 총 수량이 180개 이상인 경우
    const isElecOvenContainer = totalValidQty >= 180 && products.length > 0 && products.filter(p => p.division !== 'ZZZ').every(p => {
        return p.division === 'CVZ' && p.height !== undefined && p.height >= 630 && p.height <= 670;
    });

    // 레이다운식기 조건: ZZZ 제외 모든 제품이 CDZ(식기)이고, 높이가 900이상이며, 총 수량이 128~135개 사이인 경우
    const isLaydownDishwasher = totalValidQty >= 128 && totalValidQty <= 135 && products.length > 0 && products.filter(p => p.division !== 'ZZZ').every(p => {
        return p.division === 'CDZ' && p.height !== undefined && p.height >= 900;
    });

    if (isElecOvenContainer) {
        finalType = isMultiModel ? '다모델 일렉오븐' : '일렉오븐';
    } else if (isLaydownDishwasher) {
        finalType = isMultiModel ? '다모델 레이다운식기' : '레이다운식기';
    }

    return finalType;
}

function buildReportTextFromData(dataArray, preset = 'full') {
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
                if (!c.isCancelled && !c.adminComment?.includes('[취소]') && !c.adminComment?.includes('[작업취소]') && !c.adminComment?.includes('[작업제외]')) {
                    const cName = getNormalizedReportCarrier(c.transporter, u.teamName);
                    activeCarrierCounts[cName] = (activeCarrierCounts[cName] || 0) + 1;
                }
            });
        });
        const finalCarrierCounts = dateGroup.customCarrierCounts || activeCarrierCounts;
        const displayTotal = Object.values(finalCarrierCounts).reduce((a, b) => a + b, 0);

        const carrierEntries = Object.entries(finalCarrierCounts);
        const carrierStr = carrierEntries.length > 0 ? ` ( ${carrierEntries.map(([k, v]) => `${k}: ${v}개`).join(', ')} )` : '';
        const remarkText = dateGroup.customRemark ? ` | 비고: ${dateGroup.customRemark}` : '';
        lines.push(`총합계: ${displayTotal}개 작업완료${carrierStr}${remarkText}\n`);

        if (preset === 'anomaly') {
            let anomalyCount = 0;
            dateGroup.uploaders?.forEach((team) => {
                const teamAnomalies = (team.containers || []).filter((cntr) => 
                    cntr.isCancelled || 
                    cntr.adminComment?.includes('[취소]') || 
                    cntr.adminComment?.includes('[작업취소]') || 
                    cntr.adminComment?.includes('[작업제외]') || 
                    (cntr.adminComment && cntr.adminComment.trim()) || 
                    (cntr.lastRemark && cntr.lastRemark.trim()) ||
                    (cntr.remark && cntr.remark.trim())
                );

                if (teamAnomalies.length > 0) {
                    lines.push(`■ ${team.teamName}`);
                    teamAnomalies.forEach((cntr) => {
                        anomalyCount++;
                        const isExcluded = cntr.adminComment?.includes('[작업제외]');
                        const isCancelled = !isExcluded && (cntr.isCancelled || cntr.adminComment?.includes('[취소]') || cntr.adminComment?.includes('[작업취소]'));
                        const cancelTag = isExcluded ? ' [작업제외]' : isCancelled ? ' [작업취소]' : '';
                        const cleanComment = cntr.adminComment ? cntr.adminComment.replace(/\[작업취소\]/g, '').replace(/\[작업제외\]/g, '').replace(/\[취소\]/g, '').trim() : '';
                        const adminCommentNote = cleanComment ? ` (코멘트: ${cleanComment})` : '';
                        const remarkNote = (cntr.lastRemark || cntr.remark || '').trim();

                        lines.push(`- ${cntr.cntrNo}${cancelTag}${adminCommentNote}`);
                        if (remarkNote) {
                            lines.push(`  💬 비고/지연: ${remarkNote}`);
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
            const activeTeamCntrs = (team.containers || []).filter((c) => !c.isCancelled && !c.adminComment?.includes('[취소]') && !c.adminComment?.includes('[작업취소]') && !c.adminComment?.includes('[작업제외]'));
            lines.push(`■ ${team.teamName} (합계 ${activeTeamCntrs.length}개)`);
            team.containers?.forEach((cntr) => {
                const isExcluded = cntr.adminComment?.includes('[작업제외]');
                const isCancelled = !isExcluded && (cntr.isCancelled || cntr.adminComment?.includes('[취소]') || cntr.adminComment?.includes('[작업취소]'));
                const cancelTag = isExcluded ? ' [작업제외]' : isCancelled ? ' [작업취소]' : '';

                const cleanComment = cntr.adminComment ? cntr.adminComment.replace(/\[작업취소\]/g, '').replace(/\[작업제외\]/g, '').replace(/\[취소\]/g, '').trim() : '';
                const adminCommentNote = cleanComment ? ` (${cleanComment})` : '';

                const totalQty = cntr.totalQty ? cntr.totalQty.toLocaleString() : (cntr.products || []).reduce((s, p) => s + (p.qty || 0), 0).toLocaleString();
                const modelCount = cntr.modelCount || cntr.products?.length || 0;
                
                if (preset === 'summary') {
                    lines.push(`- ${cntr.cntrNo}${cancelTag} (${modelCount}모델, ${totalQty}개${adminCommentNote}) ${cntr.workTimeStr ? `[${cntr.workTimeStr}]` : ''}`);
                    if (cntr.lastRemark && cntr.lastRemark.trim()) {
                        lines.push(`  💬 ${cntr.lastRemark.trim()}`);
                    }
                } else {
                    lines.push(`${cntr.cntrNo}${cancelTag} (${modelCount}모델, ${totalQty}개${adminCommentNote}) [${cntr.workTimeStr || ''}]`);

                    if (cntr.lastRemark && cntr.lastRemark.trim()) {
                        lines.push(`- 💬 ${cntr.lastRemark.trim()}`);
                    }
                    if (cntr.products) {
                        for (const p of cntr.products) {
                            lines.push(`- [${p.division || 'DFZ'}] ${p.name} ${(p.qty || 0).toLocaleString()}개`);
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

app.get('/api/reports/generate', async (req, res) => {
    try {
        const pool = await getPool();
        const client = await pool.connect();
        try {
            const todayWorkDateStr = getReportWorkDateString(new Date());
            const startDateStr = typeof req.query.startDate === 'string' ? req.query.startDate.trim() : '';
            const endDateStr = typeof req.query.endDate === 'string' ? req.query.endDate.trim() : '';
            const productNameStr = typeof req.query.productName === 'string' ? req.query.productName.trim() : '';
            const containerNoStr = typeof req.query.cntrNo === 'string' ? req.query.cntrNo.trim() : '';
            const targetDateStr = startDateStr || todayWorkDateStr;

            const whereClauses = [];
            const params = [];
            let paramIdx = 1;

            whereClauses.push(`COALESCE(r.qty_plan, 0) > 0`);

            if (!startDateStr && !endDateStr) {
                whereClauses.push(`COALESCE(p.uploaded_at, j.saved_at) AT TIME ZONE 'Asia/Seoul' >= $${paramIdx++}::timestamp`);
                params.push(`${todayWorkDateStr} 13:00:00`);
            } else {
                if (startDateStr) {
                    whereClauses.push(`COALESCE(p.uploaded_at, j.saved_at) AT TIME ZONE 'Asia/Seoul' >= $${paramIdx++}::timestamp`);
                    params.push(`${startDateStr} 13:00:00`);
                }
                if (endDateStr) {
                    whereClauses.push(`COALESCE(p.uploaded_at, j.saved_at) AT TIME ZONE 'Asia/Seoul' <= ($${paramIdx++}::date + INTERVAL '1 day 12 hours 59 minutes 59.999 seconds')`);
                    params.push(endDateStr);
                }
            }

            if (productNameStr) {
                whereClauses.push(`r.prod_name ILIKE $${paramIdx++}`);
                params.push(`%${productNameStr}%`);
            }
            if (containerNoStr) {
                whereClauses.push(`r.cntr_no ILIKE $${paramIdx++}`);
                params.push(`%${containerNoStr}%`);
            }

            const commentDateParamIdx = paramIdx++;
            params.push(targetDateStr);

            const whereSql = "WHERE " + whereClauses.join(" AND ");

            // Ensure container_comments table exists
            await client.query(`
                CREATE TABLE IF NOT EXISTS container_comments (
                    cntr_no VARCHAR(50) NOT NULL,
                    work_date VARCHAR(20) DEFAULT '',
                    admin_comment TEXT,
                    job_id INTEGER DEFAULT 0,
                    duration_minutes INT,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            `).catch(() => {});
            await client.query(`ALTER TABLE container_comments ADD COLUMN IF NOT EXISTS job_id INTEGER DEFAULT 0;`).catch(() => {});
            await client.query(`ALTER TABLE container_comments ADD COLUMN IF NOT EXISTS duration_minutes INT;`).catch(() => {});

            // Ensure manual_report_entries table exists
            await client.query(`
                CREATE TABLE IF NOT EXISTS manual_report_entries (
                    id SERIAL PRIMARY KEY,
                    work_date VARCHAR(20) NOT NULL,
                    team_name VARCHAR(50) NOT NULL,
                    cntr_no VARCHAR(50) NOT NULL,
                    category VARCHAR(100),
                    duration_minutes INTEGER DEFAULT 45,
                    remark TEXT,
                    products JSONB,
                    empty_boxes JSONB,
                    first_uploaded_at TIMESTAMP WITH TIME ZONE,
                    transporter VARCHAR(100),
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            `).catch(() => {});

            // Main grouped results query
            const query = `
                WITH GroupedResults AS (
                    SELECT 
                        j.id as job_id,
                        COALESCE(r.cntr_no, j.job_name, '미지정') as cntr_no,
                        r.prod_name,
                        r.division,
                        SUM(COALESCE(r.qty_plan, 0)) as qty,
                        COALESCE(t.name, '미지정 조') as team_name,
                        BOOL_OR(p.is_completed) as is_completed,
                        COALESCE(MAX(p.uploaded_at), MAX(j.saved_at)) as work_time,
                        COALESCE(MAX(cc.duration_minutes), MAX(p.work_duration_minutes), 45) as duration_minutes,
                        COALESCE(MIN(p.uploaded_at), MAX(j.saved_at)) as first_uploaded_at,
                        MAX(p.remark) as remark,
                        MAX(r.transporter) as transporter,
                        MAX(cc.admin_comment) as admin_comment,
                        MAX(mp.height) as height,
                        MAX(r.remark) as db_remark
                    FROM container_results r
                    JOIN container_jobs j ON r.job_id = j.id
                    LEFT JOIN product_master_sync mp ON r.prod_name = mp.prod_name
                    LEFT JOIN (
                        SELECT 
                            cp.job_id as photo_job_id,
                            cp.cntr_no, 
                            MAX(cp.team_id) as team_id,
                            MAX(cp.work_duration_minutes) as work_duration_minutes,
                            BOOL_OR(cp.is_completed) as is_completed,
                            MIN(cp.uploaded_at) as uploaded_at,
                            MAX(cp.remark) as remark
                        FROM container_photos cp
                        WHERE (cp.is_deleted IS NOT TRUE)
                        GROUP BY cp.job_id, cp.cntr_no
                    ) p ON p.photo_job_id = j.id AND (p.cntr_no = r.cntr_no OR (r.cntr_no IS NULL AND p.cntr_no IS NULL))
                    LEFT JOIN teams t ON p.team_id = t.id
                    LEFT JOIN container_comments cc 
                      ON cc.cntr_no = COALESCE(r.cntr_no, j.job_name, '미지정')
                     AND (cc.work_date = $${commentDateParamIdx} OR cc.work_date = '' OR cc.work_date IS NULL)
                     AND (cc.job_id = j.id OR cc.job_id = 0 OR cc.job_id IS NULL)
                    ${whereSql}
                    GROUP BY j.id, COALESCE(r.cntr_no, j.job_name, '미지정'), r.prod_name, r.division, t.name
                )
                SELECT gr.*,
                       (SELECT json_agg(json_build_object('name', eb.box_name, 'qty', eb.qty)) 
                        FROM container_empty_boxes eb 
                        WHERE eb.job_id = gr.job_id AND eb.cntr_no = gr.cntr_no AND eb.qty > 0) as empty_boxes
                FROM GroupedResults gr
                ORDER BY gr.team_name, gr.cntr_no, gr.prod_name
            `;

            let rows = [];
            try {
                const resDb = await client.query(query, params);
                rows = resDb.rows || [];
            } catch (queryErr) {
                console.warn("[Report query warn]:", queryErr.message);
                const fallbackQuery = `
                    SELECT 
                        COALESCE(r.cntr_no, '미지정') as cntr_no,
                        r.job_id,
                        r.prod_name,
                        r.division,
                        SUM(COALESCE(r.qty_plan, 0)) as qty,
                        '1조' as team_name,
                        MAX(r.transporter) as transporter,
                        NOW() as first_uploaded_at,
                        45 as duration_minutes
                    FROM container_results r
                    GROUP BY r.job_id, r.cntr_no, r.prod_name, r.division
                    LIMIT 200
                `;
                const resFb = await client.query(fallbackQuery);
                rows = resFb.rows || [];
            }

            // Fetch manual report entries
            let manualRows = [];
            try {
                const manualRes = await client.query(`SELECT * FROM manual_report_entries WHERE work_date = $1`, [targetDateStr]);
                manualRows = manualRes.rows || [];
            } catch (mErr) {}

            // Group by workDate -> teamName -> entryKey
            const dateMap = new Map();

            for (const row of rows) {
                const teamName = row.team_name || '미지정 조';
                if (!teamName || teamName === '미지정 조') continue;

                const cntrNo = row.cntr_no;
                const entryKey = `db_${row.job_id}_${cntrNo}`;
                const division = row.division || '일반';
                const prodName = row.prod_name;
                const qty = Math.round(Number(row.qty)) || 0;
                const height = Number(row.height) || 0;
                const isCompleted = !!row.is_completed;
                const workTime = row.work_time ? new Date(row.work_time) : new Date();
                const durationMinutes = Number(row.duration_minutes) || 45;
                const firstUploadedAt = row.first_uploaded_at ? new Date(row.first_uploaded_at) : workTime;
                const remark = row.remark || '';
                const transporter = row.transporter || '';
                const adminComment = row.admin_comment || '';
                const workDateStr = getReportWorkDateString(workTime);

                if (!dateMap.has(workDateStr)) dateMap.set(workDateStr, new Map());
                const teamMap = dateMap.get(workDateStr);

                if (!teamMap.has(teamName)) teamMap.set(teamName, new Map());
                const cntrMap = teamMap.get(teamName);

                if (!cntrMap.has(entryKey)) {
                    cntrMap.set(entryKey, { cntrNo, jobId: row.job_id, isCompleted, division, durationMinutes, firstUploadedAt, remark, transporter, adminComment, products: [], emptyBoxes: [] });
                }
                const cntrData = cntrMap.get(entryKey);
                if (remark && !cntrData.remark) cntrData.remark = remark;
                if (transporter && !cntrData.transporter) cntrData.transporter = transporter;
                if (adminComment && !cntrData.adminComment) cntrData.adminComment = adminComment;
                cntrData.products.push({ name: prodName, qty, division, height });
                
                const emptyBoxes = Array.isArray(row.empty_boxes) ? row.empty_boxes : [];
                if (emptyBoxes.length > 0 && cntrData.emptyBoxes.length === 0) {
                    cntrData.emptyBoxes = emptyBoxes;
                }
            }

            // Merge Manual Entries
            for (const mRow of manualRows) {
                const workDateStr = mRow.work_date;
                const teamName = mRow.team_name;
                const cntrNo = mRow.cntr_no;
                const entryKey = `manual_${mRow.id}_${cntrNo}`;
                
                if (!dateMap.has(workDateStr)) dateMap.set(workDateStr, new Map());
                const teamMap = dateMap.get(workDateStr);
                if (!teamMap.has(teamName)) teamMap.set(teamName, new Map());
                const cntrMap = teamMap.get(teamName);
                
                if (!cntrMap.has(entryKey)) {
                    cntrMap.set(entryKey, { 
                        cntrNo,
                        isCompleted: true, 
                        division: 'DFZ', 
                        durationMinutes: mRow.duration_minutes || 45, 
                        firstUploadedAt: mRow.first_uploaded_at ? new Date(mRow.first_uploaded_at) : new Date(), 
                        remark: mRow.remark || '', 
                        transporter: mRow.transporter || '',
                        adminComment: mRow.category || '', 
                        products: [], 
                        emptyBoxes: [],
                        manualEntryId: mRow.id
                    });
                }
                
                const cntrData = cntrMap.get(entryKey);
                const mProducts = mRow.products || [];
                for (const p of mProducts) {
                    cntrData.products.push({ name: p.name, qty: p.qty, division: p.division || 'DFZ', height: 0 });
                }
                const mEmptyBoxes = mRow.empty_boxes || [];
                if (mEmptyBoxes.length > 0) {
                    cntrData.emptyBoxes.push(...mEmptyBoxes);
                }
            }

            const sortedDates = Array.from(dateMap.keys()).sort((a, b) => b.localeCompare(a));
            const reportData = [];

            sortedDates.forEach((dateStr) => {
                const teamMap = dateMap.get(dateStr);
                let totalContainersSum = 0;
                const uploaders = [];

                const sortedTeamNames = Array.from(teamMap.keys()).sort((a, b) => a.localeCompare(b, 'ko-KR'));

                sortedTeamNames.forEach((teamName) => {
                    const cntrMap = teamMap.get(teamName);
                    const rawList = Array.from(cntrMap.values()).sort((a, b) => a.firstUploadedAt.getTime() - b.firstUploadedAt.getTime());
                    const timelineList = calculateReportTeamTimeline(rawList);

                    timelineList.forEach(c => {
                        if (!c.adminComment) {
                            c.adminComment = generateReportJobType(c.products);
                        }
                    });

                    totalContainersSum += timelineList.length;
                    uploaders.push({
                        teamName,
                        totalContainers: timelineList.length,
                        containers: timelineList
                    });
                });

                reportData.push({
                    date: dateStr,
                    dateStr,
                    totalContainers: totalContainersSum,
                    uploaders
                });
            });

            const reportText = buildReportTextFromData(reportData, 'full');
            return res.json({
                success: true,
                reportData,
                reportText
            });

        } finally {
            client.release();
        }
    } catch (err) {
        console.error("GET /api/reports/generate error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/reports/comment', async (req, res) => {
    try {
        const { cntrNo, workDate, adminComment } = req.body;
        if (!cntrNo) return res.status(400).json({ success: false, message: "컨테이너 번호가 필요합니다." });

        const pool = await getPool();
        const client = await pool.connect();
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS container_comments (
                    cntr_no VARCHAR(50) NOT NULL,
                    work_date VARCHAR(20) DEFAULT '',
                    admin_comment TEXT,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (cntr_no, work_date)
                );
            `);

            await client.query(`
                INSERT INTO container_comments (cntr_no, work_date, admin_comment)
                VALUES ($1, $2, $3)
                ON CONFLICT (cntr_no, work_date)
                DO UPDATE SET admin_comment = EXCLUDED.admin_comment;
            `, [cntrNo.trim(), (workDate || '').trim(), adminComment || '']);

            return res.json({ success: true, message: "메모/코멘트가 저장되었습니다." });
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("POST /api/reports/comment error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// --- 보고서 영구 저장 (Save Daily Report) ---
app.post('/api/reports/save', async (req, res) => {
    try {
        const { workDate, reportText, reportData, savedBy } = req.body;
        if (!workDate) return res.status(400).json({ success: false, error: "작업일자가 필요합니다." });

        const pool = await getPool();
        const client = await pool.connect();
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS daily_work_reports (
                    work_date VARCHAR(20) PRIMARY KEY,
                    report_text TEXT NOT NULL,
                    report_data JSONB,
                    saved_by VARCHAR(100),
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            `);

            const dbRes = await client.query(`
                INSERT INTO daily_work_reports (work_date, report_text, report_data, saved_by, updated_at)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT (work_date)
                DO UPDATE SET
                    report_text = EXCLUDED.report_text,
                    report_data = EXCLUDED.report_data,
                    saved_by = EXCLUDED.saved_by,
                    updated_at = NOW()
                RETURNING updated_at;
            `, [workDate.trim(), reportText || '', JSON.stringify(reportData || []), savedBy || '관리자']);

            const updatedAt = dbRes.rows[0]?.updated_at;
            return res.json({
                success: true,
                message: `${workDate} 보고서가 성공적으로 DB에 저장되었습니다.`,
                updatedAt: updatedAt ? new Date(updatedAt).toISOString() : new Date().toISOString(),
                savedBy: savedBy || '관리자'
            });
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("POST /api/reports/save error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// --- 저장된 보고서 불러오기 (Get Saved Daily Report) ---
app.get('/api/reports/saved', async (req, res) => {
    try {
        const workDate = (req.query.workDate || '').trim();
        if (!workDate) return res.status(400).json({ success: false, error: "작업일자가 필요합니다." });

        const pool = await getPool();
        const client = await pool.connect();
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS daily_work_reports (
                    work_date VARCHAR(20) PRIMARY KEY,
                    report_text TEXT NOT NULL,
                    report_data JSONB,
                    saved_by VARCHAR(100),
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            `);

            const dbRes = await client.query(`
                SELECT work_date, report_text, report_data, saved_by, updated_at
                FROM daily_work_reports
                WHERE work_date = $1
            `, [workDate]);

            if (dbRes.rows.length === 0) {
                return res.json({ success: false, message: `${workDate}에 저장된 보고서가 없습니다.` });
            }

            const row = dbRes.rows[0];
            let parsedData = [];
            try {
                parsedData = typeof row.report_data === 'string' ? JSON.parse(row.report_data) : (row.report_data || []);
            } catch (e) {
                parsedData = [];
            }

            return res.json({
                success: true,
                workDate: row.work_date,
                reportText: row.report_text,
                reportData: parsedData,
                savedBy: row.saved_by,
                updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined
            });
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("GET /api/reports/saved error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// --- 작업취소 / 작업제외 상태 토글 및 저장 ---
app.post('/api/reports/toggle-cancel', async (req, res) => {
    try {
        const { jobId, cntrNo, workDate, mode, cancelType } = req.body;
        if (!cntrNo) return res.status(400).json({ success: false, error: "컨테이너 번호가 필요합니다." });

        const pool = await getPool();
        const client = await pool.connect();
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS container_comments (
                    cntr_no VARCHAR(50) NOT NULL,
                    work_date VARCHAR(20) DEFAULT '',
                    admin_comment TEXT,
                    job_id INTEGER DEFAULT 0,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (cntr_no, work_date)
                );
            `).catch(() => {});
            await client.query(`ALTER TABLE container_comments ADD COLUMN IF NOT EXISTS job_id INTEGER DEFAULT 0;`).catch(() => {});

            const cleanCntrNo = cntrNo.trim();
            const targetDate = (workDate || '').trim();
            const parsedJobId = jobId ? Number(jobId) : 0;

            const sel = await client.query(`
                SELECT admin_comment FROM container_comments 
                WHERE cntr_no = $1 
                  AND (work_date = $2 OR work_date = '' OR work_date IS NULL)
                  AND (job_id = $3 OR job_id = 0 OR job_id IS NULL)
                ORDER BY id DESC LIMIT 1
            `.replace('ORDER BY id DESC', 'ORDER BY created_at DESC'), [cleanCntrNo, targetDate, parsedJobId]);

            let currentComment = sel.rows[0]?.admin_comment || '';
            let newComment = currentComment;

            if (cancelType) {
                // 직접 특정 타입 지정 (cancel / exclude)
                const tag = cancelType === 'exclude' ? '[작업제외]' : '[작업취소]';
                const clean = currentComment.replace(/\[작업취소\]/g, '').replace(/\[작업제외\]/g, '').replace(/\[취소\]/g, '').trim();
                newComment = clean ? `${clean} ${tag}`.trim() : tag;
            } else {
                // 토글 처리
                const isCurrentlyCancelled = currentComment.includes('[작업취소]') || currentComment.includes('[작업제외]') || currentComment.includes('[취소]');
                if (isCurrentlyCancelled) {
                    newComment = currentComment.replace(/\[작업취소\]/g, '').replace(/\[작업제외\]/g, '').replace(/\[취소\]/g, '').trim();
                } else {
                    const tag = mode === 'exclude' ? '[작업제외]' : '[작업취소]';
                    const clean = currentComment.replace(/\[작업취소\]/g, '').replace(/\[작업제외\]/g, '').replace(/\[취소\]/g, '').trim();
                    newComment = clean ? `${clean} ${tag}`.trim() : tag;
                }
            }

            await client.query(`
                DELETE FROM container_comments 
                WHERE cntr_no = $1 
                  AND (work_date = $2 OR work_date = '' OR work_date IS NULL)
                  AND (job_id = $3 OR job_id = 0);

                INSERT INTO container_comments (cntr_no, work_date, admin_comment, job_id)
                VALUES ($1, $2, $3, $4);
            `, [cleanCntrNo, targetDate, newComment, parsedJobId]);

            return res.json({
                success: true,
                cntrNo: cleanCntrNo,
                adminComment: newComment,
                isCancelled: newComment.includes('[작업취소]') || newComment.includes('[취소]'),
                isExcluded: newComment.includes('[작업제외]')
            });
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("POST /api/reports/toggle-cancel error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// --- 수동 항목 추가 및 수정 (Manual Report Entry CRUD) ---
app.post('/api/reports/manual-entry', async (req, res) => {
    try {
        const { id, workDate, teamName, cntrNo, category, transporter, durationMinutes, remark, products, emptyBoxes, firstUploadedAt } = req.body;
        if (!cntrNo) return res.status(400).json({ success: false, error: "컨테이너 번호가 필요합니다." });

        const pool = await getPool();
        const client = await pool.connect();
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS manual_report_entries (
                    id SERIAL PRIMARY KEY,
                    work_date VARCHAR(20) NOT NULL,
                    team_name VARCHAR(50) NOT NULL,
                    cntr_no VARCHAR(50) NOT NULL,
                    category VARCHAR(100),
                    transporter VARCHAR(50),
                    duration_minutes INT DEFAULT 45,
                    remark TEXT,
                    products JSONB,
                    empty_boxes JSONB,
                    first_uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            `);

            if (id) {
                // 수정
                await client.query(`
                    UPDATE manual_report_entries
                    SET work_date = $1, team_name = $2, cntr_no = $3, category = $4, transporter = $5,
                        duration_minutes = $6, remark = $7, products = $8::jsonb, empty_boxes = $9::jsonb,
                        first_uploaded_at = COALESCE($10::timestamptz, first_uploaded_at)
                    WHERE id = $11
                `, [
                    workDate, teamName, cntrNo.trim().toUpperCase(), category || '', transporter || '',
                    durationMinutes || 45, remark || '', JSON.stringify(products || []), JSON.stringify(emptyBoxes || []),
                    firstUploadedAt ? new Date(firstUploadedAt).toISOString() : null, id
                ]);
                return res.json({ success: true, message: "수동 항목이 수정되었습니다." });
            } else {
                // 신규 추가
                const insRes = await client.query(`
                    INSERT INTO manual_report_entries (work_date, team_name, cntr_no, category, transporter, duration_minutes, remark, products, empty_boxes, first_uploaded_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::timestamptz)
                    RETURNING id;
                `, [
                    workDate, teamName, cntrNo.trim().toUpperCase(), category || '', transporter || '',
                    durationMinutes || 45, remark || '', JSON.stringify(products || []), JSON.stringify(emptyBoxes || []),
                    firstUploadedAt ? new Date(firstUploadedAt).toISOString() : new Date().toISOString()
                ]);
                return res.json({ success: true, message: "수동 항목이 추가되었습니다.", id: insRes.rows[0]?.id });
            }
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("POST /api/reports/manual-entry error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// --- 수동 항목 삭제 ---
app.delete('/api/reports/manual-entry', async (req, res) => {
    try {
        const id = req.query.id || req.body.id;
        if (!id) return res.status(400).json({ success: false, error: "삭제할 항목 ID가 필요합니다." });

        const pool = await getPool();
        const client = await pool.connect();
        try {
            await client.query('DELETE FROM manual_report_entries WHERE id = $1', [id]);
            return res.json({ success: true, message: "항목이 삭제되었습니다." });
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("DELETE /api/reports/manual-entry error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// --- 기존 컨테이너 보고서 상세 정보(소요시간/지연사유/운송사/카테고리) 수정 ---
app.post('/api/reports/update-container', async (req, res) => {
    try {
        const { jobId, cntrNo, workDate, durationMinutes, remark, category, transporter, emptyBoxes } = req.body;
        if (!cntrNo) return res.status(400).json({ success: false, error: "컨테이너 번호가 필요합니다." });

        const pool = await getPool();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const cleanCntrNo = cntrNo.trim().toUpperCase();
            const parsedJobId = jobId ? Number(jobId) : null;

            // 1. container_photos duration & remark
            if (parsedJobId) {
                await client.query(`
                    UPDATE container_photos 
                    SET work_duration_minutes = $1,
                        remark = $2
                    WHERE UPPER(TRIM(cntr_no)) = $3
                      AND (job_id = $4 OR job_id IS NULL)
                      AND (is_deleted IS NOT TRUE)
                `, [durationMinutes || 45, remark || '', cleanCntrNo, parsedJobId]);
            } else {
                await client.query(`
                    UPDATE container_photos 
                    SET work_duration_minutes = $1,
                        remark = $2
                    WHERE UPPER(TRIM(cntr_no)) = $3
                      AND (is_deleted IS NOT TRUE)
                `, [durationMinutes || 45, remark || '', cleanCntrNo]);
            }

            // 2. container_results transporter
            if (transporter !== undefined) {
                if (parsedJobId) {
                    await client.query(`
                        UPDATE container_results 
                        SET transporter = $1
                        WHERE UPPER(TRIM(cntr_no)) = $2
                          AND job_id = $3
                    `, [transporter, cleanCntrNo, parsedJobId]);
                } else {
                    await client.query(`
                        UPDATE container_results 
                        SET transporter = $1
                        WHERE UPPER(TRIM(cntr_no)) = $2
                    `, [transporter, cleanCntrNo]);
                }
            }

            // 3. container_comments category & duration_minutes
            await client.query(`
                CREATE TABLE IF NOT EXISTS container_comments (
                    cntr_no VARCHAR(50) NOT NULL,
                    work_date VARCHAR(20) DEFAULT '',
                    admin_comment TEXT,
                    job_id INTEGER DEFAULT 0,
                    duration_minutes INT,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            `).catch(() => {});
            await client.query(`ALTER TABLE container_comments ADD COLUMN IF NOT EXISTS job_id INTEGER DEFAULT 0;`).catch(() => {});
            await client.query(`ALTER TABLE container_comments ADD COLUMN IF NOT EXISTS duration_minutes INT;`).catch(() => {});

            const jId = parsedJobId || 0;
            const targetWorkDate = (workDate || '').trim();

            const existCommentRes = await client.query(`
                SELECT admin_comment FROM container_comments
                WHERE cntr_no = $1
                  AND (work_date = $2 OR work_date = '' OR work_date IS NULL)
                  AND (job_id = $3 OR job_id = 0)
                LIMIT 1
            `, [cleanCntrNo, targetWorkDate, jId]);

            const finalAdminComment = category !== undefined 
                ? category 
                : (existCommentRes.rows[0]?.admin_comment || '');

            await client.query(`
                DELETE FROM container_comments 
                WHERE cntr_no = $1 
                  AND (work_date = $2 OR work_date = '' OR work_date IS NULL)
                  AND (job_id = $3 OR job_id = 0)
            `, [cleanCntrNo, targetWorkDate, jId]);

            await client.query(`
                INSERT INTO container_comments (cntr_no, work_date, admin_comment, job_id, duration_minutes)
                VALUES ($1, $2, $3, $4, $5)
            `, [cleanCntrNo, targetWorkDate, finalAdminComment, jId, durationMinutes || 45]);

            await client.query('COMMIT');
            return res.json({ success: true, message: "컨테이너 정보가 업데이트되었습니다." });
        } catch (innerErr) {
            await client.query('ROLLBACK');
            throw innerErr;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("POST /api/reports/update-container error:", err);
        return res.status(500).json({ success: false, error: err.message });
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

app.post('/api/debug', (req, res) => {
    const fs = require('fs');
    fs.writeFileSync('C:\\Users\\Administrator\\Desktop\\debug.json', JSON.stringify(req.body, null, 2));
    res.json({success:true});
});

const server = app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 API 서버가 http://0.0.0.0:${port} 에서 실행 중입니다.`);
    console.log(`🌐 로컬 접속: http://localhost:${port}`);
    console.log(`📱 네트워크 접속: http://192.168.0.24:${port}`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.warn(`⚠️ [Server] 포트 ${port}가 이미 사용 중입니다. 기존에 동작 중인 백그라운드 서버를 공유하여 계속 실행합니다.`);
        // Electron 환경이나 기존 프로세스가 있을 때 앱이 강제 종료되지 않도록 유지
    } else {
        console.error(`❌ [FATAL] 서버 오류 발생:`, err);
    }
});
