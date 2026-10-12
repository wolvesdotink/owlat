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
import type {
	AnswerAskTarget,
	AnswerDraftContext,
	MailboxAttachmentScope,
} from '../../lib/validators/answerAsk';
import { assembleInboundBriefing } from '../../agent/steps/context_retrieval';
import { guardAllowsInboundMessage } from '../../agent/steps/security_scan/guard';
import { throwInvalidState } from '../../_utils/errors';
import type { EagernessMode } from '../../inbox/askEagerness';
import type { BundleSubject } from '../../decision/bundleRunner';
import { formatVoiceSection, loadVoiceGuidance } from './voiceGuidance';

/**
 * Answer mode's refusal for a team message the injection guard held back
 * (quarantine, malware, a malicious URL, a flagged injection). The web reads
 * `data.code`.
 */
const GUARD_REFUSAL_CODE = 'MESSAGE_HELD_BY_GUARD';
const GUARD_REFUSAL_MESSAGE =
	'This message was held back as unsafe, so AI drafting is not available for it.';

/** Everything the gap check and the drafter need about a target. */
interface AnswerContext extends AnswerDraftContext {
	triggerText: string;
	subject: string;
	counterpartAddress?: string | undefined;
	contactId?: Id<'contacts'> | undefined;
	language?: string | undefined;
	mailboxId?: Id<'mailboxes'> | undefined;
	/** Where the automatic file search may look in the mailbox (Postbox only). */
	mailboxScope?: MailboxAttachmentScope | undefined;
	eagerness?: EagernessMode | undefined;
	/** The message answered, for the necessity judgment (D5); absent for a fresh draft. */
	decisionSubject?: BundleSubject | undefined;
}

const PERSONAL_TONE =
	'\n\nTone: match the owner’s natural, personal style — warm and direct, not corporate.';

/** Open commitments to the contact, one line each, or '' (fail-soft). */
async function commitmentSection(ctx: ActionCtx, contactId: Id<'contacts'>): Promise<string> {
	try {
		const open = await ctx.runQuery(internal.knowledge.graph.getOpenCommitmentsByContact, {
			contactId,
			limit: 5,
			// A personal-mail draft: knowledge learned from the Team Inbox stays
			// with Team Inbox readers and out of personal mail (inbox/access.ts).
			includeInboxDerived: false,
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
			mailboxScope: loaded.mailboxScope,
			eagerness: loaded.eagerness,
			...(loaded.triggerMessageId
				? {
						decisionSubject: {
							kind: 'mail_message' as const,
							mailMessageId: loaded.triggerMessageId,
							mailboxId: loaded.mailboxId,
						},
					}
				: {}),
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
		...(target.inboundMessageId ? { inboundMessageId: target.inboundMessageId } : {}),
	});
	// D13 / #1339: the message this reply answers reaches the gap check and the
	// drafter only after the injection guard passes it (a skipped guard runs
	// now). A message the guard rejected is refused outright: no briefing, and
	// no fallback to its raw text.
	if (!(await guardAllowsInboundMessage(ctx, loaded.inboundMessageId))) {
		throwInvalidState(GUARD_REFUSAL_MESSAGE, { code: GUARD_REFUSAL_CODE });
	}
	// The pipeline's own briefing (contact, commitments, knowledge, files,
	// history, the hidden-stripped current message), without re-recording it.
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
		decisionSubject: { kind: 'inbound_message', inboundMessageId: loaded.inboundMessageId },
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

/**
 * Context past this size is rebuilt by `answer` rather than stored. A team
 * briefing is a few thousand tokens and a Postbox transcript is capped at 14k
 * characters, so this only bounds the row the sweeps and erasure read in bulk.
 */
const MAX_STORED_CONTEXT_CHARS = 60_000;

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
