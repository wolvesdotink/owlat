/**
 * Server provisioning core (desktop "set up a new server" flow).
 *
 * Pure, framework-free building blocks the wizard composable orchestrates: the
 * SSH transport contract, the setup config the wizard produces, the apex-domain
 * → hostname expansion, and the reachability / host-key guards.
 *
 * The command strings driven over SSH live in `provisioningCommands.ts`, and the
 * step timeline (plus `applyStepEvent`) in `provisioningTimeline.ts`.
 *
 * Keeping this here (no Vue, no Tauri) means the whole orchestration is unit
 * testable with a fake transport and scripted events — the SSH path itself can
 * only be exercised against a real server.
 */

import type { ConnectInfo, ExecEvent, LocalBuild, SshAuth } from '@owlat/desktop/src/ssh';
import type { SetupConfig } from '@owlat/shared/setupConfigTypes';

// Split to stay under the file-size cap; consumers keep importing from here.
export * from './provisioningCommands';
export * from './provisioningTimeline';

// ---- transport (implemented by the native bridge, faked in tests) ----------

// The bridge's own types, re-exported type-only: the native module itself is
// only ever loaded lazily (see createTauriTransport), so this adds no runtime
// import and the transport contract cannot drift from what the bridge returns.
export type { ConnectInfo, ExecEvent, LocalBuild, SshAuth };

export interface ProvisionTransport {
	connect(host: string, port: number): Promise<ConnectInfo>;
	/** `acceptChanged` must be true to (re)accept a host key that has CHANGED (MITM guard). */
	acceptHostKey(sessionId: string, acceptChanged?: boolean): Promise<void>;
	authenticate(sessionId: string, username: string, auth: SshAuth): Promise<void>;
	execStream(sessionId: string, command: string, onEvent: (e: ExecEvent) => void): Promise<number>;
	writeFile(sessionId: string, path: string, content: string, mode?: string): Promise<void>;
	uploadDir(sessionId: string, localDir: string, remoteDir: string): Promise<void>;
	/** Stream locally built images to the server (docker save → load). */
	pushImages(sessionId: string, images: string[], onEvent: (e: ExecEvent) => void): Promise<void>;
	/**
	 * Build images on THIS machine in the checkout at `localDir`, streaming
	 * output. The session owns the build: cancelling it kills the build.
	 */
	localBuild(
		sessionId: string,
		localDir: string,
		build: LocalBuild,
		onEvent: (e: ExecEvent) => void
	): Promise<number>;
	/**
	 * Stop whatever runs on the session, keeping the session; the stopped call
	 * rejects. Never kills a command already running on the server.
	 */
	cancel(sessionId: string): Promise<void>;
	disconnect(sessionId: string): Promise<void>;
}

/** Lazily wraps the desktop SSH bridge so this module stays importable on web/tests. */
export async function createTauriTransport(): Promise<ProvisionTransport> {
	const ssh = await import('@owlat/desktop/src/ssh');
	return {
		connect: (host, port) => ssh.sshConnect(host, port),
		acceptHostKey: (id, acceptChanged) => ssh.sshAcceptHostKey(id, acceptChanged),
		authenticate: (id, user, auth) => ssh.sshAuthenticate(id, user, auth),
		execStream: (id, cmd, on) => ssh.sshExecStream(id, cmd, on),
		writeFile: (id, path, content, mode) => ssh.sshWriteFile(id, path, content, mode),
		uploadDir: (id, localDir, remoteDir) => ssh.sshUploadDir(id, localDir, remoteDir),
		pushImages: (id, images, on) => ssh.sshPushImages(id, images, on),
		localBuild: (id, localDir, build, on) => ssh.localDockerBuild(id, localDir, build, on),
		cancel: (id) => ssh.sshCancel(id),
		disconnect: (id) => ssh.sshDisconnect(id),
	};
}

// ---- the setup config the wizard produces (consumed by setup-cli) ----------
// One declaration shared with setup-cli, whose `parseSetupConfig` validates it
// on the server: a renamed field or a misspelled flag / pack key fails to
// compile here instead of failing the install over SSH.

export type { SendingConfig } from '@owlat/shared/setupConfigTypes';

/** The wizard's name for the shared {@link SetupConfig}. */
export type SetupConfigInput = SetupConfig;

/**
 * The subdomain prefixes a single apex domain expands into. One source of
 * truth for the wizard, the DNS instructions, and `Caddyfile.example`'s
 * convention. `convexSite` is `rest.api` (two labels) — the only multi-label
 * prefix. The wizard lets the operator override any of these (see
 * {@link deriveHostnames}); this map is the default when they don't.
 */
export const SUBDOMAINS = {
	site: 'owlat',
	convex: 'api',
	convexSite: 'rest.api',
	mail: 'mail',
	bounce: 'bounce',
} as const;

/** The identity of each overridable subdomain label. */
export type SubdomainKey = keyof typeof SUBDOMAINS;

/** A full set of subdomain labels (the shape of {@link SUBDOMAINS}). */
export type SubdomainLabels = Record<SubdomainKey, string>;

/** The subdomain keys in a stable iteration order. */
export const SUBDOMAIN_KEYS = Object.keys(SUBDOMAINS) as SubdomainKey[];

/**
 * The five overridable labels with UI copy, in wizard order. Lives here (not in
 * the component) so the fields, their defaults and this metadata cannot drift
 * from the {@link SUBDOMAINS} map they describe. `label`/`hint` are i18n keys —
 * module scope cannot call `useI18n`, so the form translates them.
 */
export const SUBDOMAIN_FIELDS: ReadonlyArray<{ key: SubdomainKey; label: string; hint: string }> = [
	{
		key: 'site',
		label: 'shared.desktop.provisioning.subdomainFields.site.label',
		hint: 'shared.desktop.provisioning.subdomainFields.site.hint',
	},
	{
		key: 'convex',
		label: 'shared.desktop.provisioning.subdomainFields.convex.label',
		hint: 'shared.desktop.provisioning.subdomainFields.convex.hint',
	},
	{
		key: 'convexSite',
		label: 'shared.desktop.provisioning.subdomainFields.convexSite.label',
		hint: 'shared.desktop.provisioning.subdomainFields.convexSite.hint',
	},
	{
		key: 'mail',
		label: 'shared.desktop.provisioning.subdomainFields.mail.label',
		hint: 'shared.desktop.provisioning.subdomainFields.mail.hint',
	},
	{
		key: 'bounce',
		label: 'shared.desktop.provisioning.subdomainFields.bounce.label',
		hint: 'shared.desktop.provisioning.subdomainFields.bounce.hint',
	},
] as const;

/** A fresh copy of the default labels — for prefilling the override inputs. */
export function defaultSubdomainLabels(): SubdomainLabels {
	return { ...SUBDOMAINS };
}

/** The i18n key of a subdomain field's label (for user-facing copy). */
export function subdomainFieldLabel(key: SubdomainKey): string {
	return SUBDOMAIN_FIELDS.find((f) => f.key === key)?.label ?? key;
}

export interface InstanceHostnames {
	/** The app (Nuxt). */
	site: string;
	/** Convex sync backend (WebSocket + HTTP). */
	convex: string;
	/** Convex HTTP actions (auth, webhooks, tracking). */
	convexSite: string;
	/** MTA EHLO hostname (outbound SMTP identity). */
	mail: string;
	/** Bounce / Return-Path domain. */
	bounce: string;
}

/** Strip scheme/trailing slashes from a user-typed apex domain. */
export function normalizeDomain(input: string): string {
	return input
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/\/+$/, '');
}

/**
 * One DNS label segment (RFC 1035): 1–63 chars, lowercase letters/digits/hyphen,
 * no leading or trailing hyphen. A `rest.api`-style dotted prefix is several of
 * these joined by dots, each validated in turn.
 */
const DNS_LABEL_SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validate a single overridable subdomain label, allowing the dotted
 * (`rest.api`) form. Returns a human error string, or null when the label is
 * DNS-safe. Case-sensitive on purpose: hostnames are lowercase by convention
 * and the derived config/DNS records must be reproducible, so an uppercase or
 * otherwise off-charset label is rejected rather than silently normalised.
 */
export function validateSubdomainLabel(label: string): string | null {
	const l = label.trim();
	if (!l) return 'shared.desktop.provisioning.errors.labelRequired';
	for (const segment of l.split('.')) {
		if (!DNS_LABEL_SEGMENT.test(segment)) {
			return 'shared.desktop.provisioning.errors.labelCharset';
		}
	}
	return null;
}

/** Per-field validation result for the whole override set. */
export interface SubdomainLabelsValidation {
	ok: boolean;
	/** Inline error keyed by field; absent keys are valid. */
	errors: Partial<Record<SubdomainKey, string>>;
}

/**
 * Validate an override set: every label must be DNS-safe AND the labels must be
 * mutually distinct (two hostnames sharing a label would collide onto the same
 * DNS record). A collision is reported on the *later* field so the first
 * occurrence stays clean, and only labels that already pass the charset check
 * are compared so a duplicate error never masks a malformed one.
 *
 * `keys` scopes validation to the labels actually in play — the caller passes
 * only the active ones (e.g. mail/bounce are inert without the self-hosted MTA),
 * so an unused label never blocks provisioning or collides with a live one.
 */
export function validateSubdomainLabels(
	labels: SubdomainLabels,
	keys: readonly SubdomainKey[] = SUBDOMAIN_KEYS
): SubdomainLabelsValidation {
	const errors: Partial<Record<SubdomainKey, string>> = {};
	for (const key of keys) {
		const err = validateSubdomainLabel(labels[key]);
		if (err) errors[key] = err;
	}
	const seen = new Map<string, SubdomainKey>();
	for (const key of keys) {
		if (errors[key]) continue;
		const value = labels[key].trim();
		const prior = seen.get(value);
		if (prior) {
			// One message PER prior field rather than one with the field name
			// interpolated: the interpolated value would itself be a message key, and
			// nothing at the render boundary can translate a parameter.
			errors[key] = `shared.desktop.provisioning.errors.duplicateLabel.${prior}`;
		} else {
			seen.set(value, key);
		}
	}
	return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Expand an apex domain (`wolves.ink`) into every owlat hostname. Any non-empty
 * label override replaces its default; blank/whitespace overrides fall back to
 * {@link SUBDOMAINS}. This is the ONE place subdomain labels turn into
 * hostnames — the wizard's DNS instructions, generated config and network URLs
 * all flow from here, so an override cannot drift between them.
 */
export function deriveHostnames(
	domain: string,
	overrides: Partial<SubdomainLabels> = {}
): InstanceHostnames {
	const d = normalizeDomain(domain);
	const l: SubdomainLabels = { ...SUBDOMAINS };
	for (const key of SUBDOMAIN_KEYS) {
		const value = overrides[key]?.trim();
		if (value) l[key] = value;
	}
	return {
		site: `${l.site}.${d}`,
		convex: `${l.convex}.${d}`,
		convexSite: `${l.convexSite}.${d}`,
		mail: `${l.mail}.${d}`,
		bounce: `${l.bounce}.${d}`,
	};
}

/**
 * Public HTTPS URLs from explicit hostnames (which may be user-overridden),
 * following the `Caddyfile.example` convention (the `owlat.` / `api.` /
 * `rest.api.` subdomains served behind the `tls` profile). Callers pair it with
 * {@link deriveHostnames} to go from an apex domain to URLs; the operator must
 * point those DNS records at the server and open 80/443 for TLS to be issued.
 */
export function networkUrlsFromHosts(
	h: Pick<InstanceHostnames, 'site' | 'convex' | 'convexSite'>
): { siteUrl: string; convexUrl: string; convexSiteUrl: string } {
	return {
		siteUrl: `https://${h.site}`,
		convexUrl: `https://${h.convex}`,
		convexSiteUrl: `https://${h.convexSite}`,
	};
}

// ---- reachability + host-key guards (UX traps) -----------------------------

/**
 * Loopback hostnames a desktop app can never reach on a *remote* server: the
 * app's `localhost` is the user's own machine, not the box we provisioned. Used
 * to keep the wizard from baking — or trying to open — an unreachable URL.
 */
export function isLoopbackHost(host: string): boolean {
	const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
	if (!h) return false;
	if (h === 'localhost' || h === '0.0.0.0' || h === '::1') return true;
	return h.startsWith('127.');
}

/** Whether a full URL (or bare host) points at a loopback address. */
export function isLoopbackUrl(url: string | null | undefined): boolean {
	const raw = (url ?? '').trim();
	if (!raw) return false;
	try {
		return isLoopbackHost(new URL(raw).hostname);
	} catch {
		return isLoopbackHost(raw);
	}
}

/**
 * Whether the freshly-provisioned instance may be opened as a workspace from the
 * desktop. It must have a public (non-loopback) URL that the app has actually
 * confirmed reachable (DNS resolved + TLS issued). Guards the "success before
 * usable" trap, where the installer finishes before the public URL works.
 */
export function canOpenWorkspaceUrl(
	siteUrl: string | null | undefined,
	reachable: boolean
): boolean {
	if (!siteUrl) return false;
	if (isLoopbackUrl(siteUrl)) return false;
	return reachable;
}

export interface HostKeyPrompt {
	status: ConnectInfo['knownHostStatus'];
	/** A *changed* key (already trusted, now different) is the MITM case; a brand-new key is plain TOFU. */
	isMismatch: boolean;
	/** A changed key demands an explicit extra confirmation beyond the single accept click. */
	requiresExplicitConfirmation: boolean;
	tone: 'warn' | 'danger';
	/** i18n key. */
	title: string;
	/** i18n key. */
	body: string;
}

/**
 * Describe the host-key prompt so the UI (and tests) treat a brand-new key
 * (trust-on-first-use) differently from a key that has CHANGED since last time
 * (possible interception) — the latter must never be a same-click accept.
 */
export function describeHostKey(status: ConnectInfo['knownHostStatus']): HostKeyPrompt {
	if (status === 'mismatch') {
		return {
			status,
			isMismatch: true,
			requiresExplicitConfirmation: true,
			tone: 'danger',
			title: 'shared.desktop.provisioning.hostKey.changed.title',
			body: 'shared.desktop.provisioning.hostKey.changed.body',
		};
	}
	return {
		status,
		isMismatch: false,
		requiresExplicitConfirmation: false,
		tone: 'warn',
		title: 'shared.desktop.provisioning.hostKey.verify.title',
		body: 'shared.desktop.provisioning.hostKey.verify.body',
	};
}
