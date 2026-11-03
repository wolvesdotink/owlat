/**
 * The sender logo cache: one `senderLogos` row per organisational domain.
 *
 *   - {@link requestSenderLogo} runs inside the delivery transaction of a
 *     message that may show a logo. It schedules a lookup when the domain has
 *     no fresh row, so mail delivery is the only thing that ever starts an
 *     outbound fetch. A client cannot name a domain to fetch.
 *   - {@link commitSenderLogo} is the lookup action's one commit.
 *   - {@link withSenderLogos} adds `senderLogoUrl` to the rows a list or reader
 *     query returns. The URL is this deployment's own storage URL, so the
 *     client never contacts the sender, and a row gets one only when its own
 *     message passed the checks in `eligibility.ts` and the viewer has not
 *     turned logos off.
 */

import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import { isLookupDomain, senderLogoDomain, type SenderLogoInput } from './eligibility';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A logo is looked up again after this, so a rebrand shows up. */
const FOUND_TTL_MS = 14 * DAY_MS;
/** A domain without a usable logo is asked again after this. */
const NONE_TTL_MS = 3 * DAY_MS;
/** A lookup that never committed (the action died) is retried after this. */
const PENDING_TTL_MS = HOUR_MS;

/**
 * Whether a row still answers for its domain, or a new lookup is due. A
 * refresh keeps the current logo showing while it runs, so "in flight" is a
 * `requestedAt` newer than the last `checkedAt`, not a status.
 */
export function isSenderLogoFresh(row: Doc<'senderLogos'>, now: number): boolean {
	if (row.checkedAt === undefined || row.requestedAt > row.checkedAt) {
		return now - row.requestedAt < PENDING_TTL_MS;
	}
	const ttl = row.status === 'found' ? FOUND_TTL_MS : NONE_TTL_MS;
	return now - row.checkedAt < ttl;
}

async function rowForDomain(
	ctx: Pick<QueryCtx, 'db'>,
	domain: string
): Promise<Doc<'senderLogos'> | null> {
	return ctx.db
		.query('senderLogos')
		.withIndex('by_domain', (q) => q.eq('domain', domain))
		.unique();
}

/**
 * Schedule a logo lookup for a just-delivered message's sender, when the
 * message may show one and its domain has no fresh row. Mutation-side helper
 * for the delivery pipeline (`deliveryPipeline/afterInsert.ts`).
 */
export async function requestSenderLogo(
	ctx: MutationCtx,
	message: SenderLogoInput,
	now: number
): Promise<void> {
	const domain = senderLogoDomain(message);
	if (domain === null || !isLookupDomain(domain)) return;
	const row = await rowForDomain(ctx, domain);
	if (row && isSenderLogoFresh(row, now)) return;
	if (row) await ctx.db.patch(row._id, { requestedAt: now });
	else await ctx.db.insert('senderLogos', { domain, status: 'pending', requestedAt: now });
	await ctx.scheduler.runAfter(0, internal.mail.senderLogos.fetch.fetchSenderLogo, {
		domain,
		requestedAt: now,
	});
}

/**
 * Record a lookup's result, replacing the domain's previous answer: a domain
 * that stopped publishing a logo loses it. Only the newest lookup commits.
 * Returns whether `storageId` was kept, so the action frees the blob
 * otherwise (the row is gone, or a newer lookup owns it).
 */
export const commitSenderLogo = internalMutation({
	args: {
		domain: v.string(),
		requestedAt: v.number(),
		logo: v.union(
			v.null(),
			v.object({
				source: v.union(v.literal('bimi'), v.literal('icon')),
				storageId: v.id('_storage'),
			})
		),
	},
	handler: async (ctx, args): Promise<{ isKept: boolean }> => {
		const row = await rowForDomain(ctx, args.domain);
		if (!row || row.requestedAt !== args.requestedAt) return { isKept: false };
		if (row.storageId && row.storageId !== args.logo?.storageId) {
			await ctx.storage.delete(row.storageId);
		}
		const now = Date.now();
		if (args.logo) {
			await ctx.db.patch(row._id, {
				status: 'found',
				source: args.logo.source,
				storageId: args.logo.storageId,
				checkedAt: now,
			});
			return { isKept: true };
		}
		await ctx.db.patch(row._id, {
			status: 'none',
			source: undefined,
			storageId: undefined,
			checkedAt: now,
		});
		return { isKept: false };
	},
});

/** Whether the viewing user wants logos; absent setting or no session reads as on. */
async function viewerWantsLogos(ctx: QueryCtx): Promise<boolean> {
	const session = await getBetterAuthSessionWithRole(ctx);
	if (!session) return true;
	const settings = await ctx.db
		.query('mailUserSettings')
		.withIndex('by_user', (q) => q.eq('userId', session.userId))
		.first();
	return settings?.isSenderLogosOn !== false;
}

export type SenderLogoField = { senderLogoUrl?: string };

/**
 * `rows` with `senderLogoUrl` set on each one that may show a cached logo.
 * One index read per distinct domain on the page. Rows without a logo travel
 * unchanged, so an absent key never rides as a present `undefined`.
 */
export async function withSenderLogos<Row extends SenderLogoInput>(
	ctx: QueryCtx,
	rows: Row[]
): Promise<Array<Row & SenderLogoField>> {
	const domains = rows.map((row) => senderLogoDomain(row));
	if (domains.every((domain) => domain === null)) return rows;
	if (!(await viewerWantsLogos(ctx))) return rows;

	const urls = new Map<string, string | null>();
	await Promise.all(
		[...new Set(domains)].map(async (domain) => {
			if (domain === null) return;
			const row = await rowForDomain(ctx, domain);
			const url =
				row?.status === 'found' && row.storageId ? await ctx.storage.getUrl(row.storageId) : null;
			urls.set(domain, url);
		})
	);
	return rows.map((row, i) => {
		const domain = domains[i];
		const url = domain ? urls.get(domain) : null;
		return url ? { ...row, senderLogoUrl: url } : row;
	});
}
