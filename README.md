# Pump Fun Airdrop Worker

Railway worker for a SOL rent-claim / PUMP buy / holder snapshot / airdrop loop.

Every `INTERVAL_MINUTES`:

1. Calls `claimRentIfNeeded()`.
2. Checks the worker wallet SOL balance.
3. Leaves `SOL_RESERVE` in the wallet. Default: `0.2 SOL`.
4. Swaps only the excess SOL into `PUMP_TOKEN_MINT` through Jupiter.
5. Snapshots current holders of `SNAPSHOT_TOKEN_MINT`.
6. Marks wallets ineligible if their snapshot balance decreases.
7. Optionally airdrops `AIRDROP_TOKEN_MINT` to eligible wallets.

It defaults to `DRY_RUN=true` and logs planned actions without signing/sending.

## Important Limitations

`claimRentIfNeeded()` is a placeholder until the exact rent-claim instruction/API is provided:

```ts
async function claimRentIfNeeded(): Promise<string | null> {
  // TODO: plug in the actual rent-claim instruction/API here.
  return null;
}
```

The "sold = ineligible" rule is implemented conservatively by comparing snapshots. If a wallet's token balance decreases, it is marked ineligible. That catches sells, but it also treats transfers out as ineligible. For perfect sell detection, plug in an indexer such as Helius/Birdeye/Bitquery with swap-level classification.

## Env Vars

```env
RPC_URL=
WORKER_PRIVATE_KEY_BASE58=
PUMP_TOKEN_MINT=
JUPITER_API_KEY=

JUPITER_API_URL=https://api.jup.ag/swap/v2
SOL_RESERVE=0.2
MIN_SWAP_SOL=0.01
MAX_SWAP_SOL_PER_RUN=10
SLIPPAGE_BPS=300
INTERVAL_MINUTES=5
DRY_RUN=true

STATE_FILE_PATH=./data/state.json
SNAPSHOT_TOKEN_MINT=
MIN_HOLDER_TOKEN_UI=0
EXCLUDED_WALLETS=

AIRDROP_ENABLED=false
AIRDROP_TOKEN_MINT=
AIRDROP_AMOUNT_UI=0
MAX_AIRDROPS_PER_RUN=50

PUBLIC_API_ENABLED=true
PORT=3000
CORS_ORIGIN=*
```

Notes:

- `SNAPSHOT_TOKEN_MINT` defaults to `PUMP_TOKEN_MINT`.
- `AIRDROP_TOKEN_MINT` defaults to `PUMP_TOKEN_MINT`.
- `WORKER_PRIVATE_KEY_BASE58` signs swaps and airdrops. Keep it only in Railway env vars.
- Use a Railway volume and set `STATE_FILE_PATH=/data/state.json` if you want state to survive redeploys.
- If this serves a Vercel frontend, set `CORS_ORIGIN=https://your-site.vercel.app` after testing.

## Vercel Data Hookup

The worker exposes a read-only JSON API when `PUBLIC_API_ENABLED=true`:

```txt
GET /health
GET /state
GET /airdrop-data
```

In Railway:

1. Deploy this worker.
2. Make sure it has a public Railway domain.
3. Open `https://your-railway-url.up.railway.app/airdrop-data`.
4. Put that URL into Vercel as:

```env
NEXT_PUBLIC_AIRDROP_API_URL=https://your-railway-url.up.railway.app/airdrop-data
```

Frontend fetch example:

```ts
const res = await fetch(process.env.NEXT_PUBLIC_AIRDROP_API_URL!, {
  next: { revalidate: 30 }
});
const data = await res.json();
```

## Railway Setup

1. Create a Railway service from this repo.
2. Set the env vars above.
3. Keep `DRY_RUN=true` first.
4. Start command:

```bash
pnpm start
```

5. Watch logs for:
   - rent claim placeholder
   - SOL balance and reserve
   - planned Jupiter swap
   - holder snapshot count
   - ineligible wallets
   - airdrop dry-run previews

6. Once logs look right, set:

```env
DRY_RUN=false
```

## Local Development

```bash
pnpm install
pnpm dev
```

Build:

```bash
pnpm build
```
