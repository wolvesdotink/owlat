// @vitest-environment happy-dom
/**
 * What the Delete workspace confirmation promises (#906).
 *
 * The deletion job (apps/api/convex/workspaces/deletion/) sweeps the tenant
 * tables only. The organization, its members and their accounts live in the
 * BetterAuth component and survive, so after deletion every member can still
 * sign in to the emptied workspace. The copy used to list "team members" among
 * the things deleted; these cases pin both halves in each locale:
 *   - nothing in a deleting sentence names team members
 *   - the copy says members keep their accounts and memberships
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import DeleteWorkspaceModal from '../DeleteWorkspaceModal.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import de from '~~/i18n/locales/de.json';

// `useI18n` is an auto-import in the app, so it has to be a global here.
Object.assign(globalThis, i18nStubs);

const stubs = {
	UiModal: { props: ['open', 'size', 'closable', 'persistent'], template: '<div><slot /></div>' },
	UiButton: { props: ['variant', 'loading', 'disabled'], template: '<button><slot /></button>' },
	UiIconBox: true,
	Icon: true,
};

type Locale = 'en' | 'de';

function i18nFor(locale: Locale) {
	const i18n = createTestI18n();
	// The shared helper ships `de` empty; load the real catalog so the German
	// case reads the translated copy rather than falling back to English.
	if (locale === 'de') {
		i18n.global.setLocaleMessage('de', de);
		i18n.global.locale.value = 'de';
	}
	return i18n;
}

function mountModal(locale: Locale) {
	return mount(DeleteWorkspaceModal, {
		props: { open: true, workspaceName: 'Acme', busy: false },
		global: { plugins: [i18nFor(locale)], stubs },
	});
}

/** The sentences of `text` that say something is deleted or removed. */
function deletingSentences(text: string): string[] {
	return text.split(/(?<=\.)\s+/).filter((sentence) => /delet|remov|lösch|entfern/i.test(sentence));
}

const EXPECTED: Record<Locale, { member: RegExp; kept: string }> = {
	en: { member: /team member/i, kept: 'Team members keep their accounts and memberships' },
	de: {
		member: /teammitglied/i,
		kept: 'Die Teammitglieder behalten ihre Konten und Mitgliedschaften',
	},
};

describe.each(['en', 'de'] as const)('workspace deletion copy (%s)', (locale) => {
	const { member, kept } = EXPECTED[locale];

	it('the confirmation modal deletes the workspace data and keeps accounts', () => {
		const text = mountModal(locale).text().replace(/\s+/g, ' ');
		expect(text).toContain('Acme');
		expect(text).toContain(kept);
		const deleting = deletingSentences(text);
		expect(deleting.length).toBeGreaterThan(0);
		for (const sentence of deleting) expect(sentence).not.toMatch(member);
	});

	it('the danger-zone card says the same', () => {
		const { t } = i18nFor(locale).global;
		const body = t('dashboard.admin.team.dangerZone.body');
		expect(body).toContain(kept);
		const deleting = deletingSentences(body);
		expect(deleting.length).toBeGreaterThan(0);
		for (const sentence of deleting) expect(sentence).not.toMatch(member);
		expect(t('dashboard.admin.team.dangerZone.subtitle')).not.toMatch(member);
	});
});
