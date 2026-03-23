
const XLSX = require('xlsx');
const path = require('path');

const masterPath = 'f:/Gemini/Excelcompare/Excelcompare/master_data/product_master.xlsx';
const workbook = XLSX.readFile(masterPath);
const worksheet = workbook.Sheets[workbook.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

console.log('--- Product Master Sample (First 10 rows) ---');
for (let i = 0; i < 10; i++) {
    const row = rows[i];
    if (row) {
        console.log(`Row ${i}: ${JSON.stringify(row)}`);
    }
}
