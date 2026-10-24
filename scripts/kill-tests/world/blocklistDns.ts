/**
 * The blocklist resolver the MTA's `DNSBL_RESOLVER` points at: answers every
 * query with NXDOMAIN, which is how a DNSBL says "not listed". Without it the
 * MTA asks the public blocklists from a CI runner, gets their refusal answer,
 * reads its sending address as unmeasurable and (correctly) sends nothing.
 */

import { createSocket } from 'node:dgram';

const NXDOMAIN = 3;

/** An NXDOMAIN reply to `query`, echoing its id and question; null for a malformed packet. */
export function nxdomainReply(query: Buffer): Buffer | null {
	if (query.length < 12) return null;
	const reply = Buffer.from(query);
	// QR=1, opcode copied, AA=1, RD copied; RA=1, RCODE=NXDOMAIN.
	reply[2] = 0x80 | (query[2]! & 0x79) | 0x04;
	reply[3] = 0x80 | NXDOMAIN;
	// Keep the question count, drop any answer/authority/additional records the
	// query carried (an EDNS OPT record sits in additional).
	reply.writeUInt16BE(0, 6);
	reply.writeUInt16BE(0, 8);
	reply.writeUInt16BE(0, 10);
	let offset = 12;
	for (let questions = query.readUInt16BE(4); questions > 0; questions--) {
		while (offset < query.length && query[offset] !== 0) offset += query[offset]! + 1;
		offset += 5; // root label + QTYPE + QCLASS
	}
	return offset <= query.length ? reply.subarray(0, offset) : null;
}

export function listenBlocklistDns(port: number): Promise<void> {
	const socket = createSocket('udp4');
	socket.on('message', (message, peer) => {
		const reply = nxdomainReply(message);
		if (reply) socket.send(reply, peer.port, peer.address);
	});
	return new Promise((resolve) => socket.bind(port, '0.0.0.0', resolve));
}
