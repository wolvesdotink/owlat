/**
 * The dev stack's on-disk state: the Convex stage mirror
 * (scripts/dev-stack/stage.ts), the per-checkout secrets
 * (scripts/dev-stack/state.ts) and the deployment target shared with
 * `bun run dev:seed` (scripts/dev-stack/convexTarget.ts).
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDevStackConfig } from '../dev-stack/config';
import { resolveConvexTarget, selfHostedCliEnv } from '../dev-stack/convexTarget';
import { syncStage } from '../dev-stack/stage';
import { composeEnvEntries, devStackPaths, loadOrCreateSecrets } from '../dev-stack/state';

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'dev-stack-test-'));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
	mkdirSync(dirname(join(root, rel)), { recursive: true });
	writeFileSync(join(root, rel), content);
}

describe('syncStage', () => {
	function apiFixture(): string {
		const api = tempDir();
		write(api, 'package.json', '{"name":"@owlat/api"}');
		write(api, 'convex/schema.ts', 'export default 1;');
		write(api, 'convex/mail/send.ts', 'export const a = 1;');
		write(api, 'convex/__tests__/testModules.ts', 'import.meta.glob("./**");');
		write(api, 'convex/mail/__tests__/helper.ts', 'export {};');
		write(api, 'convex/mail/send.test.ts', 'export {};');
		write(api, 'scripts/check.sh', 'echo');
		write(api, '.env.local', 'CONVEX_DEPLOYMENT=dev:someone');
		return api;
	}

	it('mirrors convex/ and package.json without any __tests__ directory', () => {
		const api = apiFixture();
		const stage = join(tempDir(), 'api');
		syncStage(api, stage);
		expect(existsSync(join(stage, 'convex/schema.ts'))).toBe(true);
		expect(existsSync(join(stage, 'convex/mail/send.ts'))).toBe(true);
		// Multi-dot files are skipped by the Convex CLI itself; mirroring them is harmless.
		expect(existsSync(join(stage, 'convex/mail/send.test.ts'))).toBe(true);
		expect(existsSync(join(stage, 'package.json'))).toBe(true);
		expect(existsSync(join(stage, 'convex/__tests__'))).toBe(false);
		expect(existsSync(join(stage, 'convex/mail/__tests__'))).toBe(false);
		expect(existsSync(join(stage, 'scripts'))).toBe(false);
		expect(existsSync(join(stage, '.env.local'))).toBe(false);
	});

	it('copies nothing on a second run, then only what changed', () => {
		const api = apiFixture();
		const stage = join(tempDir(), 'api');
		expect(syncStage(api, stage).copied).toBe(4);
		expect(syncStage(api, stage)).toEqual({ copied: 0, removed: 0 });

		write(api, 'convex/mail/send.ts', 'export const a = 2;');
		const later = new Date(Date.now() + 5_000);
		utimesSync(join(api, 'convex/mail/send.ts'), later, later);
		expect(syncStage(api, stage)).toEqual({ copied: 1, removed: 0 });
		expect(readFileSync(join(stage, 'convex/mail/send.ts'), 'utf8')).toBe('export const a = 2;');
	});

	it('deletes what the source no longer has, but keeps the stage .env.local', () => {
		const api = apiFixture();
		const stage = join(tempDir(), 'api');
		syncStage(api, stage);
		write(stage, '.env.local', 'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:1');
		write(stage, 'convex/__tests__/stale.ts', 'export {};');
		rmSync(join(api, 'convex/mail'), { recursive: true });

		expect(syncStage(api, stage).removed).toBe(3);
		expect(existsSync(join(stage, 'convex/mail'))).toBe(false);
		expect(existsSync(join(stage, 'convex/__tests__'))).toBe(false);
		expect(readFileSync(join(stage, '.env.local'), 'utf8')).toContain('127.0.0.1:1');
	});

	it('refuses a directory that is not apps/api', () => {
		expect(() => syncStage(tempDir(), join(tempDir(), 'api'))).toThrow(/package.json/);
	});
});

describe('secrets', () => {
	it('generates each secret once and keeps it, owner-only', () => {
		const file = join(tempDir(), '.owlat-dev', 'secrets.json');
		let calls = 0;
		const random = (bytes: number) => Buffer.alloc(bytes, ++calls);
		const first = loadOrCreateSecrets(file, random);
		expect(first.instanceSecret).toMatch(/^[0-9a-f]{64}$/);
		expect(new Set(Object.values(first)).size).toBe(3);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(loadOrCreateSecrets(file, random)).toEqual(first);
		expect(calls).toBe(3);
	});

	it('replaces only an invalid entry', () => {
		const file = join(tempDir(), 'secrets.json');
		const good = 'a'.repeat(64);
		writeFileSync(file, JSON.stringify({ instanceSecret: good, betterAuthSecret: 'short' }));
		const secrets = loadOrCreateSecrets(file);
		expect(secrets.instanceSecret).toBe(good);
		expect(secrets.betterAuthSecret).toMatch(/^[0-9a-f]{64}$/);
	});

	it('refuses a file that is not an object of secrets, and leaves it alone', () => {
		const file = join(tempDir(), 'secrets.json');
		for (const contents of ['null', '42', '"a"', '["' + 'a'.repeat(64) + '"]']) {
			writeFileSync(file, contents);
			expect(() => loadOrCreateSecrets(file)).toThrow('does not hold an object of secrets');
			expect(readFileSync(file, 'utf8')).toBe(contents);
		}
		writeFileSync(file, '{"instanceSecret":');
		expect(() => loadOrCreateSecrets(file)).toThrow('is not valid JSON');
	});

	it('feeds the compose file the derived ports and URLs', () => {
		const config = resolveDevStackConfig({ root: '/w', linkedWorktree: true, explicit: '7' });
		const secrets = { instanceSecret: '1', betterAuthSecret: '2', redisPassword: '3' };
		expect(composeEnvEntries(config, secrets)).toEqual({
			OWLAT_DEV_CONVEX_PORT: '3217',
			OWLAT_DEV_CONVEX_SITE_PORT: '3218',
			OWLAT_DEV_REDIS_PORT: '6386',
			OWLAT_DEV_CONVEX_URL: 'http://127.0.0.1:3217',
			OWLAT_DEV_CONVEX_SITE_URL: 'http://127.0.0.1:3218',
			OWLAT_DEV_INSTANCE_SECRET: '1',
			OWLAT_DEV_REDIS_PASSWORD: '3',
		});
	});
});

describe('resolveConvexTarget', () => {
	it('uses the dev stack for both the CLI and HTTP when it has been set up', () => {
		const root = tempDir();
		const paths = devStackPaths(root);
		write(
			root,
			'.owlat-dev/api/.env.local',
			'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:13210\nCONVEX_SELF_HOSTED_ADMIN_KEY=k|1\nCONVEX_SITE_URL=http://127.0.0.1:13211/\n'
		);
		const target = resolveConvexTarget(root, {
			CONVEX_DEPLOYMENT: 'dev:hosted-123',
			CONVEX_SITE_URL: 'https://hosted.example.com',
			HOME: '/home/dev',
		});
		expect(target.source).toBe('dev-stack');
		expect(target.apiDir).toBe(paths.stageApi);
		expect(target.siteUrl).toBe('http://127.0.0.1:13211');
		expect(target.cliEnv['CONVEX_DEPLOYMENT']).toBeUndefined();
		expect(target.cliEnv['CONVEX_SELF_HOSTED_URL']).toBe('http://127.0.0.1:13210');
		expect(target.cliEnv['CONVEX_SELF_HOSTED_ADMIN_KEY']).toBe('k|1');
		expect(target.cliEnv['HOME']).toBe('/home/dev');
	});

	it('falls back to apps/api without a dev stack', () => {
		const root = tempDir();
		write(root, 'apps/api/.env.local', 'CONVEX_SITE_URL=http://127.0.0.1:4000\n');
		const env = { CONVEX_DEPLOYMENT: 'local:x' };
		const target = resolveConvexTarget(root, env);
		expect(target.source).toBe('apps/api');
		expect(target.apiDir).toBe(join(root, 'apps', 'api'));
		expect(target.siteUrl).toBe('http://127.0.0.1:4000');
		expect(target.cliEnv).toBe(env);
		expect(resolveConvexTarget(root, { CONVEX_SITE_URL: 'http://localhost:9/' }).siteUrl).toBe(
			'http://localhost:9'
		);
		expect(resolveConvexTarget(tempDir(), {}).siteUrl).toBe('http://127.0.0.1:3211');
	});

	it('drops every inherited deployment selection for a self-hosted call', () => {
		const env = selfHostedCliEnv(
			{ CONVEX_DEPLOY_KEY: 'x', CONVEX_DEPLOYMENT: 'y', PATH: '/bin' },
			'http://127.0.0.1:1',
			'key'
		);
		expect(env).toEqual({
			PATH: '/bin',
			CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:1',
			CONVEX_SELF_HOSTED_ADMIN_KEY: 'key',
		});
	});
});
