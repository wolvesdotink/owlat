/**
 * Email co-editing sessions (docs/adr/0071-email-coediting.md).
 *
 * While people edit an email, its editor state lives in one shared session
 * row instead of each tab's memory: editors send block-granular operations
 * (`applyOps`), every editor follows the row live (`get`), and the Save
 * button writes the session to the email (`emailTemplates.emails.update` /
 * `transactional.emails.update` with `coeditVersion`, see `save.ts`).
 *
 * `open` creates the session from the email row, and brings a session with
 * nothing unsaved up to date when the row changed elsewhere (the translations
 * page, an API write). `reset` throws away the shared unsaved changes. Every
 * `open` first runs the bounded sweep (`sweep.ts`), which drops a session an
 * hour after the last editor left.
 *
 * Writes need `templates:manage`, like saving the email. No audit-log entry:
 * the session is a draft; the save that persists it is audited.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { throwConflict, throwForbidden, throwInvalidInput } from '../_utils/errors';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { currentContentRevision } from '../lib/contentRevision';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import {
	coeditOpValidator,
	coeditTargetValidator,
	type CoeditTarget,
} from '../lib/validators/coediting';
import { captureTemplateVersion } from '../emailTemplates/versions';
import { dropIfIdle, sweepStaleCoediting } from './sweep';
import {
	COEDIT_FIELDS_VERSION,
	findSession,
	loadTarget,
	rootBlocksOf,
	rowFields,
	targetFields,
	TARGET_FIELDS,
	type CoeditRow,
	type CoeditSession,
	type StoredRootBlock,
} from './target';
import {
	MAX_COEDIT_ID_LENGTH,
	applySessionOps,
	parseOps,
	type ReplacedWrite,
	type SessionState,
} from './sessionOps';

/**
 * Upper bound on a session's block and field JSON together, below Convex's
 * 1 MiB document limit with room for the writer list.
 */
export const MAX_COEDIT_CONTENT_LENGTH = 800_000;

const EDIT_DENIED = 'Only owners and admins can edit emails';

/** The session columns that mirror the email row as it is now. */
function seedFrom(target: CoeditTarget, row: CoeditRow, version: number, now: number) {
	return {
		version,
		savedVersion: version,
		baseRevision: currentContentRevision(row),
		content: JSON.stringify(rootBlocksOf(row.content)),
		contentBlockVersion: row.contentBlockVersion,
		fields: JSON.stringify(rowFields(target, row)),
		fieldsVersion: COEDIT_FIELDS_VERSION,
		writes: [],
		lastActivityAt: now,
	};
}

function sessionState(session: CoeditSession): SessionState {
	return {
		doc: {
			blocks: JSON.parse(session.content) as StoredRootBlock[],
			fields: JSON.parse(session.fields) as Record<string, unknown>,
		},
		writes: session.writes,
		version: session.version,
	};
}

/**
 * The live session of an email, or null while nobody edits it. Every editor
 * subscribes to this; `content` and `fields` are JSON text.
 */
// all-members: the session is the email body every org member can already read via its get
export const get = authedQuery({
	args: { target: coeditTargetValidator },
	handler: async (ctx, args) => {
		if (args.target.type === 'transactionalEmail') {
			await assertFeatureEnabled(ctx, 'transactional');
		}
		const session = await findSession(ctx, args.target);
		if (!session) return null;
		return {
			sessionId: session._id,
			version: session.version,
			savedVersion: session.savedVersion,
			baseRevision: session.baseRevision,
			content: session.content,
			fields: session.fields,
		};
	},
});

/**
 * Join the live session of an email, creating it from the email row. A
 * session with nothing unsaved follows a row that changed elsewhere; one with
 * unsaved changes is left alone (its next save asks what to keep).
 */
export const open = authedMutation({
	args: { target: coeditTargetValidator },
	handler: async (ctx, args, session) => {
		requirePermission(hasPermission(session.role, 'templates:manage'), EDIT_DENIED);
		const row = await loadTarget(ctx, args.target);
		const now = Date.now();
		await sweepStaleCoediting(ctx, now);
		let live = await findSession(ctx, args.target);
		// The sweep is bounded, so it may not have reached this email's own
		// idle session yet; drop it here, as the sweep would have.
		if (live && (await dropIfIdle(ctx, live, now))) live = null;
		if (!live) {
			const sessionId = await ctx.db.insert('emailCoeditSessions', {
				...targetFields(args.target),
				...seedFrom(args.target, row, 1, now),
				createdAt: now,
			});
			return { sessionId };
		}
		const isClean = live.version === live.savedVersion;
		if (isClean && live.baseRevision !== currentContentRevision(row)) {
			await ctx.db.patch(live._id, seedFrom(args.target, row, live.version + 1, now));
		}
		return { sessionId: live._id };
	},
});

/**
 * Throw away the shared unsaved changes: the session goes back to the email
 * as saved. Edits other editors had not sent yet are sent on top of it.
 */
export const reset = authedMutation({
	args: { target: coeditTargetValidator },
	handler: async (ctx, args, session) => {
		requirePermission(hasPermission(session.role, 'templates:manage'), EDIT_DENIED);
		const row = await loadTarget(ctx, args.target);
		const live = await findSession(ctx, args.target);
		if (!live) return { version: null };
		const version = live.version + 1;
		await ctx.db.patch(live._id, seedFrom(args.target, row, version, Date.now()));
		return { version };
	},
});

/**
 * Tell the editors whose changes a batch replaced, and for a template keep
 * the draft as it was before the batch in version history, so the replaced
 * change can be restored from there too. Editors that already left get no
 * notice; the version history still has their change.
 */
async function recordReplaced(
	ctx: MutationCtx,
	target: CoeditTarget,
	before: SessionState,
	replaced: readonly ReplacedWrite[],
	replacedBy: string,
	now: number
): Promise<void> {
	let loserUserId: string | null = null;
	for (const lost of replaced) {
		const presence = await ctx.db
			.query('emailEditorPresence')
			.withIndex('by_client', (q) => q.eq('clientId', lost.clientId))
			.first();
		if (!presence) continue;
		loserUserId ??= presence.userId;
		await ctx.db.insert('emailCoeditNotices', {
			...targetFields(target),
			clientId: lost.clientId,
			replacedBy,
			key: lost.key,
			replacedValue: JSON.stringify(lost.value),
			replacedValueVersion: COEDIT_FIELDS_VERSION,
			createdAt: now,
		});
	}
	if (target.type !== 'emailTemplate') return;
	const template = await ctx.db.get(target.id);
	if (!template) return;
	const fields = before.doc.fields;
	await captureTemplateVersion(ctx, {
		template: {
			...template,
			content: JSON.stringify(before.doc.blocks),
			name: typeof fields['name'] === 'string' ? fields['name'] : template.name,
			subject: typeof fields['subject'] === 'string' ? fields['subject'] : template.subject,
		},
		trigger: 'conflict',
		userId: loserUserId ?? 'system:coedit',
	});
}

/**
 * Apply a batch of operations from one editor tab (`clientId`). Returns the
 * session version the batch produced. A session that ended (swept after
 * everyone left) is refused with `coedit_session_gone`; the editor reopens it
 * and sends its changes again.
 */
export const applyOps = authedMutation({
	args: {
		target: coeditTargetValidator,
		clientId: v.string(),
		ops: v.array(coeditOpValidator),
	},
	handler: async (ctx, args, session) => {
		requirePermission(hasPermission(session.role, 'templates:manage'), EDIT_DENIED);
		if (args.clientId.length === 0 || args.clientId.length > MAX_COEDIT_ID_LENGTH) {
			throwInvalidInput('The editor id is not valid.');
		}
		// Writes are attributed to the tab, so a tab id another member's
		// presence names is not the caller's to write under (`presence.ts`).
		const tab = await ctx.db
			.query('emailEditorPresence')
			.withIndex('by_client', (q) => q.eq('clientId', args.clientId))
			.first();
		if (tab && tab.userId !== session.userId) {
			throwForbidden('This editor belongs to someone else.');
		}
		await loadTarget(ctx, args.target);
		const live = await findSession(ctx, args.target);
		if (!live) {
			throwConflict('Live editing of this email ended. Reopen it to keep editing.', {
				reason: 'coedit_session_gone',
			});
		}
		const parsed = parseOps(args.ops, TARGET_FIELDS[args.target.type]);
		if (parsed.length === 0) return { version: live.version };

		const before = sessionState(live);
		const { state, replaced } = applySessionOps(before, parsed, args.clientId);
		const content = JSON.stringify(state.doc.blocks);
		const fields = JSON.stringify(state.doc.fields);
		if (content.length + fields.length > MAX_COEDIT_CONTENT_LENGTH) {
			throwInvalidInput('This email is too large to edit further. Remove some content first.');
		}
		const now = Date.now();
		await ctx.db.patch(live._id, {
			version: state.version,
			content,
			fields,
			writes: [...state.writes],
			lastActivityAt: now,
		});
		if (replaced.length > 0) {
			await recordReplaced(ctx, args.target, before, replaced, session.userId, now);
		}
		return { version: state.version };
	},
});
