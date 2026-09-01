const { BrowserWindow, session, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');

let automationWin = null;
let currentDownloadResolve = null;
let currentDownloadReject = null;

/**
 * SINGLEX 설정 파일 경로
 */
function getConfigFile(appDataPath) {
    const dir = appDataPath || app.getPath('userData');
    return path.join(dir, 'singlex_config.json');
}

/**
 * 설정 불러오기
 */
function loadConfig(appDataPath) {
    const file = getConfigFile(appDataPath);
    const defaultVal = {
        username: '',
        password: '',
        startDate: '2026.08.21', // 사용자 지정 시작일 (저장 유지)
        departurePlaceFrom: 'UDW',
        departurePlaceTo: 'UDWCY',
        cntrStatusFrom: '01',
        cntrStatusTo: '07',
        showBrowser: false // 디버그/OTP 수동 입력용 브라우저 표시 여부
    };

    if (fs.existsSync(file)) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            return { ...defaultVal, ...data };
        } catch (e) {
            console.error('[SINGLEX] 설정 로드 오류:', e);
        }
    }
    return defaultVal;
}

/**
 * 설정 저장하기
 */
function saveConfig(appDataPath, config) {
    const file = getConfigFile(appDataPath);
    try {
        const current = loadConfig(appDataPath);
        const merged = { ...current, ...config };
        fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[SINGLEX] 설정 저장 오류:', e);
        return false;
    }
}

/**
 * YYYY.MM.DD 형식 변환
 */
function getFormattedDate(date) {
    const d = new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
}

/**
 * 상태 알림 전송
 */
function sendStatus(mainWindow, step, message, details = {}) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('singlex-status-update', { step, message, ...details });
    }
    console.log(`[SINGLEX] [${step}] ${message}`);
}

/**
 * 자동화 윈도우 생성 및 초기화
 */
function createAutomationWindow(mainWindow, showBrowser = false) {
    if (automationWin && !automationWin.isDestroyed()) {
        if (showBrowser) automationWin.show();
        return automationWin;
    }

    const sess = session.fromPartition('persist:singlex_session');

    // 엑셀 다운로드 가로채기 설정
    sess.on('will-download', (event, item, webContents) => {
        const fileName = item.getFilename();
        console.log(`[SINGLEX] 엑셀 다운로드 감지: ${fileName}`);
        
        const tempDir = app.getPath('temp');
        const savePath = path.join(tempDir, `singlex_download_${Date.now()}_${fileName}`);
        item.setSavePath(savePath);

        sendStatus(mainWindow, 'DOWNLOADING', `파일 다운로드 중: ${fileName}`);

        item.once('done', (evt, state) => {
            if (state === 'completed') {
                console.log(`[SINGLEX] 다운로드 완료: ${savePath}`);
                sendStatus(mainWindow, 'DONE', '엑셀 파일 다운로드 완료! 앱에 자동 등록합니다.', { savePath, fileName });
                
                try {
                    const fileBuffer = fs.readFileSync(savePath);
                    if (currentDownloadResolve) {
                        currentDownloadResolve({
                            success: true,
                            filePath: savePath,
                            fileName: fileName,
                            buffer: fileBuffer
                        });
                        currentDownloadResolve = null;
                    }
                } catch (readErr) {
                    if (currentDownloadReject) currentDownloadReject(readErr);
                }
            } else {
                console.error(`[SINGLEX] 다운로드 실패: ${state}`);
                if (currentDownloadReject) {
                    currentDownloadReject(new Error(`다운로드 실패: ${state}`));
                    currentDownloadReject = null;
                }
            }
        });
    });

    automationWin = new BrowserWindow({
        width: 1280,
        height: 900,
        show: showBrowser,
        title: 'SINGLEX 전산 자동화',
        webPreferences: {
            session: sess,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false
        }
    });

    automationWin.on('closed', () => {
        automationWin = null;
    });

    return automationWin;
}

/**
 * 전산 자동 다운로드 메인 실행 함수
 */
async function startDownload(mainWindow, appDataPath, manualOtp = null) {
    return new Promise(async (resolve, reject) => {
        currentDownloadResolve = resolve;
        currentDownloadReject = reject;

        const config = loadConfig(appDataPath);
        const todayStr = getFormattedDate(new Date());
        const startDateStr = config.startDate || '2026.08.21';

        sendStatus(mainWindow, 'START', '전산 자동 다운로드를 시작합니다...');

        const win = createAutomationWindow(mainWindow, config.showBrowser);

        try {
            // 1. 포털 접속 시도
            sendStatus(mainWindow, 'CONNECTING', 'SINGLEX 물류 포털 접속 중...');
            await win.loadURL('https://logistics-lge.singlex.com/irj/portal');

            await win.webContents.executeJavaScript(`new Promise(r => setTimeout(r, 2000))`);

            const currentUrl = win.webContents.getURL();
            console.log(`[SINGLEX] 현재 URL: ${currentUrl}`);

            // 2. SSO 로그인 페이지로 리다이렉트된 경우 (sso.lge.com)
            if (currentUrl.includes('sso.lge.com') || currentUrl.includes('login') || currentUrl.includes('iam')) {
                sendStatus(mainWindow, 'LOGIN_REQUIRED', 'LGE SSO 로그인 및 OTP 인증을 진행합니다.');

                // 계정/비밀번호 자동 입력 스크립트 주입
                const loginScript = `
                    (function() {
                        const userInput = document.querySelector('input[name="USER"], input#USER, input#userId, input[name="username"], input[type="text"]');
                        const passInput = document.querySelector('input[name="PASSWORD"], input#PASSWORD, input#password, input[type="password"]');
                        
                        if (userInput && "${config.username}") {
                            userInput.value = "${config.username}";
                            userInput.dispatchEvent(new Event('input', { bubbles: true }));
                            userInput.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        if (passInput && "${config.password}") {
                            passInput.value = "${config.password}";
                            passInput.dispatchEvent(new Event('input', { bubbles: true }));
                            passInput.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        return { hasUser: !!userInput, hasPass: !!passInput };
                    })();
                `;
                await win.webContents.executeJavaScript(loginScript);

                // OTP 입력이 필요한 경우
                if (manualOtp) {
                    const fillOtpScript = `
                        (function() {
                            const otpInput = document.querySelector('input[name="OTP"], input#OTP, input[placeholder*="OTP"], input[name*="otp"], input[type="password"]:not([name="PASSWORD"])');
                            if (otpInput) {
                                otpInput.value = "${manualOtp}";
                                otpInput.dispatchEvent(new Event('input', { bubbles: true }));
                                otpInput.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                            const loginBtn = document.querySelector('button[type="submit"], input[type="submit"], #loginBtn, .btn_login') || document.querySelector('form button, form input[type="submit"]');
                            if (loginBtn) {
                                loginBtn.click();
                                return true;
                            }
                            return false;
                        })();
                    `;
                    await win.webContents.executeJavaScript(fillOtpScript);
                } else {
                    sendStatus(mainWindow, 'WAITING_OTP', 'OTP 번호 6자리를 입력해주세요.', { username: config.username });
                    if (config.showBrowser) win.show();
                    return; // OTP 수신 후 submitSinglexOtp로 재개
                }

                // 로그인 완료 대기 (포털 리다이렉트 대기)
                await waitForNavigation(win, ['logistics-lge.singlex.com', 'newep.lge.com'], 20000);
            }

            // 3. New EP 포털(newep.lge.com)에 도달한 경우 SINGLEX 물류 포털로 이동
            const epUrl = win.webContents.getURL();
            if (epUrl.includes('newep.lge.com')) {
                sendStatus(mainWindow, 'PORTAL_NAV', '물류 포털(SINGLEX)로 진입합니다...');
                await win.loadURL('https://logistics-lge.singlex.com/irj/portal');
                await win.webContents.executeJavaScript(`new Promise(r => setTimeout(r, 3000))`);
            }

            // 4. 즐겨찾기(⭐) 메뉴 클릭 ➔ 'Display Inventory of CNTR' 메뉴 진입
            sendStatus(mainWindow, 'NAVIGATING_MENU', "즐겨찾기에서 'Display Inventory of CNTR' 메뉴를 여는 중...");
            
            const navigateMenuScript = `
                (async function() {
                    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
                    
                    const starBtn = document.querySelector('[title*="Favorite"], [title*="즐겨찾기"], .sapUiIcon[data-sap-ui-icon-content*="favorite"], #favoritesButton, i.fa-star') 
                                 || Array.from(document.querySelectorAll('button, div, span, a')).find(el => (el.textContent && el.textContent.includes('Favorites')) || (el.getAttribute('title') && el.getAttribute('title').includes('Favorites')));
                    
                    if (starBtn) {
                        starBtn.click();
                        await sleep(1500);
                    }

                    const menuItems = Array.from(document.querySelectorAll('a, span, div, li, td'));
                    const targetMenu = menuItems.find(el => el.textContent && el.textContent.trim() === 'Display Inventory of CNTR')
                                    || menuItems.find(el => el.textContent && el.textContent.includes('Display Inventory of CNTR'));

                    if (targetMenu) {
                        targetMenu.click();
                        return { success: true };
                    }
                    return { success: false };
                })();
            `;

            await win.webContents.executeJavaScript(navigateMenuScript);
            await win.webContents.executeJavaScript(`new Promise(r => setTimeout(r, 4000))`);

            // 5. Advanced Search 열기 및 조건 입력 (시작일, 종료일=오늘, UDW, 01~07)
            sendStatus(mainWindow, 'SETTING_CONDITIONS', `검색 조건 세팅 중 (기간: ${startDateStr} ~ ${todayStr} / UDW / 01~07)...`);

            const searchConditionScript = `
                (async function() {
                    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

                    const advBtn = Array.from(document.querySelectorAll('button, a, div')).find(el => {
                        const t = (el.textContent || '').trim();
                        return t.includes('Open Adv') || t.includes('Advanced');
                    });

                    if (advBtn) {
                        advBtn.click();
                        await sleep(1500);
                    }

                    const allInputs = Array.from(document.querySelectorAll('input'));
                    
                    // Load Plan Date
                    const dateInputs = allInputs.filter(i => {
                        const parent = i.closest('tr, div, td');
                        return parent && (parent.textContent.includes('Load Plan Date') || parent.textContent.includes('Plan Date'));
                    });

                    if (dateInputs.length >= 2) {
                        dateInputs[0].value = "${startDateStr}";
                        dateInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
                        dateInputs[0].dispatchEvent(new Event('change', { bubbles: true }));

                        dateInputs[1].value = "${todayStr}";
                        dateInputs[1].dispatchEvent(new Event('input', { bubbles: true }));
                        dateInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
                    }

                    // Departure Place (UDW ~ UDWCY)
                    const depInputs = allInputs.filter(i => {
                        const parent = i.closest('tr, div, td');
                        return parent && parent.textContent.includes('Departure Place');
                    });
                    if (depInputs.length >= 2) {
                        depInputs[0].value = "${config.departurePlaceFrom || 'UDW'}";
                        depInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
                        depInputs[0].dispatchEvent(new Event('change', { bubbles: true }));

                        depInputs[1].value = "${config.departurePlaceTo || 'UDWCY'}";
                        depInputs[1].dispatchEvent(new Event('input', { bubbles: true }));
                        depInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
                    }

                    // CNTR Status (01 ~ 07)
                    const statusInputs = allInputs.filter(i => {
                        const parent = i.closest('tr, div, td');
                        return parent && parent.textContent.includes('CNTR Status');
                    });
                    if (statusInputs.length >= 2) {
                        statusInputs[0].value = "${config.cntrStatusFrom || '01'}";
                        statusInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
                        statusInputs[0].dispatchEvent(new Event('change', { bubbles: true }));

                        statusInputs[1].value = "${config.cntrStatusTo || '07'}";
                        statusInputs[1].dispatchEvent(new Event('input', { bubbles: true }));
                        statusInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
                    }

                    await sleep(500);

                    const goBtn = Array.from(document.querySelectorAll('button, a')).find(el => (el.textContent || '').trim() === 'Go' || (el.getAttribute('title') || '').trim() === 'Go');
                    if (goBtn) {
                        goBtn.click();
                        return { success: true };
                    }
                    return { success: false };
                })();
            `;

            await win.webContents.executeJavaScript(searchConditionScript);

            // 6. 검색 결과 테이블 로딩 대기
            sendStatus(mainWindow, 'SEARCHING', '전산 데이터 조회 중 (테이블 로딩 대기)...');
            await win.webContents.executeJavaScript(`new Promise(r => setTimeout(r, 6000))`);

            // 7. 엑셀 내보내기 및 팝업 2단계 클릭 (Spreadsheet ➔ Export to... ➔ OK)
            sendStatus(mainWindow, 'EXPORTING', '엑셀 Spreadsheet 내보내기 팝업 처리 중...');

            const exportScript = `
                (async function() {
                    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

                    const exportDropdownBtn = document.querySelector('[title*="Export"], [title*="Spreadsheet"], .sapUiIcon[data-sap-ui-icon-content*="excel"]')
                                           || Array.from(document.querySelectorAll('button, div, span')).find(el => (el.getAttribute('title') || '').includes('Export') || (el.className && el.className.includes('export')));

                    if (exportDropdownBtn) {
                        exportDropdownBtn.click();
                        await sleep(1000);
                    }

                    const spreadsheetOption = Array.from(document.querySelectorAll('div, span, li, a')).find(el => (el.textContent || '').trim() === 'Spreadsheet');
                    if (spreadsheetOption) {
                        spreadsheetOption.click();
                        await sleep(2000);
                    }

                    const exportToBtn = Array.from(document.querySelectorAll('button, input[type="button"]')).find(el => {
                        const t = (el.textContent || el.value || '').trim();
                        return t.includes('Export to') || t === 'Export to...';
                    });
                    if (exportToBtn) {
                        exportToBtn.click();
                        await sleep(2000);
                    }

                    const okBtn = Array.from(document.querySelectorAll('button, input[type="button"]')).find(el => {
                        const t = (el.textContent || el.value || '').trim();
                        return t === 'OK';
                    });
                    if (okBtn) {
                        okBtn.click();
                        return { success: true };
                    }
                    return { success: false };
                })();
            `;

            await win.webContents.executeJavaScript(exportScript);
            sendStatus(mainWindow, 'WAITING_FILE', '브라우저에서 엑셀 파일 다운로드를 수신하고 있습니다...');
        } catch (err) {
            console.error('[SINGLEX] 자동화 실행 중 오류:', err);
            sendStatus(mainWindow, 'ERROR', `자동 다운로드 실패: ${err.message}`);
            reject(err);
        }
    });
}

function waitForNavigation(win, targetUrlSubstrings, timeoutMs = 15000) {
    return new Promise((resolve) => {
        const start = Date.now();
        const check = setInterval(() => {
            if (win.isDestroyed()) {
                clearInterval(check);
                resolve(false);
                return;
            }
            const curUrl = win.webContents.getURL();
            const matched = targetUrlSubstrings.some(sub => curUrl.includes(sub));
            if (matched || Date.now() - start > timeoutMs) {
                clearInterval(check);
                resolve(matched);
            }
        }, 500);
    });
}

function registerSinglexIpc(ipcMainInstance, mainWindow, appDataPath) {
    ipcMainInstance.handle('get-singlex-config', () => {
        return loadConfig(appDataPath);
    });

    ipcMainInstance.handle('save-singlex-config', (event, config) => {
        return saveConfig(appDataPath, config);
    });

    ipcMainInstance.handle('start-singlex-download', async (event, options = {}) => {
        try {
            return await startDownload(mainWindow, appDataPath, options.otp || null);
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMainInstance.handle('submit-singlex-otp', async (event, otp) => {
        try {
            return await startDownload(mainWindow, appDataPath, otp);
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMainInstance.handle('cancel-singlex-download', () => {
        if (automationWin && !automationWin.isDestroyed()) {
            automationWin.close();
            automationWin = null;
        }
        return true;
    });
}

module.exports = {
    registerSinglexIpc,
    loadConfig,
    saveConfig,
    startDownload
};
