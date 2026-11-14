/**
 * Terminal-wizard section: the optional integrations a feature flag asks for
 * (Google Safe Browsing, PostHog, Microsoft sign-in for connected mailboxes).
 * Each returns the env patch for its answers, or `null` when a prompt was
 * cancelled or a key failed its check.
 */

import { confirm, group, isCancel, password, text } from '@clack/prompts';
import type { EnvMap } from '../lib/env';
import { validateWithSpinner } from '../lib/progress';
import { validateGoogleSafeBrowsingKey, validatePostHogHost } from '../lib/validators';

export async function collectGoogleSafeBrowsing(): Promise<EnvMap | null> {
	const apiKey = await password({ message: 'Google Safe Browsing API key' });
	if (isCancel(apiKey)) return null;
	if (
		!(await validateWithSpinner('Validating Google Safe Browsing key', () =>
			validateGoogleSafeBrowsingKey(apiKey as string)
		))
	) {
		return null;
	}
	return { GOOGLE_SAFE_BROWSING_API_KEY: apiKey as string };
}

export async function collectPostHog(): Promise<EnvMap | null> {
	const result = await group({
		host: () => text({ message: 'PostHog host', placeholder: 'https://app.posthog.com' }),
		apiKey: () => password({ message: 'PostHog API key (phc_...)' }),
	});
	if (
		!(await validateWithSpinner('Checking PostHog reachability', () =>
			validatePostHogHost(result.host, result.apiKey)
		))
	) {
		return null;
	}
	return {
		POSTHOG_API_KEY: result.apiKey,
		POSTHOG_HOST: result.host,
		NUXT_PUBLIC_POSTHOG_API_KEY: result.apiKey,
		NUXT_PUBLIC_POSTHOG_HOST: result.host,
	};
}

/**
 * Optional: the Microsoft app registration that lets users connect Outlook and
 * Microsoft 365 mailboxes by signing in with Microsoft. Skipping it is a
 * supported answer (an empty patch); only a cancelled prompt returns `null`.
 */
export async function collectMicrosoftOAuth(): Promise<EnvMap | null> {
	const wanted = await confirm({
		message:
			'Offer "Sign in with Microsoft" for Outlook and Microsoft 365 mailboxes? (needs an app registered in Microsoft Entra)',
		initialValue: false,
	});
	if (isCancel(wanted)) return null;
	if (!wanted) return {};
	const result = await group({
		clientId: () =>
			text({
				message: 'Application (client) ID',
				validate: (v) => (v?.trim() ? undefined : 'Enter the application ID'),
			}),
		clientSecret: () => password({ message: 'Client secret value' }),
		tenant: () =>
			text({
				message: 'Tenant (common, organizations, consumers, or a tenant ID or domain)',
				initialValue: 'common',
				validate: (v) =>
					/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(v?.trim() ?? '')
						? undefined
						: 'Enter common, organizations, consumers, a tenant ID or a domain',
			}),
	});
	if (isCancel(result) || !result.clientSecret) return null;
	return {
		MICROSOFT_OAUTH_CLIENT_ID: result.clientId.trim(),
		MICROSOFT_OAUTH_CLIENT_SECRET: result.clientSecret,
		MICROSOFT_OAUTH_TENANT: result.tenant.trim(),
	};
}
