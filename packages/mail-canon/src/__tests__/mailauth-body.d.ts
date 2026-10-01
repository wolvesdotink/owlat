// mailauth ships no types for its body-hash module; the canonicalization
// vectors use it as the byte-identity oracle.
declare module 'mailauth/lib/dkim/body/index.js' {
	export function dkimBody(canonicalization: string, ...options: unknown[]): unknown;
}
