const { Client } = require('pg');
const fs = require('fs');

async function checkSchema() {
    let configPath = 'C:\\Users\\Administrator\\Documents\\gemini\\Excelcompare\\data\\db_config.json';
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    const client = new Client({
        user: config.user,
        host: 'ungdong.iptime.org',
        database: config.database,
        password: config.password,
        port: 5432,
    });

    try {
        await client.connect();
        console.log('Connected to DB successfully.');
        const res = await client.query(\
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'products';
        \);
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (e) {
        console.error('DB Error:', e);
    } finally {
        await client.end();
    }
}

checkSchema();
