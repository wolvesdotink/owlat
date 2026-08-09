import { describe, expect, it } from 'vitest';
import { CORE_SEND_PROVIDER_CATALOG_ENTRIES } from '@owlat/shared';
import { SEND_PROVIDER_BUNDLES, providerBundleFor } from '../composition';

describe('send-provider bundle composition', () => {
	it('preserves incumbent order, catalog data, routes, and environment names', () => {
		const incumbents = SEND_PROVIDER_BUNDLES.filter(({ source }) => source !== 'third-party');
		expect(incumbents.map(({ descriptor }) => descriptor)).toEqual(
			CORE_SEND_PROVIDER_CATALOG_ENTRIES
		);
		expect(
			incumbents.map(({ descriptor, feedback }) => ({
				kind: descriptor.kind,
				required: descriptor.requiredEnvVars,
				optional: descriptor.optionalEnvVars ?? [],
				webhookPath: feedback?.webhookPath ?? null,
			}))
		).toEqual([
			{
				kind: 'mta',
				required: ['MTA_API_URL', 'MTA_API_KEY'],
				optional: ['OUTBOUND_TLS_MODE', 'MTA_WEBHOOK_SECRET'],
				webhookPath: '/webhooks/mta',
			},
			{
				kind: 'ses',
				required: ['AWS_SES_REGION', 'AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY'],
				optional: ['SES_CONFIGURATION_SET'],
				webhookPath: '/webhooks/ses',
			},
			{
				kind: 'resend',
				required: ['RESEND_API_KEY'],
				optional: ['RESEND_WEBHOOK_SECRET'],
				webhookPath: '/webhooks/resend',
			},
			{
				kind: 'smtp',
				required: ['SMTP_RELAY_HOST', 'SMTP_RELAY_USERNAME', 'SMTP_RELAY_PASSWORD'],
				optional: ['SMTP_RELAY_PORT', 'SMTP_RELAY_SECURE'],
				webhookPath: null,
			},
			{
				kind: 'mandrill',
				required: ['MANDRILL_API_KEY'],
				optional: ['MANDRILL_WEBHOOK_KEY', 'MANDRILL_SUBACCOUNT', 'MANDRILL_IP_POOL'],
				webhookPath: '/webhooks/mandrill',
			},
		]);
	});

	it('assigns trust and executable slots without a writable trust field', () => {
		expect(
			SEND_PROVIDER_BUNDLES.map(({ descriptor, source }) => [descriptor.kind, source])
		).toEqual([
			['mta', 'own'],
			['ses', 'first-party'],
			['resend', 'first-party'],
			['smtp', 'first-party'],
			['mandrill', 'first-party'],
		]);

		expect(providerBundleFor('mta')).toMatchObject({
			primaryDomainIdentity: { exportPath: 'domains/providers/mta' },
			platformHooks: { exportPath: 'providers/mta/platformHooks' },
		});
		expect(providerBundleFor('ses')).toMatchObject({
			primaryDomainIdentity: { exportPath: 'domains/providers/ses' },
			relayDomainIdentity: { exportPath: 'domains/providers/ses' },
		});
		expect(providerBundleFor('mandrill')).toMatchObject({
			primaryDomainIdentity: { exportPath: 'domains/providers/mandrill' },
			relayDomainIdentity: { exportPath: 'domains/providers/mandrill' },
		});
		expect(providerBundleFor('smtp')?.feedback).toBeUndefined();
	});

	it('declares host-owned verifier mechanisms for all incumbent feedback', () => {
		expect(
			SEND_PROVIDER_BUNDLES.flatMap(({ descriptor, feedback }) =>
				feedback ? [[descriptor.kind, feedback.verifier.scheme]] : []
			)
		).toEqual([
			['mta', 'hmac-timestamp-body'],
			['ses', 'aws-sns'],
			['resend', 'svix'],
			['mandrill', 'mandrill-form'],
		]);
	});
});
