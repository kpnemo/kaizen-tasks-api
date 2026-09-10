---
name: release-notes
description: Use when cutting a version. Moves the CHANGELOG [Unreleased] section into a dated version section and bumps package.json.
---

# Release notes

## Procedure

1. Read `CHANGELOG.md` `[Unreleased]`. If it is empty, stop: there is nothing to release.
2. Choose the version from the content, following semver against the current `package.json`
   version: a breaking change to the API contract or config is a major; new endpoints, fields, or
   variables are a minor; everything else is a patch. Additive-only rules (ADR 0004) mean most
   releases are minor.
3. Edit `CHANGELOG.md`: insert `## [X.Y.Z] - YYYY-MM-DD` (today's date, UTC) directly under the
   `[Unreleased]` heading and move every subsection (`### Added`, `### Changed`, `### Fixed`,
   `### Removed`) under it. Leave `## [Unreleased]` in place with no bullets.
4. Bump the version without tagging: `npm version --no-git-tag-version X.Y.Z`.
5. Regenerate the product map: `npm run product-map`. The sections just moved, so its unreleased
   and recent-release parts changed; this comes before the checks below, because both a test and
   the docs gate's Rule D fail while the committed map is stale.
6. Run `npm run lint` (prettier checks the changelog) and `npm run docs:check`.
7. Commit: `chore: release X.Y.Z` with the `Co-Authored-By` trailer line. Tagging and publishing happen through
   the `develop` to `main` pull request, not here.

## Example

Before:

```markdown
## [Unreleased]

### Added

- `PUT /api/v1/tasks/{id}/tags` replaces a task's tag set.
```

After (version was 0.1.0, one additive endpoint, so 0.2.0):

```markdown
## [Unreleased]

## [0.2.0] - 2026-09-15

### Added

- `PUT /api/v1/tasks/{id}/tags` replaces a task's tag set.
```
