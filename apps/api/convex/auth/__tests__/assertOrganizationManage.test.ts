/**
 * `auth.membership.assertOrganizationManage`: the dedicated probe behind the
 * Nitro `requireOrgAdmin` gate. It reads nothing, so its whole contract is the
 * `adminQuery` floor, and that floor is exercised for real here: BetterAuth
 * organization and member rows are seeded through the registered component, the
 * caller is a real identity carrying its active organization, and nothing in
 * `lib/sessionOrganization` is mocked. An owner or admin passes, an editor is
 * `forbidden`, and an anonymous caller is `unauthenticated`. The Nitro gate
 * maps exactly those two categories to 403 and 401.
 */

import type { TestConvex } from 'convex-test';
import { beforeEach, describe, expect, it } from 'vitest';
import { extractOperationError } from '@owlat/shared/operationError';
import { newBetterAuthHarness } from '../../__tests__/testModules';
import type schema from '../../schema';
import { api, components } from '../../_generated/api';
import { _resetSingletonOrgCacheForTests } from '../../lib/sessionOrganization';

type Role = 'owner' | 'admin' | 'editor';

let t: TestConvex<typeof schema>;
let organizationId: string;

async function seedOrganization(): Promise<string> {
	const org = (await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: 'organization',
			data: { name: 'Owlat', slug: 'owlat', createdAt: Date.now() },
		},
	} as never)) as { _id: string };
	return org._id;
}

async function seedMember(userId: string, role: Role): Promise<void> {
	await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: 'member',
			data: { organizationId, userId, role, createdAt: Date.now() },
		},
	} as never);
}

/** Call the probe as `userId`, with the seeded organization active. */
function probeAs(userId: string): Promise<null> {
	return t
		.withIdentity({ subject: userId, activeOrganizationId: organizationId })
		.query(api.auth.membership.assertOrganizationManage, {});
}

/** The Operation error category the probe rejected with. */
async function rejectionCategory(call: Promise<unknown>): Promise<string | undefined> {
	try {
		await call;
	} catch (e) {
		return extractOperationError(e)?.category;
	}
	throw new Error('expected the probe to reject');
}

beforeEach(async () => {
	_resetSingletonOrgCacheForTests();
	t = newBetterAuthHarness();
	organizationId = await seedOrganization();
	await seedMember('user-owner', 'owner');
	await seedMember('user-admin', 'admin');
	await seedMember('user-editor', 'editor');
});

describe('auth.membership.assertOrganizationManage', () => {
	it.each(['user-owner', 'user-admin'])('passes %s, who holds organization:manage', async (id) => {
		await expect(probeAs(id)).resolves.toBeNull();
	});

	it('answers forbidden for an editor, who is a member without organization:manage', async () => {
		expect(await rejectionCategory(probeAs('user-editor'))).toBe('forbidden');
	});

	it('answers forbidden for a signed-in identity that is not a member', async () => {
		expect(await rejectionCategory(probeAs('user-stranger'))).toBe('forbidden');
	});

	it('answers unauthenticated for an anonymous caller', async () => {
		expect(await rejectionCategory(t.query(api.auth.membership.assertOrganizationManage, {}))).toBe(
			'unauthenticated'
		);
	});
});
