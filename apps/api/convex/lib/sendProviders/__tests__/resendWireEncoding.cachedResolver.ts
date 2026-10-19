/**
 * A module that caches a DNS method while it initializes, the way a dependency
 * might. `resendWireEncoding.test.ts` imports it after its egress guard is in
 * place and checks that the cached reference is the guarded one. The resolver
 * points at a loopback port, so even an unguarded call never leaves the host.
 */

import dns from 'node:dns';

const resolver = new dns.promises.Resolver();
resolver.setServers(['127.0.0.1:9']);

export const cachedResolve4 = dns.promises.Resolver.prototype.resolve4.bind(resolver);
