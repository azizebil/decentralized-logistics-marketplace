# A2A envelope

The seller agent speaks a minimal Agent-to-Agent payments envelope inspired by
Google's A2A protocol. It is intentionally small: this is a course project,
not a production protocol, and the schema only covers the messages our
marketplace actually exchanges.

The envelope is JSON, one message per line over TCP (default port 7438 — `a2a`
+ `2026`'s last two digits, chosen to be memorable, not standard).

## Wire format

```json
{
  "v": "a2a/1",
  "id": "<uuid v4>",
  "from": "<agent identifier — typically an EOA address or DID>",
  "to":   "<peer identifier — same shape>",
  "intent": "<one of: bid-discuss | bid-confirm | co-sign-needed | rank-explain>",
  "ctx": {
    "deliveryId": "0x<bytes32>",
    "registry":   "0x<address>",
    "chainId":    31337
  },
  "body": { /* intent-specific */ }
}
```

* `v` is a literal version string; bump if the schema breaks.
* `id` is a fresh UUID. Replies set `body.replyTo = <original id>`.
* `ctx` is mandatory — without a `deliveryId` and `registry` address the
  message has no on-chain anchor and the seller agent rejects it.

## Intents

### `bid-discuss` (courier → seller agent)

A courier (or its agent) sounds out the seller agent before committing gas to
a bid.

```json
{
  "intent": "bid-discuss",
  "body": {
    "askedPrice": "100000000000000000",
    "promisedEta": 3600,
    "courier": "0xCo...",
    "pool": "0xPo..."
  }
}
```

Reply (seller agent → courier):

```json
{
  "intent": "bid-discuss",
  "body": {
    "replyTo": "<original id>",
    "feasible": true,
    "wouldRank": 0.82,
    "reason": "within budget and deadline buffer"
  }
}
```

`wouldRank` is the deterministic `r/(t·p)` score from `seller_agent_core.js`,
normalised. The seller agent will not commit to accepting any specific bid in
this exchange — it just publishes the ranker's current view.

### `bid-confirm` (courier → seller agent)

Notification that an on-chain bid has been placed. The seller agent uses this
to short-circuit polling and re-rank immediately. No reply required.

```json
{
  "intent": "bid-confirm",
  "body": {
    "bidIndex": 2,
    "txHash": "0x..."
  }
}
```

### `co-sign-needed` (seller agent → seller's master key client)

Emitted when the deterministic ranker picked a bid whose declared value is
above the seller's `coSignThreshold`. The agent refuses to call
`acceptBidByAgent` (it would revert on-chain) and asks the human seller to
call `acceptBid` themselves.

```json
{
  "intent": "co-sign-needed",
  "body": {
    "bidIndex": 1,
    "declaredValue": "5000000000000000000",
    "explain": "...short rationale..."
  }
}
```

### `rank-explain` (any → seller agent)

A debug intent. The seller agent replies with the current ranking of all open
bids for `ctx.deliveryId`, including each bid's `r`, `t`, `p` and the final
score. Disabled in production builds via the agent's `--debug` flag.

## What's deliberately *not* in the envelope

* No payment amounts in the envelope itself. All value flow is on-chain — the
  envelope is purely metadata/coordination. This is the key difference from a
  payment protocol like x402: A2A here describes *intent to transact*, the
  smart contracts describe *the transaction*.
* No signatures. The envelope is informational. If the receiver wants to act
  on it, they must independently verify the corresponding on-chain state.
* No retry/ack semantics. TCP gives us order; idempotency is provided by the
  `id` field; replays are tolerated because the on-chain logic is the source
  of truth.

## Why bother at all

Because off-chain coordination *will* happen — couriers will negotiate, agents
will compare ranks, sellers will want to override. Standardising the envelope
keeps that traffic legible and auditable, and means anomaly detection (the
collusion mitigation in §4 of the threat model) can run against a structured
log rather than scraping chat transcripts.
