// Rule test for webhook-signature-read-outside-verifier: this read form
// (space get paren) is still a signature-header read. The file is
// not in the rule's allowlist, so the read is reported. Run with
//   semgrep --test --config .semgrep.yml .semgrep/tests/read-forms/space-get-paren.ts

// prettier-ignore
export function spaceGetParen(req, expected) {
	// ruleid: webhook-signature-read-outside-verifier
	const sig = req.headers.get ('x-signature');
	if (!sig) return 401;
	return 200;
}
