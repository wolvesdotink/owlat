/**
 * The transactional intake's pure decisions (`transactional/dispatchDecision.ts`)
 * for fixed templates and a fixed `now`. `transactionalDispatch.integration.test.ts`
 * holds the live mutation to them.
 */
import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../_generated/dataModel';
import {
	decideSenderAndVariables,
	decideTemplate,
	planTransactionalSend,
	senderDefaults,
} from '../dispatchDecision';

const NOW = Date.UTC(2026, 9, 25, 12);
const TEMPLATE_ID = 'tpl_1' as Id<'transactionalEmails'>;
const CONTACT_ID = 'contact_1' as Id<'contacts'>;

const template = (
	overrides: Partial<Doc<'transactionalEmails'>> = {}
): Doc<'transactionalEmails'> =>
	({
		_id: TEMPLATE_ID,
		_creationTime: 0,
		name: 'Welcome',
		slug: 'welcome',
		subject: 'Welcome',
		htmlContent: '<p>Hello</p>',
		status: 'published',
		defaultLanguage: 'en',
		supportedLanguages: ['en', 'de'],
		...overrides,
	}) as Doc<'transactionalEmails'>;

type PlanInput = Parameters<typeof planTransactionalSend>[0];

const planInput = (overrides: Partial<PlanInput> = {}): PlanInput => ({
	template: template(),
	request: {
		email: 'ada@example.com',
		language: undefined,
		dataVariables: { firstName: 'Ada' },
		attachmentRefs: undefined,
	},
	contactId: CONTACT_ID,
	contactLanguage: undefined,
	sender: { fromEmail: 'noreply@owlat.example', fromName: 'Owlat' },
	route: { providerType: 'mta', ipPool: 'warm' },
	sendCounters: { transactionalSendCount: 2, dailySendCount: 5, dailySendCountResetAt: NOW - 1000 },
	organizationId: 'org_1',
	siteUrl: 'https://app.owlat.example',
	correlationId: 'txn_fixed',
	now: NOW,
	...overrides,
});

describe('decideTemplate', () => {
	it('refuses a missing, unpublished or empty template, naming it', () => {
		expect(decideTemplate({ kind: 'id', id: TEMPLATE_ID }, null)).toEqual({
			ok: false,
			reason: 'template_not_found',
			detail: 'Transactional email with ID "tpl_1" not found',
		});
		expect(decideTemplate({ kind: 'slug', slug: 'gone' }, null)).toMatchObject({
			reason: 'template_not_found',
			detail: 'Transactional email with slug "gone" not found',
		});
		expect(
			decideTemplate({ kind: 'slug', slug: 'welcome' }, template({ status: 'draft' }))
		).toMatchObject({
			reason: 'template_not_published',
		});
		expect(
			decideTemplate({ kind: 'slug', slug: 'welcome' }, template({ htmlContent: '' }))
		).toMatchObject({
			reason: 'template_no_content',
		});
	});

	it('accepts a published template and flags stale HTML without refusing it', () => {
		const stale = template({ htmlRenderState: { stale: true } } as Partial<
			Doc<'transactionalEmails'>
		>);
		expect(decideTemplate({ kind: 'id', id: TEMPLATE_ID }, stale)).toEqual({
			ok: true,
			template: stale,
			isHtmlStale: true,
		});
	});
});

describe('the sender and the variables', () => {
	it('takes the sender from settings, then the environment, then the fallback', () => {
		expect(senderDefaults({ defaultFromEmail: 'a@x.test', defaultFromName: 'A' }, {})).toEqual({
			fromEmail: 'a@x.test',
			fromName: 'A',
		});
		expect(senderDefaults(null, { defaultFromEmail: 'env@x.test' })).toEqual({
			fromEmail: 'env@x.test',
			fromName: 'Owlat',
		});
		expect(senderDefaults(null, {})).toEqual({
			fromEmail: 'noreply@example.com',
			fromName: 'Owlat',
		});
	});

	it('refuses an unverified domain before it looks at the variables', () => {
		const unverified = { verified: false, domain: 'x.test' };
		expect(
			decideSenderAndVariables({
				domainStatus: unverified,
				dataVariables: { firstName: 3 },
				dataVariablesSchema: { firstName: 'string' },
			})
		).toMatchObject({ reason: 'domain_unverified', detail: expect.stringContaining('"x.test"') });
		expect(
			decideSenderAndVariables({
				domainStatus: { verified: true, domain: 'x.test' },
				dataVariables: { firstName: 3 },
				dataVariablesSchema: { firstName: 'string' },
			})
		).toMatchObject({ reason: 'invalid_variables' });
		expect(
			decideSenderAndVariables({
				domainStatus: { verified: true, domain: 'x.test' },
				dataVariables: { firstName: 'Ada' },
				dataVariablesSchema: { firstName: 'string' },
			})
		).toBeUndefined();
	});
});

describe('planTransactionalSend', () => {
	it('plans the queued row, the counters, the template count and the envelope', () => {
		const plan = planTransactionalSend(
			planInput({
				template: template({ plainTextContent: 'Hello', sendCount: 9, showUnsubscribe: true }),
			})
		);
		expect(plan).toEqual({
			language: 'en',
			attachmentStorageIds: undefined,
			sendRow: {
				kind: 'transactional',
				transactionalEmailId: TEMPLATE_ID,
				email: 'ada@example.com',
				contactId: CONTACT_ID,
				language: 'en',
				dataVariables: { firstName: 'Ada' },
				status: 'queued',
				queuedAt: NOW,
				providerType: 'mta',
				correlationId: 'txn_fixed',
			},
			counterPatch: {
				transactionalSendCount: 3,
				dailySendCount: 6,
				dailySendCountResetAt: Date.UTC(2026, 9, 25),
			},
			templatePatch: { sendCount: 10 },
			from: 'Owlat <noreply@owlat.example>',
			organizationId: 'org_1',
			envelope: {
				kind: 'transactional',
				emailPurpose: 'transactional',
				to: 'ada@example.com',
				from: 'Owlat <noreply@owlat.example>',
				providerType: 'mta',
				ipPool: 'warm',
				template: { subject: 'Welcome', htmlContent: '<p>Hello</p>', plainTextContent: 'Hello' },
				dataVariables: { firstName: 'Ada' },
				attachmentRefs: undefined,
				organizationId: 'org_1',
				showUnsubscribe: true,
				contactId: CONTACT_ID,
				siteUrl: 'https://app.owlat.example',
			},
		});
	});

	it("sends the contact's language when translated, without the default plain text", () => {
		const plan = planTransactionalSend(
			planInput({
				template: template({
					plainTextContent: 'Hello',
					htmlTranslations: JSON.stringify({
						de: { htmlContent: '<p>Hallo</p>', subject: 'Hallo' },
					}),
				}),
				contactLanguage: 'de',
			})
		);
		expect(plan.language).toBe('de');
		expect(plan.sendRow.language).toBe('de');
		expect(plan.envelope.template).toEqual({ subject: 'Hallo', htmlContent: '<p>Hallo</p>' });
	});

	it('claims only the request uploads and merges template attachments first', () => {
		const plan = planTransactionalSend(
			planInput({
				template: template({
					attachments: JSON.stringify([
						{ filename: 't.pdf', url: 'https://cdn.owlat.example/t.pdf' },
					]),
				}),
				request: {
					email: 'ada@example.com',
					language: undefined,
					dataVariables: undefined,
					attachmentRefs: [
						{ filename: 'r.pdf', url: 'https://cdn.owlat.example/r.pdf', storageId: 'blob_1' },
						{ filename: 'link.pdf', url: 'https://cdn.owlat.example/link.pdf' },
					],
				},
			})
		);
		expect(plan.attachmentStorageIds).toEqual(['blob_1']);
		expect(plan.sendRow.attachmentStorageIds).toEqual(['blob_1']);
		expect(plan.envelope.attachmentRefs?.map((a) => a.filename)).toEqual([
			't.pdf',
			'r.pdf',
			'link.pdf',
		]);
	});

	it('writes no counters before the instance exists and stamps no route it does not have', () => {
		const plan = planTransactionalSend(
			planInput({ sendCounters: null, route: null, organizationId: null })
		);
		expect(plan.counterPatch).toBeUndefined();
		expect('providerType' in plan.sendRow).toBe(false);
		expect('providerType' in plan.envelope).toBe(false);
		expect('organizationId' in plan.envelope).toBe(false);
		expect('showUnsubscribe' in plan.envelope).toBe(false);
	});

	it('is the same plan on every evaluation and leaves its input alone', () => {
		const input = planInput();
		const snapshot = structuredClone(input);
		expect(planTransactionalSend(input)).toEqual(planTransactionalSend(input));
		expect(input).toEqual(snapshot);
	});
});
