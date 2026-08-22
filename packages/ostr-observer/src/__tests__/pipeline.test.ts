/**
 * The §7 flow end to end, through the public barrel only: eligibility, capture,
 * dedupe, aggregation, the batch/summary pair, key observation, signing and
 * cross-submission.
 */
import { describe, expect, it } from 'vitest';
import {
	generateEd25519KeyPair,
	parseHash,
	validateAttestation,
	verifyAttestationSignature,
	verifyBundleOpening,
	type Attestation,
	type SpamReportBatchBody,
} from '@owlat/ostr-core';
import {
	answerChallenge,
	assertObserverEligible,
	buildEvidenceBundle,
	buildReportedWindow,
	KeyObservationTracker,
	MemoryBatchCommitmentStore,
	MemoryKeyObservationStore,
	MemoryReportDedupeStore,
	retainBatchCommitment,
	shouldCaptureReport,
	signDrafts,
	submitAll,
	TrafficAccumulator,
	type AttestationDraft,
	type EvidenceInput,
	type PostJson,
	type SpamReportEntry,
	type TrafficEmission,
} from '../index.js';

const WINDOW = { windowFrom: '2026-08-19T00:00:00Z', windowTo: '2026-08-20T00:00:00Z' };
const keys = generateEd25519KeyPair();
const identity = { domain: 'mx.hinterland.camp', privateKeyBase64: keys.privateKey };

function evidenceFor(index: number): EvidenceInput {
	return {
		rawSignedHeaders: [
			{ name: 'From', raw: 'From: Blast <blast@spammy.example>' },
			{ name: 'Date', raw: 'Date: Wed, 19 Aug 2026 09:14:02 +0000' },
			{ name: 'Message-ID', raw: `Message-ID: <m${index}@spammy.example>` },
			{ name: 'Subject', raw: 'Subject: Act now' },
		],
		dkimSignatureHeader: `DKIM-Signature: v=1; a=ed25519-sha256; d=spammy.example; s=k1; h=from:date:message-id:subject; bh=bh${index}; b=sig`,
		dnsKeyRecordTxt: 'v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=',
		verificationVerdict: 'pass',
		verifiedAt: '2026-08-19T09:14:07Z',
		messageId: `<m${index}@spammy.example>`,
		bodyHash: `bh${index}`,
		signingDomain: 'spammy.example',
		selector: 'k1',
		algorithm: 'ed25519-sha256',
		usesBodyLengthTag: false,
		signedHeaderNames: ['from', 'date', 'message-id', 'subject'],
	};
}

describe('observer pipeline (§7)', () => {
	it('runs capture → aggregation → pair → submission for an eligible observer', async () => {
		const eligibility = assertObserverEligible({ enabled: true, mailboxCount: 120 });
		expect(eligibility.eligible).toBe(true);

		const accumulator = new TrafficAccumulator();
		const dedupe = new MemoryReportDedupeStore();
		const keyStore = new MemoryKeyObservationStore();
		const tracker = new KeyObservationTracker(keyStore);
		const drafts: AttestationDraft[] = [];
		const reported: SpamReportEntry[] = [];

		for (let i = 0; i < 60; i++) {
			accumulator.observe({
				signingDomain: 'spammy.example',
				ip: '192.0.2.7',
				spfPass: true,
				dkimPass: true,
				dmarcPass: true,
				tls: true,
				recipientCount: 1,
				bounced: i % 30 === 0,
				recipients: [`mbx-${i % 12}`],
			});
			const observed = tracker.observe(
				{
					domain: 'spammy.example',
					selector: 'k1',
					publicKey: 'sha256:'.concat('a'.repeat(64)),
					dnssecValidated: true,
					seenAt: '2026-08-19T09:14:07Z',
				},
				{ from: WINDOW.windowFrom, to: WINDOW.windowTo }
			);
			if (observed.ok && observed.draft !== null) drafts.push(observed.draft);

			// Every fourth message gets reported — and message 4 gets replayed.
			if (i % 4 !== 0) continue;
			const index = i === 8 ? 4 : i;
			const decision = shouldCaptureReport(
				{
					messageId: `<m${index}@spammy.example>`,
					bodyHash: `bh${index}`,
					reporter: `mbx-${i % 12}`,
				},
				dedupe,
				'2026-08-19T10:00:00Z'
			);
			if (!decision.capture) continue;
			const bundle = buildEvidenceBundle(evidenceFor(index));
			expect(bundle.ok).toBe(true);
			if (bundle.ok) {
				reported.push({
					bundleHash: bundle.bundleHash,
					signingDomain: bundle.bundle.signingDomain,
					reporter: decision.reporter,
				});
			}
		}

		// One key observation for the whole window, not one per message (§7.5).
		expect(drafts.filter((draft) => draft.kind === 'key-observation')).toHaveLength(1);
		// The replayed Message-ID/bh pair was dropped at capture (§7.3).
		expect(reported).toHaveLength(14);
		expect(new Set(reported.map((entry) => entry.bundleHash)).size).toBe(14);

		const emission: TrafficEmission = accumulator.emitTrafficSummaries(WINDOW);
		expect(emission.held).toEqual([]);
		const summary = emission.emitted.find((draft) => draft.subject.domain === 'spammy.example');
		expect(summary).toBeDefined();
		if (summary === undefined) return;

		const paired = buildReportedWindow({
			summary,
			batch: {
				subject: summary.subject,
				window: { from: WINDOW.windowFrom, to: WINDOW.windowTo },
				bundles: reported,
			},
		});
		expect(paired.ok).toBe(true);
		if (!paired.ok) return;
		drafts.push(...paired.drafts, ...emission.emitted.filter((draft) => draft !== summary));

		// Retained at publication time: without the ordered list a challenge is
		// unanswerable, which costs the batch and the observer's standing (§7.2.4).
		const commitments = new MemoryBatchCommitmentStore();
		retainBatchCommitment(commitments, paired.drafts[1], paired.bundleHashes);

		const attestations = signDrafts(identity, drafts);
		for (const attestation of attestations) {
			expect(validateAttestation(attestation).ok).toBe(true);
			expect(verifyAttestationSignature(attestation, keys.publicKey)).toBe(true);
		}

		const posted: Attestation[] = [];
		const postJson: PostJson = async (url, body) => {
			if (url.includes('log-b')) throw new Error('maintenance window');
			posted.push(body as Attestation);
			return { accepted: true };
		};
		const result = await submitAll({
			attestations,
			postJson,
			logUrls: ['https://log-a.example/v1/submit', 'https://log-b.example/v1/submit'],
		});
		expect(result.allAccepted).toBe(true);
		expect(result.crossSubmitted).toBe(false);
		expect(result.failedLogs).toEqual(['https://log-b.example/v1/submit']);
		expect(posted).toHaveLength(attestations.length);

		const batch = posted.find((attestation) => attestation.kind === 'spam-report-batch');
		expect(batch).toBeDefined();
		const batchBody = (batch as Attestation<SpamReportBatchBody>).body;
		expect(batchBody.reports).toBe(14);

		// A monitor samples three indices; the observer can substantiate.
		const answer = answerChallenge(
			commitments.get(summary.subject, { from: WINDOW.windowFrom, to: WINDOW.windowTo }),
			[0, 6, 13]
		);
		expect(answer.ok).toBe(true);
		if (!answer.ok) return;
		expect(answer.commitmentHex).toBe(batchBody.commitment);
		for (const opening of answer.openings) {
			expect(
				verifyBundleOpening({
					committedSize: batchBody.reports,
					root: parseHash(batchBody.commitment) as Buffer,
					index: opening.index,
					treeSize: opening.treeSize,
					bundleHash: parseHash(opening.bundleHash) as Buffer,
					proof: opening.proof.map((node) => parseHash(node) as Buffer),
				})
			).toBe(true);
		}
		// The batch never carries an evidence bundle — only the commitment.
		expect(JSON.stringify(posted)).not.toContain('Act now');
		expect(JSON.stringify(posted)).not.toContain('mbx-');
	});

	it('publishes nothing at all for a single-mailbox instance', () => {
		expect(assertObserverEligible({ enabled: true, mailboxCount: 1 }).eligible).toBe(false);

		const accumulator = new TrafficAccumulator();
		for (let i = 0; i < 5000; i++) {
			accumulator.observe({
				signingDomain: 'newsletter.example',
				ip: '192.0.2.9',
				spfPass: true,
				dkimPass: true,
				dmarcPass: true,
				tls: true,
				recipientCount: 1,
				bounced: false,
				recipients: ['the-only-mailbox'],
			});
		}
		const { emitted, held } = accumulator.emitTrafficSummaries(WINDOW);
		expect(emitted).toEqual([]);
		expect(held.every((entry) => entry.uniqueRecipients === 1)).toBe(true);
	});
});
