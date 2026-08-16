import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { TESSERA_VERSION } from './version';

describe('TESSERA_VERSION', () => {
    it('matches package.json and is semver', () => {
        const pkg = JSON.parse(
            readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
        ) as { version: string };
        expect(TESSERA_VERSION).toBe(pkg.version);
        expect(TESSERA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });
});
