/**
 * RFC 8617 ARC chain parsing + structural validation.
 *
 * Turns a message's ARC headers into a contiguous, instance-ordered chain and
 * enforces the structure that must hold before any seal is trusted — matching
 * `mailauth`'s `getARChain`. Every rejection is a thrown Error the orchestrator
 * (`verify.ts`) maps to a `cv: 'fail'` verdict; nothing here reaches the network.
 */

import type { HeaderField } from '../dkim/message.js';
import { parseTagList } from '../dkim/tagList.js';

/** Bound on the ARC chain length we evaluate (RFC 8617 §5.1.1 hard cap). */
export const MAX_ARC_INSTANCES = 50;

/** One fully-populated ARC instance: its three headers plus parsed AS/AMS tags. */
export interface ArcSet {
	readonly instance: number;
	readonly aar: HeaderField;
	readonly ams: HeaderField;
	readonly seal: HeaderField;
	readonly sealTags: Map<string, string>;
	readonly amsTags: Map<string, string>;
}

/** Accumulator for one instance while its three headers are still being gathered. */
interface PartialArcSet {
	aar?: HeaderField;
	ams?: HeaderField;
	seal?: HeaderField;
}

/** Which ARC header a field is, or `null` if it is not an ARC header. */
export function arcHeaderKind(name: string): 'aar' | 'ams' | 'seal' | null {
	switch (name) {
		case 'arc-authentication-results':
			return 'aar';
		case 'arc-message-signature':
			return 'ams';
		case 'arc-seal':
			return 'seal';
		default:
			return null;
	}
}

/** Parse an ARC header field's `tag=value` list (names lowercased, values trimmed). */
function parseArcTags(rawField: string): Map<string, string> {
	const colon = rawField.indexOf(':');
	const value = colon === -1 ? rawField : rawField.slice(colon + 1);
	return parseTagList(value, { lowercaseName: true, normalizeValue: (raw) => raw.trim() });
}

/** The instance number of an ARC header, or `undefined` when `i=` is missing/malformed. */
function parseInstance(tags: Map<string, string>): number | undefined {
	const raw = tags.get('i');
	if (raw === undefined || !/^\d+$/.test(raw)) {
		return undefined;
	}
	return Number.parseInt(raw, 10);
}

/** A signing algorithm we support for ARC (seals + AMS are always sha256). */
export function parseSealAlgorithm(a: string): { readonly keyType: 'rsa' | 'ed25519' } | undefined {
	switch (a) {
		case 'rsa-sha256':
			return { keyType: 'rsa' };
		case 'ed25519-sha256':
			return { keyType: 'ed25519' };
		default:
			return undefined;
	}
}

/**
 * Collect the ARC headers into a contiguous, instance-ordered chain. The caller
 * has already established at least one ARC header is present. THROWS on any
 * malformed shape a chain-bearing message must not have — a missing `i=`, a
 * duplicate header for an instance, a gap, an incomplete set, or more than
 * `MAX_ARC_INSTANCES` instances.
 */
export function buildArcChain(headerFields: readonly HeaderField[]): ArcSet[] {
	const byInstance = new Map<number, PartialArcSet>();

	for (const field of headerFields) {
		const kind = arcHeaderKind(field.name);
		if (kind === null) {
			continue;
		}
		const instance = parseInstance(parseArcTags(field.raw));
		if (instance === undefined) {
			throw new Error('ARC header with missing or malformed instance');
		}
		let set = byInstance.get(instance);
		if (set === undefined) {
			set = {};
			byInstance.set(instance, set);
		}
		if (set[kind] !== undefined) {
			throw new Error(`duplicate ${kind} for ARC instance ${instance}`);
		}
		set[kind] = field;
	}

	if (byInstance.size === 0) {
		throw new Error('no ARC instances found');
	}
	// Bound the chain length BEFORE any per-set crypto work (instance-bomb defense).
	if (byInstance.size > MAX_ARC_INSTANCES) {
		throw new Error(`ARC chain exceeds ${MAX_ARC_INSTANCES} instances`);
	}

	const chain: ArcSet[] = [];
	for (let instance = 1; instance <= byInstance.size; instance++) {
		const set = byInstance.get(instance);
		if (set === undefined) {
			throw new Error(`ARC chain missing instance ${instance}`);
		}
		if (set.aar === undefined || set.ams === undefined || set.seal === undefined) {
			throw new Error(`ARC instance ${instance} is missing a required header`);
		}
		chain.push({
			instance,
			aar: set.aar,
			ams: set.ams,
			seal: set.seal,
			sealTags: parseArcTags(set.seal.raw),
			amsTags: parseArcTags(set.ams.raw),
		});
	}
	return chain;
}

/**
 * Validate the RFC 8617 chain semantics that must hold before any seal is trusted:
 * `cv=none` at i=1 and `cv=pass` after; ARC-Seal is relaxed/relaxed, carries a
 * supported `a=` and no `h=`; AMS carries a supported `a=` and never signs the
 * ARC-Seal. THROWS on the first violation (matching `mailauth`'s `getARChain`).
 */
export function validateChainStructure(chain: readonly ArcSet[]): void {
	for (let idx = 0; idx < chain.length; idx++) {
		const set = chain[idx];
		if (set === undefined) {
			throw new Error('internal: undefined ARC set');
		}
		const cv = (set.sealTags.get('cv') ?? '').toLowerCase();
		if (idx === 0) {
			if (cv !== 'none') {
				throw new Error(`ARC i=1 cv must be none, got "${cv}"`);
			}
		} else if (cv !== 'pass') {
			throw new Error(`ARC i=${set.instance} cv must be pass, got "${cv}"`);
		}

		const sealC = (set.sealTags.get('c') ?? '').toLowerCase();
		if (sealC !== '' && sealC !== 'relaxed/relaxed') {
			throw new Error(`ARC i=${set.instance} invalid ARC-Seal c=`);
		}
		if (parseSealAlgorithm((set.sealTags.get('a') ?? '').toLowerCase()) === undefined) {
			throw new Error(`ARC i=${set.instance} invalid ARC-Seal a=`);
		}
		// ARC-Seal seals a fixed set of headers, never a signer-chosen list.
		if (set.sealTags.get('h') !== undefined) {
			throw new Error(`ARC i=${set.instance} ARC-Seal must not carry h=`);
		}

		if (parseSealAlgorithm((set.amsTags.get('a') ?? '').toLowerCase()) === undefined) {
			throw new Error(`ARC i=${set.instance} invalid ARC-Message-Signature a=`);
		}
		// An AMS that oversigns the ARC-Seal would bind the seal into the message
		// signature — forbidden by §5.1.1.
		const amsH = (set.amsTags.get('h') ?? '').toLowerCase();
		if (amsH.split(':').some((name) => name.trim() === 'arc-seal')) {
			throw new Error(`ARC i=${set.instance} ARC-Message-Signature must not sign arc-seal`);
		}
	}
}
