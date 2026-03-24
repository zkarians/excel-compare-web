const { Pool } = require('pg');

const config = {
    user: "u0_a286",
    host: "maizen.iptime.org",
    database: "u0_a286",
    password: "z456qwe12!@",
    port: 5432,
    ssl: false
};

async function findMergedRecords() {
    const pool = new Pool(config);
    try {
        console.log(`🔍 Finding merged records in ${config.host}...`);

        // prod_name에 콤마(,)가 포함된 행 찾기
        const res = await pool.query(`
            SELECT id, job_name, cntr_no, prod_name, qty_plan, saved_at 
            FROM container_results 
            WHERE prod_name LIKE '%,%'
            ORDER BY saved_at DESC
        `);

        if (res.rows.length === 0) {
            console.log("✅ No merged records found (prod_name with comma).");
        } else {
            console.log(`⚠️ Found ${res.rows.length} merged records:`);
            res.rows.forEach(row => {
                console.log(`- ID: ${row.id}, Job: ${row.job_name}, Cntr: ${row.cntr_no}, Prod: ${row.prod_name.substring(0, 50)}...`);
            });
        }

    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        await pool.end();
    }
}

findMergedRecords();
