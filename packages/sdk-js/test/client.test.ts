import { describe, it, expect, vi, afterEach } from 'vitest';
import { Owlat } from '../src';
import { mockFetch } from './helpers';

describe('Owlat Client', () => {
	it('should initialize with config object', () => {
		const owlat = new Owlat({
			apiKey: 'lm_live_test123',
			baseUrl: 'https://custom.api.com',
			timeout: 60000,
		});
		expect(owlat.contacts).toBeDefined();
		expect(owlat.transactional).toBeDefined();
		expect(owlat.events).toBeDefined();
		expect(owlat.topics).toBeDefined();
	});

	it('should have all resource methods', () => {
		const owlat = new Owlat({ apiKey: 'lm_live_test123', baseUrl: 'https://custom.api.com' });
		expect(typeof owlat.contacts.create).toBe('function');
		expect(typeof owlat.contacts.get).toBe('function');
		expect(typeof owlat.contacts.update).toBe('function');
		expect(typeof owlat.contacts.delete).toBe('function');
		expect(typeof owlat.contacts.list).toBe('function');
		expect(typeof owlat.transactional.send).toBe('function');
		expect(typeof owlat.events.send).toBe('function');
		expect(typeof owlat.topics.addContact).toBe('function');
		expect(typeof owlat.topics.removeContact).toBe('function');
	});
});

describe('baseUrl', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const whereToFindIt = 'Settings → API → API quickstart';

	it('is required, and the error says where to find it', () => {
		// @ts-expect-error baseUrl is required
		expect(() => new Owlat({ apiKey: 'lm_live_test123' })).toThrow(
			expect.objectContaining({
				name: 'TypeError',
				message: expect.stringMatching(/^baseUrl is required/),
			})
		);
		// @ts-expect-error baseUrl is required
		expect(() => new Owlat({ apiKey: 'lm_live_test123' })).toThrow(whereToFindIt);
	});

	it('refuses the API-key shorthand, which has no baseUrl', () => {
		// @ts-expect-error the key-only form is gone
		expect(() => new Owlat('lm_live_test123')).toThrow(/^baseUrl is required/);
	});

	it.each([
		['null from untyped code', null],
		['an empty string', ''],
		['whitespace only', '  \n'],
	])('refuses %s as missing', (_label, baseUrl) => {
		expect(
			() => new Owlat({ apiKey: 'lm_live_test123', baseUrl: baseUrl as unknown as string })
		).toThrow(/^baseUrl is required/);
	});

	it.each([
		['a host without a scheme', 'rest.api.example.com'],
		['a relative path', '/api'],
		['another scheme', 'ftp://rest.api.example.com'],
		['a URL that does not parse', 'https://'],
		['surrounding whitespace', ' https://rest.api.example.com\n'],
		['a query string', 'https://rest.api.example.com?tenant=a'],
		['a fragment', 'https://rest.api.example.com#api'],
		['credentials', 'https://user:secret@rest.api.example.com'],
	])('refuses %s', (_label, baseUrl) => {
		const error: unknown = (() => {
			try {
				return new Owlat({ apiKey: 'lm_live_test123', baseUrl });
			} catch (caught) {
				return caught;
			}
		})();
		expect(error).toBeInstanceOf(TypeError);
		const message = (error as Error).message;
		expect(message).toMatch(/^baseUrl /);
		expect(message).toContain(whereToFindIt);
		// The value can be a key pasted into the wrong field.
		expect(message).not.toContain('secret');
		expect(message).not.toContain('lm_live_test123');
	});

	it.each([
		['https://rest.api.example.com', 'https://rest.api.example.com/api/v1/limits'],
		['http://localhost:3211', 'http://localhost:3211/api/v1/limits'],
		['https://rest.api.example.com/', 'https://rest.api.example.com/api/v1/limits'],
		['https://example.com/owlat', 'https://example.com/owlat/api/v1/limits'],
		['https://example.com/owlat//', 'https://example.com/owlat/api/v1/limits'],
	])('sends requests for %s to %s', async (baseUrl, expected) => {
		const fetchMock = mockFetch({ body: { data: {} } });
		const owlat = new Owlat({ apiKey: 'lm_live_test123', baseUrl });

		await owlat.limits.get();

		expect(fetchMock.mock.calls[0]?.[0]).toBe(expected);
	});
});
