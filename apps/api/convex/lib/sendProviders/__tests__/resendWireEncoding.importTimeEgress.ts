/**
 * A module that reaches for the network while it initializes, the way a
 * dependency might: it makes a DNS lookup and swallows the error, and it caches
 * a DNS method. `resendWireEncoding.test.ts` imports it after its egress guard
 * is in place and checks that the swallowed attempt is still reported and that
 * the cached reference is the guarded one. The hosts are reserved and the
 * resolver points at a loopback port, so even unguarded calls reach no one.
 */

import dns from 'node:dns';

try {
	dns.lookup('api.owlat.example', () => {});
} catch {
	// Swallowed, as a dependency might: only the guard's record can report it.
}

const resolver = new dns.promises.Resolver();
resolver.setServers(['127.0.0.1:9']);

export const cachedResolve4 = dns.promises.Resolver.prototype.resolve4.bind(resolver);
