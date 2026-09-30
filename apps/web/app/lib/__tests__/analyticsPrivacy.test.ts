import { describe, expect, it } from 'vitest';
import type { CaptureResult } from 'posthog-js';
import {
	isPrivateRouteName,
	routePattern,
	sanitizeAnalyticsEvent,
	sanitizeAnalyticsUrl,
	type AnalyticsUrlContext,
	type ResolvedRoute,
} from '../analyticsPrivacy';

const ORIGIN = 'https://app.example.com';

/** A stand-in for the router: three routes, matched the way vue-router would. */
function routeOf(pathname: string): ResolvedRoute | null {
	if (pathname === '/share') return { name: 'share', pattern: '/share' };
	if (pathname === '/dashboard') return { name: 'dashboard', pattern: '/dashboard' };
	const contact = /^\/dashboard\/contacts\/[^/]+$/.exec(pathname);
	if (contact) return { name: 'dashboard-contacts-id', pattern: '/dashboard/contacts/:id' };
	return null;
}

function at(path: string): AnalyticsUrlContext {
	return { base: ORIGIN + path, routeOf };
}

const onDashboard = at('/dashboard');

function event(name: string, properties: Record<string, unknown>, extra = {}): CaptureResult {
	return { uuid: 'u1', event: name, properties, ...extra };
}

describe('routePattern', () => {
	it('names every parameter and drops custom regexes and modifiers', () => {
		expect(
			routePattern('/dashboard/postbox/:folder()/:messageId?', { folder: 'inbox', messageId: 'm1' })
		).toBe('/dashboard/postbox/:folder/:messageId');
		expect(routePattern('/files/:path(.*)*', { path: ['a', 'b'] })).toBe('/files/:path');
	});

	it('leaves out an optional segment the location does not fill', () => {
		expect(
			routePattern('/dashboard/postbox/:folder()/:messageId?', { folder: 'inbox', messageId: '' })
		).toBe('/dashboard/postbox/:folder');
		expect(routePattern('/files/:path(.*)*', { path: [] })).toBe('/files');
	});

	it('keeps static paths as they are', () => {
		expect(routePattern('/share')).toBe('/share');
		expect(routePattern('/')).toBe('/');
	});
});

describe('sanitizeAnalyticsUrl', () => {
	it('reduces a same-origin URL to its route pattern', () => {
		expect(
			sanitizeAnalyticsUrl(
				`${ORIGIN}/dashboard/contacts/PATH_SENTINEL?q=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
				onDashboard
			)
		).toBe(`${ORIGIN}/dashboard/contacts/:id`);
		expect(sanitizeAnalyticsUrl('/share?token=QUERY_SENTINEL#FRAGMENT_SENTINEL', onDashboard)).toBe(
			'/share'
		);
		expect(sanitizeAnalyticsUrl('share?token=QUERY_SENTINEL', onDashboard)).toBe('/share');
	});

	it('reduces another origin to the origin, and a host-less URL to its scheme', () => {
		expect(
			sanitizeAnalyticsUrl(
				'https://webmail.example.org/read/PATH_SENTINEL?m=QUERY_SENTINEL',
				onDashboard
			)
		).toBe('https://webmail.example.org');
		expect(sanitizeAnalyticsUrl('//cdn.example.org/x?QUERY_SENTINEL', onDashboard)).toBe(
			'https://cdn.example.org'
		);
		expect(sanitizeAnalyticsUrl('mailto:ada@example.com?subject=QUERY_SENTINEL', onDashboard)).toBe(
			'mailto:'
		);
	});

	it('hides a same-origin path no route matches, but keeps build asset names', () => {
		expect(sanitizeAnalyticsUrl(`${ORIGIN}/api/v1/PATH_SENTINEL?QUERY_SENTINEL`, onDashboard)).toBe(
			`${ORIGIN}/:unmatched`
		);
		expect(
			sanitizeAnalyticsUrl(`${ORIGIN}/_nuxt/entry.js:12:4?v=QUERY_SENTINEL`, onDashboard)
		).toBe(`${ORIGIN}/_nuxt/entry.js:12:4`);
	});

	it("leaves PostHog's $direct marker alone and is idempotent", () => {
		expect(sanitizeAnalyticsUrl('$direct', onDashboard)).toBe('$direct');
		const once = sanitizeAnalyticsUrl(`${ORIGIN}/dashboard/contacts/c1?x=1`, onDashboard);
		expect(sanitizeAnalyticsUrl(once, onDashboard)).toBe(once);
	});
});

describe('sanitizeAnalyticsEvent', () => {
	it('reduces every URL on the event, nested ones and ones inside text included', () => {
		const raw = event(
			'$autocapture',
			{
				token: 'phc_project_key',
				$current_url: `${ORIGIN}/dashboard/contacts/PATH_SENTINEL?q=QUERY_SENTINEL#FRAGMENT_SENTINEL`,
				$pathname: '/dashboard/contacts/PATH_SENTINEL',
				$referrer: 'https://webmail.example.org/read?m=QUERY_SENTINEL',
				$external_click_url: 'https://other.example.org/p/PATH_SENTINEL',
				$raw_user_agent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)',
				$timezone: 'Europe/Berlin',
				$elements: [{ tag_name: 'a', attr__href: '/share?token=QUERY_SENTINEL' }],
				$elements_chain:
					'a.row:attr__href="/share?token=QUERY_SENTINEL#FRAGMENT_SENTINEL"href="/share?token=QUERY_SENTINEL"nth-child="1"',
				$exception_message: `Failed to load ${ORIGIN}/share?token=QUERY_SENTINEL`,
				$exception_stack_trace_raw: `at go (${ORIGIN}/_nuxt/entry.js:1:2)\nPage not found: /dashboard/contacts/PATH_SENTINEL?x=QUERY_SENTINEL`,
			},
			{
				$set_once: {
					$initial_current_url: `${ORIGIN}/share?token=QUERY_SENTINEL`,
					$initial_pathname: '/dashboard/contacts/PATH_SENTINEL',
				},
			}
		);

		const sent = sanitizeAnalyticsEvent(raw, onDashboard)!;

		expect(JSON.stringify(sent)).not.toMatch(/SENTINEL/);
		expect(sent.properties).toMatchObject({
			token: 'phc_project_key',
			$current_url: `${ORIGIN}/dashboard/contacts/:id`,
			$pathname: '/dashboard/contacts/:id',
			$referrer: 'https://webmail.example.org',
			$external_click_url: 'https://other.example.org',
			$raw_user_agent: raw.properties['$raw_user_agent'],
			$timezone: 'Europe/Berlin',
			$elements: [{ tag_name: 'a', attr__href: '/share' }],
			$elements_chain: 'a.row:attr__href="/share"href="/share"nth-child="1"',
			$exception_message: `Failed to load ${ORIGIN}/share`,
			$exception_stack_trace_raw: `at go (${ORIGIN}/_nuxt/entry.js:1:2)\nPage not found: /dashboard/contacts/:id`,
		});
		expect(sent.$set_once).toEqual({
			$initial_current_url: `${ORIGIN}/share`,
			$initial_pathname: '/dashboard/contacts/:id',
		});
		expect(sent.uuid).toBe('u1');
	});

	it('reads URL objects and nested records the way they will be serialised', () => {
		const deep: Record<string, unknown> = {};
		let cursor = deep;
		for (let i = 0; i < 20; i++) cursor = cursor['next'] = {} as Record<string, unknown>;
		cursor['leaf'] = '/share?token=QUERY_SENTINEL';
		const sent = sanitizeAnalyticsEvent(
			event('owlat_probe', {
				target: new URL(`${ORIGIN}/share?token=QUERY_SENTINEL`),
				deep,
			}),
			onDashboard
		)!;
		expect(JSON.stringify(sent)).not.toMatch(/SENTINEL/);
		expect(sent.properties['target']).toBe(`${ORIGIN}/share`);
	});

	it('reduces URLs in an exception message whatever form they take', () => {
		const messages = {
			networkPath: 'Failed to fetch //owlat.example/confirm?token=QUERY_SENTINEL#FRAGMENT_SENTINEL',
			sameOriginNetworkPath:
				'Failed to fetch //app.example.com/dashboard/contacts/PATH_SENTINEL?q=QUERY_SENTINEL',
			jsonEscaped: '{"next":"https:\\/\\/owlat.example\\/share?token=QUERY_SENTINEL"}',
			encoded: `redirect=https%3A%2F%2Fapp.example.com%2Fshare%3Ftoken%3DQUERY_SENTINEL failed`,
			www: 'Could not open www.owlat.example/confirm?token=QUERY_SENTINEL#FRAGMENT_SENTINEL',
			detached: 'Unexpected ?token=QUERY_SENTINEL&x=1 and #state=FRAGMENT_SENTINEL',
			bareHost: 'Could not open owlat.example/confirm?token=QUERY_SENTINEL&code=QUERY_SENTINEL',
		};
		const sent = sanitizeAnalyticsEvent(
			event('$exception', { $exception_list: [{ value: messages.networkPath }], ...messages }),
			onDashboard
		)!;

		expect(JSON.stringify(sent)).not.toMatch(/SENTINEL/);
		expect(sent.properties).toMatchObject({
			$exception_list: [{ value: 'Failed to fetch https://owlat.example' }],
			networkPath: 'Failed to fetch https://owlat.example',
			sameOriginNetworkPath: `Failed to fetch ${ORIGIN}/dashboard/contacts/:id`,
			jsonEscaped: '{"next":"https://owlat.example"}',
			encoded: `redirect=${ORIGIN}/share failed`,
			www: 'Could not open https://www.owlat.example',
			detached: 'Unexpected  and ',
			bareHost: 'Could not open owlat.example/confirm?token=&code=',
		});
	});

	it('reduces a URL or path however the message wraps it', () => {
		const wrapped = {
			angle: 'Failed <//owlat.example/unsubscribe/PATH_SENTINEL>',
			backtick: 'Failed `//owlat.example/confirm?x=QUERY_SENTINEL`',
			square: 'Failed [//owlat.example/confirm?t=QUERY_SENTINEL#FRAGMENT_SENTINEL]',
			semicolon: 'a;//owlat.example/confirm?x=QUERY_SENTINEL',
			pipe: 'a|/dashboard/contacts/PATH_SENTINEL|b',
			squarePath: 'Failed [/dashboard/contacts/PATH_SENTINEL]',
			braces: '{/share?x=QUERY_SENTINEL}',
			ipv6: 'Failed //[2001:db8::1]:8443/confirm?x=QUERY_SENTINEL',
		};
		const sent = sanitizeAnalyticsEvent(event('$exception', wrapped), onDashboard)!;

		expect(JSON.stringify(sent)).not.toMatch(/SENTINEL/);
		expect(sent.properties).toMatchObject({
			angle: 'Failed <https://owlat.example>',
			backtick: 'Failed `https://owlat.example`',
			square: 'Failed [https://owlat.example]',
			semicolon: 'a;https://owlat.example',
			pipe: 'a|/dashboard/contacts/:id|b',
			squarePath: 'Failed [/dashboard/contacts/:id]',
			braces: '{/share}',
			ipv6: 'Failed https://[2001:db8::1]:8443',
		});
	});

	it('reduces percent-encoded paths, doubly escaped slashes and slash-less schemes', () => {
		const forms = {
			encodedNetworkPath: 'redirect=%2F%2Fowlat.example%2Fconfirm%3Fx%3DQUERY_SENTINEL&y=1',
			encodedPath: 'next=%2Fshare%3Ftoken%3DQUERY_SENTINEL',
			doublyEscaped: 'next: \\\\/\\\\/owlat.example/confirm?x=QUERY_SENTINEL',
			noSlashes: 'open https:owlat.example/confirm?x=QUERY_SENTINEL',
			oneSlash: 'open http:/owlat.example/confirm?x=QUERY_SENTINEL',
		};
		const sent = sanitizeAnalyticsEvent(event('$exception', forms), onDashboard)!;

		expect(JSON.stringify(sent)).not.toMatch(/SENTINEL/);
		expect(sent.properties).toMatchObject({
			encodedNetworkPath: 'redirect=https://owlat.example&y=1',
			encodedPath: 'next=/share',
			doublyEscaped: 'next: https://owlat.example',
			oneSlash: 'open http://owlat.example',
		});
	});

	it('stays linear on long runs of URL-like characters', () => {
		for (const unit of ['a.', 'a-', 'a+', 'a%', '%2F', 'www.', '?a', 'a/', '/', 'href="']) {
			const text = unit.repeat(Math.ceil(100_000 / unit.length));
			const started = performance.now();
			sanitizeAnalyticsEvent(event('$exception', { $exception_message: text }), onDashboard);
			// A quadratic scan takes seconds here; linear takes a few milliseconds.
			expect(performance.now() - started, unit).toBeLessThan(500);
		}
	});

	it('leaves prose and quoted element attributes alone', () => {
		const text = 'Are you sure? Use a/b testing // later, state="open" nth-child="2"';
		const sent = sanitizeAnalyticsEvent(event('owlat_probe', { text }), onDashboard)!;
		expect(sent.properties['text']).toBe(text);
	});

	it('drops everything captured on a credential page', () => {
		expect(
			sanitizeAnalyticsEvent(event('$pageleave', {}), at('/share?token=QUERY_SENTINEL'))
		).toBeNull();
		expect(isPrivateRouteName('share')).toBe(true);
		expect(isPrivateRouteName('dashboard')).toBe(false);
	});

	it('drops a sample labelled with a credential page, sent after leaving it', () => {
		expect(
			sanitizeAnalyticsEvent(event('owlat_boot_shell_ms', { route: 'share' }), onDashboard)
		).toBeNull();
		expect(
			sanitizeAnalyticsEvent(event('owlat_boot_shell_ms', { route: 'dashboard' }), onDashboard)
		).not.toBeNull();
	});

	it('drops replay snapshots and heatmaps, whose payloads are pages and raw URLs', () => {
		expect(sanitizeAnalyticsEvent(event('$snapshot', {}), onDashboard)).toBeNull();
		expect(sanitizeAnalyticsEvent(event('$$heatmap', {}), onDashboard)).toBeNull();
	});
});
