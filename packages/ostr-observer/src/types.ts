/**
 * Shapes shared by every observer-side module: the unsigned draft the builders
 * emit, the identity that signs it, and the normalization helpers that decide
 * what a subject is called.
 *
 * A draft deliberately carries no `observer` and no `v`: an accumulator has no
 * business knowing which key will sign its output, and the envelope is filled
 * exactly once, in `sign.ts`, so the observer name in the log and the key that
 * signed it cannot drift apart.
 */
import { isFqdn, isIpAddress, type AttestationKind } from '@owlat/ostr-core';
import type { AttestationWindow, SubjectRef } from '@owlat/ostr-core';

/** An attestation body plus its addressing, before an observer signs it. */
export interface AttestationDraft<TBody = unknown> {
	kind: AttestationKind;
	subject: SubjectRef;
	window?: AttestationWindow;
	body: TBody;
}

/** The observer's registry identity: the domain publishing `_ostr.<domain>`
 *  and the raw base64 ed25519 private key whose public half that record
 *  carries. Nothing in this package ever reads it from the environment. */
export interface ObserverIdentity {
	domain: string;
	/** Raw 32-byte ed25519 private key, base64 (the `@owlat/ostr-core` form). */
	privateKeyBase64: string;
}

/**
 * Lowercased, trailing-dot-stripped domain, or `undefined` when the input is
 * not a usable FQDN. Attestation fields are case-sensitive signed bytes, so a
 * domain is folded here, once, rather than compared raw anywhere downstream.
 */
export function normalizeDomain(domain: string | undefined): string | undefined {
	if (typeof domain !== 'string') return undefined;
	const trimmed = domain.trim().toLowerCase().replace(/\.+$/, '');
	return isFqdn(trimmed) ? trimmed : undefined;
}

/** The IP as given if it is an address literal `@owlat/ostr-core` accepts. */
export function normalizeIp(ip: string | undefined): string | undefined {
	if (typeof ip !== 'string') return undefined;
	const trimmed = ip.trim();
	return isIpAddress(trimmed) ? trimmed : undefined;
}

/**
 * Stable string key for a subject — the map key every per-subject accumulator
 * uses. Domain and IP live in separate namespaces so `{ domain: 'a.example' }`
 * and `{ ip: '…' }` can never collide.
 */
export function subjectKey(subject: SubjectRef): string {
	return `${subject.domain ?? ''}|${subject.ip ?? ''}`;
}

/** True when two subject references name the same party, field for field. */
export function sameSubject(a: SubjectRef, b: SubjectRef): boolean {
	return subjectKey(a) === subjectKey(b);
}

/** True when two windows are the same half-open interval. */
export function sameWindow(a: AttestationWindow, b: AttestationWindow): boolean {
	return a.from === b.from && a.to === b.to;
}
