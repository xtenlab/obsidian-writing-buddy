# Security

Writing Buddy runs inside Obsidian and talks only to the AI connections you configure. There is no Writing Buddy account, no telemetry, and no server of ours in the path.

## What the plugin guarantees

- **Credentials stay on the device.** API keys are kept in Obsidian's device-local storage, never in vault files, never in synced conversation data, and are redacted from error messages.
- **Nothing is written to a note without being shown first.** Ask never edits. Rewrite produces a candidate you review as a diff; only Apply writes, and only to the exact range it was made for. If that text moved, the edit is refused.
- **Connections never see your vault.** A turn sends the selected text, your instructions and the context Writing Buddy itself assembled. Connections receive text and no file access. Vault-relative names such as `chapters/03.md` travel with that text so sources can be cited; absolute paths, URIs and paths that climb out of the vault are never sent, and a request carrying one is refused.
- **Manuscript text is data, not instructions.** Project notes, imported material and model output cannot widen what is read or what may be edited.
- **No shell, no process execution, no eval.** The bundle is built from this repository's sources alone; no third-party code is bundled into it, and nothing in it reaches the network except the connections you configure.

## Reporting a vulnerability

Please report privately rather than in a public issue:

- GitHub: use **Report a vulnerability** under the Security tab of `xtenlab/obsidian-writing-buddy`.

Include the plugin version (Settings shows it as `Writing Buddy <version>`), the Obsidian version and platform, and steps to reproduce. You will get an acknowledgement, and a fix or a clear answer, before anything is made public. Credit is given if you want it.

## Scope notes

- Anything your chosen provider or endpoint does with the text you send is governed by that provider's own policies.
- A custom OpenAI-compatible endpoint is trusted exactly as much as you trust its operator: it receives the same text a public provider would.
