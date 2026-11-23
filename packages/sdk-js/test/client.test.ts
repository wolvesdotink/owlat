import { describe, it, expect, vi, afterEach } from 'vitest';
import { Owlat } from '../src';

describe('Owlat Client', () => {
	it('should initialize with API key string', () => {
		const owlat = new Owlat('lm_live_test123');
		expect(owlat.contacts).toBeDefined();
		expect(owlat.transactional).toBeDefined();
		expect(owlat.events).toBeDefined();
		expect(owlat.topics).toBeDefined();
	});

	it('should initialize with config object', () => {
		const owlat = new Owlat({
			apiKey: 'lm_live_test123',
			baseUrl: 'https://custom.api.com',
			timeout: 60000,
		});
		expect(owlat.contacts).toBeDefined();
	});

	it('should have all resource methods', () => {
		const owlat = new Owlat('lm_live_test123');
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

describe('the default baseUrl', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('warns that requests go to the hosted address when no baseUrl is given', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const owlat = new Owlat({ apiKey: 'lm_live_test123' });
		expect(owlat.contacts).toBeDefined();

		expect(warn).toHaveBeenCalledOnce();
		const message = String(warn.mock.calls[0]?.[0]);
		expect(message).toContain('baseUrl');
		expect(message).toContain('https://api.owlat.app');
		expect(message).not.toContain('lm_live_test123');
	});

	it('warns for the API-key shorthand too', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const owlat = new Owlat('lm_live_test123');
		expect(owlat.contacts).toBeDefined();

		expect(warn).toHaveBeenCalledOnce();
	});

	it('warns for a null baseUrl from untyped code, which falls back the same way', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const owlat = new Owlat({ apiKey: 'lm_live_test123', baseUrl: null as unknown as string });
		expect(owlat.contacts).toBeDefined();

		expect(warn).toHaveBeenCalledOnce();
	});

	it('stays quiet when baseUrl names the instance', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const owlat = new Owlat({ apiKey: 'lm_live_test123', baseUrl: 'https://owlat.example.com' });
		expect(owlat.contacts).toBeDefined();

		expect(warn).not.toHaveBeenCalled();
	});
});
