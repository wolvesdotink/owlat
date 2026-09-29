import { describe, expect, it } from 'vitest';
import { CORE_SEND_PROVIDER_CATALOG_ENTRIES } from '../sendProviderCatalog';
import {
	SETUP_SENDING_CATALOG_ENTRIES,
	isSetupSendingKind,
	sendingConfigFromCredentials,
} from '../setupSendingConfig';

const reader = (values: Record<string, string>) => (envVar: string) => values[envVar];

describe('setup sending kinds', () => {
	it('keeps every core kind except the ones the config cannot carry, in catalog order', () => {
		expect(SETUP_SENDING_CATALOG_ENTRIES.map((e) => e.kind)).toEqual(
			CORE_SEND_PROVIDER_CATALOG_ENTRIES.map((e) => e.kind).filter((k) => k !== 'mandrill')
		);
	});

	it('rejects unknown and missing kinds', () => {
		expect(isSetupSendingKind('mandrill')).toBe(false);
		expect(isSetupSendingKind('toString')).toBe(false);
		expect(isSetupSendingKind(undefined)).toBe(false);
		expect(isSetupSendingKind('smtp')).toBe(true);
	});
});

describe('sendingConfigFromCredentials', () => {
	it('mta: writes the outbound TLS floor, defaulting to opportunistic', () => {
		expect(sendingConfigFromCredentials('mta', reader({}))).toEqual({
			ok: true,
			config: { provider: 'mta', outboundTlsMode: 'opportunistic' },
		});
		expect(
			sendingConfigFromCredentials('mta', reader({ OUTBOUND_TLS_MODE: 'require-verified' }))
		).toEqual({ ok: true, config: { provider: 'mta', outboundTlsMode: 'require-verified' } });
	});

	it('mta: refuses a TLS mode the field does not declare', () => {
		const result = sendingConfigFromCredentials('mta', reader({ OUTBOUND_TLS_MODE: 'bogus' }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.problem.reason).toBe('invalid');
			expect(result.problem.field.key).toBe('outboundTlsMode');
		}
	});

	it('resend: writes a secret verbatim, as the web credential form does', () => {
		expect(sendingConfigFromCredentials('resend', reader({ RESEND_API_KEY: 're_abc ' }))).toEqual({
			ok: true,
			config: { provider: 'resend', apiKey: 're_abc ' },
		});
	});

	it('trims identifiers', () => {
		const result = sendingConfigFromCredentials(
			'ses',
			reader({
				AWS_SES_REGION: ' eu-west-1 ',
				AWS_SES_ACCESS_KEY_ID: 'AKIA\n',
				AWS_SES_SECRET_ACCESS_KEY: 'secret',
			})
		);
		expect(result.ok && result.config).toEqual({
			provider: 'ses',
			region: 'eu-west-1',
			accessKeyId: 'AKIA',
			secretAccessKey: 'secret',
		});
	});

	it('emailit: maps the API key and reports it missing when blank', () => {
		expect(sendingConfigFromCredentials('emailit', reader({ EMAILIT_API_KEY: 'em_123' }))).toEqual({
			ok: true,
			config: { provider: 'emailit', apiKey: 'em_123' },
		});
		const blank = sendingConfigFromCredentials('emailit', reader({ EMAILIT_API_KEY: '  ' }));
		expect(blank.ok).toBe(false);
		if (!blank.ok) {
			expect(blank.problem.reason).toBe('missing');
			expect(blank.problem.field.envVar).toBe('EMAILIT_API_KEY');
		}
	});

	it('ses: maps all three fields and names the first missing one', () => {
		expect(
			sendingConfigFromCredentials(
				'ses',
				reader({
					AWS_SES_REGION: 'eu-west-1',
					AWS_SES_ACCESS_KEY_ID: 'AKIA',
					AWS_SES_SECRET_ACCESS_KEY: 'secret',
				})
			)
		).toEqual({
			ok: true,
			config: {
				provider: 'ses',
				region: 'eu-west-1',
				accessKeyId: 'AKIA',
				secretAccessKey: 'secret',
			},
		});
		const partial = sendingConfigFromCredentials(
			'ses',
			reader({ AWS_SES_REGION: 'eu-west-1', AWS_SES_SECRET_ACCESS_KEY: 'secret' })
		);
		expect(partial.ok).toBe(false);
		if (!partial.ok) expect(partial.problem.field.key).toBe('accessKeyId');
	});

	it('smtp: spreads the endpoint into host / port / secure', () => {
		expect(
			sendingConfigFromCredentials(
				'smtp',
				reader({
					SMTP_RELAY_HOST: ' smtp.example.com ',
					SMTP_RELAY_PORT: '465',
					SMTP_RELAY_SECURE: 'true',
					SMTP_RELAY_USERNAME: 'user',
					SMTP_RELAY_PASSWORD: 'pass',
				})
			)
		).toEqual({
			ok: true,
			config: {
				provider: 'smtp',
				host: 'smtp.example.com',
				port: 465,
				secure: true,
				username: 'user',
				password: 'pass',
			},
		});
	});

	it('smtp: leaves a blank port and TLS flag to the backend defaults', () => {
		const result = sendingConfigFromCredentials(
			'smtp',
			reader({
				SMTP_RELAY_HOST: 'smtp.example.com',
				SMTP_RELAY_USERNAME: 'user',
				SMTP_RELAY_PASSWORD: 'pass',
			})
		);
		expect(result).toEqual({
			ok: true,
			config: {
				provider: 'smtp',
				host: 'smtp.example.com',
				username: 'user',
				password: 'pass',
			},
		});
	});

	it.each(['0', '65536', '58 7', 'abc', '-1'])('smtp: rejects port %j', (port) => {
		const result = sendingConfigFromCredentials(
			'smtp',
			reader({
				SMTP_RELAY_HOST: 'smtp.example.com',
				SMTP_RELAY_PORT: port,
				SMTP_RELAY_USERNAME: 'user',
				SMTP_RELAY_PASSWORD: 'pass',
			})
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.problem.reason).toBe('invalid');
			expect(result.problem.field.kind).toBe('host-port');
		}
	});

	it('smtp: a missing host is reported before the other fields', () => {
		const result = sendingConfigFromCredentials('smtp', reader({}));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.problem.reason).toBe('missing');
			expect(result.problem.field.kind).toBe('host-port');
		}
	});
});
