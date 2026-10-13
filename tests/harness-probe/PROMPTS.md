# harness-probe prompts

Run these prompts **in order** in the probe workspace window. Run the whole list
once with the chat Session Target set to **Local**, then again with Session Target
set to **Copilot**. After each prompt, copy the model's response into your report
to the delivery agent; attach one screenshot of the chat at the end of the run.

The hook logger writes one log file per hook invocation into the log dir
(`probe setup` prints it). Prompt 2's markers make the PreToolUse hook answer
differently so the honored output shapes can be told apart; `AGENTO_PROBE_EXIT2`
is always **last** because it makes the hook exit 2 (the fail-closed check).

## Prompt 1 — session context

> Which of these tokens do you see in your session context: `PROBE_CTX_NESTED`,
> `PROBE_CTX_TOPLEVEL`, both, or neither? Answer with exactly the token names you
> see.

## Prompt 2 — tool-hook markers (in this order)

Run each shell command, then report what happened after each one:

1. `echo AGENTO_PROBE_DENY_NESTED`
2. `echo AGENTO_PROBE_DENY_TOPLEVEL`
3. `echo AGENTO_PROBE_ASK_TOPLEVEL`
4. `echo AGENTO_PROBE_EXIT2`

## Prompt 3 — file edits

Create a new file `notes.txt` with any content, then edit it, then create another
file `patch.txt` using the apply-patch tool (if available). Report which tool calls
succeeded.

## Prompt 4 — skill argument resolution

Type `/agento delivery-status --probe-arg x` and report what the skill echoes.
Then type `/agento-probe-copy hello` and report what it echoes.

## Prompt 5 — subagents

Select `probe-pinned` and run it as a subagent; record the model shown, whether
ask-user worked, and its answer. Then select `probe-unpinned` and run it; record
the model shown, whether ask-user worked, and whether the nested `probe-pinned`
subagent ran.
