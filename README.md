# Pump Fun Airdrop Worker

Railway worker for a SOL-to-PUMP buy / holder snapshot / PUMP airdrop loop.

Every `INTERVAL_MINUTES`:

1. Checks the worker wallet SOL balance.
2. Leaves `SOL_RESERVE` in the wallet. Default: `0.2 SOL`.
3. Swaps only the excess SOL into `PUMP_TOKEN_MINT` through Jupiter Lite.
4. Snapshots current holders of `SNAPSHOT_TOKEN_MINT`.
5. Requires holders to meet `MIN_HOLDER_TOKEN_UI`.
6. Excludes holders at or above `MAX_HOLDER_PERCENT` of supply.
7. Marks wallets ineligible if their snapshot balance decreases.
8. Optionally airdrops `AIRDROP_TOKEN_MINT` to eligible wallets.

It defaults to `DRY_RUN=true` and logs planned actions without signing/sending.

## Current Behavior

- No rent-claim logic is included.
- `PUMP_TOKEN_MINT` is the token bought with SOL.
- `SNAPSHOT_TOKEN_MINT` is the token holders must hold to qualify.
- `AIRDROP_TOKEN_MINT` is the token sent to holders.
- `AIRDROP_AMOUNT_UI=0` means proportional mode: distribute the worker wallet's full available `AIRDROP_TOKEN_MINT` balance across eligible holders each snapshot.
- `AIRDROP_AMOUNT_UI>0` means fixed mode: send that fixed amount to each eligible holder, capped by `MAX_AIRDROPS_PER_RUN`.

The "sold = ineligible" rule is implemented by comparing snapshots. If a wallet's token balance decreases, it is marked ineligible. That catches sells, but it also treats transfers out as ineligible. Put known seller wallets or team wallets in `EXCLUDED_WALLETS` before launch.

## Env Vars

```env
RPC_URL=
WORKER_PRIVATE_KEY_BASE58=
PUMP_TOKEN_MINT=

JUPITER_API_URL=https://lite-api.jup.ag/swap/v1
SOL_RESERVE=0.2
MIN_SWAP_SOL=0.01
MAX_SWAP_SOL_PER_RUN=10
SLIPPAGE_BPS=300
INTERVAL_MINUTES=5
DRY_RUN=true

STATE_FILE_PATH=./data/state.json
SNAPSHOT_TOKEN_MINT=
MIN_HOLDER_TOKEN_UI=500000
MAX_HOLDER_PERCENT=4
EXCLUDED_WALLETS=

AIRDROP_ENABLED=false
AIRDROP_TOKEN_MINT=
AIRDROP_AMOUNT_UI=0
MAX_AIRDROPS_PER_RUN=50

PUBLIC_API_ENABLED=true
PORT=3000
CORS_ORIGIN=*
```

Launch notes:

- `PUMP_TOKEN_MINT`: PUMP CA.
- `AIRDROP_TOKEN_MINT`: PUMP CA if holders receive PUMP.
- `SNAPSHOT_TOKEN_MINT`: your `$AIRDROP` token CA.
- `MIN_HOLDER_TOKEN_UI=500000` means holders need at least 500K `$AIRDROP`.
- `MAX_HOLDER_PERCENT=4` excludes wallets holding 4% or more of supply.
- `EXCLUDED_WALLETS` is comma-separated: `wallet1,wallet2,wallet3`.
- `WORKER_PRIVATE_KEY_BASE58` signs swaps and airdrops. Keep it only in Railway env vars.
- `JUPITER_API_URL` uses Jupiter's no-key Lite endpoint by default. No Jupiter API key is required.
- Use a Railway volume and set `STATE_FILE_PATH=/data/state.json` if you want state to survive redeploys.
- Keep `DRY_RUN=true` first. Switch to `DRY_RUN=false` only after logs look correct.
- Set `AIRDROP_ENABLED=true` only when you want airdrops to actually run. With `DRY_RUN=true`, it only logs previews.

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
   - SOL balance and reserve
   - planned Jupiter swap
   - holder snapshot count
   - large-holder exclusions
   - ineligible wallets
   - airdrop dry-run previews or skipped reason

6. Once logs look right, set:

```env
DRY_RUN=false
```

For live proportional PUMP airdrops, use:

```env
AIRDROP_ENABLED=true
AIRDROP_AMOUNT_UI=0
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
