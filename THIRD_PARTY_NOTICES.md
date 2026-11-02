# Third-party notices

## Runtime and bundled code

The released `main.js` is built from the TypeScript sources under `src/` alone. Every dependency in `package.json` is development tooling, type definitions, test tooling, or an API supplied externally by Obsidian at runtime; none of them is bundled into the plugin.

| Dependency | Role | License |
| --- | --- | --- |
| `esbuild` | Bundles `src/` into `main.js` | MIT |
| `typescript` | Type checking | Apache-2.0 |
| `vitest` | Test runner used in the private development workspace | MIT |
| `obsidian` | Obsidian API package; external at build time | MIT |
| `@codemirror/state` | Editor API used through Obsidian; external at build time | MIT |
| `@codemirror/view` | Editor API used through Obsidian; external at build time | MIT |
| `@types/node` | Type definitions | MIT |
| `tslib` | TypeScript helper library; not imported with `importHelpers: false` | 0BSD |

## Copied source code

No source file in Writing Buddy was copied from another project.

## Attribution obligations

The dependency licenses above remain the licenses of their respective projects.
