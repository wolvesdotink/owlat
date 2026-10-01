/**
 * Dependency advisory floors for transitive packages the audit gate does not
 * block on.
 *
 * `check-security-audit.ts` fails only on high/critical findings, so a
 * low/moderate advisory can come back with any lockfile refresh and nothing
 * notices. The two packages below are pinned by root overrides instead, and
 * these tests load the exact copy each consumer resolves:
 *
 * - `ip-address` as reached from mail-sync → imapflow → socks. socks only
 *   parses and encodes literal addresses with it (no classifiers, no subnet
 *   checks), and imapflow loads socks only when a `proxy` option is set, which
 *   mail-sync never does. The fixed classifier, subnet and parse-error
 *   behaviour is pinned here together with the encoding socks relies on, so an
 *   upgrade that breaks IPv4/IPv6 proxy connects fails here first.
 * - `dompurify` as reached from apps/web → posthog-js. PostHog only sanitizes
 *   product-tour HTML strings with it (no IN_PLACE, no hooks). The repository
 *   has no DOM that DOMPurify runs correctly under (happy-dom's node getters
 *   defeat it), so the floor is asserted on the resolved version.
 */

import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type * as IpAddress from 'ip-address';
import type * as Socks from 'socks';
import { afterEach, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Each hop resolves from the previous package, the way the real consumer does.
const mailSyncRequire = createRequire(`${REPOSITORY_ROOT}apps/mail-sync/package.json`);
const imapflowRequire = createRequire(mailSyncRequire.resolve('imapflow/package.json'));
const socksRequire = createRequire(imapflowRequire.resolve('socks'));
const { SocksClient } = socksRequire('socks') as typeof Socks;
const { Address4, Address6 } = socksRequire('ip-address') as typeof IpAddress;

const webRequire = createRequire(`${REPOSITORY_ROOT}apps/web/package.json`);
const posthogRequire = createRequire(webRequire.resolve('posthog-js/package.json'));

function atLeast(version: string, floor: string): boolean {
	const have = version.split('.').map(Number);
	const want = floor.split('.').map(Number);
	for (let i = 0; i < want.length; i++) {
		const a = have[i] ?? 0;
		const b = want[i] ?? 0;
		if (a !== b) return a > b;
	}
	return true;
}

describe('ip-address on the mail-sync socks path', () => {
	it('resolves a release with the classifier, subnet and parser fixes', () => {
		const { version } = socksRequire('ip-address/package.json') as { version: string };
		expect(atLeast(version, '10.7.1'), `ip-address ${version}`).toBe(true);
	});

	it('classifies the whole fe80::/10 range as link-local', () => {
		expect(new Address6('fe80:1::1').isLinkLocal()).toBe(true);
		expect(new Address6('febf::1').isLinkLocal()).toBe(true);
		expect(new Address6('fec0::1').isLinkLocal()).toBe(false);
	});

	it('treats the NAT64 local-use prefix as private', () => {
		expect(new Address6('64:ff9b:1::1').isPrivate()).toBe(true);
	});

	it('never places an address inside a subnet of the other family', () => {
		expect(new Address4('192.0.2.1').isInSubnet(new Address6('::/0'))).toBe(false);
		expect(new Address6('::1').isInSubnet(new Address4('0.0.0.0/0'))).toBe(false);
	});

	it('keeps the parse error small for an oversized input', () => {
		const error: unknown = (() => {
			try {
				return new Address6('g'.repeat(200_000));
			} catch (caught) {
				return caught;
			}
		})();
		expect(error).toBeInstanceOf(Error);
		const { message, parseMessage } = error as Error & { parseMessage?: string };
		expect(message.length).toBeLessThan(1_000);
		expect((parseMessage ?? '').length).toBeLessThan(1_000);
	});
});

/**
 * A one-shot SOCKS5 proxy: accepts no-auth, records the CONNECT request and
 * answers with an IPv6 bound address, which socks decodes through ip-address.
 */
function fakeSocks5(boundAddress: number[]): Promise<{ server: Server; request: Promise<Buffer> }> {
	let resolveRequest: (request: Buffer) => void;
	const request = new Promise<Buffer>((resolve) => {
		resolveRequest = resolve;
	});
	const server = createServer((socket: Socket) => {
		let buffered = Buffer.alloc(0);
		let greeted = false;
		socket.on('data', (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			if (!greeted) {
				if (buffered.length < 2 || buffered.length < 2 + buffered[1]!) return;
				buffered = buffered.subarray(2 + buffered[1]!);
				greeted = true;
				socket.write(Buffer.from([0x05, 0x00]));
			}
			if (buffered.length < 4) return;
			const addressLength = buffered[3] === 0x01 ? 4 : buffered[3] === 0x04 ? 16 : -1;
			if (addressLength < 0 || buffered.length < 4 + addressLength + 2) return;
			resolveRequest(Buffer.from(buffered.subarray(0, 4 + addressLength + 2)));
			socket.write(Buffer.from([0x05, 0x00, 0x00, 0x04, ...boundAddress, 0x1f, 0x90]));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve({ server, request }));
	});
}

describe('socks proxy connects keep their address encoding', () => {
	const BOUND = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01];
	let open: { server: Server; socket?: Socket } | null = null;

	afterEach(async () => {
		open?.socket?.destroy();
		await new Promise<void>((resolve) => (open ? open.server.close(() => resolve()) : resolve()));
		open = null;
	});

	it.each([
		['IPv4', '192.0.2.10', [0x01, 192, 0, 2, 10]],
		['IPv6', '2001:db8::10', [0x04, 0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10]],
	])(
		'encodes an %s destination and decodes the IPv6 bound address',
		async (_family, host, encoded) => {
			const { server, request } = await fakeSocks5(BOUND);
			open = { server };
			const { port } = server.address() as AddressInfo;

			const established = await SocksClient.createConnection({
				command: 'connect',
				proxy: { host: '127.0.0.1', port, type: 5 },
				destination: { host, port: 993 },
				timeout: 5_000,
			});
			open.socket = established.socket;

			expect([...(await request)]).toEqual([0x05, 0x01, 0x00, ...encoded, 0x03, 0xe1]);
			expect(established.remoteHost?.host).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
			expect(established.remoteHost?.port).toBe(8080);
		}
	);
});

describe('dompurify on the web analytics path', () => {
	it('resolves the release that neutralizes hook-detached IN_PLACE subtrees', () => {
		const { version } = posthogRequire('dompurify') as { version: string };
		expect(atLeast(version, '3.4.16'), `dompurify ${version}`).toBe(true);
	});
});
