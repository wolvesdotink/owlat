/**
 * RFC 8463 Appendix A: the published message signed with both an Ed25519 and
 * an RSA key under one `d=`. The message, keys and signatures are copied from
 * the RFC text, so this pins the verifier against an independent signer rather
 * than against our own.
 */

import { describe, it, expect } from 'vitest';
import { verifyDkim } from '../verify.js';
import type { DkimDnsResolver } from '../keyRecord.js';

const ED25519_RECORD = 'v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';
const RSA_RECORD =
	'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDkHlOQoBTzWR' +
	'iGs5V6NpP3idY6Wk08a5qhdR6wy5bdOKb2jLQiY/J16JYi0Qvx/byYzCNb3W91y3FutAC' +
	'DfzwQ/BC/e/8uBsCR+yz1Lxj+PL6lHvqMKrM3rG4hstT5QjvHO9PzoxZyVYLzBfO2EeC3' +
	'Ip3G+2kryOTIKT+l/K4w3QIDAQAB';

const MESSAGE = [
	'DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed;',
	' d=football.example.com; i=@football.example.com;',
	' q=dns/txt; s=brisbane; t=1528637909; h=from : to :',
	' subject : date : message-id : from : subject : date;',
	' bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;',
	' b=/gCrinpcQOoIfuHNQIbq4pgh9kyIK3AQUdt9OdqQehSwhEIug4D11Bus',
	' Fa3bT3FY5OsU7ZbnKELq+eXdp1Q1Dw==',
	'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;',
	' d=football.example.com; i=@football.example.com;',
	' q=dns/txt; s=test; t=1528637909; h=from : to : subject :',
	' date : message-id : from : subject : date;',
	' bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;',
	' b=F45dVWDfMbQDGHJFlXUNB2HKfbCeLRyhDXgFpEL8GwpsRe0IeIixNTe3',
	' DhCVlUrSjV4BwcVcOF6+FF3Zo9Rpo1tFOeS9mPYQTnGdaSGsgeefOsk2Jz',
	' dA+L10TeYt9BgDfQNZtKdN1WO//KgIqXP7OdEFE4LjFYNcUxZQ4FADY+8=',
	'From: Joe SixPack <joe@football.example.com>',
	'To: Suzie Q <suzie@shopping.example.net>',
	'Subject: Is dinner ready?',
	'Date: Fri, 11 Jul 2003 21:00:37 -0700 (PDT)',
	'Message-ID: <20030712040037.46341.5F8J@football.example.com>',
	'',
	'Hi.',
	'',
	'We lost the game.  Are you hungry yet?',
	'',
	'Joe.',
	'',
	'',
].join('\r\n');

const resolver: DkimDnsResolver = async (name) => {
	if (name === 'brisbane._domainkey.football.example.com') return [[ED25519_RECORD]];
	if (name === 'test._domainkey.football.example.com') return [[RSA_RECORD]];
	throw Object.assign(new Error('unexpected name'), { code: 'ENOTFOUND' });
};

describe('verifyDkim: RFC 8463 Appendix A', () => {
	it('passes both published signatures', async () => {
		const result = await verifyDkim(Buffer.from(MESSAGE, 'utf8'), { resolver });
		expect(result.result).toBe('pass');
		expect(result.signatures.map((s) => [s.algorithm, s.selector, s.verdict])).toEqual([
			['ed25519-sha256', 'brisbane', 'pass'],
			['rsa-sha256', 'test', 'pass'],
		]);
	});

	it('fails the Ed25519 signature on a changed body', async () => {
		const tampered = MESSAGE.replace('Are you hungry yet?', 'Are you hungry now?');
		const result = await verifyDkim(Buffer.from(tampered, 'utf8'), { resolver });
		expect(result.signatures[0]).toMatchObject({ algorithm: 'ed25519-sha256' });
		expect(result.signatures[0]!.verdict).not.toBe('pass');
	});
});
