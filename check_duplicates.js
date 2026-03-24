const { Pool } = require('pg');

const config = {
    user: "u0_a286",
    host: "maizen.iptime.org",
    database: "u0_a286",
    password: "z456qwe12!@",
    port: 5432,
    ssl: false
};

async function checkDuplicates() {
    const pool = new Pool(config);
    try {
        console.log(`🔍 Checking duplicates in ${config.host} (User: ${config.user})...`);

        const res = await pool.query(`
            SELECT cntr_no, COUNT(*) as count 
            FROM container_results 
            GROUP BY cntr_no 
            HAVING COUNT(*) > 1 
            ORDER BY count DESC 
            LIMIT 50
        `);

        if (res.rows.length === 0) {
            console.log("✅ No duplicate container numbers found in container_results.");
        } else {
            console.log(`⚠️ Found ${res.rows.length} duplicate container numbers in container_results (simple count):`);
            res.rows.forEach(row => {
                console.log(`- ${row.cntr_no}: ${row.count} times`);
            });

            console.log("\n🔍 Checking for job/product distribution for top 5 duplicates...");
            for (let i = 0; i < Math.min(5, res.rows.length); i++) {
                const cntr = res.rows[i].cntr_no;
                const details = await pool.query(`
                    SELECT job_name, prod_name, COUNT(*) as c
                    FROM container_results 
                    WHERE cntr_no = $1
                    GROUP BY job_name, prod_name
                `, [cntr]);
                console.log(`\n  [${cntr}] Details:`);
                details.rows.forEach(d => {
                    console.log(`    - Job: ${d.job_name}, Prod: ${d.prod_name} (${d.c} times)`);
                });
            }
        }

    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        await pool.end();
    }
}

checkDuplicates();
