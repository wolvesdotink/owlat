import { describe, expect, it } from 'vitest';
import { connectedAppCapabilityLabel } from '../connectedAppCapabilities';

describe('connectedAppCapabilityLabel', () => {
	it('renders a well-formed scope:verb as "Scope · verb"', () => {
		expect(connectedAppCapabilityLabel('mail:read')).toBe('Mail · read');
		expect(connectedAppCapabilityLabel('send:gate')).toBe('Send · gate');
	});

	it('humanizes hyphenated and underscored scopes', () => {
		expect(connectedAppCapabilityLabel('plugin-storage:write')).toBe('Plugin storage · write');
		expect(connectedAppCapabilityLabel('draft_hook:score')).toBe('Draft hook · score');
	});

	it('humanizes a colon-less key whole', () => {
		expect(connectedAppCapabilityLabel('llm')).toBe('Llm');
	});

	it('falls back to the raw string for an empty or blank key', () => {
		expect(connectedAppCapabilityLabel('')).toBe('');
		expect(connectedAppCapabilityLabel('   ')).toBe('   ');
	});

	it('keeps the scope when the verb half is missing', () => {
		expect(connectedAppCapabilityLabel('mail:')).toBe('Mail');
	});

	it('keeps the verb when the scope half is missing', () => {
		expect(connectedAppCapabilityLabel(':read')).toBe(':read');
	});
});
