import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadConfig } from '../config.js';

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
	});

	it('honours overrides', () => {
		stubRequired();
		vi.stubEnv('MAIL_SYNC_PORT', '4000');
		vi.stubEnv('MAIL_SYNC_LISTEN', '127.0.0.1');
		vi.stubEnv('MAIL_SYNC_RECONCILE_MS', '15000');
		vi.stubEnv('MAIL_SYNC_FOLDER_POLL_MS', '90000');
		const cfg = loadConfig();
		expect(cfg.port).toBe(4000);
		expect(cfg.listenAddress).toBe('127.0.0.1');
		expect(cfg.reconcileIntervalMs).toBe(15_000);
		expect(cfg.folderPollIntervalMs).toBe(90_000);
	});

	it.each(['CONVEX_URL', 'CONVEX_ADMIN_KEY', 'MAIL_SYNC_API_KEY'])(
		'throws when %s is missing',
		(missing) => {
			stubRequired();
			vi.stubEnv(missing, '');
			expect(() => loadConfig()).toThrow(new RegExp(missing));
		},
	);
});
