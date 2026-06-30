/**
 * `context_retrieval` Agent step (module) — see ADR-0014.
 *
 * Builds the briefing string the LLM steps consume: contact profile,
 * recent activities, thread history, current message. Token-budgeted
 * with three compaction tiers (normal / compacted / emergency).
 */

import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { AgentStepModule } from '../types';

/**
 * Token budget for context (approximate, based on ~4 chars per token).
 */
const CONTEXT_BUDGET = {
	maxTokens: 4000,
	recentMessagesCount: 5,
	knowledgeEntryLimit: 10,
	fileLimit: 3,
	charsPerToken: 4,
};

function estimateTokens(text: string): number {
	return Math.ceil(text.length / CONTEXT_BUDGET.charsPerToken);
}

export interface ContextRetrievalInput {
	inboundMessageId: Id<'inboundMessages'>;
}

export interface ContextRetrievalOutput {
	context: string;
	tier: 'normal' | 'compacted' | 'emergency';
	estimatedTokens: number;
}

export const contextRetrievalStep: AgentStepModule<
	'context_retrieval',
	ContextRetrievalInput,
	ContextRetrievalOutput
> = {
	kind: 'context_retrieval',

	async execute(ctx, input) {
		const message = await ctx.runQuery(
			internal.agent.agentPipeline.getMessage,
			{ inboundMessageId: input.inboundMessageId },
		);
		if (!message) throw new Error('Inbound message not found');

		const contextParts: string[] = [];

		// 1. Contact profile
		if (message.contactId) {
			const contact = await ctx.runQuery(
				internal.agent.agentPipeline.getContact,
				{ contactId: message.contactId },
			);
			if (contact) {
				contextParts.push(
					`[CONTACT] ${contact.email}` +
						(contact.firstName
							? ` | Name: ${contact.firstName}${
									contact.lastName ? ' ' + contact.lastName : ''
								}`
							: '') +
						(contact.language ? ` | Language: ${contact.language}` : '') +
						(contact.timezone ? ` | Timezone: ${contact.timezone}` : ''),
				);
			}

			// 2. Recent contact activities
			const activities = await ctx.runQuery(
				internal.agent.agentPipeline.getRecentActivities,
				{ contactId: message.contactId, limit: 5 },
			);
			if (activities.length > 0) {
				contextParts.push(
					'[RECENT ACTIVITY]\n' +
						activities
							.map(
								(a) =>
									`- ${a.activityType} at ${new Date(a.occurredAt).toISOString()}`,
							)
							.join('\n'),
				);
			}
		}

		// 3. Thread history (previous messages in this conversation)
		if (message.threadId) {
			const threadMessages = await ctx.runQuery(
				internal.agent.agentPipeline.getThreadMessages,
				{
					threadId: message.threadId,
					limit: CONTEXT_BUDGET.recentMessagesCount,
					excludeMessageId: input.inboundMessageId,
				},
			);
			if (threadMessages.length > 0) {
				contextParts.push(
					'[CONVERSATION HISTORY]\n' +
						threadMessages
							.map(
								(m) =>
									`From: ${m.from}\nDate: ${new Date(m.receivedAt).toISOString()}\nSubject: ${m.subject}\n${m.textBody ?? '(no text body)'}\n---`,
							)
							.join('\n'),
				);
			}
		}

		// Query text for semantic retrieval: the inbound subject + body.
		const queryText = `${message.subject ?? ''}\n${message.textBody ?? message.htmlBody ?? ''}`.slice(
			0,
			2000,
		);

		if (queryText.trim().length > 10) {
			// Contact-scope retrieval so a draft for this contact can only draw on
			// org-general knowledge/files OR knowledge/files linked to this same
			// contact — never another contact's confidential data. When the inbound
			// has no resolved contact we fail closed to org-general only.
			const scopeToContact: Id<'contacts'> | 'org-general-only' =
				message.contactId ?? 'org-general-only';

			// 3b. Knowledge graph — semantically relevant typed entries (the
			// "intelligence flows back up" path: prior facts/decisions/etc.).
			// Graph-augmented (seed-then-expand) when `ai.knowledge.graphRetrieval`
			// is on — the KILL SWITCH: off ⇒ flat retrieval, no _via/_stale/_caveat.
			// scopeToContact stays contact-or-org-general (NEVER org-wide on this
			// drafting path); the per-hop gate in graphTraversal.ts re-enforces it.
			const graphRetrieval = await ctx.runQuery(
				internal.knowledge.graphTraversal.isGraphRetrievalEnabled,
				{},
			);
			const knowledge = await ctx.runAction(
				internal.knowledge.retrieval.semanticSearch,
				{
					queryText,
					limit: CONTEXT_BUDGET.knowledgeEntryLimit,
					scopeToContact,
					expandGraph: graphRetrieval,
				},
			);
			if (knowledge.length > 0) {
				contextParts.push(
					'[KNOWLEDGE]\n' +
						knowledge
							.map((k) => {
								// A superseded fact is kept for context but flagged so the
								// model won't ground a reply on it; a contradicts endpoint
								// is framed as a caveat.
								const prefix = k._stale
									? '[SUPERSEDED — do not rely on this] '
									: k._caveat
										? 'CAVEAT: '
										: '';
								return `- ${prefix}(${k.entryType}, confidence ${k.confidence.toFixed(2)}) ${k.title}: ${k.content}`;
							})
							.join('\n'),
				);

				// [KNOWLEDGE RELATIONSHIPS] — the typed edges among the entries above,
				// one line per edge (outgoing direction), e.g. "A" SUPERSEDES "B".
				// Sits before [CURRENT MESSAGE]; titles are untrusted retrieved data.
				const relationLines: string[] = [];
				for (const k of knowledge) {
					for (const via of k._via ?? []) {
						if (via.direction !== 'outgoing') continue;
						const verb = via.relation.toUpperCase().replace(/_/g, ' ');
						relationLines.push(`- "${k.title}" ${verb} "${via.otherTitle}"`);
					}
				}
				if (relationLines.length > 0) {
					contextParts.push('[KNOWLEDGE RELATIONSHIPS]\n' + relationLines.join('\n'));
				}
			}

			// 3c. Relevant source documents (the actual contract/invoice/etc.,
			// not a summary of it).
			const files = await ctx.runAction(
				internal.semanticFileProcessing.semanticSearch,
				{ queryText, limit: CONTEXT_BUDGET.fileLimit, scopeToContact },
			);
			if (files.length > 0) {
				contextParts.push(
					'[RELEVANT FILES]\n' +
						files
							.map(
								(f) =>
									`- ${f.filename}${f.title ? ` ("${f.title}")` : ''}${f.summary ? `: ${f.summary}` : ''}`,
							)
							.join('\n'),
				);
			}
		}

		// 4. Current message
		contextParts.push(
			'[CURRENT MESSAGE]\n' +
				`From: ${message.from}\n` +
				`To: ${message.to}\n` +
				`Subject: ${message.subject}\n` +
				`Date: ${new Date(message.receivedAt).toISOString()}\n` +
				`Body:\n${message.textBody ?? message.htmlBody ?? '(no body)'}`,
		);

		// ── Compile and compact ──
		const fullContext = contextParts.join('\n\n');
		const estimatedTokens = estimateTokens(fullContext);

		let tier: ContextRetrievalOutput['tier'];
		let finalContext: string;

		if (estimatedTokens <= CONTEXT_BUDGET.maxTokens) {
			tier = 'normal';
			finalContext = fullContext;
		} else if (estimatedTokens <= CONTEXT_BUDGET.maxTokens * 3) {
			tier = 'compacted';
			const maxChars = CONTEXT_BUDGET.maxTokens * CONTEXT_BUDGET.charsPerToken;
			finalContext = fullContext.slice(-maxChars);
		} else {
			tier = 'emergency';
			const currentMessage = contextParts[contextParts.length - 1];
			const contactInfo = contextParts[0]?.startsWith('[CONTACT]')
				? contextParts[0]
				: '';
			finalContext = `${contactInfo}\n\n${currentMessage}`;
		}

		// Record the contextTier on the inboundMessage (in-state side
		// effect — see ADR-0010 for why `contextTier` has its own helper
		// rather than rolling into a transition).
		await ctx.runMutation(
			internal.inbox.processingLifecycle.recordContextTier,
			{ inboundMessageId: input.inboundMessageId, contextTier: tier },
		);

		return {
			output: { context: finalContext, tier, estimatedTokens },
		};
	},

	route(output, _input, runCtx) {
		// In-state — context_retrieval runs while processingStatus is
		// already `classifying`. Hand off to the classify step.
		return {
			kind: 'in_state',
			nextStep: {
				kind: 'classify',
				input: {
					inboundMessageId: runCtx.inboundMessageId,
					context: output.context,
				},
			},
		};
	},
};
