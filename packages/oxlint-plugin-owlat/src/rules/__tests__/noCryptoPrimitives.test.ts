import rule from '../noCryptoPrimitives.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

const filename = '/repo/apps/api/convex/mail/route.ts';
const options = [
	{
		files: ['apps/**', 'packages/**'],
		ignore: ['**/*.d.ts'],
		allow: [{ files: ['apps/api/convex/lib/crypto.ts'], reason: 'the Convex helpers' }],
	},
];
const hit = (what: string) => ({
	message: new RegExp(`^${what.replace(/[()]/g, '\\$&')} outside`),
});

const OPEN_CODED_HMAC = [
	'async function hmacHex(secret: string, data: string) {',
	'\tconst key = await crypto.subtle.importKey(',
	"\t\t'raw',",
	'\t\tnew TextEncoder().encode(secret),',
	"\t\t{ name: 'HMAC', hash: 'SHA-256' },",
	'\t\tfalse,',
	"\t\t['sign']",
	'\t);',
	"\treturn crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));",
	'}',
].join('\n');

ruleTester.run('owlat/no-crypto-primitives', rule, {
	valid: [
		{
			name: 'the sanctioned module',
			filename: '/repo/apps/api/convex/lib/crypto.ts',
			code: OPEN_CODED_HMAC,
			options,
		},
		{
			name: 'a test file',
			filename: '/repo/apps/api/convex/__tests__/route.test.ts',
			code: OPEN_CODED_HMAC,
			options,
		},
		{
			name: 'a declaration file',
			filename: '/repo/packages/x/src/types.d.ts',
			code: 'declare const timingSafeEqual: () => boolean;',
			options,
		},
		{
			name: 'outside apps/ and packages/',
			filename: '/repo/examples/plugins/x/index.ts',
			code: OPEN_CODED_HMAC,
			options,
		},
		{
			name: 'non-HMAC key imports, signs and generated keys',
			filename,
			options,
			code: [
				"await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt']);",
				"await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);",
				"await crypto.subtle.importKey('spki', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);",
				"await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);",
				"await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);",
				"await crypto.subtle.deriveKey(params, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);",
				'importKey(a, b);',
				'importKey(...args);',
				'other.sign(payload);',
			].join('\n'),
		},
		{
			name: 'prose and strings that name a spelling',
			filename,
			options,
			code: [
				'/** Never call timingSafeEqual( directly. */',
				'// importKey(raw, key, "HMAC") by hand is banned',
				"const note = 'use timingSafeEqual via the helper';",
				"const re = new RegExp('^' + body);",
			].join('\n'),
		},
		{
			name: 'XOR outside an accumulating compare',
			filename,
			options,
			code: [
				'const mixed = a ^ b;',
				'flags |= MASK;',
				'count += step;',
				"re += '^' + escaped;",
				'hash = (hash ^ byte) >>> 0;',
				'total = other | (a ^ b);',
				'acc |= items.map((x) => x ^ 1).length;',
				'obj.acc = obj.acc | (a ^ b);',
			].join('\n'),
		},
	],
	invalid: [
		{
			name: 'an open-coded HMAC import and sign',
			filename,
			options,
			code: OPEN_CODED_HMAC,
			errors: [hit('importKey(HMAC)'), hit('sign(HMAC)')],
		},
		{
			name: 'an HMAC verify, by string and by object, in any case',
			filename,
			options,
			code: [
				"await crypto.subtle.verify('HMAC', key, signature, data);",
				'await crypto.subtle.verify({ hash: "SHA-256", name: `hmac` }, key, s, d);',
			].join('\n'),
			errors: [hit('verify(HMAC)'), hit('verify(HMAC)')],
		},
		{
			name: 'an importKey whose algorithm is not a literal',
			filename,
			options,
			code: [
				"await crypto.subtle.importKey('raw', bytes, algorithm, false, ['sign']);",
				"await crypto.subtle.importKey('raw', bytes, { name: kind, hash: 'SHA-256' }, false, ['sign']);",
				"await crypto.subtle.importKey('raw', bytes, { hash: 'SHA-256' }, false, ['sign']);",
			].join('\n'),
			errors: [
				hit('importKey(variable algorithm)'),
				hit('importKey(variable algorithm)'),
				hit('importKey(variable algorithm)'),
			],
		},
		{
			name: 'an HMAC key generated or derived in place',
			filename,
			options,
			code: [
				"await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);",
				"await subtle.deriveKey(params, base, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);",
			].join('\n'),
			errors: [hit('generateKey(HMAC)'), hit('deriveKey(HMAC)')],
		},
		{
			name: 'timingSafeEqual imported, aliased, destructured or reached through a property',
			filename: '/repo/apps/mta/src/auth/apiKey.ts',
			options,
			code: [
				"import { timingSafeEqual as safeEqual } from 'node:crypto';",
				"const { timingSafeEqual: eq } = require('node:crypto');",
				"const { 'timingSafeEqual': quoted } = crypto;",
				'crypto.timingSafeEqual(a, b);',
				"crypto['timingSafeEqual'](a, b);",
			].join('\n'),
			errors: [
				hit('timingSafeEqual'),
				hit('timingSafeEqual'),
				hit('timingSafeEqual'),
				hit('timingSafeEqual'),
				hit('timingSafeEqual'),
			],
		},
		{
			name: 'one report per spelling of an unaliased import',
			filename: '/repo/packages/x/src/compare.ts',
			options,
			code: "import { timingSafeEqual } from 'node:crypto';",
			errors: [hit('timingSafeEqual')],
		},
		{
			name: 'XOR-accumulate compares, including one split over several lines',
			filename,
			options,
			code: [
				'for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);',
				'for (let i = 0; i < a.length; i++) other = other | (x[i] ^ y[i]);',
				'for (let i = 0; i < a.length; i++) sum += a[i] ^ b[i];',
				'for (let i = 0; i < a.length; i++) total = total + (a[i] ^ b[i]);',
				'for (let i = 0; i < a.length; i++) {',
				'\tresult |=',
				'\t\ta.charCodeAt(i) ^',
				'\t\tb.charCodeAt(i);',
				'}',
				'this.acc |= (a[i] ^ b[i]);',
				'chained = chained | flag | (a ^ b);',
			].join('\n'),
			errors: Array.from({ length: 7 }, () => hit('xor-compare')),
		},
	],
});
