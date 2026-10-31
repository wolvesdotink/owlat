'use node';

/**
 * Read on arrival: plain-language Postbox rules, the COMPILE
 * seam. Modelled on `handlingRulesCompile.ts`: the person's own rule text
 * (trusted, never an inbound email) is compiled ONCE by the fast tier into a
 * deterministic filter (`mailFilters` conditions and restrict-only actions)
 * plus, when the rule needs judgement, ONE yes/no question that R2 answers
 * per message at arrival. No message ever reaches this model call.
 *
 * Asynchronous: `compile` writes a `mailRuleDrafts` row (`compiling`) and
 * schedules `compileDraft` in one transaction; `compileDraft` runs the model
 * and lands the row `ready` with a preview or `failed`. The rules section
 * subscribes to the row, and the person confirms the preview before anything
 * is saved (`filterCompileStore.confirm`). Fix (§4.2) writes its own
 * `compiling` row with `origin: 'fix'` and runs the same `compileDraft`.
 *
 * The model may name only the mailbox's own folders and labels (an offered
 * allowlist, matched by name), never a regex, and only the restrict-only
 * actions; the preview then passes the save validator before it is `ready`.
 */

import { z } from 'zod';
import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import { internalAction, type ActionCtx } from '../_generated/server';
import { resolveLanguageModel } from '../lib/llmProvider';
import { runLlmObject } from '../lib/llm/dispatch';
import { meterLlmCall } from '../analytics/meteredSpend';
import { newRootRequest } from '../lib/llm/requestMeter';
import { anchorActionDeadline } from '../lib/llm/actionDeadline';
import { logWarn } from '../lib/runtimeLog';
import type { CompileTargets } from './filterCompileStore';

type Preview = NonNullable<Doc<'mailRuleDrafts'>['preview']>;
type PreviewAction = Preview['actions'][number];

const COMPILED_ACTION_TYPES = [
	'addLabel',
	'moveToFolder',
	'markRead',
	'markFlagged',
	'pinToSection',
	'sendToDigest',
	'placeInUpdates',
	'placeInNeedsMe',
	'archiveAfter',
	'notify',
] as const;

/** The compiled rule the model must return. */
export const compiledFilterSchema = z.object({
	name: z.string().max(80),
	matchType: z.enum(['all', 'any']),
	conditions: z
		.array(
			z.object({
				field: z.enum(['from', 'to', 'cc', 'subject', 'body', 'size', 'hasAttachment']),
				op: z.enum(['contains', 'notContains', 'equals', 'greaterThan', 'lessThan', 'isTrue']),
				value: z.string().max(200).optional(),
				number: z.number().optional(),
			})
		)
		.max(6),
	aiQuestion: z.string().max(300).nullable().optional(),
	actions: z
		.array(
			z.object({
				type: z.enum(COMPILED_ACTION_TYPES),
				folder: z.string().max(120).optional(),
				label: z.string().max(120).optional(),
				section: z.string().max(60).optional(),
				hours: z.number().int().optional(),
			})
		)
		.min(1)
		.max(6),
});
export type CompiledFilter = z.infer<typeof compiledFilterSchema>;

/** The compile prompt over the person's own rule text and their folder/label names. Pure. */
export function buildFilterCompilePrompt(instruction: string, targets: CompileTargets): string {
	const names = (list: { name: string }[]) =>
		list.length > 0 ? list.map((entry) => `"${entry.name.replace(/"/g, "'")}"`).join(', ') : 'none';
	return (
		`Compile the reader's plain-language mail rule into a filter.\n\n` +
		`Rules:\n` +
		`- conditions match the sender (from), recipients (to, cc), subject, body, size in bytes ` +
		`or hasAttachment. Prefer the narrowest conditions that capture the intent; matchType ` +
		`"all" ANDs them, "any" ORs them.\n` +
		`- When the rule needs judgement that the conditions cannot express ("is this an ` +
		`invoice?"), add ONE short yes/no aiQuestion about a single email, and keep ` +
		`conditions that narrow it cheaply. Otherwise leave aiQuestion out. A rule with an ` +
		`aiQuestion may have no conditions.\n` +
		`- actions (only these): addLabel (+label), moveToFolder (+folder), markRead, ` +
		`markFlagged, pinToSection (+section), sendToDigest (the evening digest), ` +
		`placeInUpdates, placeInNeedsMe, archiveAfter (+hours, 1 to 720), notify.\n` +
		`- folder must be one of: ${names(targets.folders)}. label must be one of: ` +
		`${names(targets.labels)}. Leave out an action whose folder or label is not listed.\n` +
		`- Never forward, delete or reply. name is a short title for the rule.\n\n` +
		`Reader's rule:\n${instruction}`
	);
}

function byName<T extends { name: string }>(list: T[], name: string | undefined): T | undefined {
	const wanted = name?.trim().toLowerCase();
	return wanted ? list.find((entry) => entry.name.trim().toLowerCase() === wanted) : undefined;
}

/**
 * The preview of a compiled rule, folder and label names resolved against the
 * offered lists (an unknown one drops its action), or null when nothing
 * usable is left. Pure; the save validator still checks the result.
 */
export function previewFromCompiled(
	compiled: CompiledFilter,
	targets: CompileTargets
): Preview | null {
	const actions: PreviewAction[] = [];
	for (const action of compiled.actions) {
		if (action.type === 'moveToFolder') {
			const folder = byName(targets.folders, action.folder);
			if (folder) actions.push({ type: 'moveToFolder', folderId: folder.id });
		} else if (action.type === 'addLabel') {
			const label = byName(targets.labels, action.label);
			if (label) actions.push({ type: 'addLabel', labelId: label.id });
		} else if (action.type === 'pinToSection') {
			const section = action.section?.replace(/\s+/g, ' ').trim();
			if (section) actions.push({ type: 'pinToSection', sectionName: section });
		} else if (action.type === 'archiveAfter') {
			if (action.hours !== undefined) actions.push({ type: 'archiveAfter', hours: action.hours });
		} else if (!actions.some((existing) => existing.type === action.type)) {
			actions.push({ type: action.type });
		}
	}
	const question = compiled.aiQuestion?.replace(/\s+/g, ' ').trim();
	const conditions = compiled.conditions.map((condition) => ({
		field: condition.field,
		op: condition.op,
		...(condition.value !== undefined ? { value: condition.value } : {}),
		...(condition.number !== undefined ? { valueNumber: condition.number } : {}),
	}));
	if (actions.length === 0 || (conditions.length === 0 && !question)) return null;
	return {
		name: compiled.name.trim() || 'Rule',
		conditions,
		...(compiled.matchType === 'any' ? { matchType: 'any' as const } : {}),
		...(question ? { aiCondition: { question, revision: 0 } } : {}),
		actions,
	};
}

/**
 * Run the model over a `compiling` draft and land it `ready` or `failed`.
 * The AI gate charges `ownerUserId`'s background bucket: the run is scheduled,
 * so there is no session (the person who typed the rule owns the mailbox).
 */
async function runCompile(
	ctx: ActionCtx,
	args: {
		draftId: Id<'mailRuleDrafts'>;
		sourceText: string;
		targets: CompileTargets;
		ownerUserId: string;
	}
): Promise<void> {
	let preview: Preview | null = null;
	try {
		// checkpoint: admission before the model call; the rate-limit token it
		// consumes stays spent when the compile fails later, so retries stay bounded.
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {
			ownerUserId: args.ownerUserId,
		});
		const model = await resolveLanguageModel(ctx, 'mail.rule_compile');
		const { object } = await meterLlmCall(
			ctx,
			{
				feature: 'filter_rule_compile',
				task: 'mail.rule_compile',
				root: newRootRequest('rules'),
			},
			(meter) =>
				runLlmObject({
					meter,
					model,
					schema: compiledFilterSchema,
					prompt: buildFilterCompilePrompt(args.sourceText.trim(), args.targets),
					temperature: 0,
				})
		);
		const parsed = compiledFilterSchema.safeParse(object);
		preview = parsed.success ? previewFromCompiled(parsed.data, args.targets) : null;
	} catch (error) {
		logWarn(
			'[rules] compile failed:',
			error instanceof Error ? error.message.split('\n', 1)[0] : 'non-Error thrown'
		);
	}
	await ctx.runMutation(internal.mail.filterCompileStore.finishDraft, {
		draftId: args.draftId,
		...(preview ? { preview } : {}),
	});
}

/**
 * Compile a plain-language (or Fix) rule into a `mailRuleDrafts` row the UI
 * subscribes to (`filterCompileStore.recentDrafts`): it shows `compiling`
 * while the scheduled `compileDraft` runs the model, then `ready` or
 * `failed`. Returns the draft's id. Owner-grade on a personal mailbox,
 * AI-gated (flag, budget, the mailbox owner's background rate limit).
 */
// authz: owner access to a personal mailbox is checked by internal.mail.filterCompileStore.startCompile
// (requireMailboxAccess at owner level); the model call is gated by assertAiAllowed in compileDraft.
export const compile = authedAction({
	args: {
		mailboxId: v.id('mailboxes'),
		sourceText: v.string(),
		origin: v.optional(v.union(v.literal('fix'), v.literal('plain_language'))),
		fromMessageId: v.optional(v.id('mailMessages')),
	},
	handler: async (ctx, args): Promise<{ draftId: Id<'mailRuleDrafts'> }> => {
		anchorActionDeadline(ctx);
		return await ctx.runMutation(internal.mail.filterCompileStore.startCompile, {
			mailboxId: args.mailboxId,
			sourceText: args.sourceText,
			origin: args.origin ?? 'plain_language',
			...(args.fromMessageId ? { fromMessageId: args.fromMessageId } : {}),
		});
	},
});

/**
 * Compile a draft a mutation already wrote (`compiling`): a typed rule
 * (`filterCompileStore.startCompile`, scheduled by `compile`) or the reason a
 * person gave in Fix (`mail/arrival/fix.ts`, through the `compileFixRuleDraft`
 * hook). That mutation checked the person's access; the model call is charged
 * to the mailbox owner's background bucket. A draft that is gone, settled, or
 * no longer in a personal mailbox is left alone.
 */
export const compileDraft = internalAction({
	args: { draftId: v.id('mailRuleDrafts') },
	handler: async (ctx, args): Promise<void> => {
		anchorActionDeadline(ctx);
		const pending = await ctx.runQuery(internal.mail.filterCompileStore.draftForCompile, args);
		if (!pending) return;
		await runCompile(ctx, {
			draftId: args.draftId,
			sourceText: pending.sourceText,
			targets: pending,
			ownerUserId: pending.ownerUserId,
		});
	},
});
