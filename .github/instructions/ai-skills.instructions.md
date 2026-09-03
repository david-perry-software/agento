---
description: "Skills-first policy: load the matching installed AI skill before domain work"
applyTo: "**"
---

Installed AI skills live in `.agents/skills/<name>/SKILL.md` in the target repository
(and/or come from installed plugins). Before starting work in a matching domain, read
the skill and follow it; record consulted skills in plan.md/review.md.

The domain → skill mapping is **project-specific**: each target repository keeps its
own table in the `## Agento` section of its AGENTS.md (scaffolded by `/agento-init`),
listing the domains that occur in that codebase and the skill that covers each one.
If a domain has no matching skill, say `none — no matching domain` in the plan's
`Skills consulted:` line rather than guessing.

Install new skills with the skills CLI from the repository root
(`npx skills add <owner/repo> --skill <name>`, or the project's documented equivalent),
then add the domain row to the project's skills table.
