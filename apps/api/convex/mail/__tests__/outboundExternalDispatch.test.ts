import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { dispatchViaExternalWorker } from '../outbound/dispatch';

vi.mock('../mtaClient', () => ({
	getMailSyncConfig: () => ({ baseUrl: 'https://mail-sync.test', apiKey: 'sync-key' }),
}));
vi.mock('../../lib/sealedBlob', () => ({
	sealedBlobUrl: async () => 'https://convex.test/sealed-blob/raw',
}));

/**
 * The external worker answers one `/send` for every recipient. Each entry of
 * its answer is read on its own, so a bounce survives an unreadable entry
 * listed beside it.
 */

const MAIL_MESSAGE_ID = 'mailMessage1' as Id<'mailMessages'>;
const RECIPIENTS = ['a@example.com', 'b@example.com'];

function fakeCtx() {
	const runMutation = vi.fn(async () => undefined);
	return { ctx: { runMutation } as unknown as ActionCtx, runMutation };
}

async function dispatchAnswering(answer: unknown) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json(answer, { status: 200 }))
	);
	const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
	const { ctx, runMutation } = fakeCtx();
	await dispatchViaExternalWorker(ctx, {
		externalAccountId: 'account1' as Id<'externalMailAccounts'>,
		mailMessageId: MAIL_MESSAGE_ID,
		fromAddress: 'me@owlat.example',
		recipients: RECIPIENTS,
		rawStorageId: 'storage1' as Id<'_storage'>,
		rfc822MessageId: '<m1@owlat.example>',
	});
	const transitions = runMutation.mock.calls.flatMap((call) => {
		const args = (call as unknown[])[1] as {
			transitions: { recipientIdx: number; input: Record<string, unknown> }[];
		};
		return args.transitions;
	});
	const byIdx = new Map(transitions.map((t) => [t.recipientIdx, t.input] as const));
	const logs = logged.mock.calls.map((call) => call.map(String).join(' '));
	return { byIdx, logs, commits: runMutation.mock.calls.length, transitions: transitions.length };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('dispatchViaExternalWorker answer reading', () => {
	it('keeps a readable bounce when another entry does not decode', async () => {
		const { byIdx, logs, commits, transitions } = await dispatchAnswering({
			recipients: [
				{ address: 'a@example.com', status: 'bounced', error: '550 No such user' },
				{ address: 'b@example.com', status: 42 },
			],
		});

		// Every recipient's outcome of the one `/send` lands in one commit.
		expect(commits).toBe(1);
		expect(transitions).toBe(2);
		expect(byIdx.get(0)).toMatchObject({ to: 'bounced', bounceMessage: '550 No such user' });
		expect(byIdx.get(1)).toMatchObject({ to: 'sent' });
		expect(logs.join('\n')).toContain('$.recipients[1].status');
		expect(logs.join('\n')).not.toContain('b@example.com');
	});

	it('keeps a bounce whose message is not text, with the default message', async () => {
		const { byIdx } = await dispatchAnswering({
			recipients: [{ address: 'A@Example.com', status: 'bounced', error: { code: 550 } }],
		});

		expect(byIdx.get(0)).toMatchObject({ to: 'bounced', bounceMessage: 'Rejected by SMTP server' });
		expect(byIdx.get(1)).toMatchObject({ to: 'sent' });
	});

	it('bounces every recipient of an SMTPUTF8 refusal answered with a 2xx', async () => {
		const error =
			'Recipient/sender address requires SMTPUTF8 (RFC 6531) but the SMTP server does not support it';
		const { byIdx } = await dispatchAnswering({
			recipients: RECIPIENTS.map((address) => ({ address, status: 'bounced', error })),
		});

		expect(byIdx.get(0)).toMatchObject({ to: 'bounced', bounceMessage: error });
		expect(byIdx.get(1)).toMatchObject({ to: 'bounced', bounceMessage: error });
	});

	it('records sent when the answer names no recipient it can read', async () => {
		for (const answer of [null, [], { recipients: 'all bounced' }, {}]) {
			const { byIdx } = await dispatchAnswering(answer);
			expect(byIdx.get(0)).toMatchObject({ to: 'sent' });
			expect(byIdx.get(1)).toMatchObject({ to: 'sent' });
			vi.restoreAllMocks();
		}
	});
});
