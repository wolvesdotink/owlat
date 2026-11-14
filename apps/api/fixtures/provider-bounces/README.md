# Relay bounce payloads

Bounce notifications in the shapes each relay documents, used by the adapter
tests to check who a bounce is about (`bounceCause`):

- `ses.json`: the `Message` of an Amazon SES `Bounce` notification, one per
  bounce type and subtype in "Bounce types" of
  https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html. The
  first entry is the example on that page.
- `resend.json`: Resend `email.bounced` events, shaped like
  https://resend.com/docs/webhooks/emails/bounced. The first entry is the
  example on that page.
- `emailit.json`: the Emailit `email.bounced` event from
  https://emailit.com/docs/webhooks/events/email/bounced/.

Addresses, hosts and IPs are documentation values (`example.com`,
`192.0.2.0/24`).
