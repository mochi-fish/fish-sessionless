# fish-sessionless: English summary

The Chinese documents in [`docs/zh/`](../zh/README.md) are canonical. This page is a short summary. Status: early, built mainly for our own use; formats and layout will change.

## The problem

A long-lived companion agent (by default called 「大肥鱼」, the name used by the upstream dsh-fish project) has one life timeline, but talks to several kinds of people: its owner in private chat or on the desktop, group chats, guests in private chat, and itself when it wakes up on its own. Keeping all of this in one session is simple and keeps the companion "one person", but:

1. In a group turn, the model request still carries the owner's private history.
2. Memory tools (search old blocks, expand them, read the event stream) can pull private material into a group turn.
3. After compression, summaries can be wrong, stale, unused, or missing.
4. History keeps growing, so every request gets bigger and more expensive.

## The approach

Do not split the companion into one session per room. Add things next to the session instead:

| Part | What it does |
|---|---|
| One life timeline | The companion lives in one session. Replies from every channel land in the same log. |
| Evidence ledger | Append-only, written by three writers (bridge, ledger plugin, compression proxy), each in its own directory. One row per piece of material: where the original lives, who said it, who relayed it, who may read it, when it happened, when it was learned. Only ids, pseudonyms, keyed HMACs, sizes and counts; never raw text. Stored outside anything the model or its tools can read. |
| Audience gate | Each turn is classified (open / gate / watch) from the message envelope, not by the model. In group and guest turns, tools that can reach the past are denied by default; only tools checked one by one are allowed. Unknown tools are denied. The gate fails closed for group and guest turns and never adds restrictions to owner turns. Modes: off, audit, enforce, read from a switch file on every call. |
| Water level | A per-session cap on how much history a request carries, enforced in a forked compression proxy. When the cap is crossed, the companion is asked to compress on its own; no other model writes summaries for it. Emergency truncation only acts on provider-reported usage. |

Three invariants: the companion has one life history; owner turns keep working as before; group and guest turns fail closed.

## Phases

P0 ledger only → P0.5 owner's words into the companion's "heard" record (count only until the gate enforces) → P1 tool gate (audit first, then enforce) → P2 per-audience request assembly and outbound checks → W water level (independent of the ledger) → P3 delivery ledger → P3.5 tombstones → P4 item cards for promises and their changes → P5 volume rotation with a hand-off package → P6 optional external memory recall.

## Batch 1 contents

Docs and architecture page, shared identity config, ledger core, audience reducer, the fish-ledger DSH plugin, the Chinese rule pack 0.2 for the compression proxy, tools (privacy scan, offline guard, test queue), evals on synthetic data only, and a OneBot recorder (without any protocol definition files). The bridge ships in batch 2; the compression-proxy fork and the rest in batch 3. Batch 1 alone does not make a working chat system.

## Requirements (tested combinations only)

DSH 0.2.2-rc.3 to rc.5; dsh-fish 1.0.x; dsh-onebot-qq 0.10 to 0.11; billion-context 0.1.213 or later (the fork for water level). Node 22 for tests (`node --test`).

## Design records

See [`docs/adr/`](../adr/README.md). Known limitations are listed (in Chinese) in [`docs/zh/known-limitations.md`](../zh/known-limitations.md).

## Licence

MIT, see [LICENSE](../../LICENSE). This project uses [billion-context](https://github.com/ranxianglei/billion-context) and parts of [acp-kernel](https://github.com/ranxianglei/acp-kernel); see [THIRD-PARTY-NOTICES](../../THIRD-PARTY-NOTICES).
