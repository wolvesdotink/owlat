import { describe, it, expect } from 'vitest';
import {
	CONVEX_DASHBOARD_PORT,
	DEFAULT_CONVEX_DASHBOARD_URL,
	deriveConvexDashboardUrl,
	normalizeDashboardUrl,
	resolveConvexDashboardUrl,
} from '../convexDashboard';

describe('normalizeDashboardUrl — fail-soft validation', () => {
	it('returns null for empty/whitespace/nullish input', () => {
		expect(normalizeDashboardUrl('')).toBeNull();
		expect(normalizeDashboardUrl('   ')).toBeNull();
		expect(normalizeDashboardUrl(null)).toBeNull();
		expect(normalizeDashboardUrl(undefined)).toBeNull();
	});

	it('rejects non-http(s) protocols and garbage', () => {
		expect(normalizeDashboardUrl('javascript:alert(1)')).toBeNull();
		expect(normalizeDashboardUrl('ftp://example.com')).toBeNull();
		expect(normalizeDashboardUrl('not a url')).toBeNull();
	});

	it('accepts and normalizes http(s) URLs', () => {
		expect(normalizeDashboardUrl('http://localhost:6791')).toBe('http://localhost:6791/');
		expect(normalizeDashboardUrl('  https://admin.example.com/  ')).toBe('https://admin.example.com/');
	});
});

describe('deriveConvexDashboardUrl — port-swap heuristic', () => {
	it('swaps the port to 6791 and strips path/query/hash', () => {
		expect(deriveConvexDashboardUrl('https://app.example.com/dashboard?x=1#y')).toBe(
			`https://app.example.com:${CONVEX_DASHBOARD_PORT}/`,
		);
	});

	it('works for a localhost origin', () => {
		expect(deriveConvexDashboardUrl('http://localhost:3000/')).toBe('http://localhost:6791/');
	});

	it('falls back to the localhost default for empty/invalid input', () => {
		expect(deriveConvexDashboardUrl('')).toBe(DEFAULT_CONVEX_DASHBOARD_URL);
		expect(deriveConvexDashboardUrl(null)).toBe(DEFAULT_CONVEX_DASHBOARD_URL);
		expect(deriveConvexDashboardUrl('::: not a url')).toBe(DEFAULT_CONVEX_DASHBOARD_URL);
	});
});

describe('resolveConvexDashboardUrl — source priority', () => {
	it('prefers an explicit operator override', () => {
		expect(
			resolveConvexDashboardUrl({
				override: 'https://tunnel.example.com/',
				configured: 'https://configured.example.com/',
				currentHref: 'https://app.example.com/dashboard',
			}),
		).toEqual({ url: 'https://tunnel.example.com/', source: 'override' });
	});

	it('falls back to the configured value when there is no override', () => {
		expect(
			resolveConvexDashboardUrl({
				override: '',
				configured: 'https://configured.example.com/',
				currentHref: 'https://app.example.com/dashboard',
			}),
		).toEqual({ url: 'https://configured.example.com/', source: 'configured' });
	});

	it('derives a guess when neither override nor configured is set (proxy hostname)', () => {
		expect(
			resolveConvexDashboardUrl({
				override: '',
				configured: '',
				currentHref: 'https://mail.acme.io/dashboard/settings',
			}),
		).toEqual({ url: `https://mail.acme.io:${CONVEX_DASHBOARD_PORT}/`, source: 'derived' });
	});

	it('ignores an invalid override and configured value, falling through to derived', () => {
		expect(
			resolveConvexDashboardUrl({
				override: 'javascript:alert(1)',
				configured: 'not a url',
				currentHref: 'http://localhost:3000/',
			}),
		).toEqual({ url: 'http://localhost:6791/', source: 'derived' });
	});
});
