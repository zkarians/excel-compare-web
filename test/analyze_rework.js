const ExcelJS = require('exceljs');

(async () => {
    const basePath = 'D:\\.gemini\\antigravity\\scratch\\Excelcompare4\\test\\';

    // Parse rework (just get prodName and cntrNo)
    const rwb = new ExcelJS.Workbook();
    await rwb.xlsx.readFile(basePath + '재작업리스트2.xlsx');
    const rws = rwb.worksheets[0];
    let reworkData = [];
    rws.eachRow((row, i) => {
        const prodName = (row.getCell(9).text || String(row.getCell(9).value || '')).trim();
        const cntrNo = (row.getCell(20).text || String(row.getCell(20).value || '')).trim();
        const qty = parseInt(row.getCell(10).value) || 0;
        if (prodName && qty > 0 && cntrNo) reworkData.push({ prodName, cntrNo, qty });
    });

    // Parse download
    const dwb = new ExcelJS.Workbook();
    await dwb.xlsx.readFile(basePath + 'test4.xlsx');
    const dws = dwb.worksheets[0];
    let downData = [];
    dws.eachRow((row, i) => {
        if (i <= 1) return;
        const cntr = (row.getCell(3).text || String(row.getCell(3).value || '')).trim();
        const prodName = (row.getCell(9).text || String(row.getCell(9).value || '')).trim();
        if (cntr && prodName) downData.push({ cntrNo: cntr, prodName });
    });

    const reworkCntrs = [...new Set(reworkData.map(i => i.cntrNo))];

    // ONLY show mismatches
    let mismatchCount = 0;
    reworkCntrs.forEach(cntr => {
        const reworkProds = [...new Set(reworkData.filter(i => i.cntrNo === cntr).map(i => i.prodName.toUpperCase()))];
        const downProds = [...new Set(downData.filter(i => i.cntrNo.toUpperCase() === cntr.toUpperCase()).map(i => i.prodName.toUpperCase()))];

        const reworkNotInDown = reworkProds.filter(p => !downProds.includes(p));
        const downNotInRework = downProds.filter(p => !reworkProds.includes(p));

        if (reworkNotInDown.length > 0 || downNotInRework.length > 0) {
            mismatchCount++;
            console.log('MISMATCH: ' + cntr);
            reworkNotInDown.forEach(p => console.log('  Rework ONLY: ' + p));
            downNotInRework.forEach(p => console.log('  Download ONLY: ' + p));
        }
    });

    console.log('Mismatches: ' + mismatchCount + ' / ' + reworkCntrs.length);
})();
