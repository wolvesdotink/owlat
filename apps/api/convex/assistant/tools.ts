'use node';

/**
 * The AI assistant's tool surface (decision B1: read + draft, no writes).
 *
 * The built-in tools are declared as hosted modules in {@link TOOL_MODULES} —
 * each pairs the AI-SDK tool with the metadata the host enforces (flag, scope,
 * spend tag, scrub policy; see `./toolRegistry`). `buildAssistantTools(ctx)`
 * assembles the AI-SDK `ToolSet` the conversation runner passes to
 * `runLlmStream`: it flag-gates membership, then wraps each tool so the host
 * injection-scrubs its output before it can reach a prompt.
 *
 * Every built-in tool:
 *   - reaches the workspace through INTERNAL functions (the runner is a scheduled
 *     action with no user identity), and reads ORG-WIDE — the trusted-member
 *     scope (decision G4 / the single-org model).
 *   - scrubs retrieved text for prompt-injection before returning it to the
 *     model (decision B3), since files/contacts/knowledge are untrusted data.
 *     The host re-scrubs the whole output as a blanket guarantee on top of this.
 *   - is read-only OR returns generated text the user applies themselves; no
 *     tool ever mutates workspace state or sends mail — the scope union in
 *     `./toolRegistry` has no write/send member.
 *
 * 'use node' because the draft tools call the streaming/text LLM seam, and this
 * module is only ever imported by the Node runner.
 */

import { tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { runLlmText } from '../lib/llm/dispatch';
import { resolveLanguageModelForUserText } from '../lib/llmProvider';
import { recordLlmSpend } from '../analytics/llmUsage';
import { scrubForInjection, clampText } from './prompt';
import {
	ASSISTANT_TOOL_DRAFT_SPEND,
	hasFlaggedModule,
	selectAssistantToolModules,
	withHostScrub,
	type HostedAssistantToolModule,
} from './toolRegistry';

const clampInt = (n: number | undefined, min: number, max: number, dflt: number) =>
	Math.max(min, Math.min(n ?? dflt, max));

const MAX_KNOWLEDGE_CONTENT = 1200;
const MAX_FILE_EXCERPT = 1000;
const MAX_RELATED_TITLE = 200;

function buildSearchKnowledge(ctx: ActionCtx): Tool {
	return tool({
		description:
			'Search the workspace knowledge graph (facts, decisions, and preferences extracted from the team’s conversations and files) for information relevant to a question. Use this first for anything about what the team or its contacts know, decided, or prefer.',
		inputSchema: z.object({
			query: z.string().describe('A natural-language search query.'),
			limit: z.number().int().min(1).max(10).optional().describe('Max results (default 6).'),
		}),
		execute: async ({ query, limit }) => {
			// Graph-augmented (seed-then-expand) when ai.knowledge.graphRetrieval
			// is on. org-wide is the allowed scope-gate skip (the trusted-member
			// path); the flag is the KILL SWITCH so off ⇒ flat, no relatedTo.
			const graphRetrieval = await ctx.runQuery(
				internal.knowledge.graphTraversal.isGraphRetrievalEnabled,
				{}
			);
			const entries = await ctx.runAction(internal.knowledge.retrieval.semanticSearch, {
				queryText: query,
				limit: clampInt(limit, 1, 10, 6),
				scopeToContact: 'org-wide',
				expandGraph: graphRetrieval,
			});
			return {
				results: entries.map((e) => ({
					title: scrubForInjection(e.title),
					type: e.entryType,
					confidence: e.confidence,
					// A superseded fact is surfaced but flagged so the model
					// doesn't rely on it over the newer one.
					stale: e._stale ?? false,
					content: scrubForInjection(clampText(e.content, MAX_KNOWLEDGE_CONTENT)),
					// Typed relationships to other entries. otherTitle is UNTRUSTED
					// retrieved text — scrub + clamp every one.
					relatedTo: (e._via ?? []).map((via) => ({
						relation: via.relation,
						title: scrubForInjection(clampText(via.otherTitle, MAX_RELATED_TITLE)),
					})),
				})),
			};
		},
	});
}

function buildSearchFiles(ctx: ActionCtx): Tool {
	return tool({
		description:
			'Semantic search over files uploaded to the workspace (PDFs, documents, notes). Returns the most relevant files with a short excerpt. Use when the answer is likely in an uploaded document.',
		inputSchema: z.object({
			query: z.string().describe('A natural-language search query.'),
			limit: z.number().int().min(1).max(8).optional().describe('Max results (default 5).'),
		}),
		execute: async ({ query, limit }) => {
			const files = await ctx.runAction(internal.semanticFileProcessing.semanticSearch, {
				queryText: query,
				limit: clampInt(limit, 1, 8, 5),
				scopeToContact: 'org-wide',
			});
			return {
				results: files.map((f) => ({
					filename: scrubForInjection(f.filename),
					title: scrubForInjection(f.title ?? ''),
					summary: scrubForInjection(f.summary ?? ''),
					excerpt: scrubForInjection(clampText(f.extractedText ?? '', MAX_FILE_EXCERPT)),
				})),
			};
		},
	});
}

function buildSearchEverything(ctx: ActionCtx): Tool {
	return tool({
		description:
			'Full-text search across contacts, email templates, transactional emails, and campaigns by name/subject. Use to locate a specific record (e.g. "find the contact Jane Doe" or "the welcome campaign").',
		inputSchema: z.object({
			query: z.string().describe('Name, email, subject, or keyword to look up.'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(15)
				.optional()
				.describe('Max results per category (default 5).'),
		}),
		execute: async ({ query, limit }) => {
			const r = await ctx.runQuery(internal.globalSearch.searchInternal, {
				query,
				limit: clampInt(limit, 1, 15, 5),
			});
			const scrub = (arr: Array<{ title: string; subtitle: string; url: string }>) =>
				arr.map((x) => ({
					title: scrubForInjection(x.title),
					subtitle: scrubForInjection(x.subtitle),
					url: x.url,
				}));
			return {
				contacts: scrub(r.contacts),
				emails: scrub(r.emails),
				campaigns: scrub(r.campaigns),
			};
		},
	});
}

function buildGetCampaignStats(ctx: ActionCtx): Tool {
	return tool({
		description:
			'Look up performance stats for marketing campaigns matching a name/subject query — sends, deliveries, opens, clicks, bounces, unsubscribes, and open/click rates.',
		inputSchema: z.object({
			campaign: z.string().describe('Campaign name, subject, or keyword.'),
		}),
		execute: async ({ campaign }) => {
			const r = await ctx.runQuery(internal.assistant.insights.campaignStats, {
				query: campaign,
			});
			return {
				campaigns: r.campaigns.map((c) => ({
					...c,
					name: scrubForInjection(c.name),
					subject: c.subject ? scrubForInjection(c.subject) : null,
				})),
			};
		},
	});
}

function buildGetEmailStats(ctx: ActionCtx): Tool {
	return tool({
		description:
			'Aggregate marketing email performance across all campaigns sent in the last N days (default 30): total sends, deliveries, opens, clicks, bounces, unsubscribes, and overall open/click rates.',
		inputSchema: z.object({
			days: z
				.number()
				.int()
				.min(1)
				.max(90)
				.optional()
				.describe('Window in days (default 30, max 90).'),
		}),
		execute: async ({ days }) => {
			return ctx.runQuery(internal.assistant.insights.emailStats, { days });
		},
	});
}

function buildDraftEmailReply(ctx: ActionCtx): Tool {
	return tool({
		description:
			'Draft a professional email reply to a contact. Returns the draft text only — it does NOT send anything. Use when the user asks you to write/compose an email to someone.',
		inputSchema: z.object({
			contact: z.string().describe('The recipient — a name or email to look up.'),
			intent: z.string().describe('What the email should say or accomplish.'),
		}),
		execute: async ({ contact, intent }) => {
			const found = await ctx.runQuery(internal.assistant.insights.findContact, {
				query: contact,
			});
			const recipient = found ? `${found.name ?? found.email} <${found.email}>` : contact;
			const result = await runLlmText({
				model: await resolveLanguageModelForUserText(ctx, 'draft', intent),
				system:
					'You draft a single professional email reply. Output ONLY the email body — no preamble, no commentary, no subject line unless explicitly asked. Keep it concise and ready for the user to review and edit.',
				prompt: `Recipient: ${recipient}\n\nWrite an email that accomplishes: ${clampText(intent, 1500)}`,
				temperature: 0.4,
			});
			await recordLlmSpend(ctx, ASSISTANT_TOOL_DRAFT_SPEND, result.tokenUsage, result.modelUsed);
			return { recipient, contactFound: !!found, draft: result.text.trim() };
		},
	});
}

function buildDraftCampaignCopy(ctx: ActionCtx): Tool {
	return tool({
		description:
			'Draft marketing campaign email copy (subject line + body) from a brief. Returns the draft text only — it does NOT create or send a campaign. Use when the user asks you to write campaign or newsletter copy.',
		inputSchema: z.object({
			brief: z.string().describe('What the campaign is about, the goal, tone, key points.'),
			audience: z.string().optional().describe('Who the campaign is for (optional).'),
		}),
		execute: async ({ brief, audience }) => {
			const result = await runLlmText({
				model: await resolveLanguageModelForUserText(ctx, 'draft', brief),
				system:
					'You are an expert email-marketing copywriter. Draft compelling campaign email copy from the brief. Output Markdown: a "**Subject:**" line, then the email body. Keep it ready for the user to review and edit.',
				prompt: `Brief: ${clampText(brief, 2000)}${audience ? `\n\nAudience: ${clampText(audience, 500)}` : ''}`,
				temperature: 0.6,
			});
			await recordLlmSpend(ctx, ASSISTANT_TOOL_DRAFT_SPEND, result.tokenUsage, result.modelUsed);
			return { draft: result.text.trim() };
		},
	});
}

/**
 * The built-in assistant tools, in the order the assembler emits them. This is
 * the single source of truth for built-in membership and metadata; the same set
 * powers both the personal assistant and @assistant-in-chat. No built-in gates
 * on a per-tool `flag` (the assistant is gated as a whole by `ai.assistant`); no
 * built-in writes or sends.
 */
export const TOOL_MODULES: readonly HostedAssistantToolModule[] = Object.freeze([
	{
		name: 'searchKnowledge',
		scope: 'workspace:read',
		spend: null,
		scrubOutput: true,
		build: buildSearchKnowledge,
	},
	{
		name: 'searchFiles',
		scope: 'workspace:read',
		spend: null,
		scrubOutput: true,
		build: buildSearchFiles,
	},
	{
		name: 'searchEverything',
		scope: 'workspace:read',
		spend: null,
		scrubOutput: true,
		build: buildSearchEverything,
	},
	{
		name: 'getCampaignStats',
		scope: 'workspace:read',
		spend: null,
		scrubOutput: true,
		build: buildGetCampaignStats,
	},
	{
		name: 'getEmailStats',
		scope: 'workspace:read',
		spend: null,
		scrubOutput: true,
		build: buildGetEmailStats,
	},
	{
		name: 'draftEmailReply',
		scope: 'workspace:draft',
		spend: ASSISTANT_TOOL_DRAFT_SPEND,
		scrubOutput: true,
		build: buildDraftEmailReply,
	},
	{
		name: 'draftCampaignCopy',
		scope: 'workspace:draft',
		spend: ASSISTANT_TOOL_DRAFT_SPEND,
		scrubOutput: true,
		build: buildDraftCampaignCopy,
	},
] satisfies readonly HostedAssistantToolModule[]);

/**
 * Assemble the AI-SDK tool set from the hosted registry, closing over the
 * runner's action context. Flag-gates membership (a tool whose `flag` is OFF is
 * omitted — feature-off ⇒ the model never sees it), then wraps each tool so the
 * host injection-scrubs its output before it can reach a prompt.
 *
 * When no module declares a flag (the built-in set), no flag I/O happens, so the
 * assembled set is exactly the built-ins in declaration order. `modules` is
 * injectable so the flag-gated and scrub paths are exercised in tests.
 */
export async function buildAssistantTools(
	ctx: ActionCtx,
	modules: readonly HostedAssistantToolModule[] = TOOL_MODULES
): Promise<ToolSet> {
	const flags = hasFlaggedModule(modules)
		? await ctx.runQuery(internal.workspaces.featureFlags.getResolvedFlags, {})
		: {};
	const set: ToolSet = {};
	for (const module of selectAssistantToolModules(modules, flags)) {
		const built = module.build(ctx);
		set[module.name] = module.scrubOutput ? withHostScrub(built) : built;
	}
	return set;
}
