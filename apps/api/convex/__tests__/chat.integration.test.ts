/**
 * Integration tests for the internal team chat module
 * (apps/api/convex/chat/*).
 *
 * Covers the verification checklist from the implementation plan:
 *  - per-room admin rename/archive vs. non-admin attempts
 *  - private-channel access / public-channel browse semantics
 *  - DM participant-only access
 *  - sendMessage validation
 *  - linkChannelToInboxThread admin requirement
 *  - mention parsing + chatMentions row creation
 *  - cleanupLegacyChatData is idempotent and surgical
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { enableFeatures } from './factories';

// Each test parameterizes the mocked session to a specific user/role so we can
// exercise both admin and non-admin paths.
const sessionMock = vi.hoisted(() => ({
	user: { id: 'user-alice', role: 'owner' as 'owner' | 'admin' | 'editor' },
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.user.id),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		requireAdminContext: vi.fn().mockImplementation(async () => {
			if (sessionMock.user.role === 'editor') {
				throw new Error('forbidden');
			}
			return { userId: sessionMock.user.id, role: sessionMock.user.role };
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
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
			!path.includes('llmProvider'),
	),
);

const setUser = (id: string, role: 'owner' | 'admin' | 'editor' = 'editor') => {
	sessionMock.user.id = id;
	sessionMock.user.role = role;
};

// Membership-write mutations (createChannel initialMembers, addMember,
// findOrCreateDm) now validate each target against userProfiles.by_auth_user_id,
// so participants referenced by a test must have a profile row.
const seedUsers = async (t: TestConvex<typeof schema>, ids: string[]) => {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (const id of ids) {
			await ctx.db.insert('userProfiles', {
				authUserId: id,
				email: `${id}@example.com`,
				name: id,
				createdAt: now,
				updatedAt: now,
			});
		}
	});
};

beforeEach(() => {
	setUser('user-alice', 'owner');
});

describe('chat.rooms.createChannel', () => {
	it('creates a public channel and seeds the creator as admin', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'owner');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});
		expect(roomId).toBeDefined();

		const room = await t.run(async (ctx) => ctx.db.get(roomId!));
		expect(room?.kind).toBe('channel');
		expect(room?.visibility).toBe('public');
		expect(room?.name).toBe('general');
		expect(room?.createdBy).toBe('user-alice');

		const membership = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-alice'),
				)
				.first(),
		);
		expect(membership?.role).toBe('admin');
	});

	it('rejects duplicate channel names (case-insensitive)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		setUser('user-alice', 'owner');

		await t.mutation(api.chat.rooms.createChannel, {
			name: 'General',
			visibility: 'public',
		});
		await expect(
			t.mutation(api.chat.rooms.createChannel, {
				name: 'general',
				visibility: 'private',
			}),
		).rejects.toThrow();
	});

	it('seeds initialMemberIds as plain members', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		await seedUsers(t, ['user-alice', 'user-bob', 'user-carol']);
		setUser('user-alice', 'owner');

		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'product',
			visibility: 'private',
			initialMemberIds: ['user-bob', 'user-carol'],
		});

		const members = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room', (q) => q.eq('roomId', roomId!))
				.collect(),
		);
		const roleByMember = Object.fromEntries(members.map((m) => [m.memberId, m.role]));
		expect(roleByMember['user-alice']).toBe('admin');
		expect(roleByMember['user-bob']).toBe('member');
		expect(roleByMember['user-carol']).toBe('member');
	});
});

describe('chat.rooms.updateChannel + archiveChannel', () => {
	it('blocks non-admin renames', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});
		// Add Bob as plain member.
		await t.run(async (ctx) => {
			await ctx.db.insert('chatRoomMembers', {
				roomId: roomId!,
				memberId: 'user-bob',
				role: 'member',
				joinedAt: Date.now(),
				lastReadAt: Date.now(),
			});
		});

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.chat.rooms.updateChannel, {
				roomId: roomId!,
				name: 'renamed',
			}),
		).rejects.toThrow();
	});

	it('allows the per-room admin to rename + archive', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});

		await t.mutation(api.chat.rooms.updateChannel, {
			roomId: roomId!,
			name: 'renamed',
		});
		const renamed = await t.run(async (ctx) => ctx.db.get(roomId!));
		expect(renamed?.name).toBe('renamed');
		expect(renamed?.normalizedName).toBe('renamed');

		await t.mutation(api.chat.rooms.archiveChannel, { roomId: roomId! });
		const archived = await t.run(async (ctx) => ctx.db.get(roomId!));
		expect(archived?.archivedAt).toBeDefined();
	});

	it('lets org admins (chat:manage) override per-room admin checks', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		// Alice (org owner) creates a channel that Bob owns.
		setUser('user-bob', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'random',
			visibility: 'public',
		});

		// Alice (org owner) can still rename even though she's not a member.
		setUser('user-alice', 'owner');
		await t.mutation(api.chat.rooms.updateChannel, {
			roomId: roomId!,
			name: 'random-renamed',
		});
		const renamed = await t.run(async (ctx) => ctx.db.get(roomId!));
		expect(renamed?.name).toBe('random-renamed');
	});
});

describe('chat.members.joinChannel + private channel access', () => {
	it('lets a non-member join a public channel', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'owner');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});

		setUser('user-bob', 'editor');
		await t.mutation(api.chat.members.joinChannel, { roomId: roomId! });
		const membership = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-bob'),
				)
				.first(),
		);
		expect(membership?.role).toBe('member');
	});

	it('blocks joinChannel on a private room', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'secret',
			visibility: 'private',
		});

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.chat.members.joinChannel, { roomId: roomId! }),
		).rejects.toThrow();
	});

	it('hides private rooms from getRoom for non-members', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'secret',
			visibility: 'private',
		});

		setUser('user-bob', 'editor');
		const room = await t.query(api.chat.rooms.getRoom, { roomId: roomId! });
		expect(room).toBeNull();
	});
});

describe('chat.messages.sendMessage', () => {
	it('rejects empty messages', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});
		await expect(
			t.mutation(api.chat.messages.sendMessage, {
				roomId: roomId!,
				text: '   ',
			}),
		).rejects.toThrow();
	});

	it('requires membership to send into a public channel', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.chat.messages.sendMessage, {
				roomId: roomId!,
				text: 'hello',
			}),
		).rejects.toThrow();
	});

	it('writes a message and bumps the room counters', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});

		await t.mutation(api.chat.messages.sendMessage, {
			roomId: roomId!,
			text: 'hello',
		});

		const room = await t.run(async (ctx) => ctx.db.get(roomId!));
		expect(room?.messageCount).toBe(1);
		const messages = await t.run(async (ctx) =>
			ctx.db
				.query('chatMessages')
				.withIndex('by_room', (q) => q.eq('roomId', roomId!))
				.collect(),
		);
		expect(messages).toHaveLength(1);
		expect(messages[0]!.text).toBe('hello');
	});
});

describe('chat.dms.findOrCreateDm', () => {
	it('is idempotent for the same participant set', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		await seedUsers(t, ['user-alice', 'user-bob']);

		setUser('user-alice', 'editor');
		const a = await t.mutation(api.chat.dms.findOrCreateDm, {
			otherMemberIds: ['user-bob'],
		});
		const b = await t.mutation(api.chat.dms.findOrCreateDm, {
			otherMemberIds: ['user-bob'],
		});
		expect(a).toBe(b);
	});

	it('blocks non-participants from reading the DM', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		await seedUsers(t, ['user-alice', 'user-bob']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.dms.findOrCreateDm, {
			otherMemberIds: ['user-bob'],
		});

		setUser('user-eve', 'editor');
		const room = await t.query(api.chat.rooms.getRoom, { roomId: roomId! });
		expect(room).toBeNull();
		await expect(
			t.mutation(api.chat.messages.sendMessage, {
				roomId: roomId!,
				text: 'sneaking in',
			}),
		).rejects.toThrow();
	});
});

describe('chat.mentions', () => {
	it('writes chatMentions rows for resolved @-handles', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		// Seed profiles so the resolver can match @bob.
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('userProfiles', {
				authUserId: 'user-alice',
				email: 'alice@example.com',
				name: 'Alice',
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('userProfiles', {
				authUserId: 'user-bob',
				email: 'bob@example.com',
				name: 'Bob',
				createdAt: now,
				updatedAt: now,
			});
		});

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});

		// Bob must be a member of the room to be notified — mentions only fan
		// out to room members (see the non-member case below).
		await t.mutation(api.chat.members.addMember, {
			roomId: roomId!,
			memberId: 'user-bob',
		});

		await t.mutation(api.chat.messages.sendMessage, {
			roomId: roomId!,
			text: 'hey @bob can you review',
		});

		const mentions = await t.run(async (ctx) =>
			ctx.db.query('chatMentions').collect(),
		);
		expect(mentions).toHaveLength(1);
		expect(mentions[0]!.mentionedMemberId).toBe('user-bob');
		expect(mentions[0]!.mentioningMemberId).toBe('user-alice');
	});

	it('does NOT write a mention row when the mentioned user is not a room member (no cross-room leak)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		// Bob has a profile (so the @handle resolves) but is NOT a member of the
		// private room. A mention must not create a chatMentions row for him —
		// otherwise `mentions.listMyUnreadMentions` would leak a preview of a
		// private-room message to a non-participant.
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('userProfiles', {
				authUserId: 'user-alice',
				email: 'alice@example.com',
				name: 'Alice',
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('userProfiles', {
				authUserId: 'user-bob',
				email: 'bob@example.com',
				name: 'Bob',
				createdAt: now,
				updatedAt: now,
			});
		});

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'private-room',
			visibility: 'private',
		});

		await t.mutation(api.chat.messages.sendMessage, {
			roomId: roomId!,
			text: 'secret plan, cc @bob',
		});

		const mentions = await t.run(async (ctx) =>
			ctx.db.query('chatMentions').collect(),
		);
		expect(mentions).toHaveLength(0);
	});

	it('does not self-notify if the author @-mentions themselves', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('userProfiles', {
				authUserId: 'user-alice',
				email: 'alice@example.com',
				name: 'Alice',
				createdAt: now,
				updatedAt: now,
			});
		});

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});

		await t.mutation(api.chat.messages.sendMessage, {
			roomId: roomId!,
			text: 'note to @alice: ship it',
		});

		const mentions = await t.run(async (ctx) =>
			ctx.db.query('chatMentions').collect(),
		);
		expect(mentions).toHaveLength(0);
	});
});

describe('chat.emailLink', () => {
	it('requires per-room admin to link an inbox thread', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat', 'inbox']);

		// Seed an inbox thread that isn't the legacy chat scaffold.
		const inboxThreadId = await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert('conversationThreads', {
				subject: 'Customer ticket',
				normalizedSubject: 'customer ticket',
				contactIdentifier: 'customer@example.com',
				status: 'open',
				messageCount: 0,
				lastMessageAt: now,
				firstMessageAt: now,
				createdAt: now,
			});
		});

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'support',
			visibility: 'public',
		});
		// Bob joins as a plain member.
		setUser('user-bob', 'editor');
		await t.mutation(api.chat.members.joinChannel, { roomId: roomId! });

		// Bob (member, not admin) cannot link.
		await expect(
			t.mutation(api.chat.emailLink.linkChannelToInboxThread, {
				roomId: roomId!,
				inboxThreadId,
			}),
		).rejects.toThrow();

		// Alice (per-room admin) can.
		setUser('user-alice', 'editor');
		await t.mutation(api.chat.emailLink.linkChannelToInboxThread, {
			roomId: roomId!,
			inboxThreadId,
		});
		const room = await t.run(async (ctx) => ctx.db.get(roomId!));
		expect(room?.linkedInboxThreadId).toBe(inboxThreadId);
	});
});

describe('chat.cleanup.cleanupLegacyChatData', () => {
	it('is idempotent and surgical', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		// Seed legacy + non-legacy threads.
		const legacyChannelThreadId = await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert('conversationThreads', {
				subject: 'old channel',
				normalizedSubject: 'old channel',
				contactIdentifier: 'channel',
				status: 'open',
				messageCount: 0,
				lastMessageAt: now,
				firstMessageAt: now,
				createdAt: now,
			});
		});
		const customerThreadId = await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert('conversationThreads', {
				subject: 'Real customer',
				normalizedSubject: 'real customer',
				contactIdentifier: 'customer@example.com',
				status: 'open',
				messageCount: 0,
				lastMessageAt: now,
				firstMessageAt: now,
				createdAt: now,
			});
		});
		// Legacy chat message attached to the legacy thread.
		await t.run(async (ctx) => {
			await ctx.db.insert('unifiedMessages', {
				threadId: legacyChannelThreadId,
				channel: 'chat',
				direction: 'outbound',
				memberId: 'user-alice',
				content: JSON.stringify({ text: 'old chat' }),
				status: 'sent',
				createdAt: Date.now(),
			});
		});

		setUser('user-alice', 'owner');
		const summary1 = await t.mutation(api.chat.cleanup.cleanupLegacyChatData, {});
		expect(summary1?.threadsToDelete).toBe(1);
		expect(summary1?.messagesToDelete).toBe(1);

		// The customer thread survives.
		const customer = await t.run(async (ctx) => ctx.db.get(customerThreadId));
		expect(customer?.contactIdentifier).toBe('customer@example.com');

		// A second run is a no-op.
		const summary2 = await t.mutation(api.chat.cleanup.cleanupLegacyChatData, {});
		expect(summary2?.threadsToDelete).toBe(0);
		expect(summary2?.messagesToDelete).toBe(0);
	});
});
