import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('isolated runner reports failed suites and preparation instead of a successful final echo', { skip: process.platform === 'win32' }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-runner-test-'));
    try {
        await fs.copyFile(new URL('./run-isolated.sh', import.meta.url), path.join(dir, 'run-isolated.sh'));
        await fs.writeFile(path.join(dir, 'prepare.sh'), 'printf "{}" > installation.json\nexit "${PREPARE_EXIT:-0}"\n');
        await fs.writeFile(path.join(dir, 'pass.mjs'), "console.log('ALL PASS');\n");
        await fs.writeFile(path.join(dir, 'fail.mjs'), "console.log('FAIL expected fixture');process.exit(42);\n");
        const run = (args, extra = {}) => spawnSync('bash', [path.join(dir, 'run-isolated.sh'), ...args], {
            encoding: 'utf8', timeout: 15000,
            env: { ...process.env, PROJECT: 'runner-fixture', ST_PORT: '9998', MOCK_PORT: '9999',
                CHROME_PATH: '/unused', PLAYWRIGHT_CORE: '/unused', LOG_DIR: path.join(dir, 'logs'), WITH_HORAE: '0', ...extra },
        });
        let result = run(['pass']);
        assert.equal(result.status, 0, result.stderr);
        result = run(['fail', 'pass']);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stdout, /exit 42/);
        assert.match(result.stdout, /=== pass/, 'remaining suites still run');
        result = run(['pass'], { PREPARE_EXIT: '9' });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stdout, /PREPARE-FAILED/);
        assert.doesNotMatch(result.stdout, /=== pass/, 'no suite runs after failed setup');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
