/**
 * Email co-editing cleanup (docs/adr/0071-email-coediting.md): the sweep of
 * expired presence, old notices and idle sessions, and the cascade that runs
 * when an email is deleted.
 */

import type { MutationCtx } from '../_generated/server';
import type { CoeditTarget } from '../lib/validators/coediting';
import { COEDIT_PRESENCE_WINDOW_MS, activePresence, rowTarget } from './target';

/** A session nobody has had open for this long is dropped, unsaved changes and all. */
export const COEDIT_SESSION_IDLE_MS = 60 * 60 * 1000;

/** Notices are only useful while the tab is open. */
export const COEDIT_NOTICE_TTL_MS = 60 * 60 * 1000;

const SWEEP_BATCH = 50;
const SESSION_SWEEP_BATCH = 10;

/**
 * Delete presence rows past the active window (a tab closed without a clean
 * leave), notices past their lifetime, and sessions idle for an hour. Bounded
 * per call. Runs from `sessions.open`, so an editor never joins a session that
 * should already have been dropped, without a cron of its own. A session that
 * still has people in it is kept and its idle clock restarted, so a team that
 * has an email open without typing keeps its draft.
 */
export async function sweepStaleCoediting(ctx: MutationCtx, now: number) {
	const presence = await ctx.db
		.query('emailEditorPresence')
		.withIndex('by_heartbeat', (q) => q.lt('heartbeatAt', now - COEDIT_PRESENCE_WINDOW_MS))
		.take(SWEEP_BATCH);
	for (const row of presence) await ctx.db.delete(row._id);

	const notices = await ctx.db
		.query('emailCoeditNotices')
		.withIndex('by_created', (q) => q.lt('createdAt', now - COEDIT_NOTICE_TTL_MS))
		.take(SWEEP_BATCH);
	for (const row of notices) await ctx.db.delete(row._id);

	const idle = await ctx.db
		.query('emailCoeditSessions')
		.withIndex('by_last_activity', (q) => q.lt('lastActivityAt', now - COEDIT_SESSION_IDLE_MS))
		.take(SESSION_SWEEP_BATCH);
	let sessions = 0;
	for (const session of idle) {
		const target = rowTarget(session);
		if (target && (await activePresence(ctx, target, now)).length > 0) {
			await ctx.db.patch(session._id, { lastActivityAt: now });
			continue;
		}
		await ctx.db.delete(session._id);
		sessions += 1;
	}
	return { presence: presence.length, notices: notices.length, sessions };
}

/** Upper bound on presence rows and notices one email can have (team-sized). */
const CASCADE_BATCH = 200;

/**
 * The email was deleted: delete its session, presence and notices with it,
 * in the deleting transaction.
 */
export async function deleteCoeditState(ctx: MutationCtx, target: CoeditTarget): Promise<void> {
	const rows =
		target.type === 'emailTemplate'
			? await Promise.all([
					ctx.db
						.query('emailCoeditSessions')
						.withIndex('by_email_template', (q) => q.eq('emailTemplateId', target.id))
						.take(CASCADE_BATCH),
					ctx.db
						.query('emailEditorPresence')
						.withIndex('by_email_template_heartbeat', (q) => q.eq('emailTemplateId', target.id))
						.take(CASCADE_BATCH),
					ctx.db
						.query('emailCoeditNotices')
						.withIndex('by_email_template', (q) => q.eq('emailTemplateId', target.id))
						.take(CASCADE_BATCH),
				])
			: await Promise.all([
					ctx.db
						.query('emailCoeditSessions')
						.withIndex('by_transactional_email', (q) => q.eq('transactionalEmailId', target.id))
						.take(CASCADE_BATCH),
					ctx.db
						.query('emailEditorPresence')
						.withIndex('by_transactional_email_heartbeat', (q) =>
							q.eq('transactionalEmailId', target.id)
						)
						.take(CASCADE_BATCH),
					ctx.db
						.query('emailCoeditNotices')
						.withIndex('by_transactional_email', (q) => q.eq('transactionalEmailId', target.id))
						.take(CASCADE_BATCH),
				]);
	for (const row of rows.flat()) await ctx.db.delete(row._id);
}
