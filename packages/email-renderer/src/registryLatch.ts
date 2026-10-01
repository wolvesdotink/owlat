/**
 * Freeze-on-first-read latch shared by every email block registry.
 *
 * The renderer's two block registries and the builder's two editor registries
 * are one-way latches the host freezes after composing hosted email blocks. A
 * host that loads the email packages lazily cannot compose at boot: the
 * built-in blocks only register when the packages are imported. It arms this
 * latch at boot instead (`armEmailBlockRegistryFreeze`). From then on, the
 * first read of any block registry freezes every block registry that is loaded
 * at that moment, and a registry loaded later freezes itself on its own first
 * read. A registry is therefore never read while still open to mutation.
 *
 * `composeHostedEmailBlocks` claims the latch (disarms it) before it reads the
 * registries, so a host that does have contributions can still compose them
 * explicitly, as long as it does so before the first read.
 *
 * This module is a leaf on purpose: it is the only piece the host imports at
 * boot (via the `@owlat/email-renderer/registry-latch` subpath), so it must not
 * pull the renderer, its block modules or sanitize-html into the entry bundle.
 * Unarmed (the default, e.g. the API and the package tests), it does nothing.
 */

let armed = false;
const freezers = new Set<() => void>();

/** Arm the latch: the next block-registry read freezes the block registries. Idempotent. */
export function armEmailBlockRegistryFreeze(): void {
	armed = true;
}

/**
 * Disarm the latch. Composition calls this before reading the registries so
 * its own reads do not freeze them before the contributions are registered.
 */
export function disarmEmailBlockRegistryFreeze(): void {
	armed = false;
}

/** Is the freeze-on-first-read latch armed? */
export function isEmailBlockRegistryFreezeArmed(): boolean {
	return armed;
}

/**
 * Enrol a registry's finalizer. Each block registry module calls this once at
 * module evaluation; the finalizer must be idempotent.
 */
export function enrolEmailBlockRegistry(finalize: () => void): void {
	freezers.add(finalize);
}

/**
 * Called at the top of every block-registry read. When armed, freezes every
 * enrolled registry. Registries check their own frozen flag first, so after
 * the first read this is never reached on the hot path.
 */
export function latchEmailBlockRegistriesOnRead(): void {
	if (!armed) return;
	for (const finalize of freezers) finalize();
}
