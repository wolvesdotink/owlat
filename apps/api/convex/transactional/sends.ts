import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { getUserIdFromSession } from '../lib/sessionOrganization';
import { throwNotFound } from '../_utils/errors';

// Status type for transactional email sends. Per ADR-0006 transactional
// sends pre-create in `queued` (so the worker can transition them through
// the Send lifecycle the same way campaign sends do) and `failed` rows
// persist on worker error.
export type TransactionalSendStatus =
	| 'queued'
	| 'sent'
	| 'failed'
	| 'delivered'
	| 'opened'
	| 'clicked'
	| 'bounced'
	| 'complained';

// Get all sends for a transactional email
export const listByTransactionalEmail = authedQuery({
	args: {
		transactionalEmailId: v.id('transactionalEmails'),
		status: v.optional(
			v.union(
				v.literal('queued'),
				v.literal('sent'),
				v.literal('failed'),
				v.literal('delivered'),
				v.literal('opened'),
				v.literal('clicked'),
				v.literal('bounced'),
				v.literal('complained')
			)
		),
		limit: v.optional(v.number()),
		offset: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		const transactionalEmail = await ctx.db.get(args.transactionalEmailId);
		if (!transactionalEmail) {
			throwNotFound('Transactional email');
		}

		const offset = args.offset || 0;
		const limit = args.limit || 50;

		// Use index with ordering, apply status filter at db level
		let query = ctx.db
			.query('transactionalSends')
			.withIndex('by_transactional_email', (q) =>
				q.eq('transactionalEmailId', args.transactionalEmailId)
			)
			.order('desc')
			// Honor the soft-delete contract: erased (GDPR) sends must not appear.
			.filter((q) => q.eq(q.field('deletedAt'), undefined));

		if (args.status) {
			query = query.filter((q) => q.eq(q.field('status'), args.status));
		}

		// Read one past the page to derive an honest `hasMore`. We intentionally
		// do NOT report a `total` — a true count would require scanning the whole
		// (unbounded) index, and the old `total` was just `offset+limit+1` capped,
		// i.e. a hasMore sentinel masquerading as a count. Consumers paginate off
		// `hasMore`.
		const sends = await query.take(offset + limit + 1);

		const hasMore = sends.length > offset + limit;
		const paginatedSends = sends.slice(offset, offset + limit);

		// Batch-fetch contacts to avoid N+1
		const contactIds = [...new Set(paginatedSends.filter((s) => s.contactId).map((s) => s.contactId!))];
		const contacts = await Promise.all(contactIds.map((id) => ctx.db.get(id)));
		const contactMap = new Map(contacts.filter(Boolean).map((c) => [c!._id, c!]));

		const sendsWithContacts = paginatedSends.map((send) => {
			const contactData = send.contactId ? contactMap.get(send.contactId) : null;
			return {
				...send,
				contact: contactData
					? { _id: contactData._id, email: contactData.email, firstName: contactData.firstName, lastName: contactData.lastName }
					: null,
			};
		});

		return {
			sends: sendsWithContacts,
			hasMore,
		};
	},
});

// Get all sends
export const listAll = authedQuery({
	args: {
		limit: v.optional(v.number()),
		offset: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		const offset = args.offset || 0;
		const limit = args.limit || 50;

		// Read one past the page for an honest `hasMore`; no `total` (see
		// listByTransactionalEmail — a true count would scan the whole table).
		const sends = await ctx.db
			.query('transactionalSends')
			.order('desc')
			// Honor the soft-delete contract: erased (GDPR) sends must not appear.
			.filter((q) => q.eq(q.field('deletedAt'), undefined))
			.take(offset + limit + 1);

		const hasMore = sends.length > offset + limit;
		const paginatedSends = sends.slice(offset, offset + limit);

		// Batch-fetch unique transactional emails and contacts to avoid N+1.
		// `transactionalEmailId` is optional now that non-campaign sends
		// (automation / agent_reply) share this table and don't reference a
		// transactional template, so filter out the absent ids.
		const templateIds = [
			...new Set(
				paginatedSends.flatMap((s) =>
					s.transactionalEmailId ? [s.transactionalEmailId] : []
				)
			),
		];
		const contactIds = [...new Set(paginatedSends.filter((s) => s.contactId).map((s) => s.contactId!))];

		const [templates, contacts] = await Promise.all([
			Promise.all(templateIds.map((id) => ctx.db.get(id))),
			Promise.all(contactIds.map((id) => ctx.db.get(id))),
		]);

		const templateMap = new Map(templates.filter(Boolean).map((t) => [t!._id, t!]));
		const contactMap = new Map(contacts.filter(Boolean).map((c) => [c!._id, c!]));

		const sendsWithDetails = paginatedSends.map((send) => {
			const transactionalEmail = send.transactionalEmailId
				? templateMap.get(send.transactionalEmailId)
				: null;
			const contactData = send.contactId ? contactMap.get(send.contactId) : null;
			return {
				...send,
				transactionalEmail: transactionalEmail
					? { name: transactionalEmail.name, slug: transactionalEmail.slug }
					: null,
				contact: contactData
					? { _id: contactData._id, email: contactData.email, firstName: contactData.firstName, lastName: contactData.lastName }
					: null,
			};
		});

		return {
			sends: sendsWithDetails,
			hasMore,
		};
	},
});

// Get a single send by ID
export const get = authedQuery({
	args: { id: v.id('transactionalSends') },
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		const send = await ctx.db.get(args.id);
		// Honor the soft-delete contract: an erased (GDPR) send reads as absent.
		if (!send || send.deletedAt !== undefined) return null;

		// `transactionalEmailId` is optional: automation / agent_reply sends
		// live in this table without a transactional template reference.
		const transactionalEmail = send.transactionalEmailId
			? await ctx.db.get(send.transactionalEmailId)
			: null;
		let contact = null;
		if (send.contactId) {
			const contactData = await ctx.db.get(send.contactId);
			if (contactData) {
				contact = {
					_id: contactData._id,
					email: contactData.email,
					firstName: contactData.firstName,
					lastName: contactData.lastName,
				};
			}
		}

		return {
			...send,
			transactionalEmail: transactionalEmail
				? {
						name: transactionalEmail.name,
						slug: transactionalEmail.slug,
						subject: transactionalEmail.subject,
					}
				: null,
			contact,
		};
	},
});

// Get send counts for all transactional emails (batch query for list display).
// Reads the denormalized `sendCount` field on each template — written by the
// Transactional send intake (module) atomically with the `transactionalSends`
// insert. The pre-deepening shape did an N+1 `collect()` over
// `transactionalSends` per template; for a deployment with many templates
// and high send volume, that was a list-page hot read.
export const getCounts = authedQuery({
	args: {},
	handler: async (ctx) => {
		await getUserIdFromSession(ctx);
		const transactionalEmails = await ctx.db
			.query('transactionalEmails')
			.collect(); // bounded: per-deployment template set is small

		const counts: Record<string, number> = {};
		for (const email of transactionalEmails) {
			counts[email._id] = email.sendCount ?? 0;
		}
		return counts;
	},
});

// Per ADR-0021, every `transactionalSends` row write is owned by the
// **Transactional send intake (module)** (`transactional/dispatch.ts`) at
// create time and by the **Send lifecycle (module)** (`delivery/sendLifecycle.ts`)
// for every transition after. The pre-ADR-0006 `create` mutation that
// inserted directly in `sent` is gone (zero callers); the pre-ADR-0006
// `createInternal` was already removed.
//
// Status writes (markAsDelivered / recordOpen / recordClick / markAsBounced
// / markAsComplained) flow through `internal.delivery.sendLifecycle.transition`
// with a SendRef `{ kind: 'transactional', id }`. See CONTEXT.md
// "Send lifecycle".

// Delete sends for a transactional email (used when deleting the email template)
export const deleteByTransactionalEmail = internalMutation({
	args: { transactionalEmailId: v.id('transactionalEmails') },
	handler: async (ctx, args) => {
		const sends = await ctx.db
			.query('transactionalSends')
			.withIndex('by_transactional_email', (q) =>
				q.eq('transactionalEmailId', args.transactionalEmailId)
			)
			.collect();

		for (const send of sends) {
			await ctx.db.delete(send._id);
		}

		return sends.length;
	},
});

// Get recent sends for a recipient email
export const getByEmail = authedQuery({
	args: {
		email: v.string(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		const limit = args.limit || 10;
		const sends = await ctx.db
			.query('transactionalSends')
			.withIndex('by_email', (q) => q.eq('email', args.email))
			.order('desc')
			// Honor the soft-delete contract: erased (GDPR) sends must not appear.
			.filter((q) => q.eq(q.field('deletedAt'), undefined))
			.take(limit);

		// Fetch transactional email info
		const sendsWithDetails = await Promise.all(
			sends.map(async (send) => {
				const transactionalEmail = send.transactionalEmailId
					? await ctx.db.get(send.transactionalEmailId)
					: null;
				return {
					...send,
					transactionalEmail: transactionalEmail
						? {
								name: transactionalEmail.name,
								slug: transactionalEmail.slug,
							}
						: null,
				};
			})
		);

		return sendsWithDetails;
	},
});
