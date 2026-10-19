import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadConfig, MailSyncConfigError } from '../config.js';

const REQUIRED = {
	CONVEX_URL: 'https://example.convex.cloud',
	CONVEX_ADMIN_KEY: 'admin-key',
	MAIL_SYNC_API_KEY: 'api-key',
};

function stubRequired() {
	for (const [k, v] of Object.entries(REQUIRED)) vi.stubEnv(k, v);
}

describe('loadConfig', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('loads with all required vars and applies defaults', () => {
		stubRequired();
		const cfg = loadConfig();
		expect(cfg.convexUrl).toBe(REQUIRED.CONVEX_URL);
		expect(cfg.convexAdminKey).toBe(REQUIRED.CONVEX_ADMIN_KEY);
		expect(cfg.apiKey).toBe(REQUIRED.MAIL_SYNC_API_KEY);
		// Defaults
		expect(cfg.port).toBe(3200);
		expect(cfg.listenAddress).toBe('0.0.0.0');
		expect(cfg.reconcileIntervalMs).toBe(30_000);
		expect(cfg.folderPollIntervalMs).toBe(5 * 60 * 1000);
		expect(cfg.inboxPollIntervalMs).toBe(60_000);
	});

	it('honours overrides', () => {
		stubRequired();
		vi.stubEnv('MAIL_SYNC_PORT', '4000');
		vi.stubEnv('MAIL_SYNC_LISTEN', '127.0.0.1');
		vi.stubEnv('MAIL_SYNC_RECONCILE_MS', '15000');
		vi.stubEnv('MAIL_SYNC_FOLDER_POLL_MS', '90000');
		vi.stubEnv('MAIL_SYNC_INBOX_POLL_MS', '30000');
		const cfg = loadConfig();
		expect(cfg.port).toBe(4000);
		expect(cfg.listenAddress).toBe('127.0.0.1');
		expect(cfg.reconcileIntervalMs).toBe(15_000);
		expect(cfg.folderPollIntervalMs).toBe(90_000);
		expect(cfg.inboxPollIntervalMs).toBe(30_000);
	});

	it('treats a blank numeric value as unset', () => {
		stubRequired();
		vi.stubEnv('MAIL_SYNC_PORT', '');
		vi.stubEnv('MAIL_SYNC_BACKFILL_BATCH', '  ');
		const cfg = loadConfig();
		expect(cfg.port).toBe(3200);
		expect(cfg.backfillBatchSize).toBe(200);
	});

	it.each([
		['MAIL_SYNC_PORT', '3200abc', 'MAIL_SYNC_PORT must be an integer between 1 and 65535'],
		['MAIL_SYNC_PORT', '0', 'MAIL_SYNC_PORT must be an integer between 1 and 65535'],
		['MAIL_SYNC_RECONCILE_MS', '3e4', 'MAIL_SYNC_RECONCILE_MS must be an integer between 1 and'],
		['MAIL_SYNC_FOLDER_POLL_MS', '0', 'MAIL_SYNC_FOLDER_POLL_MS must be an integer between 1'],
		['MAIL_SYNC_BACKFILL_BATCH', '-5', 'MAIL_SYNC_BACKFILL_BATCH must be an integer of at least 1'],
	])('refuses to boot on %s=%j', (key, value, message) => {
		stubRequired();
		vi.stubEnv(key, value);
		expect(() => loadConfig()).toThrow(message);
	});

	it.each(['CONVEX_URL', 'CONVEX_ADMIN_KEY', 'MAIL_SYNC_API_KEY'])(
		'throws when %s is missing',
		(missing) => {
			stubRequired();
			vi.stubEnv(missing, '');
			expect(() => loadConfig()).toThrow(new RegExp(missing));
		}
	);

	it('reports every invalid key together, without secret values', () => {
		stubRequired();
		vi.stubEnv('CONVEX_URL', 'https://deploy:url-secret@');
		vi.stubEnv('MAIL_SYNC_API_KEY', '');
		vi.stubEnv('MAIL_SYNC_PORT', '0');
		vi.stubEnv('MAIL_SYNC_FETCH_ORIGINS', 'https://ok.example.com, not a url');
		let caught: unknown;
		try {
			loadConfig();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(MailSyncConfigError);
		const error = caught as MailSyncConfigError;
		expect(error.issues.map((issue) => issue.key)).toEqual([
			'MAIL_SYNC_API_KEY',
			'CONVEX_URL',
			'MAIL_SYNC_FETCH_ORIGINS',
			'MAIL_SYNC_PORT',
		]);
		expect(error.message).toContain('4 problems');
		expect(error.message).toContain('MAIL_SYNC_API_KEY is required');
		expect(error.message).toContain('CONVEX_URL must be an absolute http(s) URL');
		expect(error.message).toContain('MAIL_SYNC_FETCH_ORIGINS entry 2 must be');
		expect(error.message).toContain('MAIL_SYNC_PORT must be an integer between 1 and 65535');
		const printed = `${error.message}\n${JSON.stringify(error)}`;
		for (const secret of [REQUIRED.CONVEX_ADMIN_KEY, 'url-secret', 'deploy', 'not a url']) {
			expect(printed).not.toContain(secret);
		}
	});

	it('reports three missing secrets in one error', () => {
		for (const key of Object.keys(REQUIRED)) vi.stubEnv(key, '');
		expect(() => loadConfig()).toThrow(
			'Invalid mail-sync configuration (3 problems):\n' +
				'  - CONVEX_URL is required\n' +
				'  - CONVEX_ADMIN_KEY is required\n' +
				'  - MAIL_SYNC_API_KEY is required'
		);
	});

	it.each([
		[
			'https://user:sentinel@example.convex.site',
			'CONVEX_URL must be the deployment API address (*.convex.cloud)',
		],
		[
			'HTTPS://user:sentinel@convex.example.com',
			'CONVEX_URL is not a deployment address the Convex client accepts',
		],
	])('collects the Convex client rejecting CONVEX_URL=%j with the other issues', (url, message) => {
		stubRequired();
		vi.stubEnv('CONVEX_URL', url);
		vi.stubEnv('MAIL_SYNC_PORT', '0');
		let caught: unknown;
		try {
			loadConfig();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(MailSyncConfigError);
		const error = caught as MailSyncConfigError;
		expect(error.issues.map((issue) => issue.key)).toEqual(['CONVEX_URL', 'MAIL_SYNC_PORT']);
		expect(error.message).toContain(message);
		expect(`${error.message}\n${JSON.stringify(error)}`).not.toContain('sentinel');
	});

	it.each([
		['CONVEX_URL', 'convex.example.com'],
		['CONVEX_URL', 'ftp://convex.example.com'],
		['CONVEX_SITE_URL', '/http'],
	])('refuses %s=%j that is not an absolute http(s) URL', (key, value) => {
		stubRequired();
		vi.stubEnv(key, value);
		expect(() => loadConfig()).toThrow(`${key} must be an absolute http(s) URL`);
	});

	it('allows fetches from the CONVEX_URL origin plus MAIL_SYNC_FETCH_ORIGINS', () => {
		stubRequired();
		vi.stubEnv(
			'MAIL_SYNC_FETCH_ORIGINS',
			' https://public.example.com/storage , ,http://10.example.com:3210/x'
		);
		expect(loadConfig().allowedFetchOrigins).toEqual([
			'https://example.convex.cloud',
			'https://public.example.com',
			'http://10.example.com:3210',
		]);
	});
});
