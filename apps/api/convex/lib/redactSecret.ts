/**
 * Strip a credential out of text that is about to leave the module holding it.
 *
 * Provider adapters hold an API key while they build error messages from
 * upstream-controlled text: a structured error `message`, a JSON parse error
 * quoting a response body, a gateway that echoes the request. Any of those can
 * carry the key straight back, so every message that may reach
 * `emailSends.errorMessage`, a log line or an operator's screen goes through
 * this one function.
 *
 * Runtime-neutral (no Node APIs) so both V8 and `'use node'` modules can use it.
 * An empty or absent secret is a no-op: `split('')` would otherwise interleave
 * the marker between every character.
 */
export function redactSecret(text: string, secret: string | undefined): string {
	return secret ? text.split(secret).join('[redacted]') : text;
}
