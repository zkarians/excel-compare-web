const XLSX = require('xlsx');
const path = require('path');

const files = {
    original: `D:\\.gemini\\antigravity\\scratch\\Excelcompare\\test\\test2\\26.03.13(주간)웅동수출작업시트.xlsx`,
    rework: `D:\\.gemini\\antigravity\\scratch\\Excelcompare\\test\\test2\\재작업대상리스트.xlsx`,
    erp: `D:\\.gemini\\antigravity\\scratch\\Excelcompare\\test\\test2\\EXPORT_20260313_175327.xlsx`
};

const targetModel = 'CBED2415B.ABKLLNA';

function checkFile(name, filePath) {
    console.log(`\n--- Checking ${name}: ${filePath} ---`);
    try {
        const workbook = XLSX.readFile(filePath);
        workbook.SheetNames.forEach(sheetName => {
            const worksheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

            let foundCount = 0;
            data.forEach((row, index) => {
                const rowStr = JSON.stringify(row);
                if (rowStr.includes(targetModel)) {
                    foundCount++;
                    console.log(`[${sheetName}] Row ${index + 1}:`, row.slice(0, 10), '...'); // Print first 10 columns
                }
            });
            if (foundCount > 0) {
                console.log(`Found ${foundCount} matches in sheet ${sheetName}`);
            }
        });
    } catch (error) {
        console.error(`Error reading ${name}:`, error.message);
    }
}

for (const [name, path] of Object.entries(files)) {
    checkFile(name, path);
}
