/**
 * A marketing template that a sending campaign or an active automation uses
 * goes out with its live HTML, so every write to it is scanned
 * (`emailTemplates/liveContentScan.ts`), and an automation is scanned when it
 * is switched on:
 *
 *   - an editor or translation save that a scan flags is refused on a
 *     template a sending campaign or an active automation uses, and the row
 *     keeps what it had;
 *   - the same save lands on a template nothing is sending;
 *   - activation and resume are refused while an email step's content is
 *     flagged, with the scanner's verdict in the message.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestAutomation,
	createTestAutomationStep,
	createTestCampaign,
	createTestEmailTemplate,
	flushScheduled,
} from './factories';
import type * as EmailScannerModule from '@owlat/email-scanner';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'user-olive', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-olive'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'user-olive', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'user-olive', role: 'owner' }),
	};
});

// The verdict follows a marker in the subject or HTML, so each case says what it scans.
vi.mock('@owlat/email-scanner', async (importOriginal) => {
	const original = await importOriginal<typeof EmailScannerModule>();
	return {
		...original,
		scanContent: vi.fn((subject: string, html: string) => {
			const scanned = `${subject} ${html}`;
			if (scanned.includes('BLOCKED-MARKER')) {
				return {
					score: 80,
					pass: false,
					flags: [{ type: 'phishing_url', severity: 'high', description: 'bad link' }],
					level: 'blocked',
				};
			}
			if (scanned.includes('SUSPICIOUS-MARKER')) {
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

const modules = import.meta.glob('../**/*.*s');

afterEach(async () => {
	await flushScheduled();
});

const CONTENT = JSON.stringify([{ id: 'b1', type: 'text', content: { html: 'Hello world' } }]);

async function seedTemplate(t: TestConvex<typeof schema>): Promise<Id<'emailTemplates'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				name: 'June news',
				subject: 'June news',
				content: CONTENT,
				htmlContent: '<p>Scanned at start</p>',
				defaultLanguage: 'en',
				supportedLanguages: ['en'],
			})
		)
	);
}

async function seedAutomation(
	t: TestConvex<typeof schema>,
	templateId: Id<'emailTemplates'>,
	status: 'draft' | 'active' | 'paused',
	subjectOverride?: string
): Promise<Id<'automations'>> {
	return await t.run(async (ctx) => {
		const automationId = await ctx.db.insert(
			'automations',
			createTestAutomation({
				status,
				...(status !== 'draft' && { activatedAt: Date.now() - 10_000 }),
				...(status === 'paused' && { pausedAt: Date.now() - 5_000 }),
			})
		);
		await ctx.db.insert(
			'automationSteps',
			createTestAutomationStep({
				automationId,
				stepIndex: 0,
				stepType: 'email',
				config: { emailTemplateId: templateId, ...(subjectOverride && { subjectOverride }) },
			})
		);
		return automationId;
	});
}

function saveSubject(
	t: TestConvex<typeof schema>,
	templateId: Id<'emailTemplates'>,
	subject: string
) {
	return t.mutation(api.emailTemplates.emails.update, { templateId, subject });
}

async function rowOf(t: TestConvex<typeof schema>, templateId: Id<'emailTemplates'>) {
	return await t.run(async (ctx) => ctx.db.get(templateId));
}

describe('editor saves of a template that is going out are scanned', () => {
	it('refuses a flagged save of a template a sending campaign uses', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'sending', emailTemplateId: templateId, subject: undefined })
			);
		});

		await expect(saveSubject(t, templateId, 'SUSPICIOUS-MARKER deals')).rejects.toThrow(
			/sending campaign/
		);
		const row = await rowOf(t, templateId);
		expect(row?.subject).toBe('June news');
		expect(row?.htmlContent).toBe('<p>Scanned at start</p>');
	});

	it('refuses a flagged save of a template an active automation sends', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await seedAutomation(t, templateId, 'active');

		await expect(saveSubject(t, templateId, 'BLOCKED-MARKER')).rejects.toThrow(
			/Content blocked.*active automation/
		);
		expect((await rowOf(t, templateId))?.subject).toBe('June news');
	});

	it('refuses a flagged translation save of a template a sending campaign uses', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await t.mutation(api.emailTemplates.i18n.addTranslation, { templateId, language: 'de' });
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'sending', emailTemplateId: templateId, subject: undefined })
			);
		});
		const before = (await rowOf(t, templateId))?.htmlTranslations;

		await expect(
			t.mutation(api.emailTemplates.i18n.updateTranslation, {
				templateId,
				language: 'de',
				subject: 'SUSPICIOUS-MARKER Angebote',
			})
		).rejects.toThrow(/sending campaign/);
		expect((await rowOf(t, templateId))?.htmlTranslations).toBe(before);
	});

	it("scans a sending campaign's subject override with the saved content, not the template's subject", async () => {
		const t = convexTest(schema, modules);
		const flaggedOverride = await seedTemplate(t);
		const replacedSubject = await seedTemplate(t);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'sending',
					emailTemplateId: flaggedOverride,
					subject: 'SUSPICIOUS-MARKER deals',
				})
			);
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'sending',
					emailTemplateId: replacedSubject,
					subject: 'June news',
				})
			);
		});

		await expect(saveSubject(t, flaggedOverride, 'June news, again')).rejects.toThrow(
			/sending campaign/
		);
		await saveSubject(t, replacedSubject, 'SUSPICIOUS-MARKER');
		expect((await rowOf(t, replacedSubject))?.subject).toBe('SUSPICIOUS-MARKER');
	});

	it("scans an active automation step's own subject with the saved content", async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await seedAutomation(t, templateId, 'active', 'SUSPICIOUS-MARKER');

		await expect(saveSubject(t, templateId, 'June news, again')).rejects.toThrow(
			/active automation/
		);
	});

	it('lets a flagged save land where nothing is sending, for the start to scan', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await seedAutomation(t, templateId, 'paused');
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'draft', emailTemplateId: templateId })
			);
		});

		await saveSubject(t, templateId, 'BLOCKED-MARKER');
		expect((await rowOf(t, templateId))?.subject).toBe('BLOCKED-MARKER');
	});
});

describe('switching an automation on scans its email steps', () => {
	function activate(t: TestConvex<typeof schema>, automationId: Id<'automations'>) {
		return t.mutation(internal.automations.lifecycle.transition, {
			automationId,
			input: { to: 'active', at: Date.now() },
			userId: 'user-olive',
		});
	}

	it('refuses activation while a template is flagged', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await t.run(async (ctx) => ctx.db.patch(templateId, { htmlContent: '<p>BLOCKED-MARKER</p>' }));
		const automationId = await seedAutomation(t, templateId, 'draft');

		const outcome = await activate(t, automationId);
		expect(outcome).toMatchObject({ ok: false, reason: 'content_refused' });
		if (outcome.ok) return;
		expect(outcome.detail).toMatch(/Content blocked.*"June news".*bad link/);
		expect((await t.run(async (ctx) => ctx.db.get(automationId)))?.status).toBe('draft');
	});

	it("scans the step's own subject on resume", async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const automationId = await seedAutomation(t, templateId, 'paused', 'SUSPICIOUS-MARKER');

		const outcome = await activate(t, automationId);
		expect(outcome).toMatchObject({ ok: false, reason: 'content_refused' });
		if (outcome.ok) return;
		expect(outcome.detail).toMatch(/Content flagged.*spammy/);
		expect((await t.run(async (ctx) => ctx.db.get(automationId)))?.status).toBe('paused');
	});

	it('scans a template in Recently deleted, which a restore brings back', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await t.run(async (ctx) =>
			ctx.db.patch(templateId, { htmlContent: '<p>BLOCKED-MARKER</p>', deletedAt: Date.now() })
		);
		const automationId = await seedAutomation(t, templateId, 'draft');

		expect(await activate(t, automationId)).toMatchObject({ ok: false, reason: 'content_refused' });
	});

	it('activates an automation whose content scans clean', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const automationId = await seedAutomation(t, templateId, 'draft');

		expect(await activate(t, automationId)).toMatchObject({ ok: true, applied: 'transitioned' });
	});
});
