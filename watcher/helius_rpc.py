#!/usr/bin/env python3
"""Portable Helius Solana mainnet JSON-RPC client.

Usage:
  helius_rpc.py <method> [params-json]

The API key comes from the HELIUS_API_KEY environment variable.
Drop-in replacement for the Hatch skill version: same rpc(method, params)
signature, so checks.py and scanner.py work unchanged.
"""
import json
import os
import sys
import urllib.request

from dynamic_credentials import url_with_surrogate_query_param, read_json_response

HOSTS = ["mainnet.helius-rpc.com"]
RPC_URL = "https://mainnet.helius-rpc.com/"


def rpc(method, params):
    url = url_with_surrogate_query_param(
        RPC_URL, "custom.helius", allowed_hosts=HOSTS
    )
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    ).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "curl/8.5.0"},
    )
    resp = urllib.request.urlopen(req, timeout=40)
    return read_json_response(resp)


def main():
    if len(sys.argv) < 2:
        print("usage: helius_rpc.py <method> [params-json]", file=sys.stderr)
        sys.exit(2)
    method = sys.argv[1]
    params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else []
    print(json.dumps(rpc(method, params)))


if __name__ == "__main__":
    main()
