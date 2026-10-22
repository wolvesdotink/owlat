/**
 * EVERY CONFIRMATION DIALOG HAS A NAME AND A DESCRIPTION.
 *
 * UiConfirmationDialog draws its own heading and lead inside the body and never
 * passed UiModal a `title` (that would add a second, visible header), and
 * UiModal only wired `aria-labelledby` to that `title`. Every confirmation in
 * the app was therefore an unnamed dialog, with a description no assistive
 * technology was told about. The dialog now hands UiModal per-instance ids for
 * both, and the `#description` slot renders inside the element that carries
 * the description id.
 *
 * The ids have to be per instance: a confirmation can open over another one
 * (or over a page dialog), and a shared id would name both dialogs after
 * whichever heading comes first in the document.
 */
import { describe, expect, it } from 'vitest';
import { defineComponent, h, resolveComponent } from 'vue';
import { auditA11y } from '~/__tests__/a11y';
import { createTestI18n } from '~/__tests__/i18n';

/** Text of every element an `aria-labelledby`/`aria-describedby` list points at. */
function referencedText(ids: string | undefined | null): string {
	return (ids ?? '')
		.split(/\s+/)
		.filter(Boolean)
		.map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
		.join(' ')
		.trim();
}

/** Each id in the list resolves to exactly one element in the document. */
function resolvesUniquely(ids: string | undefined | null): boolean {
	const list = (ids ?? '').split(/\s+/).filter(Boolean);
	return (
		list.length > 0 &&
		list.every((id) => document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length === 1)
	);
}

function dialogs(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
}

type DialogSpec = {
	props: Record<string, unknown>;
	/** Rich copy for the `#description` slot, rendered as `<p>Delete <strong>…</strong>?</p>`. */
	slotName?: string;
};

/** A page that has the given confirmation dialogs open at once. */
function host(specs: DialogSpec[]) {
	return defineComponent({
		setup() {
			return () =>
				h(
					'div',
					specs.map(({ props, slotName }) =>
						h(
							resolveComponent('UiConfirmationDialog'),
							{ open: true, ...props },
							slotName
								? {
										description: () =>
											h('p', ['Delete ', h('strong', slotName), '? Its contacts stay.']),
									}
								: undefined
						)
					)
				);
		},
	});
}

const audit = (specs: DialogSpec[], prepare?: () => void) =>
	auditA11y(host(specs), { global: { plugins: [createTestI18n()] }, prepare });

describe('UiConfirmationDialog — accessible name and description', () => {
	it('names and describes two stacked dialogs from their own copy', async () => {
		const violations = await audit(
			[
				{ props: { title: 'Discard draft', description: 'The draft is gone for good.' } },
				{ props: { title: 'Delete topic', variant: 'danger' }, slotName: 'Beta program' },
			],
			() => {
				const [first, second] = dialogs();
				expect(first && second).toBeTruthy();
				if (!first || !second) return;

				expect(referencedText(first.getAttribute('aria-labelledby'))).toBe('Discard draft');
				expect(referencedText(second.getAttribute('aria-labelledby'))).toBe('Delete topic');
				expect(referencedText(first.getAttribute('aria-describedby'))).toBe(
					'The draft is gone for good.'
				);
				// The rich slot is what the second dialog is described by, markup and all.
				expect(referencedText(second.getAttribute('aria-describedby'))).toBe(
					'Delete Beta program? Its contacts stay.'
				);

				const ids = [first, second].flatMap((dialog) => [
					dialog.getAttribute('aria-labelledby'),
					dialog.getAttribute('aria-describedby'),
				]);
				expect(new Set(ids).size).toBe(4);
				for (const id of ids) expect(resolvesUniquely(id)).toBe(true);
				// Each dialog points inside itself, never at the other one's copy.
				for (const dialog of [first, second]) {
					for (const attr of ['aria-labelledby', 'aria-describedby']) {
						const target = document.getElementById(dialog.getAttribute(attr) ?? '');
						expect(dialog.contains(target)).toBe(true);
					}
				}
			}
		);
		expect(violations).toEqual([]);
	});

	it('falls back to the localized default copy for the name and description', async () => {
		const violations = await audit([{ props: {} }], () => {
			const [dialog] = dialogs();
			expect(referencedText(dialog?.getAttribute('aria-labelledby'))).toBe('Are you sure?');
			expect(referencedText(dialog?.getAttribute('aria-describedby'))).toBe(
				'This action cannot be undone.'
			);
		});
		expect(violations).toEqual([]);
	});

	it.each([
		['default', { props: { title: 'Archive campaign' } }],
		['danger', { props: { title: 'Delete contact', variant: 'danger' } }],
		['warning', { props: { title: 'Pause sending', variant: 'warning' } }],
		['slot description', { props: { title: 'Delete topic' }, slotName: 'Beta program' }],
	] as const)('has no axe violations for the %s variant', async (_label, spec) => {
		expect(await audit([spec as DialogSpec])).toEqual([]);
	});
});
