---
name: write-adr
description: Use when a change touches an architectural file (see docs/architectural-files.txt) or a design decision needs recording. Produces a numbered ADR in docs/adr/ in the repo's format.
---

# Write an ADR

## Numbering

Files are `docs/adr/NNNN-kebab-case-title.md`. `NNNN` is four digits, the highest existing number
plus one (`ls docs/adr | sort | tail -n 1`). Never renumber or reuse a number. To change a
decision, write a new ADR that supersedes the old one and set the old one's status to
`Superseded by NNNN`.

## Template

```markdown
# NNNN: Short imperative title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context

What situation forces a decision. Facts, constraints, the options that were realistic. Cite the
PRD or spec section when one applies.

## Decision

What was decided, stated so an engineer can check code against it. Name the files, constants,
and rules involved.

## Consequences

What becomes easier, what becomes harder, what must now be remembered. Include the operational
consequence (deploy, rollback, tests) when there is one.
```

## Procedure

1. Pick the number and file name.
2. Fill the template. Keep it under a page. Prefer concrete rules ("every write carries
   `WHERE generation_id = ...`") over intentions.
3. If the ADR changes a rule stated in `CLAUDE.md` or `docs/ARCHITECTURE.md`, update those in the
   same change.
4. Add a `CHANGELOG.md` bullet if code changed alongside.
5. Run `npm run docs:check`.
