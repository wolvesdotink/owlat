// Rule test for webhook-signature-presence-only: the file gate must admit
// this read form (bracket comment). One form per file, so no other read
// can let the file through. Run with
//   semgrep --test --config .semgrep.yml .semgrep/tests/gate/bracket-comment.ts

// prettier-ignore
export function bracketComment(req, expected) {
	// ruleid: webhook-signature-presence-only
	const sig = req.headers[/* header */ 'x-signature'];
	if (!sig) return 401;
	return 200;
}
