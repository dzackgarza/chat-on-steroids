## What changed

Describe the root cause and the smallest behavior change that fixes it.

## Validation

- [ ] The validation oracle is independent of the implementation under test (real filesystem/process/OS, external standard/runtime, or live external service).
- [ ] `npm run verify` passes for local checks.
- [ ] If ChatGPT, Chrome, the extension, conversation lifecycle, or bridge behavior changed, `npm run verify:live` passed against a real authenticated ChatGPT session. A mocked/fake ChatGPT path is not acceptance evidence.
- [ ] Packaging/runtime smoke was run when the change can differ after bundling.
- [ ] No unrelated formatting, generated output, local debugging notes, or private data is included.
- [ ] Screenshots, logs and examples use placeholders instead of real usernames, paths, chat text, IDs or credentials.
- [ ] Security-sensitive details are being handled privately instead of disclosed here.
