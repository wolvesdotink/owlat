import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression tests for the default-admin-credentials fix: unattended installs
 * used to silently provision the owner account with the publicly-known
 * `devpassword12345`. Now assume-yes generates a strong random password
 * (printed once), and `bootstrap()` refuses placeholder passwords from ANY
 * source — CLI flag, config file, or environment.
 */

vi.mock('@clack/prompts', () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	log: {
		info: vi.fn(),
		success: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		warning: vi.fn(),
		message: vi.fn(),
	},
	isCancel: vi.fn(() => false),
	text: vi.fn(async () => 'prompted@example.test'),
	password: vi.fn(async () => 'correct horse battery staple'),
	spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
}));

// If the placeholder guard ever regresses, bootstrap() would proceed past the
// check and hit the network layer — make that loud instead of silent.
vi.mock('../../lib/backend', () => ({
	loadBackendContext: vi.fn(async () => {
		throw new Error('loadBackendContext must not be reached for a placeholder password');
	}),
	postJson: vi.fn(),
}));

import * as clack from '@clack/prompts';
import { bootstrap, resolveAdminPassword } from '../bootstrap-org';

const opts = {
	web: false,
	terminal: true,
	assumeYes: true,
	owlatDir: '/tmp',
	positional: [] as string[],
	args: [] as string[],
};

describe('bootstrap placeholder-password refusal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		'devpassword12345',
		'  DevPassword12345  ',
		'change-me',
		'replace-with-openssl-rand-base64-32',
	])('refuses placeholder password %s before any network call', async (password) => {
		const code = await bootstrap({ email: 'a@b.test', name: 'A', password }, opts);
		expect(code).toBe(1);
		expect(clack.log.error).toHaveBeenCalled();
	});

	it('accepts a strong password (guard is placeholder-only)', async () => {
		// loadBackendContext throws, but only AFTER the guard passed — the error
		// propagates as a rejected promise rather than a clean exit 1 with the
		// placeholder message. Distinguish via the error message.
		await expect(
			bootstrap({ email: 'a@b.test', name: 'A', password: 'correct horse battery staple' }, opts)
		).rejects.toThrow(/loadBackendContext/);
	});
});

describe('resolveAdminPassword', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('generates a strong random password in assume-yes mode and prints it once', async () => {
		const first = await resolveAdminPassword(true);
		const second = await resolveAdminPassword(true);

		expect(first).toMatch(/^[A-Za-z0-9]{20,}$/);
		expect(second).toMatch(/^[A-Za-z0-9]{20,}$/);
		expect(first).not.toBe(second);
		expect(clack.log.warning).toHaveBeenCalledTimes(2);
	});

	it('prompts interactively when assume-yes is off', async () => {
		const password = await resolveAdminPassword(false);
		expect(password).toBe('correct horse battery staple');
		expect(clack.password).toHaveBeenCalledTimes(1);
	});
});
