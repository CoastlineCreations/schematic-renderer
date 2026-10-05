# Entity models

Each JSON file contains one base64-encoded GLB from the original model catalog.
`index.ts` maps entity names to explicit dynamic imports so the ES library fetches
only models requested by `EntityRenderer`. The UMD build embeds these imports to
keep its script-tag distribution self-contained.

When adding a model, add its JSON file and matching loader entry. Keep the key
equal to the entity name used by callers, including any version suffix.
