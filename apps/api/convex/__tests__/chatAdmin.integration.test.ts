/**
 * Integration tests for chat per-room admin + attachment authorization
 * (apps/api/convex/chat/members.ts, rooms.ts, attachments.ts, _helpers.ts).
 *
 * Covers:
 *  - members.setMemberRole / removeMember / leaveRoom: only a per-room admin
 *    (or an org chat:manage holder) can change roles / remove members; a plain
 *    member cannot escalate; the last admin cannot be removed / demoted /
 *    leave when other members remain (stranding guards).
 *  - attachments.generateUploadUrl / registerAttachment / getAttachmentDetails:
 *    generate/register only need chat:participate; getAttachmentDetails gates on
 *    room read access (the IDOR room gate) — a non-member of a private room is
 *    denied, a member is allowed.
 *  - membership-write validation: findOrCreateDm / addMember / createChannel
 *    reject an id with no userProfiles row, and cap the batch at
 *    CHAT_MEMBER_BATCH_MAX (50).
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { enableFeatures } from './factories';

// Mutable session mock so each test can pick a user/role. Mirrors the
// chat.integration.test.ts pattern.
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
		requireOrgPermission: vi.fn().mockImplementation(
			async (_ctx: unknown, permission: string, message?: string) => {
				const mod: typeof import('../lib/sessionOrganization') = actual as typeof import('../lib/sessionOrganization');
				mod.requirePermission(
					mod.hasPermission(
						sessionMock.user.role as Parameters<typeof mod.hasPermission>[0],
						permission as Parameters<typeof mod.hasPermission>[1],
					),
					message,
				);
				return { userId: sessionMock.user.id, role: sessionMock.user.role };
			},
		),
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

// Membership-write mutations validate each target against
// userProfiles.by_auth_user_id, so participants referenced by a test must have
// a profile row.
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

// Directly insert a plain-member row (bypasses the membership-write gate so we
// can set up scenarios without seeding profiles for every helper user).
const addMemberRow = async (
	t: TestConvex<typeof schema>,
	roomId: string,
	memberId: string,
	role: 'admin' | 'member' = 'member',
) => {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('chatRoomMembers', {
			roomId: roomId as never,
			memberId,
			role,
			joinedAt: now,
			lastReadAt: now,
		});
	});
};

beforeEach(() => {
	setUser('user-alice', 'owner');
});

describe('chat.members.setMemberRole', () => {
	it('lets a per-room admin promote a member to admin', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		// Alice (editor role → no org chat:manage) creates the channel and is its
		// per-room admin.
		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});
		await addMemberRow(t, roomId!, 'user-bob', 'member');

		await t.mutation(api.chat.members.setMemberRole, {
			roomId: roomId!,
			memberId: 'user-bob',
			role: 'admin',
		});

		const bob = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-bob'),
				)
				.first(),
		);
		expect(bob?.role).toBe('admin');
	});

	it('blocks a plain member from escalating themselves to admin', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});
		await addMemberRow(t, roomId!, 'user-bob', 'member');

		// Bob is a plain member with editor org role (no chat:manage).
		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.chat.members.setMemberRole, {
				roomId: roomId!,
				memberId: 'user-bob',
				role: 'admin',
			}),
		).rejects.toThrow();

		const bob = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-bob'),
				)
				.first(),
		);
		expect(bob?.role).toBe('member');
	});

	it('lets an org chat:manage holder (admin) override the per-room admin check', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		// Bob (editor) creates the channel and owns the only admin seat.
		setUser('user-bob', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'random',
			visibility: 'public',
		});
		await addMemberRow(t, roomId!, 'user-carol', 'member');

		// Alice is an org admin (chat:manage) but not a member of the room.
		setUser('user-alice', 'admin');
		await t.mutation(api.chat.members.setMemberRole, {
			roomId: roomId!,
			memberId: 'user-carol',
			role: 'admin',
		});

		const carol = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-carol'),
				)
				.first(),
		);
		expect(carol?.role).toBe('admin');
	});

	it('refuses to demote the last admin', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});
		// Alice is the sole admin; add a plain member so the room isn't trivially empty.
		await addMemberRow(t, roomId!, 'user-bob', 'member');

		await expect(
			t.mutation(api.chat.members.setMemberRole, {
				roomId: roomId!,
				memberId: 'user-alice',
				role: 'member',
			}),
		).rejects.toThrow();

		const alice = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-alice'),
				)
				.first(),
		);
		expect(alice?.role).toBe('admin');
	});

	it('rejects setting a role on a non-member', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});

		await expect(
			t.mutation(api.chat.members.setMemberRole, {
				roomId: roomId!,
				memberId: 'user-nobody',
				role: 'admin',
			}),
		).rejects.toThrow();
	});

	it('rejects role changes on a DM', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		await seedUsers(t, ['user-alice', 'user-bob']);

		setUser('user-alice', 'editor');
		const dmId = await t.mutation(api.chat.dms.findOrCreateDm, {
			otherMemberIds: ['user-bob'],
		});

		// Org admin to bypass the per-room admin check and reach the DM guard.
		setUser('user-alice', 'admin');
		await expect(
			t.mutation(api.chat.members.setMemberRole, {
				roomId: dmId!,
				memberId: 'user-bob',
				role: 'admin',
			}),
		).rejects.toThrow();
	});
});

describe('chat.members.removeMember', () => {
	it('lets a per-room admin remove a plain member', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});
		await addMemberRow(t, roomId!, 'user-bob', 'member');

		await t.mutation(api.chat.members.removeMember, {
			roomId: roomId!,
			memberId: 'user-bob',
		});

		const bob = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-bob'),
				)
				.first(),
		);
		expect(bob).toBeNull();
	});

	it('blocks a plain member from removing another member', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});
		await addMemberRow(t, roomId!, 'user-bob', 'member');
		await addMemberRow(t, roomId!, 'user-carol', 'member');

		// Bob (plain member, editor org role) tries to remove Carol.
		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.chat.members.removeMember, {
				roomId: roomId!,
				memberId: 'user-carol',
			}),
		).rejects.toThrow();

		const carol = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-carol'),
				)
				.first(),
		);
		expect(carol).not.toBeNull();
	});

	it('refuses to remove the last admin (stranding guard)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});
		await addMemberRow(t, roomId!, 'user-bob', 'member');

		// Alice is the sole admin. An org admin removing her would strand the room.
		setUser('user-zara', 'admin'); // org chat:manage, not a room member
		await expect(
			t.mutation(api.chat.members.removeMember, {
				roomId: roomId!,
				memberId: 'user-alice',
			}),
		).rejects.toThrow();

		const alice = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-alice'),
				)
				.first(),
		);
		expect(alice?.role).toBe('admin');
	});

	it('allows removing an admin when another admin remains', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});
		// Bob is a second admin so removing Alice doesn't strand the room.
		await addMemberRow(t, roomId!, 'user-bob', 'admin');

		await t.mutation(api.chat.members.removeMember, {
			roomId: roomId!,
			memberId: 'user-alice',
		});

		const alice = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-alice'),
				)
				.first(),
		);
		expect(alice).toBeNull();
	});

	it('is a no-op when removing a non-member', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});

		// Should resolve without throwing (no membership → early return; the
		// mutation's `undefined` return serializes to null over the wire).
		await expect(
			t.mutation(api.chat.members.removeMember, {
				roomId: roomId!,
				memberId: 'user-nobody',
			}),
		).resolves.toBeNull();
	});

	it('rejects removing a DM participant', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		await seedUsers(t, ['user-alice', 'user-bob']);

		setUser('user-alice', 'editor');
		const dmId = await t.mutation(api.chat.dms.findOrCreateDm, {
			otherMemberIds: ['user-bob'],
		});

		setUser('user-alice', 'admin'); // bypass per-room admin to reach the DM guard
		await expect(
			t.mutation(api.chat.members.removeMember, {
				roomId: dmId!,
				memberId: 'user-bob',
			}),
		).rejects.toThrow();
	});
});

describe('chat.members.leaveRoom', () => {
	it('lets a plain member leave a channel', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});
		await addMemberRow(t, roomId!, 'user-bob', 'member');

		setUser('user-bob', 'editor');
		await t.mutation(api.chat.members.leaveRoom, { roomId: roomId! });

		const bob = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-bob'),
				)
				.first(),
		);
		expect(bob).toBeNull();
	});

	it('refuses to let the last admin leave while other members remain', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});
		// Another member remains, so Alice (sole admin) leaving would strand them.
		await addMemberRow(t, roomId!, 'user-bob', 'member');

		setUser('user-alice', 'editor');
		await expect(
			t.mutation(api.chat.members.leaveRoom, { roomId: roomId! }),
		).rejects.toThrow();

		const alice = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-alice'),
				)
				.first(),
		);
		expect(alice?.role).toBe('admin');
	});

	it('lets the sole admin leave when they are the only member', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});

		// allMembers.length === 1, so the stranding guard does not fire.
		setUser('user-alice', 'editor');
		await t.mutation(api.chat.members.leaveRoom, { roomId: roomId! });

		const alice = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-alice'),
				)
				.first(),
		);
		expect(alice).toBeNull();
	});

	it('lets an admin leave when another admin remains', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});
		await addMemberRow(t, roomId!, 'user-bob', 'admin');

		setUser('user-alice', 'editor');
		await t.mutation(api.chat.members.leaveRoom, { roomId: roomId! });

		const alice = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-alice'),
				)
				.first(),
		);
		expect(alice).toBeNull();
	});

	it('rejects leaving a DM', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		await seedUsers(t, ['user-alice', 'user-bob']);

		setUser('user-alice', 'editor');
		const dmId = await t.mutation(api.chat.dms.findOrCreateDm, {
			otherMemberIds: ['user-bob'],
		});

		await expect(
			t.mutation(api.chat.members.leaveRoom, { roomId: dmId! }),
		).rejects.toThrow();
	});
});

describe('chat.attachments.generateUploadUrl + registerAttachment', () => {
	it('lets a chat participant generate an upload URL', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const url = await t.mutation(api.chat.attachments.generateUploadUrl, {});
		expect(typeof url).toBe('string');
		expect(url.length).toBeGreaterThan(0);
	});

	it('registers an uploaded blob as a media asset', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		// Store a blob so storage.getUrl resolves.
		const storageId = await t.run(async (ctx) =>
			ctx.storage.store(new Blob(['hello'], { type: 'text/plain' })),
		);

		setUser('user-alice', 'editor');
		const assetId = await t.mutation(api.chat.attachments.registerAttachment, {
			storageId,
			filename: 'notes.txt',
			mimeType: 'text/plain',
			fileSize: 5,
		});
		expect(assetId).toBeDefined();

		const asset = await t.run(async (ctx) => ctx.db.get(assetId));
		expect(asset?.filename).toBe('notes.txt');
		expect(asset?.uploadedBy).toBe('user-alice');
		expect(asset?.tags).toContain('chat-attachment');
	});

	it('rejects a registration over the 25 MiB cap', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		const storageId = await t.run(async (ctx) =>
			ctx.storage.store(new Blob(['x'], { type: 'application/octet-stream' })),
		);

		setUser('user-alice', 'editor');
		await expect(
			t.mutation(api.chat.attachments.registerAttachment, {
				storageId,
				filename: 'huge.bin',
				mimeType: 'application/octet-stream',
				fileSize: 26 * 1024 * 1024,
			}),
		).rejects.toThrow();
	});

	it('rejects a registration with empty filename', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		const storageId = await t.run(async (ctx) =>
			ctx.storage.store(new Blob(['x'], { type: 'text/plain' })),
		);

		setUser('user-alice', 'editor');
		await expect(
			t.mutation(api.chat.attachments.registerAttachment, {
				storageId,
				filename: '   ',
				mimeType: 'text/plain',
				fileSize: 1,
			}),
		).rejects.toThrow();
	});
});

describe('chat.attachments.getAttachmentDetails (IDOR room gate)', () => {
	it('denies a non-member of a private room', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		// Store + register an attachment, then post a message referencing it in a
		// private channel as Alice.
		const storageId = await t.run(async (ctx) =>
			ctx.storage.store(new Blob(['secret'], { type: 'text/plain' })),
		);

		setUser('user-alice', 'editor');
		const assetId = await t.mutation(api.chat.attachments.registerAttachment, {
			storageId,
			filename: 'secret.txt',
			mimeType: 'text/plain',
			fileSize: 6,
		});
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'private-room',
			visibility: 'private',
		});

		const messageId = await t.run(async (ctx) =>
			ctx.db.insert('chatMessages', {
				roomId: roomId! as never,
				authorId: 'user-alice',
				text: 'see attached',
				attachmentIds: [assetId],
				createdAt: Date.now(),
			}),
		);

		// Eve is not a member of the private room → denied.
		setUser('user-eve', 'editor');
		await expect(
			t.query(api.chat.attachments.getAttachmentDetails, { messageId }),
		).rejects.toThrow();
	});

	it('allows a member of the room', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		const storageId = await t.run(async (ctx) =>
			ctx.storage.store(new Blob(['shared'], { type: 'text/plain' })),
		);

		setUser('user-alice', 'editor');
		const assetId = await t.mutation(api.chat.attachments.registerAttachment, {
			storageId,
			filename: 'shared.txt',
			mimeType: 'text/plain',
			fileSize: 6,
		});
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'private-room',
			visibility: 'private',
		});
		await addMemberRow(t, roomId!, 'user-bob', 'member');

		const messageId = await t.run(async (ctx) =>
			ctx.db.insert('chatMessages', {
				roomId: roomId! as never,
				authorId: 'user-alice',
				text: 'see attached',
				attachmentIds: [assetId],
				createdAt: Date.now(),
			}),
		);

		// Bob is a member → allowed, gets the asset details back.
		setUser('user-bob', 'editor');
		const details = await t.query(api.chat.attachments.getAttachmentDetails, {
			messageId,
		});
		expect(details).toHaveLength(1);
		expect(details[0]!.filename).toBe('shared.txt');
		expect(details[0]!._id).toBe(assetId);
	});

	it('lets any member browse attachments in a PUBLIC channel', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		const storageId = await t.run(async (ctx) =>
			ctx.storage.store(new Blob(['pub'], { type: 'text/plain' })),
		);

		setUser('user-alice', 'editor');
		const assetId = await t.mutation(api.chat.attachments.registerAttachment, {
			storageId,
			filename: 'pub.txt',
			mimeType: 'text/plain',
			fileSize: 3,
		});
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});

		const messageId = await t.run(async (ctx) =>
			ctx.db.insert('chatMessages', {
				roomId: roomId! as never,
				authorId: 'user-alice',
				text: 'public attachment',
				attachmentIds: [assetId],
				createdAt: Date.now(),
			}),
		);

		// Carol is not a member, but a public channel is readable by any member.
		setUser('user-carol', 'editor');
		const details = await t.query(api.chat.attachments.getAttachmentDetails, {
			messageId,
		});
		expect(details).toHaveLength(1);
	});

	it('returns [] for a missing message id', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		// Create a real message, capture its id, then delete it so the id is valid
		// but the row is gone.
		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});
		const messageId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('chatMessages', {
				roomId: roomId! as never,
				authorId: 'user-alice',
				text: 'temp',
				createdAt: Date.now(),
			});
			await ctx.db.delete(id);
			return id;
		});

		const details = await t.query(api.chat.attachments.getAttachmentDetails, {
			messageId,
		});
		expect(details).toEqual([]);
	});
});

describe('chat membership-write validation', () => {
	it('findOrCreateDm rejects an id with no userProfiles row', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		await seedUsers(t, ['user-alice']);

		setUser('user-alice', 'editor');
		await expect(
			t.mutation(api.chat.dms.findOrCreateDm, {
				otherMemberIds: ['ghost-user'],
			}),
		).rejects.toThrow();
	});

	it('findOrCreateDm caps the batch at CHAT_MEMBER_BATCH_MAX', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		await seedUsers(t, ['user-alice']);

		// 51 others (> 50) trips the cap before any per-id profile lookup.
		const tooMany = Array.from({ length: 51 }, (_, i) => `bulk-${i}`);
		setUser('user-alice', 'editor');
		await expect(
			t.mutation(api.chat.dms.findOrCreateDm, { otherMemberIds: tooMany }),
		).rejects.toThrow();
	});

	it('addMember rejects an id with no userProfiles row', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});

		await expect(
			t.mutation(api.chat.members.addMember, {
				roomId: roomId!,
				memberId: 'ghost-user',
			}),
		).rejects.toThrow();

		// No phantom membership row was created.
		const ghost = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'ghost-user'),
				)
				.first(),
		);
		expect(ghost).toBeNull();
	});

	it('addMember accepts an id with a userProfiles row', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		await seedUsers(t, ['user-bob']);

		setUser('user-alice', 'editor');
		const roomId = await t.mutation(api.chat.rooms.createChannel, {
			name: 'general',
			visibility: 'public',
		});

		await t.mutation(api.chat.members.addMember, {
			roomId: roomId!,
			memberId: 'user-bob',
		});

		const bob = await t.run(async (ctx) =>
			ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room_and_member', (q) =>
					q.eq('roomId', roomId!).eq('memberId', 'user-bob'),
				)
				.first(),
		);
		expect(bob?.role).toBe('member');
	});

	it('createChannel rejects an initial member id with no userProfiles row', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		setUser('user-alice', 'editor');
		await expect(
			t.mutation(api.chat.rooms.createChannel, {
				name: 'product',
				visibility: 'private',
				initialMemberIds: ['ghost-user'],
			}),
		).rejects.toThrow();

		// Nothing was created.
		const channel = await t.run(async (ctx) =>
			ctx.db
				.query('chatRooms')
				.withIndex('by_kind_and_normalized_name', (q) =>
					q.eq('kind', 'channel').eq('normalizedName', 'product'),
				)
				.first(),
		);
		expect(channel).toBeNull();
	});

	it('createChannel caps initialMemberIds at CHAT_MEMBER_BATCH_MAX', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);

		const tooMany = Array.from({ length: 51 }, (_, i) => `bulk-${i}`);
		setUser('user-alice', 'editor');
		await expect(
			t.mutation(api.chat.rooms.createChannel, {
				name: 'product',
				visibility: 'private',
				initialMemberIds: tooMany,
			}),
		).rejects.toThrow();
	});
});
