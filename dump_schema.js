
const { Pool } = require('pg');
const cloudConfig = { user: 'root', host: 'svc.sel3.cloudtype.app', database: 'excel_compare', password: 'z456qwe12!@', port: 30554, ssl: false };

async function dump() {
    const pool = new Pool(cloudConfig);
    const tables = [
        'product_master_sync', 'container_holds', 'container_pops',
        'carrier_mappings', 'auto_classify_rules', 'container_results'
    ];
    for (const t of tables) {
        try {
            const res = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${t}'`);
            console.log(`\nTable: ${t}`);
            res.rows.forEach(r => console.log(`  - ${r.column_name}: ${r.data_type}`));
        } catch (e) { }
    }
    await pool.end();
}
dump();
