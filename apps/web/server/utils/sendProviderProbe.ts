/**
 * The pre-apply send-provider probe, shared by both endpoints that run it:
 * `POST /api/delivery/validate-transport` (the transport editor, behind the
 * org-admin gate) and `POST /api/setup/validate-provider` (the setup wizard,
 * behind setup mode and the setup token). Only the gate differs between them;
 * the request body, its 400s and the dispatch live here.
 *
 * WHICH kinds can be probed, and with which validator, is the catalog's
 * `setupProbe` declaration. This module reads that declaration and maps the
 * validator NAME to a call, so it never compares a provider kind to a literal:
 * a new probe-capable kind needs a catalog entry, and a new validator also needs
 * one row in `PROBE_RUNNERS` (the `satisfies` below fails the build until it
 * has one).
 */

import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	coreSendProviderCatalogEntry,
	type CoreSendProviderCatalogEntry,
} from '@owlat/shared/sendProviderCatalog';
import {
	validateEmailitKey,
	validateResendKey,
	validateSmtpRelay,
	type SmtpRelayInput,
	type ValidationResult,
} from '@owlat/shared/setupValidators';

/** A probe request body after its shape has been checked. */
export interface ProbeInput {
	provider: string;
	apiKey?: string;
	/** Only the setup wizard's PostHog check reads it. */
	host?: string;
	smtp?: Partial<SmtpRelayInput>;
}

/** Every validator name a core catalog entry declares, as a literal union. */
type SetupProbeValidator = Extract<
	(typeof CORE_SEND_PROVIDER_CATALOG_ENTRIES)[number],
	{ readonly setupProbe: { readonly validator: string } }
>['setupProbe']['validator'];

function badRequest(message: string): Error {
	return createError({ statusCode: 400, message });
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Reads a probe body. Only `provider` is required here: which of `apiKey` and
 * `smtp` a request needs depends on the validator it reaches, so those checks
 * run at dispatch ({@link requireApiKey}, {@link requireSmtpRelay}).
 */
export function parseProbeBody(body: unknown): ProbeInput {
	const raw = (body ?? {}) as Record<string, unknown>;
	const provider = optionalString(raw['provider']);
	if (provider === undefined) {
		throw badRequest('provider is required.');
	}
	const smtp = raw['smtp'];
	return {
		provider,
		apiKey: optionalString(raw['apiKey']),
		host: optionalString(raw['host']),
		smtp: smtp !== null && typeof smtp === 'object' ? (smtp as Partial<SmtpRelayInput>) : undefined,
	};
}

/** The API key an API-key validator needs, or the 400 saying it is missing. */
export function requireApiKey(input: ProbeInput): string {
	if (input.apiKey === undefined) {
		throw badRequest('apiKey is required.');
	}
	return input.apiKey;
}

/**
 * The SMTP relay block, normalised: port defaults to 587 and `secure` is true
 * only when the caller said so.
 *
 * A present but non-numeric port fails instead of being coerced to 587, which
 * would report a result for a different port than the caller asked about.
 */
export function requireSmtpRelay(input: ProbeInput): SmtpRelayInput {
	const smtp = input.smtp;
	if (!smtp?.host || !smtp.username || !smtp.password) {
		throw badRequest('smtp.host, smtp.username, and smtp.password are required.');
	}
	if (smtp.port !== undefined && typeof smtp.port !== 'number') {
		throw badRequest('smtp.port must be a number.');
	}
	return {
		host: smtp.host,
		port: smtp.port ?? 587,
		secure: smtp.secure === true,
		username: smtp.username,
		password: smtp.password,
	};
}

/**
 * One runner per validator name the catalog declares. The `satisfies` clause is
 * the type-level check both ways: a declared validator with no runner, or a
 * runner for a name no entry declares, does not compile.
 */
const PROBE_RUNNERS = {
	validateResendKey: (input: ProbeInput) => validateResendKey(requireApiKey(input)),
	validateEmailitKey: (input: ProbeInput) => validateEmailitKey(requireApiKey(input)),
	validateSmtpRelay: (input: ProbeInput) => validateSmtpRelay(requireSmtpRelay(input)),
} satisfies Record<SetupProbeValidator, (input: ProbeInput) => Promise<ValidationResult>>;

function probeRunner(kind: string): ((input: ProbeInput) => Promise<ValidationResult>) | undefined {
	const validator = coreSendProviderCatalogEntry(kind)?.setupProbe?.validator;
	if (validator === undefined || !Object.hasOwn(PROBE_RUNNERS, validator)) return undefined;
	return PROBE_RUNNERS[validator as SetupProbeValidator];
}

/** True when the catalog declares a pre-apply probe for this kind. */
export function hasSendProviderProbe(kind: string): boolean {
	return probeRunner(kind) !== undefined;
}

/** The refusal for a kind with no probe, naming the kinds that have one. */
export function noProbeMessage(kind: string): string {
	const entries: readonly CoreSendProviderCatalogEntry[] = CORE_SEND_PROVIDER_CATALOG_ENTRIES;
	const testable = entries
		.filter((entry) => entry.setupProbe !== undefined)
		.map((entry) => entry.label);
	const list = new Intl.ListFormat('en', { type: 'conjunction' }).format(testable);
	const label = coreSendProviderCatalogEntry(kind)?.label ?? 'this provider';
	return `Only ${list} can be tested before applying. Apply the change, then use "Send a test email" to confirm ${label}.`;
}

/**
 * Runs the catalog-declared probe for `kind`, or answers 400 when the kind has
 * none (SES, Mandrill and the built-in MTA are proven by a test send after
 * applying).
 */
export async function runSendProviderProbe(
	kind: string,
	input: ProbeInput
): Promise<ValidationResult> {
	const run = probeRunner(kind);
	if (run === undefined) {
		throw badRequest(noProbeMessage(kind));
	}
	return run(input);
}
