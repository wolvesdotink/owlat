import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	ENV_BACKUP_SEALED_PREFIX,
	createEnvBackupBox,
	isEnvBackupSealedValue,
} from '@owlat/shared/envBackupBox';

/**
 * Secrets-at-rest tests for `POST /api/delivery/apply-transport`: the `.env`
 * BACKUP copy must receive the SEALED relay password (an `envsealed:v1:…`
 * token under INSTANCE_SECRET) while the LIVE deployment env push carries the
 * working plaintext — sealing the backup must never change what the send path
 * reads. The h3/Nuxt request helpers are stubbed and the shared env/push
 * modules mocked so the route's own control flow is exercised in isolation.
 */

const { pushMock, readMock, writeMock, requireOrgAdminMock } = vi.hoisted(() => ({
	pushMock: vi.fn(),
	readMock: vi.fn(),
	writeMock: vi.fn(),
	requireOrgAdminMock: vi.fn(),
}));

vi.mock('~~/server/utils/requireOrgAdmin', () => ({
	requireOrgAdmin: requireOrgAdminMock,
}));
vi.mock('@owlat/shared/setupEnv', () => ({
	readEnvFile: readMock,
	writeEnvFile: writeMock,
}));
vi.mock('@owlat/shared/convexRuntimeEnv', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@owlat/shared/convexRuntimeEnv')>();
	return { ...actual, pushConvexRuntimeEnv: pushMock };
});

const INSTANCE_SECRET = 'e'.repeat(64);
const PLAINTEXT_PASSWORD = 'hunter2-relay-password';

let body: unknown;

interface ApplyResult {
	ok: boolean;
	message: string;
	applied: boolean;
	requiresRestart: boolean;
}

async function callRoute(): Promise<ApplyResult> {
	const mod = await import('../apply-transport.post');
	const handler = mod.default as unknown as (event: unknown) => Promise<ApplyResult>;
	return handler({});
}

function smtpPatch(): Record<string, string> {
	return {
		EMAIL_PROVIDER: 'smtp',
		SMTP_RELAY_HOST: 'smtp.example.com',
		SMTP_RELAY_PORT: '587',
		SMTP_RELAY_SECURE: 'false',
		SMTP_RELAY_USERNAME: 'postmaster@example.com',
		SMTP_RELAY_PASSWORD: PLAINTEXT_PASSWORD,
	};
}

beforeEach(() => {
	pushMock.mockReset().mockResolvedValue(undefined);
	writeMock.mockReset().mockResolvedValue(undefined);
	readMock.mockReset();
	requireOrgAdminMock.mockReset().mockResolvedValue(undefined);
	body = { providerEnv: smtpPatch() };

	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal(
		'readBody',
		vi.fn(async () => body)
	);
	vi.stubGlobal('createError', (opts: { statusCode: number; message: string }) =>
		Object.assign(new Error(opts.message), { statusCode: opts.statusCode })
	);
});

function writtenEnv(): Record<string, string> {
	expect(writeMock).toHaveBeenCalledTimes(1);
	return writeMock.mock.calls[0]![1] as Record<string, string>;
}

describe('apply-transport secrets at rest', () => {
	it('pushes the PLAINTEXT relay password live but writes the SEALED form to the .env backup', async () => {
		readMock.mockResolvedValue({
			CONVEX_ADMIN_KEY: 'convex-self-hosted|deadbeef',
			CONVEX_SITE_URL: 'http://convex:3211',
			INSTANCE_SECRET,
		});

		const res = await callRoute();
		expect(res.ok).toBe(true);
		expect(res.applied).toBe(true);

		// Live env store: the working plaintext credential, on the admin URL.
		expect(pushMock).toHaveBeenCalledTimes(1);
		const [adminUrl, adminKey, changes] = pushMock.mock.calls[0]! as [
			string,
			string,
			Array<[string, string]>,
		];
		expect(adminUrl).toBe('http://convex:3210');
		expect(adminKey).toBe('convex-self-hosted|deadbeef');
		const liveMap = Object.fromEntries(changes);
		expect(liveMap['SMTP_RELAY_PASSWORD']).toBe(PLAINTEXT_PASSWORD);
		expect(liveMap['EMAIL_PROVIDER']).toBe('smtp');

		// Live push happens BEFORE the backup write (a failed push leaves .env untouched).
		expect(pushMock.mock.invocationCallOrder[0]!).toBeLessThan(
			writeMock.mock.invocationCallOrder[0]!
		);

		// .env backup: sealed token, no plaintext anywhere in the written map.
		const envMap = writtenEnv();
		const stored = envMap['SMTP_RELAY_PASSWORD']!;
		expect(stored.startsWith(ENV_BACKUP_SEALED_PREFIX)).toBe(true);
		expect(isEnvBackupSealedValue(stored)).toBe(true);
		expect(JSON.stringify(envMap)).not.toContain(PLAINTEXT_PASSWORD);
		// The sealed token round-trips back to the exact password under INSTANCE_SECRET.
		expect(createEnvBackupBox(INSTANCE_SECRET).open(stored)).toBe(PLAINTEXT_PASSWORD);
		// Non-secret transport keys stay readable plaintext in the backup.
		expect(envMap['SMTP_RELAY_HOST']).toBe('smtp.example.com');
		expect(envMap['SMTP_RELAY_USERNAME']).toBe('postmaster@example.com');
	});

	it('seals the backup on the no-admin-key (restart-required) path too, without a live push', async () => {
		readMock.mockResolvedValue({ INSTANCE_SECRET });

		const res = await callRoute();
		expect(res.ok).toBe(true);
		expect(res.applied).toBe(false);
		expect(res.requiresRestart).toBe(true);
		expect(pushMock).not.toHaveBeenCalled();

		const envMap = writtenEnv();
		const stored = envMap['SMTP_RELAY_PASSWORD']!;
		expect(isEnvBackupSealedValue(stored)).toBe(true);
		expect(JSON.stringify(envMap)).not.toContain(PLAINTEXT_PASSWORD);
		expect(createEnvBackupBox(INSTANCE_SECRET).open(stored)).toBe(PLAINTEXT_PASSWORD);
	});

	it('keeps the documented plaintext fallback when the .env has no INSTANCE_SECRET to seal under', async () => {
		readMock.mockResolvedValue({
			CONVEX_ADMIN_KEY: 'convex-self-hosted|deadbeef',
			CONVEX_SITE_URL: 'http://convex:3211',
		});

		const res = await callRoute();
		expect(res.ok).toBe(true);

		// A token sealed under a missing key could never be unsealed — the route
		// deliberately falls back to today's plaintext write in that degenerate case.
		const envMap = writtenEnv();
		expect(envMap['SMTP_RELAY_PASSWORD']).toBe(PLAINTEXT_PASSWORD);
	});

	it('does not write the .env backup when the live push fails (retryable, no half-applied state)', async () => {
		readMock.mockResolvedValue({
			CONVEX_ADMIN_KEY: 'convex-self-hosted|deadbeef',
			CONVEX_SITE_URL: 'http://convex:3211',
			INSTANCE_SECRET,
		});
		pushMock.mockRejectedValue(new Error('admin API unreachable'));

		const res = await callRoute();
		expect(res.ok).toBe(false);
		expect(res.applied).toBe(false);
		expect(writeMock).not.toHaveBeenCalled();
	});
});
