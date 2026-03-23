
const { Pool } = require('pg');

const cloudConfig = { user: 'root', host: 'svc.sel3.cloudtype.app', database: 'excel_compare', password: 'z456qwe12!@', port: 30554, ssl: false };
const phoneConfig = { user: 'u0_a286', host: '192.168.0.24', database: 'u0_a286', password: '', port: 5432, ssl: false };

async function migrate_rest() {
    console.log('🚀 마이그레이션 나머지 작업 시작');
    const cloudPool = new Pool(cloudConfig);
    const phonePool = new Pool(phoneConfig);

    const tableMeta = {
        'container_holds': { pk: 'cntr_no', schema: 'cntr_no TEXT PRIMARY KEY, hold_reason TEXT, created_at TIMESTAMP' },
        'container_pops': { pk: 'cntr_no', schema: 'cntr_no TEXT PRIMARY KEY, weight NUMERIC, memo TEXT, updated_at TIMESTAMP' },
        'carrier_mappings': { pk: 'code', schema: 'code TEXT PRIMARY KEY, names JSONB, updated_at TIMESTAMP, id INTEGER' },
        'auto_classify_rules': { pk: 'id', schema: 'id TEXT PRIMARY KEY, is_active BOOLEAN, group_name TEXT, condition_operator TEXT, conditions JSONB, target_field TEXT, target_value TEXT, tag_color TEXT, updated_at TIMESTAMP' },
        'container_results': { pk: 'id', schema: 'id INTEGER PRIMARY KEY, job_name TEXT, cntr_no TEXT, seal_no TEXT, prod_name TEXT, qty_plan INTEGER, qty_load INTEGER, cntr_type TEXT, carrier TEXT, destination TEXT, weight_mixed NUMERIC, etd TEXT, eta TEXT, remark TEXT, saved_at TIMESTAMP, prod_type TEXT, division TEXT, dims TEXT, weight_orig NUMERIC, weight_down NUMERIC, transporter TEXT, adj1 TEXT, adj1_color TEXT, job_id INTEGER' }
    };

    for (const tableName of Object.keys(tableMeta)) {
        console.log(`\n📦 [${tableName}] 시작`);
        try {
            const res = await cloudPool.query(`SELECT * FROM ${tableName}`);
            const rows = res.rows;
            console.log(`   - ☁️ 데이터: ${rows.length}건`);

            await phonePool.query(`DROP TABLE IF EXISTS ${tableName}`);
            await phonePool.query(`CREATE TABLE ${tableName} (${tableMeta[tableName].schema})`);
            console.log(`   - 📱 테이블 생성 완료`);

            if (rows.length > 0) {
                for (const row of rows) {
                    const cols = Object.keys(row);
                    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
                    await phonePool.query(`INSERT INTO ${tableName} (${cols.join(',')}) VALUES (${placeholders})`, Object.values(row));
                }
                console.log(`   - ✅ 완료`);
            }
        } catch (err) {
            console.error(`   - ❌ 에러: ${err.message}`);
        }
    }
    await cloudPool.end();
    await phonePool.end();
}
migrate_rest();
