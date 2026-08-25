import { describe, expect, it } from 'vitest';
import {
	generateEd25519KeyPair,
	validateAttestation,
	type TrafficSummaryBody,
} from '@owlat/ostr-core';
import { signDrafts } from '../sign.js';
import { buildTrapHitBatch } from '../trapHit.js';
import type { AttestationDraft } from '../types.js';

const WINDOW = { from: '2026-08-19T00:00:00Z', to: '2026-08-20T00:00:00Z' };
const SUBJECT = { domain: 'blast.example' };

function summary(overrides: Partial<AttestationDraft<TrafficSummaryBody>> = {}) {
	const draft: AttestationDraft<TrafficSummaryBody> = {
		kind: 'traffic-summary',
		subject: SUBJECT,
		window: WINDOW,
		body: {
			messages: 400,
			spfPass: 400,
			dkimPass: 400,
			dmarcPass: 400,
			tlsInbound: 400,
			uniqueRecipientsBucket: 2,
			bounceRateBucket: 4,
		},
		...overrides,
	};
	return draft;
}

describe('buildTrapHitBatch (§5, §6.3)', () => {
	it('drafts the count alongside its denominator', () => {
		const result = buildTrapHitBatch({
			subject: SUBJECT,
			window: WINDOW,
			hits: 12,
			summary: summary(),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.drafts.map((draft) => draft.kind)).toEqual(['traffic-summary', 'trap-hit']);
		expect(result.drafts[1].body).toEqual({ hits: 12 });
		expect(result.drafts[1].window).toEqual(WINDOW);
	});

	it('never publishes the trap addresses, only the count', () => {
		const result = buildTrapHitBatch({
			subject: SUBJECT,
			window: WINDOW,
			hits: 12,
			summary: summary(),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.keys(result.drafts[1].body)).toEqual(['hits']);
	});

	it('holds a count below the k-floor, saying how far short it is', () => {
		expect(
			buildTrapHitBatch({ subject: SUBJECT, window: WINDOW, hits: 1, summary: summary() })
		).toEqual({
			ok: false,
			reason: 'below-trap-hit-threshold',
			held: { hits: 1, minTrapHits: 3 },
		});
		expect(
			buildTrapHitBatch({
				subject: SUBJECT,
				window: WINDOW,
				hits: 1,
				summary: summary(),
				kThresholds: { minTrapHits: 1, unsafeAllowBelowDefaultFloors: true },
			}).ok
		).toBe(true);
		// …but an ordinary config asking for the same thing is clamped back up.
		expect(
			buildTrapHitBatch({
				subject: SUBJECT,
				window: WINDOW,
				hits: 1,
				summary: summary(),
				kThresholds: { minTrapHits: 1 },
			})
		).toEqual({
			ok: false,
			reason: 'below-trap-hit-threshold',
			held: { hits: 1, minTrapHits: 3 },
		});
	});

	it('refuses a hit count with no denominator, or the wrong one', () => {
		expect(
			buildTrapHitBatch({ subject: SUBJECT, window: WINDOW, hits: 12, summary: null })
		).toEqual({ ok: false, reason: 'missing-traffic-summary' });
		expect(
			buildTrapHitBatch({
				subject: SUBJECT,
				window: WINDOW,
				hits: 12,
				summary: summary({ subject: { domain: 'other.example' } }),
			})
		).toEqual({ ok: false, reason: 'subject-mismatch' });
		expect(
			buildTrapHitBatch({
				subject: SUBJECT,
				window: WINDOW,
				hits: 12,
				summary: summary({ window: { from: WINDOW.from, to: '2026-08-21T00:00:00Z' } }),
			})
		).toEqual({ ok: false, reason: 'window-mismatch' });
	});

	it('refuses more trap hits than the observer attested messages', () => {
		expect(
			buildTrapHitBatch({ subject: SUBJECT, window: WINDOW, hits: 401, summary: summary() })
		).toEqual({ ok: false, reason: 'hits-exceed-attested-messages' });
	});

	it('refuses a hit count that is not a count', () => {
		for (const hits of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				buildTrapHitBatch({ subject: SUBJECT, window: WINDOW, hits, summary: summary() })
			).toEqual({ ok: false, reason: 'invalid-hit-count' });
		}
	});

	it('drafts something the core accepts as valid once signed', () => {
		const result = buildTrapHitBatch({
			subject: SUBJECT,
			window: WINDOW,
			hits: 12,
			summary: summary(),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const identity = {
			domain: 'mx.hinterland.camp',
			privateKeyBase64: generateEd25519KeyPair().privateKey,
		};
		for (const signed of signDrafts(identity, result.drafts)) {
			expect(validateAttestation(signed).ok).toBe(true);
		}
	});
});
