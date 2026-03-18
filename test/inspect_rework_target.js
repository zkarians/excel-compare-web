const ExcelJS = require('exceljs');

async function analyzeExcel() {
    const filePath = 'd:\\.gemini\\antigravity\\scratch\\Excelcompare\\test\\재작업대상리스트.xlsx';
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    console.log(`File: ${filePath}`);
    workbook.worksheets.forEach(ws => {
        console.log(`  Sheet Name: "${ws.name}"`);
    });
}

analyzeExcel();
