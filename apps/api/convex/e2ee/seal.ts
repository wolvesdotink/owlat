'use node';

/**
 * Outbound sealing — turn a built RFC 5322 message into a signed + encrypted
 * PGP/MIME message with PROTECTED HEADERS (Sealed Mail plan 2026-07-11, locked
 * decisions D1 + D4).
 *
 * D1: OpenPGP (RFC 9580 profile) via `openpgp.js` — sign with the sender's
 * address key, encrypt to every recipient's pinned key.
 * D4: protected headers ON. The ENTIRE original message (its real `Subject` and
 * all other headers included) is what gets encrypted, so the real subject travels
 * INSIDE the ciphertext; the OUTER message carries the literal placeholder
 * `Subject: ...` (three dots) and only the routing headers a relay actually needs
 * (Message-ID, Date, From, To, Cc, In-Reply-To, References). The encrypted inner
 * message's root Content-Type is marked `protected-headers="v1"` so a compliant
 * reader knows to prefer the headers it finds inside.
 *
 * Pure of `ctx`/db/network: bytes in, bytes out. `'use node'` only because
 * `openpgp` (and the `node:crypto` boundary generator) run in the action runtime.
 * The caller (`mail/outbound.ts`) stores `mime` as the raw `.eml`, ships those
 * exact bytes through the MTA, and records `encryptionInfo` on the row.
 */

import { randomBytes } from 'node:crypto';
import * as openpgp from 'openpgp';

/** The literal outer subject for a sealed message (locked decision D4). */
export const OUTER_SUBJECT_PLACEHOLDER = '...';

export interface SealMimeOptions {
	/** Armored PUBLIC keys of every recipient (D2 — all-or-nothing; verified upstream). */
	recipientPublicKeysArmored: string[];
	/** Armored PRIVATE key of the sender address (already opened from the vault). */
	signingKeyArmored: string;
	/**
	 * Whether to annotate the inner root Content-Type with the
	 * `protected-headers="v1"` marker (default true; production always passes true).
	 * The full original message — real Subject included — is encrypted and the
	 * outer Subject is the `...` placeholder EITHER WAY; `false` only omits the
	 * compliant-reader hint. Exercised with `false` in `seal.test.ts`.
	 */
	protectSubject?: boolean;
}

export interface SealedMime {
	/** The full PGP/MIME message — the bytes stored as the raw `.eml`. */
	mime: string;
	/** The outer (placeholder) subject actually written. */
	outerSubject: string;
	/** The armored `-----BEGIN PGP MESSAGE-----` block (the encrypted body). */
	armoredCiphertext: string;
	/** Honest record of what was cryptographically done. */
	encryptionInfo: {
		algorithm: 'pgp-mime';
		recipientFingerprints: string[];
		signingFingerprint: string;
	};
}

/** Header field-names copied verbatim onto the OUTER message (routing only). */
const OUTER_KEEP_HEADERS = new Set([
	'message-id',
	'date',
	'from',
	'to',
	'cc',
	'in-reply-to',
	'references',
]);

interface ParsedHeader {
	name: string;
	line: string;
}

/** Split a raw message into its header block and body at the first blank line (CRLF). */
function splitMessage(raw: string): { headerBlock: string; body: string } {
	const normalized = raw.replace(/\r?\n/g, '\r\n');
	const idx = normalized.indexOf('\r\n\r\n');
	if (idx < 0) return { headerBlock: normalized, body: '' };
	return { headerBlock: normalized.slice(0, idx), body: normalized.slice(idx + 4) };
}

/** Parse a header block into logical headers, joining folded continuation lines. */
function parseHeaders(headerBlock: string): ParsedHeader[] {
	const headers: ParsedHeader[] = [];
	for (const rawLine of headerBlock.split('\r\n')) {
		const isFold = /^[ \t]/.test(rawLine);
		const last = headers[headers.length - 1];
		if (isFold && last) {
			last.line += `\r\n${rawLine}`;
			continue;
		}
		const colon = rawLine.indexOf(':');
		const name = (colon >= 0 ? rawLine.slice(0, colon) : rawLine).trim().toLowerCase();
		headers.push({ name, line: rawLine });
	}
	return headers;
}

/** A crypto-random MIME boundary that a hostile body cannot collide with. */
function sealedBoundary(): string {
	return `=_owlat_sealed_${randomBytes(12).toString('hex')}`;
}

/**
 * Seal a built RFC 5322 message into signed+encrypted PGP/MIME with protected
 * headers. The whole `rawRfc822` (real subject + body + attachments) is the
 * encrypted payload; the outer message exposes only routing headers and a
 * placeholder subject.
 */
export async function sealMime(rawRfc822: string, opts: SealMimeOptions): Promise<SealedMime> {
	if (opts.recipientPublicKeysArmored.length === 0) {
		throw new Error('sealMime: at least one recipient key is required');
	}
	const protect = opts.protectSubject !== false;

	const { headerBlock, body } = splitMessage(rawRfc822);
	const parsed = parseHeaders(headerBlock);

	// Inner cleartext = the ORIGINAL message, with the root Content-Type marked
	// `protected-headers="v1"` so a reader prefers the (real) headers inside. We
	// append the parameter to the END of the FULL LOGICAL Content-Type header
	// (rebuilding from `parsed`, which already unfolded continuation lines) rather
	// than to the first physical line — a folded `Content-Type:\r\n boundary="x"`
	// would otherwise unfold to a run-together `...;; protected-headers=... boundary`.
	const innerHeaderBlock = protect
		? parsed
				.map((h) =>
					h.name === 'content-type' && !/protected-headers/i.test(h.line)
						? `${h.line}; protected-headers="v1"`
						: h.line
				)
				.join('\r\n')
		: headerBlock;
	const innerMessage = `${innerHeaderBlock}\r\n\r\n${body}`;

	// Sign with the sender key, encrypt to every recipient key. Binary so the
	// exact MIME bytes round-trip without text-mode CRLF munging.
	const message = await openpgp.createMessage({ binary: new TextEncoder().encode(innerMessage) });
	const encryptionKeys = await Promise.all(
		opts.recipientPublicKeysArmored.map((armoredKey) => openpgp.readKey({ armoredKey }))
	);
	const signingKey = await openpgp.readPrivateKey({ armoredKey: opts.signingKeyArmored });
	const encrypted = await openpgp.encrypt({
		message,
		encryptionKeys,
		signingKeys: signingKey,
		format: 'armored',
	});
	const armoredCiphertext = (encrypted as string).replace(/\r?\n/g, '\r\n');

	const recipientFingerprints = encryptionKeys.map((k) => k.getFingerprint().toUpperCase());
	const signingFingerprint = signingKey.getFingerprint().toUpperCase();

	// Build the OUTER routing headers: keep-set verbatim, real subject replaced.
	const outerHeaderLines: string[] = [];
	let wroteSubject = false;
	for (const h of parsed) {
		if (h.name === 'subject') {
			outerHeaderLines.push(`Subject: ${OUTER_SUBJECT_PLACEHOLDER}`);
			wroteSubject = true;
			continue;
		}
		if (OUTER_KEEP_HEADERS.has(h.name)) outerHeaderLines.push(h.line);
	}
	if (!wroteSubject) outerHeaderLines.push(`Subject: ${OUTER_SUBJECT_PLACEHOLDER}`);

	const boundary = sealedBoundary();
	outerHeaderLines.push('MIME-Version: 1.0');
	outerHeaderLines.push(
		`Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`
	);

	const versionPart =
		`--${boundary}\r\n` +
		'Content-Type: application/pgp-encrypted\r\n' +
		'Content-Description: PGP/MIME version identification\r\n\r\n' +
		'Version: 1\r\n';
	const dataPart =
		`--${boundary}\r\n` +
		'Content-Type: application/octet-stream; name="encrypted.asc"\r\n' +
		'Content-Description: OpenPGP encrypted message\r\n' +
		'Content-Disposition: inline; filename="encrypted.asc"\r\n\r\n' +
		`${armoredCiphertext}\r\n`;
	const mime = `${outerHeaderLines.join('\r\n')}\r\n\r\n${versionPart}${dataPart}--${boundary}--\r\n`;

	return {
		mime,
		outerSubject: OUTER_SUBJECT_PLACEHOLDER,
		armoredCiphertext,
		encryptionInfo: { algorithm: 'pgp-mime', recipientFingerprints, signingFingerprint },
	};
}
