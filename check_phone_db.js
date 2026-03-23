
const { Pool } = require('pg');

const phoneConfig = {
    user: 'u0_a286',
    host: '192.168.0.24',
    database: 'u0_a286',
    password: '',
    port: 5432
};

async function check() {
    const pool = new Pool(phoneConfig);
    try {
        const tables = [
            'product_master_sync',
            'container_holds',
            'container_pops',
            'carrier_mappings',
            'auto_classify_rules',
            'container_results'
        ];

        for (const tableName of tables) {
            try {
                const res = await pool.query(`SELECT COUNT(*) FROM ${tableName}`);
                console.log(`${tableName}: ${res.rows[0].count} rows`);
            } catch (err) {
                console.log(`${tableName}: Error or Table not found`);
            }
        }
    } finally {
        await pool.end();
    }
}

check();
