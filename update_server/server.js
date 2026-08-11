const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 4001;

// 업데이트 파일이 위치할 폴더 (현재 스크립트 실행 위치의 updates 폴더)
const updatesDir = path.join(__dirname, 'updates');

// 폴더가 없으면 생성
if (!fs.existsSync(updatesDir)) {
    fs.mkdirSync(updatesDir, { recursive: true });
    console.log(`[안내] 업데이트 폴더가 생성되었습니다: ${updatesDir}`);
    console.log(`[안내] 이 폴더 안에 앱 빌드 후 생성된 latest.yml 파일과 .exe 설치 파일을 넣어주세요.`);
}

// updates 폴더를 정적 파일로 호스팅
app.use(express.static(updatesDir));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`=================================================`);
    console.log(`🚀 ExcelCompare 업데이트 서버가 시작되었습니다.`);
    console.log(`🌐 접속 주소: http://0.0.0.0:${PORT}`);
    console.log(`📁 업데이트 폴더 경로: ${updatesDir}`);
    console.log(`=================================================`);
    console.log(`이 창을 열어두면 사내 PC들이 앱 실행 시 자동으로 새 버전을 감지하고 업데이트합니다.`);
});
