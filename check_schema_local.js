const { Client } = require('pg');
async function test() {
    const client = new Client({
        user: 'postgres',
        host: 'ungdong.iptime.org',
        database: 'excel',
        password: 'z456qwe12!@',
        port: 5432
    });
    await client.connect();
    const res = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'product_master_sync'");
    console.log(res.rows);
    await client.end();
}
test().catch(console.error);
