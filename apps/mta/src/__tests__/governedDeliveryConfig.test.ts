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
			fblDedupProtocol: 'legacy-shadow',
			maxMessageAgeMs: GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
			smtpOutcomeJournalMaxSize: 10_000,
			webhookDlqMaxSize: 10_000,
		});
	});

	it('loads explicit retry and DLQ bounds', () => {
		expect(
			loadGovernedDeliveryConfig(
				optionalEnv({
					FBL_DEDUP_PROTOCOL: 'owned-v2',
					MAX_MESSAGE_AGE_MS: '3600000',
					SMTP_OUTCOME_JOURNAL_MAX_SIZE: '500',
					WEBHOOK_DLQ_MAX_SIZE: '250',
				})
			)
		).toEqual({
			fblDedupProtocol: 'owned-v2',
			maxMessageAgeMs: 3_600_000,
			smtpOutcomeJournalMaxSize: 500,
			webhookDlqMaxSize: 250,
		});
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

	it.each(['0', '-1', 'NaN', '1.5', '1000001', '12entries'])(
		'rejects an unsafe SMTP outcome journal maximum of %s at boot',
		(value) => {
			expect(() =>
				loadGovernedDeliveryConfig(optionalEnv({ SMTP_OUTCOME_JOURNAL_MAX_SIZE: value }))
			).toThrow('SMTP_OUTCOME_JOURNAL_MAX_SIZE must be an integer');
		}
	);

	it('rejects an unknown FBL deduplication protocol at boot', () => {
		expect(() =>
			loadGovernedDeliveryConfig(optionalEnv({ FBL_DEDUP_PROTOCOL: 'magic-v3' }))
		).toThrow('FBL_DEDUP_PROTOCOL must be one of: legacy-shadow, owned-v2');
	});
});
