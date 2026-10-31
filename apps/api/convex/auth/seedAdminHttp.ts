import { v } from 'convex/values';
import { decodeJson } from '@owlat/worker-protocol/decodeJson';
import { httpAction } from '../_generated/server';
import { components, internal } from '../_generated/api';
import { requireInstanceSecret } from '../lib/instanceSecret';
import { logError } from '../lib/runtimeLog';
import { errorResponse, jsonResponse } from '../lib/httpResponse';
import {
	ALREADY_SEEDED,
	USERS_EXIST,
	adminSeedAnswer,
	planAdminSeed,
	type AdminSeedAnswer,
} from './seedAdminDecision';

/**
 * HTTP action to seed the first admin user on a local instance.
 * Called during VPS provisioning (and now by the setup-cli `bootstrap-org`
 * command) to create the org admin with the same credentials they used on
 * the global instance.
 *
 * Protected by X-Instance-Secret header. One-shot: refuses if any user exists.
 * Everything is written by one commit (`auth/seedAdminCommit.ts`).
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
 *
 * The seeded user is also granted the initial `platformAdmins` superadmin row
 * (see `platformAdmin/bootstrap.ts`), which is what makes the operator surface —
 * System & Updates, Backups, the Operator console — reachable on a fresh
 * install without a hand-run migration.
 */

/**
 * Presence of the three strings is the handler's check, so a body missing one
 * keeps the message the setup CLI and the web wizard surface.
 */
const seedAdminBody = v.object({
	email: v.optional(v.string()),
	name: v.optional(v.string()),
	passwordHash: v.optional(v.string()),
	flags: v.optional(v.record(v.string(), v.boolean())),
	isMigrationMode: v.optional(v.boolean()),
});

export const seedAdmin = httpAction(async (ctx, request) => {
	// Per-IP rate limit BEFORE the secret check, so a caller can't brute-force
	// the instance secret (or hammer the bootstrap) at line rate. Without a
	// trusted proxy configured every caller shares one bucket — coarse, but it
	// still caps total volume, and a healthy deployment calls this once. Its own
	// strict bucket, separate from the other instance-secret routes.
	const denied = await requireInstanceSecret(ctx, request, { limitType: 'adminSeed' });
	if (denied) return denied;

	// Every failure, an oversized body included, stays the 400 this route has
	// always answered: the error categories have no 413.
	const decoded = await decodeJson(request, seedAdminBody, 100_000);
	if (!decoded.ok) return errorResponse('invalid_input', decoded.failure.message);
	const plan = planAdminSeed(decoded.value);
	if (!plan.ok) return answer(plan.answer);

	// Cheap early rejects before the commit: a user exists, or the durable
	// latch is stamped (the user probe re-arms if every user is deleted; the
	// latch does not). The commit re-checks both atomically with its writes.
	const existingUser = await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'user',
		where: [],
		paginationOpts: { cursor: null, numItems: 1 },
	});
	if (existingUser?.page && existingUser.page.length > 0) return answer(USERS_EXIST);
	const alreadySeeded = await ctx.runQuery(
		internal.workspaces.settings.hasCompletedAdminSeedInternal,
		{}
	);
	if (alreadySeeded) return answer(ALREADY_SEEDED);

	try {
		const result = await ctx.runMutation(internal.auth.seedAdminCommit.commitAdminSeed, plan.seed);
		return answer(adminSeedAnswer(result));
	} catch (error) {
		// Locked error envelope — log the real cause server-side, return a fixed
		// message so an internal error never leaks its detail to the HTTP caller.
		logError('[seedAdmin] seed failed:', error);
		return errorResponse('internal', 'Internal error');
	}
});

function answer(seedAnswer: AdminSeedAnswer): Response {
	if (seedAnswer.kind === 'created') {
		return jsonResponse({ success: true, userId: seedAnswer.userId }, 201);
	}
	return errorResponse(seedAnswer.category, seedAnswer.message);
}
