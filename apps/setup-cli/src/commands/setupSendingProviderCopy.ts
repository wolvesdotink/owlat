/**
 * The terminal wording of the sending-provider picker.
 *
 * The catalog's own field labels are message keys for the web form, which this
 * CLI cannot resolve, so the terminal keeps its own English copy here. WHICH
 * prompts run, and in which order, still comes from the catalog entry: this
 * module only words them. A kind or a field with no row here still gets asked,
 * under a label built from the catalog (the entry's name, the field's env
 * variable), so a new provider needs no edit in this file to be set up.
 */

import {
	isOwnSendProviderKind,
	type CoreSendProviderCatalogEntry,
	type SendProviderCredentialField,
	type SendProviderHostPortField,
} from '@owlat/shared/sendProviderCatalog';
import type { SetupSendingKind } from '@owlat/shared/setupSendingConfig';

/** One single-value prompt's wording. */
export interface FieldPromptCopy {
	readonly message: string;
	/** Overrides the field's catalog placeholder. */
	readonly placeholder?: string;
}

/** The wording of the prompts a `host-port` endpoint field expands into. */
export interface EndpointPromptCopy {
	/** The preset picker, shown when the field carries presets. */
	readonly preset: string;
	readonly host: FieldPromptCopy;
	readonly port: string;
	readonly secure: string;
}

/** The own MTA's picker row: it is the one choice that needs no third party. */
const OWN_PICKER_OPTION = { label: 'Run your own MTA (self-hosted)', hint: 'no third-party' };

/** Picker hints for the relays; a kind without one shows its catalog label alone. */
const PICKER_HINTS: Partial<Record<SetupSendingKind, string>> = {
	ses: 'managed, needs an AWS account',
	smtp: 'Mailgun / Postmark / SendGrid / Brevo / custom',
	resend: 'managed API',
	emailit: 'managed API',
};

/** Single-value prompts, keyed by the env variable the field writes. */
const FIELD_PROMPTS: Readonly<Record<string, FieldPromptCopy>> = {
	RESEND_API_KEY: { message: 'Resend API key (re_...)' },
	EMAILIT_API_KEY: { message: 'Emailit API key' },
	AWS_SES_REGION: { message: 'AWS SES region' },
	AWS_SES_ACCESS_KEY_ID: { message: 'AWS_ACCESS_KEY_ID' },
	AWS_SES_SECRET_ACCESS_KEY: { message: 'AWS_SECRET_ACCESS_KEY' },
	SMTP_RELAY_USERNAME: { message: 'SMTP username' },
	SMTP_RELAY_PASSWORD: { message: 'SMTP password' },
};

/** Endpoint prompts, keyed by the env variable the field's host writes. */
const ENDPOINT_PROMPTS: Readonly<Record<string, EndpointPromptCopy>> = {
	SMTP_RELAY_HOST: {
		preset: 'SMTP relay provider',
		host: { message: 'SMTP host', placeholder: 'smtp.example.com' },
		port: 'SMTP port',
		secure: 'Use implicit TLS (port 465)? No = STARTTLS on 587',
	},
};

export function pickerOption(entry: CoreSendProviderCatalogEntry): {
	label: string;
	hint?: string;
} {
	if (isOwnSendProviderKind(entry.kind)) return OWN_PICKER_OPTION;
	const hint = PICKER_HINTS[entry.kind as SetupSendingKind];
	return hint === undefined ? { label: entry.label } : { label: entry.label, hint };
}

export function fieldPrompt(
	entry: CoreSendProviderCatalogEntry,
	field: Exclude<SendProviderCredentialField, SendProviderHostPortField>
): FieldPromptCopy {
	return FIELD_PROMPTS[field.envVar] ?? { message: `${entry.label} ${field.envVar}` };
}

export function endpointPrompt(
	entry: CoreSendProviderCatalogEntry,
	field: SendProviderHostPortField
): EndpointPromptCopy {
	return (
		ENDPOINT_PROMPTS[field.envVar] ?? {
			preset: `${entry.label} preset`,
			host: { message: field.envVar },
			port: field.portEnvVar,
			secure: `${field.secureEnvVar}: use implicit TLS?`,
		}
	);
}
