# Changelog

## 0.7.0

- New **News Search** operation: `POST /x402/v1/news` on the direct x402 API, $0.008 per call (not charged when there are no results), 1-10 articles.
- New **Screenshot** operation: `POST /x402/v1/screenshot`, $0.010 per call (failed captures not charged), PNG or JPEG, optional full page and viewport. The image is returned as n8n binary data (property `data` by default); the base64 is removed from the JSON.
- New **Filters** collection on News Search and Search and Read: freshness, date_from/date_to, country, language, include_domains, exclude_domains.
- Direct prices updated to match the API: Extract $0.004 (was $0.007), Search and Read $0.009 (was $0.015). Search $0.008 and Render $0.010 unchanged.
- README: the direct per-call ceiling is $0.020 (two places still said $0.010).

## 0.6.1

Republish of 0.6.0 through the GitHub Actions **Publish to npm (with provenance)** workflow so the package carries an npm provenance statement (required for n8n verified community nodes as of 1 May 2026).

0.6.0 was tagged and that workflow ran, but `npm publish --provenance` failed with HTTP 409 (`Cannot publish over previously staged version "0.6.0"`) because 0.6.0 had already been staged or published manually. The 0.6.0 tarball on npm therefore has no provenance. This release has no functional node changes.

The publish workflow now fails early if the version in `package.json` is already on npm, so a manual publish cannot block a later provenance publish of the same version.

## 0.6.0

Search and Read operation ($0.015) on the direct x402 API; raise the per-call ceiling to $0.020.
