import de from '~~/i18n/locales/de.json';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConvexError } from 'convex/values';
import { useOperationErrorToast } from '../useOperationErrorToast';
import { SurfacedOperationError } from '~/lib/operationError';
import { createTestI18n } from '~/__tests__/i18n';

/** The real catalog: the assertions below are assertions about English. */
const i18n = createTestI18n();
i18n.global.setLocaleMessage('de', de);

describe('useOperationErrorToast', () => {
	let showToast: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		i18n.global.locale.value = 'en';
		showToast = vi.fn();
		vi.stubGlobal('useI18n', () => i18n.global);
		vi.stubGlobal('useToast', () => ({ showToast }));
	});

	it('reads the current locale for a backend refusal', () => {
		const { showOperationError } = useOperationErrorToast();
		i18n.global.locale.value = 'de';
		showOperationError(new ConvexError({ category: 'invalid_input', message: 'Backend English' }));
		expect(showToast).toHaveBeenCalledWith(
			de.shared.operationError.categories.invalid_input,
			'error'
		);
	});

	it('toasts an uncategorized throw as the generic line', () => {
		const { showOperationError } = useOperationErrorToast();

		expect(showOperationError(new Error('boom'))).toBe(true);
		expect(showToast).toHaveBeenCalledWith('Something went wrong. Please try again.', 'error');
	});

	it('prefers the surface fallback over the generic line', () => {
		const { showOperationError } = useOperationErrorToast();

		showOperationError(
			new Error('boom'),
			'components.postbox.postboxThreadReader.attachmentDownloadFailed'
		);

		expect(showToast).toHaveBeenCalledWith(
			'That attachment could not be downloaded. Try again.',
			'error'
		);
	});

	it('shows a backend refusal in the backend’s own words', () => {
		const { showOperationError } = useOperationErrorToast();

		showOperationError(
			new ConvexError({ category: 'forbidden', message: 'This mailbox is not yours' }),
			'components.postbox.postboxThreadReader.attachmentDownloadFailed'
		);

		expect(showToast).toHaveBeenCalledWith('This mailbox is not yours', 'error');
	});

	// The whole reason the sentinel exists: the composer's `send` re-throws a
	// refusal the operation module has already toasted, purely to keep the
	// composer open. Toasting it again would double every rejected send.
	it('stays silent for a failure an Operation module already surfaced', () => {
		const { showOperationError } = useOperationErrorToast();

		expect(showOperationError(new SurfacedOperationError('Send failed'))).toBe(false);
		expect(showToast).not.toHaveBeenCalled();
	});
});
