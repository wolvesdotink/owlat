import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { mailJobStatusValidator } from '../lib/literalValidators';

/**
 * Server-side rules: filters and their run jobs, aliases, forwarding
 * and vacation responders.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
export const mailRulesTables = {
	mailFilters: defineTable({
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		isEnabled: v.boolean(),
		priority: v.number(), // lower number runs first
		conditions: v.array(
			v.object({
				field: v.union(
					v.literal('from'),
					v.literal('to'),
					v.literal('cc'),
					v.literal('subject'),
					v.literal('body'),
					v.literal('header'),
					v.literal('size'),
					v.literal('hasAttachment')
				),
				headerName: v.optional(v.string()),
				op: v.union(
					v.literal('contains'),
					v.literal('notContains'),
					v.literal('equals'),
					v.literal('matches'),
					v.literal('greaterThan'),
					v.literal('lessThan'),
					v.literal('isTrue')
				),
				value: v.optional(v.string()),
				valueNumber: v.optional(v.number()),
			})
		),
		actions: v.array(
			v.object({
				type: v.union(
					v.literal('moveToFolder'),
					v.literal('addLabel'),
					v.literal('markRead'),
					v.literal('markFlagged'),
					v.literal('forward'),
					v.literal('delete'),
					// Split inbox (idea 24): file the message into a NAMED SECTION of
					// the inbox instead of moving it out of sight. The message stays in
					// Inbox — `pinnedSection` on the row is the only thing that changes —
					// so a section is a reading arrangement, never a hiding place.
					v.literal('pinToSection'),
					v.literal('discard')
				),
				folderId: v.optional(v.id('mailFolders')),
				labelId: v.optional(v.id('mailLabels')),
				forwardTo: v.optional(v.string()),
				// For `pinToSection` — the section's display name, which IS its
				// identity (there is no section table; the set of sections is derived
				// from the enabled filters that name one).
				sectionName: v.optional(v.string()),
			})
		),
		// ONE grouping level (idea 39): `all` AND-s the conditions, `any` OR-s
		// them. Absent = `all`, which is exactly the pre-toggle behavior, so no
		// existing filter changes meaning. There is deliberately no nesting —
		// mixed AND/OR trees are a second grammar, and "define two filters" has
		// always been the escape hatch.
		matchType: v.optional(v.union(v.literal('all'), v.literal('any'))),
		stopProcessing: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_mailbox', ['mailboxId'])
		.index('by_mailbox_and_priority', ['mailboxId', 'priority']),

	// Resumable "run this filter on existing mail" job.
	//
	// A new filter has never seen the backlog that motivated it. This walks
	// `mailMessages` by cursor, re-evaluates ONE filter's conditions per page and
	// applies its SAFE actions (label / move / mark read / mark flagged) — never
	// `forward`, `delete` or `discard`, which are irreversible and were authored
	// for the inbound moment, not for a retroactive sweep over years of mail.
	//
	// One row per filter (`by_filter`), so re-running resumes or restarts rather
	// than forking a second walk; the row is the progress readout and the cancel
	// switch. Same shape as `mailAttachmentBackfillJobs`.

	mailFilterRunJobs: defineTable({
		mailboxId: v.id('mailboxes'),
		filterId: v.id('mailFilters'),
		status: mailJobStatusValidator,
		cursor: v.optional(v.string()),
		scannedCount: v.number(),
		matchedCount: v.number(),
		startedAt: v.number(),
		updatedAt: v.number(),
		finishedAt: v.optional(v.number()),
		errorMessage: v.optional(v.string()),
	})
		.index('by_filter', ['filterId'])
		.index('by_mailbox', ['mailboxId']),

	// Aliases — alternate addresses (e.g. marcel+sales@hl.camp) that
	// deliver into the same mailbox. Cheap rewrites at the MX layer.

	mailAliases: defineTable({
		alias: v.string(), // canonical lowercase
		targetMailboxId: v.id('mailboxes'),
		organizationId: v.string(),
		createdAt: v.number(),
	})
		.index('by_alias', ['alias'])
		.index('by_target', ['targetMailboxId']),

	// External-forwarding rule. On delivery the message is forwarded to
	// `forwardTo`; if `keepLocalCopy=false`, the local insert is skipped.

	mailForwarding: defineTable({
		mailboxId: v.id('mailboxes'),
		forwardTo: v.string(),
		keepLocalCopy: v.boolean(),
		isEnabled: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_mailbox', ['mailboxId']),

	// RFC 3834-compliant vacation auto-responder.

	mailVacationResponders: defineTable({
		mailboxId: v.id('mailboxes'),
		isEnabled: v.boolean(),
		subject: v.string(),
		bodyText: v.string(),
		bodyHtml: v.optional(v.string()),
		startAt: v.optional(v.number()),
		endAt: v.optional(v.number()),
		replyIntervalDays: v.number(), // anti-loop: max once-per-N-days per sender
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_mailbox', ['mailboxId']),

	// Per-(mailbox, sender) record so the responder doesn't reply to the
	// same person more than once within `replyIntervalDays`.

	mailVacationLog: defineTable({
		mailboxId: v.id('mailboxes'),
		senderEmail: v.string(),
		repliedAt: v.number(),
	})
		.index('by_mailbox_and_sender', ['mailboxId', 'senderEmail'])
		.index('by_replied_at', ['repliedAt']),

	// Personal address book — distinct from CRM `contacts` (which is
	// org-shared). Auto-populated as the user composes / replies, and
	// surfaceable in the To/Cc/Bcc autocomplete.
};
