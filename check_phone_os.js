const { spawn } = require('child_process');

const password = 'z456qwe12!@';
const sshCmd = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const args = [
    '-p', '8022',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    'u0_a286@192.168.0.17',
    'echo "--- [1] 프로세스 확인 (Postgres & SSH) ---" && ps aux | grep -p "postgres|sshd" && ' +
    'echo "--- [2] 자동실행 스크립트 내용 및 권한 ---" && ls -l ~/.termux/boot/start-db.sh && cat ~/.termux/boot/start-db.sh && ' +
    'echo "--- [3] 시스템 가동 시간 및 부하 ---" && uptime && ' +
    'echo "--- [4] 네트워크 상세 ---" && ifconfig wlan0 | grep "inet "'
];

const child = spawn(sshCmd, args);

child.stdout.on('data', (data) => {
    process.stdout.write(data);
});

child.stderr.on('data', (data) => {
    const output = data.toString();
    if (output.toLowerCase().includes('password:')) {
        child.stdin.write(password + '\n');
    } else {
        process.stderr.write(data);
    }
});

child.on('close', (code) => {
    console.log(`\n--- 점검 종료 (Exit Code: ${code}) ---`);
});
