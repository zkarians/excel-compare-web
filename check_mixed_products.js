
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'data', 'db_config.json');
const dbConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
dbConfig.user = 'u0_a286';
dbConfig.database = 'u0_a286';
// dbConfig.password = 'z456qwe12!@'; // Assuming password in config is correct or not needed for local/trusted auth

async function checkMixedProducts() {
    const pool = new Pool(dbConfig);
    try {
        console.log('--- Checking for containers with multiple products ---');

        // Query to find job_id and cntr_no that have more than one distinct prod_name
        const query = `
            SELECT job_id, cntr_no, COUNT(DISTINCT prod_name) as product_count, ARRAY_AGG(DISTINCT prod_name) as products
            FROM container_results
            WHERE cntr_no IS NOT NULL AND cntr_no != ''
            GROUP BY job_id, cntr_no
            HAVING COUNT(DISTINCT prod_name) > 1
            ORDER BY job_id, cntr_no;
        `;

        const res = await pool.query(query);

        if (res.rows.length === 0) {
            console.log('No containers found with multiple products.');
        } else {
            console.log(`Found ${res.rows.length} containers with multiple products:`);
            res.rows.forEach(row => {
                console.log(`Job ID: ${row.job_id}, Container No: ${row.cntr_no}, Product Count: ${row.product_count}`);
                console.log(`Products: ${row.products.join(', ')}`);
                console.log('---');
            });
        }
    } catch (err) {
        console.error('Error executing query:', err.message);
    } finally {
        await pool.end();
    }
}

checkMixedProducts();
