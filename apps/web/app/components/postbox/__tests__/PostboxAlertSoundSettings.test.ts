/**
 * The alert sounds card: it lists only the alerts that can reach this person,
 * reads every switch as off until saved, previews the chime when one is
 * switched on (from the click, which is what lets the browser play alerts
 * later), and resets a switch to off.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import type { AlertSoundPrefs } from '~/lib/alertSoundRules';
import UiBadge from '@owlat/ui/components/ui/Badge.vue';
import UiSwitch from '@owlat/ui/components/ui/Switch.vue';
import PostboxAlertSoundSettings from '../PostboxAlertSoundSettings.vue';

const preview = vi.hoisted(() => vi.fn());
vi.mock('~/composables/postbox/useUiSound', () => ({ previewAlertSound: preview }));

const setAlertSound = vi.fn(async () => {});
let prefs: AlertSoundPrefs;
let flags: Set<string>;
let role: 'owner' | 'admin' | 'editor' | null;

beforeEach(() => {
	preview.mockClear();
	setAlertSound.mockClear();
	prefs = { reply: false, assignment: false, question: false };
	flags = new Set(['postbox', 'inbox']);
	role = 'admin';
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: (flag: string) => flags.has(flag) }));
	vi.stubGlobal('usePermissions', () => ({ role: ref(role) }));
	vi.stubGlobal('useAlertSoundPreferences', () => ({
		alertSounds: ref(prefs),
		setAlertSound,
		isSaving: ref(false),
		isLoading: ref(false),
	}));
});

function mountCard() {
	return mount(PostboxAlertSoundSettings, {
		global: { plugins: [createTestI18n()], components: { UiBadge, UiSwitch } },
	});
}

const switchIds = (card: ReturnType<typeof mountCard>) =>
	card.findAll('[role="switch"]').map((el) => el.attributes('id'));

describe('PostboxAlertSoundSettings', () => {
	it('lists all three alerts for an admin with mail and the team inbox, fully localized', () => {
		const card = mountCard();
		expect(card.find('#alert-sounds').exists()).toBe(true);
		expect(switchIds(card)).toEqual([
			'alert-sound-reply',
			'alert-sound-assignment',
			'alert-sound-question',
		]);
		expect(card.text()).toContain('Replies you are waiting for');
		expectFullyLocalized(card);
	});

	it('keeps the team alerts to owners and admins with the team inbox', () => {
		role = 'editor';
		expect(switchIds(mountCard())).toEqual(['alert-sound-reply']);
		role = null;
		expect(switchIds(mountCard())).toEqual(['alert-sound-reply']);

		role = 'owner';
		flags = new Set(['postbox']);
		expect(switchIds(mountCard())).toEqual(['alert-sound-reply']);

		flags = new Set(['inbox']);
		expect(switchIds(mountCard())).toEqual(['alert-sound-assignment', 'alert-sound-question']);
		// An editor on a Team-inbox-only instance has no row, so no card.
		role = 'editor';
		expect(mountCard().find('#alert-sounds').exists()).toBe(false);
	});

	it('hides itself when no alert it covers can reach this person', () => {
		flags = new Set(['campaigns']);
		expect(mountCard().find('#alert-sounds').exists()).toBe(false);
	});

	it('previews the chime when a sound is switched on, not when it is switched off', async () => {
		const card = mountCard();
		await card.find('#alert-sound-assignment').trigger('click');
		expect(preview).toHaveBeenCalledTimes(1);
		expect(setAlertSound).toHaveBeenCalledWith('assignment', true);

		prefs = { reply: false, assignment: true, question: false };
		const on = mountCard();
		await on.find('#alert-sound-assignment').trigger('click');
		expect(preview).toHaveBeenCalledTimes(1);
		expect(setAlertSound).toHaveBeenLastCalledWith('assignment', false);
	});

	it('marks a switched-on sound as changed, and Reset turns it off', async () => {
		const resets = (card: ReturnType<typeof mountCard>) =>
			card.findAll('[data-testid="setting-reset"] button');
		expect(resets(mountCard())).toHaveLength(0);

		prefs = { reply: true, assignment: false, question: false };
		const card = mountCard();
		const [reset] = resets(card);
		expect(reset).toBeDefined();
		await reset!.trigger('click');
		expect(setAlertSound).toHaveBeenCalledWith('reply', false);
		expect(preview).not.toHaveBeenCalled();
	});
});
