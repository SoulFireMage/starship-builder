# Working on this repo

## Git: push straight to `main`
The owner's standing instruction: **commit and push directly to `main`**.
The site deploys from `main` (GitHub Pages, deploy from branch, root), so
work only counts once it's there.

- If a session is started on a feature branch, still fast-forward or merge
  the work into `main` and push it (`git push origin HEAD:main`) when done.
- Before pushing a change to the site, bump the version: `node tools/version.mjs`
  (patch bump; or pass e.g. `2.5.0`). The CDN caches scripts for hours, and the
  version is stamped into every module URL, so an unbumped release can leave
  people running stale code. The version shows in the page footer.
- Run `npm test` (checks the version stamps too) and `node tools/ui-test.mjs`
  for UI changes before pushing.
- Don't open pull requests unless asked.

## Project notes
- An AI project: built by Claude from an initial plan by Gemini; keep that
  credit in the README and the page footer.
- Read `AGENT_SPEC.md` before changing the compiler or the genome.
