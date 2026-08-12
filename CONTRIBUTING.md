# Contributing to TSIX

Thanks for wanting to help out. This project is small, educational, and
experimental — contributions of any size are welcome, from fixing a typo in
the docs to implementing a new device driver.

Please read this guide first, and the documentation in
[`wiki/course/`](wiki/course/README.md).

---

## Design principle: Unix fidelity

TSIX is an OS simulation on Node.js, and its **north star is to behave like
Unix/Linux as closely as is practical**. Semantics matter more than mechanisms:
behavior observed from userland must match Linux (e.g. non-root cannot read
`/etc/shadow`, a non-root process cannot `setuid` freely), even though the
implementation is a simulation (e.g. saved UID `pcb.suid` in the kernel instead
of a CPU register).

Deviating from Unix is **allowed**, but only when the Node.js/V8 runtime
truly cannot model it — never as a shortcut. Any deviation **must be
documented** (a changelog entry and/or a code comment) with a clear technical
reason, so it is not mistaken for a bug. When in doubt, raise it in the issue
or PR discussion before merging.

---

## Getting started

### 1. Clone & install

```bash
git clone https://github.com/yourusername/tsix.git
cd tsix
npm install
```

### 2. Build a fresh image & boot

```bash
npm run install        # interactive: creates a new .db + src/sysconfig.json
npm start
```

Log in as `root` (default password: `root` unless you set one during install).

### 3. Run the tests

```bash
npm test               # vitest
npm run test:coverage  # coverage report
```

---

## Development workflow

The flow between host and the TSIX filesystem (VFS) is:

- `npm run install` — fresh image: creates the database, syncs `src/mirror` +
  `src/common`, applies executable/setuid modes, seeds auth & groups.
- `npm run vfs:bootstrap` — bulk sync `src/mirror` into the configured
  database (path from `kernel.database` in `src/sysconfig.json`).
- `scripts/sync-vfs.ts` — sync a single file on save.
- `scripts/vfs-pull.ts` — pull changes from the database back to the host.

Most code lives in `src/kernel/` (core), `src/vfs/` (filesystem backends),
`src/mirror/` (userland), and `src/common/` (shared types). See
[`wiki/course/00-overview.md`](wiki/course/00-overview.md) for the mental map.

---

## Documentation

- Official docs live in [`wiki/course/`](wiki/course/README.md). Follow
  [`wiki/course/format.md`](wiki/course/format.md) for the format.
- The loose files under `wiki/` are **internal working notes** (author + AI)
  and are not part of the official docs — do not treat them as source of truth.

---

## Commit & pull request guidelines

- Use clear, concise commit messages (imperative mood, e.g. "fix: resolve
  exec permission on /sbin binaries").
- Keep changes focused: one logical change per PR.
- Run `npm test` before opening a PR and mention the result.
- Update the relevant course docs if you change public behavior.

---

## Code of conduct

Be respectful. This is a learning project — the goal is to help each other
understand OS concepts, not to be right at all costs.

---

## License & attribution

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE), and that it retains the project's attribution
requirements (see the Trademark Notice in `LICENSE`): the platform name
**TSIX** must be preserved in any copy, modification, or distribution, while
distribution names (such as "Antigonon leptopus") may be changed freely.
