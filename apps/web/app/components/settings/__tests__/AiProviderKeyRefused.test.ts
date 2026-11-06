/**
 * Settings → AI: the card that says the provider is refusing the key shows
 * only while the instance has a refusal on record.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import AiProviderKeyRefused from '../AiProviderKeyRefused.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountCard(failure: { firstSeenAt: number; lastSeenAt: number } | null) {
	vi.stubGlobal('useOrganizationQuery', () => ({ data: computed(() => failure) }));
	return mount(AiProviderKeyRefused, { global: { plugins: [createTestI18n()] } });
}

describe('AiProviderKeyRefused', () => {
	it('shows nothing while the key is accepted', () => {
		expect(mountCard(null).find('[data-testid="ai-provider-key-refused"]').exists()).toBe(false);
	});

	it('says the provider is refusing the key, and since when', () => {
		const at = Date.UTC(2026, 10, 2, 9, 0);
		const text = mountCard({ firstSeenAt: at, lastSeenAt: at + 60_000 }).text();
		expect(text).toContain("The AI provider is refusing this workspace's API key");
		expect(text).toContain('Last refused');
	});
});
