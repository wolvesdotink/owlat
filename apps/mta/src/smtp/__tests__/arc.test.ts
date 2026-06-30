import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Guard test: the ARC (Authenticated Received Chain, RFC 8617) signer module
 * has been REMOVED.
 *
 * The former `src/smtp/arc.ts` had zero production callers, its docblock
 * falsely claimed ARC was Owlat's forwarding strategy, and the signer itself
 * was non-conformant (the ARC-Message-Signature signed a template instead of
 * the `h=` headers, the ARC-Seal omitted prior ARC sets, `cv=` was hardcoded,
 * and there was no chain verification). The real forwarding path
 * (`apps/api/convex/mail/deliveryHooks.ts`) re-originates the message under the
 * mailbox's own domain with a Reply-To pointing at the original sender — a
 * legitimate non-ARC remail (RFC 7960), not an ARC chain.
 *
 * If ARC is ever revived it must be a conformant, verified, wired-in
 * implementation — not the dead skeleton this guard replaced. This test fails
 * if the old module reappears, preventing the misleading code from creeping
 * back.
 */
describe('arc module', () => {
	it('is removed (no live ARC signer ships in the MTA)', () => {
		const arcPath = resolve(__dirname, '../arc.ts');
		expect(existsSync(arcPath)).toBe(false);
	});
});
