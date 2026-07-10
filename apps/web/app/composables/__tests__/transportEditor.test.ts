import { describe, it, expect } from 'vitest';
import {
	PROVIDER_ENV_KEYS,
	SMTP_RELAY_PRESETS,
	buildProviderEnv,
	emailStepIsValid,
	validateEmailStep,
	type EmailStepDraft,
} from '../useSetupWizard';

/**
 * The in-app transport editor (`components/delivery/TransportEditor.vue`) reuses
 * the setup wizard's provider picker, SMTP presets, `buildProviderEnv`, and
 * validation rather than re-implementing them. These tests pin the contract the
 * editor depends on:
 *   - the same env-patch the wizard emits (picker + preset reuse);
 *   - validation gates Test/Apply (no partial credentials go through); and
 *   - every key the client patch can emit is inside the server's allowlist
 *     (`PROVIDER_ENV_KEYS`), so a transport change can never inject other env.
 */

function draft(overrides: Partial<EmailStepDraft> = {}): EmailStepDraft {
	return {
		provider: 'mta',
		requiresProvider: true,
		resendKey: '',
		ses: { region: 'us-east-1', accessKeyId: '', secretAccessKey: '' },
		smtp: {
			preset: 'custom',
			host: '',
			port: '',
			secure: false,
			username: '',
			password: '',
		},
		fromEmail: '',
		fromName: '',
		...overrides,
	};
}

describe('transport editor — picker + preset reuse', () => {
	it('emits EMAIL_PROVIDER=resend plus the key for a Resend transport', () => {
		const env = buildProviderEnv({}, draft({ provider: 'resend', resendKey: 're_live_abc' }));
		expect(env['EMAIL_PROVIDER']).toBe('resend');
		expect(env['RESEND_API_KEY']).toBe('re_live_abc');
		expect(env['AWS_SES_ACCESS_KEY_ID']).toBeUndefined();
	});

	it('emits the full SES credential set for an SES transport', () => {
		const env = buildProviderEnv(
			{},
			draft({
				provider: 'ses',
				ses: { region: 'eu-west-1', accessKeyId: 'AKIA', secretAccessKey: 'shh' },
			})
		);
		expect(env['EMAIL_PROVIDER']).toBe('ses');
		expect(env['AWS_SES_REGION']).toBe('eu-west-1');
		expect(env['AWS_SES_ACCESS_KEY_ID']).toBe('AKIA');
		expect(env['AWS_SES_SECRET_ACCESS_KEY']).toBe('shh');
	});

	it('applies a named SMTP preset host/port/TLS through the shared preset table', () => {
		const preset = SMTP_RELAY_PRESETS['mailgun'];
		const env = buildProviderEnv(
			{},
			draft({
				provider: 'smtp',
				smtp: {
					preset: 'mailgun',
					host: preset.host,
					port: preset.port,
					secure: preset.secure,
					username: 'postmaster',
					password: 'pw',
				},
			})
		);
		expect(env['EMAIL_PROVIDER']).toBe('smtp');
		expect(env['SMTP_RELAY_HOST']).toBe('smtp.mailgun.org');
		expect(env['SMTP_RELAY_PORT']).toBe('587');
		expect(env['SMTP_RELAY_SECURE']).toBe('false');
		expect(env['SMTP_RELAY_USERNAME']).toBe('postmaster');
	});

	it('starting from an empty base emits only transport keys (nothing carried over)', () => {
		const env = buildProviderEnv({}, draft({ provider: 'resend', resendKey: 're_x' }));
		for (const key of Object.keys(env)) {
			expect(PROVIDER_ENV_KEYS).toContain(key);
		}
	});
});

describe('transport editor — validation gating', () => {
	it('blocks apply for Resend without a key', () => {
		expect(emailStepIsValid(draft({ provider: 'resend', resendKey: '' }))).toBe(false);
		expect(validateEmailStep(draft({ provider: 'resend', resendKey: '' })).resendKey).toBeTruthy();
	});

	it('blocks apply for SMTP missing host/username/password', () => {
		const d = draft({
			provider: 'smtp',
			smtp: { preset: 'custom', host: '', port: '', secure: false, username: '', password: '' },
		});
		expect(emailStepIsValid(d)).toBe(false);
		expect(validateEmailStep(d).smtp).toBeTruthy();
	});

	it('blocks apply for SES missing credentials', () => {
		const d = draft({
			provider: 'ses',
			ses: { region: 'us-east-1', accessKeyId: '', secretAccessKey: '' },
		});
		expect(emailStepIsValid(d)).toBe(false);
	});

	it('allows a complete SMTP transport', () => {
		const d = draft({
			provider: 'smtp',
			smtp: {
				preset: 'custom',
				host: 'smtp.example.com',
				port: '587',
				secure: false,
				username: 'user',
				password: 'pw',
			},
		});
		expect(emailStepIsValid(d)).toBe(true);
	});
});

describe('transport editor — server allowlist invariant', () => {
	it('every provider/from key the patch can set is inside PROVIDER_ENV_KEYS', () => {
		// Union of keys across every provider kind + optional From identity.
		const all = new Set<string>();
		for (const env of [
			buildProviderEnv({}, draft({ provider: 'resend', resendKey: 'k' })),
			buildProviderEnv(
				{},
				draft({
					provider: 'ses',
					ses: { region: 'r', accessKeyId: 'a', secretAccessKey: 's' },
				})
			),
			buildProviderEnv(
				{},
				draft({
					provider: 'smtp',
					smtp: {
						preset: 'custom',
						host: 'h',
						port: '25',
						secure: true,
						username: 'u',
						password: 'p',
					},
				})
			),
			buildProviderEnv(
				{},
				draft({ provider: 'mta', fromEmail: 'no@reply.test', fromName: 'Owlat' })
			),
		]) {
			for (const key of Object.keys(env)) all.add(key);
		}
		for (const key of all) {
			expect(PROVIDER_ENV_KEYS).toContain(key);
		}
	});
});
