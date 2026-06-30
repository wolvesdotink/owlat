import { describe, it, expect } from 'vitest';
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
