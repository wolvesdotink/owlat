import { describe, it, expect } from 'vitest';
import {
	SETUP_STEPS,
	isSetupEmailValid,
	validateAdmin,
	adminIsValid,
	validateEmailStep,
	emailStepIsValid,
	buildProviderEnv,
	buildSetupSummary,
	interpretSetupModeProbe,
	type AdminDraft,
	type EmailStepDraft,
} from '../useSetupWizard';
import { getDefaultFlags, type FeatureFlagState } from '@owlat/shared/featureFlags';

const validAdmin: AdminDraft = {
	email: 'admin@example.com',
	name: 'Alex Operator',
	password: 'a-very-long-password',
};

function emailDraft(overrides: Partial<EmailStepDraft> = {}): EmailStepDraft {
	return {
		provider: 'mta',
		requiresProvider: true,
		resendKey: '',
		ses: { region: 'us-east-1', accessKeyId: '', secretAccessKey: '' },
		fromEmail: '',
		fromName: '',
		...overrides,
	};
}

// A flag set with all bulk-sending features off, so no delivery provider is required.
const receiveOnlyFlags: FeatureFlagState = {
	...getDefaultFlags(),
	campaigns: false,
	transactional: false,
	automations: false,
};

describe('useSetupWizard step model', () => {
	it('exposes five ordered, numbered steps ending in review', () => {
		expect(SETUP_STEPS.map((s) => s.id)).toEqual(['mode', 'features', 'email', 'admin', 'review']);
		expect(SETUP_STEPS.map((s) => s.number)).toEqual([1, 2, 3, 4, 5]);
	});
});

describe('email validation helper', () => {
	it.each(['admin@example.com', 'a.b@sub.example.co', '  trimmed@example.com  '])(
		'accepts %s',
		(value) => expect(isSetupEmailValid(value)).toBe(true),
	);
	it.each(['', 'no-at-sign', 'missing@tld', '@nolocal.com'])('rejects %s', (value) =>
		expect(isSetupEmailValid(value)).toBe(false),
	);
});

describe('admin step navigation gate', () => {
	it('cannot advance with an invalid email', () => {
		const errors = validateAdmin({ ...validAdmin, email: 'not-an-email' });
		expect(errors.email).toBeTruthy();
		expect(adminIsValid({ ...validAdmin, email: 'not-an-email' })).toBe(false);
	});

	it('cannot advance with a password under 12 characters', () => {
		const errors = validateAdmin({ ...validAdmin, password: 'short' });
		expect(errors.password).toBeTruthy();
		expect(adminIsValid({ ...validAdmin, password: 'short' })).toBe(false);
	});

	it('can advance once email and password are valid', () => {
		expect(validateAdmin(validAdmin)).toEqual({});
		expect(adminIsValid(validAdmin)).toBe(true);
	});
});

describe('email step navigation gate', () => {
	it('cannot advance with "none" when a delivery provider is required', () => {
		const draft = emailDraft({ provider: 'none', requiresProvider: true });
		expect(validateEmailStep(draft).provider).toBeTruthy();
		expect(emailStepIsValid(draft)).toBe(false);
	});

	it('can advance with "none" when no provider is required (receive-only)', () => {
		const draft = emailDraft({ provider: 'none', requiresProvider: false });
		expect(emailStepIsValid(draft)).toBe(true);
	});

	it('cannot advance with Resend selected but no API key', () => {
		const draft = emailDraft({ provider: 'resend', resendKey: '' });
		expect(validateEmailStep(draft).resendKey).toBeTruthy();
		expect(emailStepIsValid(draft)).toBe(false);
	});

	it('cannot advance with SES selected but missing credentials', () => {
		const draft = emailDraft({ provider: 'ses' });
		expect(validateEmailStep(draft).ses).toBeTruthy();
		expect(emailStepIsValid(draft)).toBe(false);
	});

	it('rejects a malformed optional From address', () => {
		const draft = emailDraft({ provider: 'mta', fromEmail: 'bogus' });
		expect(validateEmailStep(draft).fromEmail).toBeTruthy();
		expect(emailStepIsValid(draft)).toBe(false);
	});

	it('accepts a blank From address (the field is optional)', () => {
		expect(emailStepIsValid(emailDraft({ provider: 'mta', fromEmail: '' }))).toBe(true);
	});
});

describe('buildProviderEnv', () => {
	it('writes the provider and its credentials, clearing stale keys', () => {
		const env = buildProviderEnv(
			{ AWS_SES_REGION: 'eu-west-1', RESEND_API_KEY: 'old' },
			emailDraft({ provider: 'resend', resendKey: 're_live_123' }),
		);
		expect(env['EMAIL_PROVIDER']).toBe('resend');
		expect(env['RESEND_API_KEY']).toBe('re_live_123');
		expect(env['AWS_SES_REGION']).toBeUndefined();
	});

	it('clears the provider entirely for "none"', () => {
		const env = buildProviderEnv(
			{ EMAIL_PROVIDER: 'mta' },
			emailDraft({ provider: 'none', requiresProvider: false }),
		);
		expect(env['EMAIL_PROVIDER']).toBeUndefined();
	});

	it('flows the optional From-identity into the apply env', () => {
		const env = buildProviderEnv(
			{},
			emailDraft({ provider: 'mta', fromEmail: 'hello@acme.test', fromName: 'Acme' }),
		);
		expect(env['DEFAULT_FROM_EMAIL']).toBe('hello@acme.test');
		expect(env['DEFAULT_FROM_NAME']).toBe('Acme');
	});

	it('drops a previously-set From-identity when cleared', () => {
		const env = buildProviderEnv(
			{ DEFAULT_FROM_EMAIL: 'old@acme.test', DEFAULT_FROM_NAME: 'Old' },
			emailDraft({ provider: 'mta', fromEmail: '', fromName: '' }),
		);
		expect(env['DEFAULT_FROM_EMAIL']).toBeUndefined();
		expect(env['DEFAULT_FROM_NAME']).toBeUndefined();
	});
});

describe('review step renders the collected config', () => {
	it('summarizes enabled features, provider, From-identity, and admin', () => {
		const env = buildProviderEnv(
			{},
			emailDraft({ provider: 'resend', resendKey: 're_1', fromEmail: 'team@acme.test', fromName: 'Acme' }),
		);
		const summary = buildSetupSummary(getDefaultFlags(), env, validAdmin);

		expect(summary.provider).toBe('resend');
		expect(summary.providerLabel).toBe('Resend');
		expect(summary.fromIdentity).toBe('Acme <team@acme.test>');
		expect(summary.adminEmail).toBe('admin@example.com');
		expect(summary.adminName).toBe('Alex Operator');
		// Defaults enable campaigns + transactional, so those surface as active.
		expect(summary.activeFeatures).toContain('campaigns');
		expect(summary.missingProvider).toBe(false);
	});

	it('flags a missing provider when bulk sending is on but none was chosen', () => {
		const summary = buildSetupSummary(getDefaultFlags(), {}, validAdmin);
		expect(summary.provider).toBe('none');
		expect(summary.missingProvider).toBe(true);
	});

	it('does not require a provider for a receive-only feature set', () => {
		const summary = buildSetupSummary(receiveOnlyFlags, {}, validAdmin);
		expect(summary.missingProvider).toBe(false);
		expect(summary.activeFeatures).not.toContain('campaigns');
	});

	it('renders a From-identity of just the address when no name is set', () => {
		const summary = buildSetupSummary(
			getDefaultFlags(),
			{ EMAIL_PROVIDER: 'mta', DEFAULT_FROM_EMAIL: 'solo@acme.test' },
			validAdmin,
		);
		expect(summary.fromIdentity).toBe('solo@acme.test');
	});
});

describe('post-apply readiness probe', () => {
	it('treats a 403 (setup mode cleared) as ready to advance', () => {
		expect(interpretSetupModeProbe(403)).toBe(true);
	});
	it('keeps waiting while setup mode is still live', () => {
		expect(interpretSetupModeProbe(400)).toBe(false);
		expect(interpretSetupModeProbe(200)).toBe(false);
		expect(interpretSetupModeProbe(503)).toBe(false);
	});
});
