import { describe, it, expect, vi } from 'vitest';
import {
	CONVEX_RUNTIME_ENV_KEYS,
	selectRuntimeEnvVars,
	deriveConvexAdminUrl,
	pushConvexRuntimeEnv,
} from '../convexRuntimeEnv';
import { ENV_BACKUP_SEALED_PREFIX, createEnvBackupBox } from '../envBackupBox';

describe('selectRuntimeEnvVars', () => {
	it('picks only populated runtime keys, skipping empty/undefined and compose-only vars', () => {
		const env = {
			EMAIL_PROVIDER: 'resend',
			RESEND_API_KEY: 're_live_123',
			AWS_SES_REGION: '', // empty → skipped
			// not a runtime key → skipped even though set
			NUXT_PUBLIC_CONVEX_URL: 'http://localhost:3210',
			CONVEX_ADMIN_KEY: 'convex-self-hosted|deadbeef',
			REDIS_PASSWORD: 'hunter2',
		};
		const out = Object.fromEntries(selectRuntimeEnvVars(env));
		expect(out['EMAIL_PROVIDER']).toBe('resend');
		expect(out['RESEND_API_KEY']).toBe('re_live_123');
		expect(out).not.toHaveProperty('AWS_SES_REGION');
		expect(out).not.toHaveProperty('NUXT_PUBLIC_CONVEX_URL');
		expect(out).not.toHaveProperty('CONVEX_ADMIN_KEY');
		expect(out).not.toHaveProperty('REDIS_PASSWORD');
	});

	// The deploy-time RESEED contract for secrets sealed at rest in the .env
	// backup copy: sealed tokens are unsealed before the env push, plain values
	// pass through untouched (legacy .env), and an unopenable token FAILS CLOSED
	// so ciphertext is never deployed as a live credential.
	describe('sealed .env backup values (reseed step)', () => {
		const INSTANCE_SECRET = 'c'.repeat(64);

		it('unseals a sealed relay password before the env push (live store gets working plaintext)', () => {
			const sealed = createEnvBackupBox(INSTANCE_SECRET).seal('relay-pw-plain');
			const out = Object.fromEntries(
				selectRuntimeEnvVars({
					INSTANCE_SECRET,
					EMAIL_PROVIDER: 'smtp',
					SMTP_RELAY_HOST: 'smtp.example.com',
					SMTP_RELAY_PASSWORD: sealed,
				})
			);
			expect(out['SMTP_RELAY_PASSWORD']).toBe('relay-pw-plain');
			// Sibling plain values are untouched.
			expect(out['EMAIL_PROVIDER']).toBe('smtp');
			expect(out['SMTP_RELAY_HOST']).toBe('smtp.example.com');
		});

		it('passes a plaintext password through untouched (legacy .env keeps deploying fine)', () => {
			const out = Object.fromEntries(
				selectRuntimeEnvVars({
					INSTANCE_SECRET,
					EMAIL_PROVIDER: 'smtp',
					SMTP_RELAY_PASSWORD: 'legacy-plaintext-pw',
				})
			);
			expect(out['SMTP_RELAY_PASSWORD']).toBe('legacy-plaintext-pw');
		});

		it('fails CLOSED with a clear error on a tampered sealed token (never pushes ciphertext)', () => {
			const sealed = createEnvBackupBox(INSTANCE_SECRET).seal('relay-pw-plain');
			const parts = sealed.slice(ENV_BACKUP_SEALED_PREFIX.length).split('.');
			const ct = parts[2]!;
			const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
			const tampered = ENV_BACKUP_SEALED_PREFIX + [parts[0], parts[1], flipped].join('.');
			expect(() =>
				selectRuntimeEnvVars({ INSTANCE_SECRET, SMTP_RELAY_PASSWORD: tampered })
			).toThrow(/SMTP_RELAY_PASSWORD.*could not be opened/s);
		});

		it('fails CLOSED when a token was sealed under a different INSTANCE_SECRET', () => {
			const sealed = createEnvBackupBox('d'.repeat(64)).seal('relay-pw-plain');
			expect(() => selectRuntimeEnvVars({ INSTANCE_SECRET, SMTP_RELAY_PASSWORD: sealed })).toThrow(
				/SMTP_RELAY_PASSWORD.*could not be opened/s
			);
		});

		it('fails CLOSED with a clear error when INSTANCE_SECRET is missing from the same .env', () => {
			const sealed = createEnvBackupBox(INSTANCE_SECRET).seal('relay-pw-plain');
			expect(() => selectRuntimeEnvVars({ SMTP_RELAY_PASSWORD: sealed })).toThrow(
				/SMTP_RELAY_PASSWORD.*INSTANCE_SECRET is missing/s
			);
		});
	});

	it('includes the email provider + credential keys in the runtime list', () => {
		expect(CONVEX_RUNTIME_ENV_KEYS).toContain('EMAIL_PROVIDER');
		expect(CONVEX_RUNTIME_ENV_KEYS).toContain('RESEND_API_KEY');
		expect(CONVEX_RUNTIME_ENV_KEYS).toContain('AWS_SES_ACCESS_KEY_ID');
		expect(CONVEX_RUNTIME_ENV_KEYS).toContain('AWS_SES_SECRET_ACCESS_KEY');
		expect(CONVEX_RUNTIME_ENV_KEYS).toContain('AWS_SES_REGION');
	});
});

describe('deriveConvexAdminUrl', () => {
	it('swaps the site-proxy port (3211) for the cloud/admin port (3210)', () => {
		expect(deriveConvexAdminUrl('http://convex:3211')).toBe('http://convex:3210');
		expect(deriveConvexAdminUrl('http://localhost:3211/')).toBe('http://localhost:3210');
	});

	it('leaves a URL without the site-proxy port untouched (minus trailing slash)', () => {
		expect(deriveConvexAdminUrl('http://convex:3210')).toBe('http://convex:3210');
		expect(deriveConvexAdminUrl('https://api.example.com/')).toBe('https://api.example.com');
	});
});

describe('pushConvexRuntimeEnv', () => {
	it('POSTs the changes to the admin API with the Convex admin auth header', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
		await pushConvexRuntimeEnv(
			'http://convex:3210',
			'convex-self-hosted|abc',
			[
				['EMAIL_PROVIDER', 'resend'],
				['RESEND_API_KEY', 're_live_123'],
			],
			fetchMock
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('http://convex:3210/api/update_environment_variables');
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>)['Authorization']).toBe(
			'Convex convex-self-hosted|abc'
		);
		expect(JSON.parse(init.body as string)).toEqual({
			changes: [
				{ name: 'EMAIL_PROVIDER', value: 'resend' },
				{ name: 'RESEND_API_KEY', value: 're_live_123' },
			],
		});
	});

	it('no-ops on an empty var list (no request)', async () => {
		const fetchMock = vi.fn();
		await pushConvexRuntimeEnv('http://convex:3210', 'k', [], fetchMock);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('throws a clear error on a non-2xx response', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response('EnvVarNameForbidden', { status: 400 }));
		await expect(
			pushConvexRuntimeEnv('http://convex:3210', 'k', [['EMAIL_PROVIDER', 'resend']], fetchMock)
		).rejects.toThrow(/status 400.*EnvVarNameForbidden/s);
	});

	it('throws a clear error when the admin API is unreachable', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
		await expect(
			pushConvexRuntimeEnv('http://convex:3210', 'k', [['EMAIL_PROVIDER', 'resend']], fetchMock)
		).rejects.toThrow(/ECONNREFUSED/);
	});
});
