import { describe, expect, it } from 'vitest';
import { MULTI_RELAY_DETAIL_PREFIX } from '@owlat/shared/deliverabilityAlignment';
import { referenceRelayNotice } from '../referenceRelay';

const ARM = {
	label: 'Mandrill relay',
	fromDomain: 'example.com',
	dkimDomain: 'example.com',
	dkimSelectors: ['mandrill'],
	spfMechanisms: ['include:spf.mandrillapp.com'],
	supportsCustomReturnPath: false,
};

describe('referenceRelayNotice', () => {
	it('says nothing while the read is still in flight', () => {
		expect(referenceRelayNotice(undefined)).toBeNull();
	});

	it('says nothing on a standalone deployment', () => {
		// `none` is a supported configuration (plan D2), not a missing second arm.
		expect(referenceRelayNotice({ reference: { kind: 'none' } })).toBeNull();
	});

	it('says nothing when the relay is describable', () => {
		expect(referenceRelayNotice({ reference: { kind: 'arm', arm: ARM } })).toBeNull();
	});

	it('classifies the D8 multi-relay case and keeps the backend sentence verbatim', () => {
		const detail = `${MULTI_RELAY_DETAIL_PREFIX} (mandrill, ses), so there is no single second arm for example.com to be compared against.`;
		const notice = referenceRelayNotice({ reference: { kind: 'unknown', detail } });
		expect(notice?.kind).toBe('multi_relay');
		expect(notice?.detail).toBe(detail);
		expect(notice?.remedy).toContain('Keep exactly one relay enabled');
		// The wrong remedy for this branch would be "verify the relay".
		expect(notice?.remedy).not.toContain('Verify this sending domain');
	});

	it('classifies an undescribed single relay as a verification problem instead', () => {
		const detail =
			'A relay is configured (mandrill) but example.com has no verified signing identity for it, so the two arms cannot be compared.';
		const notice = referenceRelayNotice({ reference: { kind: 'unknown', detail } });
		expect(notice?.kind).toBe('undescribed');
		expect(notice?.detail).toBe(detail);
		expect(notice?.remedy).toContain('Verify this sending domain');
	});
});
