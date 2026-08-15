import { afterEach, describe, expect, it } from 'vitest';
import { createForeignI18n, mountUi, type MountedUi } from '../../__tests__/i18n';
import Bars from '../ui/Bars.vue';
import ErrorAlert from '../ui/ErrorAlert.vue';
import ProgressBar from '../ui/ProgressBar.vue';
import Select from '../ui/Select.vue';
import StepIndicator from '../ui/StepIndicator.vue';
import ThemeToggle from '../ui/ThemeToggle.vue';

/**
 * The layer's own copy, rendered the way a user meets it.
 *
 * Every string these components used to hardcode is now a `ui.*` message, and
 * the two ways that breaks are invisible to a type checker: a keypath typo
 * paints `ui.chart.empty` into the page, and a prop default that still holds
 * English copy silently outranks the translation. Both are visible here,
 * because each case asserts on the rendered text / accessible name — including
 * in German, which is what proves the catalogs are wired to the same keys.
 */

let mounted: MountedUi | null = null;

function mount(...args: Parameters<typeof mountUi>): HTMLElement {
	mounted = mountUi(...args);
	return mounted.el;
}

afterEach(() => {
	mounted?.unmount();
	mounted = null;
});

const barsData = [
	{ label: 'Mon', value: 3 },
	{ label: 'Tue', value: 7 },
];

describe('localized layer copy', () => {
	it('renders the chart empty state and the default plot name', () => {
		expect(mount(Bars, { data: [] }).textContent).toContain('No data yet');
		expect(
			mount(Bars, { data: barsData }).querySelector('[role="group"]')?.getAttribute('aria-label')
		).toBe('Bar chart');
	});

	it('translates the chart empty state', () => {
		expect(mount(Bars, { data: [] }, 'de').textContent).toContain('Noch keine Daten');
	});

	it('keeps a caller-supplied plot name over the localized default', () => {
		const el = mount(Bars, { data: barsData, ariaLabel: 'Sends per day' });
		expect(el.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Sends per day');
	});

	it('titles an alert from its variant', () => {
		expect(mount(ErrorAlert, { message: 'boom', variant: 'warning' }).textContent).toContain(
			'Warning'
		);
		expect(mount(ErrorAlert, { message: 'boom', variant: 'warning' }, 'de').textContent).toContain(
			'Warnung'
		);
	});

	it('announces indeterminate progress', () => {
		const bar = mount(ProgressBar, { indeterminate: true }).querySelector('[role="progressbar"]');
		expect(bar?.getAttribute('aria-valuetext')).toBe('Loading…');
	});

	it('falls back to the localized select placeholder', () => {
		expect(mount(Select, { options: [], modelValue: null }).textContent).toContain(
			'Select an option'
		);
		expect(mount(Select, { options: [], modelValue: null }, 'de').textContent).toContain(
			'Bitte wählen Sie eine Option'
		);
	});

	it('names the step nav and its back-links, interpolating the step label', () => {
		const props = {
			steps: [{ id: 'details', label: 'Details', number: 1 }],
			getStepStatus: () => 'completed' as const,
			isConnectorHighlighted: () => false,
			onStepClick: () => {},
		};
		const english = mount(StepIndicator, props);
		expect(english.querySelector('nav')?.getAttribute('aria-label')).toBe('Progress');
		expect(english.querySelector('button')?.getAttribute('aria-label')).toBe('Go back to Details');
		mounted?.unmount();

		const german = mount(StepIndicator, props, 'de');
		expect(german.querySelector('nav')?.getAttribute('aria-label')).toBe('Fortschritt');
		expect(german.querySelector('button')?.getAttribute('aria-label')).toBe('Zurück zu Details');
	});

	// A layer cannot require a module of the apps that extend it, so the two
	// hosts it may legitimately meet — no vue-i18n at all, and a vue-i18n that
	// carries only the app's own catalog (which is what an app's component test
	// installs) — must still read as English rather than as key paths. See
	// composables/useUiI18n.ts.
	it('renders English when the host has no vue-i18n', () => {
		const el = mount(Bars, { data: [] }, 'en', null);
		expect(el.textContent).toContain('No data yet');
		expect(el.textContent).not.toContain('ui.chart');
	});

	it('renders English when the host i18n carries no ui.* messages', () => {
		const el = mount(Select, { options: [], modelValue: null }, 'en', createForeignI18n());
		expect(el.textContent).toContain('Select an option');
		expect(el.textContent).not.toContain('ui.select');
	});

	it('labels the theme toggle with the active mode', () => {
		const button = mount(ThemeToggle).querySelector('button');
		expect(button?.getAttribute('title')).toBe('System preference');
		expect(button?.getAttribute('aria-label')).toBe('Theme: System preference. Click to change.');
		mounted?.unmount();

		const german = mount(ThemeToggle, {}, 'de').querySelector('button');
		expect(german?.getAttribute('aria-label')).toBe(
			'Design: Systemeinstellung. Klicken Sie, um zu wechseln.'
		);
	});
});
