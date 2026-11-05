/**
 * Seeds shared by the task and company suites: workspace members (BetterAuth
 * `member` rows, which `isOrgMember` reads), personal and shared mailboxes on
 * the workspace's own domain, and Postbox / Team Inbox threads with chosen
 * participants.
 *
 * The `.testlib.ts` (double-dot) name keeps Convex from bundling this file.
 */

import type { TestConvex } from 'convex-test';
import { components } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import type schema from '../../schema';
import { enableFeatures } from '../../__tests__/factories';
import { newBetterAuthHarness } from '../../__tests__/testModules';

export type Harness = TestConvex<typeof schema>;

export const ORG_ID = 'org-1';
/** The workspace's own domain: its addresses are colleagues, never a company. */
export const OWN_DOMAIN = 'owlat.test';

export async function workspaceHarness(members: Record<string, string>): Promise<Harness> {
	const t = newBetterAuthHarness();
	await enableFeatures(t, ['mail.external', 'inbox']);
	for (const [userId, role] of Object.entries(members)) {
		await t.mutation(components.betterAuth.adapter.create, {
			input: {
				model: 'member',
				data: { organizationId: ORG_ID, userId, role, createdAt: Date.now() },
			},
		} as never);
	}
	return t;
}

export async function seedMailbox(
	t: Harness,
	ownerId: string,
	address: string,
	options: { scope?: 'personal' | 'shared'; members?: string[] } = {}
): Promise<Id<'mailboxes'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: ownerId,
			organizationId: ORG_ID,
			address,
			domain: OWN_DOMAIN,
			...(options.scope ? { scope: options.scope } : {}),
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		for (const authUserId of [ownerId, ...(options.members ?? [])]) {
			await ctx.db.insert('mailboxMembers', {
				mailboxId,
				authUserId,
				role: authUserId === ownerId ? 'owner' : 'member',
				addedBy: ownerId,
				createdAt: now,
			});
		}
		return mailboxId;
	});
}

export interface ThreadSeed {
	participants: string[];
	subject?: string;
	lastMessageAt?: number;
	folderRoles?: string[];
	category?: Doc<'mailThreads'>['category'];
}

export async function seedThread(
	t: Harness,
	mailboxId: Id<'mailboxes'>,
	seed: ThreadSeed
): Promise<Id<'mailThreads'>> {
	const subject = seed.subject ?? 'Hello';
	const at = seed.lastMessageAt ?? Date.now();
	return await t.run((ctx) =>
		ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: subject.toLowerCase(),
			participants: seed.participants,
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: at,
			firstMessageAt: at,
			latestSnippet: `${subject} snippet`,
			latestFromAddress: seed.participants[0] ?? 'someone@example.com',
			latestSubject: subject,
			folderRoles: seed.folderRoles ?? ['inbox'],
			labelIds: [],
			...(seed.category ? { category: seed.category } : {}),
			createdAt: at,
			updatedAt: at,
		})
	);
}

export async function seedTeamThread(
	t: Harness,
	contactIdentifier: string,
	subject = 'Team question'
): Promise<Id<'conversationThreads'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('conversationThreads', {
			subject,
			normalizedSubject: subject.toLowerCase(),
			contactIdentifier,
			status: 'open',
			messageCount: 1,
			lastMessageAt: now,
			firstMessageAt: now,
			createdAt: now,
		});
	});
}
