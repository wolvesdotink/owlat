import { describe, expect, it } from 'vitest';
import { readInstanceInfo } from '../instanceInfo';

const INFO = {
	name: 'Acme',
	convexUrl: 'https://acme.convex.cloud',
	convexSiteUrl: 'https://acme.convex.site',
	siteUrl: 'https://acme.example',
	deploymentMode: 'selfhost',
};

describe('readInstanceInfo', () => {
	it('reads a full answer, ignoring fields it does not know', () => {
		expect(readInstanceInfo({ ...INFO, region: 'eu' })).toEqual(INFO);
	});

	it('defaults the fields an older server leaves out', () => {
		expect(
			readInstanceInfo({ convexUrl: INFO.convexUrl, convexSiteUrl: INFO.convexSiteUrl })
		).toEqual({ ...INFO, name: '', siteUrl: '', deploymentMode: '' });
	});

	it.each([
		['an empty Convex URL', { ...INFO, convexUrl: '' }],
		['a missing Convex site URL', { ...INFO, convexSiteUrl: undefined }],
		['a non-string Convex URL', { ...INFO, convexUrl: ['https://acme.convex.cloud'] }],
		['a non-string site URL', { ...INFO, siteUrl: 1 }],
		['a non-string deployment mode', { ...INFO, deploymentMode: true }],
		['a list', [INFO]],
		['a string', 'Acme'],
		['a body that was not JSON', undefined],
	])('refuses %s', (_case, body) => {
		expect(readInstanceInfo(body)).toBeNull();
	});
});
