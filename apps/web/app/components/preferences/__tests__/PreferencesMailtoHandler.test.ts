/**
 * The Email links card: asks this browser to open `mailto:` links on the
 * compose page, says what the browser answered as far as a page can tell, and
 * always says where the registration is undone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import PreferencesMailtoHandler from '../PreferencesMailtoHandler.vue';

let registerProtocolHandler: ReturnType<typeof vi.fn> | undefined;
let secure: boolean;

beforeEach(() => {
	registerProtocolHandler = vi.fn();
	secure = true;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	Object.defineProperty(window, 'isSecureContext', { configurable: true, get: () => secure });
	Object.defineProperty(navigator, 'registerProtocolHandler', {
		configurable: true,
		get: () => registerProtocolHandler,
	});
});

afterEach(() => {
	Reflect.deleteProperty(window, 'isSecureContext');
	Reflect.deleteProperty(navigator, 'registerProtocolHandler');
});

async function mountCard() {
	const card = mount(PreferencesMailtoHandler, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiButton: {
					emits: ['click'],
					template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});
	await flushPromises();
	return card;
}

const status = (card: Awaited<ReturnType<typeof mountCard>>) =>
	card.get('[data-testid="mailto-handler-status"]').text();

describe('PreferencesMailtoHandler', () => {
	it('registers the compose page as the mailto handler and says the browser was asked', async () => {
		const card = await mountCard();
		expectFullyLocalized(card);
		expect(card.get('[data-testid="mailto-handler-undo"]').text()).toContain('Protocol handlers');

		await card.get('[data-testid="mailto-handler-request"]').trigger('click');
		expect(registerProtocolHandler).toHaveBeenCalledWith(
			'mailto',
			`${window.location.origin}/dashboard/compose?mailto=%s`
		);
		expect(status(card)).toContain('Your browser was asked');
	});

	it('says so when the browser refuses', async () => {
		registerProtocolHandler!.mockImplementation(() => {
			throw new DOMException('Not allowed.', 'SecurityError');
		});
		const card = await mountCard();
		await card.get('[data-testid="mailto-handler-request"]').trigger('click');
		expect(status(card)).toBe('Your browser turned the request down.');
	});

	it('offers no button where the browser cannot register a handler', async () => {
		registerProtocolHandler = undefined;
		const card = await mountCard();
		expect(card.find('[data-testid="mailto-handler-request"]').exists()).toBe(false);
		expect(status(card)).toContain("This browser can't open email links");
	});

	it('offers no button on a page served without HTTPS', async () => {
		secure = false;
		const card = await mountCard();
		expect(card.find('[data-testid="mailto-handler-request"]').exists()).toBe(false);
		expect(status(card)).toContain('HTTPS');
	});
});
