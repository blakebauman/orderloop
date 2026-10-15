# Security policy

## Reporting a vulnerability

Report a vulnerability privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Please don't open a public issue, pull request or discussion for it.

Include what you found, where (a URL, an endpoint or a file in this repository), how to reproduce
it, and what an attacker could do with it. A proof of concept helps, but keep it to the minimum
that shows the problem.

What to expect:

- An acknowledgement within 3 business days.
- An assessment (whether we can reproduce it, how severe it is, and what happens next) within 10
  business days.
- A fix, or a plan for one, before anything is made public. We'll agree a disclosure date with you,
  normally within 90 days of the report, and credit you in the advisory unless you'd rather not be
  named.

## Scope

In scope:

- This repository's code: the web app, the engine, the shared packages and the CI that deploys
  them.
- The hosted service at `console.orderloop.app` and its customer workspaces at `*.orderloop.app`,
  within the rules below.
- The marketing site at `orderloop.app`.
- The documentation site at `docs.orderloop.app`.

Out of scope: other projects on the `orderloop.io` domain, denial of service and load testing,
social engineering of OrderLoop staff or customers, physical attacks, and reports that only
come from automated scanners without a demonstrated impact.

## Testing rules

- Use only accounts and workspaces you own or have written permission to test. Never access,
  change or delete another customer's data; if you reach data that isn't yours, stop, and tell us
  what you saw.
- Don't degrade the service: no high-volume scanning, no flooding of endpoints, inboxes or webhooks.
- Don't run tests that send email to, or place orders with, people who haven't agreed to it.

We won't pursue legal action against research done in good faith under these rules, and we'll
treat it as authorized if anyone asks.

## Supported versions

OrderLoop is a hosted service deployed from `main`: every deployment runs the latest release, so
fixes ship to all of them. There are no older versions to patch.
