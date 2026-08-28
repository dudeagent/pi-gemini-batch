# pi-gemini-batch

a [pi](https://github.com/earendil-works/pi-mono) extension that adds a
`google-batch` provider which runs agent sessions through the
[gemini batch api](https://ai.google.dev/gemini-api/docs/batch) at **50% of
interactive pricing**.

## how it works

the batch api is non-streaming: requests are submitted as a job and polled
until completion (typically minutes, sla is 24h). this extension implements
pi's `streamSimple` contract on top of that flow:

1. converts the pi context to generateContent params (reusing pi-ai's shared
   google converters, so messages/tools/thinking behave identically to the
   interactive google provider)
2. submits a single-request batch job via `client.batches.create`
3. polls `client.batches.get` until a terminal state
4. emits the full response (text / thinking / tool calls / usage) as pi
   stream events

aborting the stream cancels the underlying job.

## models

| model | batch price (in/out per m tokens) |
|---|---|
| gemini-2.5-flash | $0.15 / $1.25 |
| gemini-2.5-flash-lite | $0.05 / $0.20 |
| gemini-2.5-pro | $0.625 / $5.00 |
| gemini-3-flash-preview | $0.25 / $1.50 |
| gemini-3.1-flash-lite | $0.125 / $0.75 |
| gemini-3.1-pro-preview | $1.00 / $6.00 |
| gemini-3.5-flash-lite | $0.15 / $1.25 |
| gemini-3.5-flash | $0.75 / $4.50 |
| gemini-3.6-flash | $0.375 / $1.875 |
| gemini-3.7-flash | $0.375 / $1.875 |

prices from the [docs](https://ai.google.dev/gemini-api/docs/pricing) as of
2026-08-28. note 3.6/3.7 flash are at promo pricing through 2026-12-31.

## configuration

- `GEMINI_API_KEY` - api key (required)
- `GEMINI_BATCH_POLL_INTERVAL_MS` - poll interval, default 10000
- `GEMINI_BATCH_TIMEOUT_MS` - give up on a job after this long, default 24h

## usage

install as an extension (e.g. drop the package path into pi's
`additionalExtensionPaths` or the extensions dir), then select a model from
the `google-batch` provider. best for autonomous/background agent runs where
cost matters more than latency.

## tests

```
npm test
```

10 unit tests with a mocked `@google/genai` client covering: happy path text,
tool calls, thinking blocks, failure states, timeout + job cancel, abort +
job cancel, missing api key, and provider registration.
