#!/usr/bin/env python3
"""Standalone entry script for the LLM Wiki Python backend.

This script is the **Tauri sidecar entry point** -- Tauri v2 Shell spawns this
process via the Sidecar mechanism. It can also be launched manually for
development and debugging::

    uv run python run_server.py --port 19828 --log-level debug

Default values match ``app/config.py`` (127.0.0.1:19828).
"""

import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(
        description="LLM Wiki Python Backend Server"
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Bind address (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=19828,
        help="Listen port (default: 19828)",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        choices=["debug", "info", "warning", "error", "critical"],
        help="Logging verbosity (default: info)",
    )
    args = parser.parse_args()

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        log_level=args.log_level,
        reload=False,
    )


if __name__ == "__main__":
    main()
