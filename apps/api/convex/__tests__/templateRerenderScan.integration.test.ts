/**
 * A saved-block edit re-renders every marketing template that links the block
 * (`emailBlocks/renderingPool.ts` `patchTemplateHtml`). A campaign is scanned
 * once, when its send is prepared, and its walker then reads the template's
 * live HTML for every page it enqueues. So a re-render landing while a
 * campaign is sending would reach the rest of its audience unscanned.
 *
 *   - blocked content never lands: the patch rolls back, the template keeps
 *     the HTML it had, and the job fails (its `onComplete` records why);
 *   - suspicious content does not land on a template a sending campaign uses,
 *     where the prepare scan would have held it for review;
 *   - the same holds for a template an active automation sends;
 *   - suspicious content on a template no campaign is sending lands: that
 *     campaign's own start scans it.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestAutomation,
	createTestAutomationStep,
	createTestCampaign,
	createTestEmailTemplate,
} from './factories';
import type * as EmailScannerModule from '@owlat/email-scanner';

const modules = import.meta.glob('../**/*.*s');

// The verdict follows a marker in the HTML, so each case says what it scans.
vi.mock('@owlat/email-scanner', async (importOriginal) => {
	const original = await importOriginal<typeof EmailScannerModule>();
	return {
		...original,
		scanContent: vi.fn((_subject: string, html: string) => {
			if (html.includes('BLOCKED-MARKER')) {
				return {
					score: 80,
					pass: false,
					flags: [{ type: 'phishing_url', severity: 'high', description: 'bad link' }],
					level: 'blocked',
				};
			}
			if (html.includes('SUSPICIOUS-MARKER')) {
				return {
					score: 25,
					pass: false,
					flags: [{ type: 'spam_keywords', severity: 'medium', description: 'spammy' }],
					level: 'suspicious',
				};
			}
			return { score: 0, pass: true, flags: [], level: 'clean' };
		}),
	};
});

async function seedTemplate(t: TestConvex<typeof schema>): Promise<Id<'emailTemplates'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				subject: 'June news',
				htmlContent: '<p>Scanned at prepare</p>',
				contentRevision: 3,
				htmlRenderState: { stale: true, failureCount: 0 },
			})
		)
	);
}

async function seedCampaign(
	t: TestConvex<typeof schema>,
	fields: Record<string, unknown>
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('campaigns', createTestCampaign(fields));
	});
}

function patch(t: TestConvex<typeof schema>, templateId: Id<'emailTemplates'>, html: string) {
	return t.mutation(internal.emailBlocks.renderingPool.patchTemplateHtml, {
		templateId,
		htmlContent: html,
		expectedContentRevision: 3,
	});
}

async function htmlOf(t: TestConvex<typeof schema>, templateId: Id<'emailTemplates'>) {
	return (await t.run(async (ctx) => ctx.db.get(templateId)))?.htmlContent;
}

describe('saved-block re-render of a marketing template is scanned', () => {
	it('keeps the scanned HTML of a template a sending campaign uses when the block is blocked', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await seedCampaign(t, { status: 'sending', emailTemplateId: templateId });

		await expect(patch(t, templateId, '<p>BLOCKED-MARKER</p>')).rejects.toThrow(/Content blocked/);
		expect(await htmlOf(t, templateId)).toBe('<p>Scanned at prepare</p>');
	});

	it('never lets blocked content land, even on a template no campaign is sending', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		await expect(patch(t, templateId, '<p>BLOCKED-MARKER</p>')).rejects.toThrow(/Content blocked/);
		expect(await htmlOf(t, templateId)).toBe('<p>Scanned at prepare</p>');
	});

	it('holds suspicious content back from a sending campaign, also on its variant B template', async () => {
		const t = convexTest(schema, modules);
		const variantA = await seedTemplate(t);
		const variantB = await seedTemplate(t);
		await seedCampaign(t, {
			status: 'sending',
			emailTemplateId: variantA,
			isABTest: true,
			abTestConfig: {
				testType: 'content',
				variantBTemplateId: variantB,
				splitPercentage: 20,
				winnerCriteria: 'open_rate',
				testDuration: 4,
			},
		});

		await expect(patch(t, variantB, '<p>SUSPICIOUS-MARKER</p>')).rejects.toThrow(
			/sending campaign/
		);
		expect(await htmlOf(t, variantB)).toBe('<p>Scanned at prepare</p>');
	});

	it('holds suspicious content back from a template an active automation sends', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await t.run(async (ctx) => {
			const automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'active', activatedAt: Date.now() })
			);
			await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 0,
					stepType: 'email',
					config: { emailTemplateId: templateId },
				})
			);
		});

		await expect(patch(t, templateId, '<p>SUSPICIOUS-MARKER</p>')).rejects.toThrow(
			/active automation/
		);
		expect(await htmlOf(t, templateId)).toBe('<p>Scanned at prepare</p>');
	});

	it('lets suspicious content land where no campaign is sending, for that start to scan', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await seedCampaign(t, { status: 'draft', emailTemplateId: templateId });

		expect(await patch(t, templateId, '<p>SUSPICIOUS-MARKER</p>')).toBe('applied');
		expect(await htmlOf(t, templateId)).toBe('<p>SUSPICIOUS-MARKER</p>');
	});

	it('lets a clean re-render land on a template a sending campaign uses', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await seedCampaign(t, { status: 'sending', emailTemplateId: templateId });

		expect(await patch(t, templateId, '<p>New block text</p>')).toBe('applied');
		expect(await htmlOf(t, templateId)).toBe('<p>New block text</p>');
	});
});
