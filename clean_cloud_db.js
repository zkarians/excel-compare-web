const { Client } = require('pg');

// Cloudtype DB 정보를 직접 입력하여 강제 접속
const config = {
    user: 'root',
    host: 'svc.sel3.cloudtype.app',
    database: 'excel_compare',
    password: 'z456qwe12!@',
    port: 30554,
    ssl: false
};

async function run() {
    const client = new Client(config);
    try {
        console.log("🐘 [Cloud DB] 접속 시도 중: " + config.host);
        await client.connect();
        console.log("✅ [Cloud DB] 접속 성공!");

        // 1. 중복 데이터 확인 및 정리
        console.log("🔍 중복 데이터 확인 중...");
        const dupCheck = await client.query(`
            SELECT job_name, cntr_no, prod_name, qty_plan, COUNT(*) 
            FROM container_results 
            GROUP BY job_name, cntr_no, prod_name, qty_plan 
            HAVING COUNT(*) > 1
        `);

        if (dupCheck.rows.length > 0) {
            console.log(`⚠️ 중복 데이터 ${dupCheck.rows.length}개 발견. 삭제를 시작합니다...`);
            const result = await client.query(`
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
            console.log(`✅ 중복 데이터 ${result.rowCount}건이 정리되었습니다.`);
        } else {
            console.log("✅ 중복 데이터가 없습니다.");
        }

        // 2. UNIQUE 제약 조건 추가
        console.log("🏗️ UNIQUE 제약 조건 상태 확인 중...");
        const constraintCheck = await client.query(`
            SELECT constraint_name 
            FROM information_schema.table_constraints 
            WHERE table_name = 'container_results' 
            AND constraint_name = 'unique_job_cntr_prod_qty'
        `);

        if (constraintCheck.rows.length === 0) {
            console.log("🏗️ UNIQUE 제약 조건 (4가지 항목 조합) 추가 중...");
            await client.query(`
                ALTER TABLE container_results 
                ADD CONSTRAINT unique_job_cntr_prod_qty UNIQUE (job_name, cntr_no, prod_name, qty_plan)
            `);
            console.log("✅ Cloud DB에 제약 조건이 성공적으로 추가되었습니다.");
        } else {
            console.log("ℹ️ Cloud DB에 이미 제약 조건이 적용되어 있습니다.");
        }

        // 3. 통계 확인
        const stats = await client.query("SELECT COUNT(*) FROM container_results");
        console.log(`📊 현재 Cloud DB 총 데이터 수: ${stats.rows[0].count}건`);

    } catch (err) {
        console.error("❌ Cloud DB 정리 중 오류 발생:", err);
    } finally {
        await client.end();
    }
}

run();
