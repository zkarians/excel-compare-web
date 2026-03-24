
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'data', 'db_config.json');
const dbConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
dbConfig.user = 'u0_a286';
dbConfig.database = 'u0_a286';

async function checkConcatenatedProducts() {
    const pool = new Pool(dbConfig);
    try {
        console.log('--- Checking for concatenated prod_name or unusual patterns ---');

        // Search for prod_name containing separators or multiple product codes
        const query = `
            SELECT id, job_name, cntr_no, prod_name, qty_plan
            FROM container_results
            WHERE prod_name LIKE '%,%' OR prod_name LIKE '%|%' OR prod_name LIKE '%+%'
            OR LENGTH(prod_name) > 30
            LIMIT 20;
        `;

        const res = await pool.query(query);

        if (res.rows.length === 0) {
            console.log('No concatenated products found using separators.');
        } else {
            console.log('Found potentially concatenated products:');
            console.table(res.rows);
        }
    } catch (err) {
        console.error('Error executing query:', err.message);
    } finally {
        await pool.end();
    }
}

checkConcatenatedProducts();
