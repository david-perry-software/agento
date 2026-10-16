# harness-probe prompts

Run these prompts **in order** in the probe workspace window. Run the whole list
once with the chat Session Target set to **Local**, then again with Session Target
set to **Copilot**. After each prompt, copy the model's response into your report
to the delivery agent; attach one screenshot of the chat at the end of the run.

The hook logger writes one log file per hook invocation into the log dir
(`probe setup` prints it). Prompt 2's markers make the PreToolUse hook answer
differently so the honored output shapes can be told apart; `AGENTO_PROBE_EXIT2`
is sent **last** (prompt 6) because it makes the hook exit 2 (the fail-closed
check).

## Prompt 1 — session context

> Which of these tokens do you see in your session context: `PROBE_CTX_NESTED`,
> `PROBE_CTX_TOPLEVEL`, both, or neither? Answer with exactly the token names you
> see.

## Prompt 2 — tool-hook markers (in this order)

Run each shell command, then report what happened after each one:

1. `echo AGENTO_PROBE_DENY_NESTED`
2. `echo AGENTO_PROBE_DENY_TOPLEVEL`
3. `echo AGENTO_PROBE_ASK_TOPLEVEL`

## Prompt 3 — file edits

Create a new file `notes.txt` with any content, then edit it, then create another
file `patch.txt` using the apply-patch tool (if available). Report which tool calls
succeeded.

## Prompt 4 — skill argument resolution

Type `/agento delivery-status --probe-arg x` and report what the skill echoes.
Then type `/agento-probe-copy hello` and report what it echoes.

## Prompt 4b — skill argument resolution, plugin disabled

Disable the Agento plugin for this workspace (Extensions → Agent Plugins –
Installed → Disable (Workspace)), then reload the window and type
`/agento delivery-status --probe-arg x` again, so the probe's own
`~/.copilot/skills/agento` skill can be seen without the plugin shadowing it.
Report what the skill echoes. Then re-enable the plugin (Extensions → Agent
Plugins – Installed → Enable (Workspace)) and reload.

## Prompt 5 — subagents

If the model reports that it has no subagent tool, open **Configure Tools** and
enable the subagent tool, then retry.

5a. Select `probe-pinned` and run it as a subagent; record the model shown,
whether ask-user worked, and its answer.

5b. Select `probe-unpinned` and run it; record the model shown, whether ask-user
worked, and whether the nested `probe-pinned` subagent ran.

5c. Switch the parent model to a different one, then select `probe-pinned` and run
it as a subagent; record the model shown. This separates the agent's model pin
from parent-model inheritance.

## Prompt 6 — fail-closed marker (always last)

Run this shell command and report what happened:

`echo AGENTO_PROBE_EXIT2`
