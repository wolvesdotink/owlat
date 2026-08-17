// @vitest-environment happy-dom
/**
 * PostboxSecurityBadge — the signature-verdict driver (F2, D9). When the
 * `signature` prop (the inbound signature verdict persisted by F1) is present
 * and usable it replaces the structural chip's hardcoded "· not verified"
 * suffix with the verdict-driven states, VERBATIM:
 *   - "Signed · verified"             (+ fingerprint tail, tooltip with key source)
 *   - "Signed · signature invalid"    (crypto ran and did not verify)
 *   - "Signed · sender key not found" (no key anywhere — nothing checkable)
 *   - "Signed · sender key changed"   (TOFU pin refusal)
 *
 * Precedence (D9): sealed record → signature record → structural class. A
 * sealed record silences the signature chip entirely; an unusable verdict
 * (verifier error) falls back to the structural "· not verified".
 */
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxSecurityBadge from '../PostboxSecurityBadge.vue';
import type { InboundEncryptionInfo } from '~/utils/sealedMessage';
import type { InboundSignatureInfo } from '~/utils/signatureBadge';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

// The driver hands back catalog keys; mounting with the REAL catalog keeps the
// asserted chip character-for-character the one the reader sees.
beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const iconStub = { props: ['name'], template: '<span />' };

function mountBadge(opts: {
	klass?: string;
	sealed?: InboundEncryptionInfo;
	signature?: InboundSignatureInfo;
	textBodyInline?: string;
}) {
	return mount(PostboxSecurityBadge, {
		props: {
			klass: (opts.klass ?? 'pgp-signed') as never,
			message: { _id: 'm1', textBodyInline: opts.textBodyInline },
			sealed: opts.sealed,
			signature: opts.signature,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: iconStub },
		},
	});
}

const VERIFIED: InboundSignatureInfo = {
	isSigned: true,
	isSignatureValid: true,
	signerFingerprint: 'AABBCCDD00112233AABBCCDD00112233AABBCCDD',
	keySource: 'wkd',
};

describe('PostboxSecurityBadge · signature driver', () => {
	it('verified: verbatim summary + fingerprint tail + tooltip with key source', () => {
		const wrapper = mountBadge({ signature: VERIFIED });
		expect(wrapper.find('[data-testid="signature-badge-summary"]').text()).toBe(
			'Signed · verified'
		);
		expect(wrapper.find('[data-testid="signature-badge-fingerprint"]').text()).toBe(
			'0011 2233 AABB CCDD'
		);
		const tooltip = wrapper.find('[data-testid="signature-badge"] [title]').attributes('title');
		expect(tooltip).toContain('AABB CCDD 0011 2233 AABB CCDD 0011 2233 AABB CCDD');
		expect(tooltip).toContain('key directory (WKD)');
		// The verdict chip replaces the structural chip and its suffix.
		expect(wrapper.text()).not.toContain('not verified');
	});

	it('signature invalid: verbatim copy, no fingerprint shown', () => {
		const wrapper = mountBadge({
			signature: { isSigned: true, isSignatureValid: false, keySource: 'wkd' },
		});
		expect(wrapper.find('[data-testid="signature-badge-summary"]').text()).toBe(
			'Signed · signature invalid'
		);
		expect(wrapper.find('[data-testid="signature-badge-fingerprint"]').exists()).toBe(false);
	});

	it('sender key not found: verbatim copy', () => {
		const wrapper = mountBadge({
			signature: { isSigned: true, isSignatureValid: false, keySource: 'not_found' },
		});
		expect(wrapper.find('[data-testid="signature-badge-summary"]').text()).toBe(
			'Signed · sender key not found'
		);
	});

	it('sender key changed: verbatim copy (pin refusal)', () => {
		const wrapper = mountBadge({
			signature: {
				isSigned: true,
				isSignatureValid: false,
				keySource: 'pinned',
				failure: 'key_changed',
			},
		});
		expect(wrapper.find('[data-testid="signature-badge-summary"]').text()).toBe(
			'Signed · sender key changed'
		);
	});

	it('PRECEDENCE: a sealed record wins — no signature chip renders', () => {
		const wrapper = mountBadge({
			sealed: {
				isSealed: true,
				isDecrypted: true,
				cipherSuite: 'pgp-mime',
				isSignatureValid: true,
				signerFingerprint: 'AABBCCDD00112233',
			},
			signature: VERIFIED,
		});
		expect(wrapper.find('[data-testid="sealed-badge"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="signature-badge"]').exists()).toBe(false);
	});

	it('HONESTY: a verifier-error verdict falls back to the structural "· not verified"', () => {
		const wrapper = mountBadge({
			signature: {
				isSigned: true,
				isSignatureValid: false,
				keySource: 'not_found',
				failure: 'verification_error',
			},
		});
		expect(wrapper.find('[data-testid="signature-badge"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('Digitally signed');
		expect(wrapper.text()).toContain('· not verified');
	});

	it("no verdict record: the structural badge keeps its honest suffix (today's behavior)", () => {
		const wrapper = mountBadge({});
		expect(wrapper.find('[data-testid="signature-badge"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('Digitally signed');
		expect(wrapper.text()).toContain('· not verified');
	});

	it('clearsigned: the readable cleartext still renders beside the verdict chip', () => {
		const body =
			'-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nHello there\n-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----\n';
		const wrapper = mountBadge({
			klass: 'pgp-clearsigned',
			signature: VERIFIED,
			textBodyInline: body,
		});
		expect(wrapper.find('[data-testid="signature-badge-summary"]').text()).toBe(
			'Signed · verified'
		);
		expect(wrapper.text()).toContain('Hello there');
	});
});
