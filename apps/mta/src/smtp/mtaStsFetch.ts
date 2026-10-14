/**
 * HTTPS GET for an MTA-STS policy file (RFC 8461 §3.3).
 *
 * The policy host is chosen by whoever owns the recipient domain, so every
 * property of this request is pinned rather than left to fetch defaults:
 *
 * - the URL is exactly `https://mta-sts.<domain>/.well-known/mta-sts.txt`, for
 *   a recipient domain that is a well-formed DNS name;
 * - the socket's own DNS lookup rejects any non-public address (loopback,
 *   RFC 1918, link-local, CGNAT, ULA, multicast). The check runs on the
 *   addresses the connection actually uses, so a name that rebinds between two
 *   resolutions cannot slip through;
 * - a 3xx is refused, never followed ("HTTP 3xx redirects MUST NOT be
 *   followed"), so the GET can't be bounced to plaintext HTTP or another host;
 * - only a 200 with media type text/plain is a policy (§3.3); a 204 or 206 is
 *   not an empty policy;
 * - the certificate must name the host in a DNS subjectAltName (§3.3 follows
 *   RFC 6125): no CN fallback, a wildcard only as a whole leftmost label,
 *   and never one sitting directly on a public suffix;
 * - the body is capped at {@link STS_MAX_POLICY_BYTES} decoded bytes, declared
 *   (Content-Length) and actual, and the response is destroyed past the cap;
 * - the whole exchange, body included, is bounded by {@link STS_FETCH_TIMEOUT}.
 *
 * There is no private-address exception: a recipient domain whose policy host
 * only resolves internally gets no MTA-STS policy (opportunistic TLS and DANE
 * still apply). Every refusal throws, which the caller treats as a fetch
 * failure, so a still-valid cached enforce policy is kept.
 */

import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import { request } from 'node:https';
import type { LookupFunction } from 'node:net';
import { X509Certificate } from 'node:crypto';
import type { PeerCertificate } from 'node:tls';
import { domainToASCII } from 'node:url';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { trySplitZone } from '@owlat/shared/dnsZone';
import { isDisallowedIpAddress } from '@owlat/shared/ipBlocklist';

export const STS_FETCH_TIMEOUT = 10_000; // 10s for connect, headers and body
// A real policy file is a handful of short lines; 64 KiB leaves ample room for
// long MX lists while bounding what an attacker-run policy host can make us buffer.
export const STS_MAX_POLICY_BYTES = 64 * 1024;

const STS_POLICY_PATH = '/.well-known/mta-sts.txt';
const USER_AGENT = 'owlat-mta/0.1 (MTA-STS policy fetch)';
// LDH labels (RFC 1123), so IP literals, ports, paths, userinfo and empty
// labels can't reach the URL. The TLD must not be all digits.
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const MAX_HOSTNAME_LENGTH = 253;
const URL_SYNTAX = /[\s/\\?#@:%[\]]/;

/** A `dns.lookup` callback-style resolver returning every address. */
export type StsResolver = (
	hostname: string,
	options: LookupAllOptions,
	callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

/** Seams for tests: point the GET at a loopback fixture. Production passes nothing. */
export interface StsFetchTransport {
	resolve?: StsResolver;
	isAllowedAddress?: (ip: string) => boolean;
	port?: number;
	ca?: string;
	timeoutMs?: number;
}

/**
 * The policy host for a recipient domain, or `null` when the domain is not a
 * well-formed DNS name. Unicode domains are converted to their A-label form.
 */
export function stsPolicyHost(recipientDomain: string): string | null {
	const name = recipientDomain.trim().replace(/\.$/, '').toLowerCase();
	// domainToASCII parses like a URL host and drops what follows a `/`, `?` or
	// `#`, so URL syntax has to be refused before conversion.
	if (URL_SYNTAX.test(name)) return null;
	const ascii = domainToASCII(name);
	if (!ascii) return null;
	const host = `mta-sts.${ascii}`;
	if (host.length > MAX_HOSTNAME_LENGTH) return null;
	if (!isLdhName(ascii) || !ascii.includes('.')) return null;
	if (/^\d+$/.test(ascii.slice(ascii.lastIndexOf('.') + 1))) return null;
	return host;
}

/** True for a lowercase dotted name of RFC 1123 LDH labels, 253 characters at most. */
export function isLdhName(name: string): boolean {
	return (
		name.length <= MAX_HOSTNAME_LENGTH && name.split('.').every((label) => DNS_LABEL.test(label))
	);
}

/**
 * A `lookup` for the request socket that fails the connection when any
 * resolved address is not allowed. Answers in both the `all: true` shape
 * (Happy Eyeballs) and the single-address shape.
 */
function guardedLookup(
	resolve: StsResolver,
	isAllowedAddress: (ip: string) => boolean
): LookupFunction {
	return (hostname, options, callback) => {
		resolve(hostname, { ...options, all: true }, (err, addresses) => {
			if (err) return callback(err, []);
			const list = Array.isArray(addresses) ? addresses : [];
			const blocked = list.find((record) => !isAllowedAddress(record.address));
			if (list.length === 0 || blocked) {
				const reason = blocked
					? `resolves to non-public address ${blocked.address}`
					: 'resolves to no address';
				return callback(new Error(`MTA-STS policy host ${hostname} ${reason}`), []);
			}
			if (options.all) return callback(null, list);
			callback(null, list[0]!.address, list[0]!.family);
		});
	};
}

/**
 * Name check for the policy host certificate, in place of Node's
 * checkServerIdentity, which falls back to the subject CN and accepts partial
 * wildcards such as `mta-*.example.com`. Only a DNS subjectAltName counts, a
 * wildcard must be the whole leftmost label, and a wildcard directly on a
 * public suffix (`*.co.uk`) is refused. Chain and expiry are still verified
 * by TLS itself.
 */
function checkPolicyHostIdentity(hostname: string, cert: PeerCertificate): Error | undefined {
	const x509 = new X509Certificate(cert.raw);
	// An exact SAN wins outright: checkHost returns the first SAN that
	// matches, so a refused wildcard listed earlier must not hide it.
	if (x509.checkHost(hostname, { subject: 'never', wildcards: false })) return undefined;
	const matched = x509.checkHost(hostname, { subject: 'never', partialWildcards: false });
	if (!matched) {
		return new Error(
			`MTA-STS policy host ${hostname} is not named in a certificate DNS subjectAltName`
		);
	}
	// Only one whole-label wildcard can match a given host, so this is the
	// only candidate.
	if (matched.startsWith('*.') && trySplitZone(matched.slice(2)) === null) {
		return new Error(`MTA-STS policy host certificate wildcard ${matched} covers a public suffix`);
	}
	return undefined;
}

/** Undo a Content-Encoding the server applied even though we asked for identity. */
function decodedBody(response: IncomingMessage): Readable {
	const encoding = (response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
	switch (encoding) {
		case 'identity':
		case '':
			return response;
		case 'gzip':
		case 'x-gzip':
			return response.pipe(createGunzip());
		case 'deflate':
			return response.pipe(createInflate());
		case 'br':
			return response.pipe(createBrotliDecompress());
		default:
			throw new Error(`MTA-STS policy uses unsupported content-encoding: ${encoding}`);
	}
}

/**
 * Read the response under the byte cap. The cap counts decoded bytes, so a
 * small compressed body can't expand past it.
 */
function readCapped(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		let body: Readable;
		try {
			body = decodedBody(response);
		} catch (err) {
			response.destroy();
			return reject(err);
		}
		const chunks: Buffer[] = [];
		let total = 0;
		// Reject before destroying: destroy() emits 'aborted' synchronously.
		const fail = (err: Error) => {
			reject(err);
			response.destroy();
			if (body !== response) body.destroy();
		};
		body.on('data', (chunk: Buffer) => {
			total += chunk.byteLength;
			if (total > maxBytes) return fail(new Error(`MTA-STS policy exceeds ${maxBytes} bytes`));
			chunks.push(chunk);
		});
		body.on('end', () => resolve(Buffer.concat(chunks)));
		body.on('error', fail);
		response.on('error', fail);
		response.on('aborted', () => fail(new Error('MTA-STS policy response aborted')));
	});
}

/**
 * GET the policy file for `recipientDomain` and return its text. Throws on a
 * malformed domain, a non-public policy host, a redirect, any status but 200,
 * a media type other than text/plain, a body over the cap, an unsupported
 * encoding, a TLS failure or the timeout.
 */
export async function fetchStsPolicyText(
	recipientDomain: string,
	transport: StsFetchTransport = {}
): Promise<string> {
	const host = stsPolicyHost(recipientDomain);
	if (!host) throw new Error(`MTA-STS: not a valid recipient domain: ${recipientDomain}`);
	const url = new URL(`https://${host}${STS_POLICY_PATH}`);
	if (url.hostname !== host || url.pathname !== STS_POLICY_PATH) {
		throw new Error(`MTA-STS: policy URL does not match host ${host}`);
	}

	const timeoutMs = transport.timeoutMs ?? STS_FETCH_TIMEOUT;
	const signal = AbortSignal.timeout(timeoutMs);
	const lookup = guardedLookup(
		transport.resolve ?? (dnsLookup as unknown as StsResolver),
		transport.isAllowedAddress ?? ((ip) => !isDisallowedIpAddress(ip))
	);

	const response = await new Promise<IncomingMessage>((resolve, reject) => {
		const req = request(
			{
				host,
				servername: host,
				port: transport.port ?? 443,
				path: STS_POLICY_PATH,
				method: 'GET',
				headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' },
				lookup,
				checkServerIdentity: checkPolicyHostIdentity,
				signal,
				agent: false,
				...(transport.ca ? { ca: transport.ca } : {}),
			},
			resolve
		);
		req.on('error', reject);
		req.end();
	});

	// The request signal only covers the request; bound the body read with it too.
	let onAbort: (() => void) | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		onAbort = () => {
			reject(new Error(`MTA-STS policy fetch timed out after ${timeoutMs}ms`));
			response.destroy();
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener('abort', onAbort, { once: true });
	});
	timedOut.catch(() => undefined);

	try {
		const status = response.statusCode ?? 0;
		if (status >= 300 && status < 400) {
			throw new Error(`MTA-STS policy fetch refused redirect: ${status}`);
		}
		if (status !== 200) {
			throw new Error(
				`MTA-STS policy fetch failed: ${status} ${response.statusMessage ?? ''}`.trim()
			);
		}

		const mediaType = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
		if (mediaType !== 'text/plain') {
			throw new Error(`MTA-STS policy media type is ${mediaType || 'missing'}, not text/plain`);
		}

		const declaredLength = Number(response.headers['content-length']);
		if (Number.isFinite(declaredLength) && declaredLength > STS_MAX_POLICY_BYTES) {
			throw new Error(`MTA-STS policy too large: ${declaredLength} bytes`);
		}

		const bytes = await Promise.race([readCapped(response, STS_MAX_POLICY_BYTES), timedOut]);
		return new TextDecoder().decode(bytes);
	} finally {
		signal.removeEventListener('abort', onAbort!);
		// A no-op after a complete read; drops the socket on every refusal.
		response.destroy();
	}
}
