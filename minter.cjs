#!/usr/bin/env node
/**
 * RENTOIDS Free Minter
 * ====================
 * Auto-mint Rentoids (OnChainLandlord) NFTs on Robinhood Chain — FREE LANE ONLY.
 *
 * This build cannot spend ETH on mint price. `msg.value` is hard-wired to 0 and
 * there is no paid code path to fall back to, so a bad flag or a bad edit can
 * never turn into a 0.002 ETH charge. Gas is the only cost.
 *
 * Contract mechanics (verified on-chain, source read from Blockscout):
 *   mint(uint256 count) payable
 *     - FREE lane : msg.value == 0, ONE global slot per 5s window, FCFS.
 *                   Losing the race reverts with "Free slots full this block".
 *                   count must be 1 (FREE_PER_BLOCK = 1).
 *   Lifetime cap : 50 per wallet (WALLET_LIMIT).
 *   MAX_SUPPLY   : 10000, of which RESERVE_SUPPLY 100 is team-minted.
 *
 * Strategy: chain block time is ~0.1s, so the winner is whoever lands a tx first
 * in a fresh window. This tool aligns submission to the window boundary and
 * fires a burst, dropping the ones that revert.
 *
 * Environment:
 *   RENTOIDS_PRIVATE_KEY  Private key fallback (also accepts ETH_PRIVATE_KEY)
 *   RENTOIDS_RPC_URL      Custom RPC fallback
 *
 * Usage & examples at bottom (--help).
 */

// Alchemy is roughly 4x faster than the public endpoint from here (median
// ~60ms vs ~290ms). Keys rotate so a per-key rate limit is not what throttles
// a burst. The public RPC stays in the list as a fallback: Alchemy occasionally
// spikes to multiple seconds, and on a 5s window a stall like that costs the
// whole round.
const ALCHEMY_KEYS = (process.env.RENTOIDS_ALCHEMY_KEYS || [
  'p2SBiwHNOPpXWGL_jf88b',
  'fTLS0dlYtRgxpIko1ZTmJ',
  'HEMCckz-VT0owp-jwjqP0',
  'alch_KCz6-wvMOp0RYYdCh7yKA',
  'wCpQQoeAQ7x5YzJo3YKvx',
  'alch_hJHKXbof9uCinN25mwi7m',
  'rRzUA81CNF0Nn7niIKPo8',
  'alch_2-itxtgSWTLNcY73_PUuY',
].join(',')).split(',').map((k) => k.trim()).filter(Boolean);

const ALCHEMY_URLS = ALCHEMY_KEYS.map((k) => `https://robinhood-mainnet.g.alchemy.com/v2/${k}`);
const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';

const CONFIG = {
  CONTRACT: '0x1E757bCfC8D64d6c7B6381cAcfd9a7775745849f',
  DEFAULT_RPC: process.env.RENTOIDS_RPC_URL || ALCHEMY_URLS[0] || PUBLIC_RPC,
  BROADCAST_RPCS: [...ALCHEMY_URLS, PUBLIC_RPC],
  EXPLORER: 'https://robinhoodchain.blockscout.com',
  CHAIN_ID: 4663,
  CHAIN_NAME: 'Robinhood Chain',
  MAX_PER_TX: 10,
  WALLET_LIMIT: 50,
  MAX_SUPPLY: 10000,
  FREE_WINDOW: 5, // seconds
  FREE_PER_BLOCK: 1,
};

// The free lane mints exactly one token per transaction and pays nothing.
// These are constants, not defaults, so no CLI flag can raise them.
const FREE_QTY = 1;
const FREE_VALUE_WEI = 0n;

const ABI = [
  'function mint(uint256 count) payable',
  'function freeMintsLeft() view returns (uint256)',
  'function mintsPerWallet(address) view returns (uint256)',
  'function nextTokenId() view returns (uint256)',
  'function mintStart() view returns (uint256)',
  'function publicSupply() view returns (uint256)',
  'function revealed() view returns (bool)',
  'function currentWindow() view returns (uint256)',
  'function name() view returns (string)',
  'event Minted(address indexed to, uint256[] tokenIds, uint256[] coordIds)',
];

let ethers;
function loadEthers() {
  if (ethers) return ethers;
  try {
    ethers = require('ethers');
  } catch {
    throw new Error('ethers required. Install: npm install ethers');
  }
  return ethers;
}

// ─── Helpers ─────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtEth(wei) {
  return loadEthers().formatEther(wei);
}

/** ms until the next FREE_WINDOW boundary, using chain time as the reference. */
function msToNextWindow(chainNowMs) {
  const w = CONFIG.FREE_WINDOW * 1000;
  return w - (chainNowMs % w);
}

function isFreeSlotTaken(err) {
  const m = `${err?.shortMessage || ''} ${err?.message || ''} ${err?.info?.error?.message || ''}`;
  return /Free slots full/i.test(m);
}

function revertReason(err) {
  return err?.shortMessage || err?.info?.error?.message || err?.message || String(err);
}

// ─── Chain reads ─────────────────────────────────────────────────

async function readState(contract, provider, address) {
  const [name, mintStart, nextTokenId, publicSupply, freeLeft, revealed, block] = await Promise.all([
    contract.name(),
    contract.mintStart(),
    contract.nextTokenId(),
    contract.publicSupply(),
    contract.freeMintsLeft(),
    contract.revealed(),
    provider.getBlock('latest'),
  ]);
  const state = {
    name,
    mintStart: Number(mintStart),
    minted: Number(nextTokenId) - 1,
    publicSupply: Number(publicSupply),
    freeLeft: Number(freeLeft),
    revealed,
    chainTime: Number(block.timestamp),
    blockNumber: block.number,
    baseFee: block.baseFeePerGas ?? 0n,
  };
  if (address) {
    state.mintedByWallet = Number(await contract.mintsPerWallet(address));
    state.balance = await provider.getBalance(address);
  }
  return state;
}

function printState(s) {
  const open = s.mintStart > 0;
  console.log(`    Collection:  ${s.name}`);
  console.log(`    Mint open:   ${open ? `yes (since ${new Date(s.mintStart * 1000).toISOString()})` : 'NOT OPEN'}`);
  console.log(`    Minted:      ${s.minted} / ${CONFIG.MAX_SUPPLY}  (public left: ${s.publicSupply})`);
  console.log(`    Revealed:    ${s.revealed ? 'yes — minting is CLOSED' : 'no'}`);
  console.log(`    Free slot:   ${s.freeLeft > 0 ? 'OPEN' : 'taken this window'}`);
  console.log(`    Base fee:    ${loadEthers().formatUnits(s.baseFee, 'gwei')} gwei  (block ${s.blockNumber})`);
  if (s.mintedByWallet !== undefined) {
    console.log(`    Wallet mint: ${s.mintedByWallet} / ${CONFIG.WALLET_LIMIT}`);
    console.log(`    Balance:     ${fmtEth(s.balance)} ETH`);
  }
}

// ─── Preflight ───────────────────────────────────────────────────

function assertMintable(state, { count }) {
  if (state.mintStart === 0) throw new Error('Mint is not open yet');
  if (state.revealed) throw new Error('Mint is closed (reveal already happened)');
  if (state.publicSupply === 0) throw new Error('Sold out');

  const room = CONFIG.WALLET_LIMIT - (state.mintedByWallet ?? 0);
  if (room <= 0) throw new Error(`Wallet already at lifetime limit (${CONFIG.WALLET_LIMIT})`);
  if (count > room) {
    console.log(`  ⚠️  Chasing ${count} wins but wallet has room for ${room}. Will stop at the cap.`);
  }
  // Gas is the only cost in this build, but a wallet at zero cannot pay it.
  if (state.balance !== undefined && state.balance === 0n) {
    throw new Error('Wallet balance is 0 — free mints still need gas');
  }
}

// ─── Tx building ─────────────────────────────────────────────────

async function buildTx(contract, provider, signer, { gasLimitOverride, feeBumpPct }) {
  const data = contract.interface.encodeFunctionData('mint', [BigInt(FREE_QTY)]);

  // value is the constant 0n. A non-zero value would put the contract on its
  // paid branch and charge 0.002 ETH, which this build must never do.
  const tx = { to: CONFIG.CONTRACT, data, value: FREE_VALUE_WEI, chainId: CONFIG.CHAIN_ID };

  if (gasLimitOverride) {
    tx.gasLimit = BigInt(gasLimitOverride);
  } else {
    try {
      const est = await provider.estimateGas({ from: signer.address, ...tx });
      tx.gasLimit = (est * 150n) / 100n;
    } catch {
      // A busy free window reverts estimation. That is expected, not fatal.
      tx.gasLimit = BigInt(120000 + 60000 * FREE_QTY);
    }
  }

  const fee = await provider.getFeeData();
  const bump = BigInt(100 + (feeBumpPct ?? 25));
  if (fee.maxFeePerGas) {
    tx.maxFeePerGas = (fee.maxFeePerGas * bump) / 100n;
    tx.maxPriorityFeePerGas = fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas > 0n
      ? (fee.maxPriorityFeePerGas * bump) / 100n
      : 1000000n; // 0.001 gwei floor so the tx is never zero-tip
  } else if (fee.gasPrice) {
    tx.gasPrice = (fee.gasPrice * bump) / 100n;
  }
  return tx;
}

function tokenIdsFromReceipt(contract, receipt) {
  const ids = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== CONFIG.CONTRACT.toLowerCase()) continue;
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === 'Minted') {
        for (const id of parsed.args.tokenIds) ids.push(Number(id));
      }
    } catch { /* not our event */ }
  }
  return ids;
}

// ─── Wallet file ─────────────────────────────────────────────────

/**
 * Read private keys from a text file: one key per line. Blank lines and lines
 * starting with # are ignored, and an inline `# label` after a key is stripped
 * so the file can be annotated.
 */
function loadWalletsFromFile(path, provider) {
  const fs = require('node:fs');
  const e = loadEthers();
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read wallet file ${path}: ${err.code || err.message}`);
  }

  const wallets = [];
  const seen = new Set();
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    line = line.split('#')[0].trim();           // strip inline comment
    line = line.split(/[\s,]+/)[0].trim();      // tolerate "key label" / CSV
    if (!line) continue;
    const key = line.startsWith('0x') ? line : `0x${line}`;

    let wallet;
    try {
      wallet = new e.Wallet(key, provider);
    } catch {
      // Never echo the key itself, only where the bad line was.
      throw new Error(`invalid private key on line ${i + 1} of ${path}`);
    }
    const lower = wallet.address.toLowerCase();
    if (seen.has(lower)) {
      console.log(`  ⚠️  line ${i + 1}: duplicate wallet ${wallet.address}, skipped`);
      continue;
    }
    seen.add(lower);
    wallets.push(wallet);
  }

  if (!wallets.length) throw new Error(`no usable private keys found in ${path}`);
  return wallets;
}

// ─── Free lane ───────────────────────────────────────────────────

/**
 * Build and sign a tx without sending it. Signing ahead of the window is what
 * makes a simultaneous hit possible: at fire time there is no key derivation,
 * no gas estimation and no RPC round-trip left to do, only the raw broadcast.
 */
async function presign(ctx, wallet, nonce) {
  const { contract, provider } = ctx;
  const tx = await buildTx(contract, provider, wallet, ctx.opts);

  // Last line of defence: refuse to sign anything that carries value.
  if (tx.value !== 0n) throw new Error('refusing to sign a non-zero value tx (free lane only)');

  tx.nonce = nonce;
  const raw = await wallet.signTransaction(tx);
  return { wallet, raw, tx };
}

/**
 * Broadcast an already-signed tx and resolve its outcome.
 *
 * The raw tx goes to every RPC at once rather than to one. It is the same
 * signed bytes with the same hash, so the extra copies are harmless dedupe
 * work for the mempool, but on a 5s first-come-first-served window the fastest
 * endpoint decides the race, and one slow endpoint no longer stalls the round.
 */
async function fire(ctx, signed) {
  const { contract, provider, broadcasters } = ctx;
  const short = `${signed.wallet.address.slice(0, 6)}..${signed.wallet.address.slice(-4)}`;

  const fleet = broadcasters && broadcasters.length ? broadcasters : [provider];
  const sent = await Promise.any(fleet.map((p) => p.broadcastTransaction(signed.raw)))
    .catch((err) => {
      // Promise.any only rejects once every endpoint failed; surface a real
      // reason ("Free slots full this block") instead of "All promises rejected".
      const first = err && err.errors && err.errors[0];
      throw first || err;
    });
  console.log(`  📤 ${short}  ${CONFIG.EXPLORER}/tx/${sent.hash}`);

  if (globalThis.noWait) return { hash: sent.hash, ids: [], address: signed.wallet.address };

  const receipt = await provider.waitForTransaction(sent.hash, 1, 120_000);
  if (!receipt) throw new Error(`Timed out waiting for ${sent.hash}`);
  if (receipt.status === 0) throw new Error(`REVERTED: ${CONFIG.EXPLORER}/tx/${sent.hash}`);

  const ids = tokenIdsFromReceipt(contract, receipt);
  console.log(`  ✅ ${short} minted ${ids.length || FREE_QTY}${ids.length ? ` → #${ids.join(', #')}` : ''}`);
  return { hash: sent.hash, ids, address: signed.wallet.address };
}

/**
 * Every wallet hits the same window together. The slot is first-come-first-served
 * and global, so staggering wallets would just hand the slot to someone else:
 * all of them are signed in advance, then broadcast with no spacing at all.
 */
async function runFreeLane(ctx, { count, maxAttempts, burst }) {
  const { contract, provider, wallets } = ctx;
  const stats = new Map(wallets.map((w) => [w.address, { won: 0, lost: 0, attempts: 0 }]));
  const nonces = new Map();
  const winners = [];

  // No -n / no --max-attempts means run until the mint itself closes: sold out,
  // revealed, or every wallet at its on-chain lifetime cap.
  const countTarget = count ?? Infinity;
  const attemptCap = maxAttempts ?? Infinity;
  let stopReason = '';

  // One nonce read per wallet up front, then tracked locally. Reading it inside
  // the window would cost an RPC round-trip at the worst possible moment.
  await Promise.all(wallets.map(async (w) => {
    nonces.set(w.address, await provider.getTransactionCount(w.address, 'pending'));
  }));

  let active = [...wallets];
  let totalWon = 0;
  let totalAttempts = 0;
  let totalLost = 0;
  let round = 0;

  while (totalWon < countTarget && totalAttempts < attemptCap && active.length) {
    round++;

    // Sign everything for this round BEFORE aligning to the boundary, so the
    // wait happens with the work already done.
    const batch = [];
    for (const wallet of active) {
      for (let shot = 0; shot < burst; shot++) {
        if (totalAttempts + batch.length >= attemptCap) break;
        const nonce = nonces.get(wallet.address) + shot;
        try {
          batch.push(await presign(ctx, wallet, nonce));
        } catch (err) {
          console.log(`  ⚠️  presign failed for ${wallet.address}: ${revertReason(err)}`);
        }
      }
    }
    if (!batch.length) break;

    const block = await provider.getBlock('latest');
    const wait = msToNextWindow(Number(block.timestamp) * 1000 + 250);
    if (wait > 60) {
      if (globalThis.verbose) console.log(`  ⏱  round ${round}: ${batch.length} tx armed, waiting ${wait}ms for the window`);
      await sleep(wait);
    }

    // No sleep, no spacing: fire the whole batch at once.
    console.log(`  🚀 round ${round}: firing ${batch.length} tx from ${active.length} wallet(s) simultaneously`);
    const results = await Promise.all(batch.map((signed) =>
      fire(ctx, signed)
        .then((r) => ({ ok: true, r, signed }))
        .catch((err) => ({ ok: false, err, signed })),
    ));

    for (const res of results) {
      const addr = res.signed.wallet.address;
      const s = stats.get(addr);
      s.attempts++;
      totalAttempts++;
      if (res.ok) {
        s.won++;
        totalWon++;
        winners.push({ address: addr, hash: res.r.hash, ids: res.r.ids });
        // Only a mined tx consumes the nonce.
        nonces.set(addr, nonces.get(addr) + 1);
      } else if (isFreeSlotTaken(res.err)) {
        s.lost++;
        totalLost++;
        if (globalThis.verbose) console.log(`  ❌ ${addr.slice(0, 8)} lost the race`);
      } else {
        console.log(`  ⚠️  ${addr.slice(0, 8)}: ${revertReason(res.err)}`);
        // An unknown failure may or may not have consumed the nonce, so resync
        // that wallet rather than guessing and stranding every later tx.
        nonces.set(addr, await provider.getTransactionCount(addr, 'pending'));
      }
    }

    console.log(`  📊 round ${round}: won ${totalWon}/${countTarget === Infinity ? '∞' : countTarget} · attempts ${totalAttempts}/${attemptCap === Infinity ? '∞' : attemptCap} · lost ${totalLost}`);

    if (totalWon >= countTarget) { stopReason = 'target reached'; break; }

    const state = await readState(contract, provider);
    if (state.revealed || state.publicSupply === 0) {
      stopReason = state.revealed ? 'reveal (mint closed)' : 'sold out';
      console.log(`  🛑 mint no longer open (${stopReason})`);
      break;
    }

    // Drop wallets that hit the on-chain lifetime cap; keep the rest racing.
    const stillActive = [];
    for (const wallet of active) {
      const minted = Number(await contract.mintsPerWallet(wallet.address));
      if (minted >= CONFIG.WALLET_LIMIT) {
        console.log(`  🛑 ${wallet.address} reached the ${CONFIG.WALLET_LIMIT} lifetime cap`);
      } else {
        stillActive.push(wallet);
      }
    }
    active = stillActive;
    if (!active.length) {
      stopReason = 'every wallet at lifetime cap';
      console.log('  🛑 every wallet is at its lifetime cap');
      break;
    }
  }
  if (!stopReason && totalAttempts >= attemptCap) stopReason = 'attempt cap reached';
  if (!stopReason && !active.length) stopReason = 'every wallet at lifetime cap';

  return { won: totalWon, attempts: totalAttempts, lost: totalLost, stats, winners, stopReason };
}

// ─── CLI ─────────────────────────────────────────────────────────

function parseArgs() {
  const args = { count: null, burst: 3, maxAttempts: null, feeBumpPct: 25 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '-k': case '--key': args.key = argv[++i]; break;
      case '--wallets': case '--wallet-file': args.walletFile = argv[++i]; break;
      case '-n': case '--count': args.count = Math.max(1, parseInt(argv[++i]) || 1); break;
      case '--burst': args.burst = Math.max(1, parseInt(argv[++i]) || 1); break;
      case '--max-attempts': args.maxAttempts = Math.max(1, parseInt(argv[++i]) || 1); break;
      case '--fee-bump': args.feeBumpPct = parseInt(argv[++i]) || 0; break;
      case '--gas-limit': args.gasLimitOverride = argv[++i]; break;
      // An explicit --rpc means "use this one", so it replaces the whole fleet
      // rather than quietly leaving the defaults broadcasting alongside it.
      case '--rpc': CONFIG.DEFAULT_RPC = argv[++i]; CONFIG.BROADCAST_RPCS = [CONFIG.DEFAULT_RPC]; break;
      case '--status': args.status = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--no-wait': globalThis.noWait = true; break;
      case '-v': case '--verbose': globalThis.verbose = true; break;
      case '-h': case '--help': showHelp(); process.exit(0);
      // Retired paid-lane flags. Fail loudly instead of silently ignoring them,
      // so an old command line never looks like it worked.
      case '--paid': case '-q': case '--qty':
        console.error(`❌ ${argv[i]} is gone: this build is free-lane only and never sends ETH.`);
        process.exit(1);
      case '--free': break; // accepted as a no-op; free is the only lane
      default:
        if (argv[i].startsWith('-')) { console.error(`Unknown flag: ${argv[i]}`); process.exit(1); }
    }
  }
  return args;
}

function showHelp() {
  console.log(`
 🏚️  RENTOIDS FREE MINTER

 Free lane only. This build never sends ETH — msg.value is always 0.
 Your only cost is gas.

 Usage:
   node minter.cjs --status
   node minter.cjs --dry-run
   node minter.cjs                 # run until sold out / reveal / wallet cap
   node minter.cjs -n 50           # stop after 50 total wins

 Options:
   -n, --count <n>     Stop after n total wins (default: unlimited — stop on
                       sold out, reveal, or every wallet at its 50 cap)
       --wallets <f>   Wallet key file (default wallet.txt)
       --burst <n>     Txs fired per wallet per 5s window (default 3)
       --max-attempts  Total tx cap across all wallets (default: unlimited)
       --fee-bump <%>  Bump gas price above the node estimate (default 25)
       --gas-limit <n> Force a gas limit, skip estimation
       --rpc <url>     Override RPC
       --status        Print mint state and exit (no key needed)
       --dry-run       Preflight only, sends nothing
       --no-wait       Do not wait for confirmations
   -v, --verbose       Verbose output

 Notes:
   One global free slot per ${CONFIG.FREE_WINDOW}s window, first-come-first-served.
   Losing most races is the contract working as designed, not a bug.
   Lifetime cap is ${CONFIG.WALLET_LIMIT} per wallet, enforced on-chain.
`);
}

async function main() {
  const args = parseArgs();
  const e = loadEthers();
  const key = args.key || process.env.RENTOIDS_PRIVATE_KEY || process.env.ETH_PRIVATE_KEY;
  const walletFile = args.walletFile || 'wallet.txt';

  const provider = new e.JsonRpcProvider(CONFIG.DEFAULT_RPC, {
    chainId: CONFIG.CHAIN_ID,
    name: CONFIG.CHAIN_NAME,
  });
  const contract = new e.Contract(CONFIG.CONTRACT, ABI, provider);

  // Status mode needs no key.
  if (args.status) {
    console.log(`\n 🏚️  RENTOIDS · STATUS\n`);
    let addr;
    if (key) { try { addr = new e.Wallet(key).address; } catch { /* ignore bad key in status */ } }
    printState(await readState(contract, provider, addr));
    console.log('');
    return;
  }

  let wallets = null;
  if (!args.dryRun) wallets = loadWalletsFromFile(walletFile, provider);

  console.log(`\n 🏚️  RENTOIDS · FREE MINTER`);
  console.log(`    Wallets:  ${wallets ? wallets.length + ' from ' + walletFile : '(dry run)'}`);
  console.log(`    Lane:     FREE (0 ETH, gas only)`);
  if (args.count) console.log(`    Target:   ${args.count} win(s)`);
  else console.log(`    Target:   unlimited — stop on sold out / reveal / wallet cap`);
  console.log(`    Burst:    ${args.burst} tx per wallet per window`);
  console.log(`    Mode:     ${args.dryRun ? '🔍 DRY' : '🚀 LIVE'}\n`);

  // Global mint state, plus per-wallet cap/balance only for the live wallets.
  const state = await readState(contract, provider, wallets?.[0]?.address);
  printState(state);
  if (wallets) {
    const capped = [];
    for (const w of wallets) {
      const minted = Number(await contract.mintsPerWallet(w.address));
      if (minted >= CONFIG.WALLET_LIMIT) capped.push(w.address);
      const bal = await provider.getBalance(w.address);
      if (bal === 0n) console.log(`  ⚠️  ${w.address} has 0 balance — free mints still need gas`);
    }
    if (capped.length) {
      console.log(`  🛑 ${capped.length}/${wallets.length} wallet(s) already at the ${CONFIG.WALLET_LIMIT} lifetime cap.`);
      wallets = wallets.filter((w) => !capped.includes(w.address));
    }
  }
  console.log('');

  if (!wallets) {
    console.log('  🔍 Dry run OK. Mint cost is 0 ETH (+ gas).');
    console.log('  🔍 Expect most attempts to lose the 5s slot race.');
    console.log('');
    return;
  }
  if (!wallets.length) {
    console.error('❌ no usable wallet left to mint with\n');
    process.exit(1);
  }

  // One provider per endpoint, built once. Creating these inside the window
  // would add a connection setup to the critical path.
  const broadcasters = CONFIG.BROADCAST_RPCS.map((url) =>
    url === CONFIG.DEFAULT_RPC
      ? provider
      : new e.JsonRpcProvider(url, { chainId: CONFIG.CHAIN_ID, name: CONFIG.CHAIN_NAME }),
  );

  const ctx = { contract, provider, broadcasters, wallets, opts: { gasLimitOverride: args.gasLimitOverride, feeBumpPct: args.feeBumpPct } };
  const started = Date.now();

  const { won, attempts, lost, stats, winners, stopReason } = await runFreeLane(ctx, {
    count: args.count,
    maxAttempts: args.maxAttempts,
    burst: args.burst,
  });

  console.log(`\n  🎯 Free lane done: ${won} won · ${attempts} attempts · ${lost} lost races · ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (stopReason) console.log(`  ⏹  Stopped: ${stopReason}`);
  console.log('');

  if (winners.length) {
    console.log('  🏆 WINNERS');
    for (const w of winners) {
      console.log(`    ${w.address}  #${w.ids.join(', #')}  ${CONFIG.EXPLORER}/tx/${w.hash}`);
    }
    console.log('');
  }
  if (stats.size > 1) {
    console.log('  📋 Per-wallet');
    for (const [addr, s] of stats) {
      if (s.attempts) console.log(`    ${addr.slice(0, 10)}..  won ${s.won} · lost ${s.lost} · attempts ${s.attempts}`);
    }
    console.log('');
  }

  const after = await readState(contract, provider);
  printState(after);
  console.log('');
}

main().catch((err) => {
  console.error(`\n❌ ${revertReason(err)}\n`);
  process.exit(1);
});
