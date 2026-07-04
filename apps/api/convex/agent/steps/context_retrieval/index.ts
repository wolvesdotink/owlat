/**
 * `context_retrieval` Agent step (module) — see ADR-0014.
 *
 * Builds the briefing string the LLM steps consume: contact profile,
 * recent activities, thread history, current message. Token-budgeted
 * with three compaction tiers (normal / compacted / emergency).
 */

import { internal } from '../../../_generated/api';
import { stripRemoteImages } from '@owlat/shared/postboxTrackers';
import type { Id } from '../../../_generated/dataModel';
import type { AgentStepModule } from '../types';

/**
 * The message body the LLM steps should read, with remote images / tracking
 * pixels neutralized. The agent reads EVERY inbound automatically, so an
 * HTML-only message (no text/plain part) whose body reached the model verbatim
 * would carry live remote-image URLs — merely assembling them into context is a
 * privacy hazard and a remote-resource-resolution vector. Prefer the plain-text
 * part (no images to strip); otherwise strip remote images from the HTML before
 * it becomes context. Fails soft (see `stripRemoteImages`): a strip error leaves
 * the HTML as-is, matching prior behaviour, and never blocks retrieval.
 */
export function inboundBodyForContext(message: {
	textBody?: string | null;
	htmlBody?: string | null;
}): string | undefined {
	if (message.textBody != null) return message.textBody;
	if (message.htmlBody != null) return stripRemoteImages(message.htmlBody).html;
	return undefined;
}

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

/**
 * Advisory retrieval-coverage / grounding signal. Derived cheaply from
 * what retrieval already computed (NO extra LLM call). Persisted on the
 * inbound message alongside `contextTier`. Changes NO routing today — it
 * exists so the future clarify step and the draft-quality gate have a
 * cheap "is the AI replying blind?" trigger.
 */
export interface ContextCoverage {
	contact: boolean;
	thread: boolean;
	knowledge: boolean;
	files: boolean;
	knowledgeHitCount: number;
	topScore?: number;
	lowCoverage: boolean;
}

/**
 * A single provenance entry: one prior email or knowledge entry that was
 * ACTUALLY assembled into the briefing (so it passed the same contact-scope gate
 * the draft was grounded in). Read-side only — surfaced as the review UI's
 * "Grounded in:" list; `title` is UNTRUSTED retrieved text.
 */
export interface GroundingSource {
	type: 'thread' | 'knowledge';
	id: string;
	title: string;
}

export interface ContextRetrievalOutput {
	context: string;
	tier: 'normal' | 'compacted' | 'emergency';
	estimatedTokens: number;
	coverage: ContextCoverage;
	groundingSources: GroundingSource[];
}

export const contextRetrievalStep: AgentStepModule<
	'context_retrieval',
	ContextRetrievalInput,
	ContextRetrievalOutput
> = {
	kind: 'context_retrieval',

	async execute(ctx, input) {
		const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
			inboundMessageId: input.inboundMessageId,
		});
		if (!message) throw new Error('Inbound message not found');

		const contextParts: string[] = [];

		// Coverage tracking — which briefing legs actually produced content.
		// Cheap booleans/counts derived inline; no extra LLM call.
		let hasContact = false;
		let hasThread = false;
		let hasKnowledge = false;
		let hasFiles = false;
		let knowledgeHitCount = 0;
		let topScore: number | undefined;

		// Provenance — the exact prior emails + knowledge entries fed into the
		// briefing below. Only sources that were actually appended are recorded,
		// so this list can never name a source the draft wasn't grounded in, and
		// (because retrieval is contact-scoped) never a cross-contact source.
		const groundingSources: GroundingSource[] = [];

		// 1. Contact profile
		if (message.contactId) {
			const contact = await ctx.runQuery(internal.agent.agentPipeline.getContact, {
				contactId: message.contactId,
			});
			if (contact) {
				hasContact = true;
				contextParts.push(
					`[CONTACT] ${contact.email}` +
						(contact.firstName
							? ` | Name: ${contact.firstName}${contact.lastName ? ' ' + contact.lastName : ''}`
							: '') +
						(contact.language ? ` | Language: ${contact.language}` : '') +
						(contact.timezone ? ` | Timezone: ${contact.timezone}` : '')
				);
			}

			// 2. Recent contact activities
			const activities = await ctx.runQuery(internal.agent.agentPipeline.getRecentActivities, {
				contactId: message.contactId,
				limit: 5,
			});
			if (activities.length > 0) {
				contextParts.push(
					'[RECENT ACTIVITY]\n' +
						activities
							.map((a) => `- ${a.activityType} at ${new Date(a.occurredAt).toISOString()}`)
							.join('\n')
				);
			}

			// 2b. OPEN COMMITMENTS — durable promises we owe THIS contact (an
			// action_item or a communicated decision), pulled by contact scope
			// INDEPENDENT of semantic similarity. The vector/FTS legs only surface a
			// promise when the new inbound restates it, which is exactly when it's
			// least needed; this ensures "we said we'd ship X by Friday" is in the
			// briefing even for an unrelated inbound. First-class briefing section.
			const openCommitments = await ctx.runQuery(
				internal.knowledge.graph.getOpenCommitmentsByContact,
				{ contactId: message.contactId }
			);
			if (openCommitments.length > 0) {
				hasKnowledge = true;
				for (const c of openCommitments) {
					groundingSources.push({
						type: 'knowledge',
						id: c._id as string,
						title: c.title,
					});
				}
				contextParts.push(
					'[OPEN COMMITMENTS — still owed to this contact; honour these]\n' +
						openCommitments
							.map((c) => {
								const due =
									c.dueAt !== undefined ? ` | due ${new Date(c.dueAt).toISOString()}` : '';
								return `- (${c.entryType}${due}) ${c.title}: ${c.content}`;
							})
							.join('\n')
				);
			}
		}

		// 3. Thread history (previous messages in this conversation)
		if (message.threadId) {
			const threadMessages = await ctx.runQuery(internal.agent.agentPipeline.getThreadMessages, {
				threadId: message.threadId,
				limit: CONTEXT_BUDGET.recentMessagesCount,
				excludeMessageId: input.inboundMessageId,
			});
			if (threadMessages.length > 0) {
				hasThread = true;
				for (const m of threadMessages) {
					groundingSources.push({
						type: 'thread',
						id: m._id as string,
						title: m.subject || '(no subject)',
					});
				}
				contextParts.push(
					'[CONVERSATION HISTORY]\n' +
						threadMessages
							.map(
								(m) =>
									`From: ${m.from}\nDate: ${new Date(m.receivedAt).toISOString()}\nSubject: ${m.subject}\n${m.textBody ?? '(no text body)'}\n---`
							)
							.join('\n')
				);
			}
		}

		// The inbound body the model reads, with remote images / tracking pixels
		// neutralized (privacy: the agent reads every inbound automatically).
		const inboundBody = inboundBodyForContext(message);

		// Query text for semantic retrieval: the inbound subject + body.
		const queryText = `${message.subject ?? ''}\n${inboundBody ?? ''}`.slice(0, 2000);

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
				{}
			);
			const knowledge = await ctx.runAction(internal.knowledge.retrieval.semanticSearch, {
				queryText,
				limit: CONTEXT_BUDGET.knowledgeEntryLimit,
				scopeToContact,
				expandGraph: graphRetrieval,
			});
			if (knowledge.length > 0) {
				hasKnowledge = true;
				knowledgeHitCount = knowledge.length;
				for (const k of knowledge) {
					groundingSources.push({
						type: 'knowledge',
						id: k._id as string,
						title: k.title,
					});
				}
				// Top vector-similarity score (0 for FTS-only hits); undefined
				// only when every hit lacks a score.
				for (const k of knowledge) {
					if (typeof k._score === 'number') {
						topScore = topScore === undefined ? k._score : Math.max(topScore, k._score);
					}
				}
				const renderEntry = (k: (typeof knowledge)[number]): string => {
					// A superseded fact is kept for context but flagged so the
					// model won't ground a reply on it; a contradicts endpoint
					// is framed as a caveat.
					const prefix = k._stale
						? '[SUPERSEDED — do not rely on this] '
						: k._caveat
							? 'CAVEAT: '
							: '';
					return `- ${prefix}(${k.entryType}, confidence ${k.confidence.toFixed(2)}) ${k.title}: ${k.content}`;
				};

				// Curated canonical answers (policy / faq authored as authoritative)
				// get their OWN first-class section so a maintained answer isn't buried
				// among scraped facts. A curated entry SUPERSEDED by a newer scraped
				// fact (`_stale`) is demoted back into [KNOWLEDGE] with the superseded
				// flag, so the fresher fact still wins.
				const policyEntries: typeof knowledge = [];
				const otherEntries: typeof knowledge = [];
				for (const k of knowledge) {
					if (k.isAuthoritative === true && !k._stale) {
						policyEntries.push(k);
					} else {
						otherEntries.push(k);
					}
				}
				if (policyEntries.length > 0) {
					contextParts.push(
						'[POLICY / CANONICAL ANSWERS — curated; authoritative over scraped facts]\n' +
							policyEntries.map(renderEntry).join('\n')
					);
				}
				if (otherEntries.length > 0) {
					contextParts.push('[KNOWLEDGE]\n' + otherEntries.map(renderEntry).join('\n'));
				}

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
			const files = await ctx.runAction(internal.semanticFileProcessing.semanticSearch, {
				queryText,
				limit: CONTEXT_BUDGET.fileLimit,
				scopeToContact,
			});
			if (files.length > 0) {
				hasFiles = true;
				contextParts.push(
					'[RELEVANT FILES]\n' +
						files
							.map(
								(f) =>
									`- ${f.filename}${f.title ? ` ("${f.title}")` : ''}${f.summary ? `: ${f.summary}` : ''}`
							)
							.join('\n')
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
				`Body:\n${inboundBody ?? '(no body)'}`
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
			const contactInfo = contextParts[0]?.startsWith('[CONTACT]') ? contextParts[0] : '';
			finalContext = `${contactInfo}\n\n${currentMessage}`;
		}

		// Trim provenance to what SURVIVED compaction so the review UI's
		// "Grounded in:" list never over-claims sources the model didn't actually
		// see. `normal` keeps everything (finalContext === fullContext). `emergency`
		// keeps only [CONTACT] + [CURRENT MESSAGE], so no thread/knowledge source
		// survives. `compacted` is a tail-slice, so a source survives iff its
		// identifying text is still present in the truncated briefing.
		let survivingSources: GroundingSource[];
		if (tier === 'normal') {
			survivingSources = groundingSources;
		} else if (tier === 'emergency') {
			survivingSources = [];
		} else {
			survivingSources = [];
			for (const src of groundingSources) {
				if (src.title && finalContext.includes(src.title)) {
					survivingSources.push(src);
				}
			}
		}

		// Derive the advisory coverage signal. `lowCoverage` = no substantive
		// grounding (no knowledge, files, or thread history) — the model would
		// be replying essentially blind. Contact identity alone does NOT count
		// as grounding for the reply content.
		const coverage: ContextCoverage = {
			contact: hasContact,
			thread: hasThread,
			knowledge: hasKnowledge,
			files: hasFiles,
			knowledgeHitCount,
			...(topScore === undefined ? {} : { topScore }),
			lowCoverage: !hasKnowledge && !hasFiles && !hasThread,
		};

		// Record the contextTier + coverage on the inboundMessage (in-state
		// side effect — see ADR-0010 for why `contextTier` has its own helper
		// rather than rolling into a transition).
		await ctx.runMutation(internal.inbox.stepOutputs.recordContextTier, {
			inboundMessageId: input.inboundMessageId,
			contextTier: tier,
			contextCoverage: coverage,
			...(survivingSources.length > 0 ? { groundingSources: survivingSources } : {}),
		});

		return {
			output: {
				context: finalContext,
				tier,
				estimatedTokens,
				coverage,
				groundingSources: survivingSources,
			},
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
