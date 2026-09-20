/**
 * `POST /dev/reset` — wipe the instance back to a blank slate so the signup
 * flow at `/auth/register` can be exercised end-to-end without
 * `docker compose down -v`.
 *
 * Deletes EVERYTHING tenant-side, not just seed-tagged rows — the goal is a
 * blank instance, so a developer who hand-created content through the live
 * UI does not get an orphaned dataset after reset. The table list is the shared
 * `TENANT_TABLES` from `lib/tenantTables.ts` (also used by account deletion).
 *
 * Order of operations:
 *   1. Wipe all tenant tables (contacts/automations/templates/campaigns/…),
 *      freeing the storage blobs the row-bearing ones own — `mailMessages`
 *      through `deleteMessageRowAndBlobs`, the rest via `ownedBlobs`.
 *   2. Wipe BetterAuth tables (session/invitation/member/organization/account/
 *      user). `session` and `invitation` matter as much as `user`: a surviving
 *      session row keeps authenticating a cookie whose user this reset deletes,
 *      and a surviving pending invitation lets that address self-register into
 *      an organization that no longer exists (see auth/registrationGate.ts).
 *      Note the reset cannot close the ~5 minute window of BetterAuth's session
 *      cookie cache (auth.ts `cookieCache.maxAge`), during which a pre-reset
 *      cookie still authenticates with no session row at all.
 *   3. Wipe Owlat-local auth tables (userProfiles/platformAdmins/instanceSettings/
 *      onboardingProgress/userOnboarding/sendReadyNotices/sendPathReadiness)
 *
 * Driven by the `POST /dev/reset` route in `devShortcuts/resetHttp.ts`, which
 * owns the X-Instance-Secret and dev-deployment guards.
 *
 * Idempotent: a second call against a blank instance returns zeros for every
 * counter.
 */

import { internalMutation, type MutationCtx } from '../_generated/server';
import { components } from '../_generated/api';
import { TENANT_TABLES } from '../lib/tenantTables';
import { betterAuthAdapterArgs } from '../lib/betterAuthAdapterArgs';
import { deleteMessageRowAndBlobs } from '../mail/messagePurge';
import { logError } from '../lib/runtimeLog';
import type { Doc, Id, TableNames } from '../_generated/dataModel';

interface ResetCounts {
	users: number;
	sessions: number;
	invitations: number;
	accounts: number;
	organizations: number;
	members: number;
	userProfiles: number;
	platformAdmins: number;
	instanceSettings: number;
	onboardingProgress: number;
	userOnboarding: number;
	sendReadyNotices: number;
	sendPathReadiness: number;
	tenantRows: number;
}

export const runReset = internalMutation({
	args: {},
	handler: async (ctx): Promise<ResetCounts> => {
		const counts: ResetCounts = {
			users: 0,
			sessions: 0,
			invitations: 0,
			accounts: 0,
			organizations: 0,
			members: 0,
			userProfiles: 0,
			platformAdmins: 0,
			instanceSettings: 0,
			onboardingProgress: 0,
			userOnboarding: 0,
			sendReadyNotices: 0,
			sendPathReadiness: 0,
			tenantRows: 0,
		};

		// 1. Wipe all tenant tables, freeing the blobs the row-bearing ones own.
		for (const table of TENANT_TABLES) {
			const rows = await ctx.db.query(table).collect(); // bounded: dev-only full wipe of each tenant table
			for (const row of rows) {
				if (table === 'mailMessages') {
					// A `mailMessages` row owns up to three storage blobs, and the
					// generic wipe freed none of them — every reset orphaned the whole
					// instance's mail in storage, which nothing ever collects. Route it
					// through the one helper that destroys these rows.
					await deleteMessageRowAndBlobs(ctx, row as Doc<'mailMessages'>);
					counts.tenantRows++;
					continue;
				}
				for (const storageId of ownedBlobs(table, row)) {
					await deleteBlobQuietly(ctx, storageId);
				}
				await ctx.db.delete(row._id);
				counts.tenantRows++;
			}
		}

		// 2. Wipe BetterAuth tables via the component adapter. Order matters:
		// dependants (member) before parents (user/organization).
		// `session` first: a surviving session row keeps authenticating a cookie
		// whose USER this reset is about to delete. The app then renders its shell
		// for a ghost account and every query comes back empty — which reads as
		// "the page is broken", not "you are signed out", and cost a full
		// debugging session to track down.
		counts.sessions = await wipeBetterAuthModel(ctx, 'session');
		// Pending invitations outlive their organization otherwise, and
		// `registrationGate` reads them to allow a post-bootstrap signup — so a
		// stale invite lets that address register into a deleted org.
		counts.invitations = await wipeBetterAuthModel(ctx, 'invitation');
		counts.members = await wipeBetterAuthModel(ctx, 'member');
		counts.organizations = await wipeBetterAuthModel(ctx, 'organization');
		counts.accounts = await wipeBetterAuthModel(ctx, 'account');
		counts.users = await wipeBetterAuthModel(ctx, 'user');

		// 3. Wipe Owlat-local auth tables.
		const profiles = await ctx.db.query('userProfiles').collect(); // bounded: dev-only; org member roster (tiny)
		for (const p of profiles) {
			await ctx.db.delete(p._id);
			counts.userProfiles++;
		}

		// Platform-admin grants are keyed by BetterAuth user id, and step 2 just
		// deleted every user. A surviving row would keep granting the deployment
		// surface to a ghost id, and — because both bootstrap paths refuse once
		// the roster is non-empty — would also stop the NEXT seed from handing
		// the fresh setup user their own grant. A blank instance means blank.
		const platformAdmins = await ctx.db.query('platformAdmins').collect(); // bounded: dev-only; operator roster (low tens at most)
		for (const a of platformAdmins) {
			await ctx.db.delete(a._id);
			counts.platformAdmins++;
		}

		const settings = await ctx.db.query('instanceSettings').collect(); // bounded: dev-only; singleton instance-settings row
		for (const s of settings) {
			await ctx.db.delete(s._id);
			counts.instanceSettings++;
		}

		const onboarding = await ctx.db.query('onboardingProgress').collect(); // bounded: dev-only; one row per user
		for (const o of onboarding) {
			await ctx.db.delete(o._id);
			counts.onboardingProgress++;
		}

		const userOnboarding = await ctx.db.query('userOnboarding').collect(); // bounded: dev-only; one row per user
		for (const o of userOnboarding) {
			await ctx.db.delete(o._id);
			counts.userOnboarding++;
		}

		// "You can send now" nudges are keyed by BetterAuth user id — after the
		// user wipe above they point at nobody, and a leftover pending row would
		// toast the first account created on the fresh instance.
		const sendReadyNotices = await ctx.db.query('sendReadyNotices').collect(); // bounded: dev-only; at most one row per user per transport change
		for (const n of sendReadyNotices) {
			await ctx.db.delete(n._id);
			counts.sendReadyNotices++;
		}

		// The edge detector's last sample. Leaving it behind would make a blank
		// instance look like sending was ALREADY known-good, so the next cron tick
		// would see no edge and never notify. Cleared, the next tick re-baselines.
		const sendPathReadiness = await ctx.db.query('sendPathReadiness').collect(); // bounded: dev-only; singleton readiness row
		for (const r of sendPathReadiness) {
			await ctx.db.delete(r._id);
			counts.sendPathReadiness++;
		}

		return counts;
	},
});

/**
 * The storage blobs a tenant row OWNS, per table — everything a row-only delete
 * would strand.
 *
 * THE SAME LIST AS `workspaces/deletion/steps/`, which gives each of these
 * tables its own storage-aware step for exactly this reason; this wipe walks
 * `TENANT_TABLES` generically, so the knowledge has to live somewhere and this
 * is where. `accountExportArtifacts` was the only entry the generic path ever
 * handled, so every other table here orphaned its bytes on every reset — and
 * `inboundMessages` now holds the WHOLE received message, sealed, plus the
 * attachments captured out of it in `semanticFiles`. Nothing reclaims those
 * afterwards: the inbound retention sweep finds blobs by walking the rows this
 * loop just deleted.
 *
 * A blob a retention sweep already released is absent, so every optional field
 * is guarded. `mailMessages` is NOT here: it owns three blobs and a helper of
 * its own (`deleteMessageRowAndBlobs`) that deletes the row too.
 */
function ownedBlobs(table: (typeof TENANT_TABLES)[number], row: Doc<TableNames>): Id<'_storage'>[] {
	switch (table) {
		case 'accountExportArtifacts':
			return [(row as Doc<'accountExportArtifacts'>).storageId];
		case 'mediaAssets':
			return [(row as Doc<'mediaAssets'>).storageId];
		case 'inboundMessages': {
			const raw = (row as Doc<'inboundMessages'>).rawStorageId;
			return raw ? [raw] : [];
		}
		case 'semanticFiles': {
			const stored = (row as Doc<'semanticFiles'>).storageId;
			return stored ? [stored] : [];
		}
		case 'mailAttachmentShares': {
			const stored = (row as Doc<'mailAttachmentShares'>).storageId;
			return stored ? [stored] : [];
		}
		case 'mailArchiveImports': {
			const stored = (row as Doc<'mailArchiveImports'>).storageId;
			return stored ? [stored] : [];
		}
		case 'mailDrafts':
			return (row as Doc<'mailDrafts'>).attachments.map((att) => att.storageId);
		case 'transactionalSends':
			return ((row as Doc<'transactionalSends'>).attachmentStorageIds ?? []) as Id<'_storage'>[];
		default:
			return [];
	}
}

/**
 * Delete a blob without letting one storage failure abort the wipe.
 *
 * "Already gone" is the ordinary case (a released blob whose row still names
 * it, a half-finished earlier reset), and a reset that throws part-way leaves
 * the instance in exactly the state it exists to clear.
 */
async function deleteBlobQuietly(ctx: MutationCtx, storageId: Id<'_storage'>): Promise<void> {
	try {
		await ctx.storage.delete(storageId);
	} catch (err) {
		logError('[dev reset] blob delete failed', { storageId, err });
	}
}

/**
 * Drain a BetterAuth model by re-querying from cursor=null after each batch
 * delete. Re-querying (instead of following `continueCursor`) avoids the
 * cursor-anchor-deleted pathology when we delete the page we just fetched.
 *
 * Defensive max-iteration cap: dev/selfhost instances should never hold more
 * than a few hundred auth rows, but keep the upper bound explicit so a
 * misbehaving adapter can't hang the mutation forever.
 */
async function wipeBetterAuthModel(
	ctx: MutationCtx,
	model: 'user' | 'session' | 'account' | 'organization' | 'member' | 'invitation'
): Promise<number> {
	let total = 0;
	const MAX_ITERATIONS = 200;
	for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
		const result: { page: Array<{ _id: string }>; isDone: boolean; continueCursor: string } =
			await ctx.runQuery(
				components.betterAuth.adapter.findMany,
				betterAuthAdapterArgs({
					model,
					where: [],
					paginationOpts: { cursor: null, numItems: 100 },
				})
			);
		const rows = result?.page ?? [];
		if (rows.length === 0) break;
		for (const row of rows) {
			await ctx.runMutation(
				components.betterAuth.adapter.deleteOne,
				betterAuthAdapterArgs({
					input: {
						model,
						where: [{ field: '_id', value: row._id }],
					},
				})
			);
			total++;
		}
		// Loop continues: re-query with cursor=null picks up whatever's left.
	}
	return total;
}
