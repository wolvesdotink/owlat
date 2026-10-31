/**
 * Writing-voice profile end-to-end, with the LLM dispatch seam MOCKED:
 *
 *   - refresh action: samples the mailbox's SENT bodies (quoted reply-chains
 *     stripped), derives a profile via one runLlmObject call, and persists it.
 *     The mocked dispatch asserts the fresh sample content reached the prompt
 *     and the quoted original did not.
 *   - getGuidanceForMailbox: a fresh profile is served without scheduling a
 *     recompute (status stays idle); a stale one flips to `refreshing` (a
 *     background refresh is scheduled). Disabled personalization → no guidance.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { AI_BUDGET_ERROR_CODE } from '@owlat/shared/aiRouting';
import type { Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { VOICE_STALE_MS } from '../mail/ai/voiceProfile';
import type * as LlmDispatchModule from '../lib/llm/dispatch';
import type * as LlmProviderModule from '../lib/llmProvider';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const runLlmObjectMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof LlmProviderModule>('../lib/llmProvider');
	return { ...actual, resolveLanguageModel: vi.fn(() => 'test-model') };
});

vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof LlmDispatchModule>('../lib/llm/dispatch');
	return { ...actual, runLlmObject: runLlmObjectMock };
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('visualizationAgent') &&
			!path.includes('semanticFileProcessing')
	)
);

beforeEach(() => {
	runLlmObjectMock.mockReset();
});
afterEach(() => {
	vi.unstubAllEnvs();
});

async function seedMailboxWithSent(
	t: TestConvex<typeof schema>,
	sentBodies: string[]
): Promise<Id<'mailboxes'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: 'me@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const sentId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'Sent',
			role: 'sent',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 0,
			totalCount: sentBodies.length,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'hi',
			participants: ['me@example.com'],
			messageCount: sentBodies.length,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: '',
			latestFromAddress: 'me@example.com',
			latestSubject: 'Hi',
			folderRoles: ['sent'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		let uid = 1;
		for (const body of sentBodies) {
			const rawStorageId = await ctx.storage.store(new Blob(['raw']));
			await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId: sentId,
				uid: uid++,
				modseq: 1,
				rfc822MessageId: `<${Math.random().toString(36).slice(2)}@example.com>`,
				threadId,
				fromAddress: 'me@example.com',
				toAddresses: ['bob@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'Hi',
				normalizedSubject: 'hi',
				snippet: body.slice(0, 40),
				rawStorageId,
				rawSize: 3,
				textBodyInline: body,
				attachments: [],
				hasAttachments: false,
				flagSeen: true,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [],
				receivedAt: now + uid,
				internalDate: now + uid,
				createdAt: now,
				updatedAt: now,
			});
		}
		return mailboxId;
	});
}

describe('mail.voiceProfileActions.refresh', () => {
	it('derives + persists a profile and sends the stripped samples to the model', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const mailboxId = await seedMailboxWithSent(t, [
			'Hey Bob,\n\nSounds great, ship it.\n\nCheers,\nMe\n\n' +
				'On Mon, Jan 1, 2024, Bob <bob@x.com> wrote:\n> Should we ship?',
			'Thanks, appreciate it!',
			'Will do — talk soon.',
		]);

		runLlmObjectMock.mockResolvedValue({
			object: {
				greetings: ['Hey'],
				signOffs: ['Cheers'],
				formality: 2,
				brevity: 2,
				languages: ['English'],
				isEmojiUser: false,
				examplePhrasings: ['ship it', 'talk soon'],
			},
			tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			modelUsed: 'test-model',
		});

		await t.action(internal.mail.ai.voiceProfileActions.refresh, { mailboxId });

		// The fresh prose reached the prompt; the quoted original did not.
		const prompt = runLlmObjectMock.mock.calls[0]?.[0]?.prompt as string;
		expect(prompt).toContain('untrusted DATA');
		expect(prompt).toContain('Sounds great, ship it.');
		expect(prompt).not.toContain('Should we ship?');
		expect(prompt).not.toContain('wrote:');

		const row = await t.run(async (ctx) =>
			ctx.db
				.query('mailVoiceProfiles')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.first()
		);
		expect(row?.status).toBe('idle');
		expect(row?.profile?.greetings).toEqual(['Hey']);
		expect(row?.sampleCount).toBe(3);
		expect(row?.lastComputedAt).toBeGreaterThan(0);
	});

	it('fails soft with too few samples (no profile written, dispatch not called)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const mailboxId = await seedMailboxWithSent(t, ['only one message']);

		// Pre-create a refreshing row so we can observe it released.
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mailVoiceProfiles', {
				mailboxId,
				isEnabled: true,
				status: 'refreshing',
				sampleCount: 0,
				sentCountAtCompute: 0,
				createdAt: now,
				updatedAt: now,
			});
		});

		await t.action(internal.mail.ai.voiceProfileActions.refresh, { mailboxId });

		expect(runLlmObjectMock).not.toHaveBeenCalled();
		const row = await t.run(async (ctx) =>
			ctx.db
				.query('mailVoiceProfiles')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.first()
		);
		expect(row?.status).toBe('idle');
		expect(row?.profile).toBeUndefined();
	});

	it('fails soft when the model fails: the flag is released and the previous profile stays', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const mailboxId = await seedMailboxWithSent(t, ['One.', 'Two.', 'Three.']);
		const previous = {
			greetings: ['Hi'],
			signOffs: ['Best'],
			formality: 3,
			brevity: 3,
			languages: ['English'],
			isEmojiUser: false,
			examplePhrasings: [],
		};
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mailVoiceProfiles', {
				mailboxId,
				isEnabled: true,
				status: 'refreshing',
				profile: previous,
				sampleCount: 5,
				sentCountAtCompute: 5,
				lastComputedAt: now,
				createdAt: now,
				updatedAt: now,
			});
		});
		runLlmObjectMock.mockRejectedValue(new Error('model down'));

		await t.action(internal.mail.ai.voiceProfileActions.refresh, { mailboxId });

		expect(runLlmObjectMock).toHaveBeenCalledTimes(1);
		const row = await t.run(async (ctx) =>
			ctx.db
				.query('mailVoiceProfiles')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.first()
		);
		expect(row?.status).toBe('idle');
		expect(row?.profile).toEqual(previous);
		expect(row?.sampleCount).toBe(5);
	});
});

describe('mail.voiceProfile.getGuidanceForMailbox', () => {
	async function seedProfile(
		t: TestConvex<typeof schema>,
		lastComputedAt: number
	): Promise<Id<'mailboxes'>> {
		return await t.run(async (ctx) => {
			const now = Date.now();
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'test-user',
				organizationId: 'test-org',
				address: 'me@example.com',
				domain: 'example.com',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('mailVoiceProfiles', {
				mailboxId,
				isEnabled: true,
				status: 'idle',
				sampleCount: 10,
				sentCountAtCompute: 10,
				lastComputedAt,
				profile: {
					greetings: ['Hi'],
					signOffs: ['Best'],
					formality: 3,
					brevity: 3,
					languages: ['English'],
					isEmojiUser: false,
					examplePhrasings: ['sounds good'],
				},
				createdAt: now,
				updatedAt: now,
			});
			return mailboxId;
		});
	}

	async function refreshJobs(t: TestConvex<typeof schema>): Promise<number> {
		const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		return jobs.filter((job) => job.name.includes('voiceProfileActions')).length;
	}

	async function statusOf(t: TestConvex<typeof schema>, mailboxId: Id<'mailboxes'>) {
		return await t.run(async (ctx) =>
			ctx.db
				.query('mailVoiceProfiles')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.first()
		);
	}

	it('serves a fresh profile without scheduling a recompute', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const mailboxId = await seedProfile(t, Date.now());

		const res = await t.mutation(internal.mail.ai.voiceProfile.getGuidanceForMailbox, {
			mailboxId,
		});
		expect(res.guidance).toContain('Typical greetings: Hi');
		expect((await statusOf(t, mailboxId))?.status).toBe('idle');
	});

	it('schedules a background refresh for a stale profile (status → refreshing)', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const mailboxId = await seedProfile(t, Date.now() - VOICE_STALE_MS - 1);

		const res = await t.mutation(internal.mail.ai.voiceProfile.getGuidanceForMailbox, {
			mailboxId,
		});
		// Stale profile is still served immediately (never blocks).
		expect(res.guidance).toContain('Typical greetings: Hi');
		expect((await statusOf(t, mailboxId))?.status).toBe('refreshing');
	});

	it('defers a stale refresh while spend admission says no: no job is scheduled (#1333)', async () => {
		// A ceiling with a spend state nobody has reconciled yet: unverifiable.
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '10');
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const mailboxId = await seedProfile(t, Date.now() - VOICE_STALE_MS - 1);

		const res = await t.mutation(internal.mail.ai.voiceProfile.getGuidanceForMailbox, {
			mailboxId,
		});
		expect(res.guidance).toContain('Typical greetings: Hi');
		expect((await statusOf(t, mailboxId))?.status).toBe('idle');
		expect(await refreshJobs(t)).toBe(0);
	});

	it('schedules one refresh for repeated "Refresh now" presses, not one per press', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai', 'postbox']);
		const mailboxId = await seedProfile(t, Date.now());

		for (let press = 0; press < 5; press++) {
			await t.mutation(api.mail.ai.voiceProfile.requestRefresh, { mailboxId });
		}
		expect((await statusOf(t, mailboxId))?.status).toBe('refreshing');
		expect(await refreshJobs(t)).toBe(1);
	});

	it('refuses "Refresh now" with the budget code when admission says no', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '10');
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai', 'postbox']);
		const mailboxId = await seedProfile(t, Date.now());

		const error = await t
			.mutation(api.mail.ai.voiceProfile.requestRefresh, { mailboxId })
			.catch((e) => e);
		expect(error.data).toMatchObject({ data: { code: AI_BUDGET_ERROR_CODE } });
		expect(await refreshJobs(t)).toBe(0);
	});

	it('returns no guidance when personalization is disabled', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await enableFeatures(t, ['ai']);
		const mailboxId = await seedProfile(t, Date.now());
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('mailVoiceProfiles')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.first();
			if (row) await ctx.db.patch(row._id, { isEnabled: false });
		});

		const res = await t.mutation(internal.mail.ai.voiceProfile.getGuidanceForMailbox, {
			mailboxId,
		});
		expect(res.guidance).toBeNull();
	});
});
