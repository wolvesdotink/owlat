import { describe, it, expect } from 'vitest';
import { lastPathSegment, pathSegmentAfter } from '../apiResponses';

const req = (path: string) => new Request(`https://api.owlat.test${path}`);

describe('lastPathSegment', () => {
	it('returns the decoded last segment', () => {
		expect(lastPathSegment(req('/api/v1/contacts/user%40example.com'))).toEqual({
			ok: true,
			value: 'user@example.com',
		});
	});

	it('reports a missing segment for a trailing slash', () => {
		expect(lastPathSegment(req('/api/v1/contacts/'))).toEqual({ ok: false, reason: 'missing' });
	});

	it('reports malformed percent-encoding instead of throwing', () => {
		expect(lastPathSegment(req('/api/v1/contacts/%E0%A4%A'))).toEqual({
			ok: false,
			reason: 'malformed',
		});
	});
});

describe('pathSegmentAfter', () => {
	const path = '/api/v1/topics/topic12345/contacts/user%40example.com';

	it('returns the decoded segment after the marker', () => {
		expect(pathSegmentAfter(req(path), 'topics')).toEqual({ ok: true, value: 'topic12345' });
		expect(pathSegmentAfter(req(path), 'contacts')).toEqual({
			ok: true,
			value: 'user@example.com',
		});
	});

	it('reports missing when the marker is absent or last', () => {
		expect(pathSegmentAfter(req('/api/v1/other/x'), 'topics')).toEqual({
			ok: false,
			reason: 'missing',
		});
		expect(pathSegmentAfter(req('/api/v1/topics'), 'topics')).toEqual({
			ok: false,
			reason: 'missing',
		});
		expect(pathSegmentAfter(req('/api/v1/topics//contacts'), 'topics')).toEqual({
			ok: false,
			reason: 'missing',
		});
	});

	it('reports malformed percent-encoding instead of throwing', () => {
		expect(pathSegmentAfter(req('/api/v1/topics/t/contacts/%'), 'contacts')).toEqual({
			ok: false,
			reason: 'malformed',
		});
	});
});
