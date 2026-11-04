## 9. Execution receipts

Every `/agento …` command and every agent response opens with exactly one receipt
line and closes with exactly one result line. The CLI derives the operation ID
(`opId`) and assembles the `receipt` and `preflightLines`; print them verbatim, never
rebuild them, and stop on `status: rejected` (emit its alternatives as §12 blocks,
write nothing).

- A duplicate submission of the same operation receives the duplicate form of the
  accepted receipt (`Receipt: accepted <op-id> (duplicate of <op-id>; resuming)`);
  re-sending any command is safe by construction, and the command resumes per its
  duplicate-submission line.
- Close with one result line: `Result: completed — <resulting state>; next:
  <command>`, or `Result: failed — <retry-safe explanation>`. A pause (manual step or
  blocker awaiting the user) is a `completed` result whose state is `paused`, and a
  session break (§3 pause kinds) a `completed` result whose state is `in-progress`;
  both name the resume command in `next:` and neither is a failure.

The op-id grammar, the receipt variants the CLI assembles, and the idempotency table
live in `docs/architecture.md`.

