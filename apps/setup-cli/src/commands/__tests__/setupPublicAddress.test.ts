import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The terminal wizard's public-address step, driven through mocked clack
 * prompts against a temp install directory. It has to produce the same `.env`
 * keys and Caddyfile as the config file's `network` section for the same names,
 * keep an install that gives no domain on localhost, and write nothing at all
 * when the names do not reach this server.
 */

const CANCEL = Symbol('cancel');

const driver = vi.hoisted(() => ({
	text: [] as unknown[],
	select: [] as unknown[],
	confirm: [] as unknown[],
	messages: [] as string[],
}));

vi.mock('@clack/prompts', () => {
	const next = (queue: unknown[], message: string) => {
		driver.messages.push(message);
		if (queue.length === 0) throw new Error(`unexpected prompt: ${message}`);
		return queue.shift();
	};
	return {
		text: async (o: { message: string }) => next(driver.text, o.message),
		select: async (o: { message: string }) => next(driver.select, o.message),
		confirm: async (o: { message: string }) => next(driver.confirm, o.message),
		isCancel: (value: unknown) => value === CANCEL,
		outro: vi.fn(),
		log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn() },
		spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
	};
});

import { runPublicAddressOnly } from '../setupPublicAddress';
import type { HostCheckDeps } from '../../lib/publicHostCheck';
import { buildSetupFromConfig, parseSetupConfig } from '../../lib/setupConfig';
import { caddyfileForNetwork, networkFromDomain } from '../../lib/publicAddress';
import { readEnv, writeEnv } from '../../lib/env';

/** DNS and ports as they would be on a server the names point at. */
function reachableDeps(): HostCheckDeps {
	let token = '';
	return {
		resolve: async () => ['203.0.113.10'],
		listen: async (_port, t) => {
			token = t;
			return { close: async () => {} };
		},
		connect: async () => token,
		token: () => 'token',
	};
}

const PUBLIC_URL_KEYS = [
	'SITE_URL',
	'NUXT_PUBLIC_SITE_URL',
	'NUXT_PUBLIC_CONVEX_URL',
	'NUXT_PUBLIC_CONVEX_SITE_URL',
	'CONVEX_SITE_URL',
	'RATE_LIMIT_TRUSTED_PROXY',
];

const LOCAL_ENV = {
	INSTANCE_SECRET: 'already-installed',
	SITE_URL: 'http://localhost:3000',
	NUXT_PUBLIC_SITE_URL: 'http://localhost:3000',
	NUXT_PUBLIC_CONVEX_URL: 'http://localhost:3210',
	NUXT_PUBLIC_CONVEX_SITE_URL: 'http://localhost:3211',
	CONVEX_SITE_URL: 'http://localhost:3211',
	COMPOSE_PROFILES: 'mta',
};

let dir: string;
let paths: { owlatDir: string; envPath: string; overridePath: string };

beforeEach(async () => {
	driver.text = [];
	driver.select = [];
	driver.confirm = [];
	driver.messages = [];
	dir = await mkdtemp(join(tmpdir(), 'owlat-public-address-'));
	paths = {
		owlatDir: dir,
		envPath: join(dir, '.env'),
		overridePath: join(dir, 'docker-compose.override.yml'),
	};
	await writeEnv(paths.envPath, LOCAL_ENV);
	await writeFile(paths.overridePath, 'services: {}\n');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('the public-address step of a re-run', () => {
	it('writes the same public URLs and Caddyfile as a config file naming the same hosts', async () => {
		driver.text = ['example.com', 'ops@example.com'];
		expect(await runPublicAddressOnly({ ...paths, deps: reachableDeps() })).toBe(0);

		const network = networkFromDomain('example.com');
		const fromConfig = buildSetupFromConfig(
			parseSetupConfig({
				version: 1,
				deploymentMode: 'selfhost',
				features: {},
				sending: { provider: 'mta' },
				admin: { email: 'ops@example.com', name: 'Ops', password: 'a-long-enough-password' },
				network,
			}),
			{}
		).env;
		const written = await readEnv(paths.envPath);
		for (const key of PUBLIC_URL_KEYS) expect(written[key], key).toBe(fromConfig[key]);
		expect(written['SITE_URL']).toBe('https://owlat.example.com');
		expect(written['COMPOSE_PROFILES']?.split(',').sort()).toEqual(['mta', 'tls']);
		expect(await readFile(paths.overridePath, 'utf-8')).toContain('- tls');
		// quickstart writes the config path's Caddyfile with caddyfileForNetwork too.
		expect(await readFile(join(dir, 'Caddyfile'), 'utf-8')).toBe(
			caddyfileForNetwork(network, 'ops@example.com')
		);
	});

	it('leaves a localhost install as it is when no domain is given', async () => {
		driver.text = [''];
		expect(await runPublicAddressOnly({ ...paths, deps: reachableDeps() })).toBe(0);
		expect(await readEnv(paths.envPath)).toEqual(LOCAL_ENV);
		expect(existsSync(join(dir, 'Caddyfile'))).toBe(false);
	});

	it('writes nothing when a name does not resolve, and names the record to create', async () => {
		const before = await readFile(paths.envPath, 'utf-8');
		const deps: HostCheckDeps = { ...reachableDeps(), resolve: async () => [] };
		driver.text = ['example.com', 'ops@example.com'];
		driver.select = ['cancel'];
		const { log } = await import('@clack/prompts');

		expect(await runPublicAddressOnly({ ...paths, deps })).toBe(1);

		expect(vi.mocked(log.error).mock.calls.at(-1)?.[0]).toContain(
			'owlat.example.com does not resolve. Create an A record'
		);
		expect(await readFile(paths.envPath, 'utf-8')).toBe(before);
		expect(await readFile(paths.overridePath, 'utf-8')).toBe('services: {}\n');
		expect(existsSync(join(dir, 'Caddyfile'))).toBe(false);
	});

	it('checks again after a failed check and writes once the names resolve', async () => {
		// The first check (three names) finds no records; the second finds them.
		let lookups = 0;
		const deps: HostCheckDeps = {
			...reachableDeps(),
			resolve: async () => (lookups++ < 3 ? [] : ['203.0.113.10']),
		};
		driver.text = ['example.com', 'ops@example.com', 'example.com', 'ops@example.com'];
		driver.select = ['retry'];
		expect(await runPublicAddressOnly({ ...paths, deps })).toBe(0);
		expect(driver.messages.filter((m) => m === 'What now?')).toHaveLength(1);
		expect((await readEnv(paths.envPath))['SITE_URL']).toBe('https://owlat.example.com');
	});

	it('keeps the address Caddy already serves without testing its ports again', async () => {
		driver.text = ['example.com', 'ops@example.com'];
		await runPublicAddressOnly({ ...paths, deps: reachableDeps() });
		const before = await readEnv(paths.envPath);

		const portsTaken: HostCheckDeps = { ...reachableDeps(), listen: async () => 'EADDRINUSE' };
		driver.text = ['example.com', 'ops@example.com'];
		expect(await runPublicAddressOnly({ ...paths, deps: portsTaken })).toBe(0);
		expect(driver.messages).not.toContain('What now?');
		expect(await readEnv(paths.envPath)).toEqual(before);
	});

	it('tests the ports again when a config-file install with other Convex names is moved onto the convention', async () => {
		await writeEnv(paths.envPath, {
			...LOCAL_ENV,
			SITE_URL: 'https://owlat.example.com',
			NUXT_PUBLIC_CONVEX_URL: 'https://convex.example.com',
			NUXT_PUBLIC_CONVEX_SITE_URL: 'https://convex-site.example.com',
			COMPOSE_PROFILES: 'mta,tls',
		});
		const before = await readEnv(paths.envPath);
		const portsTaken: HostCheckDeps = { ...reachableDeps(), listen: async () => 'EADDRINUSE' };
		driver.text = ['example.com', 'ops@example.com'];
		driver.select = ['cancel'];

		expect(await runPublicAddressOnly({ ...paths, deps: portsTaken })).toBe(1);
		expect(await readEnv(paths.envPath)).toEqual(before);
	});

	it('goes back to localhost, dropping the edge, when the domain is cleared', async () => {
		driver.text = ['example.com', 'ops@example.com'];
		await runPublicAddressOnly({ ...paths, deps: reachableDeps() });

		driver.text = [''];
		driver.confirm = [true];
		expect(await runPublicAddressOnly({ ...paths, deps: reachableDeps() })).toBe(0);

		const env = await readEnv(paths.envPath);
		expect(env['SITE_URL']).toBe('http://localhost:3000');
		expect(env['NUXT_PUBLIC_CONVEX_URL']).toBe('http://localhost:3210');
		expect(env['COMPOSE_PROFILES']).toBe('mta');
		expect(env['RATE_LIMIT_TRUSTED_PROXY']).toBeUndefined();
		expect(await readFile(paths.overridePath, 'utf-8')).not.toContain('tls');
	});
});
