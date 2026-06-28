# Capability index

A quick "which class do I use for X?" map. Find the need on the left, use
the listed M3L class or function, and follow the link to its reference
page for the full API. Everything here lives under the `Core` namespace
unless noted as `AWS`; import from the namespace
(`import { Core, AWS } from "@m3l-automation/m3l-common";`) or from the
`./core` / `./aws` subpaths.

## Application framework

| I need to…                                                                     | Use                                                 | Reference                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------- |
| Build a CLI or Lambda entry point with lifecycle, config, logging, and cleanup | `M3LScript`                                         | [script](../reference/core/script.md) |
| Parse and resolve CLI args, files, env, presets into typed values              | `M3LConfigReader` with `M3LConfigParameter`         | [config](../reference/core/config.md) |
| Load a named parameter preset                                                  | `M3LScriptPresetLoader` / `M3LPresetConfigProvider` | [config](../reference/core/config.md) |

## Logging and console UI

| I need to…                                                                                    | Use               | Reference                               |
| --------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------- |
| Emit structured, multi-sink logs (console, file, JSON)                                        | `M3LLogger`       | [logging](../reference/core/logging.md) |
| Show interactive prompts (text, password, number, confirm, select, multiselect, autocomplete) | `M3LPrompt`       | [prompt](../reference/core/prompt.md)   |
| Show one or more concurrent task spinners                                                     | `M3LMultiSpinner` | [prompt](../reference/core/prompt.md)   |
| Show a percentage progress bar                                                                | `M3LLoadingBar`   | [prompt](../reference/core/prompt.md)   |

## Reading and writing data

| I need to…                                     | Use                                           | Reference                                   |
| ---------------------------------------------- | --------------------------------------------- | ------------------------------------------- |
| Read a CSV file (batch or streaming)           | `M3LCSVListImporter`                          | [importers](../reference/core/importers.md) |
| Read a JSON or JSONL file (batch or streaming) | `M3LJSONListImporter` / `M3LJSONFileImporter` | [importers](../reference/core/importers.md) |
| Read a text file line by line                  | `M3LTextFileImporter` / `M3LFileListImporter` | [importers](../reference/core/importers.md) |
| Write a CSV file                               | `M3LCSVListExporter`                          | [exporters](../reference/core/exporters.md) |
| Write a JSON or JSONL file                     | `M3LJSONListExporter` / `M3LJSONFileExporter` | [exporters](../reference/core/exporters.md) |
| Write an HTML report from a template           | `M3LHTMLListExporter`                         | [exporters](../reference/core/exporters.md) |
| Write a binary file                            | `M3LBinaryFileExporter`                       | [exporters](../reference/core/exporters.md) |

## Files, JSON, and text

| I need to…                                                   | Use                                    | Reference                           |
| ------------------------------------------------------------ | -------------------------------------- | ----------------------------------- |
| Archive input/config files to the execution output directory | `M3LFileCopier`                        | [files](../reference/core/files.md) |
| Navigate or parse a dot-notation JSON field path             | `navigateFieldPath` / `parseFieldPath` | [json](../reference/core/json.md)   |
| Detect whether a file is JSON or JSONL                       | `M3LJSONFormatDetector`                | [json](../reference/core/json.md)   |
| Extract text from PDF, DOCX, XLSX, email, or ZIP             | `M3LTextExtractorRegistry`             | [text](../reference/core/text.md)   |

## Search

| I need to…                                                   | Use           | Reference                               |
| ------------------------------------------------------------ | ------------- | --------------------------------------- |
| Run in-process full-text search over documents (SQLite FTS5) | `M3LFtsIndex` | [storage](../reference/core/storage.md) |

## Network, polling, and resilience

| I need to…                                                | Use              | Reference                               |
| --------------------------------------------------------- | ---------------- | --------------------------------------- |
| Make HTTP requests                                        | `M3LHttpClient`  | [network](../reference/core/network.md) |
| Poll external state until it reaches a terminal condition | `M3LPoller`      | [polling](../reference/core/polling.md) |
| Retry the same operation on transient failures            | `M3LRetryRunner` | [polling](../reference/core/polling.md) |

## Analysis and events

| I need to…                                                                | Use                     | Reference                                 |
| ------------------------------------------------------------------------- | ----------------------- | ----------------------------------------- |
| Evaluate rows against threshold rules (operator + aggregation + severity) | `M3LThresholdEvaluator` | [analysis](../reference/core/analysis.md) |
| Emit and handle type-safe events                                          | `M3LEventEmitterBase`   | [events](../reference/core/events.md)     |

## Errors and results

| I need to…                                            | Use         | Reference                             |
| ----------------------------------------------------- | ----------- | ------------------------------------- |
| Throw structured, coded errors with context and cause | `M3LError`  | [errors](../reference/core/errors.md) |
| Propagate failures without exceptions (Result type)   | `M3LResult` | [errors](../reference/core/errors.md) |

## Paths and concurrency

| I need to…                                               | Use                  | Reference                           |
| -------------------------------------------------------- | -------------------- | ----------------------------------- |
| Resolve data/config/input/output/cache directories       | `M3LPaths`           | [utils](../reference/core/utils.md) |
| Run async work with a bounded number of concurrent tasks | `M3LConcurrencyPool` | [utils](../reference/core/utils.md) |

## AWS

| I need to…                                                | Use                                                    | Reference                                      |
| --------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| Manage and validate AWS SSO credentials                   | `AWS.M3LAWSCredentialsManager`                         | [credentials](../reference/aws/credentials.md) |
| Create and reuse AWS SDK clients for one or many profiles | `AWS.AWSClientProvider` / `AWS.AWSMultiClientProvider` | [clients](../reference/aws/clients.md)         |

## See also

- [Guide: Configuration](./configuration.md)
- [Guide: Environments and paths](./environments-and-paths.md)
- [Architecture overview](../m3l-common-architecture.md)
