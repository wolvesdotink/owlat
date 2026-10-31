import { describe, it, expect } from 'vitest';
import { SETUP_SENDING_CATALOG_ENTRIES } from '@owlat/shared/setupSendingConfig';
import { buildEnvPatchFromConfig, parseSetupConfig } from '../setupConfig';

/**
 * Operators keep the `--config` files they wrote. The `sending` block is read
 * and written through the catalog's credential fields now, so these pin what
 * the v0.6.16 CLI accepted and wrote for each shipped kind: the same config must
 * still parse, produce exactly the same env keys and values, and be refused with
 * the same field-named messages.
 */

function config(sending: unknown): Record<string, unknown> {
	return {
		version: 1,
		deploymentMode: 'selfhost',
		features: {},
		sending,
		admin: { email: 'admin@example.com', name: 'Admin', password: 'longenoughpw!' },
	};
}

/** [label, v0.6.16 `sending` block, the env the v0.6.16 CLI wrote for it]. */
const SHIPPED: Array<[string, Record<string, unknown>, Record<string, string>]> = [
	['mta', { provider: 'mta' }, { EMAIL_PROVIDER: 'mta' }],
	[
		'mta with a TLS floor',
		{ provider: 'mta', outboundTlsMode: 'require-verified' },
		{ EMAIL_PROVIDER: 'mta', OUTBOUND_TLS_MODE: 'require-verified' },
	],
	[
		'resend',
		{ provider: 'resend', apiKey: 're_live' },
		{ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_live' },
	],
	[
		'emailit',
		{ provider: 'emailit', apiKey: 'em_live' },
		{ EMAIL_PROVIDER: 'emailit', EMAILIT_API_KEY: 'em_live' },
	],
	[
		'ses',
		{ provider: 'ses', region: 'eu-west-1', accessKeyId: 'AKIA', secretAccessKey: 'shh' },
		{
			EMAIL_PROVIDER: 'ses',
			AWS_SES_REGION: 'eu-west-1',
			AWS_SES_ACCESS_KEY_ID: 'AKIA',
			AWS_SES_SECRET_ACCESS_KEY: 'shh',
		},
	],
	[
		'smtp, defaults left to the backend',
		{ provider: 'smtp', host: 'smtp.mailgun.org', username: 'u', password: 'p' },
		{
			EMAIL_PROVIDER: 'smtp',
			SMTP_RELAY_HOST: 'smtp.mailgun.org',
			SMTP_RELAY_USERNAME: 'u',
			SMTP_RELAY_PASSWORD: 'p',
		},
	],
	[
		'smtp, implicit TLS on 465',
		{
			provider: 'smtp',
			host: 'smtp.example.com',
			port: 465,
			secure: true,
			username: 'u',
			password: 'p',
		},
		{
			EMAIL_PROVIDER: 'smtp',
			SMTP_RELAY_HOST: 'smtp.example.com',
			SMTP_RELAY_USERNAME: 'u',
			SMTP_RELAY_PASSWORD: 'p',
			SMTP_RELAY_PORT: '465',
			SMTP_RELAY_SECURE: 'true',
		},
	],
	[
		'smtp, STARTTLS said explicitly',
		{ provider: 'smtp', host: 'h', port: 587, secure: false, username: 'u', password: 'p' },
		{
			EMAIL_PROVIDER: 'smtp',
			SMTP_RELAY_HOST: 'h',
			SMTP_RELAY_USERNAME: 'u',
			SMTP_RELAY_PASSWORD: 'p',
			SMTP_RELAY_PORT: '587',
			SMTP_RELAY_SECURE: 'false',
		},
	],
];

describe('a v0.6.16 sending block', () => {
	it('is pinned for every kind a setup config can carry', () => {
		const pinned = new Set(SHIPPED.map(([, sending]) => sending['provider']));
		expect([...pinned].sort()).toEqual(SETUP_SENDING_CATALOG_ENTRIES.map((e) => e.kind).sort());
	});

	it.each(SHIPPED)('%s: parses and writes the same env', (_label, sending, env) => {
		const parsed = parseSetupConfig(config(sending));
		expect(parsed.sending).toEqual(sending);
		expect(buildEnvPatchFromConfig(parsed)).toEqual(env);
	});
});

describe('a malformed sending block', () => {
	const REFUSED: Array<[string, Record<string, unknown>, string]> = [
		[
			'unknown provider',
			{ provider: 'mailgun' },
			'config.sending.provider must be one of mta, ses, resend, smtp, emailit',
		],
		[
			'a kind the setup config cannot carry',
			{ provider: 'mandrill', apiKey: 'k' },
			'config.sending.provider must be one of mta, ses, resend, smtp, emailit',
		],
		[
			'mta TLS floor outside the set',
			{ provider: 'mta', outboundTlsMode: 'always' },
			'config.sending.outboundTlsMode must be one of opportunistic, require, require-verified',
		],
		[
			'mta TLS floor that is not a string',
			{ provider: 'mta', outboundTlsMode: 1 },
			'config.sending.outboundTlsMode must be one of opportunistic, require, require-verified',
		],
		[
			'resend without a key',
			{ provider: 'resend' },
			'config.sending.apiKey must be a non-empty string',
		],
		[
			'emailit with an empty key',
			{ provider: 'emailit', apiKey: '' },
			'config.sending.apiKey must be a non-empty string',
		],
		[
			'ses without its key id',
			{ provider: 'ses', region: 'us-east-1', secretAccessKey: 's' },
			'config.sending.accessKeyId must be a non-empty string',
		],
		[
			'ses missing everything reports the region first',
			{ provider: 'ses' },
			'config.sending.region must be a non-empty string',
		],
		[
			'smtp without a host',
			{ provider: 'smtp', username: 'u', password: 'p' },
			'config.sending.host must be a non-empty string',
		],
		[
			'smtp missing a credential reports it ahead of a bad port',
			{ provider: 'smtp', host: 'h', port: '587', password: 'p' },
			'config.sending.username must be a non-empty string',
		],
		[
			'smtp with a string port',
			{ provider: 'smtp', host: 'h', port: '587', username: 'u', password: 'p' },
			'config.sending.port must be a number',
		],
		[
			'smtp with a string TLS flag',
			{ provider: 'smtp', host: 'h', secure: 'true', username: 'u', password: 'p' },
			'config.sending.secure must be a boolean',
		],
	];

	it.each(REFUSED)('%s', (_label, sending, message) => {
		expect(() => parseSetupConfig(config(sending))).toThrow(message);
	});

	it('names every carriable kind when bulk sending has no provider', () => {
		const raw = config(undefined);
		delete raw['sending'];
		expect(() => parseSetupConfig(raw)).toThrow(
			'config.sending is required when campaigns, transactional, or automations are enabled. Set sending.provider to mta, ses, resend, smtp, or emailit, or disable bulk sending.'
		);
	});
});
