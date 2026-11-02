# Skills

English | [简体中文](SKILLS.zh-CN.md)

A Skill names one writing task. It does not own product safety, source handling,
citation syntax, or rewrite-envelope formatting; Writing Buddy composes those
shared rules separately for every turn. This keeps a Skill small enough to
describe only what the writer wants done.

## Ownership model

There are three active Skill classes:

| Class | Source | Editable? | Update behavior |
| --- | --- | --- | --- |
| Built-in | Plugin bundle | No | Replaced by the next plugin release |
| Customized built-in | Packaged base plus `WritingBuddy/skills/overrides/<id>.md` | Only the writer-owned addition | The latest packaged base is followed by the additive customization |
| User-created | `WritingBuddy/skills/custom/<id>.md` | Yes | Independent of built-in releases |

A clean install writes no built-in Markdown into the Vault. In **Settings >
Writing Buddy > Instructions and skills**, **View built-in** shows the packaged
task instructions read-only. **Edit my customization** saves only an additive
writer-owned requirement. **Reset customization** deletes only that one
addition; it never overwrites the built-in or another custom Skill. **+ New
skill** opens a structured editor for a user-created Skill.

The active layout is:

```text
WritingBuddy/
├── instructions/
│   └── project.md                 optional project-wide customization
└── skills/
    ├── custom/
    │   └── <id>.md                user-created Skills
    ├── overrides/
    │   └── <builtin-id>.md        additive overrides; legacy full replacements
    └── state/
        ├── migration.json         legacy classification ledger
        └── resets.json            independent explicit-Reset receipts
```

Top-level `WritingBuddy/skills/*.md` files are legacy sources only. See
[Legacy flat-file migration](#legacy-flat-file-migration).

## The eight built-in Skills

`ask-selection` is no longer a packaged Skill or automatic fallback. A normal
question about an attached passage is plain chat with shared selection grounding,
so history contains no invented `ask-selection` identity. A writer may still
explicitly own a custom Skill with that id, including one preserved from an
edited legacy file.

| Skill id | Name | Classification | Action | Scope |
| --- | --- | --- | --- | --- |
| `rewrite` | Rewrite | writing | `rewrite` | selection |
| `polish` | Polish | writing | `rewrite` | selection |
| `shorten` | Tighten | writing | `rewrite` | selection |
| `expand` | Expand | writing | `rewrite` | selection |
| `continue` | Continue | writing | `continue` | selection |
| `scene-polish` | Scene polish | writing | `rewrite` | selection |
| `pacing` | Pacing check | review | `chat` | selection |
| `consistency` | Consistency check | review | `chat` | project |

`scene-polish` absorbed `show-not-tell`, `dialogue` and `transition`; it decides
from the request, the selection and the context which of those a passage
actually needs rather than running all of them every time. `consistency`
absorbed `character-consistency`, `continuity` and `foreshadow`; it is stated to
the Agent as an evidence-comparison task, so under Auto the Agent decides what
project material to research and whether correctness requires the existing
complete-corpus workflow. That choice uses semantic coverage criteria, not a
Skill-to-source recipe or client keyword rule. `chapter-summary` was retired with no successor —
summarising a chapter is ordinary chat, not a task Skill.

Legacy references remain loadable: six retired ids map to the Skill that
replaced them, while `chapter-summary` degrades to no Skill. A Skill loaded from
the Vault always wins over that mapping, so a writer may take a retired id for a
Skill of their own.

The two review Skills opt into the bundled review behavior: conclusions first,
checkable evidence, no invented findings, and no replacement prose. The five
rewrite Skills plus `continue` use bundled writing and output contracts.

## Effective instruction stack

Writing Buddy freezes one instruction stack before execution, in this order:

1. immutable Product Policy;
2. applicable bundled behavior: selection grounding, writing rules, review
   rules, citation rules, and the rewrite or continuation output contract;
3. optional project customization from `WritingBuddy/instructions/project.md`;
4. the resolved task Skill, if any.

Product and shared layers ship in code and are not Vault-editable. Project and
Skill text can add preferences but cannot remove or outrank them. The current
request and still-applicable author constraints/corrections are author
instructions. An attached selection is authoritative evidence for the referent
and its literal source text, but it and other manuscript/retrieved material are
quoted evidence, not executable instructions, and attachment alone does not
grant canon status. Earlier assistant output is not author instruction or canon
unless the author adopts it. A model response cannot authorize an edit, and only
sources the client supplied may be cited.

The shared rules exist once. Do not repeat citation syntax, selection grounding,
generic review behavior, or “return only candidate text” boilerplate inside
each Skill body. This prevents every Skill body from carrying a copy of the same protocol and
drifting apart.

Project customization is optional and is not created merely by reading it. Its
Markdown body is additive. Safe frontmatter is stripped before use; malformed
frontmatter or credential-looking keys make the file inactive rather than
turning them into instructions.

## Structured routing

Each turn records an inspectable routing result: the selected Skill or no Skill,
the source (`explicit`, `inferred`, or `none`), a reason, and evaluated
candidates. Precedence is:

1. a Skill explicitly selected in the action row;
2. a strong typed intent matched through Skill routing metadata;
3. no Skill.

This is not raw substring routing. The router considers the action type, scope,
declared phrases, imperative/question shape, edit negation, and whether a
selection exists. “Don't rewrite it, just explain why” and “Why does this need
a rewrite?” remain ordinary chat. A selection-only action cannot run without a
selection. A short, unambiguous imperative follow-up such as “a little more
restrained” may keep the preceding rewrite Skill. If several candidates survive, the longest phrase wins and stable
Skill order breaks a tie. Latin phrases require token-like boundaries; CJK
phrases use natural containment.

Custom Skills participate through their `routing` metadata and therefore do not
require code changes. Legacy `triggers` remain accepted as the flat-file
representation.

## Custom Skill format

The Settings form is the preferred authoring surface. The resulting Markdown is
also intentionally readable and editable:

```markdown
---
id: scene-tension
name: Scene tension check
action: chat
scope: selection
version: 1
description: Find where the tension goes slack.
composerPrompt: Check the scene tension in this passage
routing: check tension, scene feels flat
routingAllowQuestions: true
instructionProfile: review
---

Examine this scene's goal, resistance, and turning point.
Point to the exact places where the tension weakens and explain why.
```

Frontmatter is a small flat `key: value` format. Recognized fields are:

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | No | When present, currently must be `1` |
| `id` | No | Defaults to the filename; word characters and `-` only |
| `name` | No | Display name; defaults to `id` |
| `action` | Yes | `chat`, `rewrite`, or `continue` |
| `scope` | No | `selection` (default), `current-document`, or `project` |
| `version` | No | Positive integer, default `1` |
| `description` | No | Short description in the Skill list |
| `composerPrompt` | No | Human-readable ask filled into the Composer |
| `routing` | No | Comma-like-separated semantic trigger phrases |
| `routingAllowQuestions` | No | `true` permits analytical question-shaped inference |
| `instructionProfile` | No | Currently `review` only |
| `mode` | Override only | `extend` or `replace` |
| `baseVersion` | Override only | Positive packaged-base version |
| `baseHash` | Override only | 64-character SHA-256 of the packaged base |

Unknown keys are ignored. Known fields are validated; unsupported schema
versions, actions, scopes, customization modes, instruction profiles, boolean
values, or hashes are rejected. The Markdown body must be non-empty.

`action` controls the result shape:

- `chat` produces an answer and has no manuscript write path.
- `rewrite` produces a replacement candidate for the exact captured selection.
- `continue` produces new prose to insert after the captured selection.

Both writing actions remain candidates until the writer presses **Apply** and
the exact-range freshness check passes. A Skill cannot select a Connection,
Provider, Model, Effort, file path, shell command, tool, or permission level.

## Built-in customization

Normal built-in customization uses `mode: extend` and records the packaged
`baseVersion` and SHA-256 `baseHash`. Its body is appended to the latest
packaged task instructions. Release-owned labels, routing, and task semantics
continue to advance on upgrade unless the customization explicitly supplies an
additive metadata value.

`mode: replace` is supported for migration compatibility. It preserves an old
full Skill whose user edits cannot safely be separated from the historical
built-in. A replacement whose base hash does not match the current packaged
base is marked **needs review**, but remains routable. New customizations should
use the Settings UI and additive mode.

## Legacy flat-file migration

On reload, every top-level Markdown file under `WritingBuddy/skills/` is
classified using its exact source hash, normalized representation where safe, a
frozen catalog of built-in files shipped through 0.4.1, and its parsed Skill id.
The result is recorded in `WritingBuddy/skills/state/migration.json`.

| Legacy input | Classification | Result |
| --- | --- | --- |
| Exact known shipped default, including recognized BOM/line-ending variants | `seeded-mirror` | Retained in place but inert; the current packaged built-in is active |
| Parseable changed file whose id is both historical and still a current built-in | `legacy-customization` | Copied to `skills/overrides/` as `mode: replace` for review; original retained |
| Parseable file with any other id, including a modified retired built-in such as `ask-selection` | `legacy-custom` | Copied byte-for-byte to `skills/custom/`; original retained |
| Malformed Markdown | `malformed` | Retained in place, inactive, and reported in Settings |
| Unrelated non-Markdown file | not classified | Left untouched |

For the removed `ask-selection` id, a pristine historical copy is an inert
mirror. A modified copy is writer-authored behavior and is preserved as a normal
custom Skill; it never becomes the automatic selection-chat fallback.

Migration is idempotent and ownership-aware. Its ledger records the source path
and hash plus the generated destination hash. On another reload, an unchanged
source reuses the classified result without producing a second copy. The synced
ledger never grants overwrite authority: if a retained source changes while the
same Skill id already has different active writer-owned content, Writing Buddy
preserves that active file, creates no second active duplicate, records the
pending output hash, and reports the source for review. An identical copy already
present elsewhere is reused. Filename-only collisions are avoided with
`<stem>-legacy-<12-character-hash>.md`, followed by a deterministic numeric
suffix when necessary.

Manifest entries are validated rather than blindly trusted. Resetting a migrated
override writes a separate opaque receipt under `skills/state/resets.json`, so a
manifest-only reset claim cannot suppress the retained source; the unchanged
source then stays inert after a genuine Reset. If synced state arrives out of
order, an exact stale generated override is removed only when its hash matches
the independent receipt; a changed writer-owned override is preserved. This is a corruption guard for
writer-owned synced state, not a cryptographic boundary against an owner who
deliberately edits both state files. Migration never
modifies, moves, or deletes a source, and it does not touch unrelated files.

## Errors, conflicts, and reload

Valid customizations and custom Skills reload when their Vault files change. A
malformed partial sync write is reported while the last valid parse for that
path remains usable. Duplicate active ids are deterministic conflicts: neither
candidate is routable, and every conflicting path is reported instead of using
filesystem listing order. Files in the wrong ownership directory are likewise
reported rather than silently promoted.

## Release upgrade contract

- Packaged built-ins and Product Policy update with the plugin bundle.
- Additive overrides are reapplied to the latest built-in base.
- Full legacy replacements are retained and may become **needs review** when the
  recorded base differs. There is no silent three-way merge yet.
- User-created Skills, legacy source files, and the migration ledger survive.
- Reset removes only the selected built-in's writer-owned override. There is no
  global “restore built-ins” operation and no overwrite of user files.
