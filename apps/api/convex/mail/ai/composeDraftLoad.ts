'use node';

/**
 * Loading what Answer mode "Draft with AI" (mail/ai/composeDraft.ts) needs
 * about a target: the access-checked facts from the V8 loaders
 * (mail/ai/composeDraftContext.ts), plus, for a team thread, the pipeline's own
 * briefing. `start` builds it once and keeps the drafter's part on the session
 * ({@link draftContextOf}), so `answer` drafts from the same context without
 * running the briefing's searches again.
 *
 * `'use node'` because the team briefing (agent/steps/context_retrieval) does.
 */

import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { logError } from '../../lib/runtimeLog';
import type { AnswerAskTarget, AnswerDraftContext } from '../../lib/validators/answerAsk';
import { assembleInboundBriefing } from '../../agent/steps/context_retrieval';
import type { EagernessMode } from '../../inbox/askEagerness';
import { formatVoiceSection, loadVoiceGuidance } from './voiceGuidance';

/** Everything the gap check and the drafter need about a target. */
interface AnswerContext extends AnswerDraftContext {
	triggerText: string;
	subject: string;
	counterpartAddress?: string | undefined;
	contactId?: Id<'contacts'> | undefined;
	language?: string | undefined;
	mailboxId?: Id<'mailboxes'> | undefined;
	eagerness?: EagernessMode | undefined;
}

const PERSONAL_TONE =
	'\n\nTone: match the owner’s natural, personal style — warm and direct, not corporate.';

/** Open commitments to the contact, one line each, or '' (fail-soft). */
async function commitmentSection(ctx: ActionCtx, contactId: Id<'contacts'>): Promise<string> {
	try {
		const open = await ctx.runQuery(internal.knowledge.graph.getOpenCommitmentsByContact, {
			contactId,
			limit: 5,
		});
		if (open.length === 0) return '';
		return `[OPEN COMMITMENTS — still owed to this contact]\n${open
			.map((c) => `- ${c.title}: ${c.content.slice(0, 300)}`)
			.join('\n')}\n\n`;
	} catch {
		return '';
	}
}

/** Load (access-checked) and assemble the context for a target. */
export async function loadAnswerContext(
	ctx: ActionCtx,
	target: AnswerAskTarget
): Promise<AnswerContext> {
	if (target.kind === 'mailDraft') {
		const loaded = await ctx.runQuery(internal.mail.ai.composeDraftContext.loadMailDraftContext, {
			draftId: target.draftId,
		});
		const contact = loaded.contact;
		const contactLine = contact
			? `[CONTACT] ${loaded.counterpartAddress ?? ''}${contact.name ? ` | Name: ${contact.name}` : ''}${contact.language ? ` | Language: ${contact.language}` : ''}\n\n`
			: '';
		const commitments = contact ? await commitmentSection(ctx, contact.contactId) : '';
		return {
			context: `${contactLine}${commitments}${loaded.transcript}`,
			triggerText: loaded.triggerText,
			subject: loaded.subject,
			counterpartAddress: loaded.counterpartAddress,
			contactId: contact?.contactId,
			language: contact?.language,
			mailboxId: loaded.mailboxId,
			eagerness: loaded.eagerness,
			audience: `the mailbox owner (${loaded.ownerAddress}), answering the last message in the thread, which the other party sent`,
			styleReference: "the owner's",
			toneInstruction: PERSONAL_TONE,
			signatureInstruction: '',
			// The mailbox was access-checked by the loader above.
			voiceSection: formatVoiceSection(
				await loadVoiceGuidance(ctx, { mailboxId: loaded.mailboxId, requireAccess: false })
			),
		};
	}
	const loaded = await ctx.runQuery(internal.mail.ai.composeDraftContext.loadTeamThreadContext, {
		threadId: target.threadId,
	});
	// The pipeline's own briefing (contact, commitments, knowledge, files,
	// history, the quarantined current message), without re-recording it.
	let context = loaded.triggerText;
	try {
		context = (await assembleInboundBriefing(ctx, loaded.inboundMessageId)).context;
	} catch (err) {
		logError('[composeDraft] team briefing failed, drafting from the message:', err);
	}
	const agentConfig = await ctx.runQuery(internal.agent.agentPipeline.getAgentConfig, {});
	return {
		context,
		triggerText: loaded.triggerText,
		subject: loaded.subject,
		counterpartAddress: loaded.counterpartAddress,
		contactId: loaded.contact?.contactId,
		language: loaded.contact?.language,
		eagerness: loaded.eagerness,
		audience: 'an organization',
		styleReference: "the organization's",
		toneInstruction: agentConfig?.toneDescription
			? `\n\nTone guidance: ${agentConfig.toneDescription}`
			: '\n\nTone: Professional and helpful. Use a friendly but concise style.',
		signatureInstruction: agentConfig?.signatureTemplate
			? `\n\nEnd the email with this signature:\n${agentConfig.signatureTemplate}`
			: '',
		voiceSection: '',
	};
}

/** Context strings past this size are rebuilt by `answer` rather than stored. */
const MAX_STORED_CONTEXT_CHARS = 200_000;

/** The drafter's part of a context, as the session keeps it, or undefined when too large. */
export function draftContextOf(context: AnswerContext): AnswerDraftContext | undefined {
	const stored: AnswerDraftContext = {
		context: context.context,
		audience: context.audience,
		styleReference: context.styleReference,
		toneInstruction: context.toneInstruction,
		signatureInstruction: context.signatureInstruction,
		voiceSection: context.voiceSection,
		...(context.language ? { language: context.language } : {}),
	};
	const size = Object.values(stored).reduce((sum, value) => sum + (value?.length ?? 0), 0);
	return size <= MAX_STORED_CONTEXT_CHARS ? stored : undefined;
}
