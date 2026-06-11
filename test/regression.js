const fs = require('fs');
const path = require('path');
const { parseOriginalExcel, parseDownloadExcel } = require('../services/excelService');
const { compareData } = require('../js/modules/compareLogic');
const { carrierMap, normalizeCarrier } = require('../js/modules/carrier');

async function run() {
    console.log('🏁 Starting regression test tool...');
    
    const isCheckMode = process.argv.includes('--check');
    const appDataDir = 'C:\\Users\\Administrator\\AppData\\Roaming\\excelcompare\\masterrule';
    const pathsFile = path.join(appDataDir, 'saved_file_paths.json');
    const rulesFile = path.join(appDataDir, 'rules.json');
    
    if (!fs.existsSync(pathsFile)) {
        console.error(`❌ Saved file paths not found: ${pathsFile}`);
        process.exit(1);
    }
    
    const paths = JSON.parse(fs.readFileSync(pathsFile, 'utf8'));
    const origPath = paths.original;
    const downPath = paths.download;
    
    console.log(`📂 Original file: ${origPath}`);
    console.log(`📂 Download file: ${downPath}`);
    
    if (!fs.existsSync(origPath) || !fs.existsSync(downPath)) {
        console.error('❌ Excel files do not exist!');
        process.exit(1);
    }
    
    // Load rules
    let dynamicRules = [];
    if (fs.existsSync(rulesFile)) {
        try {
            const rulesContent = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
            dynamicRules = rulesContent.rules || [];
        } catch (e) {
            console.warn('⚠️ Failed to load rules.json, using empty array');
        }
    }
    
    console.log('⚙️ Parsing files...');
    const originalData = await parseOriginalExcel(origPath);
    const downloadData = await parseDownloadExcel(downPath);
    
    console.log('⚖️ Comparing data...');
    // Mock the other params
    const productMaster = []; // empty for consistent baseline since DB isn't running in CLI
    const customFields = [];
    
    const comparisonResult = compareData(
        originalData,
        downloadData,
        productMaster,
        dynamicRules,
        customFields,
        carrierMap,
        normalizeCarrier
    );
    
    const snapshotDir = path.join(__dirname, 'snapshots');
    if (!fs.existsSync(snapshotDir)) {
        fs.mkdirSync(snapshotDir, { recursive: true });
    }
    
    const snapshotOrigPath = path.join(snapshotDir, 'before_orig.json');
    const snapshotDownPath = path.join(snapshotDir, 'before_down.json');
    const snapshotComparePath = path.join(snapshotDir, 'before_compare.json');
    
    if (isCheckMode) {
        console.log('🔍 Check Mode: Comparing current output with snapshots...');
        
        if (!fs.existsSync(snapshotOrigPath) || !fs.existsSync(snapshotDownPath) || !fs.existsSync(snapshotComparePath)) {
            console.error('❌ Snapshots do not exist! Run without --check first to generate snapshots.');
            process.exit(1);
        }
        
        const beforeOrig = JSON.parse(fs.readFileSync(snapshotOrigPath, 'utf8'));
        const beforeDown = JSON.parse(fs.readFileSync(snapshotDownPath, 'utf8'));
        const beforeCompare = JSON.parse(fs.readFileSync(snapshotComparePath, 'utf8'));
        
        const cleanForCompare = (obj) => {
            // Remove properties that might change dynamically, like timestamp (workDate)
            return JSON.parse(JSON.stringify(obj, (key, value) => {
                if (key === 'workDate' && (value.includes('월') && value.includes('일'))) {
                    return 'DYNAMIC_DATE'; // ignore dynamic current date workDate fallbacks
                }
                return value;
            }));
        };
        
        const currentOrigClean = cleanForCompare(originalData);
        const beforeOrigClean = cleanForCompare(beforeOrig);
        const currentDownClean = cleanForCompare(downloadData);
        const beforeDownClean = cleanForCompare(beforeDown);
        const currentCompareClean = cleanForCompare(comparisonResult);
        const beforeCompareClean = cleanForCompare(beforeCompare);
        
        let hasDiff = false;
        
        if (JSON.stringify(currentOrigClean) !== JSON.stringify(beforeOrigClean)) {
            console.error('❌ Regression: originalData has differences!');
            hasDiff = true;
        } else {
            console.log('✅ PASS: originalData matches exactly.');
        }
        
        if (JSON.stringify(currentDownClean) !== JSON.stringify(beforeDownClean)) {
            console.error('❌ Regression: downloadData has differences!');
            hasDiff = true;
        } else {
            console.log('✅ PASS: downloadData matches exactly.');
        }
        
        if (JSON.stringify(currentCompareClean) !== JSON.stringify(beforeCompareClean)) {
            console.error('❌ Regression: comparisonResult has differences!');
            hasDiff = true;
        } else {
            console.log('✅ PASS: comparisonResult matches exactly.');
        }
        
        if (hasDiff) {
            process.exit(1);
        } else {
            console.log('🎉 SUCCESS: All regression checks passed perfectly! No changes detected.');
        }
    } else {
        console.log('📸 Generation Mode: Writing current output to snapshots...');
        fs.writeFileSync(snapshotOrigPath, JSON.stringify(originalData, null, 2), 'utf8');
        fs.writeFileSync(snapshotDownPath, JSON.stringify(downloadData, null, 2), 'utf8');
        fs.writeFileSync(snapshotComparePath, JSON.stringify(comparisonResult, null, 2), 'utf8');
        console.log('✅ Snapshots written successfully!');
    }
}

run().catch(err => {
    console.error('❌ Error during regression run:', err);
    process.exit(1);
});
