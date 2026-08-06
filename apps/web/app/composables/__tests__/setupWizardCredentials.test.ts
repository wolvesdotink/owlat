/**
 * THE DESCRIPTOR SNAPSHOT — the safety net the seams plan asks P1.2 for.
 *
 * "Catalog-driven UI subtly changes wizard/editor behaviour for existing
 * deployments" is the plan's own risk row, and its mitigation is this file:
 * the form every incumbent kind renders, and the env patch it writes, pinned to
 * what the hand-written per-vendor blocks produced BEFORE they were deleted.
 * The expectations below are literals on purpose — a table derived from the same
 * catalog the code reads would agree with any change at all, including one that
 * silently renames a field or drops a credential.
 *
 * WHY EACH HALF EARNS ITS PLACE:
 *
 *  - the FIELD table is what the operator sees. A label change moves the input's
 *    id (`#field-resend-api-key`), which is what the shipped wizard suites find
 *    their inputs by; a dropped `required` flag silently un-gates Apply.
 *  - the ENV table is what leaves the browser. It is the one thing a wrong
 *    refactor could get wrong invisibly — the form would still look right and
 *    the deployment would stop sending.
 *
 * The suite iterates the CATALOG, not a list of four names, so a sixth provider
 * fails here until its expected form and env are written down — which is the
 * point: the descriptor is the contract, and it gets reviewed once.
 */
import { describe, expect, it } from 'vitest';
import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	credentialFieldEnvVars,
} from '@owlat/shared/sendProviderCatalog';
import {
	credentialFieldsFor,
	credentialValuesFromDraft,
	draftCredentialsFromValues,
	hostPortFieldFor,
	seedCredentialValues,
	secretEnvKeys,
	transportCredentialEnv,
} from '../setupWizardCredentials';
import { buildProviderEnv, type EmailStepDraft } from '../useSetupWizard';

interface ExpectedField {
	key: string;
	kind: string;
	label: string;
	envVars: string[];
	required: boolean;
}

/** The forms the four incumbents (plus Mandrill) shipped, field for field. */
const EXPECTED_FIELDS: Record<string, ExpectedField[]> = {
	mta: [
		{
			key: 'outboundTlsMode',
			kind: 'select',
			label: 'Outbound TLS',
			envVars: ['OUTBOUND_TLS_MODE'],
			required: false,
		},
	],
	ses: [
		{
			key: 'region',
			kind: 'region-select',
			label: 'Region',
			envVars: ['AWS_SES_REGION'],
			required: true,
		},
		{
			key: 'accessKeyId',
			kind: 'string',
			label: 'Access key ID',
			envVars: ['AWS_SES_ACCESS_KEY_ID'],
			required: true,
		},
		{
			key: 'secretAccessKey',
			kind: 'secret',
			label: 'Secret access key',
			envVars: ['AWS_SES_SECRET_ACCESS_KEY'],
			required: true,
		},
	],
	resend: [
		{
			key: 'apiKey',
			kind: 'secret',
			label: 'Resend API key',
			envVars: ['RESEND_API_KEY'],
			required: true,
		},
	],
	smtp: [
		{
			key: 'relay',
			kind: 'host-port',
			label: 'Server host',
			envVars: ['SMTP_RELAY_HOST', 'SMTP_RELAY_PORT', 'SMTP_RELAY_SECURE'],
			required: true,
		},
		{
			key: 'username',
			kind: 'string',
			label: 'Username',
			envVars: ['SMTP_RELAY_USERNAME'],
			required: true,
		},
		{
			key: 'password',
			kind: 'secret',
			label: 'Password',
			envVars: ['SMTP_RELAY_PASSWORD'],
			required: true,
		},
	],
	mandrill: [
		{
			key: 'apiKey',
			kind: 'secret',
			label: 'Mailchimp Transactional API key',
			envVars: ['MANDRILL_API_KEY'],
			required: true,
		},
	],
};

/** A filled-in form per kind, in the env-keyed shape the renderer writes. */
const FILLED_VALUES: Record<string, Record<string, string>> = {
	mta: { OUTBOUND_TLS_MODE: 'require-verified' },
	ses: {
		AWS_SES_REGION: 'eu-west-1',
		AWS_SES_ACCESS_KEY_ID: 'AKIAEXAMPLE',
		AWS_SES_SECRET_ACCESS_KEY: 'ses-secret',
	},
	resend: { RESEND_API_KEY: 're_live_123' },
	smtp: {
		SMTP_RELAY_HOST: 'smtp.mailgun.org',
		SMTP_RELAY_PORT: '587',
		SMTP_RELAY_SECURE: 'false',
		SMTP_RELAY_USERNAME: 'postmaster@mg.acme.test',
		SMTP_RELAY_PASSWORD: 'relay-secret',
	},
	mandrill: { MANDRILL_API_KEY: 'md-9f3c2b7a41' },
};

/** The env patch each of those forms wrote before the refactor, byte for byte. */
const EXPECTED_ENV: Record<string, Record<string, string>> = {
	mta: { OUTBOUND_TLS_MODE: 'require-verified' },
	ses: {
		AWS_SES_REGION: 'eu-west-1',
		AWS_SES_ACCESS_KEY_ID: 'AKIAEXAMPLE',
		AWS_SES_SECRET_ACCESS_KEY: 'ses-secret',
	},
	resend: { RESEND_API_KEY: 're_live_123' },
	smtp: {
		SMTP_RELAY_HOST: 'smtp.mailgun.org',
		SMTP_RELAY_PORT: '587',
		SMTP_RELAY_SECURE: 'false',
		SMTP_RELAY_USERNAME: 'postmaster@mg.acme.test',
		SMTP_RELAY_PASSWORD: 'relay-secret',
	},
	mandrill: { MANDRILL_API_KEY: 'md-9f3c2b7a41' },
};

const CATALOG_KINDS = CORE_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => entry.kind);

function draft(overrides: Partial<EmailStepDraft> = {}): EmailStepDraft {
	return {
		provider: 'mta',
		requiresProvider: true,
		resendKey: '',
		mandrillKey: '',
		ses: { region: '', accessKeyId: '', secretAccessKey: '' },
		smtp: { preset: 'custom', host: '', port: '', secure: false, username: '', password: '' },
		fromEmail: '',
		fromName: '',
		...overrides,
	};
}

describe('credential descriptors — the shipped forms, pinned', () => {
	it('covers every kind the catalog declares', () => {
		expect(CATALOG_KINDS).toEqual(Object.keys(EXPECTED_FIELDS));
	});

	it.each(CATALOG_KINDS)('renders %s from the same fields it always did', (kind) => {
		const actual = credentialFieldsFor(kind).map((field) => ({
			key: field.key,
			kind: field.kind,
			label: field.label,
			envVars: [...credentialFieldEnvVars(field)],
			required: field.required === true,
		}));
		expect(actual).toEqual(EXPECTED_FIELDS[kind]);
	});

	it('knows nothing about a transport this build does not carry', () => {
		expect(credentialFieldsFor('postmark')).toEqual([]);
		expect(credentialFieldsFor(null)).toEqual([]);
		expect(transportCredentialEnv('postmark', { ANYTHING: 'x' })).toEqual({});
	});
});

describe('credential descriptors — the env patch, pinned', () => {
	it.each(CATALOG_KINDS)('writes the %s patch byte for byte', (kind) => {
		expect(transportCredentialEnv(kind, FILLED_VALUES[kind]!)).toEqual(EXPECTED_ENV[kind]);
	});

	it('defaults a blank relay port to the descriptor’s own default, not to nothing', () => {
		const env = transportCredentialEnv('smtp', { ...FILLED_VALUES['smtp'], SMTP_RELAY_PORT: '  ' });
		expect(env['SMTP_RELAY_PORT']).toBe('587');
	});

	it('trims the relay host so a pasted endpoint cannot carry whitespace into DNS', () => {
		const env = transportCredentialEnv('smtp', {
			...FILLED_VALUES['smtp'],
			SMTP_RELAY_HOST: '  smtp.example.com  ',
		});
		expect(env['SMTP_RELAY_HOST']).toBe('smtp.example.com');
	});

	it('writes the implicit-TLS flag explicitly in both directions', () => {
		expect(
			transportCredentialEnv('smtp', { ...FILLED_VALUES['smtp'], SMTP_RELAY_SECURE: 'true' })[
				'SMTP_RELAY_SECURE'
			]
		).toBe('true');
		expect(
			transportCredentialEnv('smtp', { ...FILLED_VALUES['smtp'], SMTP_RELAY_SECURE: '' })[
				'SMTP_RELAY_SECURE'
			]
		).toBe('false');
	});

	it('falls back to a select’s declared default rather than writing a blank floor', () => {
		expect(transportCredentialEnv('mta', {})).toEqual({ OUTBOUND_TLS_MODE: 'opportunistic' });
	});

	it('never writes a variable the entry declares but does not collect as a field', () => {
		// `MANDRILL_WEBHOOK_KEY` / `RESEND_WEBHOOK_SECRET` are issued after the
		// webhook exists, and `MTA_API_KEY` is the installer's. All three are
		// `optionalEnvVars` / `requiredEnvVars` with no field, and the patch is
		// cleared-then-set — so writing one would unset a working feedback loop.
		const written = new Set(
			CATALOG_KINDS.flatMap((kind) =>
				Object.keys(transportCredentialEnv(kind, FILLED_VALUES[kind]!))
			)
		);
		for (const name of [
			'MANDRILL_WEBHOOK_KEY',
			'MANDRILL_SUBACCOUNT',
			'MANDRILL_IP_POOL',
			'RESEND_WEBHOOK_SECRET',
			'MTA_API_URL',
			'MTA_API_KEY',
			'MTA_WEBHOOK_SECRET',
		]) {
			expect(written.has(name)).toBe(false);
		}
	});
});

describe('the blank form', () => {
	it('seeds each kind with its declared defaults', () => {
		expect(seedCredentialValues('mta')).toEqual({ OUTBOUND_TLS_MODE: 'opportunistic' });
		expect(seedCredentialValues('ses')['AWS_SES_REGION']).toBe('us-east-1');
		expect(seedCredentialValues('resend')).toEqual({ RESEND_API_KEY: '' });
	});

	it('seeds a relay endpoint from the first preset the descriptor offers', () => {
		const seeded = seedCredentialValues('smtp');
		const first = hostPortFieldFor('smtp')?.presets?.['mailgun'];
		expect(seeded['SMTP_RELAY_HOST']).toBe(first?.host);
		expect(seeded['SMTP_RELAY_PORT']).toBe('587');
		expect(seeded['SMTP_RELAY_SECURE']).toBe('false');
	});

	it('names every secret the redaction list has to cover, across all kinds', () => {
		expect([...secretEnvKeys(CATALOG_KINDS)].sort()).toEqual([
			'AWS_SES_SECRET_ACCESS_KEY',
			'MANDRILL_API_KEY',
			'RESEND_API_KEY',
			'SMTP_RELAY_PASSWORD',
		]);
	});
});

describe('the legacy draft bridge', () => {
	it('round-trips every credential the wizard draft can carry', () => {
		const values = {
			...FILLED_VALUES['mta'],
			...FILLED_VALUES['ses'],
			...FILLED_VALUES['resend'],
			...FILLED_VALUES['smtp'],
			...FILLED_VALUES['mandrill'],
		};
		const credentials = draftCredentialsFromValues(values, 'mailgun');
		expect(credentialValuesFromDraft({ ...draft(), ...credentials })).toEqual(values);
	});

	it('reads a blank outbound-TLS floor as unset rather than as an empty mode', () => {
		expect(draftCredentialsFromValues({}, 'custom').outboundTlsMode).toBeUndefined();
	});
});

/**
 * The whole path, through the SHIPPED entry point: what the wizard and the
 * editor actually call. A refactor that got the descriptors right but wired
 * `buildProviderEnv` to the wrong values would pass everything above.
 */
describe('buildProviderEnv writes exactly the selected kind’s credentials', () => {
	it.each(CATALOG_KINDS)('for %s, and clears every other kind’s', (kind) => {
		const credentials = draftCredentialsFromValues(
			{
				...FILLED_VALUES['mta'],
				...FILLED_VALUES['ses'],
				...FILLED_VALUES['resend'],
				...FILLED_VALUES['smtp'],
				...FILLED_VALUES['mandrill'],
			},
			'mailgun'
		);
		const env = buildProviderEnv({}, draft({ provider: kind, ...credentials }));
		expect(env).toEqual({ EMAIL_PROVIDER: kind, ...EXPECTED_ENV[kind] });
	});
});
