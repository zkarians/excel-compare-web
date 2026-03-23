const { spawn } = require('child_process');
const fs = require('fs');

/**
 * A23 (Old Phone) -> F5 (New Phone) Database Migration Script
 * This script dumps the database from A23 and restores it to Flip 5 (F5) via SSH.
 */

const CONFIG = {
    oldPhone: {
        host: '192.168.0.21',
        user: 'u0_a286',
        db: 'u0_a286',
        port: 8022
    },
    newPhone: {
        host: '192.168.0.24',
        user: 'u0_a354',
        db: 'u0_a354',
        port: 8022
    },
    password: 'z456qwe12!@'
};

const sshExe = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';

async function migrate() {
    console.log(`🚀 Starting Direct DB Migration: ${CONFIG.oldPhone.host} -> ${CONFIG.newPhone.host}`);

    // Command: ssh [A23] "pg_dump" | ssh [F5] "psql"
    // Note: Termux postgres doesn't usually require password if 'trust' is set for local, 
    // but SSH itself might require password interaction.

    const dumpCmd = `pg_dump -U ${CONFIG.oldPhone.user} --clean --if-exists ${CONFIG.oldPhone.db}`;
    const restoreCmd = `psql -U ${CONFIG.newPhone.user} ${CONFIG.newPhone.db}`;

    console.log(`📡 [1/2] Dumping from A23 (${CONFIG.oldPhone.host})...`);

    const migrationProcess = spawn('cmd.exe', ['/c',
        `${sshExe} -p ${CONFIG.oldPhone.port} ${CONFIG.oldPhone.user}@${CONFIG.oldPhone.host} "${dumpCmd}" | ` +
        `${sshExe} -p ${CONFIG.newPhone.port} ${CONFIG.newPhone.user}@${CONFIG.newPhone.host} "${restoreCmd}"`
    ]);

    migrationProcess.stdout.on('data', (data) => {
        process.stdout.write(data);
    });

    migrationProcess.stderr.on('data', (data) => {
        const output = data.toString();
        // Handle password prompts if they appear
        if (output.toLowerCase().includes('password:')) {
            console.log("🔑 Password requested by SSH...");
            migrationProcess.stdin.write(CONFIG.password + '\n');
        } else {
            process.stderr.write(data);
        }
    });

    migrationProcess.on('close', (code) => {
        if (code === 0) {
            console.log("\n✅ Migration completed successfully!");
            console.log("👉 Now you can use the Excel Compare app with the Flip 5 DB.");
        } else {
            console.error(`\n❌ Migration failed with exit code ${code}`);
            console.log("\n💡 Tips:");
            console.log("1. Ensure both phones are on and SSH (Termux) is running.");
            console.log("2. Ensure IPs are correct: A23 (.21), F5 (.24).");
            console.log("3. Ensure Postgres is running on both phones.");
        }
    });
}

migrate();
