import type { CashierConfig } from './core/types';

const config: CashierConfig = {
    port: Number(process.env.PORT || 7878),
};

export default config;
