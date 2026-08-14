import { describe, expect, it } from 'vitest';
import {
	indexSuppressionProvenance,
	suppressionProvenanceLine,
	type SuppressionProvenanceEntry,
	type SuppressionProvenanceText,
} from '../suppressionProvenance';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * The line is a catalog key plus its values — the provider is part of the KEY,
 * because two of the names ("your SMTP relay", "your own mail server") are copy.
 * These assertions render it, so what is pinned is the sentence on the row.
 */
const { t } = createTestI18n().global;
const render = (line: SuppressionProvenanceText | null) =>
	line === null ? null : t(line.key, line.params ?? {});

function entry(over: Partial<SuppressionProvenanceEntry> = {}): SuppressionProvenanceEntry {
	return {
		blockedEmailId: 'row1',
		provider: 'mandrill',
		source: 'webhook',
		evidence: 'MANDRILL_REJECT_SPAM',
		recordedAt: 1_000,
		...over,
	};
}

describe('indexSuppressionProvenance', () => {
	it('is empty for a read still in flight', () => {
		expect(indexSuppressionProvenance(undefined).size).toBe(0);
	});

	it('keeps the newest entry when a row was blocked, removed, then blocked again', () => {
		const map = indexSuppressionProvenance([
			entry({ recordedAt: 5_000, evidence: 'MANDRILL_REJECT_HARD_BOUNCE' }),
			entry({ recordedAt: 1_000, evidence: 'MANDRILL_REJECT_SPAM' }),
		]);
		expect(map.get('row1')?.evidence).toBe('MANDRILL_REJECT_HARD_BOUNCE');
	});
});

describe('suppressionProvenanceLine', () => {
	it('says nothing for a row with no provider entry — that one really was a person', () => {
		expect(suppressionProvenanceLine(undefined)).toBeNull();
	});

	it('names an operator-worded provider in its own language', () => {
		expect(render(suppressionProvenanceLine(entry({ provider: 'smtp', evidence: null })))).toBe(
			'Reported by your SMTP relay'
		);
		expect(
			render(suppressionProvenanceLine(entry({ provider: 'mta', source: 'import', evidence: null })))
		).toBe('Carried over from your own mail server');
	});

	it('names the provider and quotes its own reason code verbatim', () => {
		expect(render(suppressionProvenanceLine(entry()))).toBe(
			'Reported by Mailchimp Transactional · MANDRILL_REJECT_SPAM'
		);
	});

	it('distinguishes an ongoing webhook from a one-off carry-over import', () => {
		expect(render(suppressionProvenanceLine(entry({ source: 'import', evidence: null })))).toBe(
			'Carried over from Mailchimp Transactional'
		);
	});

	it('falls back to the raw kind for a provider it has no name for', () => {
		expect(
			render(suppressionProvenanceLine(entry({ provider: 'plugin.acme.relay', evidence: null })))
		).toBe('Reported by plugin.acme.relay');
	});
});
