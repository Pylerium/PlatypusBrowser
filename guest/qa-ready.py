#!/usr/bin/python3
"""Unprivileged, readiness-only Chrome native messaging host. No commands."""
import json
import os
import pathlib
import re
import struct
import sys

if len(sys.argv) < 2 or sys.argv[1] != "chrome-extension://pmfendbmmlpmplggbadknjflhppgbhdi/":
    raise SystemExit("Unexpected extension origin")
header = sys.stdin.buffer.read(4)
if len(header) != 4:
    raise SystemExit("Missing message length")
length = struct.unpack("=I", header)[0]
if not 0 < length <= 4096:
    raise SystemExit("Oversized readiness message")
message = json.loads(sys.stdin.buffer.read(length))
nonce = message.get("nonce", "")
if not isinstance(nonce, str) or not re.fullmatch(r"[0-9a-f]{32}", nonce):
    raise SystemExit("Invalid readiness nonce")
if message.get("action") == "cookies":
    offset = message.get("offset")
    if type(offset) is not int or not 0 <= offset <= 3000:
        raise SystemExit("Invalid cookie batch offset")
    state = json.loads(pathlib.Path("/run/platypus-session-import.json").read_text())
    if state.get("nonce") != nonce:
        raise SystemExit("Stale cookie import")
    cookies = state["cookies"]
    response = json.dumps({"cookies": cookies[offset:offset + 50], "done": offset + 50 >= len(cookies)}).encode()
    sys.stdout.buffer.write(struct.pack("=I", len(response)) + response)
    sys.stdout.buffer.flush()
    raise SystemExit(0)
if message.get("action") is not None:
    raise SystemExit("Unsupported readiness action")

directory = pathlib.Path("/home/workspace/.cache/platypus-qa")
directory.mkdir(parents=True, exist_ok=True)
path = directory / "ready"
handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
with os.fdopen(handle, "w") as file:
    file.write(nonce)
response = json.dumps({"ready": True}).encode()
sys.stdout.buffer.write(struct.pack("=I", len(response)) + response)
sys.stdout.buffer.flush()
