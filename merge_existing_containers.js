
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'data', 'db_config.json');
const localConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
localConfig.user = 'u0_a286';
localConfig.database = 'u0_a286';

const CLOUD_CONFIG = {
    user: 'root', host: 'svc.sel3.cloudtype.app', database: 'excel_compare',
    password: 'z456qwe12!@', port: 30554, ssl: false
};

async function mergeDb(config, label) {
    const pool = new Pool(config);
    try {
        console.log(`\n--- Merging ${label} DB ---`);
        const client = await pool.connect();
        try {
            // Find duplicates
            const dupRes = await client.query(`
                SELECT job_id, cntr_no, COUNT(*) as row_count
                FROM container_results
                WHERE job_id IS NOT NULL AND cntr_no IS NOT NULL
                GROUP BY job_id, cntr_no
                HAVING COUNT(*) > 1
            `);

            console.log(`Found ${dupRes.rows.length} containers with mixed products in ${label}.`);

            for (const row of dupRes.rows) {
                const { job_id, cntr_no } = row;

                // Get all rows for this container
                const itemsRes = await client.query(
                    `SELECT * FROM container_results WHERE job_id = $1 AND cntr_no = $2`,
                    [job_id, cntr_no]
                );
                const items = itemsRes.rows;

                // Aggregate
                const first = items[0];
                const mergedProdName = items.map(it => it.prod_name).join(', ');
                const totalQtyPlan = items.reduce((sum, it) => sum + (parseInt(it.qty_plan) || 0), 0);
                const totalQtyLoad = items.reduce((sum, it) => sum + (parseInt(it.qty_load) || 0), 0);
                const totalQtyPending = items.reduce((sum, it) => sum + (parseInt(it.qty_pending) || 0), 0);
                const totalQtyRemain = items.reduce((sum, it) => sum + (parseInt(it.qty_remain) || 0), 0);
                const totalQtyPacking = items.reduce((sum, it) => sum + (parseInt(it.qty_packing) || 0), 0);
                const totalWeightMixed = items.reduce((sum, it) => sum + parseFloat(it.weight_mixed || 0), 0);
                const totalWeightOrig = items.reduce((sum, it) => sum + parseFloat(it.weight_orig || 0), 0);
                const totalWeightDown = items.reduce((sum, it) => sum + parseFloat(it.weight_down || 0), 0);
                const mergedRemark = Array.from(new Set(items.map(it => it.remark))).filter(r => r).join(' | ');

                await client.query('BEGIN');

                // Delete duplicates
                await client.query(
                    `DELETE FROM container_results WHERE job_id = $1 AND cntr_no = $2`,
                    [job_id, cntr_no]
                );

                // Insert merged row
                const insertQuery = `
                    INSERT INTO container_results (
                        job_id, job_name, cntr_no, seal_no, prod_name, qty_plan, qty_load, 
                        qty_pending, qty_remain, qty_packing,
                        cntr_type, carrier, destination, weight_mixed, etd, eta, remark,
                        prod_type, division, dims, weight_orig, weight_down, transporter, 
                        adj1, adj1_color, adj2, saved_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
                `;

                await client.query(insertQuery, [
                    job_id, first.job_name, cntr_no, first.seal_no, mergedProdName, totalQtyPlan, totalQtyLoad,
                    totalQtyPending, totalQtyRemain, totalQtyPacking,
                    first.cntr_type, first.carrier, first.destination, totalWeightMixed, first.etd, first.eta, mergedRemark,
                    first.prod_type, first.division, first.dims, totalWeightOrig, totalWeightDown, first.transporter,
                    first.adj1, first.adj1_color, first.adj2, first.saved_at
                ]);

                await client.query('COMMIT');
                process.stdout.write('.');
            }
            console.log(`\n✨ ${label} merge complete.`);
        } finally {
            client.release();
        }
    } catch (err) {
        console.error(`\n❌ Error merging ${label} DB:`, err.message);
    } finally {
        await pool.end();
    }
}

async function runCleanup() {
    await mergeDb(localConfig, 'LOCAL');
    await mergeDb(CLOUD_CONFIG, 'CLOUD');
}

runCleanup();
