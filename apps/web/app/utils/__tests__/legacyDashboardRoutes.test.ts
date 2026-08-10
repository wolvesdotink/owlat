import { describe, expect, it } from 'vitest';
import { legacyDashboardRedirect } from '../legacyDashboardRoutes';

describe('legacy dashboard redirects', () => {
	it('maps the former administration hubs to their consolidated routes', () => {
		expect(legacyDashboardRedirect('/dashboard/settings')).toBe('/dashboard/admin');
		expect(legacyDashboardRedirect('/dashboard/delivery/domains')).toBe(
			'/dashboard/admin/delivery/domains'
		);
		expect(legacyDashboardRedirect('/dashboard/settings/team')).toBe('/dashboard/admin/team');
	});

	it('maps personal settings to Preferences', () => {
		expect(legacyDashboardRedirect('/dashboard/settings/account')).toBe(
			'/dashboard/preferences/account'
		);
		expect(legacyDashboardRedirect('/dashboard/postbox/settings/signatures')).toBe(
			'/dashboard/preferences/signatures'
		);
	});

	it('preserves plugin and mailbox-member suffixes', () => {
		expect(legacyDashboardRedirect('/dashboard/settings/plugins/example')).toBe(
			'/dashboard/admin/instance/plugins/example'
		);
		expect(legacyDashboardRedirect('/dashboard/postbox/settings/members/mailbox-id')).toBe(
			'/dashboard/preferences/members/mailbox-id'
		);
	});

	it('returns null for canonical and unrelated paths', () => {
		expect(legacyDashboardRedirect('/dashboard/preferences')).toBeNull();
		expect(legacyDashboardRedirect('/dashboard/campaigns')).toBeNull();
	});
});
