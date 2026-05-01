const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const bs58 = require("bs58");

const RPC_ENDPOINT   = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
const TOKEN_MINT     = process.env.TOKEN_MINT;
const FEE_WALLET_KEY = process.env.FEE_WALLET_KEY;
const MIN_HOLD       = BigInt("1000000000000"); // 1,000,000 tokens (6 decimals)
const AIRDROP_PCT    = parseFloat(process.env.AIRDROP_PCT || "0.50");
const INTERVAL_MS    = parseInt(process.env.INTERVAL_MS || "120000");
const RESERVE_SOL    = parseFloat(process.env.RESERVE_SOL || "0.01");

// Add your liquidity pool wallet here after launch
const EXCLUDED_WALLETS = new Set([
  // "YourPoolWalletAddressHere",
]);

if (!TOKEN_MINT || !FEE_WALLET_KEY) {
  console.error("❌  Missing TOKEN_MINT or FEE_WALLET_KEY");
  process.exit(1);
}

const connection = new Connection(RPC_ENDPOINT, "confirmed");
const feeWallet  = Keypair.fromSecretKey(bs58.decode(FEE_WALLET_KEY));

let stats = {
  totalRounds: 0,
  totalSolDistributed: 0,
  totalWalletsAirdropped: 0,
  lastRound: null,
  history: [],
};

module.exports = { getStats: () => stats };

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getEligibleHolders() {
  const mintPubkey = new PublicKey(TOKEN_MINT);
  console.log(`Fetching largest accounts for mint: ${TOKEN_MINT}`);

  let attempts = 0;
  let accounts = null;

  while (attempts < 5) {
    try {
      accounts = await connection.getTokenLargestAccounts(mintPubkey, "confirmed");
      break;
    } catch (e) {
      attempts++;
      console.log(`Attempt ${attempts} failed: ${e.message} — retrying in 3s`);
      await sleep(3000);
    }
  }

  if (!accounts || !accounts.value.length) {
    console.log("⚠️  No token accounts returned from RPC");
    return [];
  }

  console.log(`Top accounts returned: ${accounts.value.length}`);

  const holders = [];
  for (const account of accounts.value) {
    try {
      if (BigInt(account.amount) >= MIN_HOLD) {
        await sleep(300);
        const info = await connection.getParsedAccountInfo(account.address);
        const owner = info.value?.data?.parsed?.info?.owner;
        if (owner && !EXCLUDED_WALLETS.has(owner)) {
          holders.push({
            wallet: owner,
            amount: BigInt(account.amount),
          });
          console.log(`  ✅ Eligible: ${owner.slice(0,8)}... holding ${account.uiAmountString}`);
        } else if (owner && EXCLUDED_WALLETS.has(owner)) {
          console.log(`  ⛔ Excluded: ${owner.slice(0,8)}...`);
        }
      }
    } catch (e) {
      console.error("Error fetching account info:", e.message);
    }
  }

  console.log(`Found ${holders.length} eligible holders`);
  return holders;
}

async function getAirdropPool() {
  const balance   = await connection.getBalance(feeWallet.publicKey);
  const reserve   = Math.floor(RESERVE_SOL * LAMPORTS_PER_SOL);
  const available = balance - reserve;
  if (available <= 0) return 0;
  return Math.floor(available * AIRDROP_PCT);
}

function calcShares(holders, poolLamports) {
  const filtered = holders.filter(h => !EXCLUDED_WALLETS.has(h.wallet));
  const totalTokens = filtered.reduce((sum, h) => sum + h.amount, BigInt(0));
  return filtered.map((h) => ({
    wallet: h.wallet,
    amount: h.amount,
    lamports: Math.floor(Number((BigInt(poolLamports) * h.amount) / totalTokens)),
  })).filter((h) => h.lamports > 5000);
}

async function runRound() {
  console.log(`\n[${new Date().toISOString()}] ── Starting airdrop round ──`);
  try {
    const [holders, poolLamports] = await Promise.all([
      getEligibleHolders(),
      getAirdropPool(),
    ]);

    if (poolLamports < 10000) {
      console.log("⚠️  Pool too small — waiting for more fees");
      return;
    }

    if (holders.length === 0) {
      console.log("⚠️  No eligible holders yet");
      return;
    }

    const shares = calcShares(holders, poolLamports);
    console.log(`✅  ${holders.length} eligible | Pool: ${(poolLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL | Sending to ${shares.length}`);

    const BATCH = 10;
    let sentLamports = 0;
    const roundDrops = [];

    for (let i = 0; i < shares.length; i += BATCH) {
      const batch = shares.slice(i, i + BATCH);
      const tx = new Transaction();
      for (const { wallet, lamports } of batch) {
        tx.add(SystemProgram.transfer({
          fromPubkey: feeWallet.publicKey,
          toPubkey:   new PublicKey(wallet),
          lamports,
        }));
      }
      try {
        const sig = await sendAndConfirmTransaction(connection, tx, [feeWallet]);
        for (const s of batch) {
          sentLamports += s.lamports;
          roundDrops.push({
            wallet: s.wallet,
            tokens: s.amount.toString(),
            sol: (s.lamports / LAMPORTS_PER_SOL).toFixed(6),
            sig,
            ts: new Date().toISOString(),
          });
          console.log(`  → ${s.wallet.slice(0,8)}...${s.wallet.slice(-4)}  +${(s.lamports/LAMPORTS_PER_SOL).toFixed(6)} SOL`);
        }
      } catch (err) {
        console.error(`  ❌ Batch failed:`, err.message);
      }
      if (i + BATCH < shares.length) await sleep(1500);
    }

    stats.totalRounds++;
    stats.totalSolDistributed += sentLamports / LAMPORTS_PER_SOL;
    stats.totalWalletsAirdropped += roundDrops.length;
    stats.lastRound = {
      ts: new Date().toISOString(),
      wallets: roundDrops.length,
      solDistributed: (sentLamports / LAMPORTS_PER_SOL).toFixed(6),
    };
    stats.history = [...roundDrops, ...stats.history].slice(0, 50);
    console.log(`✅  Round complete — ${(sentLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL to ${roundDrops.length} wallets`);

  } catch (err) {
    console.error("❌  Round error:", err.message);
  }
}

console.log("🚀  $PAID Airdrop Engine started");
console.log(`   Wallet : ${feeWallet.publicKey.toBase58()}`);
console.log(`   Token  : ${TOKEN_MINT}`);
console.log(`   Min    : 1,000,000 tokens`);

runRound();
setInterval(runRound, INTERVAL_MS);
