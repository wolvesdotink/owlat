'use node';

import { createPublicKey } from 'node:crypto';
import dns from 'node:dns/promises';

export function parsedDkimKeyBits(value: string | undefined): number | null {
	if (!value) return null;
	const tags = new Map<string, string>();
	for (const part of value
		.split(';')
		.map((candidate) => candidate.trim())
		.filter(Boolean)) {
		const separator = part.indexOf('=');
		if (separator < 1) return null;
		const name = part.slice(0, separator).trim().toLowerCase();
		if (tags.has(name)) return null;
		tags.set(name, part.slice(separator + 1).trim());
	}
	if (tags.has('v') && tags.get('v')?.toUpperCase() !== 'DKIM1') return null;
	if ((tags.get('k') ?? 'rsa').toLowerCase() !== 'rsa') return null;
	const key = tags.get('p')?.replace(/\s+/g, '');
	if (!key) return null;
	try {
		const publicKey = createPublicKey({
			key: Buffer.from(key, 'base64'),
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
				.slice(0, 8)
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
