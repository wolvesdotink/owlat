/**
 * Seed loader: automations + automationSteps.
 *
 * Direct insert — skips the lifecycle-driven activation effect that the public
 * mutation would fire (which schedules cron entries and warms the step
 * walker). The seed leaves the automation in 'active' but the walker only
 * acts on new contact_created events; existing seeded contacts won't re-fire.
 *
 * That "only new events" caveat is exactly why a REAL install runs this loader
 * INERT (`options.inert`): the fixture automation triggers on `contact_created`
 * and sends a "Summer sale" template, and `automations/triggers.ts` fans out to
 * every active automation with no seed-tag filter — so on a live instance the
 * next genuine signup would receive a demo promo. Inert mode writes the
 * automation `paused` with no `activatedAt`, which the fanout skips.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { SEED_TAG, type LoadResult, type Loader, type LoaderOptions, type SeedRefs } from './types';

type TriggerType = 'contact_created' | 'contact_updated' | 'event_received' | 'topic_subscribed';
type AutomationStatus = 'draft' | 'active' | 'paused';

interface AutomationFixture {
	slug: string;
	name: string;
	description?: string;
	triggerType: TriggerType;
	status: AutomationStatus;
	steps: Array<{ stepType: 'email'; template: string }>;
}

async function load(
	ctx: MutationCtx,
	rawRecords: unknown[],
	refs: SeedRefs,
	options: LoaderOptions
): Promise<LoadResult> {
	const records = rawRecords as AutomationFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'automations'>> = {};
	const now = Date.now();

	const existing = await ctx.db.query('automations').collect(); // bounded: tiny seed table
	const byName = new Map(existing.map((a) => [a.name, a]));

	for (const rec of records) {
		const found = byName.get(rec.name);
		if (found) {
			ids[rec.slug] = found._id;
			skipped++;
			continue;
		}

		// Inert mode never writes a live automation, whatever the fixture says.
		const status: AutomationStatus =
			options.inert && rec.status === 'active' ? 'paused' : rec.status;

		const automationId = await ctx.db.insert('automations', {
			name: rec.name,
			description: rec.description,
			triggerType: rec.triggerType,
			status,
			activatedAt: status === 'active' ? now : undefined,
			seedTag: SEED_TAG,
			createdAt: now,
			updatedAt: now,
		});

		for (let idx = 0; idx < rec.steps.length; idx++) {
			const step = rec.steps[idx]!;
			const templateId = refs['emailTemplates']?.[step.template] as
				| Id<'emailTemplates'>
				| undefined;
			if (!templateId) continue;
			await ctx.db.insert('automationSteps', {
				automationId,
				stepIndex: idx,
				stepType: 'email',
				config: {
					emailTemplateId: templateId,
				},
				seedTag: SEED_TAG,
				createdAt: now,
				updatedAt: now,
			});
		}

		ids[rec.slug] = automationId;
		inserted++;
	}

	return { inserted, skipped, ids };
}

export const automationsLoader: Loader = {
	module: 'automations',
	dependencies: ['emailTemplates'],
	load,
};
