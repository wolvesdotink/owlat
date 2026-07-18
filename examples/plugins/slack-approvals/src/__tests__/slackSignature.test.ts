import { describe, expect, it } from 'vitest';
import {
	SLACK_SIGNATURE_TOLERANCE_SECONDS,
	signSlackRequest,
	verifySlackSignature,
} from '../slackSignature';

const SECRET = 'slack-signing-secret';
const BODY = 'payload=%7B%22type%22%3A%22block_actions%22%7D';
const TS = 1_700_000_000;
const NOW_MS = TS * 1000;

async function validHeaders(overrides?: { secret?: string; ts?: number; body?: string }) {
	const secret = overrides?.secret ?? SECRET;
	const ts = overrides?.ts ?? TS;
	const body = overrides?.body ?? BODY;
	return {
		signatureHeader: await signSlackRequest(secret, ts, body),
		timestampHeader: String(ts),
		rawBody: body,
	};
}

describe('verifySlackSignature', () => {
	it('accepts a correctly signed, fresh request', async () => {
		const headers = await validHeaders();
		const result = await verifySlackSignature({
			signingSecret: SECRET,
			signatureHeader: headers.signatureHeader,
			timestampHeader: headers.timestampHeader,
			rawBody: headers.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: true });
	});

	it('rejects a signature made with the wrong secret', async () => {
		const headers = await validHeaders({ secret: 'attacker-secret' });
		const result = await verifySlackSignature({
			signingSecret: SECRET,
			signatureHeader: headers.signatureHeader,
			timestampHeader: headers.timestampHeader,
			rawBody: headers.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
	});

	it('rejects when the body is tampered after signing', async () => {
		const headers = await validHeaders();
		const result = await verifySlackSignature({
			signingSecret: SECRET,
			signatureHeader: headers.signatureHeader,
			timestampHeader: headers.timestampHeader,
			rawBody: `${headers.rawBody}&injected=1`,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
	});

	it('rejects a stale timestamp (replay defense), even with a valid signature', async () => {
		const headers = await validHeaders();
		const staleNow = NOW_MS + (SLACK_SIGNATURE_TOLERANCE_SECONDS + 1) * 1000;
		const result = await verifySlackSignature({
			signingSecret: SECRET,
			signatureHeader: headers.signatureHeader,
			timestampHeader: headers.timestampHeader,
			rawBody: headers.rawBody,
			nowMs: staleNow,
		});
		expect(result).toEqual({ valid: false, reason: 'stale_timestamp' });
	});

	it('rejects a missing signature header', async () => {
		const result = await verifySlackSignature({
			signingSecret: SECRET,
			signatureHeader: null,
			timestampHeader: String(TS),
			rawBody: BODY,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'missing_signature' });
	});

	it('rejects a non-numeric timestamp header', async () => {
		const headers = await validHeaders();
		const result = await verifySlackSignature({
			signingSecret: SECRET,
			signatureHeader: headers.signatureHeader,
			timestampHeader: 'not-a-number',
			rawBody: headers.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'missing_timestamp' });
	});

	it('does not accept a signature that differs only in the last byte', async () => {
		const headers = await validHeaders();
		const tampered = `${headers.signatureHeader.slice(0, -1)}${
			headers.signatureHeader.endsWith('0') ? '1' : '0'
		}`;
		const result = await verifySlackSignature({
			signingSecret: SECRET,
			signatureHeader: tampered,
			timestampHeader: headers.timestampHeader,
			rawBody: headers.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
	});
});
