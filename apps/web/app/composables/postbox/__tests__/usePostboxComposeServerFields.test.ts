/**
 * `serverFieldsOf`: the loaded row as the device mirror compares against it.
 * It must serialise exactly as the composer snapshots its live fields, or a
 * row nobody touched would read as changed and offer a restore on every open.
 */
import { describe, expect, it } from 'vitest';
import { serverFieldsOf } from '../usePostboxComposeHydration';
import { composeDraftFields } from '~/utils/postboxDraftFields';

const blocks = [{ id: 'b1', type: 'text', content: 'Hi' }];

describe('serverFieldsOf', () => {
	it('matches the composer’s own snapshot of the same fields', () => {
		const row = {
			toAddresses: ['ines@northwind.studio'],
			subject: 'Invoice',
			bodyHtml: '<p>Hi</p>',
			bodyBlocks: JSON.stringify(blocks),
			composerMode: 'full' as const,
			followUpRemindAt: 7_000,
		};
		expect(serverFieldsOf(row)).toEqual({
			...composeDraftFields({
				toAddresses: { value: ['ines@northwind.studio'] },
				ccAddresses: { value: [] },
				bccAddresses: { value: [] },
				subject: { value: 'Invoice' },
				bodyHtml: { value: '<p>Hi</p>' },
				bodyBlocks: { value: blocks },
				composerMode: { value: 'full' },
			}),
			followUpRemindAt: 7_000,
		});
	});

	it('fills the row’s gaps the way hydration renders them', () => {
		expect(serverFieldsOf({ bodyBlocks: 'not json' })).toEqual({
			toAddresses: [],
			ccAddresses: [],
			bccAddresses: [],
			subject: '',
			bodyHtml: '',
			bodyBlocks: undefined,
			composerMode: 'simple',
			followUpRemindAt: null,
		});
	});
});
