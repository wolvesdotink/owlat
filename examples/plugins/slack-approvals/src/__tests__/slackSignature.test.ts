import { describe, expect, it } from 'vitest';
import { MAX_RAW_BODY_BYTES } from '../bodyLimit';
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

	it('reports an ABSENT timestamp header as missing_timestamp', async () => {
		const headers = await validHeaders();
		const result = await verifySlackSignature({
			signingSecret: SECRET,
			signatureHeader: headers.signatureHeader,
			timestampHeader: null,
			rawBody: headers.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'missing_timestamp' });
	});

	it('reports a PRESENT-but-garbage timestamp header as malformed_timestamp', async () => {
		const headers = await validHeaders();
		const result = await verifySlackSignature({
			signingSecret: SECRET,
			signatureHeader: headers.signatureHeader,
			timestampHeader: 'not-a-number',
			rawBody: headers.rawBody,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'malformed_timestamp' });
	});

	it('rejects an over-cap body before any signature work runs', async () => {
		// Sign the oversized body CORRECTLY: were the length guard not ahead of the
		// HMAC, this request would verify. It must still be rejected as
		// body_too_large, proving the cap short-circuits before hashing.
		const huge = 'x'.repeat(MAX_RAW_BODY_BYTES + 1);
		const result = await verifySlackSignature({
			signingSecret: SECRET,
			signatureHeader: await signSlackRequest(SECRET, TS, huge),
			timestampHeader: String(TS),
			rawBody: huge,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ valid: false, reason: 'body_too_large' });
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
