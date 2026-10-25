# pi-web-search source attribution

This directory vendors the provider/search implementation from **pi-web-search
1.7.0**, by **ttttmr**, under its declared **MIT** license.

- Official directory: https://pi.dev/packages/pi-web-search
- npm: https://registry.npmjs.org/pi-web-search/1.7.0
- Upstream: https://github.com/ttttmr/pi-web-search
- Tarball: https://registry.npmjs.org/pi-web-search/-/pi-web-search-1.7.0.tgz
- Tarball SHA-512: `VthBC7G6v4vkQMgL6atADMi6XjKjoQbI0QUvn76Ldhzv+ewCTlJEN7441PSiz7reDk5AyU8kZZabOQQVNfDXjg==`

The published package.json states author `ttttmr` and license `MIT`; its README
also states MIT. Neither the 1.7.0 npm tarball nor the upstream repository at the
time of import supplied a standalone license/copyright notice. LICENSE below
reproduces the standard MIT terms, attributing the declared author without
inventing a copyright year. This notice must travel with redistributed source.

## Local delta

- Upstream `src/index.ts` is not vendored: Pindie owns tool registration through
  `src/web-search.ts`, uses native default rendering, marks errors as errors,
  and avoids conflicts with existing extensions. No upstream TUI renderer or
  active-tool suppression manager is included.
- `providers/auth.ts`: omit null-valued Pi 1.4 credential headers before passing
  resolved headers to the upstream transports (API typing compatibility).
- Trailing whitespace in `web_search.ts` / `url_context.ts` is normalized.
- Other `.ts` files are the unchanged 1.7.0 npm source snapshot.

No runtime npm dependency on pi-web-search exists. To update, review a new
**npm tarball**, compare all files and this delta, retain attribution, and rerun
provider fixtures, native-loader coexistence tests and the opt-in live smoke.
Do not copy an unverified similarly named GitHub repository.
