import { httpAction } from './_generated/server';
import { components } from './_generated/api';
import { internal } from './_generated/api';
import { getOptional } from './lib/env';
import { safeCompare } from './lib/safeCompare';

/**
 * HTTP action to seed the first admin user on a local instance.
 * Called during VPS provisioning (and now by the setup-cli `bootstrap-org`
 * command) to create the org admin with the same credentials they used on
 * the global instance.
 *
 * Protected by X-Instance-Secret header. One-shot: refuses if any user exists.
 *
 * POST /seed/admin
 * Headers: X-Instance-Secret: <instance secret>
 * Body: { email: string, name: string, passwordHash: string, flags?: Record<string, boolean> }
 *
 * `flags` (optional) carries the setup wizard's resolved feature-flag map; when
 * present it is persisted onto instanceSettings.featureFlags so the wizard's
 * selections actually take effect at runtime. Omitted by the bare VPS-provision
 * path, which then falls back to the compiled-in flag defaults.
 */

export const seedAdmin = httpAction(async (ctx, request) => {
	// Verify instance secret (timing-safe comparison to prevent side-channel attacks)
	const secret = request.headers.get('X-Instance-Secret');
	const expectedSecret = getOptional('INSTANCE_SECRET');

	if (!expectedSecret || !secret || !safeCompare(secret, expectedSecret)) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	// Parse request body
	let body: { email: string; name: string; passwordHash: string; flags?: Record<string, boolean> };
	try {
		body = await request.json() as { email: string; name: string; passwordHash: string; flags?: Record<string, boolean> };
	} catch {
		return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	if (!body.email || !body.name || !body.passwordHash) {
		return new Response(JSON.stringify({ error: 'Missing required fields: email, name, passwordHash' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	// One-shot check: refuse if any user already exists
	const existingUser = await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'user',
		where: [],
		paginationOpts: { cursor: null, numItems: 1 },
	});

	if (existingUser && existingUser.page && existingUser.page.length > 0) {
		return new Response(JSON.stringify({ error: 'Users already exist. Seed endpoint is one-shot only.' }), {
			status: 409,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	try {
		const now = new Date();
		const nowMs = now.getTime();

		// Create the BetterAuth user. The component's adapter GENERATES the row
		// id (`_id`) and its `create` validator REJECTS a client-supplied `id`
		// (older code passed one and 500'd at runtime against the deployed
		// component). Capture the returned doc and use its `_id` as the
		// canonical user id for every foreign-key reference — that is exactly
		// the id BetterAuth resolves at login (the adapter derives the
		// better-auth id from `_id`; see getDocId in @convex-dev/better-auth).
		const userDoc = (await ctx.runMutation(components.betterAuth.adapter.create, {
			input: {
				model: 'user',
				data: {
					email: body.email,
					name: body.name,
					emailVerified: true,
					createdAt: nowMs,
					updatedAt: nowMs,
				},
			} as unknown as Parameters<typeof ctx.runMutation>[1],
		})) as unknown as { _id: string };
		const userId = String(userDoc._id);

		// Create BetterAuth account record with the hashed password
		await ctx.runMutation(components.betterAuth.adapter.create, {
			input: {
				model: 'account',
				data: {
					userId,
					providerId: 'credential',
					accountId: userId,
					password: body.passwordHash,
					createdAt: nowMs,
					updatedAt: nowMs,
				},
			} as unknown as Parameters<typeof ctx.runMutation>[1],
		});

		// Create BetterAuth organization
		// Collapse runs of `-` and strip leading/trailing `-` so an email local
		// part like `+++@x.com` doesn't yield the all-dashes slug `---`.
		const slugBase = body.email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
		const orgSlug = slugBase && slugBase.length > 0 ? slugBase : 'org';
		const orgName = `${body.name}'s Team`;

		const orgDoc = (await ctx.runMutation(components.betterAuth.adapter.create, {
			input: {
				model: 'organization',
				data: {
					name: orgName,
					slug: orgSlug,
					createdAt: nowMs,
				},
			} as unknown as Parameters<typeof ctx.runMutation>[1],
		})) as unknown as { _id: string };
		const orgId = String(orgDoc._id);

		// Create BetterAuth member record (owner role)
		await ctx.runMutation(components.betterAuth.adapter.create, {
			input: {
				model: 'member',
				data: {
					userId,
					organizationId: orgId,
					role: 'owner',
					createdAt: nowMs,
				},
			} as unknown as Parameters<typeof ctx.runMutation>[1],
		});

		// Create userProfile record
		await ctx.runMutation(internal.auth.userProfiles.createInternal, {
			authUserId: userId,
			email: body.email,
			name: body.name,
		});

		// Create instanceSettings record
		await ctx.runMutation(internal.organizations.settings.createInternal, {
			timezone: 'UTC',
			defaultFromName: orgName,
		});

		// Persist the wizard's chosen feature flags (if provided) so the
		// selections take effect at runtime instead of falling back to defaults.
		if (body.flags && Object.keys(body.flags).length > 0) {
			await ctx.runMutation(internal.organizations.featureFlags.setAllInternal, {
				flags: body.flags,
			});
		}

		return new Response(JSON.stringify({ success: true, userId }), {
			status: 201,
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return new Response(JSON.stringify({ error: message }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
});
