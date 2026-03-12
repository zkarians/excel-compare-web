const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Electron의 contextIsolation 환경에서 renderer에 안전하게 API 노출
contextBridge.exposeInMainWorld('electronAPI', {
    // webUtils.getPathForFile: contextIsolation에서 File 객체의 실제 경로를 가져오는 공식 API
    getPathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file);
        } catch (e) {
            console.error('getPathForFile 실패:', e);
            return null;
        }
    },
    // 파일 경로 저장 요청 (main process에서 디스크에 영구 저장)
    saveFilePath: (type, filePath) => ipcRenderer.invoke('save-file-path', type, filePath),
    // 저장된 파일 경로 가져오기
    getFilePath: (type) => ipcRenderer.invoke('get-file-path', type),
    // 엑셀 파일 저장 (네이티브 다이얼로그)
    saveExcel: (buffer, defaultName) => ipcRenderer.invoke('save-excel', { buffer, defaultName }),
    // 파일 존재 여부 확인
    checkFileExists: (filePath) => ipcRenderer.invoke('check-file-exists', filePath),
    // 네이티브 파일 선택 다이얼로그 (폴더 기억 가능)
    selectFile: (type, defaultPath) => ipcRenderer.invoke('select-file', { type, defaultPath }),
    // 프론트엔드 에러 백엔드 로그로 전송
    logFrontendError: (errorMsg) => ipcRenderer.send('log-frontend-error', errorMsg)
});
