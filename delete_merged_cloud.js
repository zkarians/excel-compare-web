const { Pool } = require('pg');

const CLOUD_CONFIG = {
    user: 'root',
    host: 'svc.sel3.cloudtype.app',
    database: 'excel_compare',
    password: 'z456qwe12!@',
    port: 30554,
    ssl: false
};

async function deleteMergedRecords() {
    const pool = new Pool(CLOUD_CONFIG);
    try {
        console.log(`🧹 Deleting merged records in ${CLOUD_CONFIG.host}...`);

        const res = await pool.query(`
            DELETE FROM container_results 
            WHERE prod_name LIKE '%,%'
        `);

        console.log(`✅ 성공적으로 ${res.rowCount}건의 레거시 데이터를 삭제했습니다.`);

    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        await pool.end();
    }
}

deleteMergedRecords();
