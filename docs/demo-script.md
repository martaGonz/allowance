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
| 0:20–0:50 | Panel: allowance issued (5 USDC, expires in 1 hour). HashScan: ATS bond deployment and `issue` to the agent — `<!-- PENDING-TX: ats-bond-deploy -->` / `<!-- PENDING-TX: ats-issue -->`. | "The human issues an allowance note as a tokenized instrument with Hedera's Asset Tokenization Studio contracts, and allocates it to the agent." | Hedera — Tokenization |
| 0:50–1:40 | Panel: query by query, with the price shown before each one. Terminal: 402 → pay → data. HashScan: x402 payment whose fee payer is `0.0.7162784` (Blocky402) — `<!-- PENDING-TX: x402-payment -->`. | "Every query is paywalled with x402 on Hedera and settled through the Blocky402 facilitator. No payment, no data." | Hedera — Agentic Payments |
| 1:40–2:10 | Panel: position state and price. Code, briefly: the query to the Messari Standardized Subgraph. | "The data comes from The Graph: a Messari Standardized Subgraph for Uniswap v3 on Base, so one query shape reads both position and prices." | The Graph — Composable/Standardized |
| 2:10–2:40 | **Key shot.** Panel: one query **REFUSED**, shown in red: "still fresh" or "too expensive". | "Here is the point: the agent declines a query. It isn't worth the price yet. The spending rule is deterministic — the model reasons about the data, it never decides to spend." | The Graph — AI (data-grounded decisions) |
| 2:40–3:05 | Panel: analyst level (WATCH/ACT) and summary. Arcscan: USDC settlement from the Circle wallet — `<!-- PENDING-TX: arc-settlement -->`. | "Claude turns paid data into an alert. Each payment is settled in USDC on Arc from a Circle Developer-Controlled Wallet, idempotent per payment." | Arc — Agentic Economy / Treasury |
| 3:05–3:30 | Panel: budget draining to zero. Terminal: `stopped: exhausted`. | "When the allowance runs out, the agent stops by itself. Nobody has to be watching." | Core thesis |
| 3:30–3:50 | A second allowance is issued; click **Revoke** on camera. HashScan: `controllerRedeemByPartition` — `<!-- PENDING-TX: ats-burn -->`. Agent: `stopped: burned`. | "And revoking is one click: the note is burned on-chain. The agent cannot spend a cent more." | Hedera — Tokenization (burn) |
| 3:50–4:00 | Architecture diagram (from the README) and a link to the repo. | "Allowance. Agents get an allowance, not the keys." | Arc — required architecture diagram |

## Pre-recording checklist

- Accounts funded: Hedera testnet account (HBAR + USDC `0.0.429274`), Circle Developer-Controlled
  Wallet on Arc testnet.
- `.env` filled in with at least `GRAPH_API_KEY`, `CIRCLE_API_KEY`, and `ANTHROPIC_API_KEY`, plus
  the Hedera and Arc variables the gate and treasury need (see the README setup table).
- A real position chosen (`WATCH_POSITION_ID`) on the Messari Standardized Subgraph for Uniswap
  v3 on Base.
- Budget (`ALLOWANCE_AMOUNT_MICRO_USDC`) sized so that **at least one refusal appears** before the
  note is exhausted — the 2:10–2:40 shot depends on it.
- Explorer tabs open and ready: HashScan testnet, Arcscan testnet.
- System notifications turned off.

## No-simulation rule

**If a real payment fails live, do not cut and do not simulate it.** Record a clean take of each
segment separately and edit them together afterward. A failed take is a reason to re-record that
segment for real, never a reason to fake the transaction on screen.
