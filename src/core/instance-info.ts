import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const instanceInfoRouter = Router();

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SETTINGS_PATH = path.join(DATA_DIR, 'instance-settings.json');

instanceInfoRouter.get('/instance-info', (req, res) => {
    // 1. Set fallback values from env variables (if they exist)
    let adminWallet = process.env.TESSERA_ADMIN_WALLET || process.env.SELLER_ADDRESS || '';
    let displayFee = process.env.TESSERA_DISPLAY_FEE !== undefined ? Number(process.env.TESSERA_DISPLAY_FEE) : 0.10;
    let originFee = process.env.TESSERA_ORIGIN_FEE !== undefined ? Number(process.env.TESSERA_ORIGIN_FEE) : 0.10;

    // 2. Override with dynamically persisted JSON settings (priority)
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
            const data = JSON.parse(raw);
            if (data.adminWallet) adminWallet = data.adminWallet.trim();
            if (data.displayFee !== undefined) displayFee = Number(data.displayFee);
            if (data.originFee !== undefined) originFee = Number(data.originFee);
        }
    } catch (err) {
        console.error('[Tessera-InstanceInfo] ⚠️ Error reading instance-settings.json:', err);
    }

    // 3. If no admin wallet is configured, indicate that we are not yet ready
    if (!adminWallet) {
        return res.status(503).json({
            error: 'Tessera not fully configured: Admin wallet address is missing. Configure it in the PeerTube plugin settings UI.',
            tesseraVersion: '1.2.0',
        });
    }

    res.json({
        adminWallet,
        displayFee,
        originFee,
        tesseraVersion: '1.2.0',
    });
});

export default instanceInfoRouter;
