import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import { createAuthOptions } from '../auth';

afterEach(() => vi.unstubAllEnvs());

describe('invitation identity verification with installed BetterAuth', () => {
	it.each(['', 'false'])(
		'blocks member-to-admin invitation theft when legacy verification is %j',
		async (setting) => {
			vi.stubEnv('REQUIRE_EMAIL_VERIFICATION', setting);
			vi.stubEnv('OWLAT_DEV_MODE', 'false');
			vi.stubEnv('SITE_URL', 'https://owlat.example');
			vi.stubEnv('BETTER_AUTH_SECRET', 'test-only-secret-123456789012345678901234567890');
			const now = new Date();
			const db: Record<string, Array<Record<string, unknown>>> = {
				user: [
					{
						id: 'seeded-owner',
						email: 'owner@owlat.example',
						name: 'Owner',
						emailVerified: true,
						createdAt: now,
						updatedAt: now,
					},
				],
				account: [],
				session: [],
				organization: [{ id: 'audit-org', name: 'Audit', slug: 'audit', createdAt: now }],
				member: [],
				invitation: [],
				verification: [],
			};
			const ctx = {
				runQuery: vi.fn(async (_ref, args) => {
					const rows = db[args.model] ?? [];
					return {
						page: rows.filter((row) =>
							args.where.every(
								(condition: { field: string; value: unknown }) =>
									row[condition.field] === condition.value
							)
						),
					};
				}),
				runAction: vi.fn(async () => ({ success: true })),
			} as unknown as ActionCtx;
			const production = createAuthOptions(ctx);
			// Exercise the actual registration hook and organization plugin. The
			// in-memory adapter replaces only persistence; no external I/O is used.
			const auth = betterAuth({
				...production,
				database: memoryAdapter(db),
				plugins: production.plugins.filter((plugin) => plugin.id === 'organization'),
			});
			function invite(id: string, email: string, role: string) {
				db['invitation']!.push({
					id,
					email,
					role,
					organizationId: 'audit-org',
					status: 'pending',
					inviterId: 'seeded-owner',
					createdAt: now,
					expiresAt: new Date(Date.now() + 60_000),
				});
			}
			async function signup(email: string) {
				const result = await auth.api.signUpEmail({
					body: { email, password: 'test-password-1234', name: 'Audit' },
					returnHeaders: true,
				});
				const cookie = result.headers
					.getSetCookie()
					.map((value) => value.split(';')[0])
					.join('; ');
				return { id: result.response.user.id, headers: new Headers({ cookie }) };
			}
			invite('editor-invite', 'editor@owlat.example', 'editor');
			const editor = await signup('editor@owlat.example');
			// Existing unverified members retain access under the legacy policy.
			// Seed membership as the trusted bootstrap/previous acceptance would.
			db['member']!.push({
				id: 'editor-membership',
				userId: editor.id,
				organizationId: 'audit-org',
				role: 'editor',
				createdAt: now,
			});
			invite('admin-invite', 'invitee@owlat.example', 'admin');
			const listed = await auth.api.listInvitations({
				headers: editor.headers,
				query: { organizationId: 'audit-org' },
			});
			const target = listed.find((invitation) => invitation.role === 'admin')!;
			expect(target).toBeDefined();
			const impostor = await signup(target.email);
			expect(ctx.runAction).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ to: target.email })
			);
			await expect(
				auth.api.acceptInvitation({ headers: impostor.headers, body: { invitationId: target.id } })
			).rejects.toMatchObject({ status: 'FORBIDDEN' });
			expect(db['member']!.some((member) => member['userId'] === impostor.id)).toBe(false);
			// Proving ownership unlocks only the invitation's intended membership.
			db['user']!.find((user) => user['id'] === impostor.id)!['emailVerified'] = true;
			const verifiedSignIn = await auth.api.signInEmail({
				body: { email: target.email, password: 'test-password-1234' },
				returnHeaders: true,
			});
			const verifiedCookie = verifiedSignIn.headers
				.getSetCookie()
				.map((value) => value.split(';')[0])
				.join('; ');
			const accepted = await auth.api.acceptInvitation({
				headers: new Headers({ cookie: verifiedCookie }),
				body: { invitationId: target.id },
			});
			expect(accepted.member.role).toBe('admin');
		},
		10_000
	);
});
