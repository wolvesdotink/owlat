import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import schema from '../schema';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestContact, createTestConversationThread, createTestInboundMessage } from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const allModules = import.meta.glob('../**/*.*s');
// Filter out modules that require external APIs (node runtime actions)
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') &&
		!path.includes('agentSecurity') &&
		!path.includes('agentContext') &&
		!path.includes('agentClassifier') &&
		!path.includes('agentDrafter') &&
		!path.includes('agentRouter') &&
		!path.includes('agent/walker') &&
		!path.includes('agent/steps/index') &&
		!path.includes('agent/steps/shared') &&
		!path.includes('agent/steps/classify') &&
		!path.includes('agent/steps/draft') &&
		!path.includes('knowledgeExtraction') &&
		!path.includes('semanticFileProcessing') &&
		!path.includes('visualizationAgent') &&
		!path.includes('llmProvider')
	)
);

// ============ receiveMessage ============

describe('inbound.receiveMessage', () => {
	it('should create a new contact when sender not found', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		const result = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'New User <newuser@example.com>',
			to: 'inbox@myapp.com',
			subject: 'Hello',
			textBody: 'This is a test email',
			messageId: '<msg-001@example.com>',
			timestamp: Date.now(),
		});

		expect(result.inboundMessageId).toBeDefined();
		expect(result.contactId).toBeDefined();

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(result.contactId!);
			expect(contact).toBeDefined();
			expect(contact!.email).toBe('newuser@example.com');
			expect(contact!.source).toBe('inbound');
			expect(contact!.firstName).toBe('New');
		});
	});

	it('should link to existing contact when email matches', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		// Pre-create a contact (with email identity, so the resolution module
		// finds it via `contactIdentities.by_identifier`).
		let existingContactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			existingContactId = await ctx.db.insert('contacts', createTestContact({
				email: 'existing@example.com',
			}));
			await ctx.db.insert('contactIdentities', {
				contactId: existingContactId,
				channel: 'email',
				identifier: 'existing@example.com',
				isPrimary: true,
				createdAt: Date.now(),
			});
		});

		const result = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'Existing User <existing@example.com>',
			to: 'inbox@myapp.com',
			subject: 'Follow-up',
			textBody: 'Following up on our conversation',
			messageId: '<msg-002@example.com>',
			timestamp: Date.now(),
		});

		expect(result.contactId).toBe(existingContactId);
	});

	it('should create a new thread when no existing thread matches', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		const result = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'sender@example.com',
			to: 'inbox@myapp.com',
			subject: 'Brand New Topic',
			textBody: 'Starting a new conversation',
			messageId: '<msg-003@example.com>',
			timestamp: Date.now(),
		});

		expect(result.threadId).toBeDefined();

		await t.run(async (ctx) => {
			const thread = await ctx.db.get(result.threadId);
			expect(thread).toBeDefined();
			expect(thread!.subject).toBe('Brand New Topic');
			expect(thread!.status).toBe('open');
			expect(thread!.messageCount).toBe(1);
		});
	});

	it('should match thread by In-Reply-To header', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		// Create first message in thread
		const first = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'alice@example.com',
			to: 'inbox@myapp.com',
			subject: 'Original Subject',
			textBody: 'First message',
			messageId: '<original-123@example.com>',
			timestamp: Date.now(),
		});

		// Reply with In-Reply-To
		const reply = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'alice@example.com',
			to: 'inbox@myapp.com',
			subject: 'Re: Original Subject',
			textBody: 'This is my reply',
			messageId: '<reply-456@example.com>',
			inReplyTo: '<original-123@example.com>',
			timestamp: Date.now(),
		});

		expect(reply.threadId).toBe(first.threadId);

		await t.run(async (ctx) => {
			const thread = await ctx.db.get(reply.threadId);
			expect(thread!.messageCount).toBe(2);
		});
	});

	it('should match thread by References header', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		// Create first message
		const first = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'bob@example.com',
			to: 'inbox@myapp.com',
			subject: 'Discussion',
			textBody: 'Starting discussion',
			messageId: '<disc-001@example.com>',
			timestamp: Date.now(),
		});

		// Reply with References (no In-Reply-To)
		const reply = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'bob@example.com',
			to: 'inbox@myapp.com',
			subject: 'Re: Discussion',
			textBody: 'Continuing',
			messageId: '<disc-002@example.com>',
			references: '<disc-001@example.com>',
			timestamp: Date.now(),
		});

		expect(reply.threadId).toBe(first.threadId);
	});

	it('should match thread by normalized subject + email fallback', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		const first = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'carol@example.com',
			to: 'inbox@myapp.com',
			subject: 'Project Update',
			textBody: 'First update',
			messageId: '<proj-001@example.com>',
			timestamp: Date.now(),
		});

		// Same sender, same subject (with Re: prefix), no headers
		const reply = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'carol@example.com',
			to: 'inbox@myapp.com',
			subject: 'Re: Project Update',
			textBody: 'Second update',
			messageId: '<proj-002@example.com>',
			timestamp: Date.now(),
		});

		expect(reply.threadId).toBe(first.threadId);
	});

	it('should store message with correct processingStatus', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		const result = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'test@example.com',
			to: 'inbox@myapp.com',
			subject: 'Test',
			textBody: 'Test body',
			messageId: '<test-status@example.com>',
			timestamp: Date.now(),
		});

		await t.run(async (ctx) => {
			const message = await ctx.db.get(result.inboundMessageId);
			expect(message).toBeDefined();
			expect(message!.processingStatus).toBe('received');
		});
	});

	it('should log inbound_received activity on contact', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		const result = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'activity@example.com',
			to: 'inbox@myapp.com',
			subject: 'Activity Test',
			textBody: 'Check activity log',
			messageId: '<activity-001@example.com>',
			timestamp: Date.now(),
		});

		await t.run(async (ctx) => {
			const activities = await ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', result.contactId!))
				.collect();

			const inboundActivity = activities.find((a) => a.activityType === 'inbound_received');
			expect(inboundActivity).toBeDefined();
			expect(inboundActivity!.metadata!.emailSubject).toBe('Activity Test');
		});
	});

	it('should reopen a resolved thread on new message', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		// Create initial message
		const first = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'reopen@example.com',
			to: 'inbox@myapp.com',
			subject: 'Reopen Test',
			textBody: 'Initial message',
			messageId: '<reopen-001@example.com>',
			timestamp: Date.now(),
		});

		// Manually close the thread
		await t.run(async (ctx) => {
			await ctx.db.patch(first.threadId!, { status: 'resolved' });
		});

		// New message should reopen
		const reply = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'reopen@example.com',
			to: 'inbox@myapp.com',
			subject: 'Re: Reopen Test',
			textBody: 'Actually, one more question',
			messageId: '<reopen-002@example.com>',
			inReplyTo: '<reopen-001@example.com>',
			timestamp: Date.now(),
		});

		await t.run(async (ctx) => {
			const thread = await ctx.db.get(reply.threadId);
			expect(thread!.status).toBe('open');
		});
	});

	// ── unified-timeline mirror (conversational email → unifiedMessages) ──
	it('should mirror exactly one email-inbound row into unifiedMessages on the thread + contact', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		const result = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'Mirror Test <mirror@example.com>',
			to: 'inbox@myapp.com',
			subject: 'Mirror me',
			textBody: 'plain body',
			htmlBody: '<p>html body</p>',
			messageId: '<mirror-001@example.com>',
			timestamp: Date.now(),
		});

		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('unifiedMessages')
				.withIndex('by_contact', (q) => q.eq('contactId', result.contactId!))
				.collect();
			expect(rows).toHaveLength(1);
			const row = rows[0]!;
			expect(row.channel).toBe('email');
			expect(row.direction).toBe('inbound');
			expect(row.status).toBe('received');
			expect(row.threadId).toBe(result.threadId);
			expect(row.externalMessageId).toBe('<mirror-001@example.com>');
			const content = JSON.parse(row.content);
			expect(content.text).toBe('plain body');
			expect(content.html).toBe('<p>html body</p>');
			expect(content.subject).toBe('Mirror me');
		});
	});

	it('should NOT create a duplicate mirror row when the same Message-ID is re-delivered', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);

		const args = {
			from: 'redeliver@example.com',
			to: 'inbox@myapp.com',
			subject: 'Re-delivery',
			textBody: 'body',
			messageId: '<redeliver-001@example.com>',
			timestamp: Date.now(),
		};

		const first = await t.mutation(internal.inbox.messages.receiveMessage, args);
		// MTA re-POSTs the same message (e.g. webhook retry after a timeout).
		await t.mutation(internal.inbox.messages.receiveMessage, args);

		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('unifiedMessages')
				.withIndex('by_external_message_id', (q) =>
					q.eq('externalMessageId', '<redeliver-001@example.com>'),
				)
				.collect();
			const emailInbound = rows.filter(
				(r) => r.channel === 'email' && r.direction === 'inbound',
			);
			expect(emailInbound).toHaveLength(1);
			expect(emailInbound[0]!.contactId).toBe(first.contactId);
		});
	});

	it('should store all message fields correctly', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const now = Date.now();

		const result = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'Fields Test <fields@example.com>',
			to: 'inbox@myapp.com',
			subject: 'Field Validation',
			textBody: 'Text content here',
			htmlBody: '<p>HTML content here</p>',
			messageId: '<fields-001@example.com>',
			inReplyTo: '<parent@example.com>',
			references: '<ref-a@example.com> <ref-b@example.com>',
			headers: '{"x-custom":"value"}',
			attachmentMeta: '[{"filename":"doc.pdf","size":1024}]',
			timestamp: now,
		});

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(result.inboundMessageId);
			expect(msg!.from).toBe('Fields Test <fields@example.com>');
			expect(msg!.to).toBe('inbox@myapp.com');
			expect(msg!.subject).toBe('Field Validation');
			expect(msg!.textBody).toBe('Text content here');
			expect(msg!.htmlBody).toBe('<p>HTML content here</p>');
			expect(msg!.messageId).toBe('<fields-001@example.com>');
			expect(msg!.inReplyTo).toBe('<parent@example.com>');
			expect(msg!.references).toBe('<ref-a@example.com> <ref-b@example.com>');
			expect(msg!.headers).toBe('{"x-custom":"value"}');
			expect(msg!.attachmentMeta).toBe('[{"filename":"doc.pdf","size":1024}]');
			expect(msg!.receivedAt).toBe(now);
		});
	});
});

// ============ mail-loop / auto-responder suppression ============

describe('inbound.receiveMessage mail-loop suppression', () => {
	async function enableAgent(t: ReturnType<typeof convexTest>) {
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { ai: true, 'ai.agent': true, inbox: true },
				createdAt: Date.now(),
			});
		});
	}

	/** Count scheduled agent-pipeline starts (the only walker.* job receive queues). */
	async function scheduledWalkerStarts(t: ReturnType<typeof convexTest>): Promise<number> {
		return await t.run(async (ctx) => {
			const jobs = await ctx.db.system.query('_scheduled_functions').collect();
			return jobs.filter((j) => (j.name ?? '').includes('walker')).length;
		});
	}

	it('schedules the agent pipeline for ordinary mail (control)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableAgent(t);

		const r = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'human@example.com',
			to: 'inbox@myapp.com',
			subject: 'A real question',
			textBody: 'Can you help?',
			messageId: '<human-001@example.com>',
			timestamp: Date.now(),
		});
		expect(r.inboundMessageId).toBeDefined();
		expect(await scheduledWalkerStarts(t)).toBe(1);
	});

	it('stores but does NOT run the pipeline for an auto-submitted autoresponder', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableAgent(t);

		const r = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'vacation@example.com',
			to: 'inbox@myapp.com',
			subject: 'Out of office',
			textBody: 'I am away until next week',
			headers: JSON.stringify({ 'Auto-Submitted': 'auto-replied' }),
			messageId: '<ooo-001@example.com>',
			timestamp: Date.now(),
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(r.inboundMessageId);
			expect(m!.processingStatus).toBe('received'); // stored
		});
		expect(await scheduledWalkerStarts(t)).toBe(0); // but not processed
	});

	it('suppresses mailing-list (List-Id) and bulk (Precedence) mail', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableAgent(t);

		await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'list@example.com',
			to: 'inbox@myapp.com',
			subject: 'Weekly digest',
			textBody: 'news',
			headers: JSON.stringify({ 'List-Id': '<news.example.com>' }),
			messageId: '<list-001@example.com>',
			timestamp: Date.now(),
		});
		await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'blast@example.com',
			to: 'inbox@myapp.com',
			subject: 'Sale',
			textBody: 'buy',
			headers: JSON.stringify({ Precedence: 'bulk' }),
			messageId: '<bulk-001@example.com>',
			timestamp: Date.now(),
		});
		expect(await scheduledWalkerStarts(t)).toBe(0);
	});

	it('breaks self-send loops (From == To)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableAgent(t);

		await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'Inbox <inbox@myapp.com>',
			to: 'inbox@myapp.com',
			subject: 'Re: loop',
			textBody: 'echo',
			messageId: '<self-001@example.com>',
			timestamp: Date.now(),
		});
		expect(await scheduledWalkerStarts(t)).toBe(0);
	});
});

// ============ post-delivery hooks: forwarding + vacation auto-reply ============
//
// mail/deliveryHooks.runPostDelivery is the Node action scheduled by
// mailDelivery.deliverToMailbox. It re-emits a delivered message to the
// configured forwarding targets and fires the vacation auto-responder, both
// over HTTP to the MTA's /send intake. These cases lock the RFC 3834/5230
// anti-loop contract end-to-end: the headers it stamps on the wire, target
// de-dup + self-skip, the per-sender vacation dedup window, and the rule that
// a message already touched by another Owlat mailbox (X-Owlat-Forwarded) draws
// neither a forward nor an auto-reply. We stub the MTA env and intercept
// global fetch so every outbound /send POST is captured without a live MTA.

describe('mail.deliveryHooks.runPostDelivery', () => {
	const MTA_URL = 'http://mta.internal:3100';

	/** Captured outbound /send POSTs (parsed JSON bodies). */
	interface SendPost {
		from: string;
		to: string;
		subject: string;
		headers?: Record<string, string>;
	}

	function installMtaFetch(): { sends: SendPost[] } {
		vi.stubEnv('MTA_INTERNAL_URL', MTA_URL);
		vi.stubEnv('MTA_API_KEY', 'test-mta-key');
		const sends: SendPost[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init?: { body?: string }) => {
				if (init?.body) sends.push(JSON.parse(init.body) as SendPost);
				return { ok: true, status: 200, json: async () => ({ success: true }) } as Response;
			}),
		);
		return { sends };
	}

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	/** A mailbox plus one inbox folder — enough to satisfy the action's args. */
	async function seedMailbox(
		t: ReturnType<typeof convexTest>,
		address: string,
	): Promise<{ mailboxId: Id<'mailboxes'>; folderId: Id<'mailFolders'> }> {
		return t.run(async (ctx) => {
			const now = Date.now();
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'user-1',
				organizationId: 'org-1',
				address,
				domain: address.split('@')[1]!,
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			const folderId = await ctx.db.insert('mailFolders', {
				mailboxId,
				name: 'INBOX',
				role: 'inbox',
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
			return { mailboxId, folderId };
		});
	}

	/** Insert a minimal delivered mailMessages row (the action's messageId arg). */
	async function seedMessage(
		t: ReturnType<typeof convexTest>,
		mailboxId: Id<'mailboxes'>,
		folderId: Id<'mailFolders'>,
	): Promise<Id<'mailMessages'>> {
		return t.run(async (ctx) => {
			const now = Date.now();
			const threadId = await ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: 'hi',
				participants: ['sender@example.com'],
				messageCount: 1,
				unreadCount: 1,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now,
				firstMessageAt: now,
				latestSnippet: 'snip',
				latestFromAddress: 'sender@example.com',
				latestSubject: 'Hi',
				folderRoles: ['inbox'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			const rawStorageId = await ctx.storage.store(new Blob(['raw']));
			return ctx.db.insert('mailMessages', {
				mailboxId,
				folderId,
				uid: 1,
				modseq: 1,
				rfc822MessageId: `<${Math.random().toString(36).slice(2)}@example.com>`,
				threadId,
				fromAddress: 'sender@example.com',
				toAddresses: [],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'Hi',
				normalizedSubject: 'hi',
				snippet: 'snip',
				rawStorageId,
				rawSize: 3,
				attachments: [],
				hasAttachments: false,
				flagSeen: false,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [],
				receivedAt: now,
				internalDate: now,
				createdAt: now,
				updatedAt: now,
			});
		});
	}

	async function enableForwarding(
		t: ReturnType<typeof convexTest>,
		mailboxId: Id<'mailboxes'>,
		forwardTo: string,
		isEnabled = true,
	): Promise<void> {
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mailForwarding', {
				mailboxId,
				forwardTo: forwardTo.toLowerCase(),
				keepLocalCopy: true,
				isEnabled,
				createdAt: now,
				updatedAt: now,
			});
		});
	}

	async function enableVacation(
		t: ReturnType<typeof convexTest>,
		mailboxId: Id<'mailboxes'>,
		overrides: Record<string, unknown> = {},
	): Promise<void> {
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mailVacationResponders', {
				mailboxId,
				isEnabled: true,
				subject: 'Away',
				bodyText: 'I am on vacation.',
				replyIntervalDays: 7,
				createdAt: now,
				updatedAt: now,
				...overrides,
			});
		});
	}

	// ── vacation auto-reply: headers reach the wire (RFC 3834 §2/§5) ──
	it('stamps Auto-Submitted:auto-replied + X-Auto-Response-Suppress:All on the auto-reply', async () => {
		const t = convexTest(schema, modules);
		const { sends } = installMtaFetch();
		const { mailboxId, folderId } = await seedMailbox(t, 'me@hinterland.camp');
		const messageId = await seedMessage(t, mailboxId, folderId);
		await enableVacation(t, mailboxId);

		await t.action(internal.mail.deliveryHooks.runPostDelivery, {
			mailboxId,
			mailboxAddress: 'me@hinterland.camp',
			messageId,
			fromAddress: 'human@example.com',
			subject: 'Question',
			bodyText: 'hi',
			headers: {},
		});

		const vac = sends.find((s) => s.to === 'human@example.com');
		expect(vac).toBeDefined();
		expect(vac!.from).toBe('me@hinterland.camp');
		expect(vac!.headers!['Auto-Submitted']).toBe('auto-replied');
		expect(vac!.headers!['X-Auto-Response-Suppress']).toBe('All');
	});

	it('does NOT auto-reply to automated mail (Auto-Submitted set)', async () => {
		const t = convexTest(schema, modules);
		const { sends } = installMtaFetch();
		const { mailboxId, folderId } = await seedMailbox(t, 'me@hinterland.camp');
		const messageId = await seedMessage(t, mailboxId, folderId);
		await enableVacation(t, mailboxId);

		await t.action(internal.mail.deliveryHooks.runPostDelivery, {
			mailboxId,
			mailboxAddress: 'me@hinterland.camp',
			messageId,
			fromAddress: 'robot@example.com',
			subject: 'Out of office',
			bodyText: 'away',
			headers: { 'Auto-Submitted': 'auto-replied' },
		});

		expect(sends).toHaveLength(0);
	});

	it('does NOT auto-reply to a self-send (from == to)', async () => {
		const t = convexTest(schema, modules);
		const { sends } = installMtaFetch();
		const { mailboxId, folderId } = await seedMailbox(t, 'me@hinterland.camp');
		const messageId = await seedMessage(t, mailboxId, folderId);
		await enableVacation(t, mailboxId);

		await t.action(internal.mail.deliveryHooks.runPostDelivery, {
			mailboxId,
			mailboxAddress: 'me@hinterland.camp',
			messageId,
			fromAddress: 'ME@hinterland.camp',
			subject: 'note to self',
			bodyText: 'x',
			headers: {},
		});

		expect(sends).toHaveLength(0);
	});

	// ── per-sender vacation dedup window (RFC 3834 §2: rate-limit) ──
	it('replies once per sender within the dedup window, then suppresses repeats', async () => {
		const t = convexTest(schema, modules);
		const { sends } = installMtaFetch();
		const { mailboxId, folderId } = await seedMailbox(t, 'me@hinterland.camp');
		const messageId = await seedMessage(t, mailboxId, folderId);
		await enableVacation(t, mailboxId, { replyIntervalDays: 7 });

		const call = () =>
			t.action(internal.mail.deliveryHooks.runPostDelivery, {
				mailboxId,
				mailboxAddress: 'me@hinterland.camp',
				messageId,
				fromAddress: 'persistent@example.com',
				subject: 'ping',
				bodyText: 'hi',
				headers: {},
			});

		await call();
		await call();

		// One auto-reply for the first message; the second is inside the window.
		expect(sends.filter((s) => s.to === 'persistent@example.com')).toHaveLength(1);
		// The reply was recorded so the window is enforced.
		const logged = await t.run(async (ctx) =>
			ctx.db
				.query('mailVacationLog')
				.withIndex('by_mailbox_and_sender', (q) =>
					q.eq('mailboxId', mailboxId).eq('senderEmail', 'persistent@example.com'),
				)
				.first(),
		);
		expect(logged).not.toBeNull();
	});

	// ── forwarding: de-dup, self-skip, anti-loop stamps (RFC 5230) ──
	it('de-dups forwarding targets and skips the mailbox itself, stamping anti-loop headers', async () => {
		const t = convexTest(schema, modules);
		const { sends } = installMtaFetch();
		const { mailboxId, folderId } = await seedMailbox(t, 'me@hinterland.camp');
		const messageId = await seedMessage(t, mailboxId, folderId);
		// Two rules to the same external target (a dup) + a rule back to self.
		await enableForwarding(t, mailboxId, 'archive@example.com');
		await enableForwarding(t, mailboxId, 'ARCHIVE@example.com'); // case-dup
		await enableForwarding(t, mailboxId, 'me@hinterland.camp'); // self

		await t.action(internal.mail.deliveryHooks.runPostDelivery, {
			mailboxId,
			mailboxAddress: 'me@hinterland.camp',
			messageId,
			fromAddress: 'human@example.com',
			subject: 'Please archive',
			bodyText: 'body',
			headers: {},
			// A filter-level "Forward to…" action repeating the same target.
			filterForwardTo: ['archive@example.com'],
		});

		const forwards = sends.filter((s) => s.subject.startsWith('Fwd:'));
		// Exactly one forward despite 3 dup mentions of the target + a self-rule.
		expect(forwards).toHaveLength(1);
		const fwd = forwards[0]!;
		expect(fwd.to).toBe('archive@example.com');
		expect(fwd.from).toBe('me@hinterland.camp');
		expect(fwd.headers!['X-Owlat-Forwarded']).toBe('me@hinterland.camp');
		expect(fwd.headers!['Auto-Submitted']).toBe('auto-forwarded');
	});

	it('does NOT forward or auto-reply a message already touched by another Owlat mailbox', async () => {
		const t = convexTest(schema, modules);
		const { sends } = installMtaFetch();
		const { mailboxId, folderId } = await seedMailbox(t, 'me@hinterland.camp');
		const messageId = await seedMessage(t, mailboxId, folderId);
		await enableForwarding(t, mailboxId, 'archive@example.com');
		await enableVacation(t, mailboxId);

		await t.action(internal.mail.deliveryHooks.runPostDelivery, {
			mailboxId,
			mailboxAddress: 'me@hinterland.camp',
			messageId,
			fromAddress: 'human@example.com',
			subject: 'Re: forwarded',
			bodyText: 'body',
			// A re-delivered forward carries the marker we stamp on outbound
			// forwards — isAutomatedMail() must short-circuit both consumers.
			headers: { 'X-Owlat-Forwarded': 'someone@elsewhere.app' },
		});

		expect(sends).toHaveLength(0);
	});

	it('skips disabled forwarding rules', async () => {
		const t = convexTest(schema, modules);
		const { sends } = installMtaFetch();
		const { mailboxId, folderId } = await seedMailbox(t, 'me@hinterland.camp');
		const messageId = await seedMessage(t, mailboxId, folderId);
		await enableForwarding(t, mailboxId, 'archive@example.com', false);

		await t.action(internal.mail.deliveryHooks.runPostDelivery, {
			mailboxId,
			mailboxAddress: 'me@hinterland.camp',
			messageId,
			fromAddress: 'human@example.com',
			subject: 'hi',
			bodyText: 'body',
			headers: {},
		});

		expect(sends.filter((s) => s.subject.startsWith('Fwd:'))).toHaveLength(0);
	});
});
