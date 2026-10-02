import { v, type Infer } from 'convex/values';

/**
 * Co-editing validators (docs/adr/0071-email-coediting.md): which email a
 * live editing session belongs to, and the block-granular operations editors
 * send to it. Shared by `schema/emailCoediting.ts` and `emailCoediting/*`.
 */

/** The two editors that co-edit: email templates (campaign content) and transactional emails. */
export const coeditTargetTypeValidator = v.union(
	v.literal('emailTemplate'),
	v.literal('transactionalEmail')
);

/** The email a session, presence row or notice belongs to. */
export const coeditTargetValidator = v.union(
	v.object({ type: v.literal('emailTemplate'), id: v.id('emailTemplates') }),
	v.object({ type: v.literal('transactionalEmail'), id: v.id('transactionalEmails') })
);

export type CoeditTarget = Infer<typeof coeditTargetValidator>;

/**
 * The polymorphic reference stored on every co-editing row: the discriminator
 * plus exactly one id, matching it (see "Polymorphic foreign keys").
 */
export const coeditTargetFields = {
	targetType: coeditTargetTypeValidator,
	emailTemplateId: v.optional(v.id('emailTemplates')),
	transactionalEmailId: v.optional(v.id('transactionalEmails')),
};

/**
 * The editor fields shared next to the blocks. Which of them a target has is
 * decided by its type (`emailCoediting/target.ts`).
 */
export const coeditFieldValidator = v.union(
	v.literal('name'),
	v.literal('subject'),
	v.literal('plainTextOverride'),
	v.literal('attachments'),
	v.literal('showUnsubscribe')
);

export type CoeditField = Infer<typeof coeditFieldValidator>;

const afterIdValidator = v.union(v.string(), v.null());

/**
 * One operation as an editor sends it. Blocks and field values travel as JSON
 * text and are parsed and checked by the server. `baseVersion` is the session
 * version the sender last saw this block or field at; a newer write by someone
 * else means the sender is replacing a change it never saw.
 */
export const coeditOpValidator = v.union(
	v.object({
		kind: v.literal('insert'),
		block: v.string(),
		afterId: afterIdValidator,
		baseVersion: v.number(),
	}),
	v.object({ kind: v.literal('delete'), blockId: v.string(), baseVersion: v.number() }),
	v.object({ kind: v.literal('move'), blockId: v.string(), afterId: afterIdValidator }),
	v.object({
		kind: v.literal('update'),
		block: v.string(),
		afterId: afterIdValidator,
		baseVersion: v.number(),
	}),
	v.object({
		kind: v.literal('field'),
		field: coeditFieldValidator,
		value: v.string(),
		baseVersion: v.number(),
	})
);

export type CoeditOpArg = Infer<typeof coeditOpValidator>;

/** Who last wrote one block or field of a session, and at which version. */
export const coeditWriteValidator = v.object({
	key: v.string(),
	version: v.number(),
	clientId: v.string(),
});
