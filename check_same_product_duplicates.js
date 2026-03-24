
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'data', 'db_config.json');
const dbConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
dbConfig.user = 'u0_a286';
dbConfig.database = 'u0_a286';

async function checkSameProductDuplicates() {
    const pool = new Pool(dbConfig);
    try {
        console.log('--- Checking for same container + same product duplicates ---');

        // This query finds containers that have multiple rows with the SAME product name
        const query = `
            SELECT job_id, cntr_no, prod_name, COUNT(*) as row_count
            FROM container_results
            GROUP BY job_id, cntr_no, prod_name
            HAVING COUNT(*) > 1
            LIMIT 10;
        `;

        const res = await pool.query(query);

        if (res.rows.length === 0) {
            console.log('No same-product duplicates found.');
        } else {
            console.log('Found same-product duplicates:');
            console.table(res.rows);
        }
    } catch (err) {
        console.error('Error executing query:', err.message);
    } finally {
        await pool.end();
    }
}

checkSameProductDuplicates();
