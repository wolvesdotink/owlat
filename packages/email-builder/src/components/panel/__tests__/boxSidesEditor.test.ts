// @vitest-environment happy-dom
//
// One control edits both padding and margin. These pin the behaviour the two
// former copies (SpacingEditor, MarginEditor) shared: the initial mode is the
// first offered mode whose equality rule holds, switching mode re-emits the
// paired sides, and the per-side inputs clamp to 0..max.
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import BoxSidesEditor from '../BoxSidesEditor.vue';
import type { EditorBlock } from '../../../types';

const textBlock = (sides: Record<string, number>): EditorBlock =>
	({
		id: 'b1',
		type: 'text',
		content: {
			html: '<p>x</p>',
			blockType: 'paragraph',
			fontSize: 16,
			textColor: '#000',
			...sides,
		},
	}) as unknown as EditorBlock;

const PADDING_MODES = ['uniform', 'axis', 'individual'] as const;
const MARGIN_MODES = ['axis', 'individual'] as const;

let wrapper: VueWrapper | null = null;

function mountEditor(props: {
	block: EditorBlock;
	prefix: 'padding' | 'margin';
	modes: readonly ('uniform' | 'axis' | 'individual')[];
	max?: number;
}) {
	wrapper = mount(BoxSidesEditor, { props });
	return wrapper;
}

const pressed = (w: VueWrapper) =>
	w
		.findAll('[role="group"] button')
		.filter((b) => b.attributes('aria-pressed') === 'true')
		.map((b) => b.attributes('aria-label'));

const updates = (w: VueWrapper) => (w.emitted('update') ?? []) as [string, unknown][];

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

describe('BoxSidesEditor', () => {
	it('labels the toggle and buttons from the prefix', () => {
		const padding = mountEditor({ block: textBlock({}), prefix: 'padding', modes: PADDING_MODES });
		expect(padding.get('[role="group"]').attributes('aria-label')).toBe('Padding mode');
		expect(padding.findAll('[role="group"] button').map((b) => b.attributes('title'))).toEqual([
			'Uniform padding',
			'Vertical & horizontal pairs',
			'Individual sides',
		]);
		padding.unmount();

		const margin = mountEditor({ block: textBlock({}), prefix: 'margin', modes: MARGIN_MODES });
		expect(margin.get('[role="group"]').attributes('aria-label')).toBe('Margin mode');
		expect(margin.findAll('[role="group"] button').map((b) => b.attributes('title'))).toEqual([
			'Vertical & horizontal pairs',
			'Individual sides',
		]);
	});

	describe('auto-detects the initial mode', () => {
		it('picks uniform padding when all four sides match', () => {
			const w = mountEditor({
				block: textBlock({ paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 8 }),
				prefix: 'padding',
				modes: PADDING_MODES,
			});
			expect(pressed(w)).toEqual(['Uniform padding']);
			expect(w.get('input[aria-label="Padding on all sides"]').element).toBeTruthy();
		});

		it('picks axis for the padding defaults (16/24/16/24)', () => {
			const w = mountEditor({ block: textBlock({}), prefix: 'padding', modes: PADDING_MODES });
			expect(pressed(w)).toEqual(['Vertical & horizontal pairs']);
			expect(
				(w.get('input[aria-label="Vertical padding"]').element as HTMLInputElement).value
			).toBe('16');
			expect(
				(w.get('input[aria-label="Horizontal padding"]').element as HTMLInputElement).value
			).toBe('24');
		});

		it('picks individual when no pair rule holds', () => {
			const w = mountEditor({
				block: textBlock({ marginTop: 4, marginBottom: 12 }),
				prefix: 'margin',
				modes: MARGIN_MODES,
			});
			expect(pressed(w)).toEqual(['Individual sides']);
			const values = w
				.findAll('input[type="number"]')
				.map((i) => (i.element as HTMLInputElement).value);
			expect(values).toEqual(['4', '0', '12', '0']);
		});

		it('never picks uniform for margin, which does not offer it', () => {
			const w = mountEditor({ block: textBlock({}), prefix: 'margin', modes: MARGIN_MODES });
			expect(pressed(w)).toEqual(['Vertical & horizontal pairs']);
		});
	});

	it('switching margin to axis copies top to bottom and left to right', async () => {
		const w = mountEditor({
			block: textBlock({ marginTop: 10, marginRight: 3, marginBottom: 20, marginLeft: 6 }),
			prefix: 'margin',
			modes: MARGIN_MODES,
		});
		await w.get('button[title="Vertical & horizontal pairs"]').trigger('click');
		expect(updates(w)).toEqual([
			['marginBottom', 10],
			['marginRight', 6],
		]);
		expect(pressed(w)).toEqual(['Vertical & horizontal pairs']);
	});

	it('switching padding to uniform copies top to every other side', async () => {
		const w = mountEditor({
			block: textBlock({ paddingTop: 12 }),
			prefix: 'padding',
			modes: PADDING_MODES,
		});
		await w.get('button[title="Uniform padding"]').trigger('click');
		expect(updates(w)).toEqual([
			['paddingRight', 12],
			['paddingBottom', 12],
			['paddingLeft', 12],
		]);
	});

	it('clamps the per-side input to 0..max', async () => {
		const w = mountEditor({
			block: textBlock({ paddingTop: 1, paddingRight: 2, paddingBottom: 3, paddingLeft: 4 }),
			prefix: 'padding',
			modes: PADDING_MODES,
		});
		const top = w.get('input[aria-label="Top padding"]');
		await top.setValue('250');
		await top.setValue('-5');
		await top.setValue('abc');
		expect(updates(w)).toEqual([
			['paddingTop', 100],
			['paddingTop', 0],
			['paddingTop', 0],
		]);
		expect(top.attributes('max')).toBe('100');
	});

	it('honours a custom max', async () => {
		const w = mountEditor({
			block: textBlock({ marginTop: 1, marginRight: 2, marginBottom: 3, marginLeft: 4 }),
			prefix: 'margin',
			modes: MARGIN_MODES,
			max: 40,
		});
		await w.get('input[aria-label="Left margin"]').setValue('99');
		expect(updates(w)).toEqual([['marginLeft', 40]]);
	});
});
