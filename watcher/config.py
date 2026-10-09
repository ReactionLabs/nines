"""Shared config for the trading bot: thresholds, launchpads, paths."""
import os

BASE = os.path.dirname(os.path.abspath(__file__))

# The Nines: thresholds (checks 8-9 TBD by Dip)
# Two tiers (set 2026-10-07): day-one (fresh) vs second-day (survived day one)
DAY1_MC_MIN_USD = 20_000
DAY1_MC_MAX_USD = 100_000
DAY2_MC_MIN_USD = 90_000
DAY2_MC_MAX_USD = 450_000
# Back-compat defaults (day-one tier)
MC_MIN_USD = DAY1_MC_MIN_USD
MC_MAX_USD = DAY1_MC_MAX_USD
LIQ_MIN_USD = 10_000  # provisional, Dip verifying his Axiom filter

WHITELIST_FILE = os.path.join(BASE, "wallets", "whitelist.txt")
BLACKLIST_FILE = os.path.join(BASE, "wallets", "blacklist.txt")
ALERTS_LOG = os.path.join(BASE, "alerts.log")

# Nine launchpads the filter stack watches (refine with Dip)
LAUNCHPADS = [
    "pump.fun",
    "bags.fm",
    "moonshot",
    "pumpfun-amm",
    "raydium",
    "meteora",
    "orca",
    "heaven",
    "boop",
]

JUP_PRICE_URL = "https://api.jup.ag/price/v3"

# pump.fun program for the bonding-curve liquidity read (check 5)
PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
SOL_MINT = "So11111111111111111111111111111111111111112"


def load_wallets(path):
    try:
        with open(path) as f:
            return [l.strip() for l in f if l.strip() and not l.startswith("#")]
    except FileNotFoundError:
        return []
