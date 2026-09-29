import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createI18n } from 'vue-i18n';
import { resolveLocalized, type LocalizedText } from '../localizedText';
import type { QuarantineText } from '../quarantineReason';
import type { SealLockText } from '../sealComposer';
import type { SenderAuthText } from '../senderAuth';
import type { TransportText } from '../transportState';

/**
 * A small catalog pair rather than the app's: the cases are about the policy
 * (which strings are keys, where a missing translation lands), and a key that
 * exists in `en` but not in `de` has to exist on purpose.
 */
function i18nIn(locale: 'en' | 'de') {
	const missing = vi.fn((_locale: string, key: string) => key);
	const i18n = createI18n({
		legacy: false,
		locale,
		fallbackLocale: 'en',
		missing,
		missingWarn: false,
		fallbackWarn: false,
		messages: {
			en: {
				status: { paused: 'Paused', sent: 'Sent {count} messages' },
				onlyEnglish: { hint: 'Try again later' },
			},
			de: {
				status: { paused: 'Pausiert', sent: '{count} Nachrichten gesendet' },
			},
		},
	});
	return { i18n: i18n.global, missing };
}

describe('resolveLocalized', () => {
	afterEach(() => vi.restoreAllMocks());

	it('translates a bare key in the active locale', () => {
		expect(resolveLocalized(i18nIn('en').i18n, 'status.paused')).toBe('Paused');
		expect(resolveLocalized(i18nIn('de').i18n, 'status.paused')).toBe('Pausiert');
	});

	it('falls back to English for a key the active locale has not caught up with', () => {
		const { i18n } = i18nIn('de');
		expect(resolveLocalized(i18n, 'onlyEnglish.hint')).toBe('Try again later');
	});

	it('returns a string that is no key verbatim, without a missing-key lookup', () => {
		const { i18n, missing } = i18nIn('de');
		expect(resolveLocalized(i18n, 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
		expect(resolveLocalized(i18n, 'The relay refused: 550 5.7.1')).toBe(
			'The relay refused: 550 5.7.1'
		);
		expect(missing).not.toHaveBeenCalled();
	});

	it('translates an object with its params', () => {
		expect(resolveLocalized(i18nIn('en').i18n, { key: 'status.sent', params: { count: 3 } })).toBe(
			'Sent 3 messages'
		);
		expect(resolveLocalized(i18nIn('de').i18n, { key: 'status.sent', params: { count: 3 } })).toBe(
			'3 Nachrichten gesendet'
		);
	});

	it('translates an object without params', () => {
		expect(resolveLocalized(i18nIn('en').i18n, { key: 'status.paused' })).toBe('Paused');
	});

	it('renders null and undefined as nothing', () => {
		const { i18n } = i18nIn('en');
		expect(resolveLocalized(i18n, null)).toBe('');
		expect(resolveLocalized(i18n, undefined)).toBe('');
		expect(resolveLocalized(i18n, '')).toBe('');
	});

	it('accepts the narrower-params message types', () => {
		expectTypeOf<SenderAuthText>().toMatchTypeOf<LocalizedText>();
		expectTypeOf<SealLockText>().toMatchTypeOf<LocalizedText>();
		expectTypeOf<QuarantineText>().toMatchTypeOf<LocalizedText>();
		expectTypeOf<TransportText>().toMatchTypeOf<LocalizedText>();
	});
});

describe('useLocalized', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it('binds the resolver to the component i18n instance', async () => {
		const { i18n } = i18nIn('de');
		vi.stubGlobal('useI18n', () => i18n);
		const { useLocalized } = await import('~/composables/useLocalized');
		const localized = useLocalized();
		expect(localized('status.paused')).toBe('Pausiert');
		expect(localized('onlyEnglish.hint')).toBe('Try again later');
		expect(localized('Amazon SES')).toBe('Amazon SES');
		expect(localized(null)).toBe('');
	});
});
