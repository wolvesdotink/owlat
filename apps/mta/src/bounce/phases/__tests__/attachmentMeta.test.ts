import { describe, it, expect } from 'vitest';
import type { ParsedMessage } from '@owlat/mail-message';
import { attachmentMetaPhase } from '../attachmentMeta.js';
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

describe('attachmentMetaPhase', () => {
	it('extracts string headers and per-attachment metadata, never the bytes', async () => {
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

		const out = await attachmentMetaPhase.run(deps, ctx);
		expect(out.kind).toBe('bounceTo');
		if (out.kind === 'bounceTo' && out.attempt.kind === 'inbound_accept') {
			expect(out.attempt.route).toBe(ctx.route);
			expect(out.attempt.rcptTo).toBe('inbox@org.example');
			expect(out.attempt.headers).toEqual({ from: 'bob@example', subject: 'hi' });
			// The parsed `content` Buffer is present on the first attachment and is
			// deliberately NOT carried forward: a base64 copy of it is what used to
			// end up in Redis for an hour with no reader.
			expect(out.attempt.attachments).toEqual([
				{ index: 0, filename: 'a.pdf', contentType: 'application/pdf', size: 4 },
				{ index: 1, filename: 'b.txt', contentType: 'application/octet-stream', size: 0 },
			]);
		}
	});

	it('handles a parsed mail with no attachments and no headers', async () => {
		const ctx = makeCtx({});
		const out = await attachmentMetaPhase.run(deps, ctx);
		if (out.kind === 'bounceTo' && out.attempt.kind === 'inbound_accept') {
			expect(out.attempt.headers).toEqual({});
			expect(out.attempt.attachments).toEqual([]);
		}
	});
});
