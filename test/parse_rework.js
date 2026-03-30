const { parseOriginalExcel } = require('../services/excelService.js');
const path = require('path');

async function test() {
    try {
        const filePath = path.join(__dirname, 'test2', '재작업대상리스트.xlsx');
        console.log("Analyzing:", filePath);
        const data = await parseOriginalExcel(filePath, ["재작업당일"], "rework");
        console.log(`Parsed ${data.length} rows.`);
        data.forEach(row => {
            console.log(`[${row.cntrNo}] Product: ${row.prodName}, Qty: ${row.qty}, Job: ${row.jobName}`);
        });
    } catch (e) {
        console.error("Error:", e);
    }
}

test();
