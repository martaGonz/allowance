# Demo script (4:00)

Four minutes satisfies every track's video requirement at once: The Graph asks for 2–4 minutes,
Hedera for 5 or fewer, Arc requires a video with a walkthrough.

Voiceover in English (international judges), optional subtitles. Screen recording at 1080p,
terminal and panel side by side. **Real payments only, never simulated** — every transaction
opens in its explorer on screen. Every cell below marked `<!-- PENDING-TX: ... -->` gets filled
in with the real hash and link after recording — never before, and never with a placeholder that
looks real.

| Time | Screen | Voiceover (English) | Proves |
|---|---|---|---|
| 0:00–0:20 | Title card: **Allowance** — "An agent shouldn't hold keys. It should get an allowance." | "Agents can decide to spend money. What stops you leaving one running isn't capability, it's cost. Allowance is the spending brake." | — (hook) |
| 0:20–0:50 | Panel: allowance issued (0.03 USDC, expires in 1 hour). HashScan: ATS bond deployment and `issue` to the agent — `[deployBond](https://hashscan.io/testnet/transaction/0x3020f40e93ece3dbd3aba7ae5d149e422060db4ae0bd2c8a0822d11f51697f13) → [bond contract](https://hashscan.io/testnet/contract/0x595e5f93d1e48f822AC5bDB9F14AB4A2FCf8d365)` / `[issue to the agent](https://hashscan.io/testnet/transaction/0xac81cd9ccf2aca4b61f65d39feddb385baffbd410a20138acd08dee75e35df7b)`. | "The human issues an allowance note as a tokenized instrument with Hedera's Asset Tokenization Studio contracts, and allocates it to the agent." | Hedera — Tokenization |
| 0:50–1:40 | Panel: query by query, with the price shown before each one. Terminal: 402 → pay → data. HashScan: x402 payment whose fee payer is `0.0.7162784` (Blocky402) — `<!-- PENDING-TX: x402-payment -->`. | "Every query is paywalled with x402 on Hedera and settled through the Blocky402 facilitator. No payment, no data." | Hedera — Agentic Payments |
| 1:40–2:10 | Panel: position state and price. Code, briefly: the query to the Messari Standardized Subgraph. | "The data comes from The Graph: a Messari Standardized Subgraph for Uniswap v3 on Base, so one query shape reads both position and prices." | The Graph — Composable/Standardized |
| 2:10–2:40 | **Key shot.** Panel log line reads, in red: **REFUSED (data is still fresh)** or **REFUSED (too expensive right now)**. | "Here is the point: the agent declines a query. It isn't worth the price yet. The spending rule is deterministic — the model reasons about the data, it never decides to spend." | The Graph — AI (data-grounded decisions) |
| 2:40–3:05 | Panel: analyst pill reads **OK**, **WATCH** or **ACT**, with the summary beneath it. Arcscan: USDC settlement from the Circle wallet — `<!-- PENDING-TX: arc-settlement -->`. | "Claude turns paid data into an alert. Each payment is settled in USDC on Arc from a Circle Developer-Controlled Wallet, idempotent per payment." | Arc — Agentic Economy / Treasury |
| 3:05–3:30 | Panel: budget draining to zero, badge reads **STOPPED: allowance exhausted**. Terminal prints the event: `{ kind: 'stopped', reason: 'exhausted' }`. | "When the allowance runs out, the agent stops by itself. Nobody has to be watching." | Core thesis |
| 3:30–3:50 | A second allowance is issued; click **Revoke allowance** on camera. HashScan: `controllerRedeemByPartition` — `<!-- PENDING-TX: ats-burn -->`. Panel badge reads **STOPPED: allowance revoked**; terminal prints `{ kind: 'stopped', reason: 'burned' }`. | "And revoking is one click: the note is burned on-chain. The agent cannot spend a cent more." | Hedera — Tokenization (burn) |
| 3:50–4:00 | Architecture diagram (from the README) and a link to the repo. | "Allowance. Agents get an allowance, not the keys." | Arc — required architecture diagram |

## Pre-recording checklist

- Accounts funded: Hedera testnet account (HBAR + USDC `0.0.429274`), Circle Developer-Controlled
  Wallet on Arc testnet.
- `.env` filled in with at least `GRAPH_API_KEY`, `CIRCLE_API_KEY`, and `ANTHROPIC_API_KEY`, plus
  the Hedera and Arc variables the gate and treasury need (see the README setup table).
- A real position chosen (`WATCH_POSITION_ID`) on the Messari Standardized Subgraph for Uniswap
  v3 on Base.
- Budget: `ALLOWANCE_AMOUNT_MICRO_USDC=30000` (0.03 USDC, `.env.example`'s default) — sized against
  the catalog's real prices (`token_price` 2,000 microUSDC, `position_state` 12,000 microUSDC) so
  the note actually reaches exhaustion on camera instead of taking hours. With this budget, the
  run's events happen in this order: **payments** for both tools in the first round, then
  `token_price` keeps paying every time it goes stale while `position_state` stays fresh; once the
  remaining balance drops below `position_state`'s price, its refusal reads **"too expensive right
  now"** — this is the 2:10–2:40 key shot, and it keeps recurring near the end of the run — until
  the last `token_price` payment brings the balance to exactly zero and the agent stops itself
  with **`{ kind: 'stopped', reason: 'exhausted' }`** (3:05–3:30). This whole run takes several
  minutes of real wall-clock time (the agent waits between rounds when nothing is worth buying);
  **do not try to compress it into one continuous take** — see the no-simulation rule below: the
  exhaustion beat (3:05–3:30) is recorded as its own take once the budget has actually drained
  (started from a fresh, near-empty allowance, or left running until it happens for real) and
  edited into the final cut, exactly like every other segment.
- Explorer tabs open and ready: HashScan testnet, Arcscan testnet.
- System notifications turned off.

## No-simulation rule

**If a real payment fails live, do not cut and do not simulate it.** Record a clean take of each
segment separately and edit them together afterward. A failed take is a reason to re-record that
segment for real, never a reason to fake the transaction on screen.
