import { httpAction } from './_generated/server';
import { components } from './_generated/api';
import { internal } from './_generated/api';
import { getOptional } from './lib/env';
import { betterAuthAdapterArgs } from './lib/betterAuthAdapterArgs';
import { safeCompare } from './lib/safeCompare';
import { getClientIp, rateLimitedResponse } from './publicRateLimit';
import { logError } from './lib/runtimeLog';

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
 * Body: { email: string, name: string, passwordHash: string, flags?: Record<string, boolean>, isMigrationMode?: boolean }
 *
 * `flags` (optional) carries the setup wizard's resolved feature-flag map; when
 * present it is persisted onto instanceSettings.featureFlags so the wizard's
 * selections actually take effect at runtime. Omitted by the bare VPS-provision
 * path, which then falls back to the compiled-in flag defaults.
 *
 * `isMigrationMode` (optional) carries the wizard's "moving from another platform?"
 * answer onto instanceSettings.isMigrationMode. Defaults to false (fresh start).
 */

export const seedAdmin = httpAction(async (ctx, request) => {
	// Per-IP rate limit BEFORE the secret check, so a caller can't brute-force
	// the instance secret (or hammer the bootstrap) at line rate. Without a
	// trusted proxy configured every caller shares one bucket — coarse, but it
	// still caps total volume, and a healthy deployment calls this once.
	const { ok: rateOk, retryAfter } = await ctx.runMutation(
		internal.publicRateLimit.checkPublicRateLimit,
		{ limitType: 'adminSeed', key: getClientIp(request) }
	);
	if (!rateOk) return rateLimitedResponse(retryAfter);

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
	let body: {
		email: string;
		name: string;
		passwordHash: string;
		flags?: Record<string, boolean>;
		isMigrationMode?: boolean;
	};
	try {
		body = (await request.json()) as {
			email: string;
			name: string;
			passwordHash: string;
			flags?: Record<string, boolean>;
			isMigrationMode?: boolean;
		};
	} catch {
		return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	if (!body.email || !body.name || !body.passwordHash) {
		return new Response(
			JSON.stringify({ error: 'Missing required fields: email, name, passwordHash' }),
			{
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			}
		);
	}

	// One-shot check: refuse if any user already exists…
	const existingUser = await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'user',
		where: [],
		paginationOpts: { cursor: null, numItems: 1 },
	});

	if (existingUser && existingUser.page && existingUser.page.length > 0) {
		return new Response(
			JSON.stringify({ error: 'Users already exist. Seed endpoint is one-shot only.' }),
			{
				status: 409,
				headers: { 'Content-Type': 'application/json' },
			}
		);
	}

	// Fast path: refuse before any write if the durable latch is already stamped,
	// even when no user rows remain. The user probe above re-arms if every user is
	// deleted; this latch does not. (The authoritative, race-free gate is the
	// atomic claim below — this is just a cheap early reject.)
	const alreadySeeded = await ctx.runQuery(
		internal.workspaces.settings.hasCompletedAdminSeedInternal,
		{}
	);
	if (alreadySeeded) {
		return new Response(
			JSON.stringify({ error: 'Admin seed has already completed on this instance.' }),
			{
				status: 409,
				headers: { 'Content-Type': 'application/json' },
			}
		);
	}

	// The org display name is needed both to seed `instanceSettings.defaultFromName`
	// and to name the organization row later, so derive it once up front.
	const orgName = `${body.name}'s Team`;

	// Create the instanceSettings singleton (idempotent) BEFORE the atomic latch
	// claim, so the seed's settings columns are persisted and the claim always has
	// a row to stamp. No latch here — the claim below owns stamping it.
	await ctx.runMutation(internal.workspaces.settings.createInternal, {
		timezone: 'UTC',
		defaultFromName: orgName,
		isMigrationMode: body.isMigrationMode ?? false,
	});

	// ATOMICALLY claim the durable one-shot latch BEFORE creating any user. The
	// claim reads and stamps `adminSeedCompletedAt` in a SINGLE transaction and
	// returns whether THIS request won it, so two concurrent /seed/admin calls
	// can't both pass a check-then-write and both seed — the loser gets a 409.
	// A failure AFTER the claim leaves the latch set (fail-closed) — recovering a
	// half-seeded instance is an operator action.
	const { claimed } = await ctx.runMutation(
		internal.workspaces.settings.claimAdminSeedInternal,
		{}
	);
	if (!claimed) {
		return new Response(
			JSON.stringify({ error: 'Admin seed has already completed on this instance.' }),
			{
				status: 409,
				headers: { 'Content-Type': 'application/json' },
			}
		);
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
			input: betterAuthAdapterArgs({
				model: 'user',
				data: {
					email: body.email,
					name: body.name,
					emailVerified: true,
					createdAt: nowMs,
					updatedAt: nowMs,
				},
			}),
		})) as unknown as { _id: string };
		const userId = userDoc._id;

		// Create BetterAuth account record with the hashed password
		await ctx.runMutation(components.betterAuth.adapter.create, {
			input: betterAuthAdapterArgs({
				model: 'account',
				data: {
					userId,
					providerId: 'credential',
					accountId: userId,
					password: body.passwordHash,
					createdAt: nowMs,
					updatedAt: nowMs,
				},
			}),
		});

		// Create BetterAuth organization
		// Collapse runs of `-` and strip leading/trailing `-` so an email local
		// part like `+++@x.com` doesn't yield the all-dashes slug `---`.
		const slugBase = body.email
			.split('@')[0]
			?.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
		const orgSlug = slugBase && slugBase.length > 0 ? slugBase : 'org';

		const orgDoc = (await ctx.runMutation(components.betterAuth.adapter.create, {
			input: betterAuthAdapterArgs({
				model: 'organization',
				data: {
					name: orgName,
					slug: orgSlug,
					createdAt: nowMs,
				},
			}),
		})) as unknown as { _id: string };
		const orgId = orgDoc._id;

		// Create BetterAuth member record (owner role)
		await ctx.runMutation(components.betterAuth.adapter.create, {
			input: betterAuthAdapterArgs({
				model: 'member',
				data: {
					userId,
					organizationId: orgId,
					role: 'owner',
					createdAt: nowMs,
				},
			}),
		});

		// Create userProfile record
		await ctx.runMutation(internal.auth.userProfiles.createInternal, {
			authUserId: userId,
			email: body.email,
			name: body.name,
		});

		// The instanceSettings singleton (timezone, defaultFromName, migration mode)
		// was already created by `createInternal`, and its durable one-shot latch
		// stamped by the atomic `claimAdminSeedInternal` claim above, before any
		// user was created.

		// Persist the wizard's chosen feature flags (if provided) so the
		// selections take effect at runtime instead of falling back to defaults.
		if (body.flags && Object.keys(body.flags).length > 0) {
			await ctx.runMutation(internal.workspaces.featureFlags.setAllInternal, {
				flags: body.flags,
			});
		}

		return new Response(JSON.stringify({ success: true, userId }), {
			status: 201,
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (error) {
		// Locked error envelope — log the real cause server-side, return a fixed
		// message so an internal error never leaks its detail to the HTTP caller.
		logError('[seedAdmin] seed failed:', error);
		return new Response(JSON.stringify({ error: 'Internal error' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
});
