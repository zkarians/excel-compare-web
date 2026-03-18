const path = require('path');
const fs = require('fs');

// 로깅 시스템 초기 설정
console.log('--- Startup Debug ---');
console.log('Process Versions:', JSON.stringify(process.versions));

// --- Electron module resolution fix ---
let electron;
try {
    if (process.versions.electron) {
        const Module = require('module');
        const originalResolveLookupPaths = Module._resolveLookupPaths;
        Module._resolveLookupPaths = function (request, parent, newReturn) {
            let result = originalResolveLookupPaths.apply(this, arguments);
            if (request === 'electron') {
                if (Array.isArray(result)) {
                    return result.filter(p => !p.includes('node_modules'));
                }
            }
            return result;
        };
        try {
            electron = require('electron');
        } finally {
            Module._resolveLookupPaths = originalResolveLookupPaths;
        }
    } else {
        electron = require('electron');
    }
} catch (e) {
    console.error('Failed to load electron with specialized resolution:', e.message);
    try {
        electron = require('electron');
    } catch (e2) {
        console.error('Final fallback require("electron") failed:', e2.message);
    }
}

const { app, BrowserWindow, dialog, ipcMain } = (typeof electron === 'object' && electron !== null) ? electron : {};

// 백그라운드 실행 제한 해제를 위한 엔진 스위치 추가
if (app) {
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    app.commandLine.appendSwitch('disable-background-timer-throttling');
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

if (!app && typeof electron === 'string') {
    console.log('Electron path string detected, attempting to respawn:', electron);
    const child = require('child_process').spawn(electron, [__filename], {
        stdio: 'inherit',
        detached: true,
        windowsHide: false
    });
    child.unref();
    process.exit(0);
}

if (!app) {
    console.error('Critical Error: Electron app module is undefined.');
    console.log('Final electron type:', typeof electron);
}

let mainWindow;

let masterRulePath; // ready 이후 설정됨

// 로깅 함수 (masterRulePath 설정 후 사용)
function logToFile(msg) {
    const timestamp = new Date().toISOString();
    try {
        const runtimeLogPath = path.join(masterRulePath, 'runtime_debug.log');
        fs.appendFileSync(runtimeLogPath, `[${timestamp}] ${msg}\n`);
    } catch (e) { }
    process.stdout.write(`[${timestamp}] ${msg}\n`);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 1050,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
            preload: path.join(__dirname, 'preload.js'),
            backgroundThrottling: false
        },
        title: "엑셀 데이터 비교 프로그램"
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    mainWindow.on('closed', () => { mainWindow = null; });
}

// IPC: 파일 경로 저장/불러오기 (불러오기 기능을 위해 - 디스크에 영구 저장)
function getFilePathsFile() {
    return path.join(masterRulePath, 'saved_file_paths.json');
}

function loadSavedPaths() {
    try {
        const filePathsFile = getFilePathsFile();
        if (fs.existsSync(filePathsFile)) {
            return JSON.parse(fs.readFileSync(filePathsFile, 'utf8'));
        }
    } catch (e) { }
    return {};
}

function savePaths(paths) {
    try {
        const filePathsFile = getFilePathsFile();
        fs.writeFileSync(filePathsFile, JSON.stringify(paths, null, 2), 'utf8');
    } catch (e) { console.error('경로 저장 실패:', e); }
}

// createWindow 함수 정의 유지

app.on('ready', () => {
    // Portable Data Architecture 초기화 (ready 이후에 app API 사용 가능)
    // Portable Data Architecture 초기화 (ready 이후에 app API 사용 가능)
    if (app.isPackaged) {
        // [수정] 포터블 실행 시에도 실행 파일과 같은 위치 혹은 시스템 AppData 사용하도록 유도
        // 포터블 버전(NSIS)의 경우 app.getPath('exe')가 임시 폴더일 수 있음
        // 따라서 userData를 기본으로 하되, 실행파일 주변의 'masterrule'을 우선 탐색
        const exeDir = path.dirname(app.getPath('exe'));
        const portablePath = path.join(exeDir, 'masterrule');

        if (fs.existsSync(portablePath)) {
            masterRulePath = portablePath;
        } else {
            // 없으면 사용자의 AppData 로컬 폴더에 생성 (권한 문제 방지)
            masterRulePath = path.join(app.getPath('userData'), 'masterrule');
        }
    } else {
        masterRulePath = path.join(__dirname, 'masterrule');
    }

    if (!fs.existsSync(masterRulePath)) {
        try {
            fs.mkdirSync(masterRulePath, { recursive: true });
        } catch (e) {
            // 최종 폴백: 시스템 임시 폴더
            masterRulePath = path.join(require('os').tmpdir(), 'excel-compare-masterrule');
            if (!fs.existsSync(masterRulePath)) fs.mkdirSync(masterRulePath, { recursive: true });
        }
    }

    process.env.APP_DATA_PATH = masterRulePath;
    console.log(`📂 [Startup] Data Path: ${masterRulePath}`);

    // 이전 데이터 마이그레이션 (AppData -> masterrule 최초 1회)
    const oldUserData = app.getPath('userData');
    ['rules.json', 'products.json', 'saved_file_paths.json'].forEach(file => {
        const oldPath = path.join(oldUserData, file);
        const newPath = path.join(masterRulePath, file);
        if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
            try { fs.copyFileSync(oldPath, newPath); } catch (e) { }
        }
    });
    process.env.APP_DATA_PATH = masterRulePath;

    // 로깅 시스템 초기화 및 전역 console 오버라이드
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => {
        logToFile(args.join(' '));
        originalLog.apply(console, args);
    };
    console.error = (...args) => {
        logToFile('❌ ERROR: ' + args.join(' '));
        originalError.apply(console, args);
    };

    // IPC 핸들러 등록 (ready 상태에서 등록 권장)
    ipcMain.handle('save-file-path', (event, type, filePath) => {
        const paths = loadSavedPaths();
        paths[type] = filePath;
        savePaths(paths);
        console.log(`📂 [IPC] 파일 경로 저장: ${type} => ${filePath}`);
        return true;
    });

    ipcMain.handle('get-file-path', (event, type) => {
        const paths = loadSavedPaths();
        return paths[type] || null;
    });

    ipcMain.handle('save-excel', async (event, { buffer, defaultName }) => {
        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            defaultPath: defaultName,
            filters: [
                { name: 'Excel Files', extensions: ['xlsx'] }
            ]
        });

        if (filePath) {
            fs.writeFileSync(filePath, Buffer.from(buffer));
            console.log(`💾 [IPC] 엑셀 파일 저장 완료: ${filePath}`);
            return { success: true, filePath };
        }
        return { success: false };
    });

    ipcMain.handle('select-file', async (event, { type, defaultPath }) => {
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
            defaultPath: defaultPath || undefined,
            properties: ['openFile'],
            filters: [
                { name: 'Excel Files', extensions: ['xlsx', 'xls', 'xlsm'] }
            ]
        });

        if (!canceled && filePaths && filePaths.length > 0) {
            const selectedPath = filePaths[0];
            const paths = loadSavedPaths();
            paths[type] = selectedPath;
            savePaths(paths);
            console.log(`📂 [IPC] 파일 선택 완료: ${type} => ${selectedPath}`);
            return selectedPath;
        }
        return null;
    });

    ipcMain.handle('check-file-exists', (event, targetPath) => {
        try {
            return fs.existsSync(targetPath);
        } catch (e) {
            return false;
        }
    });

    ipcMain.on('log-frontend-error', (event, errorMsg) => {
        logToFile(`[Frontend Error] ${errorMsg}`);
    });

    const errorLogPath = path.join(masterRulePath, 'startup_error.log');

    // 백엔드 시작 전 로그 초기화
    try { fs.writeFileSync(errorLogPath, `[${new Date().toISOString()}] Starting...\n`); } catch (e) { }

    try {
        logToFile('🚀 서버 기동 시도 중...');
        // 각 모듈 require를 개별 try/catch로 테스트
        let express, cors, ExcelJS, multer;
        try { express = require('express'); } catch (e) { throw new Error('express 로드 실패: ' + e.message); }
        try { cors = require('cors'); } catch (e) { throw new Error('cors 로드 실패: ' + e.message); }
        try { ExcelJS = require('exceljs'); } catch (e) { throw new Error('exceljs 로드 실패: ' + e.message); }
        try { multer = require('multer'); } catch (e) { throw new Error('multer 로드 실패: ' + e.message); }

        logToFile('✅ 필수 모듈 로드 완료');

        // [중요] 기존 실행 중인 서버나 포트 충돌 방지 로직 (여기서는 server.js 내부에서 처리됨)
        require('./server.js');

        logToFile('✨ server.js 로드 및 실행 성공');
    } catch (err) {
        const errMsg = `서버 시작 실패:\n${err.message}\n\n스택:\n${err.stack}`;
        logToFile(`❌ FATAL ERROR: ${err.stack}`);
        dialog.showErrorBox('서버 시작 실패', errMsg);
    }

    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (mainWindow === null) createWindow();
});
