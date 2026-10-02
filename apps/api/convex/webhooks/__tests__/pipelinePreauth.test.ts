import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderFeedbackContribution } from '@owlat/provider-kit';
import type { ActionCtx } from '../../_generated/server';
import { runInboundPipeline, type InboundAdapter } from '../pipeline';
import { composeProviderFeedbackAdapter } from '../providerFeedbackAdapter';
import { twilioAdapter } from '../adapters/twilio';
import { metaAdapter } from '../adapters/meta';
import { genericAdapter } from '../adapters/generic';

/**
 * What the inbound pipeline does before it has verified anything: a request
 * without the adapter's signature headers is refused without reading the body
 * or charging a bucket, and a verify-first adapter reads a body for free only
 * when its declared length is small. Anything larger (or undeclared) pays a
 * separate `<source>:unverified:<ip>` key before it is read.
 */

const FREE_VERIFY_BYTES = 256 * 1024;

afterEach(() => vi.unstubAllEnvs());

function recordingCtx(allow = true): { ctx: ActionCtx; keys: string[] } {
	const keys: string[] = [];
	const ctx = {
		runMutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
			if (typeof args['key'] === 'string') keys.push(args['key']);
			return { ok: allow, retryAfter: allow ? 0 : 1000 };
		}),
		runQuery: vi.fn(async () => null),
	} as unknown as ActionCtx;
	return { ctx, keys };
}

function request(headers: Record<string, string>, body: string): Request {
	return new Request('https://deploy.convex.site/webhooks/test', { method: 'POST', headers, body });
}

function verifyFirstAdapter(): InboundAdapter {
	return {
		source: 'test',
		verifyBeforeRateLimit: true,
		missingSignatureHeaders: (req) =>
			req.headers.has('x-test-signature') ? null : 'Missing test signature',
		verifySignature: vi.fn().mockResolvedValue({ ok: false, status: 401, reason: 'unsigned' }),
		parseEvent: () => null,
	};
}

describe('runInboundPipeline: missing signature headers', () => {
	it('refuses before reading the body or charging a bucket', async () => {
		const adapter = verifyFirstAdapter();
		const { ctx, keys } = recordingCtx();
		const req = request({ 'Content-Length': '11' }, 'hello world');
		const res = await runInboundPipeline(ctx, req, adapter);
		expect(res.status).toBe(401);
		expect(req.bodyUsed).toBe(false);
		expect(keys).toEqual([]);
		expect(adapter.verifySignature).not.toHaveBeenCalled();
	});

	it('applies to the declared provider feedback schemes', async () => {
		const contributions: ProviderFeedbackContribution<unknown>['verifier'][] = [
			{
				scheme: 'hmac-timestamp-body',
				signatureHeader: 'X-Test-Signature',
				timestampHeader: 'X-Test-Timestamp',
				secretEnvVar: 'MTA_WEBHOOK_SECRET',
				algorithm: 'sha256',
				encoding: 'hex',
				toleranceSeconds: 300,
			},
			{ scheme: 'svix', secretEnvVar: 'RESEND_WEBHOOK_SECRET', toleranceSeconds: 300 },
			{ scheme: 'mandrill-form', secretEnvVar: 'MANDRILL_WEBHOOK_KEY' },
		];
		for (const verifier of contributions) {
			const adapter = composeProviderFeedbackAdapter('test', {
				verifier,
				parser: { source: 'test', parseEvent: () => null },
			} as unknown as ProviderFeedbackContribution<unknown>);
			const { ctx, keys } = recordingCtx();
			const req = request({ 'Content-Length': '2' }, '{}');
			const res = await runInboundPipeline(ctx, req, adapter);
			expect(res.status, verifier.scheme).toBe(401);
			expect(req.bodyUsed, verifier.scheme).toBe(false);
			expect(keys, verifier.scheme).toEqual([]);
		}
	});

	it('applies to the channel adapters, which are otherwise charged first', async () => {
		for (const adapter of [twilioAdapter, metaAdapter, genericAdapter]) {
			const { ctx, keys } = recordingCtx();
			const req = request({ 'Content-Length': '2' }, '{}');
			const res = await runInboundPipeline(ctx, req, adapter);
			expect(res.status, adapter.source).toBe(401);
			expect(req.bodyUsed, adapter.source).toBe(false);
			expect(keys, adapter.source).toEqual([]);
		}
	});
});

describe('runInboundPipeline: bounded pre-verification read', () => {
	const signed = { 'x-test-signature': 'sig' };

	it('verifies a small declared body without charging anything', async () => {
		const adapter = verifyFirstAdapter();
		const { ctx, keys } = recordingCtx();
		const res = await runInboundPipeline(
			ctx,
			request({ ...signed, 'Content-Length': '11' }, 'hello world'),
			adapter
		);
		expect(res.status).toBe(401);
		expect(adapter.verifySignature).toHaveBeenCalledOnce();
		expect(keys).toEqual([]);
	});

	it('charges a separate unverified key before reading a large body', async () => {
		const adapter = verifyFirstAdapter();
		const { ctx, keys } = recordingCtx();
		const body = 'a'.repeat(FREE_VERIFY_BYTES + 1);
		const res = await runInboundPipeline(
			ctx,
			request({ ...signed, 'Content-Length': String(body.length) }, body),
			adapter
		);
		expect(res.status).toBe(401);
		expect(keys).toEqual(['test:unverified:unknown']);
	});

	it('treats a body with no declared length as large', async () => {
		const adapter = verifyFirstAdapter();
		const { ctx, keys } = recordingCtx(false);
		const req = request(signed, 'hello world');
		req.headers.delete('content-length');
		const res = await runInboundPipeline(ctx, req, adapter);
		expect(res.status).toBe(429);
		expect(keys).toEqual(['test:unverified:unknown']);
		expect(adapter.verifySignature).not.toHaveBeenCalled();
	});

	it('charges the verified key once a large body verifies', async () => {
		const adapter = verifyFirstAdapter();
		vi.mocked(adapter.verifySignature).mockResolvedValue({ ok: true });
		const { ctx, keys } = recordingCtx();
		const body = 'a'.repeat(FREE_VERIFY_BYTES + 1);
		const res = await runInboundPipeline(
			ctx,
			request({ ...signed, 'Content-Length': String(body.length) }, body),
			adapter
		);
		expect(res.status).toBe(200);
		expect(keys.filter((k) => k.startsWith('test:'))).toEqual([
			'test:unverified:unknown',
			'test:unknown',
		]);
	});
});
