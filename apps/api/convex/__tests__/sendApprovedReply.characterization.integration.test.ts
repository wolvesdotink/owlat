/**
 * What `agent/agentPipeline.sendApprovedReply` writes on each of its paths:
 * the pre-flight refusals, the envelope it hands the send intake, the channel
 * hand-off, the reference monitor's veto, the file-copy wait and the approval
 * feedback it records once a human-approved reply leaves.
 *
 * The intake's refusal mapping lives in
 * `agent/__tests__/sendApprovedReply.suppression.test.ts` and the attachment
 * paths in `teamReplyAttachments.integration.test.ts`; this suite pins the
 * rest, so the handler can be split without moving what it writes.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { modules } from './testModulesWithoutNodeActions';
import { seedCleanInterpretation } from '../mail/interpret/__tests__/interpret.testlib';
import {
	createTestContact,
	createTestConversationThread,
	createTestInboundMessage,
	createTestInstanceSettings,
} from './factories';

// Agent replies enqueue on the transactional workpool. Stub it so nothing is
// dispatched and the envelope the worker would get can be inspected.
const { enqueueActionMock } = vi.hoisted(() => ({
	enqueueActionMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../delivery/workpool', () => ({
	transactionalEmailPool: { enqueueAction: enqueueActionMock },
	campaignEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	EMAIL_WORKPOOL_RETRY_BEHAVIOR: { maxAttempts: 1 },
}));

type Harness = TestConvex<typeof schema>;

beforeEach(() => {
	vi.useFakeTimers();
	enqueueActionMock.mockClear();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

type MessageSeed = Record<string, unknown> & { withThread?: boolean };

async function seed(
	t: Harness,
	message: MessageSeed = {},
	settings: Record<string, unknown> = {}
): Promise<{ messageId: Id<'inboundMessages'>; threadId?: Id<'conversationThreads'> }> {
	const { withThread, ...overrides } = message;
	return t.run(async (ctx) => {
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				defaultFromEmail: 'support@owlat.example',
				defaultFromName: 'Owlat Support',
				...settings,
			})
		);
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'customer@example.com' })
		);
		let threadId: Id<'conversationThreads'> | undefined;
		if (withThread) {
			const { updatedAt: _u, channel: _c, ...thread } = createTestConversationThread({ contactId });
			threadId = await ctx.db.insert('conversationThreads', thread);
		}
		const messageId = await ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({
				from: 'Customer <customer@example.com>',
				to: 'support@owlat.example',
				subject: 'Need help',
				messageId: '<question-1@example.com>',
				references: '<earlier@example.com>',
				processingStatus: 'approved',
				draftResponse: 'Here is the help you asked for.',
				draftSubject: 'Re: Need help',
				threadId,
				contactId,
				...overrides,
			})
		);
		return { messageId, threadId };
	});
}

const readMessage = (t: Harness, id: Id<'inboundMessages'>) => t.run((ctx) => ctx.db.get(id));
const sends = (t: Harness) => t.run((ctx) => ctx.db.query('transactionalSends').collect());
const feedback = (t: Harness) => t.run((ctx) => ctx.db.query('autonomyFeedback').collect());
const scheduled = (t: Harness) =>
	t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());

function lastEnvelope() {
	const calls = enqueueActionMock.mock.calls;
	return calls[calls.length - 1]?.[2]?.envelopeInput;
}

async function expectFailedWithoutSend(t: Harness, id: Id<'inboundMessages'>, error: RegExp) {
	const message = await readMessage(t, id);
	expect(message?.processingStatus).toBe('failed');
	expect(message?.errorMessage).toMatch(error);
	expect(await sends(t)).toHaveLength(0);
	expect(enqueueActionMock).not.toHaveBeenCalled();
	expect(await feedback(t)).toHaveLength(0);
}

describe('sendApprovedReply: pre-flight refusals', () => {
	it('does nothing for a message that no longer exists', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seed(t);
		await t.run((ctx) => ctx.db.delete(messageId));

		await t.action(internal.agent.agentPipeline.sendApprovedReply, { inboundMessageId: messageId });

		expect(await sends(t)).toHaveLength(0);
		expect(await scheduled(t)).toHaveLength(0);
	});

	it('fails a message with no draft', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seed(t, { draftResponse: undefined });

		await t.action(internal.agent.agentPipeline.sendApprovedReply, { inboundMessageId: messageId });

		await expectFailedWithoutSend(t, messageId, /^No draft to send$/);
	});

	it('fails a recipient that does not parse as an email address', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seed(t, { from: 'nobody at all' });

		await t.action(internal.agent.agentPipeline.sendApprovedReply, { inboundMessageId: messageId });

		await expectFailedWithoutSend(t, messageId, /Unsupported or invalid reply recipient: "nobody/);
	});

	it('fails when neither the settings nor the environment name a sender', async () => {
		const t = convexTest(schema, modules);
		vi.stubEnv('DEFAULT_FROM_EMAIL', '');
		const { messageId } = await seed(t, {}, { defaultFromEmail: undefined });

		await t.action(internal.agent.agentPipeline.sendApprovedReply, { inboundMessageId: messageId });

		await expectFailedWithoutSend(t, messageId, /^No sending identity configured/);
	});

	it('ends a file-copy wait without writing once the message left approved', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seed(t, { processingStatus: 'draft_ready' });

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
			attachmentWaits: 3,
		});

		expect((await readMessage(t, messageId))?.processingStatus).toBe('draft_ready');
		expect(await sends(t)).toHaveLength(0);
	});
});

describe('sendApprovedReply: the email reply', () => {
	it('enqueues the reply with the threading headers, sender and rendered body', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seed(t, { draftSubject: undefined });

		await t.action(internal.agent.agentPipeline.sendApprovedReply, { inboundMessageId: messageId });

		const rows = await sends(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: 'agent_reply',
			email: 'customer@example.com',
			subject: 'Re: Need help',
			inboundMessageId: messageId,
			status: 'queued',
		});
		expect(lastEnvelope()).toMatchObject({
			to: 'customer@example.com',
			from: 'Owlat Support <support@owlat.example>',
			headers: {
				'In-Reply-To': '<question-1@example.com>',
				References: '<earlier@example.com> <question-1@example.com>',
			},
			template: { subject: 'Re: Need help' },
		});
		expect(lastEnvelope()?.template.htmlContent).toContain('Here is the help you asked for.');
		// The Send completion module drives the message on; the action leaves it.
		expect((await readMessage(t, messageId))?.processingStatus).toBe('approved');
	});

	it("prefers the agent's draft subject and falls back to the environment sender", async () => {
		const t = convexTest(schema, modules);
		vi.stubEnv('DEFAULT_FROM_EMAIL', 'env@owlat.example');
		vi.stubEnv('DEFAULT_FROM_NAME', '');
		const { messageId } = await seed(
			t,
			{ draftSubject: 'Re: Your order', messageId: '' },
			{ defaultFromEmail: undefined, defaultFromName: undefined }
		);

		await t.action(internal.agent.agentPipeline.sendApprovedReply, { inboundMessageId: messageId });

		expect((await sends(t))[0]?.subject).toBe('Re: Your order');
		expect(lastEnvelope()?.from).toBe('env@owlat.example');
		expect(lastEnvelope()?.headers).toBeUndefined();
	});

	it("records a person's approval once the reply is enqueued", async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seed(t);

		await t.action(internal.agent.agentPipeline.sendApprovedReply, { inboundMessageId: messageId });

		const rows = await feedback(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ action: 'approved', inboundMessageId: messageId });
	});

	it('records no approval for an autonomous send', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seed(t, { withThread: true });
		await seedCleanInterpretation(t, threadId!, messageId);

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
			autonomous: true,
		});

		expect(await sends(t)).toHaveLength(1);
		expect(await feedback(t)).toHaveLength(0);
	});

	it('withholds an autonomous reply whose draft carries a credential', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seed(t, {
			threadId: undefined,
			draftResponse: 'Your key is AKIAABCDEFGHIJKLMNOP, keep it safe.',
		});

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
			autonomous: true,
		});

		await expectFailedWithoutSend(t, messageId, /^Reference monitor: .*aws_access_key_id/);
	});

	it('sends the same credential unchanged when a person approved it', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seed(t, {
			draftResponse: 'Your key is AKIAABCDEFGHIJKLMNOP, keep it safe.',
		});

		await t.action(internal.agent.agentPipeline.sendApprovedReply, { inboundMessageId: messageId });

		expect(await sends(t)).toHaveLength(1);
		expect(lastEnvelope()?.template.htmlContent).toContain('AKIAABCDEFGHIJKLMNOP');
	});
});

describe('sendApprovedReply: waiting for a file copy', () => {
	const copying = {
		id: 'copy-1',
		filename: 'prices.pdf',
		contentType: 'application/pdf',
		size: 10,
		origin: 'semanticFile' as const,
		addedBy: 'user-A',
		addedAt: 0,
	};

	async function seedCopying(t: Harness) {
		const seeded = await seed(t, { withThread: true });
		await t.run((ctx) => ctx.db.patch(seeded.threadId!, { replyAttachments: [copying] }));
		return seeded.messageId;
	}

	it('re-queues the send with one more wait while a file is copying', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedCopying(t);

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
			attachmentWaits: 2,
		});

		expect(await sends(t)).toHaveLength(0);
		const message = await readMessage(t, messageId);
		expect(message?.processingStatus).toBe('approved');
		const jobs = (await scheduled(t)).filter(
			(job) => job.name === 'agent/agentPipeline:sendApprovedReply'
		);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.args[0]).toMatchObject({
			inboundMessageId: messageId,
			autonomous: false,
			attachmentWaits: 3,
		});
		expect(message?.pendingAutoSend?.scheduledFnId).toBe(jobs[0]?._id);
		expect(await feedback(t)).toHaveLength(0);
	});

	it('stops for a person after the last wait', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedCopying(t);

		await t.action(internal.agent.agentPipeline.sendApprovedReply, {
			inboundMessageId: messageId,
			attachmentWaits: 24,
		});

		await expectFailedWithoutSend(t, messageId, /still being attached/);
	});
});

describe('sendApprovedReply: a channel reply', () => {
	it('schedules the channel dispatch and records the approval', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seed(t, { to: 'sms', withThread: true });

		await t.action(internal.agent.agentPipeline.sendApprovedReply, { inboundMessageId: messageId });

		const message = await readMessage(t, messageId);
		const jobs = (await scheduled(t)).filter(
			(job) => job.name === 'channels/outbound:dispatchOutbound'
		);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.args[0]).toEqual({
			channel: 'sms',
			contactId: message?.contactId,
			threadId,
			content: { text: 'Here is the help you asked for.', subject: 'Re: Need help' },
			inboundMessageId: messageId,
		});
		expect(await sends(t)).toHaveLength(0);
		expect(message?.processingStatus).toBe('approved');
		expect(await feedback(t)).toHaveLength(1);
	});

	it('fails a channel reply that lost its thread', async () => {
		const t = convexTest(schema, modules);
		const { messageId } = await seed(t, { to: 'whatsapp', threadId: undefined });

		await t.action(internal.agent.agentPipeline.sendApprovedReply, { inboundMessageId: messageId });

		await expectFailedWithoutSend(t, messageId, /^Channel reply \(whatsapp\) is missing/);
		expect(await scheduled(t)).toHaveLength(0);
	});
});
