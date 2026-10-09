#!/usr/bin/env python3
"""Portable credential helper for the Nines watcher.

On the original Hatch box, credentials were injected by authd via
surrogate query params / request headers. This module provides the same
function signatures but reads from environment variables, so the watcher
runs on any machine:

  HELIUS_API_KEY  -> used for "custom.helius"
  GITHUB_TOKEN    -> used for "custom.github" (only needed by publish.py)

No secrets are ever printed or logged by this module.
"""
import json
import os


def _helius_key():
    key = os.environ.get("HELIUS_API_KEY", "").strip()
    if not key:
        raise RuntimeError("HELIUS_API_KEY is not set")
    return key


def _github_token():
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token:
        raise RuntimeError("GITHUB_TOKEN is not set")
    return token


def url_with_surrogate_query_param(url, credential_name,
                                   allowed_hosts=None, entry_name=None):
    """Return the URL with the credential attached as a query param.

    Compatible with the Hatch dynamic_credentials signature.
    """
    if credential_name == "custom.helius":
        sep = "&" if "?" in url else "?"
        return f"{url}{sep}api-key={_helius_key()}"
    raise RuntimeError(f"Unknown credential: {credential_name}")


def add_surrogate_to_request(req, credential_name,
                             entry_name=None, allowed_hosts=None):
    """Attach the credential to a urllib Request as an Authorization header.

    Compatible with the Hatch dynamic_credentials signature.
    """
    if credential_name == "custom.github":
        req.add_header("Authorization", f"Bearer {_github_token()}")
        return req
    raise RuntimeError(f"Unknown credential: {credential_name}")


def read_json_response(resp):
    """Read a urllib response and parse it as JSON."""
    return json.loads(resp.read().decode("utf-8"))
