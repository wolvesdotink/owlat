/**
 * Reset to default on the Preferences cards outside the Reading card: undo
 * send, trash retention, the notification rules (scope, badge, previews,
 * screener, quiet hours) and the daily-brief email.
 *
 * Each card is judged the same way: nothing is marked at the default, a
 * changed value is marked and named, Reset writes the default through the
 * card's own setter, and nothing is marked while the settings row is still
 * loading (every value then reads as a fallback nobody chose).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { POSTBOX_PREFERENCE_DEFAULTS } from '~/utils/postboxPreferenceDefaults';
import { POSTBOX_BRIEF_TIME_DEFAULT_MINUTE } from '~/utils/postboxBriefSchedule';
import PostboxSendingSettings from '../PostboxSendingSettings.vue';
import PostboxNotificationSettings from '../PostboxNotificationSettings.vue';
import PostboxQuietHoursFields from '../PostboxQuietHoursFields.vue';
import PostboxDailyBriefSettings from '../PostboxDailyBriefSettings.vue';
import PreferencesYourData from '~/components/preferences/PreferencesYourData.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const setters = {
	setUndoSendSeconds: vi.fn(async () => {}),
	setTrashAutoPurgeDays: vi.fn(async () => {}),
	setNotifyAbout: vi.fn(async () => {}),
	setBadgeNonPeople: vi.fn(async () => {}),
	setHidePreview: vi.fn(async () => {}),
	setSenderScreener: vi.fn(async () => {}),
	setQuietHours: vi.fn(async () => {}),
	setDailyBriefEmail: vi.fn(async () => {}),
};

let values: Record<string, unknown>;
let isLoading: boolean;
let aiEnabled: boolean;

function quietHoursDefault() {
	const fallback = POSTBOX_PREFERENCE_DEFAULTS.quietHours;
	return { ...fallback, days: [...fallback.days] };
}

beforeEach(() => {
	for (const setter of Object.values(setters)) setter.mockClear();
	aiEnabled = true;
	values = {
		...POSTBOX_PREFERENCE_DEFAULTS,
		quietHours: quietHoursDefault(),
		notifyAbout: 'people-important',
		dailyBriefEmail: null,
	};
	isLoading = false;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (flag: string) => aiEnabled && flag === 'ai',
	}));
	vi.stubGlobal('useConvexQuery', () => ({
		data: ref(undefined),
		isLoading: ref(false),
		error: ref(null),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useConvex', () => null);
	vi.stubGlobal('usePostboxMailbox', () => ({ currentMailbox: ref(null) }));
	vi.stubGlobal('usePostboxSettings', () => ({
		...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, ref(value)])),
		...setters,
		isSaving: ref(false),
		isLoading: ref(isLoading),
	}));
});

const SwitchStub = {
	props: ['modelValue', 'id', 'disabled', 'label'],
	emits: ['update:modelValue'],
	template: '<button :id="id" role="switch" :aria-checked="String(modelValue)" />',
};

function mountCard(component: unknown) {
	return mount(component as Parameters<typeof mount>[0], {
		global: {
			plugins: [createTestI18n()],
			components: { PostboxQuietHoursFields },
			stubs: {
				UiSwitch: SwitchStub,
				UiButton: true,
				UiIconBox: true,
				I18nT: true,
				PostboxNotificationPermission: true,
			},
		},
	});
}

const markers = (card: ReturnType<typeof mountCard>) =>
	card
		.findAll('[data-testid="setting-reset"] button')
		.map((button) => button.attributes('aria-label'));

async function resetNamed(card: ReturnType<typeof mountCard>, label: string) {
	const button = card
		.findAll('[data-testid="setting-reset"] button')
		.find((candidate) => candidate.attributes('aria-label') === label);
	expect(button, label).toBeDefined();
	await button!.trigger('click');
}

describe('Undo send', () => {
	it('is unmarked at the 10-second default and while the row loads', () => {
		expect(markers(mountCard(PostboxSendingSettings))).toEqual([]);
		values.undoSendSeconds = 30;
		isLoading = true;
		expect(markers(mountCard(PostboxSendingSettings))).toEqual([]);
	});

	it('marks another window and resets it to the default', async () => {
		values.undoSendSeconds = 0;
		const card = mountCard(PostboxSendingSettings);
		expect(markers(card)).toEqual(['Reset Undo send to its default']);
		await resetNamed(card, 'Reset Undo send to its default');
		expect(setters.setUndoSendSeconds).toHaveBeenCalledWith(
			POSTBOX_PREFERENCE_DEFAULTS.undoSendSeconds
		);
	});
});

describe('Trash retention', () => {
	it('is unmarked at Never and while the row loads', () => {
		expect(markers(mountCard(PreferencesYourData))).toEqual([]);
		values.trashAutoPurgeDays = 30;
		isLoading = true;
		expect(markers(mountCard(PreferencesYourData))).toEqual([]);
	});

	it('marks a purge horizon and resets it to Never', async () => {
		values.trashAutoPurgeDays = 30;
		const card = mountCard(PreferencesYourData);
		const [label] = markers(card);
		expect(label).toMatch(/^Reset .+ to its default$/);
		await resetNamed(card, label!);
		expect(setters.setTrashAutoPurgeDays).toHaveBeenCalledWith(0);
	});
});

describe('Notification rules', () => {
	it('is unmarked when every rule is at its default', () => {
		expect(markers(mountCard(PostboxNotificationSettings))).toEqual([]);
	});

	it('takes the scope default from smart categories', () => {
		aiEnabled = false;
		values.notifyAbout = 'everything';
		expect(markers(mountCard(PostboxNotificationSettings))).toEqual([]);
		values.notifyAbout = 'people-important';
		expect(markers(mountCard(PostboxNotificationSettings))).toHaveLength(1);
	});

	it('marks each changed rule, and Reset writes that rule’s default', async () => {
		values.notifyAbout = 'nothing';
		values.badgeNonPeople = false;
		values.hidePreview = true;
		values.senderScreener = true;
		values.quietHours = { ...quietHoursDefault(), enabled: true };
		const card = mountCard(PostboxNotificationSettings);
		expect(markers(card)).toHaveLength(5);

		for (const label of markers(card)) await resetNamed(card, label!);
		expect(setters.setNotifyAbout).toHaveBeenCalledWith('people-important');
		expect(setters.setBadgeNonPeople).toHaveBeenCalledWith(true);
		expect(setters.setHidePreview).toHaveBeenCalledWith(false);
		expect(setters.setSenderScreener).toHaveBeenCalledWith(false);
		expect(setters.setQuietHours).toHaveBeenCalledWith(quietHoursDefault());
	});

	it('marks nothing while the settings row loads', () => {
		values.notifyAbout = 'nothing';
		values.hidePreview = true;
		values.quietHours = { ...quietHoursDefault(), startMinute: 60 };
		isLoading = true;
		expect(markers(mountCard(PostboxNotificationSettings))).toEqual([]);
	});
});

describe('Daily brief email', () => {
	it('is unmarked while delivery has never been turned on', () => {
		expect(markers(mountCard(PostboxDailyBriefSettings))).toEqual([]);
	});

	it('marks delivery that is on, and Reset turns it off keeping the time', async () => {
		values.dailyBriefEmail = {
			enabled: true,
			minute: POSTBOX_BRIEF_TIME_DEFAULT_MINUTE,
			utcOffsetMinutes: -new Date().getTimezoneOffset(),
		};
		const card = mountCard(PostboxDailyBriefSettings);
		expect(markers(card)).toHaveLength(1);
		await resetNamed(card, markers(card)[0]!);
		expect(setters.setDailyBriefEmail).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: false, minute: POSTBOX_BRIEF_TIME_DEFAULT_MINUTE })
		);
	});

	it('marks a non-default send time, and Reset puts the default hour back', async () => {
		values.dailyBriefEmail = {
			enabled: true,
			minute: 9 * 60,
			utcOffsetMinutes: -new Date().getTimezoneOffset(),
		};
		const card = mountCard(PostboxDailyBriefSettings);
		await resetNamed(card, 'Reset Daily brief time to its default');
		expect(setters.setDailyBriefEmail).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: true, minute: POSTBOX_BRIEF_TIME_DEFAULT_MINUTE })
		);
	});
});
