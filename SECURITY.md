# Security Policy

TSIX is an **experimental** project. It is not yet suitable for production use or for controlling anything where a security failure would cause harm. See the security status section in the [README](README.md#security-status-experimental) for what is and is not protected today.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** (GitHub private vulnerability reporting).
3. Describe the issue, the affected component and version or commit, and how to reproduce it.

Only the maintainers can see the report. If private reporting is unavailable for some reason, open a public issue that says only "security contact request" (no details), and a maintainer will reach out.

## What to expect

TSIX is maintained by a small team in their free time, so timelines are best effort:

| Step | Target |
|---|---|
| Acknowledge the report | within 7 days |
| Initial assessment (valid / severity) | within 14 days |
| Fix or mitigation for critical and high issues | as soon as practical, usually within 90 days |

We will keep you updated, credit you in the release notes if you wish, and coordinate the disclosure date with you. Please give us a reasonable time to fix the issue before publishing details.

## Supported versions

Only the latest commit on the `main` branch receives security fixes. There are no long-term-support releases yet.

## Scope

In scope:

- the TSIX kernel, VFS, drivers, and userland in this repository (`src/`);
- the MQTNL protocol and its implementation;
- bundled applications and daemons (Lantana, tssh/tsshd, scpd, tpkg/tpkgd, netfsd, otad, ...);
- the ESP firmware library in `platformio/` (`tsixlib`).

Out of scope:

- vulnerabilities in third-party MQTT brokers or other external services;
- attacks that require an already-compromised host machine running the TSIX simulator;
- issues that are already listed as known limitations in the README security status section (reports with new impact or a practical exploit path are still welcome).
