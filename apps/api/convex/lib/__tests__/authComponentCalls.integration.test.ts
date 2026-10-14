import { expect, it, vi } from 'vitest';
import { newBetterAuthHarness } from '../../__tests__/testModules';
import { components } from '../../_generated/api';
import type { QueryCtx } from '../../_generated/server';
import { authedQuery } from '../authedFunctions';
import { getBetterAuthSessionWithRole } from '../sessionOrganization';

it('reuses real component reads and rejects removed members and expired legacy sessions', async () => {
	const t = newBetterAuthHarness();
	const org = (await t.mutation(components.betterAuth.adapter.create, {
		input: { model: 'organization', data: { name: 'Owlat', slug: 'owlat', createdAt: 0 } },
	})) as { _id: string };
	const member = (await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: 'member',
			data: { organizationId: org._id, userId: 'user-1', role: 'admin', createdAt: 0 },
		},
	})) as { _id: string };
	const read = authedQuery({
		args: {},
		handler: async (ctx, _args, session) => {
			await Promise.all([getBetterAuthSessionWithRole(ctx), getBetterAuthSessionWithRole(ctx)]);
			return session.role;
		},
	});
	const handler = (read as unknown as { _handler: (ctx: QueryCtx, args: {}) => Promise<string> })
		._handler;
	const viewer = t.withIdentity({ subject: 'user-1', activeOrganizationId: org._id });
	await viewer.query(async (ctx) => {
		const calls = vi.spyOn(ctx, 'runQuery');
		await expect(handler(ctx, {})).resolves.toBe('admin');
		expect(calls).toHaveBeenCalledTimes(2);
	});
	const session = (await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: 'session',
			data: {
				userId: 'user-1',
				activeOrganizationId: org._id,
				token: 'expired-test-token',
				expiresAt: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		},
	})) as { _id: string };
	await expect(
		t
			.withIdentity({ subject: 'user-1', sessionId: session._id })
			.query(async (ctx) => handler(ctx, {}))
	).rejects.toThrow(/No active organization/);
	await t.mutation(components.betterAuth.adapter.deleteOne, {
		input: { model: 'member', where: [{ field: '_id', value: member._id }] },
	});
	await expect(viewer.query(async (ctx) => handler(ctx, {}))).rejects.toThrow(/do not have access/);
});
