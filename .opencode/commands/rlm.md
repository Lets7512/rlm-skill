Use the RLM (Recursive Language Model) pattern for this task. Instead of reading large data into context, write code to process it externally and only print a summary.

Key principle: **Tokens are CPU, not storage.** Never dump raw data into context.

For the user's request "$ARGUMENTS":

1. If dealing with a large file — write code to process it in a sandbox, print only findings
2. If analyzing multiple files — chain code executions: survey scope, slice into chunks, deep-dive on specifics
3. If data is 50MB+ and needs sub-LLM decomposition — use `rlm-cli query "..." --file <path> --stats`

Always write code first, execute it, and return only the summary. Never read large files directly.
