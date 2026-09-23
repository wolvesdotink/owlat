import { describe, expect, it } from 'vitest';
import {
	hasOperatorLegalPages,
	instanceRootRedirect,
	registrationOpenFor,
	workspaceDisplayName,
} from '../instanceEntry';

describe('instanceRootRedirect (#768)', () => {
	it('sends a self-hosted instance root to sign-in', () => {
		expect(instanceRootRedirect({ deploymentMode: 'selfhost' })).toBe('/auth/login');
	});

	it('treats an unset mode as self-hosted, matching the runtime-config default', () => {
		expect(instanceRootRedirect({})).toBe('/auth/login');
	});

	it('keeps the product hero on the hosted marketing deployment', () => {
		expect(instanceRootRedirect({ deploymentMode: 'hosted' })).toBeNull();
	});
});

describe('workspace branding', () => {
	it('uses the configured company name', () => {
		expect(workspaceDisplayName({ companyName: '  Northwind Studio ' })).toBe('Northwind Studio');
		expect(hasOperatorLegalPages({ companyName: 'Northwind Studio' })).toBe(true);
	});

	it('has no name and no legal pages on a stock install', () => {
		expect(workspaceDisplayName({ companyName: '' })).toBeNull();
		expect(workspaceDisplayName({})).toBeNull();
		expect(hasOperatorLegalPages({ companyName: '   ' })).toBe(false);
	});
});

describe('registrationOpenFor', () => {
	it('is open only for a visitor coming from an invitation', () => {
		expect(registrationOpenFor('/invite/accept?id=1')).toBe(true);
		expect(registrationOpenFor(encodeURIComponent('/invite/accept?id=1'))).toBe(true);
	});

	it('is closed everywhere else', () => {
		expect(registrationOpenFor(undefined)).toBe(false);
		expect(registrationOpenFor('')).toBe(false);
		expect(registrationOpenFor('/dashboard')).toBe(false);
		expect(registrationOpenFor(['/invite/accept'])).toBe(false);
		// A malformed escape must not throw out of a computed.
		expect(registrationOpenFor('%E0%A4%A')).toBe(false);
	});
});
