const { exec } = require('child_process');

// SSH command to check disk space on the phone
// Using the known settings: 192.168.0.24, port 8022, user u0_a286
const sshCmd = 'ssh -p 8022 u0_a286@192.168.0.24 "df -h $HOME"';

console.log('📡 Checking phone storage capacity via SSH...');

exec(sshCmd, (error, stdout, stderr) => {
    if (error) {
        console.error(`❌ SSH Error: ${error.message}`);
        return;
    }
    if (stderr) {
        console.error(`⚠️ SSH Stderr: ${stderr}`);
    }
    console.log('--- Phone Storage Info ---');
    console.log(stdout);
});
