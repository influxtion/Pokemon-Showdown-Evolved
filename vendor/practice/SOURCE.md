# Practice simulator runtime

`dist/` (`npm run build:practice`) is a generated, ignored Windows x64 runtime holding the pinned Showdown simulator and the patched classic battle client. It is what releases ship under `resources/practice`. Bots connect to it as players; Foul Play itself is installed separately (see [api/README.md](../../api/README.md)). Keep credentials, personal logs, saved games and developer server configuration out of it.

## Sources

- [Pokémon Showdown server](https://github.com/smogon/pokemon-showdown), MIT, revision `a9caa4cabe89459b00e717a47148d0f67b4451ae` for simulation. Its reviewed production dependency locks are `server-package.json` and `server-package-lock.json`.
- [Pokémon Showdown classic client](https://github.com/smogon/pokemon-showdown-client), AGPL-3.0, revision `49b54209ebee54ceb8fff62a5eb5bedf7efcf6dc`. Its build tooling uses server data revision `202b6b385c2536977c60a97bf12d931c2d449586`; this does not replace the simulator. See [SHOWDOWN-CLIENT-SOURCE.md](SHOWDOWN-CLIENT-SOURCE.md).

## Build

Build on Windows x64 with Node.js 24, npm and Git on PATH. The first build needs network access to fetch the pinned source revisions and dependencies under `out/`. From the desktop repository, after installing its npm dependencies, run:

```powershell
npm run build:practice
npm run test:practice
```

The build compiles the pinned simulator and classic client, then creates and verifies a v3 manifest (`kind` `simulator`) with each payload file's size and SHA-256. A verified candidate replaces `dist/`; an earlier runtime is retained under `out/practice/previous-runtime-*`. Stop a running Practice session before rebuilding.

For inspection while an existing runtime is in use, `npm run build:practice -- --stage-only`
retains a verified `pending-*` candidate next to the runtime without replacing it.
Failed candidates are removed; prior active runtimes are preserved.

The runtime's `sources/` folder retains archives of the pinned Showdown simulator,
classic client and its separate data-generator repositories, plus the top-level builder,
local adapter scripts (`scripts/practice/`), client shell and notices.

At **Start practice**, the desktop verifies the manifest and exact file inventory in a worker before launching the simulator. An incomplete or damaged runtime fails startup with a rebuild message.
This detects inconsistency and corruption; the local manifest is not a publisher signature.

The client builder records its loopback connection, local storage and practice navigation patches in code. The adjacent HTML, bootstrap and CSS provide the practice shell. Battle simulation, move controls, rendering, HP bars and type colors remain upstream. The desktop view permits official Pokémon artwork. It disables audio and arbitrary browser navigation.

## Before distribution

Before releases are offered to testers, review corresponding source and notices for
the patched AGPL client and dependencies; the owner's licensing decision is still open.
See [practice bots](../../docs/bots.md).
