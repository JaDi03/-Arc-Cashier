const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log(`
=========================================
 ⚡ TESSERA - INITIAL SETUP ⚡
=========================================
`);

function askPlatform() {
    console.log('Select your streaming platform:');
    console.log('1) Owncast');
    console.log('2) PeerTube');
    console.log('3) Jellyfin');
    
    rl.question('\nEnter 1, 2, or 3: ', (answer) => {
        const choice = answer.trim();
        if (choice === '1') {
            askUpstreamUrl('owncast', 'http://127.0.0.1:8080');
        } else if (choice === '2') {
            askUpstreamUrl('peertube', 'http://localhost:9000');
        } else if (choice === '3') {
            askUpstreamUrl('jellyfin', 'http://localhost:8096');
        } else {
            console.log('Invalid selection. Please enter 1, 2, or 3.');
            askPlatform();
        }
    });
}

function askUpstreamUrl(platformName, defaultUrl) {
    rl.question(`\nEnter the upstream URL for ${platformName} (press Enter for default: ${defaultUrl}): `, (answer) => {
        const upstreamUrl = answer.trim() || defaultUrl;
        configureProject(platformName, upstreamUrl);
    });
}

function configureProject(platformName, defaultUrl) {
    console.log(`\nConfiguring Tessera for ${platformName}...`);

    // 1. Generate/update .env file securely
    const envPath = path.join(__dirname, '..', '.env');
    const envExamplePath = path.join(__dirname, '..', '.env.example');

    try {
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf-8');
        } else if (fs.existsSync(envExamplePath)) {
            envContent = fs.readFileSync(envExamplePath, 'utf-8');
            const crypto = require('crypto');
            const masterKey = crypto.randomBytes(32).toString('hex');
            envContent = envContent.replace(
                /MASTER_KEY=your_secure_master_key_here/g,
                `MASTER_KEY=${masterKey}`
            );
        }

        // Set or update ACTIVE_CONNECTOR and UPSTREAM_URL
        if (envContent.includes('ACTIVE_CONNECTOR=')) {
            envContent = envContent.replace(/ACTIVE_CONNECTOR=.*/g, `ACTIVE_CONNECTOR=${platformName}`);
        } else {
            envContent = `ACTIVE_CONNECTOR=${platformName}\n` + envContent;
        }

        if (envContent.includes('UPSTREAM_URL=')) {
            envContent = envContent.replace(/UPSTREAM_URL=.*/g, `UPSTREAM_URL=${defaultUrl}`);
        } else {
            envContent = `UPSTREAM_URL=${defaultUrl}\n` + envContent;
        }

        fs.writeFileSync(envPath, envContent);
        console.log(`✅ Configured .env with ACTIVE_CONNECTOR=${platformName} and UPSTREAM_URL=${defaultUrl}`);
    } catch (error) {
        console.error(`❌ Failed to update .env:`, error.message);
    }

    finishSetup(platformName, defaultUrl);
}

function finishSetup(platformName, upstreamUrl) {
    console.log(`
=========================================
 🎉 SETUP COMPLETE! 🎉
=========================================

⚠️  ACTION REQUIRED:
For security reasons, this script does NOT ask for your API Keys.
Please manually open the '.env' file in your code editor and configure:
 - CIRCLE_API_KEY
 - CIRCLE_APP_ID
 - SELLER_ADDRESS
`);
    console.log(`✅ MASTER_KEY was automatically generated in your .env file to encrypt session keys at rest.`);
    console.log(`✅ Configured for ${platformName} (upstream: ${upstreamUrl}).`);
    console.log(`Point the Webhook plugin to: http://localhost:7878/api/connectors/${platformName}/webhook\n`);

    console.log(`Once your .env is configured, compile and start the sidecar with:
  npm run build
  npm run start
`);
    rl.close();
}

// Start the setup flow
askPlatform();
