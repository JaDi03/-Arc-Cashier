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
    
    rl.question('\nEnter 1 or 2: ', (answer) => {
        const choice = answer.trim();
        if (choice === '1') {
            askUpstreamUrl('owncast', 'http://127.0.0.1:8080');
        } else if (choice === '2') {
            askUpstreamUrl('peertube', 'http://localhost:9000');
        } else {
            console.log('Invalid selection. Please enter 1 or 2.');
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

    // 1. Update tessera.config.ts
    const configPath = path.join(__dirname, '..', 'src', 'tessera.config.ts');
    
    try {
        let configContent = fs.readFileSync(configPath, 'utf-8');
        
        // Regex to replace the connectors array block completely
        const connectorsRegex = /connectors:\s*\[[\s\S]*?\],/m;
        
        const newConnectorsBlock = `connectors: [\n        {\n            name: '${platformName}',\n            upstreamUrl: '${defaultUrl}',\n            ratePerSecond: 0.0001,\n        },\n    ],`;

        if (connectorsRegex.test(configContent)) {
            configContent = configContent.replace(connectorsRegex, newConnectorsBlock);
            fs.writeFileSync(configPath, configContent);
            console.log(`✅ Updated src/tessera.config.ts with ${platformName} connector.`);
        } else {
            console.warn(`⚠️  Could not automatically locate the connectors block in tessera.config.ts. Please configure it manually.`);
        }
    } catch (error) {
        console.error(`❌ Failed to read or update tessera.config.ts:`, error.message);
    }

    // 2. Generate .env file securely
    const envPath = path.join(__dirname, '..', '.env');
    const envExamplePath = path.join(__dirname, '..', '.env.example');

    try {
        if (!fs.existsSync(envPath)) {
            if (fs.existsSync(envExamplePath)) {
                let envContent = fs.readFileSync(envExamplePath, 'utf-8');
                
                // If platform is peertube, generate a webhook secret automatically
                if (platformName === 'peertube') {
                    const crypto = require('crypto');
                    const secret = crypto.randomBytes(32).toString('hex');
                    envContent = envContent.replace(
                        /# PEERTUBE_WEBHOOK_SECRET=your_generated_secret_here/g,
                        `PEERTUBE_WEBHOOK_SECRET=${secret}`
                    );
                }

                fs.writeFileSync(envPath, envContent);
                console.log(`✅ Generated .env file securely from .env.example.`);
            } else {
                console.warn(`⚠️  .env.example not found. Skipping .env generation.`);
            }
        } else {
            console.log(`ℹ️  .env file already exists. Skipping generation.`);
        }
    } catch (error) {
        console.error(`❌ Failed to copy .env file:`, error.message);
    }

    finishSetup(platformName);
}

function finishSetup(platformName) {
    console.log(`
=========================================
 🎉 SETUP COMPLETE! 🎉
=========================================

⚠️  ACTION REQUIRED:
For security reasons, this script does NOT ask for your API Keys.
Please manually open the '.env' file in your code editor and configure:
 - CIRCLE_API_KEY
 - CIRCLE_APP_ID
 - SELLER_PRIVATE_KEY
 - SELLER_ADDRESS
`);
    if (platformName === 'peertube') {
        console.log(`✅ PEERTUBE_WEBHOOK_SECRET was automatically generated in your .env file.`);
        console.log(`Copy this secret into the PeerTube Plugin Settings so they can communicate securely.\n`);
    }

    console.log(`Once your .env is configured, start the sidecar with:
  npm run dev
`);
    rl.close();
}

// Start the setup flow
askPlatform();
