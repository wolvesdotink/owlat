/**
 * The non-interactive setup config contract: the JSON that `owlat setup
 * --config <file>` reads.
 *
 * Two programs speak it. The desktop "set up a new server" wizard writes it and
 * uploads it over SSH; setup-cli parses it on the target host with
 * `parseSetupConfig` (apps/setup-cli/src/lib/setupConfig.ts), which stays the
 * runtime validator. Both halves import the types from here, so a renamed field
 * or a misspelled flag / pack key is a compile error on the writing side rather
 * than a failed install mid-provision.
 *
 * Types only: no runtime code, and only type imports, so importing this module
 * never widens a bundle or a Docker source closure.
 */

import type { FeatureFlagState, FeaturePackKey } from './featureFlags';

export type DeploymentMode = 'selfhost' | 'dev' | 'hosted';

export type SendingConfig =
	| { provider: 'mta' }
	| { provider: 'resend'; apiKey: string }
	| { provider: 'emailit'; apiKey: string }
	| { provider: 'ses'; region: string; accessKeyId: string; secretAccessKey: string }
	| {
			provider: 'smtp';
			host: string;
			/** Optional — defaults to 587 (STARTTLS) in the backend adapter. */
			port?: number;
			/** true ⇒ implicit TLS (usually 465); default false ⇒ STARTTLS (587). */
			secure?: boolean;
			username: string;
			password: string;
	  };

export type AiConfig =
	| { provider: 'openrouter'; apiKey: string }
	| { provider: 'openai'; apiKey: string }
	| { provider: 'ollama' }
	| {
			provider: 'custom';
			baseUrl: string;
			apiKey: string;
			modelFast: string;
			modelCapable: string;
	  };

export interface SetupConfig {
	version: 1;
	deploymentMode: DeploymentMode;
	features: {
		/** Explicit flag overrides (highest precedence). */
		flags?: FeatureFlagState;
		/** Feature-pack toggles, applied on top of the defaults before `flags`. */
		packs?: Partial<Record<FeaturePackKey, boolean>>;
	};
	sending?: SendingConfig;
	ai?: AiConfig;
	integrations?: {
		googleSafeBrowsingKey?: string;
		posthog?: { host: string; apiKey: string };
	};
	admin: { email: string; name: string; password: string };
	/** MTA self-host only — EHLO + Return-Path domains. */
	domain?: { ehloHostname: string; bounceDomain: string };
	/**
	 * Public URLs for remote access (served behind the `tls` Caddy profile).
	 * Omit for a same-host / localhost install. When set, these override the
	 * localhost defaults so the web app + Convex are reachable off-box.
	 */
	network?: { siteUrl: string; convexUrl: string; convexSiteUrl: string };
	/** Seed realistic demo data after bootstrap (default: false). */
	seedDemo?: boolean;
}
