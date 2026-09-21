import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRepoUrl } from '../taskRunner.js';

// Opt in with OWLAT_TEST_SANDBOX_DOCKER=1. This exercises Linux permissions
// using the runtime image and the same capabilities as both Compose stacks.
const enabled = process.env['OWLAT_TEST_SANDBOX_DOCKER'] === '1';
const sandboxPath = fileURLToPath(new URL('../sandbox.ts', import.meta.url));

function runContainer(script: string): string {
	return execFileSync(
		'docker',
		[
			'run',
			'--rm',
			'--pull',
			'never',
			'--network',
			'none',
			'--cap-drop',
			'ALL',
			'--cap-add',
			'SETUID',
			'--cap-add',
			'SETGID',
			'--cap-add',
			'CHOWN',
			'--read-only',
			'--tmpfs',
			'/tmp:size=16m',
			'--security-opt',
			'no-new-privileges:true',
			'--mount',
			`type=bind,source=${sandboxPath},target=/audit/sandbox.ts,readonly`,
			'-i',
			'node:26-alpine',
			'node',
			'--input-type=module',
		],
		{ input: script, encoding: 'utf8', timeout: 15_000 }
	);
}

describe.skipIf(!enabled)('sandbox Linux security boundaries', () => {
	it('allows workspace edits but prevents replacing privileged Git metadata', () => {
		const output = runContainer(`
			import assert from 'node:assert/strict';
			import { mkdirSync, writeFileSync } from 'node:fs';
			import { spawnSync } from 'node:child_process';
			import { handOffWorkspaceToSandbox } from '/audit/sandbox.ts';
			mkdirSync('/tmp/work/.git/hooks', { recursive: true });
			writeFileSync('/tmp/work/.git/config', 'trusted config');
			writeFileSync('/tmp/work/source.txt', 'original source');
			handOffWorkspaceToSandbox('/tmp/work');
			const probe = spawnSync(process.execPath, ['-e', \`
				const assert = require('node:assert/strict');
				const fs = require('node:fs');
				fs.writeFileSync('/tmp/work/source.txt', 'edited');
				fs.writeFileSync('/tmp/work/new.txt', 'created');
				fs.renameSync('/tmp/work/new.txt', '/tmp/work/renamed.txt');
				fs.mkdirSync('/tmp/work/replacement');
				for (const attempt of [
					() => fs.renameSync('/tmp/work/.git', '/tmp/work/original-git'),
					() => fs.renameSync('/tmp/work/replacement', '/tmp/work/.git'),
					() => fs.symlinkSync('/tmp/work/replacement', '/tmp/work/.git'),
					() => fs.writeFileSync('/tmp/work/.git/config', 'malicious config'),
					() => fs.writeFileSync('/tmp/work/.git/hooks/pre-commit', 'malicious hook'),
				]) assert.throws(attempt);
			\`], { uid: 10001, gid: 10001, env: {}, encoding: 'utf8' });
			assert.equal(probe.status, 0, probe.stderr);
			console.log('Git metadata boundary passed');
		`);
		expect(output).toContain('Git metadata boundary passed');
	}, 20_000);

	it('keeps Git credentials out of cross-uid readable argv and blocks access to environ', () => {
		const { authEnv } = parseRepoUrl('https://user:dummy-secret@github.com/owlat/example.git');
		const output = runContainer(`
			import assert from 'node:assert/strict';
			import { spawn, spawnSync } from 'node:child_process';
			const trusted = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
				env: ${JSON.stringify(authEnv)}, stdio: 'ignore',
			});
			try {
				const probe = spawnSync(process.execPath, ['-e', \`
					const fs = require('node:fs');
					console.log(fs.readFileSync('/proc/\${trusted.pid}/cmdline', 'utf8'));
					try { fs.readFileSync('/proc/\${trusted.pid}/environ'); process.exit(42); }
					catch (error) { if (error.code !== 'EACCES') throw error; }
				\`], { uid: 10001, gid: 10001, env: {}, encoding: 'utf8' });
				assert.equal(probe.status, 0, probe.stderr);
				assert.ok(probe.stdout.includes('setInterval'));
				assert.ok(!probe.stdout.includes('Authorization'));
				assert.ok(!probe.stdout.includes(${JSON.stringify(authEnv['GIT_CONFIG_VALUE_0'])}));
				console.log('credential boundary passed');
			} finally { trusted.kill('SIGKILL'); }
		`);
		expect(output).toContain('credential boundary passed');
	}, 20_000);

	it.each(['timeout', 'cancel', 'success'])(
		'reaps detached descendants on %s without CAP_KILL',
		(mode) => {
			const output = runContainer(`
				import assert from 'node:assert/strict';
				import { readdirSync, readFileSync } from 'node:fs';
				import { runUntrusted } from '/audit/sandbox.ts';
				const mode = ${JSON.stringify(mode)};
				const controller = new AbortController();
				const script = \`
					const { spawn } = require('node:child_process');
					const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
						detached: true, stdio: 'ignore',
					});
					console.log(child.pid);
					child.unref();
					\${mode === 'success' ? '' : 'setInterval(() => {}, 1000);'}
				\`;
				if (mode === 'cancel') setTimeout(() => controller.abort(), 500);
				const result = await runUntrusted(process.execPath, ['-e', script], {
					cwd: '/tmp', env: {}, timeoutMs: mode === 'timeout' ? 500 : 5000,
					signal: controller.signal,
				});
				assert.match(result.stdout, /[0-9]+/);
				assert.equal(result.timedOut, mode === 'timeout');
				assert.equal(result.killed, mode === 'cancel');
				if (mode === 'success') assert.equal(result.code, 0);
				// A signalled process may briefly remain a zombie until PID 1 reaps it.
				const live = readdirSync('/proc').filter(name => {
					if (!/^[0-9]+$/.test(name)) return false;
					try {
						const status = readFileSync('/proc/' + name + '/status', 'utf8');
						return /^Uid:\\s+10001\\s/m.test(status) && !/^State:\\s+Z/m.test(status);
					} catch (error) { if (error.code === 'ENOENT') return false; throw error; }
				});
				assert.deepEqual(live, []);
				console.log('cleanup boundary passed');
			`);
			expect(output).toContain('cleanup boundary passed');
		},
		20_000
	);
});
