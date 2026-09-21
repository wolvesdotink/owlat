import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ENV_BACKUP_SEALED_PREFIX,
	createEnvBackupBox,
	isEnvBackupSealedValue,
} from '@owlat/shared/envBackupBox';
import { getDefaultFlags } from '@owlat/shared/featureFlags';

/**
 * Secrets-at-rest test for `POST /api/setup/apply` (the web setup wizard's final
 * step). When the operator configures an SMTP relay during first install, the
 * `.env` BACKUP must receive the relay password SEALED (an `envsealed:v1:…`
 * token under INSTANCE_SECRET) while the LIVE deployment env push carries the
 * working plaintext — sealing the backup must never change what the send path
 * reads. The Nuxt/h3 auto-imports are stubbed and the shared env/push modules
 * mocked so the route's own control flow is exercised in isolation.
 */

const { pushMock, readMock, writeMock, identityPreflightMock } = vi.hoisted(() => ({
	pushMock: vi.fn(),
	readMock: vi.fn(),
	writeMock: vi.fn(),
	identityPreflightMock: vi.fn(),
}));

vi.mock('@owlat/shared/setupEnv', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@owlat/shared/setupEnv')>();
	return { ...actual, readEnvFile: readMock, writeEnvFile: writeMock };
});
vi.mock('@owlat/shared/convexRuntimeEnv', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@owlat/shared/convexRuntimeEnv')>();
	return { ...actual, pushConvexRuntimeEnv: pushMock };
});
vi.mock('../../../utils/mtaIdentityPreflight', () => ({
	preflightMtaIdentities: identityPreflightMock,
}));

const INSTANCE_SECRET = 'e'.repeat(64);
const PLAINTEXT_PASSWORD = 'hunter2-relay-password';

// OWLAT_DIR is captured once at module load (a top-level const in the route), so
// set it BEFORE the first dynamic import and keep it stable across tests. The
// wizard's override/flag-state files are written here for real (writeEnvFile is
// mocked); each run overwrites them.
const DIR = mkdtempSync(join(tmpdir(), 'owlat-apply-'));
process.env['OWLAT_DIR'] = DIR;

let body: unknown;
let fetchStatus: number;

interface ApplyResult {
	ok: boolean;
	message?: string;
	redirectTo?: string;
}

async function callRoute(): Promise<ApplyResult> {
	const mod = await import('../apply.post');
	const handler = mod.default as unknown as (event: unknown) => Promise<ApplyResult>;
	return handler({});
}

function writtenEnv(): Record<string, string> {
	expect(writeMock).toHaveBeenCalledTimes(1);
	return writeMock.mock.calls[0]![1] as Record<string, string>;
}

beforeEach(() => {
	process.env['OWLAT_SETUP_MODE'] = 'true';

	pushMock.mockReset().mockResolvedValue(undefined);
	writeMock.mockReset().mockResolvedValue(undefined);
	identityPreflightMock.mockReset().mockResolvedValue({
		ok: true,
		message: 'Every outbound IP passed.',
		identities: [],
	});
	// A configured install already carries the generated secrets + admin key.
	readMock.mockReset().mockResolvedValue({
		INSTANCE_SECRET,
		CONVEX_ADMIN_KEY: 'convex-self-hosted|deadbeef',
		CONVEX_SITE_URL: 'http://convex:3211',
	});

	fetchStatus = 201;
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({
			status: fetchStatus,
			json: async () => ({}),
		}))
	);
	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal('requireSetupToken', vi.fn());
	vi.stubGlobal(
		'readBody',
		vi.fn(async () => body)
	);
	vi.stubGlobal('createError', (opts: { statusCode: number; message: string }) =>
		Object.assign(new Error(opts.message), { statusCode: opts.statusCode })
	);

	body = {
		flags: getDefaultFlags({ hosted: false }),
		env: { EMAIL_PROVIDER: 'smtp', SMTP_RELAY_PASSWORD: PLAINTEXT_PASSWORD },
		admin: { email: 'admin@example.com', name: 'Admin', password: 'longenoughpw!' },
	};
});

afterAll(() => {
	rmSync(DIR, { recursive: true, force: true });
	delete process.env['OWLAT_DIR'];
	delete process.env['OWLAT_SETUP_MODE'];
	vi.unstubAllGlobals();
});

describe('POST /api/setup/apply — relay password at rest', () => {
	it('pushes the PLAINTEXT relay password live but writes the SEALED form to the .env backup', async () => {
		const res = await callRoute();
		expect(res.ok).toBe(true);

		// Live env store received the working plaintext credential.
		expect(pushMock).toHaveBeenCalledTimes(1);
		const changes = pushMock.mock.calls[0]![2] as Array<[string, string]>;
		const liveMap = Object.fromEntries(changes);
		expect(liveMap['SMTP_RELAY_PASSWORD']).toBe(PLAINTEXT_PASSWORD);

		// .env backup: sealed token, no plaintext anywhere in the written map.
		const env = writtenEnv();
		const stored = env['SMTP_RELAY_PASSWORD']!;
		expect(stored.startsWith(ENV_BACKUP_SEALED_PREFIX)).toBe(true);
		expect(isEnvBackupSealedValue(stored)).toBe(true);
		expect(JSON.stringify(env)).not.toContain(PLAINTEXT_PASSWORD);
		// The sealed token round-trips back to the exact password under INSTANCE_SECRET.
		expect(createEnvBackupBox(INSTANCE_SECRET).open(stored)).toBe(PLAINTEXT_PASSWORD);
	});

	it('live push happens BEFORE the .env backup write (a failed push leaves .env untouched)', async () => {
		await callRoute();
		expect(pushMock.mock.invocationCallOrder[0]!).toBeLessThan(
			writeMock.mock.invocationCallOrder[0]!
		);
	});
});

describe('POST /api/setup/apply — env value hygiene', () => {
	it('refuses a newline in an env value before seeding or writing (env injection)', async () => {
		body = {
			flags: getDefaultFlags({ hosted: false }),
			// A newline in the operator-supplied From name would inject an arbitrary
			// extra `.env` line (here a forged INSTANCE_SECRET) through the line-oriented
			// writer.
			env: {
				EMAIL_PROVIDER: 'smtp',
				SMTP_RELAY_PASSWORD: PLAINTEXT_PASSWORD,
				DEFAULT_FROM_NAME: 'Acme\nINSTANCE_SECRET=attacker-owned',
			},
			admin: { email: 'admin@example.com', name: 'Admin', password: 'longenoughpw!' },
		};

		const result = await callRoute();
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/control characters/);
		expect(fetch).not.toHaveBeenCalled();
		expect(pushMock).not.toHaveBeenCalled();
		expect(writeMock).not.toHaveBeenCalled();
	});
});

describe('POST /api/setup/apply — MTA identity gate', () => {
	it('refuses the happy path before seeding or writing when live FCrDNS fails', async () => {
		body = {
			flags: getDefaultFlags({ hosted: false }),
			env: { EMAIL_PROVIDER: 'mta' },
			admin: { email: 'admin@example.com', name: 'Admin', password: 'longenoughpw!' },
		};
		identityPreflightMock.mockResolvedValue({
			ok: false,
			message: 'Set its PTR exactly to mail.example.com. In Hetzner Console…',
			identities: [],
		});

		const result = await callRoute();
		expect(result).toEqual({
			ok: false,
			message: 'Set its PTR exactly to mail.example.com. In Hetzner Console…',
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(pushMock).not.toHaveBeenCalled();
		expect(writeMock).not.toHaveBeenCalled();
	});

	it('runs the identity gate when inbox enables MTA but delivery uses an SMTP relay', async () => {
		body = {
			flags: { ...getDefaultFlags({ hosted: false }), inbox: true },
			env: { EMAIL_PROVIDER: 'smtp', SMTP_RELAY_PASSWORD: PLAINTEXT_PASSWORD },
			admin: { email: 'admin@example.com', name: 'Admin', password: 'longenoughpw!' },
		};
		identityPreflightMock.mockResolvedValue({
			ok: false,
			message: 'Outbound identity is not ready.',
			identities: [],
		});

		const result = await callRoute();
		expect(result).toEqual({ ok: false, message: 'Outbound identity is not ready.' });
		expect(identityPreflightMock).toHaveBeenCalledTimes(1);
		expect(fetch).not.toHaveBeenCalled();
		expect(writeMock).not.toHaveBeenCalled();
	});
});

describe('POST /api/setup/apply — email-verification provider coupling (H3)', () => {
	// Flags with every bulk-sending feature off, so the ONLY thing that can demand a
	// delivery provider is REQUIRE_EMAIL_VERIFICATION — isolates the new coupling
	// from the pre-existing "bulk sending needs a provider" floor.
	const noBulkFlags = () => ({
		...getDefaultFlags({ hosted: false }),
		campaigns: false,
		transactional: false,
		automations: false,
	});

	it('refuses to finish setup when verification is on but no delivery provider is configured', async () => {
		body = {
			flags: noBulkFlags(),
			// Verification on, but EMAIL_PROVIDER absent — the verification link could
			// never be delivered, so every new signup/invitee would be locked out.
			env: { REQUIRE_EMAIL_VERIFICATION: 'true' },
			admin: { email: 'admin@example.com', name: 'Admin', password: 'longenoughpw!' },
		};

		const result = await callRoute();
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/verification/i);
		expect(result.message).toMatch(/locked out|provider/i);
		// Fails before seeding the admin, pushing runtime env, or writing .env.
		expect(fetch).not.toHaveBeenCalled();
		expect(pushMock).not.toHaveBeenCalled();
		expect(writeMock).not.toHaveBeenCalled();
	});

	it('allows setup when verification is on AND a real delivery provider is configured', async () => {
		body = {
			flags: noBulkFlags(),
			env: {
				REQUIRE_EMAIL_VERIFICATION: 'true',
				EMAIL_PROVIDER: 'smtp',
				SMTP_RELAY_PASSWORD: PLAINTEXT_PASSWORD,
			},
			admin: { email: 'admin@example.com', name: 'Admin', password: 'longenoughpw!' },
		};

		const result = await callRoute();
		expect(result.ok).toBe(true);
		expect(writeMock).toHaveBeenCalledTimes(1);
	});

	it('ignores a non-truthy REQUIRE_EMAIL_VERIFICATION value (no provider required)', async () => {
		body = {
			flags: noBulkFlags(),
			env: { REQUIRE_EMAIL_VERIFICATION: 'false' },
			admin: { email: 'admin@example.com', name: 'Admin', password: 'longenoughpw!' },
		};

		const result = await callRoute();
		expect(result.ok).toBe(true);
	});
});

/**
 * The gate itself, not its mock: without the setup token the shipped
 * `requireSetupToken` refuses the call before an admin is created or .env is
 * touched, even with setup mode on and a token configured.
 */
describe('POST /api/setup/apply — the real setup-token gate', () => {
	it('rejects a call without the setup token before creating the admin', async () => {
		const { requireSetupToken } = await import('../../../utils/setupToken');
		vi.stubGlobal('requireSetupToken', requireSetupToken);
		vi.stubGlobal('getHeader', () => undefined);
		process.env['OWLAT_SETUP_TOKEN'] = 'stk_configured-by-owlat-setup';
		try {
			await expect(callRoute()).rejects.toMatchObject({ statusCode: 401 });
		} finally {
			delete process.env['OWLAT_SETUP_TOKEN'];
		}

		expect(fetch).not.toHaveBeenCalled();
		expect(pushMock).not.toHaveBeenCalled();
		expect(writeMock).not.toHaveBeenCalled();
	});
});
