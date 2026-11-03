import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import UiAvatar from '~/components/ui/Avatar.vue';
import PostboxSenderAvatar from '../PostboxSenderAvatar.vue';

/**
 * The sender avatar draws the logo the server attached, on a light tile, and
 * falls back to the identity initials when there is none or it fails to load.
 */
function mountAvatar(sender: { fromName?: string; fromAddress: string; senderLogoUrl?: string }) {
	return mount(PostboxSenderAvatar, {
		props: { sender, size: 'md' },
		global: { components: { UiAvatar } },
	});
}

const LOGO = 'https://convex.owlat.test/api/storage/logo-id';

describe('PostboxSenderAvatar', () => {
	it('draws the attached logo instead of initials', () => {
		const wrapper = mountAvatar({
			fromName: 'Acme Bank',
			fromAddress: 'alerts@acme-bank.com',
			senderLogoUrl: LOGO,
		});
		expect(wrapper.find('img').attributes('src')).toBe(LOGO);
		expect(wrapper.text()).toBe('');
		// A transparent icon must not sit on the identity colour.
		expect(wrapper.classes()).toContain('bg-white');
		expect(wrapper.attributes('style') ?? '').toBe('');
	});

	it('draws initials when no logo was attached', () => {
		const wrapper = mountAvatar({ fromName: 'Ada Lovelace', fromAddress: 'ada@example.com' });
		expect(wrapper.find('img').exists()).toBe(false);
		expect(wrapper.text()).toBe('AL');
	});

	it('falls back to initials when the logo fails to load', async () => {
		const wrapper = mountAvatar({
			fromName: 'Acme Bank',
			fromAddress: 'alerts@acme-bank.com',
			senderLogoUrl: LOGO,
		});
		await wrapper.find('img').trigger('error');
		expect(wrapper.find('img').exists()).toBe(false);
		expect(wrapper.text()).toBe('AB');
		expect(wrapper.classes()).not.toContain('bg-white');
	});
});
