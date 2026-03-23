const { spawn } = require('child_process');

const password = 'z456qwe12!@';
const sshCmd = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const args = [
    '-p', '8022',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    'u0_a286@192.168.0.24',
    'df -h /data/data/com.termux/files/home && echo "---" && df -h /storage/emulated/0'
];

const child = spawn(sshCmd, args);

console.log('📡 Accessing phone storage info via SSH...');

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
    console.log(`\n--- Check Finished (Exit Code: ${code}) ---`);
});
