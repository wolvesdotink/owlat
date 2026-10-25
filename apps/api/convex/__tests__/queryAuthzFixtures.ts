/**
 * Shared seed for the query-authorization suites. Sessions are REAL: the org
 * and its members live in the registered BetterAuth component and each caller
 * is a JWT identity, so the membership floor, the role gates and the
 * self-scope checks run unmocked. A permissive session mock would prove
 * nothing about who is refused.
 */

import type { TestConvex } from 'convex-test';
import type schema from '../schema';
import { components } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import { _resetSingletonOrgCacheForTests } from '../lib/sessionOrganization';
import { createTestAutomation, createTestCampaign, createTestContact } from './factories';
import { newBetterAuthHarness } from './testModules';

export type Harness = TestConvex<typeof schema>;

/** The org's members by role, plus a signed-in identity with no membership. */
export const OWNER = 'user-owner';
export const ADMIN = 'user-admin';
export const EDITOR = 'user-editor';
export const OUTSIDER = 'user-outsider';

const MEMBERS = [
	[OWNER, 'owner'],
	[ADMIN, 'admin'],
	[EDITOR, 'editor'],
] as const;

export type Caller = typeof OWNER | typeof ADMIN | typeof EDITOR | typeof OUTSIDER | 'anonymous';

export interface Seed {
	orgId: string;
	contactId: Id<'contacts'>;
	campaignId: Id<'campaigns'>;
	automationId: Id<'automations'>;
	publicRoomId: Id<'chatRooms'>;
}

/**
 * A harness with the org, its three members and the gated features enabled.
 * The singleton-org id is cached per isolate, and every harness mints a new
 * org, so the cache is dropped first.
 */
export async function authzHarness(
	features: FeatureFlagKey[] = ['campaigns', 'automations', 'chat']
): Promise<{ t: Harness; seed: Seed }> {
	_resetSingletonOrgCacheForTests();
	const t = newBetterAuthHarness();
	const org = (await t.mutation(components.betterAuth.adapter.create, {
		input: { model: 'organization', data: { name: 'Owlat', slug: 'owlat', createdAt: 0 } },
	} as never)) as { _id: string };
	for (const [userId, role] of MEMBERS) {
		await t.mutation(components.betterAuth.adapter.create, {
			input: {
				model: 'member',
				data: { organizationId: org._id, userId, role, createdAt: 0 },
			},
		} as never);
	}
	await setFeatures(t, features);
	const ids = await t.run(async (ctx) => {
		const now = Date.now();
		for (const userId of [OWNER, ADMIN, EDITOR, OUTSIDER]) {
			await ctx.db.insert('userProfiles', {
				authUserId: userId,
				email: `${userId}@owlat.example`,
				name: userId,
				createdAt: now,
				updatedAt: now,
			});
		}
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'reader@example.com', doiConfirmationToken: 'doi-secret' })
		);
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		const automationId = await ctx.db.insert('automations', createTestAutomation());
		const publicRoomId = await ctx.db.insert('chatRooms', room('general', 'public', now));
		return { contactId, campaignId, automationId, publicRoomId };
	});
	return { t, seed: { orgId: org._id, ...ids } };
}

/** A chat room row, created by the owner. */
export function room(name: string, visibility: 'public' | 'private', now: number) {
	return {
		kind: 'channel' as const,
		name,
		normalizedName: name,
		visibility,
		createdBy: OWNER,
		createdAt: now,
		updatedAt: now,
		lastMessageAt: now,
		messageCount: 0,
	};
}

/**
 * Write the flag map as given: listed flags on, every other gated family off,
 * so a "feature disabled" case is decided by the stored flags rather than by
 * a registry default.
 */
export async function setFeatures(t: Harness, enabled: FeatureFlagKey[]): Promise<void> {
	const featureFlags: Record<string, boolean> = {
		campaigns: false,
		automations: false,
		chat: false,
	};
	for (const flag of enabled) featureFlags[flag] = true;
	await t.run(async (ctx) => {
		const now = Date.now();
		const settings = await ctx.db.query('instanceSettings').first();
		if (settings) {
			await ctx.db.patch(settings._id, { featureFlags, updatedAt: now });
			return;
		}
		await ctx.db.insert('instanceSettings', { featureFlags, createdAt: now, updatedAt: now });
	});
}

/** The harness as `caller`: anonymous, or a JWT identity in the org. */
export function as(t: Harness, seed: Seed, caller: Caller) {
	if (caller === 'anonymous') return t;
	return t.withIdentity({ subject: caller, activeOrganizationId: seed.orgId });
}
