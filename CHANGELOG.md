# Changelog

## 0.6.1

Republish of 0.6.0 through the GitHub Actions **Publish to npm (with provenance)** workflow so the package carries an npm provenance statement (required for n8n verified community nodes as of 1 May 2026).

0.6.0 was tagged and that workflow ran, but `npm publish --provenance` failed with HTTP 409 (`Cannot publish over previously staged version "0.6.0"`) because 0.6.0 had already been staged or published manually. The 0.6.0 tarball on npm therefore has no provenance. This release has no functional node changes.

The publish workflow now fails early if the version in `package.json` is already on npm, so a manual publish cannot block a later provenance publish of the same version.

## 0.6.0

Search and Read operation ($0.015) on the direct x402 API; raise the per-call ceiling to $0.020.
