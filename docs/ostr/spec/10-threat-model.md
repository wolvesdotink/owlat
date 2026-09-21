# 10. Threat model

[Index](../spec-v0.md) · prev: [09. Privacy floor](09-privacy.md) · next:
[11. Governance](11-governance.md)

Named threats, their primary mitigations, and the residual risk each one leaves.
The residual column is the useful one. A threat model that ends every row with
"mitigated" is marketing.

## 10.1 Threats and mitigations

| Threat                                                                                                                     | Actor                        | Primary mitigations                                                                                                                                                                                             | Residual                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sybil observers inflating a spammer, an evidence ring                                                                      | Spammer                      | Observer standing takes months of corroborated history; diversity collapse for shared infrastructure; per-observer caps; positive evidence weighted by observer standing ([06 §6.4](06-scoring.md))             | Patient, well-funded rings with genuinely distinct infrastructure remain possible; caps bound the payoff, they do not remove it                                           |
| Report-bombing a competitor                                                                                                | Malicious sender or observer | DKIM admissibility ([04 §4.1](04-evidence-and-reporting.md)); rate against attested volume; three-observer rule for `flagged`; challenge sampling; the attacker's own standing is staked                        | An attacker who really receives the victim's mail can report it. Rate and diversity bound the damage                                                                      |
| Whitewashing: burn a domain, register a fresh one                                                                          | Spammer                      | Cold start is deliberately slow without vouches; vouchers stake standing; domain-age and registration posture; IP-level evidence persists across domain rotation ([06 §6.5](06-scoring.md))                     | Domains are cheap. The cost imposed is time and vouching, not prevention                                                                                                  |
| Log equivocation or censorship of evidence                                                                                 | Log operator                 | Cross-submission, at least two independent logs from Phase 2 ([05 §5.5](05-logs.md)); STH gossip; monitor findings; automatic distrust on proof ([05 §5.6](05-logs.md))                                         | Detection needs at least two independent monitors actually running and gossiping. Before Phase 2 there is one log, so distrusting it takes the whole evidence set with it |
| Aggregator serving doctored scores                                                                                         | Aggregator                   | Determinism plus published as-of head sets: any monitor recomputes and publishes mismatches; DNSSEC pins which aggregator said what                                                                             | A consumer that never verifies never notices. The default client behaviour matters more than the property                                                                 |
| Poisoning via a hacked observer key                                                                                        | External attacker            | DNS-based rotation and revocation; retroactive exclusion of the compromised window by policy; anomaly detection on sudden behavioural change ([03 §3.4](03-canonicalization-and-keys.md))                       | Everything signed before detection counted. Exclusion is a policy change, so it is not instant                                                                            |
| Deanonymizing reporters or recipients                                                                                      | Anyone                       | Aggregates, bucketing and k-thresholds only; bundles never public; openings minimized, monitor-only, and logged ([09](09-privacy.md))                                                                           | Adjudicating monitors see sampled recipients. Single-mailbox observers cannot be protected at all, which is why observer mode is off by default                           |
| DKIM replay: making an innocent domain "prove" spam it sent once                                                           | Spammer                      | Per-observer dedupe on `(Message-ID, bh=)` at capture; per-observer caps bound unchallenged inflation; duplicate-heavy openings are an `audit-finding`; oversigning guidance in posture                         | Cross-observer dedupe at scoring time does not exist, by design ([09 §9.5](09-privacy.md)). Caps and diversity are the only bound                                         |
| Subject's DKIM key compromised, so the attacker's spam verifiably attributes to the victim                                 | External attacker            | No retroactive erasure, since that is the whitewashing route. Rotate, publish `compromiseDisclosure`, then time decay plus leniency for a disclosed, rotated, non-recurring incident                            | The victim carries real negative evidence for a while. Chronic "we were hacked" is itself negative evidence, and telling the two apart takes time                         |
| Appeal flooding to bury small observers in challenge work                                                                  | Flagged sender               | Appeals bounded to the retention window and rate-limited; failed appeals cost the appellant standing; challenge cost is proportional to the sample, not the batch; first-lapse grace ([07 §7.2](07-appeals.md)) | A determined appellant still generates work. The bound is on volume per subject, not on total load                                                                        |
| Reporter deanonymization via crafted per-recipient content plus an appeal, or timing correlation against published windows | Spammer                      | Openings go to adjudicating monitors only, never the accused; k-thresholds with window widening ([04 §4.4](04-evidence-and-reporting.md))                                                                       | Real, and unfixable for very small observers. Pooled relays (plan D6) are the intended answer and do not exist yet                                                        |
| Governance capture, the new-gatekeeper problem                                                                             | Any large player             | Consumer-side observer re-weighting; forkable spec and open snapshots; the no-paid-standing rule; multi-stakeholder governance ([11](11-governance.md))                                                         | Forking is a right, not a plan. Capture resistance depends on there being someone with the will and money to fork                                                         |
| Hostile observer under-attests volume to inflate a subject's complaint rate                                                | Observer                     | A `spam-report-batch` is admissible only alongside that observer's `traffic-summary` for the same window; monitors cross-check the denominator against other observers                                          | Cross-checking needs other observers to see the same subject. Rare senders are hard to corroborate                                                                        |

## 10.2 Compromise and the erasure temptation

The one design pressure worth naming separately: after a key compromise, the
victim will want the evidence gone. We do not offer that. Retroactive erasure on
request is precisely the whitewashing route, and a spammer's claim of compromise
is indistinguishable from a victim's at the moment it is made.

The path is rotate, disclose with `compromiseDisclosure`, and let decay plus
policy leniency do the rest. It is slower than deletion and it is the only
version that does not hand every spammer a reset button.

## 10.3 Honest residual risks

Four trade-offs we accepted rather than solved. They belong in the specification
because an implementer who discovers them later will reasonably conclude we were
hiding them.

1. **Scale asymmetry.** A large mailbox provider that joins as an observer will
   dominate evidence volume even under caps. Diversity weighting softens the
   effect; it cannot erase the difference between a provider with a hundred
   million mailboxes and one with fifty.
2. **Unsigned mail.** Spam with no DKIM signature never enters the verified
   reporting path. The IP-side signals carry that load and are inherently
   weaker, which means the strongest evidence in the system is only available
   about senders who authenticate.
3. **Precision cost of privacy.** k-anonymity bucketing trades freshness and
   resolution for privacy, and small observers' evidence lands in coarse
   buckets ([09 §9.5](09-privacy.md)).
4. **List traffic is under-measured.** Forwarding usually preserves DKIM, so
   evidence still attributes to the true signer, which is correct. Mailing lists
   that rewrite content break the signature, so legitimate list traffic falls
   back to the weaker IP path. ARC helps only where the receiver already trusts
   the intermediary, and that is a trust decision OSTR cannot make for them.
   List-heavy small senders stay under-measured, and this is the gap most likely
   to produce an unfair `unknown` for a legitimate small sender.
