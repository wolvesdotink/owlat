import { describe, it, expect } from 'vitest';
import { seedOutboundTlsMode } from '../setupOutboundTls';
import {
	PROVIDER_ENV_KEYS,
	SMTP_RELAY_PRESETS,
	buildProviderEnv,
	type EmailStepDraft,
} from '../useSetupWizard';
import {
	emailStepIsValid,
	transportStepIsValid,
	validateEmailStep,
} from '../setupWizardValidation';

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
		credentials: { AWS_SES_REGION: 'us-east-1' },
		fromEmail: '',
		fromName: '',
		...overrides,
	};
}

describe('transport editor — picker + preset reuse', () => {
	it('emits EMAIL_PROVIDER=resend plus the key for a Resend transport', () => {
		const env = buildProviderEnv(
			{},
			draft({ provider: 'resend', credentials: { RESEND_API_KEY: 're_live_abc' } })
		);
		expect(env['EMAIL_PROVIDER']).toBe('resend');
		expect(env['RESEND_API_KEY']).toBe('re_live_abc');
		expect(env['AWS_SES_ACCESS_KEY_ID']).toBeUndefined();
	});

	it('emits the full SES credential set for an SES transport', () => {
		const env = buildProviderEnv(
			{},
			draft({
				provider: 'ses',
				credentials: {
					AWS_SES_REGION: 'eu-west-1',
					AWS_SES_ACCESS_KEY_ID: 'AKIA',
					AWS_SES_SECRET_ACCESS_KEY: 'shh',
				},
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
				credentials: {
					SMTP_RELAY_HOST: preset.host,
					SMTP_RELAY_PORT: preset.port,
					SMTP_RELAY_SECURE: String(preset.secure),
					SMTP_RELAY_USERNAME: 'postmaster',
					SMTP_RELAY_PASSWORD: 'pw',
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
		const env = buildProviderEnv(
			{},
			draft({ provider: 'resend', credentials: { RESEND_API_KEY: 're_x' } })
		);
		for (const key of Object.keys(env)) {
			expect(PROVIDER_ENV_KEYS).toContain(key);
		}
	});
});

describe('transport editor — validation gating', () => {
	it('blocks apply for Resend without a key', () => {
		expect(
			emailStepIsValid(draft({ provider: 'resend', credentials: { RESEND_API_KEY: '' } }))
		).toBe(false);
		expect(
			validateEmailStep(draft({ provider: 'resend', credentials: { RESEND_API_KEY: '' } }))
				.credentials
		).toBeTruthy();
	});

	it('blocks apply for SMTP missing host/username/password', () => {
		const d = draft({
			provider: 'smtp',
			credentials: {
				SMTP_RELAY_HOST: '',
				SMTP_RELAY_PORT: '',
				SMTP_RELAY_SECURE: 'false',
				SMTP_RELAY_USERNAME: '',
				SMTP_RELAY_PASSWORD: '',
			},
		});
		expect(emailStepIsValid(d)).toBe(false);
		expect(validateEmailStep(d).credentials).toBeTruthy();
	});

	it('blocks apply for SES missing credentials', () => {
		const d = draft({
			provider: 'ses',
			credentials: {
				AWS_SES_REGION: 'us-east-1',
				AWS_SES_ACCESS_KEY_ID: '',
				AWS_SES_SECRET_ACCESS_KEY: '',
			},
		});
		expect(emailStepIsValid(d)).toBe(false);
	});

	it('allows a complete SMTP transport', () => {
		const d = draft({
			provider: 'smtp',
			credentials: {
				SMTP_RELAY_HOST: 'smtp.example.com',
				SMTP_RELAY_PORT: '587',
				SMTP_RELAY_SECURE: 'false',
				SMTP_RELAY_USERNAME: 'user',
				SMTP_RELAY_PASSWORD: 'pw',
			},
		});
		expect(emailStepIsValid(d)).toBe(true);
	});
});

/**
 * WHICH RULES THIS SCREEN CAN MEET.
 *
 * The editor renders the provider picker, the credential fields and the From
 * identity. `validateEmailStep` also demands the sending IPs and the EHLO
 * hostname whenever the built-in MTA is chosen, because the SETUP wizard
 * collects them on that same step — this screen renders neither and could not
 * write them (they are not `PROVIDER_ENV_KEYS`), so gating Apply on them made
 * "Run your own MTA" a button that did nothing, silently.
 */
describe('transport editor — the subset of the email step it owns', () => {
	/** The MTA identity is the wizard's rule; the editor applies without it. */
	it('applies the built-in MTA with no identity fields collected', () => {
		const d = draft({ provider: 'mta' });
		expect(validateEmailStep(d).mtaIdentity).toBeTruthy();
		expect(emailStepIsValid(d)).toBe(false);
		expect(transportStepIsValid(d)).toBe(true);
	});

	// Every rule the screen CAN meet still gates it — the predicate is a subset,
	// not a bypass.
	it('still blocks on each error this screen renders a field for', () => {
		expect(
			transportStepIsValid(draft({ provider: 'resend', credentials: { RESEND_API_KEY: '' } }))
		).toBe(false);
		expect(
			transportStepIsValid(
				draft({
					provider: 'ses',
					credentials: {
						AWS_SES_REGION: 'us-east-1',
						AWS_SES_ACCESS_KEY_ID: '',
						AWS_SES_SECRET_ACCESS_KEY: '',
					},
				})
			)
		).toBe(false);
		expect(transportStepIsValid(draft({ provider: 'smtp' }))).toBe(false);
		expect(transportStepIsValid(draft({ provider: 'none', requiresProvider: true }))).toBe(false);
		expect(transportStepIsValid(draft({ provider: 'mta', fromEmail: 'not-an-address' }))).toBe(
			false
		);
	});

	// The bug the previous shape reproduced on the next field added to the step:
	// an MTA draft with a BAD From address is not valid just because the identity
	// error is present too.
	it('does not let an ignored error carry an owned one through with it', () => {
		const d = draft({ provider: 'mta', fromEmail: 'nope' });
		expect(validateEmailStep(d).mtaIdentity).toBeTruthy();
		expect(transportStepIsValid(d)).toBe(false);
	});
});

describe('transport editor — outbound TLS mode (OUTBOUND_TLS_MODE)', () => {
	it('emits the chosen outbound TLS mode for the built-in MTA transport', () => {
		const env = buildProviderEnv(
			{},
			draft({ provider: 'mta', credentials: { OUTBOUND_TLS_MODE: 'require-verified' } })
		);
		expect(env['EMAIL_PROVIDER']).toBe('mta');
		expect(env['OUTBOUND_TLS_MODE']).toBe('require-verified');
	});

	it('defaults an omitted mode to opportunistic (byte-identical to historic behaviour)', () => {
		const env = buildProviderEnv({}, draft({ provider: 'mta' }));
		expect(env['OUTBOUND_TLS_MODE']).toBe('opportunistic');
	});

	it('never emits OUTBOUND_TLS_MODE for a relay/API transport (their TLS is the provider’s concern)', () => {
		for (const env of [
			buildProviderEnv({}, draft({ provider: 'resend', credentials: { RESEND_API_KEY: 'k' } })),
			buildProviderEnv(
				{},
				draft({
					provider: 'smtp',
					credentials: {
						SMTP_RELAY_HOST: 'h',
						SMTP_RELAY_PORT: '587',
						SMTP_RELAY_SECURE: 'false',
						SMTP_RELAY_USERNAME: 'u',
						SMTP_RELAY_PASSWORD: 'p',
						// A floor left in the form from the own arm must not leak into a relay's patch.
						OUTBOUND_TLS_MODE: 'require-verified',
					},
				})
			),
		]) {
			expect(env['OUTBOUND_TLS_MODE']).toBeUndefined();
		}
	});

	it('OUTBOUND_TLS_MODE is inside the server allowlist so the patch is accepted', () => {
		expect(PROVIDER_ENV_KEYS).toContain('OUTBOUND_TLS_MODE');
	});

	// Regression: an admin who set `require-verified` and later re-applies any
	// transport edit must NOT have the floor silently reset to `opportunistic`.
	// The editor seeds its mode from the active value (status query) via
	// `seedOutboundTlsMode`; re-applying then re-emits the SAME floor.
	it('re-apply preserves a previously-set mode (no silent downgrade)', () => {
		// Seeded from the active OUTBOUND_TLS_MODE, exactly as the editor does.
		const seeded = seedOutboundTlsMode('require-verified');
		expect(seeded).toBe('require-verified');
		const env = buildProviderEnv(
			{},
			draft({ provider: 'mta', credentials: { OUTBOUND_TLS_MODE: seeded } })
		);
		expect(env['OUTBOUND_TLS_MODE']).toBe('require-verified');
	});

	it('seedOutboundTlsMode falls back to opportunistic for an unset/unknown active value', () => {
		expect(seedOutboundTlsMode(null)).toBe('opportunistic');
		expect(seedOutboundTlsMode(undefined)).toBe('opportunistic');
		expect(seedOutboundTlsMode('bogus')).toBe('opportunistic');
		expect(seedOutboundTlsMode('require')).toBe('require');
	});
});

describe('transport editor — server allowlist invariant', () => {
	it('every provider/from key the patch can set is inside PROVIDER_ENV_KEYS', () => {
		// Union of keys across every provider kind + optional From identity.
		const all = new Set<string>();
		for (const env of [
			buildProviderEnv({}, draft({ provider: 'resend', credentials: { RESEND_API_KEY: 'k' } })),
			buildProviderEnv(
				{},
				draft({
					provider: 'ses',
					credentials: {
						AWS_SES_REGION: 'r',
						AWS_SES_ACCESS_KEY_ID: 'a',
						AWS_SES_SECRET_ACCESS_KEY: 's',
					},
				})
			),
			buildProviderEnv(
				{},
				draft({
					provider: 'smtp',
					credentials: {
						SMTP_RELAY_HOST: 'h',
						SMTP_RELAY_PORT: '25',
						SMTP_RELAY_SECURE: 'true',
						SMTP_RELAY_USERNAME: 'u',
						SMTP_RELAY_PASSWORD: 'p',
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
