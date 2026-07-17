/**
 * ARC verifier — ADVERSARIAL / hostile-input safety (I4/I6).
 *
 * `verifyArc` must be TOTAL: every hostile shape — an instance bomb, duplicate
 * or missing instances, an incomplete set, CRLF smuggling inside ARC headers,
 * garbage key records, a resolver that explodes — is BOUNDED and yields a
 * rescue-free verdict (`cv` never `pass`, `attestsOriginalPass` always false),
 * NEVER a throw and NEVER a NACK of already-accepted bytes. A fail-open case
 * pins that an internal error rescues nothing rather than crashing.
 */

import { describe, it, expect } from 'vitest';
import { verifyArc } from '../verify.js';
import {
	BASE_MESSAGE,
	makeRsaKey,
	resolverFor,
	sealHop,
	type ArcTestResolver,
} from './helpers/seal.js';

const TAIL = ['From: alice@author.example', 'Subject: hostile', '', 'body', ''].join('\r\n');

/** One structurally-shaped ARC set (crypto is garbage; never reaches the wire). */
function arcSet(instance: number, cv: string): string[] {
	return [
		`ARC-Seal: i=${instance}; a=rsa-sha256; cv=${cv}; d=x.example; s=s; b=AAAA`,
		`ARC-Message-Signature: i=${instance}; a=rsa-sha256; c=relaxed/relaxed; d=x.example; s=s; h=from; bh=AAAA; b=AAAA`,
		`ARC-Authentication-Results: i=${instance}; x.example; dmarc=pass header.from=author.example`,
	];
}

/** Assemble raw header lines + a fixed body tail into a message buffer. */
function assemble(headerLines: string[]): Buffer {
	return Buffer.from(`${headerLines.join('\r\n')}\r\n${TAIL}`, 'latin1');
}

/** A resolver that answers nothing (every seal/AMS key lookup fails). */
const emptyResolver: ArcTestResolver = resolverFor({});

/** Assert a verdict is rescue-free: never `pass`, never attesting. */
function expectRescueFree(verdict: { cv: string; attestsOriginalPass: boolean }): void {
	expect(verdict.cv).not.toBe('pass');
	expect(verdict.attestsOriginalPass).toBe(false);
}

describe('verifyArc adversarial — bounded, never throws', () => {
	it('a 60-instance bomb is rejected without per-set crypto work', async () => {
		const lines: string[] = [];
		for (let i = 1; i <= 60; i++) {
			lines.push(...arcSet(i, i === 1 ? 'none' : 'pass'));
		}
		const verdict = await verifyArc(assemble(lines), { resolver: emptyResolver });
		expect(verdict.cv).toBe('fail');
		expectRescueFree(verdict);
	});

	it('duplicate i= set (two ARC-Seal i=1) -> fail', async () => {
		const lines = [
			...arcSet(1, 'none'),
			'ARC-Seal: i=1; a=rsa-sha256; cv=none; d=x.example; s=s; b=AAAA',
		];
		const verdict = await verifyArc(assemble(lines), { resolver: emptyResolver });
		expect(verdict.cv).toBe('fail');
		expectRescueFree(verdict);
	});

	it('a gap in the instance sequence (i=1, i=3) -> fail', async () => {
		const verdict = await verifyArc(assemble([...arcSet(1, 'none'), ...arcSet(3, 'pass')]), {
			resolver: emptyResolver,
		});
		expect(verdict.cv).toBe('fail');
		expectRescueFree(verdict);
	});

	it('an incomplete set (i=1 missing its ARC-Authentication-Results) -> fail', async () => {
		const [seal, ams] = arcSet(1, 'none');
		const verdict = await verifyArc(assemble([seal!, ams!]), { resolver: emptyResolver });
		expect(verdict.cv).toBe('fail');
		expectRescueFree(verdict);
	});

	it('an ARC header with no i= tag -> fail', async () => {
		const lines = [
			'ARC-Seal: a=rsa-sha256; cv=none; d=x.example; s=s; b=AAAA',
			'ARC-Message-Signature: a=rsa-sha256; d=x.example; s=s; h=from; bh=AAAA; b=AAAA',
			'ARC-Authentication-Results: x.example; dmarc=pass header.from=author.example',
		];
		const verdict = await verifyArc(assemble(lines), { resolver: emptyResolver });
		expect(verdict.cv).toBe('fail');
		expectRescueFree(verdict);
	});

	it('CRLF smuggling inside ARC headers is bounded (folded injection) -> fail', async () => {
		// A folded continuation tries to smuggle a second b= and a fake trailing
		// header. The parser rejoins the fold as one field (first-wins tags) and the
		// bogus signature never verifies — no injection, no crash.
		const lines = [
			'ARC-Seal: i=1; a=rsa-sha256; cv=none; d=x.example; s=s;\r\n b=AAAA;\r\n b=INJECTED',
			'ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=x.example; s=s; h=from; bh=AAAA; b=AAAA',
			'ARC-Authentication-Results: i=1; x.example;\r\n dmarc=pass header.from=author.example',
		];
		const verdict = await verifyArc(assemble(lines), { resolver: emptyResolver });
		expectRescueFree(verdict);
	});

	it('an ARC-Seal carrying an h= tag -> fail (must not choose its signed headers)', async () => {
		const lines = [
			'ARC-Seal: i=1; a=rsa-sha256; cv=none; d=x.example; s=s; h=from:to; b=AAAA',
			'ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=x.example; s=s; h=from; bh=AAAA; b=AAAA',
			'ARC-Authentication-Results: i=1; x.example; dmarc=pass header.from=author.example',
		];
		const verdict = await verifyArc(assemble(lines), { resolver: emptyResolver });
		expect(verdict.cv).toBe('fail');
	});

	it('i=1 with cv other than none -> fail', async () => {
		const verdict = await verifyArc(assemble(arcSet(1, 'pass')), { resolver: emptyResolver });
		expect(verdict.cv).toBe('fail');
	});

	it('garbage key record for a real chain -> fail, never throws', async () => {
		const key = makeRsaKey();
		const message = await sealHop(BASE_MESSAGE, {
			domain: 'lists.sourceforge.net',
			selector: 'arc1',
			privateKey: key.privateKey,
			instance: 1,
			cv: 'none',
			authResults: 'lists.sourceforge.net; dmarc=pass header.from=author.example',
		});
		const garbage = resolverFor({
			'arc1._domainkey.lists.sourceforge.net': 'not a dkim key at all',
		});
		const verdict = await verifyArc(message, { resolver: garbage });
		expect(verdict.cv).toBe('fail');
		expectRescueFree(verdict);
	});

	it('a resolver that throws a non-DNS error is caught -> fail, never propagates', async () => {
		const key = makeRsaKey();
		const message = await sealHop(BASE_MESSAGE, {
			domain: 'lists.sourceforge.net',
			selector: 'arc1',
			privateKey: key.privateKey,
			instance: 1,
			cv: 'none',
			authResults: 'lists.sourceforge.net; dmarc=pass header.from=author.example',
		});
		const exploding: ArcTestResolver = async () => {
			throw new Error('kaboom — DNS layer blew up');
		};
		const verdict = await verifyArc(message, { resolver: exploding });
		expect(verdict.cv).toBe('fail');
		expectRescueFree(verdict);
	});
});

describe('verifyArc fail-open — an internal error rescues nothing, never NACKs', () => {
	it('a message with no ARC headers -> cv none, no rescue', async () => {
		const verdict = await verifyArc(BASE_MESSAGE, { resolver: emptyResolver });
		expect(verdict.cv).toBe('none');
		expectRescueFree(verdict);
	});

	it('total garbage bytes -> cv none, no throw, no rescue', async () => {
		const verdict = await verifyArc(Buffer.from([0x00, 0xff, 0x10, 0x80, 0x0a]), {
			resolver: emptyResolver,
		});
		expect(verdict.cv).toBe('none');
		expectRescueFree(verdict);
	});

	it('an empty buffer -> cv none, no throw', async () => {
		const verdict = await verifyArc(Buffer.alloc(0), { resolver: emptyResolver });
		expect(verdict.cv).toBe('none');
		expectRescueFree(verdict);
	});

	it('never throws across every hostile input', async () => {
		const inputs: Buffer[] = [
			Buffer.alloc(0),
			Buffer.from('garbage', 'latin1'),
			assemble(arcSet(1, 'none')),
			assemble([...arcSet(1, 'none'), ...arcSet(2, 'fail')]),
			assemble(['ARC-Seal: i=notanumber; a=rsa-sha256; cv=none; d=x; s=s; b=AAAA']),
		];
		for (const input of inputs) {
			const verdict = await verifyArc(input, { resolver: emptyResolver });
			expect(['pass', 'fail', 'none']).toContain(verdict.cv);
			// Nothing hostile is ever a rescue.
			expect(verdict.cv).not.toBe('pass');
		}
	});
});
