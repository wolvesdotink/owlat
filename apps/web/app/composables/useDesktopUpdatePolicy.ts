import { api } from '@owlat/api';

/**
 * The desktop-update policy as one data seam: what this instance currently
 * offers connected desktop apps, when it last polled GitHub, which releases it
 * has cached for the pin picker, and the two writes — save the policy, poll now.
 *
 * It lives here rather than inside a page because the same four calls back both
 * the admin policy page and the "managed by your admin" line on the device
 * page, and because the reads are plain subscriptions: the page is a template
 * over this, with no query wiring of its own.
 *
 * Reading the policy is open to every member (the summary is served
 * unauthenticated anyway); the cached-release list and both writes are gated on
 * `settings:manage` server-side, so a page may render the controls disabled and
 * still not be able to get ahead of the backend.
 */
export function useDesktopUpdatePolicy() {
	const { t } = useI18n();

	const { data: policy, isLoading, error } = useConvexQuery(api.desktop.updates.getPolicy, {});
	const { data: releases } = useConvexQuery(api.desktop.updates.listReleases, {});

	const { run: savePolicy, isLoading: isSaving } = useBackendOperation(
		api.desktop.updates.updatePolicy,
		{ label: () => t('shared.useDesktopUpdatePolicy.saveOperation') }
	);
	const { run: checkNow, isLoading: isChecking } = useBackendOperation(
		api.desktop.updates.checkNow,
		{ label: () => t('shared.useDesktopUpdatePolicy.checkOperation'), type: 'action' }
	);

	return { policy, releases, isLoading, error, savePolicy, isSaving, checkNow, isChecking };
}
