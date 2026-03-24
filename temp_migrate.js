const { Pool } = require('pg');

const PHONE_CONFIG = {
    user: "u0_a286",
    host: "maizen.iptime.org",
    database: "u0_a286",
    password: "z456qwe12!@",
    port: 5432,
    ssl: false
};

const CLOUD_CONFIG = {
    user: 'root',
    host: 'svc.sel3.cloudtype.app',
    database: 'excel_compare',
    password: 'z456qwe12!@',
    port: 30554,
    ssl: false
};

const tables = [
    'product_master_sync', 'container_holds', 'container_pops',
    'carrier_mappings', 'auto_classify_rules', 'container_jobs', 'container_results', 'sent_emails'
];

async function syncData() {
    console.log("🚀 Starting Final Clean Migration: Phone -> Cloud");
    const sourcePool = new Pool(PHONE_CONFIG);
    const targetPool = new Pool(CLOUD_CONFIG);

    try {
        for (const tableName of tables) {
            console.log(`[Sync] Processing ${tableName}...`);
            try {
                let querySource = `SELECT * FROM ${tableName}`;
                if (tableName === 'container_jobs') {
                    querySource = `SELECT DISTINCT ON (job_name, eta, etd) * FROM container_jobs ORDER BY job_name, eta, etd, id DESC`;
                }

                const resSource = await sourcePool.query(querySource);
                const rows = resSource.rows;
                console.log(` - Found ${rows.length} rows in ${tableName}`);

                if (rows.length > 0) {
                    let pk = 'id';
                    if (tableName === 'product_master_sync') pk = 'prod_name';
                    else if (tableName === 'container_holds' || tableName === 'container_pops') pk = 'cntr_no';
                    else if (tableName === 'carrier_mappings') pk = 'code';
                    else if (tableName === 'container_jobs') pk = 'job_name, eta, etd';
                    else if (tableName === 'container_results') pk = 'job_name, cntr_no, prod_name, qty_plan';

                    let columns = Object.keys(rows[0]);

                    // Exclude 'id' for natural key tables to avoid PK conflicts or null-violations
                    if (['carrier_mappings', 'container_jobs', 'product_master_sync'].includes(tableName)) {
                        columns = columns.filter(c => c !== 'id');
                    }

                    const colNames = columns.join(', ');
                    const updateCols = columns.filter(c => !pk.includes(c));
                    const updateClause = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ');

                    for (let i = 0; i < rows.length; i += 200) {
                        const batch = rows.slice(i, i + 200);

                        // FK Mapping for container_results
                        if (tableName === 'container_results') {
                            const sourceJobIds = [...new Set(batch.map(r => r.job_id).filter(id => id))];
                            if (sourceJobIds.length > 0) {
                                const resJobsSource = await sourcePool.query(`SELECT id, job_name, eta, etd FROM container_jobs WHERE id IN (${sourceJobIds.join(',')})`);
                                const sourceJobInfo = new Map(resJobsSource.rows.map(j => [j.id, `${j.job_name}|${j.eta}|${j.etd}`]));

                                const resJobsTarget = await targetPool.query(`SELECT id, job_name, eta, etd FROM container_jobs`);
                                const targetJobMap = new Map(resJobsTarget.rows.map(j => [`${j.job_name}|${j.eta}|${j.etd}`, j.id]));

                                batch.forEach(row => {
                                    const key = sourceJobInfo.get(row.job_id);
                                    row.job_id = targetJobMap.get(key) || null;
                                });
                            }
                        }

                        const values = [];
                        const placeholdersRows = [];
                        batch.forEach((row, rowIndex) => {
                            const offset = rowIndex * columns.length;
                            const placeholders = columns.map((_, colIndex) => `$${offset + colIndex + 1}`).join(', ');
                            placeholdersRows.push(`(${placeholders})`);
                            values.push(...columns.map(c => {
                                let val = row[c];
                                return (typeof val === 'object' && val !== null && !(val instanceof Date)) ? JSON.stringify(val) : val;
                            }));
                        });

                        const queryTarget = `
                            INSERT INTO ${tableName} (${colNames}) 
                            VALUES ${placeholdersRows.join(', ')} 
                            ON CONFLICT (${pk}) 
                            DO UPDATE SET ${updateClause || `${pk.split(',')[0]} = EXCLUDED.${pk.split(',')[0]}`}
                        `;
                        await targetPool.query(queryTarget, values);
                    }
                    console.log(` ✅ ${tableName} sync completed.`);
                }
            } catch (err) {
                console.error(` ❌ Error in ${tableName}:`, err.message);
            }
        }

        console.log("\n🎉 Final Clean Migration finished successfully!");
    } catch (err) {
        console.error("Critical Migration Error:", err.message);
    } finally {
        await sourcePool.end();
        await targetPool.end();
    }
}

syncData();
