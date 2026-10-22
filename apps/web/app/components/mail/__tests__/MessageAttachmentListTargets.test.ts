/**
 * Touch targets of the attachment row's icon controls (plan item OW-010).
 *
 * With a mouse the eye and the download stay the compact `p-1` icon buttons
 * they always were; on a coarse pointer each grows to the 44px target the
 * `.btn` recipe uses, as its own box in the row's flex flow. happy-dom has no
 * layout, so this pins the class contract: every class without the
 * `pointer-coarse:` prefix is the fine-pointer recipe, unchanged, and the
 * prefixed ones carry the size. The rendered geometry (rects, hit ownership,
 * nonoverlap) is checked in a real browser for the PR.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageAttachmentList from '../MessageAttachmentList.vue';

const FINE_RECIPE = {
	preview: [
		'p-1',
		'rounded',
		'hover:bg-bg-elevated',
		'text-text-tertiary',
		'hover:text-text-primary',
	],
	download: [
		'p-1',
		'rounded',
		'hover:bg-bg-elevated',
		'text-text-tertiary',
		'hover:text-text-primary',
		'disabled:opacity-50',
		'aria-disabled:opacity-50',
	],
};

const COARSE_TARGET = [
	'pointer-coarse:inline-flex',
	'pointer-coarse:min-h-11',
	'pointer-coarse:min-w-11',
	'pointer-coarse:items-center',
	'pointer-coarse:justify-center',
];

function render() {
	return mount(MessageAttachmentList, {
		props: {
			attachments: [
				{ filename: 'invoice.pdf', contentType: 'application/pdf', size: 4096, partIndex: '2' },
			],
			messageId: 'mm_1',
			isPreviewEnabled: true,
			previewLabel: (name: string) => `Preview ${name}`,
			downloadLabel: (name: string) => `Download ${name}`,
		},
		global: { stubs: { Icon: true } },
	});
}

function split(classes: string[]) {
	return {
		fine: classes.filter((c) => !c.startsWith('pointer-coarse:')),
		coarse: classes.filter((c) => c.startsWith('pointer-coarse:')),
	};
}

describe('MessageAttachmentList touch targets', () => {
	it.each([
		['preview', '[data-testid="message-attachment-preview"]'],
		['download', '[data-testid="message-attachment-download"]'],
	] as const)('the %s control keeps its mouse recipe and grows to 44px on touch', (key, sel) => {
		const { fine, coarse } = split(render().get(sel).classes());
		expect(fine).toEqual(FINE_RECIPE[key]);
		expect(coarse).toEqual(COARSE_TARGET);
	});

	it('sizes the target through min-size in the row flow, never an overlay', () => {
		for (const button of render().findAll('button')) {
			const classes = button.classes().join(' ');
			// A pseudo-element or absolutely positioned hit area would reach into
			// the neighbouring control; the target is the button's own box.
			expect(classes).not.toMatch(/before:|after:|absolute|-m[xy]?-/);
		}
	});
});
