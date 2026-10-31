import { describe, expect, it } from 'vitest';
import {
	artifactScope,
	exportPageSize,
	isContentResource,
	mailMessageExportRow,
	membershipExportRows,
	splitDraftForExport,
	stagingStep,
} from '../accountExportDecision';

describe('page size', () => {
	it.each(['mailMessages', 'mailDrafts', 'emailTemplates', 'transactionalEmails'])(
		'pages %s one row at a time',
		(resource) => {
			expect(isContentResource(resource)).toBe(true);
			expect(exportPageSize(resource)).toBe(1);
		}
	);

	it.each(['mailboxes', 'contacts', 'organizationMemberships', 'threadBriefs'])(
		'pages %s a hundred rows at a time',
		(resource) => {
			expect(isContentResource(resource)).toBe(false);
			expect(exportPageSize(resource)).toBe(100);
		}
	);

	it('scopes an artifact to its resource and row', () => {
		expect(artifactScope('mailDrafts', 'draft-1')).toBe('mailDrafts:draft-1');
	});
});

describe('membershipExportRows', () => {
	it('pairs each membership with its organization and drops one whose organization is gone', () => {
		expect(
			membershipExportRows(
				[
					{ organizationId: 'org-1', role: 'owner' },
					{ organizationId: 'org-2', role: 'member' },
				],
				[{ _id: 'org-1', name: 'Acme', slug: 'acme', createdAt: 1 } as never, null]
			)
		).toEqual([
			{
				organizationId: 'org-1',
				role: 'owner',
				organization: { _id: 'org-1', name: 'Acme', slug: 'acme' },
			},
		]);
	});
});

describe('row projections', () => {
	it('strips blob handles and bodies from a mail message row', () => {
		expect(
			mailMessageExportRow({
				_id: 'm1',
				subject: 'Hi',
				rawStorageId: 's1',
				textBodyStorageId: 's2',
				htmlBodyStorageId: 's3',
				textBodyInline: 'text',
				htmlBodyInline: '<p>html</p>',
			})
		).toEqual({ _id: 'm1', subject: 'Hi' });
	});

	it('moves draft bodies and attachment bytes into the staged content', () => {
		const attachment = { filename: 'a.pdf', contentBase64: 'QUJD', isContentAvailable: true };
		expect(
			splitDraftForExport({
				_id: 'd1',
				subject: 'Draft',
				bodyHtml: '<p>x</p>',
				bodyText: undefined,
				bodyBlocks: [{ type: 'p' }],
				bodyAvailability: { html: 'available' },
				attachments: [attachment],
			})
		).toEqual({
			row: {
				_id: 'd1',
				subject: 'Draft',
				attachments: [{ filename: 'a.pdf', isContentAvailable: true }],
			},
			content: {
				bodyHtml: '<p>x</p>',
				bodyBlocks: [{ type: 'p' }],
				bodyAvailability: { html: 'available' },
				attachments: [attachment],
			},
		});
	});
});

describe('stagingStep', () => {
	it.each([
		['leases the artifact holding the minted blob', { storageId: 's1' }, 's1', false, 'lease'],
		['restages when another blob holds the key', { storageId: 's2' }, 's1', true, 'restage'],
		[
			'restages a found blob held under the key no more',
			{ storageId: 's2' },
			's1',
			false,
			'restage',
		],
		['registers a fresh blob under a free key', null, 's1', true, 'register'],
		['restages when the found artifact is gone', null, 's1', false, 'restage'],
	] as const)('%s', (_label, existing, storageId, isFreshBlob, step) => {
		expect(stagingStep(existing, { storageId, isFreshBlob })).toBe(step);
	});
});
