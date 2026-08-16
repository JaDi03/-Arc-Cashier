import { createRequire } from 'module';
import path from 'path';

const requirePkg = createRequire(__filename);
const pkg = requirePkg(path.join(__dirname, '..', 'package.json')) as { version?: string };

if (!pkg.version || typeof pkg.version !== 'string') {
    throw new Error('package.json is missing a version field');
}

/** Sidecar version. Single source of truth: root package.json. */
export const TESSERA_VERSION: string = pkg.version;
