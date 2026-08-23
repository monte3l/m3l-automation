# Example queue backlog alarm

The example queue is above its backlog threshold. This is a **synthetic**
runbook, authored for the `convert` tests — it exercises every shape the
converter reads and resembles no real document.

## Where to look

Query the consumer log group `/example/sqs/consumer` over the alarm window.

```text
fields @timestamp, @message, level | filter level = 'ERROR' | sort @timestamp desc
```

## Known cases

| Error              | Cause                                     | Verdict              | Ticket       | Resolution                                 |
| ------------------ | ----------------------------------------- | -------------------- | ------------ | ------------------------------------------ |
| ConsumerLagError   | the consumer fell behind its partition    | transient downstream | EXAMPLE-0010 | No action while the lag recovers.          |
| PoisonMessageError | a message failed every redelivery attempt | known open issue     | EXAMPLE-0011 | Move the message to the dead-letter queue. |

## Preset metadata

Everything the converter cannot read out of prose is declared here, so this
runbook converts to a preset that passes `validate` unattended.

```m3l-preset
{
  "correlation": {
    "field": "@message",
    "pattern": "messageId=([0-9a-f-]+)",
    "label": "message id"
  },
  "escalateTo": "example-owning-team"
}
```
