import { describe, expect, it } from 'vitest';
import {
	DELIVERY_PROVIDER_KINDS,
	getSendPathRequiredEnv,
	isDeliveryProviderKind,
} from '../featureFlags';
import { OUTBOUND_TLS_MODES } from '../outboundTlsMode';
import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	OUTBOUND_TLS_MODE_OPTIONS,
	OWN_SEND_PROVIDER_KIND,
	SEND_PROVIDER_CREDENTIAL_FIELD_KINDS,
	SEND_TRANSPORT_KINDS,
	TRANSPORT_CREDENTIAL_ENV_KEYS,
	acceptanceSemanticsOf,
	coreSendProviderCatalogEntry,
	credentialFieldEnvVars,
	deduplicatesOnIdempotencyKeyOf,
	domainVerificationOf,
	hasProviderFeedbackOf,
	isCoreSendProviderKind,
	isOwnSendProviderKind,
	messageIdSourceOf,
	supportsCustomReturnPathOf,
	tagsFeedbackProvenanceOf,
	type CoreSendProviderCatalogEntry,
	type OwnSendProviderKind,
} from '../sendProviderCatalog';
import * as setupValidators from '../setupValidators';
import { PROVIDER_ENV_KEYS, SMTP_RELAY_PRESETS } from '../setupSendingPresets';

/**
 * THE SINGLE-SOURCE GATE for the seams plan's P1.1 / D1.
 *
 * The catalog moved into this package so that five separate declarations of the
 * same facts could become one. The risk that move carries is not that a table is
 * missing — a missing table fails to compile — but that a DERIVED table quietly
 * says something different from the literal it replaced. So every derivation is
 * pinned against a SNAPSHOT OF ITS PRE-MOVE VALUE, written out here as a literal
 * rather than computed from the catalog: a test that re-derived the expectation
 * would agree with any catalog, including a wrong one.
 *
 * The snapshots below are the values as they stood on `main` @ c3889fa2, in the
 * files they were taken from:
 *
 *   SEND_TRANSPORT_KINDS      packages/shared/src/transportAlignment.ts
 *   DELIVERY_PROVIDER_KINDS   packages/shared/src/featureFlags.ts
 *   getSendPathRequiredEnv    packages/shared/src/featureFlags.ts (the switch)
 *   PROVIDER_ENV_KEYS         packages/shared/src/setupSendingPresets.ts
 *   SMTP_RELAY_PRESETS        packages/shared/src/setupSendingPresets.ts
 *
 * ORDER IS ASSERTED WHERE IT WAS PRESERVED and stated explicitly where it was
 * not: `DELIVERY_PROVIDER_KINDS` and `PROVIDER_ENV_KEYS` were hand-written in
 * an order neither consumer reads (a membership check, and an iteration whose
 * result is consumed as key/value pairs), and both now follow catalog order. The
 * SET is pinned in both cases — nothing gained an entry, nothing lost one — and
 * the new order is pinned too, so a future reordering is still a visible change.
 */

/**
 * The entries under the shape a CONSUMER sees. The exported const keeps its
 * literal types (the backend's `ApiVerifiedSendProviderKind` guard extracts a
 * kind union out of them), and reading an optional field off that union is a
 * compile error for the entries that do not declare it — which is exactly the
 * widening every real caller does.
 */
const ENTRIES: readonly CoreSendProviderCatalogEntry[] = CORE_SEND_PROVIDER_CATALOG_ENTRIES;

/** The kind list exactly as `transportAlignment.ts` declared it pre-move. */
const KINDS_BEFORE = ['mta', 'ses', 'resend', 'smtp', 'mandrill'] as const;

/** The `getSendPathRequiredEnv` switch, arm for arm, pre-move. */
const SEND_PATH_REQUIRED_ENV_BEFORE: Record<string, string[]> = {
	mta: ['MTA_API_URL', 'MTA_API_KEY'],
	resend: ['RESEND_API_KEY'],
	ses: ['AWS_SES_REGION', 'AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY'],
	smtp: ['SMTP_RELAY_HOST', 'SMTP_RELAY_USERNAME', 'SMTP_RELAY_PASSWORD'],
	mandrill: ['MANDRILL_API_KEY'],
};

/** `PROVIDER_ENV_KEYS` as `setupSendingPresets.ts` declared it pre-move. */
const PROVIDER_ENV_KEYS_BEFORE = [
	'EMAIL_PROVIDER',
	'RESEND_API_KEY',
	'MANDRILL_API_KEY',
	'AWS_SES_REGION',
	'AWS_SES_ACCESS_KEY_ID',
	'AWS_SES_SECRET_ACCESS_KEY',
	'SMTP_RELAY_HOST',
	'SMTP_RELAY_PORT',
	'SMTP_RELAY_SECURE',
	'SMTP_RELAY_USERNAME',
	'SMTP_RELAY_PASSWORD',
	'OUTBOUND_TLS_MODE',
	'DEFAULT_FROM_EMAIL',
	'DEFAULT_FROM_NAME',
];

describe('the kind union is the catalog, and the catalog is the kind union', () => {
	it('SEND_TRANSPORT_KINDS is byte-identical to the tuple it replaced', () => {
		expect([...SEND_TRANSPORT_KINDS]).toEqual([...KINDS_BEFORE]);
	});

	it('derives it from the entries rather than beside them', () => {
		expect([...SEND_TRANSPORT_KINDS]).toEqual(ENTRIES.map((entry) => entry.kind));
	});

	it('DELIVERY_PROVIDER_KINDS covers the same SET (its order was never read)', () => {
		expect([...DELIVERY_PROVIDER_KINDS].sort()).toEqual([...KINDS_BEFORE].sort());
		expect([...DELIVERY_PROVIDER_KINDS]).toEqual([...SEND_TRANSPORT_KINDS]);
	});

	it('recognises every declared kind and nothing else', () => {
		for (const kind of KINDS_BEFORE) {
			expect(isCoreSendProviderKind(kind)).toBe(true);
			expect(isDeliveryProviderKind(kind)).toBe(true);
		}
		for (const other of ['sendgrid', '', 'MTA', 'plugin.acme.postmark', undefined]) {
			expect(isCoreSendProviderKind(other)).toBe(false);
			expect(isDeliveryProviderKind(other)).toBe(false);
		}
	});

	it('never answers from an inherited property', () => {
		// `catalogByKind` is a Map, not an object literal — but the predicate is
		// what routing and the setup surfaces gate on, so prove it.
		for (const inherited of ['constructor', '__proto__', 'toString']) {
			expect(isCoreSendProviderKind(inherited)).toBe(false);
			expect(coreSendProviderCatalogEntry(inherited)).toBeUndefined();
		}
	});
});

describe('getSendPathRequiredEnv is the catalog’s requiredEnvVars', () => {
	it.each(Object.entries(SEND_PATH_REQUIRED_ENV_BEFORE))(
		'%s returns the pre-move list, in order',
		(kind, expected) => {
			expect(getSendPathRequiredEnv(kind)).toEqual(expected);
		}
	);

	it('still returns [] for an unset or unknown provider (no implicit default)', () => {
		expect(getSendPathRequiredEnv(undefined)).toEqual([]);
		expect(getSendPathRequiredEnv('')).toEqual([]);
		expect(getSendPathRequiredEnv('sendgrid')).toEqual([]);
	});

	it('hands back a fresh mutable array, never the frozen declaration', () => {
		const first = getSendPathRequiredEnv('mta');
		first.push('MUTATED');
		expect(getSendPathRequiredEnv('mta')).toEqual(SEND_PATH_REQUIRED_ENV_BEFORE['mta']);
	});
});

describe('PROVIDER_ENV_KEYS is derived from the credential fields', () => {
	it('covers exactly the pre-move set — nothing added, nothing dropped', () => {
		expect([...PROVIDER_ENV_KEYS].sort()).toEqual([...PROVIDER_ENV_KEYS_BEFORE].sort());
	});

	it('is the catalog order, with the three keys that belong to no kind around it', () => {
		expect([...PROVIDER_ENV_KEYS]).toEqual([
			'EMAIL_PROVIDER',
			'OUTBOUND_TLS_MODE',
			'AWS_SES_REGION',
			'AWS_SES_ACCESS_KEY_ID',
			'AWS_SES_SECRET_ACCESS_KEY',
			'RESEND_API_KEY',
			'SMTP_RELAY_HOST',
			'SMTP_RELAY_PORT',
			'SMTP_RELAY_SECURE',
			'SMTP_RELAY_USERNAME',
			'SMTP_RELAY_PASSWORD',
			'MANDRILL_API_KEY',
			'DEFAULT_FROM_EMAIL',
			'DEFAULT_FROM_NAME',
		]);
	});

	it('KEEPS OUT the variables that are required to send but are not form fields', () => {
		// The clear-then-set rule makes this a real hazard rather than tidiness:
		// every key in this list is unset on every transport apply. `MTA_API_URL` /
		// `MTA_API_KEY` are the installer's, and `MANDRILL_WEBHOOK_KEY` is issued
		// after the transport is connected — admitting either would let a Resend
		// key rotation tear down a working MTA or a working feedback loop.
		for (const key of [
			'MTA_API_URL',
			'MTA_API_KEY',
			'MTA_WEBHOOK_SECRET',
			'MANDRILL_WEBHOOK_KEY',
			'MANDRILL_SUBACCOUNT',
			'MANDRILL_IP_POOL',
			'RESEND_WEBHOOK_SECRET',
		]) {
			expect(PROVIDER_ENV_KEYS, key).not.toContain(key);
			// ...and each of them IS declared by its kind, so the exclusion is the
			// catalog answering a different question, not the catalog forgetting.
			const declared = ENTRIES.flatMap((entry) => [
				...entry.requiredEnvVars,
				...(entry.optionalEnvVars ?? []),
			]);
			expect(declared, key).toContain(key);
		}
	});

	it('TRANSPORT_CREDENTIAL_ENV_KEYS is exactly the fields’ env vars', () => {
		const walked = ENTRIES.flatMap((entry) =>
			entry.credentialFields.flatMap((field) => credentialFieldEnvVars(field))
		);
		expect([...TRANSPORT_CREDENTIAL_ENV_KEYS]).toEqual(walked);
	});

	it('describes every field in the declared vocabulary, and marks required on `envVar` only', () => {
		const vocabulary = new Set<string>(SEND_PROVIDER_CREDENTIAL_FIELD_KINDS);
		for (const entry of ENTRIES) {
			const required = new Set(entry.requiredEnvVars);
			for (const field of entry.credentialFields) {
				expect(vocabulary, `${entry.kind}/${field.key}`).toContain(field.kind);
				// `required` qualifies `envVar` and nothing else: it says that ONE
				// variable is in `requiredEnvVars`. A composite's secondary variables
				// carry declared defaults and stay optional either way — the rule
				// P1.3's consistency guard should encode, pinned here so it is a rule
				// about the shipped catalog rather than a sentence in a docblock.
				expect(required.has(field.envVar), `${entry.kind}/${field.key}`).toBe(
					field.required === true
				);
				if (field.kind === 'host-port') {
					for (const name of [field.portEnvVar, field.secureEnvVar]) {
						expect(required.has(name), `${entry.kind}/${name}`).toBe(false);
						expect(entry.optionalEnvVars ?? [], `${entry.kind}/${name}`).toContain(name);
					}
				}
			}
		}
	});

	it('gives the composite endpoint field all three of its variables', () => {
		// A `host-port` descriptor that answered with `envVar` alone would leave
		// SMTP_RELAY_PORT / SMTP_RELAY_SECURE outside the apply endpoint's
		// allowlist — unsettable by the very editor that renders them.
		const smtp = coreSendProviderCatalogEntry('smtp');
		const endpoint = smtp?.credentialFields.find((field) => field.kind === 'host-port');
		expect(endpoint, 'the smtp entry no longer declares an endpoint field').toBeDefined();
		expect(credentialFieldEnvVars(endpoint!)).toEqual([
			'SMTP_RELAY_HOST',
			'SMTP_RELAY_PORT',
			'SMTP_RELAY_SECURE',
		]);
	});
});

describe('the entries themselves', () => {
	it('declares every kind exactly once', () => {
		expect(new Set(SEND_TRANSPORT_KINDS).size).toBe(SEND_TRANSPORT_KINDS.length);
	});

	it('has exactly one `own` tier — the D3 identity that legitimately exists', () => {
		const own = ENTRIES.filter((entry) => entry.tier === 'own');
		expect(own.map((entry) => entry.kind)).toEqual(['mta']);
	});

	it('declares no bundled-plugin entries (the backend composes those)', () => {
		for (const entry of ENTRIES) {
			expect(entry.tier, entry.kind).not.toBe('plugin');
		}
	});

	it('gives every required env var a form field, or a stated reason it has none', () => {
		// A required variable with no field is a variable an operator cannot enter
		// through the UI. That is TRUE of the MTA's two (the installer writes
		// them), and of nothing else — a new relay that forgets its field would
		// otherwise ship a transport nobody can configure.
		for (const entry of ENTRIES) {
			const fieldVars = new Set(
				entry.credentialFields.flatMap((field) => credentialFieldEnvVars(field))
			);
			const missing = entry.requiredEnvVars.filter((name) => !fieldVars.has(name));
			expect(missing, entry.kind).toEqual(
				entry.kind === 'mta' ? ['MTA_API_URL', 'MTA_API_KEY'] : []
			);
		}
	});

	it('gives every field a unique key within its own form', () => {
		for (const entry of ENTRIES) {
			const keys = entry.credentialFields.map((field) => field.key);
			expect(new Set(keys).size, entry.kind).toBe(keys.length);
		}
	});

	it('never writes the same env var from two different fields', () => {
		const all = [...TRANSPORT_CREDENTIAL_ENV_KEYS];
		expect(new Set(all).size).toBe(all.length);
	});

	it('offers every outbound-TLS mode the backend accepts', () => {
		// The MTA's only form field is a select over another module's union. A
		// missing option is a floor an operator cannot choose; an extra one is a
		// value the backend rejects (the `satisfies` in the catalog catches that
		// half at compile time, this catches the other).
		const mta = coreSendProviderCatalogEntry('mta');
		const select = mta?.credentialFields.find((field) => field.kind === 'select');
		expect(select, 'the mta entry no longer declares its TLS select').toBeDefined();
		expect(select!.kind === 'select' ? select!.options.map((o) => o.value) : []).toEqual([
			...OUTBOUND_TLS_MODES,
		]);
		// ...and the exported list IS that field's option list, not a parallel one.
		// `apps/web/app/composables/setupOutboundTls.ts` maps this export and adds
		// only its `hint` copy, so the selector the wizard renders and the
		// descriptor the catalog declares cannot disagree about a label.
		expect(select!.kind === 'select' ? select!.options : []).toEqual([
			...OUTBOUND_TLS_MODE_OPTIONS,
		]);
	});

	it('names a real validator on every setup probe, and only where one exists', () => {
		const probes = ENTRIES.filter((entry) => entry.setupProbe !== undefined);
		// The literal, pinned: which kinds can be checked before applying is a
		// product decision, and a probe appearing on SES (which has no cheap
		// pre-apply check) should be a test failure rather than a UI surprise.
		expect(probes.map((entry) => [entry.kind, entry.setupProbe?.validator])).toEqual([
			['resend', 'validateResendKey'],
			['smtp', 'validateSmtpRelay'],
		]);
		// ...and the OTHER direction, which the literal cannot give: the name has
		// to resolve to something callable in the module the descriptor points at.
		// Pinning the string alone would pass a typo (`validateResendKeys`) and a
		// later rename in `../setupValidators` straight through to P1.3, which
		// inherits a descriptor addressing nothing.
		const exported = setupValidators as unknown as Record<string, unknown>;
		for (const entry of probes) {
			expect(typeof exported[entry.setupProbe!.validator], entry.kind).toBe('function');
		}
	});

	it('gives the own arm a derived declaration rather than a comparison to copy', () => {
		// D3's one sanctioned identity, as a value: `tier: 'own'` is the
		// declaration and this is what a consumer reads. `apps/web`,
		// `apps/setup-cli` and this package restated `=== 'mta'` in seven places
		// before it existed, because the only declaration lived in Convex code they
		// may not import.
		expect(OWN_SEND_PROVIDER_KIND).toBe('mta');
		expect(ENTRIES.find((entry) => entry.tier === 'own')?.kind).toBe(OWN_SEND_PROVIDER_KIND);
		expect(isOwnSendProviderKind(OWN_SEND_PROVIDER_KIND)).toBe(true);
		// The TYPE is the literal too, not the wide kind union — that is what lets
		// the backend's `OWN_ARM_TRANSPORT_KIND` be a re-export of this constant
		// while the three compile-time guards keyed off its literal type keep
		// working. `OwnSendProviderKind` is not assignable from any other kind, so
		// this line stops compiling if the annotation widens.
		const ownKind: OwnSendProviderKind = OWN_SEND_PROVIDER_KIND;
		expect(ownKind).toBe(OWN_SEND_PROVIDER_KIND);
		for (const other of ['ses', 'resend', 'smtp', 'mandrill', 'MTA', '', undefined, null]) {
			expect(isOwnSendProviderKind(other), String(other)).toBe(false);
		}
	});
});

describe('the fail-closed defaults are code, not just docblocks', () => {
	/**
	 * Every capability field is optional and every absent value MEANS something —
	 * and the meaning is the SAFE reading in each case. These accessors are that
	 * rule, in one place, taking an entry so the backend (which resolves against
	 * the composed core+plugin catalog) and web/CLI (which resolve against the
	 * core one) apply the same rule through their own lookups.
	 */
	const UNDECLARED = {
		kind: 'plugin.acme.postmark',
		label: 'Postmark',
		retryDelays: [],
		requiredEnvVars: [],
	} as const;

	it('reads an entry that declares nothing at its fail-closed value', () => {
		expect(supportsCustomReturnPathOf(UNDECLARED)).toBe('no');
		expect(domainVerificationOf(UNDECLARED)).toBe('none');
		expect(hasProviderFeedbackOf(UNDECLARED)).toBe(false);
		expect(acceptanceSemanticsOf(UNDECLARED)).toBe('unknown-on-timeout');
		expect(messageIdSourceOf(UNDECLARED)).toBe('provider');
		expect(deduplicatesOnIdempotencyKeyOf(UNDECLARED)).toBe(false);
		expect(tagsFeedbackProvenanceOf(UNDECLARED)).toBe(false);
	});

	it('reads an ABSENT entry the same way — an unknown kind has declared nothing', () => {
		// The reading a consumer gets for a kind this catalog does not know: web
		// and the CLI hold `coreSendProviderCatalogEntry` results, which are
		// `undefined` for a bundled plugin kind they cannot see. Crediting such a
		// kind with a capability is exactly what the defaults exist to prevent.
		expect(supportsCustomReturnPathOf(undefined)).toBe('no');
		expect(domainVerificationOf(undefined)).toBe('none');
		expect(hasProviderFeedbackOf(undefined)).toBe(false);
		expect(acceptanceSemanticsOf(undefined)).toBe('unknown-on-timeout');
		expect(messageIdSourceOf(undefined)).toBe('provider');
		expect(deduplicatesOnIdempotencyKeyOf(undefined)).toBe(false);
		expect(tagsFeedbackProvenanceOf(undefined)).toBe(false);
	});

	it('hands back what a core entry actually declares, default or not', () => {
		const mta = coreSendProviderCatalogEntry('mta');
		expect(acceptanceSemanticsOf(mta)).toBe('accepted');
		expect(messageIdSourceOf(mta)).toBe('idempotency-key');
		expect(hasProviderFeedbackOf(mta)).toBe(true);
		expect(tagsFeedbackProvenanceOf(mta)).toBe(true);
		const ses = coreSendProviderCatalogEntry('ses');
		expect(domainVerificationOf(ses)).toBe('api');
		expect(supportsCustomReturnPathOf(ses)).toBe('no');
		expect(deduplicatesOnIdempotencyKeyOf(ses)).toBe(false);
		expect(supportsCustomReturnPathOf(coreSendProviderCatalogEntry('smtp'))).toBe('probe');
	});
});

describe('the SMTP presets are the endpoint field’s data', () => {
	it('is byte-identical to the table it replaced', () => {
		expect(SMTP_RELAY_PRESETS).toEqual({
			mailgun: { label: 'Mailgun', host: 'smtp.mailgun.org', port: '587', secure: false },
			postmark: { label: 'Postmark', host: 'smtp.postmarkapp.com', port: '587', secure: false },
			sendgrid: { label: 'SendGrid', host: 'smtp.sendgrid.net', port: '587', secure: false },
			brevo: { label: 'Brevo', host: 'smtp-relay.brevo.com', port: '587', secure: false },
			custom: { label: 'Custom SMTP server', host: '', port: '587', secure: false },
		});
	});

	it('is the very table the smtp entry attaches, not a second copy', () => {
		const smtp = coreSendProviderCatalogEntry('smtp');
		const endpoint = smtp?.credentialFields.find((field) => field.kind === 'host-port');
		expect(endpoint?.kind === 'host-port' ? endpoint.presets : undefined).toBe(SMTP_RELAY_PRESETS);
	});

	it('carries the endpoint defaults the form falls back to', () => {
		const smtp = coreSendProviderCatalogEntry('smtp');
		const endpoint = smtp?.credentialFields.find((field) => field.kind === 'host-port');
		expect(endpoint?.kind === 'host-port' ? endpoint.portDefault : undefined).toBe('587');
		expect(endpoint?.kind === 'host-port' ? endpoint.secureDefault : undefined).toBe(false);
	});
});

describe('the module stays data only — it ships to the browser', () => {
	it('declares env NAMES and never a value that looks like a credential', () => {
		const serialized = JSON.stringify(ENTRIES);
		// `re_...` and `md-...` are placeholders and stay; a real key would not be
		// three characters long. AKIA-prefixed access keys and PEM blocks have no
		// placeholder form at all, so any occurrence is the real thing.
		for (const shape of [/AKIA[A-Z0-9]{8}/, /BEGIN [A-Z ]*PRIVATE KEY/, /re_[A-Za-z0-9]{8}/]) {
			expect(shape.test(serialized), String(shape)).toBe(false);
		}
	});

	it('carries no functions — a descriptor is data, and data is what a bundle may hold', () => {
		const walk = (value: unknown): void => {
			if (typeof value === 'function') expect.unreachable('the catalog carries a function');
			if (Array.isArray(value)) {
				for (const item of value) walk(item);
				return;
			}
			if (value && typeof value === 'object') {
				for (const item of Object.values(value)) walk(item);
			}
		};
		walk(ENTRIES);
	});
});
