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
	credentialFieldEnv,
	credentialFieldsFor,
	credentialValuesFromDraft,
	draftCredentialsFromValues,
	hostPortFieldFor,
	seedCredentialValues,
	secretEnvKeys,
	transportCredentialEnv,
} from '../setupWizardCredentials';
import { buildProviderEnv, buildSetupSummary, type EmailStepDraft } from '../useSetupWizard';
import { getDefaultFlags } from '@owlat/shared/featureFlags';
import { credentialErrorFor, validateEmailStep } from '../setupWizardValidation';
import { createTestI18n } from '~/__tests__/i18n';

/** The real catalog's `t`, for the module-scope names the review step resolves. */
const { t } = createTestI18n().global;

interface ExpectedField {
	key: string;
	kind: string;
	label: string;
	envVars: string[];
	required: boolean;
	/**
	 * The two RENDERED strings a descriptor may carry besides its label —
	 * `TransportCredentialFields.vue` draws both. They are pinned for the same
	 * reason the label is, and because the first revision of this pin left them
	 * out and two copy changes walked straight through it: Mandrill's note lost
	 * the pointer to the card that issues `MANDRILL_WEBHOOK_KEY`, and the relay
	 * host gained a hint the wizard's step never showed.
	 */
	description?: string;
	placeholder?: string;
}

/** The forms the four incumbents (plus Mandrill) shipped, field for field. */
const EXPECTED_FIELDS: Record<string, ExpectedField[]> = {
	mta: [
		{
			key: 'outboundTlsMode',
			kind: 'select',
			// The string the shipped editor shows. A LITERAL, not a read of the
			// entry: the risk this suite exists for is precisely a descriptor whose
			// label drifts from the form an operator already knows.
			label: 'Connection security',
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
			placeholder: 'us-east-1',
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
			placeholder: 're_...',
		},
	],
	smtp: [
		{
			key: 'relay',
			kind: 'host-port',
			label: 'Server host',
			envVars: ['SMTP_RELAY_HOST', 'SMTP_RELAY_PORT', 'SMTP_RELAY_SECURE'],
			required: true,
			// THE ONE HINT THAT MOVED, and it moved by ADDITION: the in-app editor
			// showed it, the wizard's step did not, and a descriptor has one. Ratified
			// in `scripts/provider-identity-allowlist.txt` — the composite's own
			// docblock argues the pair must hint together, since the port input beside
			// it always showed its declared default.
			placeholder: 'smtp.mailgun.org',
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
			// BOTH shipped blocks closed by pointing at the card that issues the
			// second variable. Dropping that pointer left the operator told they need
			// `MANDRILL_WEBHOOK_KEY` with nowhere to get it, which is why the sentence
			// is pinned whole rather than by its opening clause.
			description:
				'Mailchimp Transactional → Settings → API keys. Feedback (bounces, complaints, rejects) needs a second variable, MANDRILL_WEBHOOK_KEY, which Mandrill issues when you create the webhook — the webhook card on the delivery page has the URL and the events to enable.',
			placeholder: 'md-...',
		},
	],
	emailit: [
		{
			key: 'apiKey',
			kind: 'secret',
			label: 'Emailit API key',
			envVars: ['EMAILIT_API_KEY'],
			required: true,
			placeholder: 'em_...',
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
	emailit: { EMAILIT_API_KEY: 'em_live_123' },
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
	emailit: { EMAILIT_API_KEY: 'em_live_123' },
};

const CATALOG_KINDS = CORE_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => entry.kind);

function draft(overrides: Partial<EmailStepDraft> = {}): EmailStepDraft {
	return {
		provider: 'mta',
		requiresProvider: true,
		resendKey: '',
		emailitKey: '',
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
			// The descriptor carries a `sharedPkg.sendProviderCatalog.*` KEY, so the
			// words are read through the catalog exactly as the form reads them —
			// which is what keeps this table a pin on the SENTENCE an operator sees
			// rather than on the key path that happens to address it.
			label: t(field.label),
			envVars: [...credentialFieldEnvVars(field)],
			required: field.required === true,
			// Undefined rather than omitted on both, so an ADDED description or
			// placeholder fails here too — `toEqual` ignores an undefined-valued key
			// on one side, but not a string where the table says nothing.
			description: field.description === undefined ? undefined : t(field.description),
			// A placeholder is an EXAMPLE value (`re_...`, `us-east-1`), not copy, so
			// it stays a literal in the descriptor and is compared as one.
			placeholder: 'placeholder' in field ? field.placeholder : undefined,
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
			'EMAILIT_WEBHOOK_SECRET',
			'MTA_API_URL',
			'MTA_API_KEY',
			'MTA_WEBHOOK_SECRET',
		]) {
			expect(written.has(name)).toBe(false);
		}
	});
});

/**
 * THE FOUR NORMALISATION RULES, one field kind at a time.
 *
 * `transportCredentialEnv` above proves them for the kinds that SHIP, which is
 * what the deployments in the field run — but no shipped entry declares a
 * `boolean` credential, so that rule is the one branch provider N+1 reaches
 * first and nothing else can exercise. The same argument
 * `transportDnsGuidance`'s capability layer makes: the only thing that can prove
 * a branch before its first caller arrives is a test that calls it.
 */
describe('one descriptor → the env lines it owns', () => {
	it('writes free text verbatim — normalising a credential would change it', () => {
		const field = { kind: 'secret', key: 'apiKey', label: 'API key', envVar: 'ACME_KEY' } as const;
		expect(credentialFieldEnv(field, { ACME_KEY: '  spaced-secret  ' })).toEqual({
			ACME_KEY: '  spaced-secret  ',
		});
		expect(credentialFieldEnv(field, {})).toEqual({ ACME_KEY: '' });
	});

	it('falls back to a select’s declared default rather than writing a blank', () => {
		const field = {
			kind: 'select',
			key: 'mode',
			label: 'Mode',
			envVar: 'ACME_MODE',
			options: [{ value: 'fast', label: 'Fast' }],
			default: 'fast',
		} as const;
		expect(credentialFieldEnv(field, {})).toEqual({ ACME_MODE: 'fast' });
		expect(credentialFieldEnv(field, { ACME_MODE: 'slow' })).toEqual({ ACME_MODE: 'slow' });
	});

	it('writes a boolean as an explicit true/false, defaulted from the descriptor', () => {
		// The branch NO shipped kind reaches. An unchecked box must write `'false'`,
		// never an absent key: the patch is cleared-then-set, so a missing key is a
		// variable the deployment loses rather than a toggle left off.
		const field = { kind: 'boolean', key: 'pool', label: 'Dedicated IP', envVar: 'ACME_POOL' };
		expect(credentialFieldEnv(field, {})).toEqual({ ACME_POOL: 'false' });
		expect(credentialFieldEnv({ ...field, default: true }, {})).toEqual({ ACME_POOL: 'true' });
		expect(credentialFieldEnv(field, { ACME_POOL: 'true' })).toEqual({ ACME_POOL: 'true' });
		expect(credentialFieldEnv(field, { ACME_POOL: 'nonsense' })).toEqual({ ACME_POOL: 'false' });
	});

	it('trims a composite’s host and defaults its port and TLS flag', () => {
		const field = {
			kind: 'host-port',
			key: 'relay',
			label: 'Server host',
			envVar: 'ACME_HOST',
			portEnvVar: 'ACME_PORT',
			secureEnvVar: 'ACME_SECURE',
			portDefault: '2525',
			secureDefault: true,
		} as const;
		expect(credentialFieldEnv(field, { ACME_HOST: ' relay.acme.test ' })).toEqual({
			ACME_HOST: 'relay.acme.test',
			ACME_PORT: '2525',
			ACME_SECURE: 'true',
		});
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
			'EMAILIT_API_KEY',
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
			...FILLED_VALUES['emailit'],
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
				...FILLED_VALUES['emailit'],
			},
			'mailgun'
		);
		const env = buildProviderEnv({}, draft({ provider: kind, ...credentials }));
		expect(env).toEqual({ EMAIL_PROVIDER: kind, ...EXPECTED_ENV[kind] });
	});
});

/**
 * THE REVIEW STEP'S NAMES, as literals for the same reason the field labels
 * above are: this step summarises what the operator just chose, and the strings
 * it shows are the ones the shipped wizard shipped.
 */
describe('the review step names every choice as it always has', () => {
	const admin = { email: 'admin@example.com', name: 'Alex Operator', password: 'a-long-password' };
	const labelFor = (provider: string | undefined) =>
		buildSetupSummary(
			getDefaultFlags(),
			provider === undefined ? {} : { EMAIL_PROVIDER: provider },
			admin
		).providerLabel;

	it('keeps the own arm’s qualifier, which no catalog entry carries', () => {
		// `buildSetupSummary` runs at module scope, so the two names this step words
		// itself are message keys; the review step resolves them with `t()`.
		expect(t(labelFor('mta'))).toBe('Owlat MTA (self-hosted)');
	});

	it('takes every relay’s name from the catalog', () => {
		for (const entry of CORE_SEND_PROVIDER_CATALOG_ENTRIES) {
			if (entry.tier === 'own') continue;
			expect(t(labelFor(entry.kind))).toBe(entry.label);
		}
	});

	it('has its own word for no transport at all', () => {
		expect(t(labelFor(undefined))).toBe('None (receive-only)');
		expect(t(labelFor('not-a-transport'))).toBe('None (receive-only)');
	});
});

/**
 * THE ONE CREDENTIAL ERROR, for both surfaces at once.
 *
 * The transport editor and the wizard's credential step both need "the message
 * for the selected kind, whichever field set it belongs to". They used to spell
 * that out as an identical `errors.resendKey ?? errors.mandrillKey ?? …` chain
 * in two templates — per-vendor knowledge in a `.vue` file, duplicated, and
 * silently non-exhaustive: a new key rendered nowhere while Apply refused.
 */
describe('credentialErrorFor', () => {
	const filled: Record<string, Partial<EmailStepDraft>> = {
		mta: {},
		ses: { ses: { region: 'eu-west-1', accessKeyId: 'AKIA', secretAccessKey: 's' } },
		resend: { resendKey: 're_1' },
		smtp: {
			smtp: {
				preset: 'custom',
				host: 'smtp.acme.test',
				port: '',
				secure: false,
				username: 'u',
				password: 'p',
			},
		},
		mandrill: { mandrillKey: 'md-1' },
		emailit: { emailitKey: 'em_1' },
	};

	it.each(CATALOG_KINDS)('surfaces %s’s missing-credential message', (kind) => {
		const errors = validateEmailStep(draft({ provider: kind }));
		const message = credentialErrorFor(errors);
		// The own MTA collects no credential that can be missing; every relay does.
		if (kind === 'mta') expect(message).toBeUndefined();
		else expect(typeof message).toBe('string');
	});

	it.each(CATALOG_KINDS)('says nothing once %s’s credentials are filled in', (kind) => {
		expect(credentialErrorFor(validateEmailStep(draft({ provider: kind, ...filled[kind] })))).toBe(
			undefined
		);
	});

	it('ignores the errors that are not about credentials', () => {
		// A bad From address and a missing MTA identity both belong to other
		// controls on the screen; announcing either beside the API key would point
		// the operator at the wrong field.
		expect(credentialErrorFor({ fromEmail: 'bad address', mtaIdentity: 'no PTR' })).toBeUndefined();
		expect(credentialErrorFor({})).toBeUndefined();
	});
});
