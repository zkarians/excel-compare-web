
const { Pool } = require('pg');

const CLOUD_CONFIG = {
    user: 'root', host: 'svc.sel3.cloudtype.app', database: 'excel_compare',
    password: 'z456qwe12!@', port: 30554, ssl: false
};

async function fixCloudSchema() {
    const pool = new Pool(CLOUD_CONFIG);
    try {
        console.log('--- Checking Cloud DB schema ---');
        const client = await pool.connect();
        try {
            // Check column type
            const res = await client.query(`
                SELECT data_type, character_maximum_length 
                FROM information_schema.columns 
                WHERE table_name = 'container_results' AND column_name = 'prod_name'
            `);
            console.log('Current prod_name type:', res.rows[0]);

            if (res.rows[0].data_type === 'character varying' && res.rows[0].character_maximum_length === 255) {
                console.log('Updating prod_name to TEXT...');
                await client.query(`ALTER TABLE container_results ALTER COLUMN prod_name TYPE TEXT`);
                console.log('Successfully updated prod_name to TEXT.');
            } else {
                console.log('Column is already TEXT or has enough length.');
            }
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Error fixing Cloud DB schema:', err.message);
    } finally {
        await pool.end();
    }
}

fixCloudSchema();
