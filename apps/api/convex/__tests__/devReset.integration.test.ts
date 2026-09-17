/**
 * Integration tests for `POST /dev/reset` — the dev-only "back to a blank
 * instance" endpoint.
 *
 * The property under test is completeness. A table the wipe forgets survives
 * into what is supposed to be a fresh install, and the two onboarding tables
 * added with the send-ready notices are exactly the kind that go unnoticed:
 * they are in `NON_TENANT_TABLES` (so the tenant walker skips them) and they
 * are keyed by a BetterAuth user id that no longer exists after the wipe.
 * A leftover pending notice would toast the first account created afterwards,
 * and a leftover readiness sample would make a blank instance look like sending
 * was already known-good, so the edge detector would see no edge and never
 * notify anyone.
 *
 * The BetterAuth component is registered because `runReset` drains its models
 * through the adapter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newBetterAuthHarness } from './testModules';
import { components, internal } from '../_generated/api';

const SECRET = 'dev-reset-test-secret-at-least-32-characters';

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', SECRET);
	vi.stubEnv('OWLAT_DEV_MODE', 'true');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('dev reset — onboarding notice tables', () => {
	it('wipes sendReadyNotices and sendPathReadiness and counts them', async () => {
		const t = newBetterAuthHarness();
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('sendReadyNotices', { userId: 'auth-user-1', createdAt: now });
			await ctx.db.insert('sendReadyNotices', {
				userId: 'auth-user-2',
				createdAt: now,
				acknowledgedAt: now,
			});
			await ctx.db.insert('sendPathReadiness', { isReady: true, changedAt: now });
			await ctx.db.insert('userOnboarding', {
				authUserId: 'auth-user-1',
				createdAt: now,
				updatedAt: now,
			});
		});

		const counts = await t.mutation(internal.devShortcuts.reset.runReset, {});
		expect(counts.sendReadyNotices).toBe(2);
		expect(counts.sendPathReadiness).toBe(1);
		expect(counts.userOnboarding).toBe(1);

		const left = await t.run(async (ctx) => ({
			notices: await ctx.db.query('sendReadyNotices').collect(),
			readiness: await ctx.db.query('sendPathReadiness').collect(),
		}));
		expect(left.notices).toEqual([]);
		expect(left.readiness).toEqual([]);
	});

	it('wipes the platform-admin roster so the next seed can grant it again', async () => {
		// Two failures ride on this row surviving: it keeps granting the
		// deployment surface (updates, backups, operator console) to a user id
		// step 2 just deleted, and — because the bootstrap paths refuse a
		// non-empty roster — it stops the NEXT `/seed/admin` from giving the
		// fresh setup user their own grant, leaving the instance unoperatable.
		const t = newBetterAuthHarness();
		await t.run(async (ctx) => {
			await ctx.db.insert('platformAdmins', {
				authUserId: 'auth-user-1',
				email: 'owner@example.com',
				role: 'superadmin',
				createdAt: Date.now(),
			});
		});

		const counts = await t.mutation(internal.devShortcuts.reset.runReset, {});
		expect(counts.platformAdmins).toBe(1);

		const left = await t.run(async (ctx) => ctx.db.query('platformAdmins').collect());
		expect(left).toEqual([]);
	});

	it('wipes the session and invitation rows a stale cookie or invite rides on', async () => {
		// Both outlive the user they belong to unless drained explicitly, and both
		// are worse than leftover data. A surviving session keeps authenticating a
		// cookie whose user this reset just deleted — the app then renders its
		// shell with every query empty, which reads as "the page is broken" rather
		// than "you are signed out", and cost a full debugging session. A
		// surviving pending invitation lets that address self-register into an
		// organization that no longer exists (auth/registrationGate.ts).
		const t = newBetterAuthHarness();
		const now = Date.now();

		await t.mutation(components.betterAuth.adapter.create, {
			input: {
				model: 'session',
				data: {
					token: 'stale-session-token',
					userId: 'auth-user-1',
					expiresAt: now + 86_400_000,
					createdAt: now,
					updatedAt: now,
				},
			},
		} as never);
		await t.mutation(components.betterAuth.adapter.create, {
			input: {
				model: 'invitation',
				data: {
					email: 'invited@example.com',
					organizationId: 'org-1',
					inviterId: 'auth-user-1',
					role: 'member',
					status: 'pending',
					expiresAt: now + 86_400_000,
				},
			},
		} as never);

		const counts = await t.mutation(internal.devShortcuts.reset.runReset, {});
		expect(counts.sessions).toBe(1);
		expect(counts.invitations).toBe(1);

		const left = await t.query(components.betterAuth.adapter.findMany, {
			model: 'session',
			where: [],
			paginationOpts: { cursor: null, numItems: 10 },
		} as never);
		expect((left as { page?: unknown[] }).page ?? []).toEqual([]);
	});

	it('is idempotent — a second reset reports zeros', async () => {
		const t = newBetterAuthHarness();
		await t.run(async (ctx) => {
			await ctx.db.insert('sendPathReadiness', { isReady: false, changedAt: Date.now() });
		});

		await t.mutation(internal.devShortcuts.reset.runReset, {});
		const second = await t.mutation(internal.devShortcuts.reset.runReset, {});
		expect(second.sendReadyNotices).toBe(0);
		expect(second.sendPathReadiness).toBe(0);
	});

	it('frees the storage blobs of every wiped mailMessages row', async () => {
		// The generic `TENANT_TABLES` walker deletes rows; it knows nothing about
		// the up-to-three blobs a `mailMessages` row owns, so every reset used to
		// orphan the whole instance's mail in storage with nothing left pointing at
		// it — and nothing ever collects an unreferenced blob.
		const t = newBetterAuthHarness();
		const blobs = await t.run(async (ctx) => {
			const now = Date.now();
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'auth-user-1',
				organizationId: 'org-x',
				address: 'user@example.com',
				domain: 'example.com',
				status: 'active' as const,
				usedBytes: 13,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			const folderId = await ctx.db.insert('mailFolders', {
				mailboxId,
				name: 'INBOX',
				role: 'inbox' as const,
				uidValidity: now,
				uidNext: 2,
				highestModseq: 1,
				totalCount: 1,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
			const threadId = await ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: 'hi',
				participants: ['user@example.com'],
				messageCount: 1,
				unreadCount: 0,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now,
				firstMessageAt: now,
				latestSnippet: 'hi',
				latestFromAddress: 'a@example.com',
				latestSubject: 'hi',
				folderRoles: ['inbox'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			const rawStorageId = await ctx.storage.store(new Blob(['raw eml bytes']));
			const textBodyStorageId = await ctx.storage.store(new Blob(['text body']));
			const htmlBodyStorageId = await ctx.storage.store(new Blob(['<p>html</p>']));
			await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId,
				uid: 1,
				modseq: 1,
				rfc822MessageId: '<m1@example.com>',
				threadId,
				fromAddress: 'a@example.com',
				toAddresses: ['user@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'hi',
				normalizedSubject: 'hi',
				snippet: 'hi',
				rawStorageId,
				textBodyStorageId,
				htmlBodyStorageId,
				rawSize: 13,
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
			return [rawStorageId, textBodyStorageId, htmlBodyStorageId];
		});

		await t.mutation(internal.devShortcuts.reset.runReset, {});

		await t.run(async (ctx) => {
			expect(await ctx.db.query('mailMessages').collect()).toEqual([]);
			for (const storageId of blobs) {
				expect(await ctx.storage.get(storageId)).toBeNull();
			}
		});
	});
});
