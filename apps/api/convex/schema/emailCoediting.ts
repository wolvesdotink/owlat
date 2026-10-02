import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { coeditTargetFields, coeditWriteValidator } from '../lib/validators/coediting';

/**
 * Email co-editing tables (docs/adr/0071-email-coediting.md): the shared live
 * draft two or more people edit at once, who has the email open, and the
 * notices that tell someone their change to a block was replaced.
 *
 * All three are short-lived. A session exists while somebody edits the email
 * and is swept an hour after the last person left; presence lives for its
 * heartbeat window; notices for an hour. Each row names its email through
 * `targetType` plus exactly one of the two id fields. Deleting the email
 * deletes its rows (`emailCoediting/sweep.ts:deleteCoeditState`).
 *
 * Spread into `defineSchema()` from schema.ts via `...emailCoeditingTables`.
 */
export const emailCoeditingTables = {
	// The shared draft of one email while it is being edited. Editors send
	// block-granular operations (`emailCoediting/sessions.ts:applyOps`), each
	// accepted batch advances `version`, and every editor follows the row live.
	// The Save button writes this draft to the email row
	// (`emailTemplates.emails.update` / `transactional.emails.update` with
	// `coeditVersion`), which sets `savedVersion = version` and `baseRevision`
	// to the revision that save stored. Unsaved = version > savedVersion.
	emailCoeditSessions: defineTable({
		...coeditTargetFields,
		version: v.number(),
		savedVersion: v.number(),
		// The email row's `contentRevision` this draft was seeded from or last
		// saved to. A clean session whose row moved on is reseeded from it.
		baseRevision: v.number(),
		// The root blocks, `EditorBlock[]` JSON with unique root ids.
		content: v.string(),
		// Schema version for `content` (EditorBlock[]), copied from the row.
		contentBlockVersion: v.optional(v.number()),
		// The shared editor fields (name, subject, ...), a JSON object.
		fields: v.string(),
		// Shape version of `fields`; bump COEDIT_FIELDS_VERSION when it changes.
		fieldsVersion: v.number(),
		// Last writer per block and field, for last-writer-wins notices.
		writes: v.array(coeditWriteValidator),
		lastActivityAt: v.number(),
		createdAt: v.number(),
	})
		.index('by_email_template', ['emailTemplateId'])
		.index('by_transactional_email', ['transactionalEmailId'])
		.index('by_last_activity', ['lastActivityAt']),

	// Who has an email open in the editor: one row per open editor (tab),
	// identified by a random `clientId`. Carries the selected root block (the
	// coloured outline others see) and the edit lease on a block (others cannot
	// edit it while `leaseExpiresAt` is in the future). Heartbeats keep it alive;
	// the sweep deletes rows past the active window. Never audited.
	emailEditorPresence: defineTable({
		...coeditTargetFields,
		userId: v.string(), // BetterAuth user ID
		clientId: v.string(),
		heartbeatAt: v.number(),
		selectedBlockId: v.optional(v.string()),
		leaseBlockId: v.optional(v.string()),
		leaseExpiresAt: v.optional(v.number()),
	})
		.index('by_client', ['clientId'])
		.index('by_user', ['userId'])
		.index('by_heartbeat', ['heartbeatAt'])
		.index('by_email_template_heartbeat', ['emailTemplateId', 'heartbeatAt'])
		.index('by_transactional_email_heartbeat', ['transactionalEmailId', 'heartbeatAt']),

	// "Your change to this block was replaced": written when an operation
	// overwrites a block or field another editor wrote after the sender last saw
	// it (last writer wins). Addressed to the editor tab whose change was lost,
	// carrying that change so the tab can put it back.
	emailCoeditNotices: defineTable({
		...coeditTargetFields,
		clientId: v.string(),
		// BetterAuth user ID of the person whose write replaced the change.
		replacedBy: v.string(),
		// `block:<id>` or `field:<name>` (see @owlat/shared/coeditOps).
		key: v.string(),
		// The replaced block (`EditorBlock` JSON) or field value (JSON).
		replacedValue: v.string(),
		// Shape version of `replacedValue`; follows COEDIT_FIELDS_VERSION.
		replacedValueVersion: v.number(),
		createdAt: v.number(),
	})
		.index('by_client', ['clientId', 'createdAt'])
		.index('by_replaced_by', ['replacedBy'])
		.index('by_created', ['createdAt'])
		.index('by_email_template', ['emailTemplateId'])
		.index('by_transactional_email', ['transactionalEmailId']),
};
