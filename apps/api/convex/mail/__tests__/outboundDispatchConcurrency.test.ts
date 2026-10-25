import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchViaMta } from '../outbound/dispatch';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import type { DraftRow } from '../rfc822';

/**
 * Postbox MTA dispatch fans the per-recipient intake POSTs out instead of
 * sending them one after another, and still records every recipient's own
 * outcome on its own index.
 */

const MAIL_MESSAGE_ID = 'mailMessage1' as Id<'mailMessages'>;
const MTA = { baseUrl: 'https://mta.test', apiKey: 'mta-key' };

const DRAFT = {
	_id: 'draft1' as Id<'mailDrafts'>,
	mailboxId: 'mailbox1' as Id<'mailboxes'>,
	toAddresses: [],
	ccAddresses: [],
	bccAddresses: [],
	fromAddress: 'me@owlat.test',
	subject: 'Hello',
	bodyHtml: '<p>hi</p>',
	attachments: [],
	state: 'pending_send',
} as unknown as DraftRow;

type Answer = () => Response | Promise<Response>;

/**
 * A fetch whose calls wait until the test releases them, one answer per call.
 * `arrived(n)` resolves once `n` calls have been made, so the test steps
 * through the dispatch instead of spinning until requests show up.
 */
function heldFetch() {
	const pending: Array<{
		to: string;
		messageId: string;
		init: RequestInit;
		answer: (a: Answer) => void;
	}> = [];
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	const wake = () => {
		for (const waiter of waiters.filter((w) => pending.length >= w.count)) {
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	};
	let inFlight = 0;
	let peak = 0;
	const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { to: string; messageId: string };
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		const call = new Promise<Response>((resolve, reject) => {
			pending.push({
				to: body.to,
				messageId: body.messageId,
				init: init!,
				answer: (answer) => {
					inFlight -= 1;
					Promise.resolve().then(answer).then(resolve, reject);
				},
			});
		});
		wake();
		return call;
	});
	vi.stubGlobal('fetch', fetchMock);
	const arrived = (count: number) =>
		new Promise<void>((resolve) => {
			waiters.push({ count, resolve });
			wake();
		});
	return { pending, arrived, peak: () => peak };
}

function fakeCtx() {
	const runMutation = vi.fn(async () => undefined);
	return { ctx: { runMutation } as unknown as ActionCtx, runMutation };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('dispatchViaMta', () => {
	it('posts every recipient before any answer arrives, and records each outcome on its own index', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const held = heldFetch();
		const { ctx, runMutation } = fakeCtx();
		const recipients = ['a@example.com', 'b@example.com', 'c@example.com'];

		const run = dispatchViaMta(ctx, {
			draft: DRAFT,
			sealed: null,
			mailMessageId: MAIL_MESSAGE_ID,
			recipients,
			rfc822MessageId: '<m1@owlat.test>',
			allowedFromAddresses: ['me@owlat.test'],
			mta: MTA,
		});
		await held.arrived(3);

		// All three intakes are open at once — the old loop had exactly one.
		expect(held.pending.map((p) => p.to)).toEqual(recipients);
		expect(held.pending.map((p) => p.messageId)).toEqual([
			`pb-${MAIL_MESSAGE_ID}-0`,
			`pb-${MAIL_MESSAGE_ID}-1`,
			`pb-${MAIL_MESSAGE_ID}-2`,
		]);
		// Each carries a deadline.
		for (const p of held.pending) expect(p.init.signal).toBeInstanceOf(AbortSignal);

		// Answer out of order: a network error, a refusal, an accept.
		held.pending[2]!.answer(() => {
			throw new TypeError('fetch failed');
		});
		held.pending[1]!.answer(() => new Response('bad from', { status: 403 }));
		held.pending[0]!.answer(() => new Response('{}', { status: 202 }));
		await run;

		const transitions = runMutation.mock.calls.map(
			(call) => (call as unknown[])[1] as { recipientIdx: number; input: Record<string, unknown> }
		);
		expect(transitions).toHaveLength(2);
		const byIdx = new Map(transitions.map((t) => [t.recipientIdx, t.input]));
		expect(byIdx.get(1)).toMatchObject({ to: 'bounced', bounceMessage: 'MTA POST 403: bad from' });
		expect(byIdx.get(2)).toMatchObject({
			to: 'failed',
			errorMessage: 'fetch failed',
			errorCode: 'MTA_POST_NETWORK',
		});
		// The accepted recipient waits for its webhook; nothing is written for it now.
		expect(byIdx.has(0)).toBe(false);
	});

	it('keeps a long recipient list to a bounded number of intakes in flight', async () => {
		const held = heldFetch();
		const { ctx } = fakeCtx();
		const recipients = Array.from({ length: 15 }, (_, i) => `r${i}@example.com`);

		const run = dispatchViaMta(ctx, {
			draft: DRAFT,
			sealed: null,
			mailMessageId: MAIL_MESSAGE_ID,
			recipients,
			rfc822MessageId: '<m2@owlat.test>',
			allowedFromAddresses: ['me@owlat.test'],
			mta: MTA,
		});

		const accept = () => new Response('{}', { status: 202 });
		// Six intakes open at once and no more; each answered one frees a slot
		// for the next recipient: 6, then 6 more, then the last 3.
		await held.arrived(6);
		expect(held.pending).toHaveLength(6);
		for (const p of held.pending.slice(0, 6)) p.answer(accept);
		await held.arrived(12);
		expect(held.pending).toHaveLength(12);
		for (const p of held.pending.slice(6, 12)) p.answer(accept);
		await held.arrived(15);
		for (const p of held.pending.slice(12)) p.answer(accept);
		await run;

		expect(held.pending.map((p) => p.to).sort()).toEqual([...recipients].sort());
		expect(held.peak()).toBe(6);
	});
});
