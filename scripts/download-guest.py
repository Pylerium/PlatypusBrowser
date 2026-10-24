"""Fetch an official Debian base, verifying its published SHA-512 over HTTPS."""
import hashlib
import json
import pathlib
import time
import urllib.request

root = pathlib.Path(__file__).resolve().parents[1] / "vm-images" / "build"
root.mkdir(parents=True, exist_ok=True)
origin = "https://cloud.debian.org/images/cloud/trixie/latest/"
name = "debian-13-generic-amd64.qcow2"
target = root / name
provenance = root / "source.json"
if target.exists() and provenance.exists():
    expected = json.loads(provenance.read_text())["sha512"]
else:
    manifest = urllib.request.urlopen(origin + "SHA512SUMS", timeout=60).read()
    (root / "SHA512SUMS").write_bytes(manifest)
    expected = next(line.split()[0] for line in manifest.decode().splitlines() if line.split()[-1].lstrip("*") == name)
if not target.exists():
    temporary = target.with_suffix(".download")
    with urllib.request.urlopen(origin + name, timeout=120) as response, temporary.open("wb") as output:
        size = int(response.headers.get("Content-Length", 0))
        count = 0
        last = 0.0
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            count += len(chunk)
            if time.monotonic() - last > 10:
                print(f"Debian base download: {count // 1048576} MiB / {size // 1048576} MiB", flush=True)
                last = time.monotonic()
    temporary.replace(target)
with target.open("rb") as downloaded:
    actual = hashlib.file_digest(downloaded, "sha512").hexdigest()
if actual != expected:
    raise RuntimeError("Debian image checksum mismatch; image was not provisioned.")
(root / "source.json").write_text(json.dumps({"url": origin + name, "sha512": actual}, indent=2) + "\n")
print(f"Verified official Debian image: {target}", flush=True)
