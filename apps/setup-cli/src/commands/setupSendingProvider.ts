/**
 * Terminal-wizard picker for the instance-level outbound transport.
 *
 * One deployment sends through exactly one transport: its own MTA or one of the
 * relays. Extracted from `setup.ts` so that file stays focused and under the
 * size ratchet; the web wizard's equivalent lives in
 * `apps/web/app/pages/setup/email.vue`.
 *
 * The picker reads the send-provider catalog and names no provider: the choices
 * are the kinds a setup config can carry, the prompts are each entry's REQUIRED
 * credential fields in declaration order (an optional field such as the MTA's
 * TLS floor keeps its backend default, as it always has here), and the values
 * are written to the env variables those fields name. The wording lives in
 * `./setupSendingProviderCopy`.
 *
 * Credential-bearing choices are validated for real before they are persisted,
 * through the probe the entry's `setupProbe` names (Resend key request, SMTP
 * handshake + AUTH), so an operator finds a bad host/port/credential here rather
 * than at first send.
 */

import { select, password, text, confirm, isCancel } from '@clack/prompts';
import type {
	CoreSendProviderCatalogEntry,
	SendProviderCredentialField,
	SendProviderHostPortField,
} from '@owlat/shared/sendProviderCatalog';
import type { SendingConfig } from '@owlat/shared/setupConfigTypes';
import {
	SETUP_SENDING_CATALOG_ENTRIES,
	sendingConfigFromCredentials,
	type SetupSendingKind,
} from '@owlat/shared/setupSendingConfig';
import type { SetupProbeValidator } from '@owlat/shared/setupValidators';
import { validateWithSpinner } from '../lib/progress';
import { type EnvMap } from '../lib/env';
import {
	validateEmailitKey,
	validateResendKey,
	validateSmtpRelay,
	type ValidationResult,
} from '../lib/validators';
import { endpointPrompt, fieldPrompt, pickerOption } from './setupSendingProviderCopy';

/** A relay port is optional (blank means the field's default), but if given must
 * parse to a real port — mirrors the web step's `isValidSmtpPort`. Returns an
 * error string for clack's `validate:` when invalid. */
function portValidator(portDefault: string): (value: string | undefined) => string | undefined {
	return (value) => {
		const trimmed = (value ?? '').trim();
		if (trimmed === '') return undefined;
		if (!/^\d+$/.test(trimmed)) return `Port must be digits only (leave blank for ${portDefault}).`;
		const n = Number.parseInt(trimmed, 10);
		if (n < 1 || n > 65535) return 'Port must be between 1 and 65535.';
		return undefined;
	};
}

/** Reject an empty required field at the prompt instead of deferring to the
 * network probe (matches the web step, which blocks empty fields client-side). */
function requireNonEmpty(label: string): (value: string | undefined) => string | undefined {
	return (value) => ((value ?? '').trim() === '' ? `${label} is required.` : undefined);
}

/** Collected values, keyed by the env variable each field writes. */
type CredentialValues = Record<string, string>;

/** Reads one string property of a mapped sending config. */
function configText(config: SendingConfig, key: string): string {
	const value = (config as unknown as Readonly<Record<string, unknown>>)[key];
	return typeof value === 'string' ? value : '';
}

/**
 * One probe per validator name the catalog declares, worded per validator. The
 * `satisfies` fails the build when an entry names a validator with no row here.
 */
const SETUP_PROBES = {
	validateResendKey: {
		spinner: (label: string) => `Validating ${label} key`,
		run: (config: SendingConfig) => validateResendKey(configText(config, 'apiKey')),
	},
	validateEmailitKey: {
		spinner: (label: string) => `Validating ${label} key`,
		run: (config: SendingConfig) => validateEmailitKey(configText(config, 'apiKey')),
	},
	validateSmtpRelay: {
		spinner: (label: string) => `Validating ${label}`,
		run: (config: SendingConfig) => {
			const props = config as unknown as Readonly<Record<string, unknown>>;
			return validateSmtpRelay({
				host: configText(config, 'host'),
				port: typeof props['port'] === 'number' ? props['port'] : 587,
				secure: props['secure'] === true,
				username: configText(config, 'username'),
				password: configText(config, 'password'),
			});
		},
	},
} satisfies Record<
	SetupProbeValidator,
	{
		spinner: (label: string) => string;
		run: (config: SendingConfig) => Promise<ValidationResult>;
	}
>;

/**
 * Prompts one single-value field into `values`, with the control its field kind
 * calls for. Returns false on cancel. A secret is stored verbatim, as the web
 * credential form stores it; typed text is trimmed, so the value that is probed
 * is the value that is written.
 */
async function promptField(
	entry: CoreSendProviderCatalogEntry,
	field: Exclude<SendProviderCredentialField, SendProviderHostPortField>,
	values: CredentialValues
): Promise<boolean> {
	const copy = fieldPrompt(entry, field);
	const validate = field.required ? requireNonEmpty(copy.message) : undefined;
	let answer: string | boolean | symbol;
	if (field.kind === 'secret') {
		answer = await password({ message: copy.message, validate });
	} else if (field.kind === 'boolean') {
		answer = await confirm({ message: copy.message, initialValue: field.default ?? false });
	} else if (field.kind === 'select' || (field.kind === 'region-select' && field.options)) {
		answer = await select({
			message: copy.message,
			options: (field.options ?? []).map((option) => ({
				value: option.value,
				label: option.value,
			})),
			initialValue: field.default,
		});
	} else {
		const placeholder =
			copy.placeholder ?? ('placeholder' in field ? field.placeholder : undefined);
		answer = await text({
			message: copy.message,
			placeholder,
			validate: field.kind === 'number' ? numberValidator(validate) : validate,
		});
	}
	if (isCancel(answer)) return false;
	values[field.envVar] =
		typeof answer === 'boolean' ? String(answer) : field.kind === 'secret' ? answer : answer.trim();
	return true;
}

/** A number field accepts blank (when optional) or a finite number. */
function numberValidator(
	required: ((value: string | undefined) => string | undefined) | undefined
): (value: string | undefined) => string | undefined {
	return (value) => {
		const missing = required?.(value);
		if (missing !== undefined) return missing;
		const trimmed = (value ?? '').trim();
		return trimmed === '' || Number.isFinite(Number(trimmed)) ? undefined : 'Enter a number.';
	};
}

/**
 * Prompts a relay endpoint: an optional preset, then host, port and implicit TLS.
 * Port and TLS are always written, so a re-run of setup over an existing install
 * cannot leave a stale port (setup.ts applies the result with
 * `mergeEnv(existing, patch)`) that differs from the one the probe just checked.
 */
async function promptEndpoint(
	entry: CoreSendProviderCatalogEntry,
	field: SendProviderHostPortField,
	values: CredentialValues
): Promise<boolean> {
	const copy = endpointPrompt(entry, field);
	let defaults = { host: '', port: field.portDefault, secure: field.secureDefault };
	if (field.presets) {
		const presets = field.presets;
		const preset = await select({
			message: copy.preset,
			options: Object.entries(presets).map(([value, row]) => ({ label: row.label, value })),
		});
		if (isCancel(preset)) return false;
		defaults = presets[preset] ?? defaults;
	}

	const host = await text({
		message: copy.host.message,
		placeholder: defaults.host || copy.host.placeholder || field.placeholder,
		initialValue: defaults.host,
		validate: field.required ? requireNonEmpty(copy.host.message) : undefined,
	});
	if (isCancel(host)) return false;
	const port = await text({
		message: copy.port,
		placeholder: field.portDefault,
		initialValue: defaults.port,
		validate: portValidator(field.portDefault),
	});
	if (isCancel(port)) return false;
	const secure = await confirm({ message: copy.secure, initialValue: defaults.secure });
	if (isCancel(secure)) return false;

	const trimmedPort = port.trim();
	values[field.envVar] = host.trim();
	values[field.portEnvVar] = String(
		Number.parseInt(trimmedPort === '' ? field.portDefault : trimmedPort, 10)
	);
	values[field.secureEnvVar] = secure ? 'true' : 'false';
	return true;
}

/** Runs the entry's catalog probe on the collected values. True when it passes. */
async function probe(
	entry: CoreSendProviderCatalogEntry,
	values: CredentialValues
): Promise<boolean> {
	const validator = entry.setupProbe?.validator as SetupProbeValidator | undefined;
	if (validator === undefined || !Object.hasOwn(SETUP_PROBES, validator)) return true;
	const mapped = sendingConfigFromCredentials(
		entry.kind as SetupSendingKind,
		(envVar) => values[envVar]
	);
	// Every check the mapper makes (blank required value, port range, declared
	// option) already ran at the prompt, so a refusal here means nothing to probe.
	if (!mapped.ok) return false;
	const config = mapped.config;
	const { spinner, run } = SETUP_PROBES[validator];
	return validateWithSpinner(spinner(entry.label), () => run(config));
}

export async function pickSendingProvider(): Promise<EnvMap | null> {
	const kind = await select({
		message: 'Email sending provider',
		options: SETUP_SENDING_CATALOG_ENTRIES.map((entry) => ({
			value: entry.kind,
			...pickerOption(entry),
		})),
	});
	if (isCancel(kind)) return null;
	const entry = SETUP_SENDING_CATALOG_ENTRIES.find((e) => e.kind === kind);
	if (entry === undefined) return null;

	const values: CredentialValues = {};
	for (const field of entry.credentialFields) {
		if (!field.required) continue;
		const answered =
			field.kind === 'host-port'
				? await promptEndpoint(entry, field, values)
				: await promptField(entry, field, values);
		if (!answered) return null;
	}
	if (!(await probe(entry, values))) return null;
	return { EMAIL_PROVIDER: entry.kind, ...values };
}
