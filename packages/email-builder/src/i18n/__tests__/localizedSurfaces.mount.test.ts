// @vitest-environment happy-dom
//
// Issue #1444: the designer and the previewer render in the host app's
// language. Each surface is mounted the way apps/web mounts it — under the
// app's vue-i18n, whose catalog does NOT contain the builder's messages — and
// read back as a user (visible text) and a screen reader (accessible names)
// meet it.
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import EditorHeader from '../../components/EditorHeader.vue';
import KeyboardShortcutsDialog from '../../components/dialogs/KeyboardShortcutsDialog.vue';
import PropertyField from '../../components/panel/PropertyField.vue';
import CompatibilityTab from '../../preview/components/analysis/CompatibilityTab.vue';
import HealthTab from '../../preview/components/analysis/HealthTab.vue';
import SizeTab from '../../preview/components/analysis/SizeTab.vue';
import ValidationTab from '../../preview/components/analysis/ValidationTab.vue';
import DiffPanel from '../../preview/components/DiffPanel.vue';
import type {
	CompatibilityReport,
	PreviewEmailDiff,
	PreviewHealthScore,
} from '../../preview/types';
import { textSchema } from '../../schema/definitions/text';
import type { TextBlockContent } from '../../types';
import { defaultTheme } from '../../defaults';
import { createBlock } from '../../utils/blocks';
import { blockAccessibleLabel } from '../../utils/blockLabel';
import { translate, translateLabel } from '../useBuilderI18n';
import { createHostI18n } from './hostI18n';

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

function mountIn<T>(component: T, props: Record<string, unknown>, locale: 'en' | 'de' = 'de') {
	const i18n = createHostI18n(locale);
	wrapper = mount(component as never, {
		props: props as never,
		global: { plugins: [i18n] },
		attachTo: document.body,
	});
	return { w: wrapper, i18n };
}

const headerProps = {
	name: 'October update',
	subject: 'News',
	previewMode: 'edit' as const,
	isFocusMode: false,
	isSaving: false,
	isGeneratingHtml: false,
	hideSubject: false,
	canUndo: true,
	canApplyBrand: true,
};

describe('editor header', () => {
	it('names its controls in German', () => {
		const { w } = mountIn(EditorHeader, headerProps);
		const labels = w.findAll('[aria-label]').map((el) => el.attributes('aria-label'));
		expect(labels).toEqual(
			expect.arrayContaining([
				'Zurück',
				'Name der Vorlage',
				'Betreffzeile der E-Mail',
				'Fokusmodus starten',
				'Rückgängig (Strg + Z)',
				'Wiederholen (Strg + Umschalt + Z)',
				'Tastenkürzel',
				'Markenkit anwenden',
			])
		);
		expect(w.get('input[aria-label="Betreffzeile der E-Mail"]').attributes('placeholder')).toBe(
			'Betreffzeile der E-Mail'
		);
		expect(w.text()).toContain('Bearbeiten');
		expect(w.text()).toContain('Vorschau');
		expect(w.text()).toContain('Speichern');
		expect(w.text()).not.toMatch(/\b(Back|Preview|Save)\b/);
	});

	it('switches language with the host, without remounting', async () => {
		const { w, i18n } = mountIn(EditorHeader, headerProps, 'en');
		expect(w.find('[aria-label="Back"]').exists()).toBe(true);
		expect(w.text()).toContain('Save');

		i18n.global.locale.value = 'de';
		await nextTick();
		expect(w.find('[aria-label="Back"]').exists()).toBe(false);
		expect(w.find('[aria-label="Zurück"]').exists()).toBe(true);
		expect(w.text()).toContain('Speichern');
	});

	it('stays English for a host without vue-i18n', () => {
		wrapper = mount(EditorHeader, { props: headerProps });
		expect(wrapper.find('[aria-label="Back"]').exists()).toBe(true);
		expect(wrapper.find('[aria-label="Undo (Ctrl + Z)"]').exists()).toBe(true);
	});
});

describe('keyboard shortcuts sheet', () => {
	it('lists groups, descriptions and key chips in German', async () => {
		mountIn(KeyboardShortcutsDialog, { show: true });
		await nextTick();
		const sheet = document.body.textContent ?? '';
		expect(sheet).toContain('Tastenkürzel');
		expect(sheet).toContain('Allgemein');
		expect(sheet).toContain('Ausgewählten Block duplizieren');
		expect(sheet).toContain('Strg');
		expect(sheet).toContain('Entf');
		expect(sheet).not.toContain('Duplicate selected block');
	});
});

describe('property panel', () => {
	it('translates schema labels and options, never the stored value', () => {
		const typeField = textSchema.groups[0]!.fields.find((field) => field.key === 'blockType')!;
		const { w } = mountIn(PropertyField, {
			field: typeField,
			value: 'paragraph',
			block: createBlock('text', defaultTheme),
			theme: defaultTheme,
		});
		expect(w.text()).toContain('Typ');
		expect(w.text()).toContain('Absatz');
		expect(w.get('button[aria-haspopup="listbox"]').attributes('aria-label')).toBe('Typ');
		// The registry entry keeps its English source and value.
		expect(typeField.label).toBe('Type');
		expect(typeField.options?.[0]).toEqual({ label: 'Paragraph', value: 'paragraph' });
	});
});

describe('canvas accessible names', () => {
	it('names a block in the given language', () => {
		const german = {
			t: (key: string, params?: Record<string, string | number>) => translate('de', key, params),
			label: (source: string) => translateLabel('de', source),
		};
		const columns = createBlock('columns', defaultTheme);
		const emptyText = createBlock('text', defaultTheme);
		(emptyText.content as TextBlockContent).html = '';
		expect(blockAccessibleLabel(columns, german)).toBe('Spalten: 2 Spalten');
		expect(blockAccessibleLabel(emptyText, german)).toBe('Text: leer');
		expect(blockAccessibleLabel(columns)).toBe('Columns: 2 columns');
	});
});

describe('previewer analysis', () => {
	const report: CompatibilityReport = {
		score: 60,
		testedClients: ['Outlook (Windows)'],
		timestamp: new Date(0),
		issues: [
			{
				severity: 'error',
				feature: 'css-display-grid',
				message: 'CSS Grid is not supported in most email clients',
				messageKey: 'builder.analysis.compatibility.issues.grid',
				clients: [],
			},
			{ severity: 'error', feature: 'x', message: 'Host supplied note', clients: [] },
			{
				severity: 'warning',
				feature: 'css-max-width',
				message: 'Max width may not work in some clients',
				messageKey: 'builder.analysis.compatibility.issues.cssFeature',
				messageParams: { feature: 'Max width' },
				clients: [],
			},
		],
	};

	it('prompts for a client in German', () => {
		const { w } = mountIn(CompatibilityTab, {
			compatibilityReport: null,
			compatibilityError: null,
			selectedClientName: null,
			isAnalyzing: false,
		});
		expect(w.text()).toBe('Wähle oben ein E-Mail-Programm, um die Kompatibilität zu prüfen.');
	});

	it('counts and words compatibility issues in German', () => {
		const { w } = mountIn(CompatibilityTab, {
			compatibilityReport: report,
			compatibilityError: null,
			selectedClientName: 'Outlook (Windows)',
			isAnalyzing: false,
		});
		expect(w.text()).toContain('kompatibel');
		expect(w.text()).toContain('2 Fehler');
		expect(w.text()).toContain('1 Warnung');
		expect(w.text()).toContain('CSS Grid wird von den meisten E-Mail-Programmen nicht unterstützt');
		expect(w.text()).toContain('Max width funktioniert nicht in allen E-Mail-Programmen');
		// Text the builder did not write is shown as written.
		expect(w.text()).toContain('Host supplied note');
	});

	it('words the empty states in German', () => {
		expect(mountIn(HealthTab, { healthScore: null }).w.text()).toBe(
			'Keine Daten zum Zustand verfügbar.'
		);
		wrapper?.unmount();
		expect(mountIn(SizeTab, { emailAnalysis: null }).w.text()).toBe(
			'Keine Größenanalyse verfügbar.'
		);
		wrapper?.unmount();
		expect(mountIn(ValidationTab, { validationIssues: [] }).w.text()).toBe(
			'Keine Probleme gefunden.'
		);
	});

	it('labels the health score in German', () => {
		const healthScore: PreviewHealthScore = {
			overall: 94,
			compatibility: 87,
			accessibility: 100,
			deliverability: 100,
			outlookSupport: 87,
			recommendations: [{ category: 'compatibility', impact: 'high', message: 'Host message' }],
		} as PreviewHealthScore;
		const { w } = mountIn(HealthTab, { healthScore });
		expect(w.text()).toContain('Hervorragend');
		expect(w.text()).toContain('Barrierefreiheit');
		expect(w.text()).toContain('Empfehlungen');
		expect(w.text()).toContain('hoch');
	});

	it('summarizes a diff in German', () => {
		const diff = (changes: number): PreviewEmailDiff => ({
			identical: changes === 0,
			changes: Array.from({ length: changes }, () => ({
				type: 'modified',
				category: 'text',
				description: 'Heading changed',
			})) as PreviewEmailDiff['changes'],
			sizeDelta: 0,
			stats: {
				addedElements: 0,
				removedElements: 0,
				modifiedStyles: 0,
				textChanges: changes,
				linkChanges: 0,
				imageChanges: 0,
			},
		});
		expect(mountIn(DiffPanel, { emailDiff: diff(0) }).w.text()).toContain(
			'Keine Änderungen erkannt.'
		);
		wrapper?.unmount();
		expect(mountIn(DiffPanel, { emailDiff: diff(1) }).w.text()).toContain('1 Änderung erkannt');
		wrapper?.unmount();
		expect(mountIn(DiffPanel, { emailDiff: diff(3) }).w.text()).toContain('3 Änderungen erkannt');
	});
});
