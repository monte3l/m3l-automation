# Core: `messaging`

An abstract messaging interface: define a transport once by implementing a writer (and optionally a reader), then send plain messages, templated reports, and errors through a uniform `M3LMessenger` facade.

## Overview

The `messaging` module describes how scripts emit outbound messages and read inbound ones without binding to any specific transport. `M3LMessenger` wraps a required `M3LMessageWriter` and an optional `M3LMessageReader`, applying a `defaultTarget` fallback when a call does not name a target. It exposes high-level helpers for sending a plain message, a templated report, and an error. This module ships only the abstract interfaces and the messenger facade — no concrete transport is provided; consumers implement the writer/reader for their channel.

## Public API

Exported from `@m3l-automation/m3l-common/core` (and the `Core` namespace):

- Facade: `M3LMessenger`
- Abstract interfaces: `M3LMessageWriter`, `M3LMessageReader`
- Message types: `M3LOutboundMessage`, `M3LReceivedMessage`, `M3LMessageTarget`, `M3LMessageAuthor`, `M3LMessageReceipt`
- Attachments: `M3LInboundAttachment`, `M3LOutboundAttachment`

## Writer and reader interfaces

`M3LMessageWriter` is the abstract outbound interface — implementing it is how you add a transport (email, chat, queue, etc.). It accepts a `M3LOutboundMessage` (optionally carrying `M3LOutboundAttachment` values addressed to a `M3LMessageTarget`) and returns a `M3LMessageReceipt`.

`M3LMessageReader` is the optional abstract inbound interface. It yields `M3LReceivedMessage` values, which carry a `M3LMessageAuthor` and any `M3LInboundAttachment` values. A messenger configured with only a writer is send-only.

## The `M3LMessenger` facade

`M3LMessenger` is constructed with a writer (required), an optional reader, and a `defaultTarget`. When a send method is called without an explicit target, the `defaultTarget` is used.

It provides three send helpers:

- `sendMessage(text, target?)` — send a plain text message.
- `sendReport(template, data, attachments?, target?)` — render a template with `{{ key }}` interpolation against `data`, then send it (optionally with attachments).
- `sendError(errorMessage, error?, target?)` — send an error notification, optionally including the underlying error.

```typescript
import { Core } from "@m3l-automation/m3l-common";

// `writer` is your own M3LMessageWriter implementation for the chosen transport.
const messenger = new Core.M3LMessenger({
  writer,
  defaultTarget: { id: "ops-channel" },
});

await messenger.sendMessage("Job started");

await messenger.sendReport("Processed {{ count }} rows in {{ seconds }}s", {
  count: 1280,
  seconds: 42,
});

try {
  await runJob();
} catch (error) {
  await messenger.sendError("Job failed", error);
}
```

## Notes and behavior

- This is an abstract interface only: nothing here opens a network connection. Behavior depends entirely on the `M3LMessageWriter`/`M3LMessageReader` implementation you supply.
- `sendReport` interpolates `{{ key }}` placeholders from the `data` object into the `template` string.
- Omitting a `target` on any send call falls back to the messenger's `defaultTarget`.
- A messenger without a reader cannot receive messages; provide a `M3LMessageReader` to read inbound traffic.

## See also

- [analysis](./analysis.md)
- [errors](./errors.md)
- [logging](./logging.md)
- [Architecture overview](../../m3l-common-architecture.md)
