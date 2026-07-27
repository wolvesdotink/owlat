import { describe, expect, it } from 'vitest';
import {
	VERP_KEY_MIN_BYTES,
	VERP_MAC_B64URL_LEN,
	VERP_WINDOW_MS,
	VERP_WINDOW_TOLERANCE,
	buildVerpAddress,
	isUsableVerpKey,
	normalizeReturnPathDomain,
	normalizeVerpKey,
	parseVerpAddress,
} from '../verp';

/**
 * The VERP token core is now shared by the MTA bounce server and the Convex
 * relay adapter, so its grammar is a CROSS-PROCESS contract: a change on one
 * side that the other does not see is a silent bounce-attribution outage. These
 * fixtures pin the grammar, the MAC length, the acceptance window and the
 * unsigned compatibility form directly, rather than reaching them transitively
 * through the MTA wrapper.
 */

const KEY = 'k'.repeat(VERP_KEY_MIN_BYTES);
const DOMAIN = 'bounces.example.com';
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);
const ID = 'send-42@mail.example.com';

describe('token grammar', () => {
	it('is bounce+<base64url(id)>+<mac>@<domain>', () => {
		const address = buildVerpAddress(ID, DOMAIN, KEY, NOW);
		const match = /^bounce\+([A-Za-z0-9_-]+)\+([A-Za-z0-9_-]+)@(.+)$/.exec(address);
		expect(match).not.toBeNull();
		expect(Buffer.from(match?.[1] ?? '', 'base64url').toString('utf-8')).toBe(ID);
		expect(match?.[3]).toBe(DOMAIN);
	});

	it('carries a MAC of exactly VERP_MAC_B64URL_LEN characters', () => {
		const address = buildVerpAddress(ID, DOMAIN, KEY, NOW);
		const mac = /\+([A-Za-z0-9_-]+)@/.exec(address.slice('bounce+'.length))?.[1];
		expect(mac).toHaveLength(VERP_MAC_B64URL_LEN);
	});

	it('never emits a character that would need quoting in an SMTP local part', () => {
		const address = buildVerpAddress('id with spaces/and+plus', DOMAIN, KEY, NOW);
		expect(address.split('@')[0]).toMatch(/^[A-Za-z0-9_+-]+$/);
	});

	it('round-trips an id through the decoder', () => {
		expect(parseVerpAddress(buildVerpAddress(ID, DOMAIN, KEY, NOW), KEY, NOW)).toBe(ID);
	});
});

describe('acceptance window', () => {
	it('verifies across the whole tolerance range', () => {
		const address = buildVerpAddress(ID, DOMAIN, KEY, NOW);
		for (let day = 0; day <= VERP_WINDOW_TOLERANCE; day++) {
			expect(parseVerpAddress(address, KEY, NOW + day * VERP_WINDOW_MS)).toBe(ID);
		}
	});

	it('stops verifying one window past the tolerance', () => {
		const address = buildVerpAddress(ID, DOMAIN, KEY, NOW);
		const beyond = NOW + (VERP_WINDOW_TOLERANCE + 1) * VERP_WINDOW_MS;
		expect(parseVerpAddress(address, KEY, beyond)).toBeNull();
	});
});

describe('forgery resistance', () => {
	it('rejects a token signed with a different key', () => {
		const address = buildVerpAddress(ID, DOMAIN, KEY, NOW);
		expect(parseVerpAddress(address, `${KEY}x`, NOW)).toBeNull();
	});

	it('rejects an UNSIGNED token once a key is configured', () => {
		const unsigned = buildVerpAddress(ID, DOMAIN, undefined, NOW);
		// Exactly one `+`: the id separator, with no MAC after it.
		expect(unsigned.split('+')).toHaveLength(2);
		expect(parseVerpAddress(unsigned, KEY, NOW)).toBeNull();
	});

	it('rejects a tampered id — the MAC covers the encoded id', () => {
		const address = buildVerpAddress(ID, DOMAIN, KEY, NOW);
		const tampered = address.replace('bounce+', `bounce+${Buffer.from('x').toString('base64url')}`);
		expect(parseVerpAddress(tampered, KEY, NOW)).toBeNull();
	});

	it('rejects an address that is not a VERP address at all', () => {
		expect(parseVerpAddress('postmaster@example.com', KEY, NOW)).toBeNull();
		expect(parseVerpAddress('', KEY, NOW)).toBeNull();
	});
});

describe('unsigned compatibility form', () => {
	it('round-trips only when no key is configured on either side', () => {
		const unsigned = buildVerpAddress(ID, DOMAIN, undefined, NOW);
		expect(parseVerpAddress(unsigned, undefined, NOW)).toBe(ID);
	});
});

describe('key and domain hygiene', () => {
	it('accepts a key at the minimum length and rejects anything shorter', () => {
		expect(isUsableVerpKey('k'.repeat(VERP_KEY_MIN_BYTES))).toBe(true);
		expect(isUsableVerpKey('k'.repeat(VERP_KEY_MIN_BYTES - 1))).toBe(false);
		expect(isUsableVerpKey(undefined)).toBe(false);
		expect(isUsableVerpKey('')).toBe(false);
	});

	it('measures the key in BYTES, not characters', () => {
		// 16 astral characters = 64 UTF-8 bytes, and 8 of them = 32 bytes.
		expect(isUsableVerpKey('😀'.repeat(8))).toBe(true);
		expect(isUsableVerpKey('😀'.repeat(7))).toBe(false);
	});

	it('normalises a return-path domain to one canonical form', () => {
		expect(normalizeReturnPathDomain(' bounces.example.com. ')).toBe('bounces.example.com');
		expect(normalizeReturnPathDomain('bounces.example.com')).toBe('bounces.example.com');
		expect(normalizeReturnPathDomain('   ')).toBeUndefined();
		expect(normalizeReturnPathDomain('.')).toBeUndefined();
		expect(normalizeReturnPathDomain(undefined)).toBeUndefined();
	});
});

describe('key normalisation is ONE definition for both signers', () => {
	// The MTA reads BOUNCE_VERP_KEY and Convex reads the projected copy. If one
	// side trimmed the configured value and the other did not, the two sides
	// would sign with DIFFERENT keys and every relay-stamped token would fail
	// verification at the MTA — safely, but for an invisible reason.
	const KEY = 'k'.repeat(VERP_KEY_MIN_BYTES);
	const PADDED = ` ${KEY}\n`;
	const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

	it('trims, and treats blank as unset', () => {
		expect(normalizeVerpKey(PADDED)).toBe(KEY);
		expect(normalizeVerpKey(undefined)).toBeUndefined();
		expect(normalizeVerpKey('')).toBeUndefined();
		expect(normalizeVerpKey('   \n\t ')).toBeUndefined();
	});

	it('a padded copy of the key mints the SAME token', () => {
		expect(buildVerpAddress('mid@example.com', 'bounces.example.com', PADDED, NOW)).toBe(
			buildVerpAddress('mid@example.com', 'bounces.example.com', KEY, NOW)
		);
	});

	it('a token minted with a padded key verifies against the bare key', () => {
		const address = buildVerpAddress('mid@example.com', 'bounces.example.com', PADDED, NOW);
		expect(parseVerpAddress(address, KEY, NOW)).toBe('mid@example.com');
		expect(parseVerpAddress(address, PADDED, NOW)).toBe('mid@example.com');
	});

	it('whitespace can never pad a too-short key over the floor', () => {
		const short = 'x'.repeat(VERP_KEY_MIN_BYTES - 1);
		expect(isUsableVerpKey(short)).toBe(false);
		expect(isUsableVerpKey(` ${short} `)).toBe(false);
		expect(isUsableVerpKey(PADDED)).toBe(true);
	});
});
