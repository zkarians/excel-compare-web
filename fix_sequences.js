const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.APP_DATA_PATH || path.join(__dirname, 'data');
const DB_CONFIG_FILE = path.join(DATA_DIR, 'db_config.json');

let config = {
    user: 'root',
    host: 'svc.sel3.cloudtype.app',
    database: 'excel_compare',
    password: 'z456qwe12!@',
    port: 30554,
    ssl: false
};

if (fs.existsSync(DB_CONFIG_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8'));
    config = { ...config, ...saved };
}

async function fix() {
    const client = new Client(config);
    try {
        await client.connect();
        console.log("Connected to", config.host);

        console.log("Reseting sequences...");
        await client.query(`SELECT setval('container_jobs_id_seq', COALESCE((SELECT MAX(id) FROM container_jobs), 0) + 1, false)`);
        await client.query(`SELECT setval('container_results_id_seq', COALESCE((SELECT MAX(id) FROM container_results), 0) + 1, false)`);

        console.log("✅ Sequences reset successfully for", config.host);
    } catch (err) {
        console.error("❌ Error resetting sequences:", err.message);
    } finally {
        await client.end();
    }
}

fix();
