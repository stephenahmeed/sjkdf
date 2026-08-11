# Rentoids Free Minter

Auto-mint [Rentoids](https://www.rentoids.xyz/) (`OnChainLandlord`) on Robinhood Chain.

**Free lane only. This build never sends ETH — `msg.value` is hard-wired to `0`.
Your only cost is gas.**

- **Contract:** `0x1E757bCfC8D64d6c7B6381cAcfd9a7775745849f` (verified)
- **Chain:** Robinhood Chain, id `4663`
- **RPC:** Alchemy (default, ~4x faster) with the public
  `https://rpc.mainnet.chain.robinhood.com` as fallback
- **Explorer:** https://robinhoodchain.blockscout.com

---

## Install

Needs **Node.js 18+** and **ethers v6**.

```bash
# 1. unzip anywhere
unzip rentoids-free-minter.zip
cd rentoids-minter

# 2. install ethers (only dependency)
npm install

# 3. verify it runs — no key needed, reads chain only
node minter.cjs --status
```

If `--status` prints the collection state, you are ready.

Already have `ethers` elsewhere? Skip `npm install` and point Node at it:

```bash
NODE_PATH=/path/to/node_modules node minter.cjs --status
```

---

## Wallets

Put your private keys in `wallet.txt`, **one key per line**.
Comments (`#`) and inline labels after a key are allowed and ignored.

```text
# my burner wallets
0x1111111111111111111111111111111111111111111111111111111111111111 wallet-1
0x2222222222222222222222222222222222222222222222222222222222222222 wallet-2
0x3333333333333333333333333333333333333333333333333333333333333333
```

Any file can be used with `--wallets <file>` (default: `wallet.txt`).

---

## Usage

```bash
# Check mint state (no key needed)
node minter.cjs --status

# Preflight without sending anything
node minter.cjs --dry-run

# RUN: all wallets, all windows, until the mint itself closes
node minter.cjs

# Stop earlier: after 50 total wins
node minter.cjs -n 50
```

The default run has **no target and no attempt cap**: it keeps racing until one
of these happens, and stops by itself:

- **Sold out** — public supply hits 0 → `mint no longer open (sold out)`
- **Revealed** — reveal seed lands, mint closes forever → `(reveal)`
- **Every wallet capped** — all wallets at the on-chain 50 lifetime limit

### Options

| Flag | Meaning |
|---|---|
| `-n, --count <n>` | Stop after n total wins (default: unlimited, stop only on sold out / reveal / cap) |
| `--wallets <file>` | Wallet key file (default `wallet.txt`) |
| `--burst <n>` | Txs fired per wallet per 5s window (default 3) |
| `--max-attempts <n>` | Total tx cap across all wallets (default: unlimited) |
| `--fee-bump <%>` | Gas price bump over node estimate (default 25) |
| `--gas-limit <n>` | Force gas limit, skip estimation |
| `--rpc <url>` | Use only this RPC, replacing the default fleet |
| `--status` | Print state and exit |
| `--dry-run` | Preflight only |
| `--no-wait` | Do not wait for confirmations |
| `-v` | Verbose |

---

## Mint mechanics (read from verified source, not the marketing page)

`mint(uint256 count) payable` has a free lane and a paid lane on-chain.
**This tool only ever uses the free one:**

| Lane | Value | Per tx | Behaviour |
|---|---|---|---|
| Free | `0` | 1 | **One global slot per 5s window**, first-come-first-served. Losers revert with `Free slots full this block`. |
| ~~Paid~~ | ~~0.002 ETH~~ | — | **Not implemented in this build.** No code path can reach it. |

Hard limits enforced on-chain:

- `WALLET_LIMIT` = **50 lifetime per wallet**
- `MAX_SUPPLY` = 10000, of which `RESERVE_SUPPLY` = 100 is team-minted
- Minting closes the moment the reveal seed lands (`revealed()` → true)

### How the simultaneous hit works

The slot is **first-come-first-served and global**, so staggering wallets would
just hand the slot to someone else. Every wallet hits the same window together:

1. All txs are **built and signed in advance** — no key derivation, no gas
   estimation, no RPC round-trip left at fire time.
2. Nonces are read once up front, then tracked locally per wallet.
3. When the 5s window opens, the whole batch is broadcast **at the same instant**
   with no spacing. Every wallet gets `--burst` shots per window.
4. Each signed tx is pushed to **every RPC at once**. Same bytes, same hash, so
   the copies just dedupe in the mempool — but the fastest endpoint decides the
   race, and one slow endpoint cannot stall the round.

### RPC speed

Measured from a VPS, median round-trip:

| Endpoint | Time |
|---|---|
| Alchemy (default) | **~60ms** |
| Public Robinhood RPC | ~290ms |
| thirdweb | ~590ms |

Alchemy is the default and eight keys rotate so a per-key rate limit is not what
throttles a burst. Alchemy does occasionally spike to several seconds, which on
a 5s window would cost the whole round — that is why the public RPC stays in the
fleet as a fallback instead of being dropped.

Override the keys with `RENTOIDS_ALCHEMY_KEYS=key1,key2` if you have your own.

Each wallet keeps racing until it hits the on-chain `WALLET_LIMIT` (50) — then
it is dropped and the others continue. Unknown errors resync that wallet's
nonce instead of guessing, so a failed tx never strands the rest.

Losing most free races is the contract working as designed, not a bug. 1 slot
per 5s is 720/hour across every minter on the chain.

---

## Why you cannot get charged

The paid lane was removed rather than defaulted off:

- `FREE_VALUE_WEI = 0n` and `FREE_QTY = 1` are module constants, not defaults.
  No flag can change them.
- The paid price constant, `runPaidLane()`, and the `--paid` branch are gone.
  There is nothing to fall through to.
- Every signed tx is checked: `value !== 0n` is refused before signing.
- `--paid`, `-q`, and `--qty` now **exit with an error** instead of being
  silently ignored, so an old command line never looks like it worked.

Verified: `grep` for value assignments finds only `value: FREE_VALUE_WEI`.

---

## Cost

Gas only. Base fee has been sitting around 0.028 gwei — negligible.
A wallet with a zero balance is warned up front, because free mints still
need gas.

---

## Notes

- `estimateGas` fails during a contested free window; the tool falls back to
  `120000 + 60000 × qty` rather than aborting.
- Priority fee on this chain reports 0, so a 0.001 gwei floor is applied to avoid
  a zero-tip tx.
- Duplicate keys in the wallet file are skipped with a warning.
- Bad keys abort with `invalid private key on line N`, never echoing the key.
- The tool talks to RPC endpoints only — Alchemy plus the public Robinhood RPC.
  No telemetry, no other outbound calls, and keys are never logged.