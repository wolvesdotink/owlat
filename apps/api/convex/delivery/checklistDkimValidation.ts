'use node';

import { createPublicKey } from 'node:crypto';
import dns from 'node:dns/promises';

const APPLICABLE_DKIM_SERVICES = new Set(['*', 'email']);
const SECURE_DKIM_HASHES = new Set(['sha256']);
const DKIM_HYPHENATED_WORD = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
const DKIM_TAG_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

function colonSeparatedTagIncludes(value: string, accepted: ReadonlySet<string>): boolean {
	const items = value.split(':').map((item) => item.trim().toLowerCase());
	if (
		items.some((item) => !DKIM_HYPHENATED_WORD.test(item) && !(item === '*' && accepted.has(item)))
	) {
		return false;
	}
	return items.some((item) => accepted.has(item));
}

function decodeCanonicalBase64(value: string): Buffer | null {
	if (/(?:^|[^\r])\n|\r(?!\n)|\r\n(?![ \t])/.test(value)) return null;
	const compact = value.replace(/[ \t]|\r\n/g, '');
	const match = /^([A-Za-z0-9+/]+)(={0,2})$/.exec(compact);
	if (!match) return null;

	const unpadded = match[1]!;
	const suppliedPadding = match[2]!.length;
	const remainder = unpadded.length % 4;
	if (remainder === 1) return null;
	const requiredPadding = (4 - remainder) % 4;
	if (suppliedPadding !== 0 && suppliedPadding !== requiredPadding) return null;

	const canonical = `${unpadded}${'='.repeat(requiredPadding)}`;
	const decoded = Buffer.from(canonical, 'base64');
	return decoded.toString('base64') === canonical ? decoded : null;
}

export function parsedDkimKeyBits(value: string | undefined): number | null {
	if (!value) return null;
	const tagSpecs = value.split(';').map((candidate) => candidate.trim());
	if (tagSpecs[tagSpecs.length - 1] === '') tagSpecs.pop();
	if (tagSpecs.length === 0 || tagSpecs.some((tagSpec) => tagSpec === '')) return null;

	const tags = new Map<string, string>();
	for (const tagSpec of tagSpecs) {
		const separator = tagSpec.indexOf('=');
		if (separator < 1) return null;
		const name = tagSpec.slice(0, separator).trim();
		if (!DKIM_TAG_NAME.test(name)) return null;
		if (name === 'v' && tags.size > 0) return null;
		if (tags.has(name)) return null;
		tags.set(name, tagSpec.slice(separator + 1).trim());
	}
	if (tags.has('v') && tags.get('v') !== 'DKIM1') return null;
	if ((tags.get('k') ?? 'rsa').toLowerCase() !== 'rsa') return null;
	const services = tags.get('s');
	if (services !== undefined && !colonSeparatedTagIncludes(services, APPLICABLE_DKIM_SERVICES)) {
		return null;
	}
	const hashes = tags.get('h');
	if (hashes !== undefined && !colonSeparatedTagIncludes(hashes, SECURE_DKIM_HASHES)) {
		return null;
	}
	const key = tags.get('p');
	if (!key) return null;
	const decodedKey = decodeCanonicalBase64(key);
	if (!decodedKey) return null;
	try {
		const publicKey = createPublicKey({
			key: decodedKey,
			format: 'der',
			type: 'spki',
		});
		return publicKey.asymmetricKeyType === 'rsa'
			? (publicKey.asymmetricKeyDetails?.modulusLength ?? null)
			: null;
	} catch {
		return null;
	}
}

export type DkimKeyResolution =
	| { outcome: 'resolved'; bits: number | null }
	| { outcome: 'unresolved'; bits: null };

export async function resolveDkimKey(hostname: string): Promise<DkimKeyResolution> {
	const visited = new Set<string>();
	let current = hostname.toLowerCase().replace(/\.$/, '');
	for (let hop = 0; hop < 4 && !visited.has(current); hop += 1) {
		visited.add(current);
		try {
			const candidates = (await dns.resolveTxt(current))
				.map((chunks) => chunks.join(''))
				.filter((value) => /(?:^|;)\s*(?:v=DKIM1\s*;|k=rsa\s*;|p=)/i.test(value));
			if (candidates.length === 1) {
				return { outcome: 'resolved', bits: parsedDkimKeyBits(candidates[0]) };
			}
			// More than one key-bearing TXT record at a selector is ambiguous.
			// Never choose whichever answer the resolver happened to return first.
			if (candidates.length > 1) return { outcome: 'resolved', bits: null };
			// A successful terminal TXT lookup with no DKIM key is definitive
			// invalid evidence. Only resolver failure can indicate a CNAME hop.
			return { outcome: 'resolved', bits: null };
		} catch {
			// A provider-managed selector is commonly a CNAME, so continue.
		}
		try {
			const cnames = await dns.resolveCname(current);
			if (cnames.length !== 1) {
				return cnames.length === 0
					? { outcome: 'unresolved', bits: null }
					: { outcome: 'resolved', bits: null };
			}
			current = cnames[0]!.toLowerCase().replace(/\.$/, '');
		} catch {
			return { outcome: 'unresolved', bits: null };
		}
	}
	return { outcome: 'unresolved', bits: null };
}
