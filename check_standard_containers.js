
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'data', 'db_config.json');
const dbConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
dbConfig.user = 'u0_a286';
dbConfig.database = 'u0_a286';

async function checkStandardContainers() {
    const pool = new Pool(dbConfig);
    try {
        console.log('--- Checking standard (single-product) containers ---');

        // Find job_id and cntr_no that have exactly one prod_name
        const query = `
            SELECT job_id, cntr_no, prod_name, qty_plan, qty_load, weight_mixed, weight_orig
            FROM container_results
            WHERE cntr_no IS NOT NULL AND cntr_no != ''
            AND (job_id, cntr_no) IN (
                SELECT job_id, cntr_no
                FROM container_results
                GROUP BY job_id, cntr_no
                HAVING COUNT(DISTINCT prod_name) = 1
            )
            LIMIT 10;
        `;

        const res = await pool.query(query);

        console.log('Sample rows for single-product containers:');
        console.table(res.rows);

    } catch (err) {
        console.error('Error executing query:', err.message);
    } finally {
        await pool.end();
    }
}

checkStandardContainers();
