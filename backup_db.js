const { Pool } = require('pg');
const fs = require('fs');

const config = { user: 'postgres', host: 'localhost', database: 'excel', password: 'z456qwe12!@', port: 5432, ssl: false };
const tables = [
    'product_master_sync', 'container_holds', 'container_pops',
    'carrier_mappings', 'auto_classify_rules', 'container_jobs', 'container_results',
    'sent_emails', 'app_configs'
];

async function backup() {
    const pool = new Pool(config);
    const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `db_backup_${date}.sql`;
    const stream = fs.createWriteStream(fileName);

    console.log(`Starting backup to ${fileName}...`);

    try {
        for (const table of tables) {
            console.log(`Backing up ${table}...`);
            stream.write(`\n-- Backup of ${table}\n`);
            stream.write(`TRUNCATE TABLE ${table};\n`);

            const res = await pool.query(`SELECT * FROM ${table}`);
            const columns = res.fields.map(f => f.name);

            for (const row of res.rows) {
                const vals = columns.map(c => {
                    const val = row[c];
                    if (val === null) return 'NULL';
                    if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
                    if (val instanceof Date) return `'${val.toISOString()}'`;
                    if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
                    return val;
                });
                stream.write(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${vals.join(', ')});\n`);
            }
        }
        console.log("Backup completed successfully.");
    } catch (e) {
        console.error("Backup failed:", e.message);
    } finally {
        stream.end();
        await pool.end();
    }
}

backup();
