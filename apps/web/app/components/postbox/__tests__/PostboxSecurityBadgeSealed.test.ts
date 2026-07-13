// @vitest-environment happy-dom
/**
 * PostboxSecurityBadge — the Sealed-Mail driver (E5). When the `sealed` prop
 * (the inbound encryption record) is present it wins over the structural badge
 * and renders the honest sealed states with VERBATIM copy:
 *   - "Sealed — sender verified"      (decrypted + signatureValid + pin match)
 *   - "Sealed — sender not verified"  (decrypted, but no verified signature)
 *   - "Encrypted — can't decrypt"     (sealed on the wire, no key to open it)
 *
 * The honesty audit: "verified" is unreachable without a valid signature against
 * the pinned key. When no `sealed` prop is passed the pre-Sealed-Mail structural
 * badge is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxSecurityBadge from '../PostboxSecurityBadge.vue';
import type { InboundEncryptionInfo } from '~/utils/sealedMessage';

const iconStub = { props: ['name'], template: '<span />' };

function mountBadge(opts: {
	klass?: string;
	sealed?: InboundEncryptionInfo;
	textBodyInline?: string;
}) {
	return mount(PostboxSecurityBadge, {
		props: {
			klass: (opts.klass ?? 'none') as never,
			message: { _id: 'm1', textBodyInline: opts.textBodyInline },
			sealed: opts.sealed,
		},
		global: { stubs: { Icon: iconStub } },
	});
}

const VERIFIED: InboundEncryptionInfo = {
	sealed: true,
	decrypted: true,
	cipherSuite: 'pgp-mime',
	signatureValid: true,
	signerFingerprint: 'AABBCCDD00112233',
};

describe('PostboxSecurityBadge · sealed driver', () => {
	it('verified: verbatim summary + detail (honesty audit)', () => {
		const wrapper = mountBadge({ sealed: VERIFIED });
		expect(wrapper.find('[data-testid="sealed-badge-summary"]').text()).toBe(
			'Sealed — sender verified'
		);
		expect(wrapper.find('[data-testid="sealed-badge-detail"]').text()).toBe(
			'This message was encrypted end-to-end, and we confirmed it was really signed by the sender.'
		);
	});

	it('not verified: decrypted but signature did not verify → verbatim copy', () => {
		const wrapper = mountBadge({
			sealed: { sealed: true, decrypted: true, cipherSuite: 'pgp-mime', signatureValid: false },
		});
		expect(wrapper.find('[data-testid="sealed-badge-summary"]').text()).toBe(
			'Sealed — sender not verified'
		);
	});

	it('HONESTY: signatureValid with no signer fingerprint can never read "verified"', () => {
		const wrapper = mountBadge({
			sealed: { sealed: true, decrypted: true, cipherSuite: 'pgp-mime', signatureValid: true },
		});
		expect(wrapper.find('[data-testid="sealed-badge-summary"]').text()).toBe(
			'Sealed — sender not verified'
		);
	});

	it("can't decrypt: verbatim copy + recovery controls (download raw .eml)", () => {
		const wrapper = mountBadge({
			klass: 'pgp-encrypted',
			sealed: { sealed: true, decrypted: false },
		});
		expect(wrapper.find('[data-testid="sealed-badge-summary"]').text()).toBe(
			"Encrypted — can't decrypt"
		);
		// The escape hatch survives: the reader can still download the raw .eml.
		expect(wrapper.find('[data-testid="download-eml"]').exists()).toBe(true);
	});

	it('the sealed chip wins over the structural chip (no double badge)', () => {
		const wrapper = mountBadge({ klass: 'pgp-signed', sealed: VERIFIED });
		expect(wrapper.find('[data-testid="sealed-badge"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('Signed (PGP)');
	});

	it('no sealed prop: the pre-Sealed-Mail structural badge is unchanged', () => {
		const wrapper = mountBadge({ klass: 'pgp-signed' });
		expect(wrapper.find('[data-testid="sealed-badge"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('Signed (PGP)');
	});
});
