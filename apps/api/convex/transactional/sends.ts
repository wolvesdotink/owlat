import { v } from 'convex/values';
import { transactionalQuery } from './_helpers';
import { getOrThrow } from '../_utils/errors';
import { sendStatusValidator } from '../lib/literalValidators';
import { isLiveContact } from '../lib/contactHelpers';
import { isSharedInboxReader } from '../inbox/access';

// Get all sends for a transactional email
// all-members: the send log of a transactional template, which every role
// reads on the template page. A Team inbox reply carries no template id, so
// none reaches this list.
export const listByTransactionalEmail = transactionalQuery({
	args: {
		transactionalEmailId: v.id('transactionalEmails'),
		status: v.optional(sendStatusValidator),
		limit: v.optional(v.number()),
		offset: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await getOrThrow(ctx, args.transactionalEmailId, 'Transactional email');

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
		const contactIds = [
			...new Set(paginatedSends.filter((s) => s.contactId).map((s) => s.contactId!)),
		];
		const contacts = await Promise.all(contactIds.map((id) => ctx.db.get(id)));
		// A soft-deleted contact joins as null, as in contacts.get.
		const contactMap = new Map(contacts.filter(isLiveContact).map((c) => [c._id, c]));

		const sendsWithContacts = paginatedSends.map((send) => {
			const contactData = send.contactId ? contactMap.get(send.contactId) : null;
			return {
				...send,
				contact: contactData
					? {
							_id: contactData._id,
							email: contactData.email,
							firstName: contactData.firstName,
							lastName: contactData.lastName,
						}
					: null,
			};
		});

		return {
			sends: sendsWithContacts,
			hasMore,
		};
	},
});

// Get a single send by ID. Every role reads template, automation and test
// sends. An agent_reply or team_reply send is a Team inbox reply (its subject
// and recipient come from the inbox thread), so it follows the shared-inbox
// reader rule and reads as absent to everyone else.
export const get = transactionalQuery({
	args: { id: v.id('transactionalSends') },
	handler: async (ctx, args, session) => {
		const send = await ctx.db.get(args.id);
		// Honor the soft-delete contract: an erased (GDPR) send reads as absent.
		if (!send || send.deletedAt !== undefined) return null;
		const isInboxReply = send.kind === 'agent_reply' || send.kind === 'team_reply';
		if (isInboxReply && !isSharedInboxReader(session)) return null;

		// `transactionalEmailId` is optional: automation / agent_reply sends
		// live in this table without a transactional template reference.
		const transactionalEmail = send.transactionalEmailId
			? await ctx.db.get(send.transactionalEmailId)
			: null;
		let contact = null;
		if (send.contactId) {
			const contactData = await ctx.db.get(send.contactId);
			// A soft-deleted contact joins as null, as in contacts.get.
			if (isLiveContact(contactData)) {
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
// all-members: one send count per template for the template list.
export const getCounts = transactionalQuery({
	args: {},
	handler: async (ctx) => {
		const transactionalEmails = await ctx.db.query('transactionalEmails').collect(); // bounded: per-deployment template set is small

		const counts: Record<string, number> = {};
		for (const email of transactionalEmails) {
			counts[email._id] = email.sendCount ?? 0;
		}
		return counts;
	},
});
