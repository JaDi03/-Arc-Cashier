import 'dotenv/config';
import { createServer } from './server';
import config from './tessera.config';

const PORT = Number(process.env.PORT || config.port || 7878);

async function main() {
    try {
        const app = await createServer(config.connectors);

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Tessera running on http://localhost:${PORT}`);
            console.log(`📋 Active connectors: ${config.connectors.map(c => c.name).join(', ')}`);
        });
    } catch (error) {
        console.error('❌ Critical failure starting the server:', error);
        process.exit(1);
    }
}

main();
