const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.APP_DATA_PATH || path.join(__dirname, 'data');
const DB_CONFIG_FILE = path.join(DATA_DIR, 'db_config.json');

let config = {
    user: 'root',
    host: 'svc.sel3.cloudtype.app',
    database: 'excel_compare',
    password: 'z456qwe12!@',
    port: 30554,
    ssl: false
};

if (fs.existsSync(DB_CONFIG_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8'));
    config = { ...config, ...saved };
}

async function run() {
    const client = new Client(config);
    try {
        await client.connect();
        console.log("🐘 [DB] Connected to", config.host);

        console.log("🛠️ container_results 테이블의 id 시퀀스 복구를 시작합니다...");

        // 1. 시퀀스가 있는지 확인
        const seqCheck = await client.query(`
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'S' AND c.relname = 'container_results_id_seq'
        `);

        if (seqCheck.rows.length === 0) {
            console.log("🏗️ 시퀀스가 없습니다. 생성을 시작합니다...");

            // 시퀀스 생성
            await client.query(`CREATE SEQUENCE container_results_id_seq`);

            // 최대값 찾기
            const maxIdRes = await client.query(`SELECT COALESCE(MAX(id), 0) as max_id FROM container_results`);
            const maxId = maxIdRes.rows[0].max_id;

            // 시퀀스 시작값 설정
            await client.query(`SELECT setval('container_results_id_seq', ${maxId + 1}, false)`);
            console.log(`✅ 시퀀스 생성 및 시작값(${maxId + 1}) 설정 완료.`);
        } else {
            console.log("ℹ️ 시퀀스가 이미 존재합니다.");
        }

        // 2. 컬럼의 DEFAULT 값 설정
        console.log("🏗️ id 컬럼에 DEFAULT nextval('container_results_id_seq') 설정을 시도합니다...");
        await client.query(`
            ALTER TABLE container_results 
            ALTER COLUMN id SET DEFAULT nextval('container_results_id_seq')
        `);

        // 3. 시퀀스 소유권 설정 (의존성 연결)
        console.log("🏗️ 시퀀스 소유권(OWNED BY) 설정을 시도합니다...");
        await client.query(`
            ALTER SEQUENCE container_results_id_seq OWNED BY container_results.id
        `);

        console.log("✨ 모든 복구가 완료되었습니다!");

    } catch (err) {
        console.error("❌ 오류 발생:", err);
    } finally {
        await client.end();
    }
}

run();
