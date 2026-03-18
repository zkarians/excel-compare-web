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

async function check() {
    const client = new Client(config);
    try {
        await client.connect();
        console.log("Connected to", config.host);

        const tables = ['container_jobs', 'container_results'];
        for (const table of tables) {
            const maxIdRes = await client.query(`SELECT MAX(id) FROM ${table}`);
            const maxId = maxIdRes.rows[0].max;
            console.log(`${table} MAX(id): ${maxId}`);

            try {
                const seqName = `${table}_id_seq`;
                const seqRes = await client.query(`SELECT last_value FROM ${seqName}`);
                console.log(`${seqName} last_value: ${seqRes.rows[0].last_value}`);
            } catch (e) {
                console.error(`Could not read sequence for ${table}: ${e.message}`);
            }
        }
    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

check();
