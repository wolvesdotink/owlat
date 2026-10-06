// Rule test for webhook-signature-presence-only: the file gate must admit
// this read form (newline dot get). One form per file, so no other read
// can let the file through. Run with
//   semgrep --test --config .semgrep.yml .semgrep/tests/gate/newline-dot-get.ts

// prettier-ignore
export function newlineDotGet(req, expected) {
	// ruleid: webhook-signature-presence-only
	const sig = req.headers.
	get('x-signature');
	if (!sig) return 401;
	return 200;
}
