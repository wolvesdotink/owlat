/**
 * The "ask an admin" request queue, shared by its two tables.
 *
 * `accessRequests` (auth/accessRequest.ts, an orgless user asking to join) and
 * `mailboxRequests` (mail/mailboxRequest.ts, a member asking for a mailbox) are
 * the same queue: one open row per requester, refreshed rather than stacked,
 * listed to admins on the dashboard, resolved by acknowledgement. The tables
 * stay separate because the mailbox flow adds a `fulfilled` status and its own
 * provisioning path, but everything the two share lives here so a fix lands in
 * one place:
 *   - `upsertOpenRequest`: refresh the caller's open row or insert one;
 *   - `listOpenRequests`: the admin dashboard projection;
 *   - `resolveOpenRequest`: org-scoped, open-only acknowledgement. A decided row
 *     is never rewritten, so a second admin's late click cannot overwrite who
 *     resolved it (or turn a `fulfilled` mailbox request back into `resolved`).
 *
 * Member erasure (auth/memberErasure.ts) deletes both tables' rows for the
 * member, since each row carries the requester's email, name and note.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { MutationSessionContext } from './sessionOrganization';
import { getOrThrow, throwForbidden, throwInvalidInput, throwInvalidState } from '../_utils/errors';

/** The tables that hold an admin-request queue. Their columns are identical. */
export type AdminRequestTable = 'accessRequests' | 'mailboxRequests';

/** Max length of the free-text note a requester can attach. */
export const ADMIN_REQUEST_NOTE_MAX = 500;

/**
 * Both tables share every column and index this module touches, so one of them
 * stands in as the type the query builder is checked against. Convex's index
 * typing cannot resolve `withIndex` over a union of table names, so the cast is
 * kept here rather than at each call site. `mailboxRequests` is the stand-in
 * because its `status` union is the wider of the two.
 */
type RepresentativeTable = 'mailboxRequests';

function asRepresentative(table: AdminRequestTable): RepresentativeTable {
	return table as RepresentativeTable;
}

/** Reject an over-long note, then trim it (an empty note is stored as absent). */
export function normalizeRequestNote(note: string | undefined): string | undefined {
	if (note !== undefined && note.length > ADMIN_REQUEST_NOTE_MAX) {
		throwInvalidInput(`Note must be ${ADMIN_REQUEST_NOTE_MAX} characters or fewer`);
	}
	return note?.trim() || undefined;
}

/**
 * Who is asking, as the admin card shows it. The card is only useful if it
 * names the requester, so prefer the profile email (written at signup) and fall
 * back to the session identity's email rather than inserting a blank row that
 * renders as an empty card.
 */
export async function resolveRequesterIdentity(
	ctx: QueryCtx | MutationCtx,
	authUserId: string,
	identityEmail: unknown
): Promise<{ requesterEmail: string; requesterName: string | undefined }> {
	const profile = await ctx.db
		.query('userProfiles')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
		.first();
	let requesterEmail = profile?.email?.trim();
	if (!requesterEmail) {
		requesterEmail = typeof identityEmail === 'string' ? identityEmail.trim() : '';
	}
	if (!requesterEmail) {
		throwInvalidState('Your account has no email address to share with admins');
	}
	return { requesterEmail, requesterName: profile?.name };
}

/**
 * Record the caller's request. One open request per requester: an existing open
 * row gets the new note instead of a second row being stacked beside it. The
 * note is validated and trimmed here, so callers pass the raw argument.
 */
export async function upsertOpenRequest<T extends AdminRequestTable>(
	ctx: MutationCtx,
	table: T,
	args: {
		authUserId: string;
		organizationId: string;
		note: string | undefined;
		identityEmail: unknown;
	}
): Promise<Id<T>> {
	const note = normalizeRequestNote(args.note);

	const open = await ctx.db
		.query(asRepresentative(table))
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', args.authUserId))
		.filter((q) => q.eq(q.field('status'), 'open'))
		.first();
	if (open) {
		await ctx.db.patch(open._id, { note });
		return open._id as Id<AdminRequestTable> as Id<T>;
	}

	const { requesterEmail, requesterName } = await resolveRequesterIdentity(
		ctx,
		args.authUserId,
		args.identityEmail
	);
	const requestId = await ctx.db.insert(asRepresentative(table), {
		authUserId: args.authUserId,
		organizationId: args.organizationId,
		requesterEmail,
		requesterName,
		note,
		status: 'open',
		createdAt: Date.now(),
	});
	return requestId as Id<AdminRequestTable> as Id<T>;
}

/** The open requests addressed to an organization, as the admin dashboard lists them. */
export async function listOpenRequests<T extends AdminRequestTable>(
	ctx: QueryCtx,
	table: T,
	organizationId: string
): Promise<
	Array<{ id: Id<T>; email: string; name: string | null; note: string | null; createdAt: number }>
> {
	const rows = await ctx.db
		.query(asRepresentative(table))
		.withIndex('by_org_and_status', (q) =>
			q.eq('organizationId', organizationId).eq('status', 'open')
		)
		.collect();
	// bounded: one open row per requester (refreshed, not stacked), and this
	// deployment hosts a single organization, so the list is bounded by the
	// number of people who can ask.

	return rows.map((r) => ({
		id: r._id as Id<AdminRequestTable> as Id<T>,
		email: r.requesterEmail,
		name: r.requesterName ?? null,
		note: r.note ?? null,
		createdAt: r.createdAt,
	}));
}

/**
 * Mark an open request resolved: a plain acknowledgement that grants nothing.
 * Org-scoped (a request from another organization is rejected) and open-only:
 * a row an admin already decided is left exactly as it is, so a stale or second
 * click neither rewrites `resolvedByUserId`/`resolvedAt` nor downgrades a
 * `fulfilled` mailbox request. Idempotent either way.
 */
export async function resolveOpenRequest<T extends AdminRequestTable>(
	ctx: MutationCtx,
	table: T,
	requestId: Id<T>,
	session: Pick<MutationSessionContext, 'userId' | 'activeOrganizationId'>
): Promise<{ resolved: true }> {
	// The validator already pins the id to its table; normalizing against the
	// named table keeps a mismatched pair from resolving the wrong queue's row.
	const id = ctx.db.normalizeId(asRepresentative(table), requestId);
	if (!id) throwInvalidInput('Unknown request');

	const row = await getOrThrow(ctx, id, 'Request');
	if (row.organizationId !== session.activeOrganizationId) {
		throwForbidden('Request not accessible');
	}
	if (row.status !== 'open') {
		return { resolved: true };
	}

	await ctx.db.patch(id, {
		status: 'resolved',
		resolvedByUserId: session.userId,
		resolvedAt: Date.now(),
	});
	return { resolved: true };
}
