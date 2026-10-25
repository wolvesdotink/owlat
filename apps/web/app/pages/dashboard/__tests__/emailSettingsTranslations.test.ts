/**
 * The template Settings page saves the whole `translations` blob it read. When
 * the stored blob cannot be read the page shows no translations, so a save
 * would write blank overlays over the text the row still holds. The page must
 * say so and write nothing, through every way a save can start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { api } from '@owlat/api';
import { getFunctionName } from 'convex/server';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import SettingsPage from '../send/emails/[id]/settings.vue';

const CONTENT = JSON.stringify([
	{ id: 'b1', type: 'text', content: { html: '<p>Hello world</p>' } },
]);

const STORED_DE = {
	subject: 'Deutscher Betreff',
	previewText: 'Vorschau',
	blocks: { b1: { html: '<p>Hallo Welt</p>' } },
};

const row = (translations: string | undefined) => ({
	_id: 'tmpl_1',
	type: 'marketing' as const,
	status: 'draft',
	subject: 'English subject',
	previewText: '',
	defaultLanguage: 'en',
	supportedLanguages: ['en', 'de'],
	content: CONTENT,
	contentRevision: 7,
	translations,
});

/** The subject card as a plain input, so a test can make the form dirty. */
const SubjectCard = defineComponent({
	props: { subject: { type: String, default: '' } },
	emits: ['update:subject'],
	setup(props, { emit }) {
		return () =>
			h('input', {
				class: 'subject',
				value: props.subject,
				onInput: (event: Event) => emit('update:subject', (event.target as HTMLInputElement).value),
			});
	},
});

const Button = defineComponent({
	props: { disabled: Boolean, loading: Boolean },
	emits: ['click'],
	setup(props, { emit, slots }) {
		return () =>
			h(
				'button',
				{ class: 'ui-button', disabled: props.disabled, onClick: () => emit('click') },
				slots['default']?.()
			);
	},
});

const Passthrough = defineComponent({
	setup(_props, { slots }) {
		return () => h('div', slots['default']?.());
	},
});

const updateRef = api.emailTemplates.emails.update;
let update: ReturnType<typeof vi.fn>;
/** Type change and default-language swap; no case here may reach them. */
let otherWrite: ReturnType<typeof vi.fn>;
let showOperationError: ReturnType<typeof vi.fn>;
let onSave: (() => Promise<void>) | undefined;
let mounted: VueWrapper[] = [];

function mountWith(translations: string | undefined) {
	vi.stubGlobal('useConvexQuery', () => ({
		data: ref(row(translations)),
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
	const w = mount(SettingsPage, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				EmailSubjectSettingsCard: SubjectCard,
				EmailTranslationsCard: true,
				UiButton: Button,
				UiCard: Passthrough,
				UiQueryBoundary: Passthrough,
				UiUnsavedChangesDialog: true,
				UiSpinner: true,
				Icon: true,
			},
		},
	});
	mounted.push(w);
	return w;
}

const saveButton = (w: VueWrapper) =>
	w.findAll('button.ui-button').find((b) => b.text().includes('Save changes'))!;

async function editSubject(w: VueWrapper) {
	await w.get('input.subject').setValue('A new subject');
	await flushPromises();
}

beforeEach(() => {
	update = vi.fn().mockResolvedValue({ ok: true, result: { contentRevision: 8 } });
	otherWrite = vi.fn().mockResolvedValue({ ok: true, result: null });
	showOperationError = vi.fn();
	onSave = undefined;
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
	vi.stubGlobal('useRouteId', () => ref('tmpl_1'));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useOperationErrorToast', () => ({ showOperationError }));
	vi.stubGlobal('useEmailTheme', () => ({ emailTheme: ref(undefined) }));
	vi.stubGlobal('useBackendOperation', (fn: unknown) =>
		getFunctionName(fn as typeof updateRef) === getFunctionName(updateRef)
			? { run: update }
			: { run: otherWrite }
	);
	vi.stubGlobal('useUnsavedChanges', (opts: { onSave: () => Promise<void> }) => {
		onSave = opts.onSave;
		return {
			showDialog: ref(false),
			isSavingBeforeLeave: ref(false),
			confirmDiscard: vi.fn(),
			confirmSave: vi.fn(),
			cancelNavigation: vi.fn(),
			setHasChanges: vi.fn(),
		};
	});
});

afterEach(() => {
	for (const w of mounted) w.unmount();
	mounted = [];
});

describe('email Settings page over stored translations', () => {
	it('saves an edit with the stored overlay text kept', async () => {
		const w = mountWith(JSON.stringify({ de: STORED_DE }));
		await flushPromises();
		expect(w.text()).not.toContain('Translations could not be read');

		await editSubject(w);
		await saveButton(w).trigger('click');
		await flushPromises();

		expect(update).toHaveBeenCalledOnce();
		const write = update.mock.calls[0]![0] as { translations: string; subject: string };
		expect(write.subject).toBe('A new subject');
		expect(JSON.parse(write.translations)).toEqual({ de: STORED_DE });
	});

	it.each([
		['a language that is not an overlay', JSON.stringify({ de: 'Recoverable stored text' })],
		['text that is not JSON', 'not json'],
		['an overlay with a non-string subject', JSON.stringify({ de: { subject: 42 } })],
	])('writes nothing over %s', async (_case, stored) => {
		const w = mountWith(stored);
		await flushPromises();

		expect(w.get('[role="alert"]').text()).toContain('Translations could not be read');
		await editSubject(w);
		expect(saveButton(w).attributes('disabled')).toBeDefined();

		// The leave dialog's Save starts the same save without the button.
		await expect(onSave!()).rejects.toThrow('Save failed');
		await saveButton(w).trigger('click');
		await flushPromises();

		expect(update).not.toHaveBeenCalled();
		expect(otherWrite).not.toHaveBeenCalled();
	});
});
