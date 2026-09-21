// @vitest-environment happy-dom
/**
 * PostboxAuthBadge — the OSTR registry tier chip (flag `ostr`).
 *
 * The chip is a SECOND signal inside the sender-auth badge: authentication says
 * whether the sender is who it claims to be, the tier says what the public
 * registries have observed about it. So this suite pins the two apart:
 *   - each speaking tier renders its own chip, tone and verbatim copy;
 *   - `unknown`, an absent tier and a flag-off instance render no chip at all
 *     (the registry having no evidence is not something a reader must parse);
 *   - a warned / flagged tier opens the detail even on a verified sender;
 *   - the copy exists in BOTH shipped locales, and German really is German.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxAuthBadge from '../PostboxAuthBadge.vue';
import type { SenderAuthInput } from '~/utils/senderAuth';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import de from '~~/i18n/locales/de.json';
import en from '~~/i18n/locales/en.json';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const iconStub = { props: ['name'], template: '<span />' };

const VERIFIED: SenderAuthInput = {
	fromDomain: 'acme.com',
	spfResult: 'pass',
	dmarcResult: 'pass',
	envelopeFromDomain: 'acme.com',
};

function mountBadge(
	ostrTier: string | undefined,
	ostrEnabled = true,
	options: { auth?: SenderAuthInput; locale?: 'en' | 'de' } = {}
) {
	const i18n = createTestI18n();
	// The shared helper ships `de` empty (its suites mount the English copy);
	// the German case here is about the translated tier copy, so it loads the
	// real catalog.
	if (options.locale === 'de') {
		i18n.global.setLocaleMessage('de', de);
		i18n.global.locale.value = 'de';
	}
	return mount(PostboxAuthBadge, {
		props: { enabled: true, auth: options.auth ?? VERIFIED, ostrEnabled, ostrTier },
		global: { plugins: [i18n], stubs: { Icon: iconStub } },
	});
}

/** The tone tables the badge already owns — chip classes, asserted verbatim. */
const QUIET_CHIP = 'border-border-subtle text-text-secondary';
const WARN_CHIP = 'border-warning/40 text-warning';
const DANGER_CHIP = 'border-error/40 text-error';

/** The chip's leading globe icon, where the two quiet tiers pull apart. */
function ostrIconClasses(wrapper: ReturnType<typeof mountBadge>): string {
	return wrapper.find('[data-testid="auth-badge-ostr"] span').classes().join(' ');
}

describe('PostboxAuthBadge — OSTR tier chip', () => {
	it('establishing: quiet chip with verbatim copy', async () => {
		const wrapper = mountBadge('establishing');
		const chip = wrapper.find('[data-testid="auth-badge-ostr"]');
		expect(chip.text()).toBe('Reputation: establishing');
		expect(chip.classes().join(' ')).toContain(QUIET_CHIP);
		// An unalarming tier on a verified sender stays quiet, like the badge itself.
		expect(wrapper.find('[data-testid="auth-badge-ostr-detail"]').exists()).toBe(false);
		await wrapper.find('[data-testid="auth-badge-toggle"]').trigger('click');
		expect(wrapper.find('[data-testid="auth-badge-ostr-detail"]').text()).toBe(
			'Public sender-trust registries record clean sending for this sender, but its history is still short.'
		);
	});

	it('trusted: quiet chip with verbatim copy', async () => {
		const wrapper = mountBadge('trusted');
		const chip = wrapper.find('[data-testid="auth-badge-ostr"]');
		expect(chip.text()).toBe('Reputation: trusted');
		expect(chip.classes().join(' ')).toContain(QUIET_CHIP);
		await wrapper.find('[data-testid="auth-badge-toggle"]').trigger('click');
		expect(wrapper.find('[data-testid="auth-badge-ostr-detail"]').text()).toBe(
			'Public sender-trust registries record a sustained clean history for this sender, observed independently by several receivers.'
		);
	});

	// Both quiet tiers share the chip border, so the icon is the only at-a-glance
	// difference between "clean so far" and "clean for a long time, per several
	// independent observers". Only the latter earns the reassuring green.
	it('reserves the success-green icon for `trusted`, not `establishing`', () => {
		expect(ostrIconClasses(mountBadge('trusted'))).toContain('text-success');
		const establishing = ostrIconClasses(mountBadge('establishing'));
		expect(establishing).not.toContain('text-success');
		expect(establishing).toContain('text-text-tertiary');
	});

	it('warned: warn tone, and it opens the detail on an otherwise verified sender', () => {
		const wrapper = mountBadge('warned');
		const chip = wrapper.find('[data-testid="auth-badge-ostr"]');
		expect(chip.text()).toBe('Reputation: warned');
		expect(chip.classes().join(' ')).toContain(WARN_CHIP);
		// A clean authentication verdict does not silence a bad public record.
		expect(wrapper.find('[data-testid="auth-badge-summary"]').text()).toBe('Verified sender');
		expect(wrapper.find('[data-testid="auth-badge-ostr-detail"]').text()).toBe(
			'Public sender-trust registries recorded recent complaints or spam-trap hits for this sender. Not a chronic pattern yet, but treat this message with care.'
		);
	});

	it('flagged: danger tone, starts expanded, collapses on click', async () => {
		const wrapper = mountBadge('flagged');
		const chip = wrapper.find('[data-testid="auth-badge-ostr"]');
		expect(chip.text()).toBe('Reputation: flagged');
		expect(chip.classes().join(' ')).toContain(DANGER_CHIP);
		expect(wrapper.find('[data-testid="auth-badge-ostr-detail"]').text()).toBe(
			'Public sender-trust registries recorded strong negative evidence about this sender from several independent observers. Treat this message as suspicious.'
		);
		await wrapper.find('[data-testid="auth-badge-toggle"]').trigger('click');
		expect(wrapper.find('[data-testid="auth-badge-ostr-detail"]').exists()).toBe(false);
	});

	it('renders no chip for an absent tier, `unknown`, or a tier this build cannot explain', () => {
		for (const tier of [undefined, 'unknown', 'quarantined']) {
			const wrapper = mountBadge(tier);
			// The auth badge itself still renders — only the chip is missing.
			expect(wrapper.find('[data-testid="auth-badge"]').exists()).toBe(true);
			expect(wrapper.find('[data-testid="auth-badge-ostr"]').exists()).toBe(false);
			expect(wrapper.find('[data-testid="auth-badge-ostr-detail"]').exists()).toBe(false);
		}
	});

	it('renders no chip when the ostr flag is off', async () => {
		const wrapper = mountBadge('flagged', false);
		expect(wrapper.find('[data-testid="auth-badge"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="auth-badge-ostr"]').exists()).toBe(false);
		// And the flagged tier no longer forces the badge open.
		expect(wrapper.find('[data-testid="auth-badge-detail"]').exists()).toBe(false);
		await wrapper.find('[data-testid="auth-badge-toggle"]').trigger('click');
		expect(wrapper.find('[data-testid="auth-badge-ostr-detail"]').exists()).toBe(false);
	});

	it('renders no chip on a legacy row, where the badge itself stays silent', () => {
		const wrapper = mountBadge('flagged', true, { auth: { fromDomain: 'acme.com' } });
		expect(wrapper.find('[data-testid="auth-badge"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="auth-badge-ostr"]').exists()).toBe(false);
	});

	it('speaks German', () => {
		const wrapper = mountBadge('flagged', true, { locale: 'de' });
		expect(wrapper.find('[data-testid="auth-badge-ostr"]').text()).toBe('Reputation: markiert');
		expect(wrapper.find('[data-testid="auth-badge-ostr-detail"]').text()).toContain(
			'Behandeln Sie diese Nachricht als verdächtig.'
		);
	});

	// Locale parity, checked against the catalogs themselves: `en` is the
	// fallback, so a missing German tier would render an English line inside a
	// German page rather than fail anything at runtime.
	it('ships every tier key in both locales, translated', () => {
		type Catalog = Record<string, Record<string, Record<string, Record<string, string>>>>;
		const tiers = ['establishing', 'trusted', 'warned', 'flagged'];
		for (const tier of tiers) {
			for (const field of ['label', 'detail']) {
				const english = (en as Catalog).shared!.ostr!.tier![tier]![field];
				const german = (de as Catalog).shared!.ostr!.tier![tier]![field];
				expect(english, `en shared.ostr.tier.${tier}.${field}`).toBeTruthy();
				expect(german, `de shared.ostr.tier.${tier}.${field}`).toBeTruthy();
				expect(german).not.toBe(english);
			}
		}
	});
});
