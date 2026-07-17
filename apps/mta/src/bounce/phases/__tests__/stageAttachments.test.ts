import { describe, it, expect } from 'vitest';
import type { ParsedMessage } from '@owlat/mail-message';
import { stageAttachmentsPhase } from '../stageAttachments.js';
import type { CtxWithAcceptRoute, PhaseDeps } from '../../types.js';
import type { InboundRoute } from '../../../inbound/router.js';

function makeRoute(): InboundRoute {
	return {
		id: 'r-1',
		domain: 'org.example',
		address: 'inbox',
		mode: 'accept',
		organizationId: 'org-1',
		createdAt: 0,
	};
}

function makeCtx(parsed: Record<string, unknown>): CtxWithAcceptRoute {
	return {
		parsed: parsed as unknown as ParsedMessage,
		rawBuffer: Buffer.alloc(0),
		rcptTo: 'inbox@org.example',
		route: makeRoute(),
	};
}

const deps: PhaseDeps = { redis: {} as never, config: {} as never };

describe('stageAttachmentsPhase', () => {
	it('extracts string headers and base64-encodes attachment content', async () => {
		const ctx = makeCtx({
			headers: new Map<string, unknown>([
				['from', 'bob@example'],
				['subject', 'hi'],
				['received', { line: 'complex object' }],
			]) as never,
			attachments: [
				{
					filename: 'a.pdf',
					contentType: 'application/pdf',
					size: 4,
					content: Buffer.from('AAAA'),
				},
				{
					filename: 'b.txt',
					contentType: undefined,
					size: undefined,
					content: undefined,
				} as never,
			],
		});

		const out = await stageAttachmentsPhase.run(deps, ctx);
		expect(out.kind).toBe('bounceTo');
		if (out.kind === 'bounceTo' && out.attempt.kind === 'inbound_accept') {
			expect(out.attempt.route).toBe(ctx.route);
			expect(out.attempt.rcptTo).toBe('inbox@org.example');
			expect(out.attempt.headers).toEqual({ from: 'bob@example', subject: 'hi' });
			expect(out.attempt.attachments).toEqual([
				{
					index: 0,
					filename: 'a.pdf',
					contentType: 'application/pdf',
					size: 4,
					contentBase64: Buffer.from('AAAA').toString('base64'),
				},
				{
					index: 1,
					filename: 'b.txt',
					contentType: 'application/octet-stream',
					size: 0,
					contentBase64: undefined,
				},
			]);
		}
	});

	it('handles a parsed mail with no attachments and no headers', async () => {
		const ctx = makeCtx({});
		const out = await stageAttachmentsPhase.run(deps, ctx);
		if (out.kind === 'bounceTo' && out.attempt.kind === 'inbound_accept') {
			expect(out.attempt.headers).toEqual({});
			expect(out.attempt.attachments).toEqual([]);
		}
	});
});
