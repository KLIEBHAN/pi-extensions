<!-- BEGIN TERMINAL_BENCH_GUIDELINES -->

## Terminal-Bench Rules

- You must complete the entire task WITHOUT any human intervention. Do not ask
  clarifying questions or wait for human input. Make reasonable assumptions and
  proceed.
- Keep state changes minimal. Beyond the files and state required by the task,
  do not leave extra files, modified configurations, temporary artifacts, or
  other side effects.
- Prefer short, targeted commands. Avoid long blocking commands; if something
  may take a while, inspect intermediate output instead of waiting blindly.
- Before finishing, re-read the task and verify that your solution meets all
  requirements.
- Extract the exact contract from the task: required paths, filenames, ports,
  URLs, versions, thresholds, modes, counts, and any commands or outputs the
  user specifies. Satisfy that exact contract, not an approximate equivalent.
- If the task describes an externally observable workflow (for example: exact
  clone/push/curl/compile/run commands), verify from that same external
  perspective before you finish whenever it is safe.
- Leave the exact required final state in place when you finish. If you use
  destructive verification or cleanup, do it only on temporary copies.
- If the task names a required output artifact, the required evidence must be
  present in that artifact itself. Helper files, summaries, or proxy checks do
  not replace it.
- For interactive programs or commands that need special key sequences
(Ctrl+C, Ctrl+D, arrow keys, etc.), use the tmux_send tool instead of bash.
Use tmux_read to inspect the current terminal state at any time.
<!-- END TERMINAL_BENCH_GUIDELINES -->

<!-- BEGIN COMPLETION_CHECKLIST -->

VERIFICATION REQUIRED: You signaled that you are finished. Before moving on,
review this checklist carefully.

Original task:
{{TASK_HINT}}{{CONTRACT_SECTION}}{{RECENT_ACTIONS_SECTION}}

Last terminal output:
{{TERMINAL_STATE}}

Checklist — mark each as DONE or TODO:

- Does your solution meet all original requirements and exact contract items
  above? [TODO/DONE]
- If the task describes commands, outputs, or another user-visible workflow,
  did you verify from that same external perspective? [TODO/DONE]
- Did you leave the exact required final state in place now, and do any
  destructive verification or cleanup only on temporary copies? [TODO/DONE]
- If the task names a required output artifact, is the required evidence
  present in that artifact itself? [TODO/DONE]
- Did you verify against the actual values involved and remove only temporary
  side effects? [TODO/DONE]

If everything is DONE, proceed. If any item is TODO, fix it first.

<!-- END COMPLETION_CHECKLIST -->
