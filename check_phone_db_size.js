const { Client } = require('pg');
const config = {
    user: 'u0_a286',
    host: '192.168.0.24',
    database: 'u0_a286',
    password: 'z456qwe12!@',
    port: 5432
};

async function checkDbSize() {
    const client = new Client(config);
    try {
        await client.connect();
        const res = await client.query("SELECT pg_size_pretty(pg_database_size('u0_a286')) as db_size");
        console.log(`Current Phone DB Size (u0_a286): ${res.rows[0].db_size}`);

        const resTables = await client.query(`
            SELECT 
                relname as table_name, 
                pg_size_pretty(pg_total_relation_size(relid)) as total_size
            FROM pg_catalog.pg_statio_user_tables 
            ORDER BY pg_total_relation_size(relid) DESC
        `);
        console.log('\n--- Table Breakdown ---');
        resTables.rows.forEach(row => {
            console.log(` - ${row.table_name}: ${row.total_size}`);
        });
    } catch (err) {
        console.error(err.message);
    } finally {
        await client.end();
    }
}

checkDbSize();
