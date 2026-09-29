/**
 * The one fail-soft lookup of a mailbox's learned writing voice for Postbox AI
 * prompts (suggested replies, selection rewrite, whole-draft revise,
 * draft-on-arrival, the clarification draft).
 *
 * Personalization is opt-in and advisory: a missing or disabled profile, or any
 * error, yields `null` and the prompt falls through to the generic tone.
 * `getGuidanceForMailbox` may also lazily schedule a profile refresh; it never
 * blocks the caller.
 */

import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';

/**
 * Load the voice guidance for `mailboxId`, or `null`.
 *
 * `requireAccess` MUST be set whenever the mailbox id came from the client.
 * The caller's access is then proven first through `mail.mailbox.identity.get`,
 * which returns null for a mailbox the caller cannot read, so a foreign
 * mailboxId can never fold another user's private voice guidance (learned
 * phrasings, example sentences) into their prompt. Leave it off only when the
 * id was derived server-side from a row the caller was already authorized for.
 */
export async function loadVoiceGuidance(
	ctx: Pick<ActionCtx, 'runQuery' | 'runMutation'>,
	opts: { mailboxId: Id<'mailboxes'> | undefined; requireAccess: boolean }
): Promise<string | null> {
	const { mailboxId } = opts;
	if (!mailboxId) return null;
	try {
		if (opts.requireAccess) {
			const mailbox = await ctx.runQuery(api.mail.mailbox.identity.get, { mailboxId });
			if (!mailbox) return null;
		}
		const res = await ctx.runMutation(internal.mail.ai.voiceProfile.getGuidanceForMailbox, {
			mailboxId,
		});
		return res.guidance;
	} catch {
		return null;
	}
}

/** The prompt section for loaded guidance: '' when there is none. */
export function formatVoiceSection(guidance: string | null | undefined): string {
	return guidance ? `\n\n${guidance}` : '';
}
