const xlsx = require('xlsx');
const workbook = xlsx.readFile('C:\\Users\\Administrator\\Downloads\\EXPORT_20260813_182450.xlsx');
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
console.log('Row 1 (Header?):', data[0].length, 'columns');
console.log(data[0]);
console.log('Row 2:', data[1]);
