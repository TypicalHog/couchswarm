# vendor

`mediabunny-1.38.1-cd3cd2b.tgz` is `npm pack` of [kzahel/mediabunny](https://github.com/kzahel/mediabunny) at commit `cd3cd2beb9c122dfa6fa89edbd7a73f2fa9df7a0`, the fork `playsvideo` asks for as the moving branch `#integration`. It is vendored rather than fetched from GitHub so that the lockfile carries an integrity hash, installs do not depend on the fork staying online, and npm does not run a nested unlocked `npm install` in the checkout to satisfy the fork's `workspaces` field.

The `overrides` entry in `package.json` points `playsvideo`'s own `mediabunny` edge at this same tarball. To move to a newer fork commit, `npm pack` that checkout with its `dist` built, drop the tarball here under its short SHA, update both the devDependency and this note, then `npm install` to refresh the lock.

The package is MPL-2.0; its `src` and `LICENSE` are inside the tarball.
