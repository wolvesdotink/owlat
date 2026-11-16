/**
 * The reads of AI email drafting: everything one generation needs, in one
 * query (the gate, the picked references, the style samples, the brand
 * kit's company name), and the reference picker's name search.
 *
 * References are read with the caller's own access rules: a template or
 * campaign in Recently deleted is gone, a transactional email or campaign is
 * read only while its own feature is on. A reference that no longer resolves
 * fails the request with `EMAIL_GENERATION_REFERENCE_MISSING`, so the author
 * learns which pick to remove instead of getting a draft built without it.
 */

import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { getStoredFlags, resolveStoredFeatureFlags } from '../lib/featureFlags';
import { requireOrgMember } from '../lib/sessionOrganization';
import { getLive } from '../lib/softDelete';
import { throwInvalidState } from '../_utils/errors';
import { parseContentBlocks } from '../emailBlocks/consumers';
import { loadBrandKit } from '../workspaces/brandKit';
import {
	emailGenerationQuery,
	generationKindValidator,
	generationRefusal,
	referenceValidator,
	REFERENCE_FLAGS,
	throwGenerationRefusal,
} from './_helpers';
import { GENERATION_LIMITS } from './outputSchema';
import { selectStyleSamples, type EmailExample, type SampleCandidate } from './promptDecision';
import type { GenerationKind } from './blocksDecision';

type Reference = typeof referenceValidator.type;

export interface GenerationContext {
	references: EmailExample[];
	samples: EmailExample[];
	companyName: string;
}

/** How many recent rows the sample choice looks at. */
const SAMPLE_WINDOW = { templates: 40, sentCampaigns: 30, transactional: 40 } as const;

function templateExample(
	kind: EmailExample['kind'],
	template: Doc<'emailTemplates'> | Doc<'transactionalEmails'>,
	subject?: string
): EmailExample {
	return {
		kind,
		name: template.name,
		subject: subject || template.subject,
		...('previewText' in template && template.previewText
			? { previewText: template.previewText }
			: {}),
		blocks: parseContentBlocks(template.content),
	};
}

function missingReference(reference: Reference): never {
	throwInvalidState('A picked reference no longer exists', {
		code: 'EMAIL_GENERATION_REFERENCE_MISSING',
		referenceId: reference.id,
	});
}

async function loadReference(
	ctx: QueryCtx,
	reference: Reference,
	flags: Readonly<Record<string, boolean>>
): Promise<{ example: EmailExample; templateId?: string }> {
	const flag = REFERENCE_FLAGS[reference.kind];
	if (flag && flags[flag] !== true) missingReference(reference);
	if (reference.kind === 'template') {
		const template = await getLive(ctx, reference.id);
		if (!template) missingReference(reference);
		return { example: templateExample('template', template), templateId: template._id };
	}
	if (reference.kind === 'transactional') {
		const email = await ctx.db.get(reference.id);
		if (!email) missingReference(reference);
		return { example: templateExample('transactional', email) };
	}
	const campaign = await getLive(ctx, reference.id);
	const template = campaign?.emailTemplateId ? await getLive(ctx, campaign.emailTemplateId) : null;
	if (!campaign || !template) missingReference(reference);
	return {
		example: { ...templateExample('campaign', template, campaign.subject), name: campaign.name },
		templateId: template._id,
	};
}

const hasBlocks = (content: string) => content.trim().length > 2 && content.trim() !== '[]';

/** Marketing templates, each scored by the newest send of a campaign that used it. */
async function marketingSamples(ctx: QueryCtx, exclude: ReadonlySet<string>) {
	const [templates, sent] = await Promise.all([
		ctx.db
			.query('emailTemplates')
			.withIndex('by_deleted_at_and_type_and_updated_at', (q) =>
				q.eq('deletedAt', undefined).eq('type', 'marketing')
			)
			.order('desc')
			.take(SAMPLE_WINDOW.templates),
		ctx.db
			.query('campaigns')
			.withIndex('by_deleted_at_and_status_and_sent_at', (q) =>
				q.eq('deletedAt', undefined).eq('status', 'sent')
			)
			.order('desc')
			.take(SAMPLE_WINDOW.sentCampaigns),
	]);
	const lastSent = new Map<string, number>();
	for (const campaign of sent) {
		if (!campaign.emailTemplateId) continue;
		const at = campaign.sentAt ?? 0;
		if ((lastSent.get(campaign.emailTemplateId) ?? 0) < at)
			lastSent.set(campaign.emailTemplateId, at);
	}
	const candidates: SampleCandidate[] = templates.map((t) => ({
		id: t._id,
		status: t.status,
		usage: lastSent.get(t._id) ?? 0,
		updatedAt: t.updatedAt,
		hasContent: hasBlocks(t.content),
	}));
	const byId = new Map(templates.map((t) => [t._id as string, t]));
	return selectStyleSamples(candidates, { exclude }).map((id) =>
		templateExample('template', byId.get(id)!)
	);
}

/** Transactional emails, each scored by its send count. */
async function transactionalSamples(ctx: QueryCtx, exclude: ReadonlySet<string>) {
	const rows = await ctx.db
		.query('transactionalEmails')
		.order('desc')
		.take(SAMPLE_WINDOW.transactional);
	const candidates: SampleCandidate[] = rows.map((row) => ({
		id: row._id,
		status: row.status,
		usage: row.sendCount ?? 0,
		updatedAt: row.updatedAt,
		hasContent: hasBlocks(row.content),
	}));
	const byId = new Map(rows.map((row) => [row._id as string, row]));
	return selectStyleSamples(candidates, { exclude }).map((id) =>
		templateExample('transactional', byId.get(id)!)
	);
}

export const load = internalQuery({
	args: {
		kind: generationKindValidator,
		references: v.array(referenceValidator),
		matchStyle: v.boolean(),
	},
	handler: async (ctx, args): Promise<GenerationContext> => {
		const session = await requireOrgMember(ctx);
		const flags = resolveStoredFeatureFlags(await getStoredFlags(ctx));
		const refusal = generationRefusal(args.kind, flags, session.role);
		if (refusal) throwGenerationRefusal(refusal);

		const references: EmailExample[] = [];
		const exclude = new Set<string>();
		for (const reference of args.references.slice(0, GENERATION_LIMITS.references)) {
			const loaded = await loadReference(ctx, reference, flags);
			references.push(loaded.example);
			exclude.add(reference.id);
			if (loaded.templateId) exclude.add(loaded.templateId);
		}

		const kind: GenerationKind = args.kind;
		const samples = !args.matchStyle
			? []
			: kind === 'transactional'
				? await transactionalSamples(ctx, exclude)
				: await marketingSamples(ctx, exclude);

		const kit = await loadBrandKit(ctx);
		return { references, samples, companyName: kit.design.footerCompanyName.trim() };
	},
});

/** One reference the picker offers. */
export interface ReferenceOption {
	kind: 'template' | 'transactional' | 'campaign';
	id: string;
	name: string;
	subject: string;
}

const SEARCH_LIMIT = 5;

/**
 * The reference picker's search: templates, transactional emails and
 * campaigns whose name or subject matches, a few of each. A campaign is
 * offered only when it has an email to base a draft on. Transactional emails
 * and campaigns appear only while their own feature is on.
 */
// authz: reading the library is open to every member; the picker is shown only
// to members who may draft, and generating re-checks the permission.
export const searchReferences = emailGenerationQuery({
	args: { query: v.string() },
	handler: async (ctx, args): Promise<ReferenceOption[]> => {
		const query = args.query.trim().slice(0, 100);
		if (query.length < 2) return [];
		const flags = resolveStoredFeatureFlags(await getStoredFlags(ctx));
		const [templates, transactional, campaigns] = await Promise.all([
			ctx.db
				.query('emailTemplates')
				.withSearchIndex('search_templates', (q) =>
					q.search('searchableText', query).eq('deletedAt', undefined)
				)
				.take(SEARCH_LIMIT),
			flags.transactional
				? ctx.db
						.query('transactionalEmails')
						.withSearchIndex('search_transactional', (q) => q.search('searchableText', query))
						.take(SEARCH_LIMIT)
				: [],
			flags.campaigns
				? ctx.db
						.query('campaigns')
						.withSearchIndex('search_campaigns', (q) =>
							q.search('searchableText', query).eq('deletedAt', undefined)
						)
						.take(SEARCH_LIMIT)
				: [],
		]);
		return [
			...templates.map((t) => ({
				kind: 'template' as const,
				id: t._id as string,
				name: t.name,
				subject: t.subject,
			})),
			...transactional.map((t) => ({
				kind: 'transactional' as const,
				id: t._id as string,
				name: t.name,
				subject: t.subject,
			})),
			...campaigns
				.filter((c) => c.emailTemplateId)
				.map((c) => ({
					kind: 'campaign' as const,
					id: c._id as string,
					name: c.name,
					subject: c.subject ?? '',
				})),
		];
	},
});
