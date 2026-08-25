import { describe, expect, it } from 'vitest';
import { generateEd25519KeyPair, type Attestation } from '@owlat/ostr-core';
import { signDrafts } from '../sign.js';
import { MIN_CROSS_SUBMIT_LOGS, submitAll, type PostJson } from '../submit.js';

const keys = generateEd25519KeyPair();
const identity = { domain: 'mx.hinterland.camp', privateKeyBase64: keys.privateKey };

const LOG_A = 'https://log-a.example/v1/submit';
const LOG_B = 'https://log-b.example/v1/submit';
const LOG_C = 'https://log-c.example/v1/submit';

function attestations(count: number): Attestation[] {
	return signDrafts(
		identity,
		Array.from({ length: count }, (_, index) => ({
			kind: 'trap-hit' as const,
			subject: { domain: `sender-${index}.example` },
			window: { from: '2026-08-19T00:00:00Z', to: '2026-08-20T00:00:00Z' },
			body: { hits: index + 1 },
		}))
	);
}

/** A poster that records every call and fails for the named logs. */
function fakePoster(failing: { url: string; error: unknown }[] = []): {
	postJson: PostJson;
	calls: { url: string; body: unknown }[];
} {
	const calls: { url: string; body: unknown }[] = [];
	const postJson: PostJson = async (url, body) => {
		calls.push({ url, body });
		const failure = failing.find((entry) => entry.url === url);
		if (failure !== undefined) throw failure.error;
		return { accepted: true, index: calls.length - 1 };
	};
	return { postJson, calls };
}

describe('submitAll cross-submission (§9.1)', () => {
	it('sends every attestation to every log and reports acceptance', async () => {
		const { postJson, calls } = fakePoster();
		const result = await submitAll({
			attestations: attestations(2),
			postJson,
			logUrls: [LOG_A, LOG_B],
		});
		expect(calls).toHaveLength(4);
		expect(result.allAccepted).toBe(true);
		expect(result.crossSubmitted).toBe(true);
		expect(result.failedLogs).toEqual([]);
		expect(result.submissions[0]?.outcomes.map((outcome) => outcome.logUrl)).toEqual([
			LOG_A,
			LOG_B,
		]);
		expect(result.submissions[0]?.acceptedLogs).toBe(2);
		expect(result.submissions[0]?.outcomes[0]).toMatchObject({ ok: true });
	});

	it('tolerates one log failing: the record still exists elsewhere', async () => {
		const { postJson } = fakePoster([{ url: LOG_B, error: new Error('502 bad gateway') }]);
		const result = await submitAll({
			attestations: attestations(2),
			postJson,
			logUrls: [LOG_A, LOG_B],
		});
		expect(result.allAccepted).toBe(true);
		// Accepted, but no longer redundant — the caller must be able to see that.
		expect(result.crossSubmitted).toBe(false);
		expect(result.failedLogs).toEqual([LOG_B]);
		const [first] = result.submissions;
		expect(first?.acceptedLogs).toBe(1);
		expect(first?.crossSubmitted).toBe(false);
		expect(first?.outcomes[1]).toEqual({ logUrl: LOG_B, ok: false, error: '502 bad gateway' });
	});

	it('keeps redundancy when a third log covers the failure', async () => {
		const { postJson } = fakePoster([{ url: LOG_C, error: new Error('timeout') }]);
		const result = await submitAll({
			attestations: attestations(1),
			postJson,
			logUrls: [LOG_A, LOG_B, LOG_C],
		});
		expect(result.crossSubmitted).toBe(true);
		expect(result.submissions[0]?.acceptedLogs).toBe(MIN_CROSS_SUBMIT_LOGS);
		expect(result.failedLogs).toEqual([LOG_C]);
	});

	it('reports total failure without throwing', async () => {
		const { postJson } = fakePoster([
			{ url: LOG_A, error: new Error('connection refused') },
			{ url: LOG_B, error: 'dns failure' },
		]);
		const result = await submitAll({
			attestations: attestations(1),
			postJson,
			logUrls: [LOG_A, LOG_B],
		});
		expect(result.allAccepted).toBe(false);
		expect(result.crossSubmitted).toBe(false);
		expect(result.failedLogs).toEqual([LOG_A, LOG_B]);
		expect(result.submissions[0]?.outcomes.map((outcome) => outcome.ok)).toEqual([false, false]);
		expect(result.submissions[0]?.outcomes[1]).toMatchObject({ error: 'dns failure' });
	});

	it('describes a thrown non-error without crashing the batch', async () => {
		const { postJson } = fakePoster([{ url: LOG_A, error: { status: 500 } }]);
		const result = await submitAll({
			attestations: attestations(1),
			postJson,
			logUrls: [LOG_A, LOG_B],
		});
		expect(result.submissions[0]?.outcomes[0]).toEqual({
			logUrl: LOG_A,
			ok: false,
			error: 'submission failed',
		});
		expect(result.allAccepted).toBe(true);
	});

	it('reports a per-attestation split when a log rejects only one record', async () => {
		const calls: string[] = [];
		const postJson: PostJson = async (url, body) => {
			calls.push(url);
			const { subject } = body as Attestation;
			if (url === LOG_B && subject.domain === 'sender-1.example') {
				throw new Error('duplicate submission');
			}
			return { accepted: true };
		};
		const result = await submitAll({
			attestations: attestations(3),
			postJson,
			logUrls: [LOG_A, LOG_B],
		});
		expect(result.allAccepted).toBe(true);
		expect(result.crossSubmitted).toBe(false);
		// LOG_B took two of three, so it is not a failed log.
		expect(result.failedLogs).toEqual([]);
		expect(result.submissions.map((submission) => submission.crossSubmitted)).toEqual([
			true,
			false,
			true,
		]);
		expect(calls).toHaveLength(6);
	});

	it('collapses duplicate log URLs — posting twice to one log is not redundancy', async () => {
		const { postJson, calls } = fakePoster();
		const result = await submitAll({
			attestations: attestations(1),
			postJson,
			logUrls: [LOG_A, LOG_A, ''],
		});
		expect(calls).toHaveLength(1);
		expect(result.crossSubmitted).toBe(false);
		expect(result.allAccepted).toBe(true);
	});

	it('reports nothing to submit as a success, not as two dead logs', async () => {
		const { postJson, calls } = fakePoster();
		const result = await submitAll({ attestations: [], postJson, logUrls: [LOG_A, LOG_B] });
		expect(result).toEqual({
			submissions: [],
			allAccepted: true,
			crossSubmitted: true,
			failedLogs: [],
		});
		expect(calls).toEqual([]);
	});

	it('still refuses an empty submission with no logs configured', async () => {
		const { postJson } = fakePoster();
		await expect(submitAll({ attestations: [], postJson, logUrls: [] })).rejects.toThrow(
			RangeError
		);
	});

	it('refuses to believe it published when there is nowhere to publish', async () => {
		const { postJson } = fakePoster();
		await expect(
			submitAll({ attestations: attestations(1), postJson, logUrls: [] })
		).rejects.toThrow(RangeError);
	});

	it('submits attestations in order', async () => {
		const seen: unknown[] = [];
		const postJson: PostJson = async (_url, body) => {
			seen.push((body as Attestation).body);
			return null;
		};
		await submitAll({ attestations: attestations(3), postJson, logUrls: [LOG_A] });
		expect(seen).toEqual([{ hits: 1 }, { hits: 2 }, { hits: 3 }]);
	});
});
