const ExcelJS = require('exceljs');

async function analyzeExcel() {
    const filePath = 'd:\\.gemini\\antigravity\\scratch\\Excelcompare\\test\\재작업리스트2.xlsx';
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const ws = workbook.getWorksheet("재작업당일");

    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        if (rowNumber > 3) return;
        console.log(`Row ${rowNumber}:`);
        for (let i = 1; i <= 25; i++) {
            const val = row.getCell(i).text;
            if (val) console.log(`  Col ${i}: ${val}`);
        }
    });
}

analyzeExcel();
