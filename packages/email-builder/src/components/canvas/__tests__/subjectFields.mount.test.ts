// @vitest-environment happy-dom
//
// The subject line of a data-variable (transactional) email: `{{` opens the
// variable picker, the insert button adds a token at the caret, and a token
// naming no variable is flagged because the send path renders it empty.
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import SubjectFields from '../SubjectFields.vue';
import type { Variable } from '../../../types';

const variables: Variable[] = [
	{ key: 'firstName', label: 'firstName', type: 'string' },
	{ key: 'orderId', label: 'orderId', type: 'string' },
];

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

function mountFields(subject: string, extra: Record<string, unknown> = {}) {
	wrapper = mount(SubjectFields, {
		props: {
			name: 'Receipt',
			subject,
			hideSubject: false,
			variables,
			showDataVariables: true,
			dataVariables: variables,
			'onUpdate:subject': (value: string) => wrapper?.setProps({ subject: value }),
			...extra,
		},
		attachTo: document.body,
	});
	return wrapper;
}

const subjectInput = (w: VueWrapper) =>
	w.get<HTMLInputElement>('input[aria-label="Email subject line"]');

async function typeInto(w: VueWrapper, value: string) {
	const input = subjectInput(w);
	input.element.value = value;
	input.element.setSelectionRange(value.length, value.length);
	await input.trigger('input');
}

describe('SubjectFields', () => {
	it('opens the variable picker on {{ and inserts the picked key', async () => {
		const w = mountFields('Hi');
		await typeInto(w, 'Hi {{fir');
		const options = w.findAll('[role="option"]');
		expect(options.map((o) => o.text())).toEqual(['firstName']);
		expect(subjectInput(w).attributes('aria-expanded')).toBe('true');

		await subjectInput(w).trigger('keydown', { key: 'Enter' });
		expect(w.emitted('update:subject')?.at(-1)).toEqual(['Hi {{firstName}}']);
		expect(w.find('[role="option"]').exists()).toBe(false);
	});

	it('closes the picker on Escape without touching the subject', async () => {
		const w = mountFields('Hi');
		await typeInto(w, 'Hi {{');
		expect(w.findAll('[role="option"]')).toHaveLength(2);
		await subjectInput(w).trigger('keydown', { key: 'Escape' });
		expect(w.find('[role="option"]').exists()).toBe(false);
		expect(w.emitted('update:subject')?.at(-1)).toEqual(['Hi {{']);
	});

	it('appends a spaced token from the insert button', async () => {
		const w = mountFields('Your receipt');
		await w.get('[data-testid="subject-insert-variable"]').trigger('click');
		const second = w.findAll('[role="option"]')[1]!;
		await second.trigger('mousedown');
		expect(w.emitted('update:subject')?.at(-1)).toEqual(['Your receipt {{orderId}}']);
	});

	it('flags an unknown token and offers to define it', async () => {
		const w = mountFields('Hi {{frstName}}');
		expect(w.text()).toContain("isn't a variable of this email");
		const define = w.findAll('button').find((b) => b.text() === 'Define frstName');
		expect(define).toBeDefined();
		await define!.trigger('click');
		expect(w.emitted('add-variable')?.at(-1)).toEqual(['frstName']);
	});

	it('warns about an empty subject', () => {
		const w = mountFields('   ');
		expect(w.text()).toContain('No subject yet');
		expect(subjectInput(w).attributes('aria-describedby')).toBeTruthy();
	});

	it('hides the insert button when there is nothing to insert', () => {
		const w = mountFields('Hi', { variables: [], dataVariables: [] });
		expect(w.find('[data-testid="subject-insert-variable"]').exists()).toBe(false);
		expect(subjectInput(w).attributes('placeholder')).toBe('Email subject line');
	});
});
