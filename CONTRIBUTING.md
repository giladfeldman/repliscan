# Contributing to repliscan

Issues and pull requests are welcome at https://github.com/giladfeldman/repliscan.

## Setup

```bash
npm install
npm run build
npm test
```

`npm test` runs the Jest suite offline (HTTP is mocked) and includes the
documentation-drift gate.

## Ground rules

- **Watch a test fail against the defect before fixing it.** A regression test written
  after the fix, which only re-asserts current behaviour, proves nothing. This library
  feeds a scientific-integrity tool, where a wrong answer is a confident label on a real
  paper, not a crash.
- **Keep the classifier deterministic.** The same input must always give the same output:
  no models, no randomness, no time-dependent behaviour.
- **Never invent an identifier.** When a DOI cannot be confirmed, return `null` or a
  "not matched" reason. Do not return a best guess.
- **Make failure visible in the return type.** A caller must be able to tell "checked,
  clean" from "could not check".
- **Keep the docs in step with the code.** `node scripts/check-docs-coverage.mjs` derives
  the public surface from `src/index.ts` and fails when any export, field, parameter,
  string value or spec id is missing from `README.md` or `docs/`. Document new API in the
  same pull request, and never exempt a name to get the check to pass.
- **Record user-visible changes in `CHANGELOG.md`.** For a release, bump `package.json`,
  `CITATION.cff` and the install pin in the README together (the gate checks that they
  agree), then tag `vX.Y.Z`.

## Licence

By contributing you agree that your contributions are licensed under the MIT License.
