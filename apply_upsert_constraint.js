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

        // 1. 중복 데이터 확인
        const dupCheck = await client.query(`
            SELECT job_name, cntr_no, prod_name, qty_plan, COUNT(*) 
            FROM container_results 
            GROUP BY job_name, cntr_no, prod_name, qty_plan 
            HAVING COUNT(*) > 1
        `);

        if (dupCheck.rows.length > 0) {
            console.log(`⚠️ 중복 데이터 ${dupCheck.rows.length}개 발견. 정리를 시작합니다...`);
            // 중복된 데이터 중 가장 최신(id가 큰 것)만 남기고 삭제
            await client.query(`
                DELETE FROM container_results a USING (
                    SELECT MIN(id) as id, job_name, cntr_no, prod_name, qty_plan
                    FROM container_results
                    GROUP BY job_name, cntr_no, prod_name, qty_plan
                    HAVING COUNT(*) > 1
                ) b
                WHERE a.job_name = b.job_name 
                AND a.cntr_no = b.cntr_no 
                AND a.prod_name = b.prod_name 
                AND a.qty_plan = b.qty_plan
                AND a.id = b.id
            `);
            console.log("✅ 중복 데이터 정리가 완료되었습니다.");
        } else {
            console.log("✅ 중복 데이터가 없습니다.");
        }

        // 2. UNIQUE 제약 조건 추가
        // 이미 존재할 수도 있으므로 체크 후 추가
        const constraintCheck = await client.query(`
            SELECT constraint_name 
            FROM information_schema.table_constraints 
            WHERE table_name = 'container_results' 
            AND constraint_name = 'unique_job_cntr_prod_qty'
        `);

        if (constraintCheck.rows.length === 0) {
            console.log("🏗️ UNIQUE 제약 조건 추가 중...");
            await client.query(`
                ALTER TABLE container_results 
                ADD CONSTRAINT unique_job_cntr_prod_qty UNIQUE (job_name, cntr_no, prod_name, qty_plan)
            `);
            console.log("✅ 제약 조건이 성공적으로 추가되었습니다.");
        } else {
            console.log("ℹ️ 이미 제약 조건이 존재합니다.");
        }

    } catch (err) {
        console.error("❌ 오류 발생:", err);
    } finally {
        await client.end();
    }
}

run();
