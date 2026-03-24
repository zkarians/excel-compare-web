const { Pool } = require('pg');

const CLOUD_CONFIG = {
    user: 'root',
    host: 'svc.sel3.cloudtype.app',
    database: 'excel_compare',
    password: 'z456qwe12!@',
    port: 30554,
    ssl: false
};

async function findMergedRecords() {
    const pool = new Pool(CLOUD_CONFIG);
    try {
        console.log(`🔍 Finding merged records in ${CLOUD_CONFIG.host}...`);

        // prod_name에 콤마(,)가 포함된 행 찾기
        const res = await pool.query(`
            SELECT COUNT(*) as count 
            FROM container_results 
            WHERE prod_name LIKE '%,%'
        `);

        const count = res.rows[0].count;
        console.log(`\n📊 결과: 총 ${count}건의 합쳐진(Merged) 레코드가 발견되었습니다.`);

        if (count > 0) {
            const examples = await pool.query(`
                SELECT job_name, cntr_no, prod_name 
                FROM container_results 
                WHERE prod_name LIKE '%,%'
                LIMIT 5
            `);
            console.log("\n예시 데이터:");
            examples.rows.forEach(row => {
                console.log(`- Job: ${row.job_name}, Cntr: ${row.cntr_no}, Prod: ${row.prod_name.substring(0, 100)}...`);
            });
        }

    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        await pool.end();
    }
}

findMergedRecords();
