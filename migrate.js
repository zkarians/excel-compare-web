
const { Pool } = require('pg');

const cloudConfig = { user: 'root', host: 'svc.sel3.cloudtype.app', database: 'excel_compare', password: 'z456qwe12!@', port: 30554, ssl: false };
const phoneConfig = { user: 'u0_a354', host: '192.168.0.24', database: 'u0_a354', password: '', port: 5432, ssl: false };

async function migrate() {
    console.log('🚀 DB 마이그레이션 도구 시작 (고성능 배치)');
    const cloudPool = new Pool(cloudConfig);
    const phonePool = new Pool(phoneConfig);

    const tableMeta = {
        'product_master_sync': { pk: 'prod_name', schema: 'prod_name TEXT PRIMARY KEY, prod_type TEXT, weight NUMERIC, width NUMERIC, depth NUMERIC, height NUMERIC, updated_at TIMESTAMP, cbm NUMERIC, last_used_at TIMESTAMP, id INTEGER' },
        'container_holds': { pk: 'cntr_no', schema: 'cntr_no TEXT PRIMARY KEY, hold_reason TEXT, created_at TIMESTAMP' },
        'container_pops': { pk: 'cntr_no', schema: 'cntr_no TEXT PRIMARY KEY, weight NUMERIC, memo TEXT, updated_at TIMESTAMP' },
        'carrier_mappings': { pk: 'code', schema: 'code TEXT PRIMARY KEY, names JSONB, updated_at TIMESTAMP, id INTEGER' },
        'auto_classify_rules': { pk: 'id', schema: 'id TEXT PRIMARY KEY, is_active BOOLEAN, group_name TEXT, condition_operator TEXT, conditions JSONB, target_field TEXT, target_value TEXT, tag_color TEXT, updated_at TIMESTAMP' },
        'container_jobs': { pk: 'id', schema: 'id SERIAL PRIMARY KEY, job_name TEXT, eta TEXT, etd TEXT, remark TEXT, saved_at TIMESTAMP' },
        'container_results': { pk: 'id', schema: 'id SERIAL PRIMARY KEY, job_name TEXT, cntr_no TEXT, seal_no TEXT, prod_name TEXT, qty_plan INTEGER, qty_load INTEGER, qty_pending INTEGER, qty_remain INTEGER, qty_packing INTEGER, cntr_type TEXT, carrier TEXT, destination TEXT, weight_mixed NUMERIC, etd TEXT, eta TEXT, remark TEXT, saved_at TIMESTAMP, prod_type TEXT, division TEXT, dims TEXT, weight_orig NUMERIC, weight_down NUMERIC, transporter TEXT, adj1 TEXT, adj1_color TEXT, job_id INTEGER' },
        'sent_emails': { pk: 'id', schema: 'id SERIAL PRIMARY KEY, recipient TEXT, subject TEXT, content TEXT, sent_at TIMESTAMP' }
    };

    try {
        for (const tableName of Object.keys(tableMeta)) {
            console.log(`\n📦 [${tableName}] 마이그레이션 시작...`);

            // 1. 소스 데이터 가져오기
            let rows;
            try {
                const res = await cloudPool.query(`SELECT * FROM ${tableName}`);
                rows = res.rows;
                console.log(`   - ☁️ Cloudtype 데이터 조회 성공: ${rows.length}건`);
            } catch (err) {
                console.error(`   - ❌ Cloudtype 조회 실패: ${err.message}`);
                continue;
            }

            // 2. 타겟 테이블 생성
            try {
                await phonePool.query(`CREATE TABLE IF NOT EXISTS ${tableName} (${tableMeta[tableName].schema})`);
                console.log(`   - 📱 Phone DB 테이블 준비 완료`);
            } catch (err) {
                console.error(`   - ❌ Phone DB 테이블 생성 실패: ${err.message}`);
                continue;
            }

            if (rows.length === 0) {
                console.log(`   - ℹ️ 데이터가 없어 건너뜁니다.`);
                continue;
            }

            // 3. 배치 삽입
            const BATCH_SIZE = 500;
            const columns = Object.keys(rows[0]);
            const colNames = columns.join(', ');
            const pk = tableMeta[tableName].pk;
            const updateClause = columns.filter(c => c !== pk).map(c => `${c} = EXCLUDED.${c}`).join(', ');

            console.log(`   - 🚀 Batch 삽입 진행 중...`);
            for (let i = 0; i < rows.length; i += BATCH_SIZE) {
                const batch = rows.slice(i, i + BATCH_SIZE);
                const values = [];
                const placeholdersRows = [];

                batch.forEach((row, rowIndex) => {
                    const offset = rowIndex * columns.length;
                    const placeholders = columns.map((_, colIndex) => `$${offset + colIndex + 1}`).join(', ');
                    placeholdersRows.push(`(${placeholders})`);
                    values.push(...columns.map(c => row[c]));
                });

                const query = `
                    INSERT INTO ${tableName} (${colNames}) 
                    VALUES ${placeholdersRows.join(', ')}
                    ON CONFLICT (${pk}) DO UPDATE SET ${updateClause || `${pk} = EXCLUDED.${pk}`}
                `;

                await phonePool.query(query, values);
                if (i % 10000 === 0 && i > 0) process.stdout.write(`.`);
            }
            console.log(`   - ✨ [${tableName}] 완료!`);
        }

        // 4. 시퀀스 동기화 (SERIAL PK 테이블들)
        console.log('\n⚙️ 시퀀스 동기화 중...');
        const serialTables = ['container_jobs', 'container_results', 'sent_emails'];
        for (const tableName of serialTables) {
            try {
                const resSeq = await phonePool.query(`SELECT pg_get_serial_sequence('${tableName}', 'id') as seq`);
                const seqName = resSeq.rows[0].seq;
                if (seqName) {
                    await phonePool.query(`SELECT setval('${seqName}', COALESCE((SELECT MAX(id) FROM ${tableName}), 0) + 1, false)`);
                    console.log(`   - ✅ [${tableName}] 시퀀스 갱신 완료`);
                }
            } catch (err) {
                console.warn(`   - ⚠️ [${tableName}] 시퀀스 갱신 실패: ${err.message}`);
            }
        }

        console.log('\n🎉 마이그레이션이 성공적으로 완료되었습니다!');
    } catch (err) {
        console.error('❌ 치명적 오류:', err.message);
    } finally {
        await cloudPool.end();
        await phonePool.end();
    }
}

migrate();
