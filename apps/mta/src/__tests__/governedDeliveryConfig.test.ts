import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import { describe, expect, it } from 'vitest';
import { loadGovernedDeliveryConfig } from '../governedDeliveryConfig.js';

const optionalEnv =
	(values: Record<string, string>) =>
	(key: string, defaultValue: string): string =>
		values[key] ?? defaultValue;

describe('loadGovernedDeliveryConfig', () => {
	it('loads the governed retry and DLQ defaults together', () => {
		expect(loadGovernedDeliveryConfig(optionalEnv({}))).toEqual({
			maxMessageAgeMs: GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
			webhookDlqMaxSize: 10_000,
		});
	});

	it('loads explicit retry and DLQ bounds', () => {
		expect(
			loadGovernedDeliveryConfig(
				optionalEnv({ MAX_MESSAGE_AGE_MS: '3600000', WEBHOOK_DLQ_MAX_SIZE: '250' })
			)
		).toEqual({ maxMessageAgeMs: 3_600_000, webhookDlqMaxSize: 250 });
	});

	it.each(['0', '-1', 'not-a-number', String(GOVERNED_MTA_MAX_MESSAGE_AGE_MS + 1)])(
		'rejects an invalid maximum message age of %s',
		(value) => {
			expect(() => loadGovernedDeliveryConfig(optionalEnv({ MAX_MESSAGE_AGE_MS: value }))).toThrow(
				'MAX_MESSAGE_AGE_MS must be between'
			);
		}
	);

	it.each(['0', '-1', 'NaN', '1.5', '1000001', '12entries'])(
		'rejects an unsafe webhook DLQ maximum of %s at boot',
		(value) => {
			expect(() =>
				loadGovernedDeliveryConfig(optionalEnv({ WEBHOOK_DLQ_MAX_SIZE: value }))
			).toThrow('WEBHOOK_DLQ_MAX_SIZE must be an integer');
		}
	);
});
