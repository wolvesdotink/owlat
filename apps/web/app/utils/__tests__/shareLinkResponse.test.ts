import { describe, it, expect } from 'vitest';
import { interpretShareResponse, type ShareLinkData } from '../shareLinkResponse';

const sampleData: ShareLinkData = {
	html: '<p>hi</p>',
	subject: 'Spring sale',
	organizationName: 'Acme',
	expiresAt: Date.now() + 3_600_000,
};

describe('interpretShareResponse', () => {
	it('maps an expired link (404 + reason:expired in the error envelope) to "expired"', () => {
		// This is the bug being fixed: the endpoint returns 404, NOT 410, and the
		// expired signal rides in error.data.reason.
		const body = {
			error: { category: 'not_found', message: 'This share link has expired', data: { reason: 'expired' } },
		};
		expect(interpretShareResponse(false, body)).toEqual({ kind: 'expired' });
	});

	it('maps a not-found / revoked 404 (no expired reason) to "invalid"', () => {
		const body = {
			error: { category: 'not_found', message: 'Share link not found', data: { reason: 'share_link_not_found' } },
		};
		expect(interpretShareResponse(false, body)).toEqual({ kind: 'invalid' });
	});

	it('maps a non-ok response with an unparseable body to "invalid"', () => {
		expect(interpretShareResponse(false, null)).toEqual({ kind: 'invalid' });
	});

	it('maps a successful { ok: true, data } envelope to "ok" with the data', () => {
		expect(interpretShareResponse(true, { ok: true, data: sampleData })).toEqual({
			kind: 'ok',
			data: sampleData,
		});
	});

	it('maps a 2xx with an unexpected body shape to "invalid"', () => {
		expect(interpretShareResponse(true, { ok: true })).toEqual({ kind: 'invalid' });
		expect(interpretShareResponse(true, null)).toEqual({ kind: 'invalid' });
	});
});
