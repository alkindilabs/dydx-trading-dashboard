"""Static file server for the Playwright specs.

Serves the repository root on the port given as the only argument.
`python3 -m http.server` listens with a backlog of 5, so the parallel
workers' page loads overflow it and connections get reset; this server
keeps the same handler with a deeper accept queue.

Usage: python3 test/static-server.py PORT
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LOOPBACK = "127.0.0.1"
REQUEST_QUEUE_SIZE = 128


class StaticServer(ThreadingHTTPServer):
    request_queue_size = REQUEST_QUEUE_SIZE


def main():
    port = int(sys.argv[1])
    handler = partial(SimpleHTTPRequestHandler, directory=str(REPO_ROOT))
    with StaticServer((LOOPBACK, port), handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
