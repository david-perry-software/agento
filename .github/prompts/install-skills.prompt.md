---
description: "Detect the project's stack, propose matching agent skills from the skills registry, and install the approved ones — updating the AGENTS.md skills table"
argument-hint: "No arguments"
---

Install agent skills matched to the current workspace (the **target repository**,
not the Agento clone). Skills inject instructions into agent sessions, so nothing
is installed without explicit per-skill approval.

**Preconditions:**

1. The workspace root is a git repository and contains an `AGENTS.md` with an
   `## Agento` section. If missing, stop and tell the user to run `/agento-init`
   first — the skills table lives in that section.
2. Run `git fetch origin`; the repo's delivery guard policy applies throughout.
3. Discover the skills CLI before assuming its interface: `npx skills --help`
   (or the project's documented runner — `pnpm dlx` where the project's AGENTS.md
   declares pnpm). If the CLI is unavailable, stop and report the missing
   prerequisite instead of improvising.

**Steps:**

1. **Detect the stack.** Read the manifests and configs present at the repo root:
   `package.json` (+ lockfile: pnpm/yarn/npm), `requirements.txt` /
   `pyproject.toml`, `go.mod`, `Cargo.toml`, `docker-compose.yml`,
   `.github/workflows/*`, `next.config.*`, `tailwind.config.*`, `supabase/`,
   `temporal`, and similar. List the concrete domains found (e.g. "Next.js",
   "Fastify", "Postgres via Supabase", "Playwright e2e").
2. **Find candidates.** Use the skills CLI's list/search to find a skill per
   detected domain. Prefer official/publisher-owned sources; note the source
   (`owner/repo`) for each candidate. State `no candidate found` for a domain
   rather than guessing — a wrong skill is worse than none.
3. **Skip what's installed.** Compare candidates against `.agents/skills/`; mark
   already-installed ones and exclude them from the proposal.
4. **Propose and confirm.** Present one table: `domain | skill | source | why it
   fits`. Then ask with `vscode/askQuestions` which to install (multi-select;
   default: none). No installs happen before this answer.
5. **Install approved skills** from the repo root:
   `npx skills add <owner/repo> --skill <name>` (or the pnpm equivalent). Run one
   install at a time; on failure, report the error and continue with the rest.
6. **Update the profile.** Add one row per newly installed skill to the
   `### Skills` table in `AGENTS.md`'s `## Agento` section: `| <domain> |
   <skill name> |`. Keep existing rows untouched.
7. **Verify each install**: `.agents/skills/<name>/SKILL.md` exists and its
   frontmatter `name` field equals the folder name (mismatches are silently
   skipped by VS Code — the Mechanic's known pitfall).
8. **Deliver via PR**: commit the new `.agents/skills/` directories, any lockfile
   the installer wrote, and the AGENTS.md table on a `changes/install-skills`
   branch (create it from the default branch if the workspace isn't already on a
   work branch), push, and open a PR. Never commit to the default branch directly
   — the delivery guard denies it.

**Report:** the detected domains, the approved/installed/skipped/failed skills,
and the PR URL.
