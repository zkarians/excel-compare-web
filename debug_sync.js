const { Pool } = require('pg');

const srcConfig = { user: 'postgres', host: 'localhost', database: 'excel', password: 'z456qwe12!@', port: 5432, ssl: false };
const dstConfig = { user: 'aidlux', host: 'maizen.iptime.org', database: 'excel', password: 'z456qwe12!@', port: 5432, ssl: false };

async function check() {
    const srcPool = new Pool(srcConfig);
    const dstPool = new Pool(dstConfig);

    try {
        console.log("--- Checking product_master_sync ---");

        const resDst = await dstPool.query(`SELECT MAX(updated_at) as last_sync, COUNT(*) as total FROM product_master_sync`);
        const lastSync = resDst.rows[0].last_sync;
        const totalDst = resDst.rows[0].total;
        console.log(`Target (Phone) - Total Rows: ${totalDst}, MAX(updated_at): ${lastSync}`);

        if (lastSync) {
            const sourceWhere = `WHERE updated_at > '${lastSync.toISOString()}'`;
            console.log(`Calculated sourceWhere: ${sourceWhere}`);

            const resSrc = await srcPool.query(`SELECT COUNT(*) as count FROM product_master_sync ${sourceWhere}`);
            console.log(`Rows to sync from Source (PC): ${resSrc.rows[0].count}`);
        } else {
            console.log("Target is empty or updated_at is null. Incremental sync will do a full sync.");
        }

    } catch (e) {
        console.error("Error:", e.message);
    } finally {
        await srcPool.end();
        await dstPool.end();
    }
}
check();
