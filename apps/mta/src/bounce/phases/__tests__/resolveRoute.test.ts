import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ParsedMail } from 'mailparser';

vi.mock('../../../inbound/router.js', () => ({
	findRoute: vi.fn(),
}));
vi.mock('../../../inbound/mailboxResolver.js', () => ({
	findMailboxRoute: vi.fn(),
}));

import { resolveRoutePhase } from '../resolveRoute.js';
import { findRoute } from '../../../inbound/router.js';
import { findMailboxRoute } from '../../../inbound/mailboxResolver.js';
import type { BasePhaseCtx, PhaseDeps } from '../../types.js';
import type { InboundRoute } from '../../../inbound/router.js';
import type { MailboxCacheEntry } from '../../../inbound/mailboxResolver.js';

function makeCtx(overrides: Partial<BasePhaseCtx> = {}): BasePhaseCtx {
	return {
		parsed: {
			to: { value: [{ address: 'me@org.example' }] },
			cc: { value: [{ address: 'cc1@org.example' }, { address: 'cc2@org.example' }] },
			bcc: undefined,
			references: ['<a@b>', '<c@d>'],
			attachments: [
				{ filename: 'a.pdf', contentType: 'application/pdf', size: 10, contentId: 'cid-1' },
			],
		} as unknown as ParsedMail,
		rawBuffer: Buffer.alloc(0),
		rcptTo: 'inbox@org.example',
		...overrides,
	};
}

const deps: PhaseDeps = { redis: {} as never, config: {} as never };

function makeRoute(overrides: Partial<InboundRoute> = {}): InboundRoute {
	return {
		id: 'org.example:inbox',
		domain: 'org.example',
		address: 'inbox',
		mode: 'accept',
		organizationId: 'org-1',
		createdAt: 0,
		...overrides,
	};
}

beforeEach(() => vi.clearAllMocks());

describe('resolveRoutePhase — terminal classifications', () => {
	it('bounceTo(unrecognized) when rcptTo is missing', async () => {
		const out = await resolveRoutePhase.run(deps, makeCtx({ rcptTo: undefined }));
		expect(out).toEqual({
			kind: 'bounceTo',
			attempt: { kind: 'unrecognized', rcptTo: undefined },
		});
		expect(findMailboxRoute).not.toHaveBeenCalled();
	});

	it('bounceTo(mailbox) when the personal-mailbox cache hits', async () => {
		const mailbox: MailboxCacheEntry = {
			mailboxId: 'mb-1',
			organizationId: 'org-2',
			usedBytes: 0,
			cachedAt: 0,
		};
		vi.mocked(findMailboxRoute).mockResolvedValueOnce(mailbox);

		const out = await resolveRoutePhase.run(deps, makeCtx({ dkimResult: 'pass' }));
		expect(out.kind).toBe('bounceTo');
		if (out.kind === 'bounceTo' && out.attempt.kind === 'mailbox') {
			expect(out.attempt.mailbox).toEqual(mailbox);
			expect(out.attempt.rcptTo).toBe('inbox@org.example');
			// The DKIM verdict computed in onData is carried onto the attempt.
			expect(out.attempt.dkimResult).toBe('pass');
			expect(out.attempt.attachments).toEqual([
				{
					filename: 'a.pdf',
					contentType: 'application/pdf',
					size: 10,
					contentId: 'cid-1',
					partIndex: '0',
				},
			]);
			expect(out.attempt.toAddrs).toEqual(['me@org.example']);
			expect(out.attempt.ccAddrs).toEqual(['cc1@org.example', 'cc2@org.example']);
			expect(out.attempt.bccAddrs).toEqual([]);
			expect(out.attempt.references).toBe('<a@b> <c@d>');
		}
		expect(findRoute).not.toHaveBeenCalled();
	});

	it('bounceTo(endpoint_forward) for route mode=endpoint', async () => {
		vi.mocked(findMailboxRoute).mockResolvedValueOnce(null);
		const route = makeRoute({ mode: 'endpoint', endpointUrl: 'https://hook' });
		vi.mocked(findRoute).mockResolvedValueOnce(route);

		const out = await resolveRoutePhase.run(deps, makeCtx());
		expect(out).toEqual({
			kind: 'bounceTo',
			attempt: { kind: 'endpoint_forward', route, rcptTo: 'inbox@org.example' },
		});
	});

	it('bounceTo(route_hold) for route mode=hold', async () => {
		vi.mocked(findMailboxRoute).mockResolvedValueOnce(null);
		const route = makeRoute({ mode: 'hold' });
		vi.mocked(findRoute).mockResolvedValueOnce(route);

		const out = await resolveRoutePhase.run(deps, makeCtx());
		expect(out).toEqual({
			kind: 'bounceTo',
			attempt: { kind: 'route_hold', route, rcptTo: 'inbox@org.example' },
		});
	});

	it('bounceTo(route_bounce) for route mode=bounce', async () => {
		vi.mocked(findMailboxRoute).mockResolvedValueOnce(null);
		const route = makeRoute({ mode: 'bounce' });
		vi.mocked(findRoute).mockResolvedValueOnce(route);

		const out = await resolveRoutePhase.run(deps, makeCtx());
		expect(out).toEqual({
			kind: 'bounceTo',
			attempt: { kind: 'route_bounce', route, rcptTo: 'inbox@org.example' },
		});
	});

	it('bounceTo(unrecognized) for route mode=reject (defensive — reject is enforced at onRcptTo)', async () => {
		vi.mocked(findMailboxRoute).mockResolvedValueOnce(null);
		vi.mocked(findRoute).mockResolvedValueOnce(makeRoute({ mode: 'reject' }));

		const out = await resolveRoutePhase.run(deps, makeCtx());
		expect(out).toEqual({
			kind: 'bounceTo',
			attempt: { kind: 'unrecognized', rcptTo: 'inbox@org.example' },
		});
	});

	it('bounceTo(unrecognized) when no inbound route exists', async () => {
		vi.mocked(findMailboxRoute).mockResolvedValueOnce(null);
		vi.mocked(findRoute).mockResolvedValueOnce(null);

		const out = await resolveRoutePhase.run(deps, makeCtx());
		expect(out).toEqual({
			kind: 'bounceTo',
			attempt: { kind: 'unrecognized', rcptTo: 'inbox@org.example' },
		});
	});
});

describe('resolveRoutePhase — continue (accept)', () => {
	it('continues with the route added to ctx for the accept mode', async () => {
		vi.mocked(findMailboxRoute).mockResolvedValueOnce(null);
		const route = makeRoute({ mode: 'accept' });
		vi.mocked(findRoute).mockResolvedValueOnce(route);

		const out = await resolveRoutePhase.run(deps, makeCtx());
		expect(out.kind).toBe('continue');
		if (out.kind === 'continue') {
			expect(out.ctx.route).toBe(route);
			expect(out.ctx.rcptTo).toBe('inbox@org.example');
		}
	});
});
