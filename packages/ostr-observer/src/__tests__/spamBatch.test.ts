import { describe, expect, it } from 'vitest';
import {
	commitToBundles,
	openBundles,
	parseHash,
	sha256,
	verifyBundleOpening,
	type TrafficSummaryBody,
} from '@owlat/ostr-core';
import { buildReportedWindow, buildSpamReportBatch, type SpamReportEntry } from '../spamBatch.js';
import type { AttestationDraft } from '../types.js';

const WINDOW = { from: '2026-08-19T00:00:00Z', to: '2026-08-20T00:00:00Z' };
const SUBJECT = { domain: 'example.com' };

const hashes = (count: number): string[] =>
	Array.from({ length: count }, (_, index) => sha256(`bundle-${index}`).toString('hex'));

/** `count` reports, each from its own reporter, all signed by the subject. */
function bundles(count: number, overrides: Partial<SpamReportEntry> = {}): SpamReportEntry[] {
	return hashes(count).map((bundleHash, index) => ({
		bundleHash,
		signingDomain: 'example.com',
		reporter: `reporter-${index}`,
		...overrides,
	}));
}

function summary(overrides: Partial<AttestationDraft<TrafficSummaryBody>> = {}) {
	const draft: AttestationDraft<TrafficSummaryBody> = {
		kind: 'traffic-summary',
		subject: SUBJECT,
		window: WINDOW,
		body: {
			messages: 900,
			spfPass: 900,
			dkimPass: 900,
			dmarcPass: 900,
			tlsInbound: 900,
			uniqueRecipientsBucket: 2,
			bounceRateBucket: 1,
		},
		...overrides,
	};
	return draft;
}

describe('buildSpamReportBatch (§7.2)', () => {
	it('commits to the bundle hashes and counts one report per leaf', () => {
		const entries = bundles(4);
		const result = buildSpamReportBatch({ subject: SUBJECT, window: WINDOW, bundles: entries });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.draft.kind).toBe('spam-report-batch');
		expect(result.draft.body.reports).toBe(4);
		expect(result.draft.body.commitment).toBe(
			commitToBundles(entries.map((entry) => parseHash(entry.bundleHash) as Buffer)).rootHex
		);
	});

	it('hands back the committed list, in commitment order, for later openings', () => {
		const entries = bundles(4);
		const result = buildSpamReportBatch({ subject: SUBJECT, window: WINDOW, bundles: entries });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.bundleHashes).toEqual(entries.map((entry) => entry.bundleHash));
		expect(result.reporters).toBe(4);
	});

	it('produces a commitment a monitor can open at challenge time', () => {
		const entries = bundles(5);
		const result = buildSpamReportBatch({ subject: SUBJECT, window: WINDOW, bundles: entries });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const leaves = entries.map((entry) => parseHash(entry.bundleHash) as Buffer);
		const [opening] = openBundles(leaves, [3]);
		expect(opening).toBeDefined();
		if (opening === undefined) return;
		expect(
			verifyBundleOpening({
				root: parseHash(result.draft.body.commitment) as Buffer,
				committedSize: result.draft.body.reports,
				index: opening.index,
				treeSize: opening.treeSize,
				bundleHash: opening.bundleHash,
				proof: opening.proof,
			})
		).toBe(true);
	});

	it('refuses an empty, malformed or duplicated batch', () => {
		expect(buildSpamReportBatch({ subject: SUBJECT, window: WINDOW, bundles: [] })).toEqual({
			ok: false,
			reason: 'no-bundles',
		});
		expect(
			buildSpamReportBatch({
				subject: SUBJECT,
				window: WINDOW,
				bundles: bundles(1, { bundleHash: 'not-a-hash' }),
			})
		).toEqual({ ok: false, reason: 'invalid-bundle-hash' });
		const [first] = bundles(1);
		expect(
			buildSpamReportBatch({
				subject: SUBJECT,
				window: WINDOW,
				bundles: [first as SpamReportEntry, first as SpamReportEntry],
			})
		).toEqual({ ok: false, reason: 'duplicate-bundle-hash' });
	});
});

describe('the committed evidence must name the accused', () => {
	it('refuses a batch whose bundles were signed by another domain', () => {
		const mixed = bundles(4);
		mixed[2] = { ...(mixed[2] as SpamReportEntry), signingDomain: 'other.example' };
		expect(buildSpamReportBatch({ subject: SUBJECT, window: WINDOW, bundles: mixed })).toEqual({
			ok: false,
			reason: 'evidence-subject-mismatch',
		});
	});

	it('refuses a domain-subject batch whose evidence names no domain at all', () => {
		expect(
			buildSpamReportBatch({
				subject: SUBJECT,
				window: WINDOW,
				bundles: bundles(4, { signingDomain: undefined }),
			})
		).toEqual({ ok: false, reason: 'evidence-subject-mismatch' });
	});

	it('folds the domain spelling before comparing', () => {
		const result = buildSpamReportBatch({
			subject: { domain: 'example.com' },
			window: WINDOW,
			bundles: bundles(3, { signingDomain: 'Example.COM.' }),
		});
		expect(result.ok).toBe(true);
	});

	it('leaves the signing domains alone for an IP subject', () => {
		const result = buildSpamReportBatch({
			subject: { ip: '192.0.2.7' },
			window: WINDOW,
			bundles: bundles(3, { signingDomain: 'anything.example' }),
		});
		expect(result.ok).toBe(true);
	});
});

describe('the distinct-reporter half of the k-floor (§7.4)', () => {
	const batch = { subject: SUBJECT, window: WINDOW, bundles: bundles(3) };

	it('refuses evidence carrying no reporter token: the floor is unevaluable', () => {
		expect(
			buildSpamReportBatch({
				subject: SUBJECT,
				window: WINDOW,
				bundles: bundles(4, { reporter: undefined }),
			})
		).toEqual({ ok: false, reason: 'missing-reporter-token' });
	});

	it('HOLDS ten reports from a single mailbox', () => {
		const result = buildReportedWindow({
			summary: summary(),
			batch: { subject: SUBJECT, window: WINDOW, bundles: bundles(10, { reporter: 'the-one' }) },
		});
		expect(result).toEqual({
			ok: false,
			reason: 'below-reporter-threshold',
			held: { reports: 10, minReports: 3, reporters: 1, minReporters: 3 },
		});
	});

	it('publishes three reports from three mailboxes', () => {
		expect(buildReportedWindow({ summary: summary(), batch }).ok).toBe(true);
	});

	it('counts reporters, not reports: two mailboxes stay held however loud', () => {
		const twoReporters = bundles(9).map((entry, index) => ({
			...entry,
			reporter: index % 2 === 0 ? 'mbx-a' : 'mbx-b',
		}));
		const result = buildReportedWindow({
			summary: summary(),
			batch: { subject: SUBJECT, window: WINDOW, bundles: twoReporters },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('below-reporter-threshold');
		expect(result.held?.reporters).toBe(2);
	});
});

describe('a batch is publishable only with its own traffic-summary (§7.3)', () => {
	const batch = { subject: SUBJECT, window: WINDOW, bundles: bundles(4) };

	it('returns the pair when the summary matches', () => {
		const result = buildReportedWindow({ summary: summary(), batch });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.drafts.map((draft) => draft.kind)).toEqual([
			'traffic-summary',
			'spam-report-batch',
		]);
		expect(result.drafts[1].window).toEqual(result.drafts[0].window);
		expect(result.drafts[1].subject).toEqual(result.drafts[0].subject);
		expect(result.bundleHashes).toEqual(batch.bundles.map((entry) => entry.bundleHash));
	});

	it('refuses a batch with no summary at all — the hostile-denominator attack', () => {
		expect(buildReportedWindow({ summary: null, batch })).toEqual({
			ok: false,
			reason: 'missing-traffic-summary',
		});
		expect(buildReportedWindow({ summary: undefined, batch })).toEqual({
			ok: false,
			reason: 'missing-traffic-summary',
		});
	});

	it('refuses a summary about another subject or another window', () => {
		expect(
			buildReportedWindow({ summary: summary({ subject: { domain: 'other.example' } }), batch })
		).toEqual({ ok: false, reason: 'subject-mismatch' });
		expect(
			buildReportedWindow({
				summary: summary({ window: { from: WINDOW.from, to: '2026-08-21T00:00:00Z' } }),
				batch,
			})
		).toEqual({ ok: false, reason: 'window-mismatch' });
		expect(buildReportedWindow({ summary: summary({ window: undefined }), batch })).toEqual({
			ok: false,
			reason: 'window-mismatch',
		});
	});

	it('refuses a draft of the wrong kind posing as the denominator', () => {
		const notASummary = { ...summary(), kind: 'trap-hit' as const };
		expect(
			buildReportedWindow({
				summary: notASummary as unknown as AttestationDraft<TrafficSummaryBody>,
				batch,
			})
		).toEqual({ ok: false, reason: 'missing-traffic-summary' });
	});

	it('refuses more reports than the observer attested messages', () => {
		expect(
			buildReportedWindow({
				summary: summary({
					body: {
						...summary().body,
						messages: 3,
						spfPass: 3,
						dkimPass: 3,
						dmarcPass: 3,
						tlsInbound: 3,
					},
				}),
				batch,
			})
		).toEqual({ ok: false, reason: 'reports-exceed-attested-messages' });
	});

	it('holds a batch below the report threshold rather than publishing it', () => {
		const short = { ...batch, bundles: bundles(2) };
		expect(buildReportedWindow({ summary: summary(), batch: short })).toEqual({
			ok: false,
			reason: 'below-report-threshold',
			held: { reports: 2, minReports: 3, reporters: 2, minReporters: 3 },
		});

		const relaxed = buildReportedWindow({
			summary: summary(),
			batch: short,
			kThresholds: { minReports: 1, minReporters: 1, unsafeAllowBelowDefaultFloors: true },
		});
		expect(relaxed.ok).toBe(true);
	});

	it('ignores a config that tries to lower the k-floor', () => {
		const short = { ...batch, bundles: bundles(2) };
		expect(
			buildReportedWindow({
				summary: summary(),
				batch: short,
				kThresholds: { minReports: 1, minReporters: 1 },
			})
		).toEqual({
			ok: false,
			reason: 'below-report-threshold',
			held: { reports: 2, minReports: 3, reporters: 2, minReporters: 3 },
		});
	});
});
