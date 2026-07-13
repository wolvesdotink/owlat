'use node';

/**
 * "Encryption keys published" readiness self-check — the live counterpart to the
 * local-state `e2ee/keys.getReadiness`.
 *
 * The delivery-readiness surface asks a simple operator question: *can the
 * outside world actually discover our Sealed Mail keys?* Answering it honestly
 * means fetching our OWN published endpoints exactly as a remote Owlat instance
 * (or Thunderbird) would and checking they serve well-formed material:
 *   - `/.well-known/owlat.json`            — the signed instance manifest,
 *   - `/.well-known/openpgpkey/policy`     — the WKD policy marker, and
 *   - `/.well-known/openpgpkey/hu/<hash>`  — a real address key over WKD.
 *
 * Pure + fail-soft: `fetch` is injected (see {@link SelfCheckDeps}) so the
 * verdict logic is unit-testable without a live server, and every network / parse
 * failure degrades to "not reachable" rather than throwing into the readiness UI.
 * It reads only PUBLIC endpoints, so it never touches private key material.
 *
 * The manifest's signature is verified against the manifest's OWN served instance
 * public key — a self-consistency check that catches a corrupted or truncated
 * serve. Honesty contract: `published` is true only when the manifest is
 * reachable AND its signature verifies AND it advertises `features.e2ee` AND the
 * WKD policy is reachable AND a real address key is served over WKD.
 */

import { verifyManifest, type SignedManifest } from './manifest';
import { splitAddress, wkdHashForAddress } from './wkd';

/** Structured verdict for the "encryption keys published" self-check. Never throws. */
export type EncryptionKeysPublishedResult = {
	/** The base site URL the check ran against (trailing slashes stripped). */
	siteUrl: string;
	/** What our LOCAL DB believes is published — the truth the live check probes against. */
	localPublished: boolean;
	manifest: {
		/** `/.well-known/owlat.json` returned a well-formed signed manifest. */
		reachable: boolean;
		/** The served manifest's signature verifies against its own served instance key. */
		signatureValid: boolean;
		/** The manifest advertises `features.e2ee === 1`. */
		featuresE2ee: boolean;
		/** The instance signing fingerprint the manifest advertises, when reachable. */
		fingerprint?: string;
	};
	wkd: {
		/** `/.well-known/openpgpkey/policy` is reachable (WKD marker present). */
		policyReachable: boolean;
		/** A real address key was served over WKD `hu/<hash>` (non-empty binary body). */
		keyServed: boolean;
		/** The address whose key we probed over WKD, when one matched the site host. */
		checkedAddress?: string;
	};
	/**
	 * Overall live verdict: the outside world can discover a signed manifest AND a
	 * real address key. Only true when every sub-check the honesty contract names
	 * passes.
	 */
	published: boolean;
};

/** Injectable network dependency so the verdict logic is testable without a live server. */
export type SelfCheckDeps = {
	/** A `fetch`-compatible function. In production this is the global `fetch`. */
	fetch: (url: string) => Promise<Response>;
};

/** Inputs for the self-check: our site URL, local publication truth, and the key directory. */
export type SelfCheckInput = {
	/** The instance site URL (`SITE_URL`) whose `/.well-known` endpoints we probe. */
	siteUrl: string;
	/** `getReadiness().isPublished` — whether our DB believes anything is published. */
	localPublished: boolean;
	/** The published address directory; we probe one address whose domain matches the site host. */
	directory: readonly { address: string }[];
};

/** True when `value` structurally matches a served {@link SignedManifest}. */
function isSignedManifest(value: unknown): value is SignedManifest {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	const instance = record['instance'];
	const features = record['features'];
	if (typeof instance !== 'object' || instance === null) return false;
	if (typeof features !== 'object' || features === null) return false;
	const instanceRecord = instance as Record<string, unknown>;
	const featuresRecord = features as Record<string, unknown>;
	return (
		typeof record['signature'] === 'string' &&
		typeof record['keyDirectoryDigest'] === 'string' &&
		typeof record['rotationFeedUrl'] === 'string' &&
		typeof record['generatedAt'] === 'number' &&
		typeof record['version'] === 'number' &&
		typeof instanceRecord['fingerprint'] === 'string' &&
		typeof instanceRecord['publicKeyArmored'] === 'string' &&
		typeof featuresRecord['e2ee'] === 'number'
	);
}

/** The host (without any port) a WKD `hu/<hash>` request would match against. */
function siteHost(siteUrl: string): string | null {
	try {
		return new URL(siteUrl).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Run the live "encryption keys published" self-check. Fetches our own manifest +
 * WKD endpoints via the injected `fetch`, verifies the served manifest signature,
 * and returns a structured verdict. Never throws — every failure degrades to a
 * "not reachable" sub-result.
 */
export async function checkEncryptionKeysPublished(
	input: SelfCheckInput,
	deps: SelfCheckDeps
): Promise<EncryptionKeysPublishedResult> {
	const base = input.siteUrl.replace(/\/+$/, '');

	const manifest: EncryptionKeysPublishedResult['manifest'] = {
		reachable: false,
		signatureValid: false,
		featuresE2ee: false,
	};
	try {
		const response = await deps.fetch(`${base}/.well-known/owlat.json`);
		if (response.ok) {
			const body: unknown = await response.json();
			if (isSignedManifest(body)) {
				manifest.reachable = true;
				manifest.fingerprint = body.instance.fingerprint;
				manifest.featuresE2ee = body.features.e2ee === 1;
				const { signature, ...payload } = body;
				manifest.signatureValid = await verifyManifest(
					payload,
					signature,
					body.instance.publicKeyArmored
				);
			}
		}
	} catch {
		// Network / parse failure — keep the "not reachable" defaults.
	}

	let policyReachable = false;
	try {
		const response = await deps.fetch(`${base}/.well-known/openpgpkey/policy`);
		policyReachable = response.ok;
	} catch {
		// Keep policyReachable = false.
	}

	// Probe one real address key over WKD. The `hu/<hash>` route matches the
	// request host against the stored bare domain, so a self-fetch can only verify
	// an address whose domain equals our site host.
	const host = siteHost(base);
	const probe = host
		? input.directory.find((entry) => {
				try {
					return splitAddress(entry.address).domain === host;
				} catch {
					return false;
				}
			})
		: undefined;

	let keyServed = false;
	let checkedAddress: string | undefined;
	if (probe) {
		checkedAddress = probe.address;
		try {
			const hash = wkdHashForAddress(probe.address);
			const response = await deps.fetch(`${base}/.well-known/openpgpkey/hu/${hash}`);
			if (response.ok) {
				const bytes = new Uint8Array(await response.arrayBuffer());
				keyServed = bytes.length > 0;
			}
		} catch {
			// Keep keyServed = false.
		}
	}

	const published =
		manifest.reachable &&
		manifest.signatureValid &&
		manifest.featuresE2ee &&
		policyReachable &&
		keyServed;

	return {
		siteUrl: base,
		localPublished: input.localPublished,
		manifest,
		wkd: { policyReachable, keyServed, ...(checkedAddress ? { checkedAddress } : {}) },
		published,
	};
}
