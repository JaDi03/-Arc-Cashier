import 'dotenv/config';
import { createServer } from './server';
import config from './tessera.config';

const PORT = Number(process.env.PORT || config.port || 7878);

async function main() {
    try {
        if (!process.env.TESSERA_INGEST_SECRET && process.env.NODE_ENV !== 'test') {
            throw new Error('FATAL - TESSERA_INGEST_SECRET is not defined. Sessions/start and stop cannot be authenticated.');
        }

        const app = await createServer();

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Tessera running on http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('Critical failure starting the server:', error);
        process.exit(1);
    }
}

main();
