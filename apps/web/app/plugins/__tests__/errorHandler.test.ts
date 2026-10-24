import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientErrorReporterKey } from '~/lib/clientErrorReporter';

/**
 * The global error toast. One failure tends to arrive as a burst (Vue errors
 * and unhandled rejections from the same cause), so repeats collapse into one
 * toast; the copy is the reader's language, resolved when the toast is shown;
 * and every occurrence still reaches diagnostics.
 */

type ToastOptions = { onDismiss?: () => void };
type RejectionListener = (event: { reason: unknown }) => void;

let showToast: ReturnType<typeof vi.fn>;
let capture: ReturnType<typeof vi.fn>;
let provide: ReturnType<typeof vi.fn>;
let onRejection: RejectionListener;
let vueApp: { config: { errorHandler?: (error: unknown, instance: null, info: string) => void } };

const COPY: Record<string, Record<string, string>> = {
	en: { 'shell.error.toast': 'Something went wrong. Please refresh and try again.' },
	de: {
		'shell.error.toast':
			'Etwas ist schiefgelaufen. Lade die Seite neu und versuche es noch einmal.',
	},
};
const ENGLISH = COPY['en']!['shell.error.toast'];
const GERMAN = COPY['de']!['shell.error.toast'];

function fakeI18n(locale: { value: string }) {
	return {
		t: (key: string) => COPY[locale.value]?.[key] ?? key,
		te: (key: string) => key in (COPY[locale.value] ?? {}),
	};
}

async function loadPlugin(i18n: unknown) {
	showToast = vi.fn();
	capture = vi.fn();
	provide = vi.fn();
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: unknown) => {
		if (type === 'unhandledrejection') onRejection = listener as RejectionListener;
	}) as typeof window.addEventListener);
	vueApp = { config: {} };
	const plugin = (await import('../error-handler.client')).default as unknown as (
		app: unknown
	) => void;
	plugin({
		vueApp: Object.assign(vueApp, { provide }),
		$i18n: i18n,
		$posthog: { value: { capture } },
	});
}

const vueError = (message = 'render failed') =>
	vueApp.config.errorHandler!(new Error(message), null, 'render function');

/** The `onDismiss` of the n-th toast shown. */
const dismiss = (n: number) => (showToast.mock.calls[n]![2] as ToastOptions).onDismiss!();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('error toast: collapsing repeats', () => {
	it('shows one toast for a burst from both entry points, and reports every error', async () => {
		await loadPlugin(fakeI18n({ value: 'en' }));

		vueError();
		vueError();
		onRejection({ reason: new Error('rejected') });
		onRejection({ reason: 'not an error' });

		expect(showToast).toHaveBeenCalledTimes(1);
		expect(showToast).toHaveBeenCalledWith(ENGLISH, 'error', expect.any(Object));
		expect(capture).toHaveBeenCalledTimes(4);
		expect(capture.mock.calls.map((call) => call[1].$exception_source)).toEqual([
			'vue:render function',
			'vue:render function',
			'unhandledrejection',
			'unhandledrejection',
		]);
		expect(capture.mock.calls[3]![1].$exception_message).toBe('not an error');
	});

	it('shows a new toast once the last one is gone and the window has passed', async () => {
		await loadPlugin(fakeI18n({ value: 'en' }));
		vueError();
		dismiss(0);

		vi.advanceTimersByTime(2999);
		vueError();
		expect(showToast).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1);
		vueError();
		expect(showToast).toHaveBeenCalledTimes(2);
	});

	it('adds no second toast while the first is still on screen', async () => {
		await loadPlugin(fakeI18n({ value: 'en' }));
		vueError();

		vi.advanceTimersByTime(60_000);
		onRejection({ reason: new Error('later') });
		expect(showToast).toHaveBeenCalledTimes(1);

		dismiss(0);
		onRejection({ reason: new Error('after dismissal') });
		expect(showToast).toHaveBeenCalledTimes(2);
	});
});

describe('error toast: copy', () => {
	it('uses the current language for each toast', async () => {
		const locale = { value: 'de' };
		await loadPlugin(fakeI18n(locale));
		vueError();
		expect(showToast.mock.calls[0]![0]).toBe(GERMAN);

		dismiss(0);
		vi.advanceTimersByTime(3000);
		locale.value = 'en';
		vueError();
		expect(showToast.mock.calls[1]![0]).toBe(ENGLISH);
	});

	it('falls back to the English sentence, never a key path, before i18n is ready', async () => {
		await loadPlugin(undefined);
		vueError();
		expect(showToast.mock.calls[0]![0]).toBe(ENGLISH);
	});

	it('falls back to the English sentence while the catalog lacks the key', async () => {
		await loadPlugin({ t: (key: string) => key, te: () => false });
		vueError();
		expect(showToast.mock.calls[0]![0]).toBe(ENGLISH);
	});
});

describe('error reporter for pane boundaries', () => {
	it('provides a reporter that ships to diagnostics without a toast', async () => {
		await loadPlugin(fakeI18n({ value: 'en' }));
		expect(provide).toHaveBeenCalledWith(
			'owlat:client-error-reporter' satisfies ClientErrorReporterKey,
			expect.any(Function)
		);

		const report = provide.mock.calls[0]![1] as (error: unknown, source: string) => void;
		report(new Error('reader failed'), 'boundary:reader:render function');

		expect(showToast).not.toHaveBeenCalled();
		expect(capture).toHaveBeenCalledWith(
			'$exception',
			expect.objectContaining({
				$exception_message: 'reader failed',
				$exception_source: 'boundary:reader:render function',
			})
		);
	});
});
