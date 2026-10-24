#!/usr/bin/python3
"""Consume the host's fw_cfg manifest before the unprivileged desktop starts."""
import json
import os
import pathlib
import re
import subprocess
import urllib.parse

MANIFEST = pathlib.Path("/sys/firmware/qemu_fw_cfg/by_name/opt/org.platypus/workspace/raw")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

def validate(value):
    if not isinstance(value, dict) or value.get("format") != "platypus-workspace" or value.get("version") != 1:
        raise ValueError("Unsupported workspace manifest")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", value.get("workspaceId", "")):
        raise ValueError("Invalid workspace ID")
    if not UUID.fullmatch(value.get("profileId", "")):
        raise ValueError("Invalid hardware profile ID")
    hardware = value.get("hardware", {})
    for field in ("systemUuid", "machineGuid"):
        if not UUID.fullmatch(hardware.get(field, "")):
            raise ValueError("Invalid machine identity")
    browser = value.get("browser", {})
    url = browser.get("startUrl", "")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or len(url) > 2048:
        raise ValueError("Invalid browser URL")
    runtime = browser.get("runtime")
    if runtime is not None:
        if (not isinstance(runtime, dict) or type(runtime.get("hardwareConcurrency")) is not int
            or not 1 <= runtime["hardwareConcurrency"] <= 256
            or runtime.get("deviceMemory") not in (0.25, 0.5, 1, 2, 4, 8)
            or not isinstance(runtime.get("platform"), str) or not 1 <= len(runtime["platform"]) <= 64
            or any(ord(c) < 32 or ord(c) == 127 for c in runtime["platform"])
            or (runtime.get("canvasSeed") is not None and
                (type(runtime["canvasSeed"]) is not int or not 0 <= runtime["canvasSeed"] <= 4294967295))):
            raise ValueError("Invalid navigator simulation")
    return value

def main():
    if not MANIFEST.exists():
        print("No workspace manifest: image provisioning mode", flush=True)
        return
    encoded = MANIFEST.read_bytes()
    if len(encoded) > 65536:
        raise ValueError("Oversized workspace manifest")
    value = validate(json.loads(encoded))
    hardware = value["hardware"]
    actual_uuid = pathlib.Path("/sys/class/dmi/id/product_uuid").read_text().strip().lower()
    if actual_uuid != hardware["systemUuid"]:
        raise ValueError("Firmware identity does not match this workspace")
    if pathlib.Path("/etc/machine-id").read_text().strip() != hardware["machineGuid"].replace("-", ""):
        raise ValueError("Linux machine ID does not match this workspace")
    state = pathlib.Path("/run/platypus")
    state.mkdir(mode=0o755, exist_ok=True)
    (state / "workspace.json").write_text(json.dumps(value))
    os.chmod(state / "workspace.json", 0o644)
    # This image has GPT virtio disks. Change only the disk GUID; never modify a
    # mounted filesystem's UUID or partition GUIDs used by the bootloader/fstab.
    for index, disk in enumerate(hardware.get("storage", [])):
        if not UUID.fullmatch(disk.get("diskId", "")):
            raise ValueError("Invalid disk ID")
        device = "/dev/vd" + chr(ord("a") + index)
        serial = pathlib.Path("/sys/block/" + pathlib.Path(device).name + "/serial")
        if not serial.exists() or serial.read_text().strip() != disk["volumeSerial"]:
            raise ValueError("Disk serial does not match the workspace")
        subprocess.run(["sgdisk", "--disk-guid=" + disk["diskId"], device], check=True)
    extension = pathlib.Path("/opt/platypus/runtime-extension")
    extension.mkdir(parents=True, exist_ok=True)
    runtime = value["browser"].get("runtime")
    if runtime is not None:
        (extension / "manifest.json").write_text(json.dumps({"manifest_version": 3, "name": "Platypus QA device simulation", "version": "1.0.0",
            "content_scripts": [{"matches": ["<all_urls>"], "js": ["runtime.js"], "run_at": "document_start", "world": "MAIN"}]}))
        source = pathlib.Path("/usr/local/share/platypus/runtime.iife.js").read_text()
        (extension / "runtime.js").write_text(source + "\nPlatypusRuntime.applyRuntimeSimulation(PlatypusRuntime.validateRuntime(" + json.dumps(runtime) + "));\n")
    subprocess.run(["hostname", "workspace-" + value["workspaceId"][:8]], check=True)
    print("PLATYPUS_GUEST_READY " + value["workspaceId"], flush=True)

if __name__ == "__main__":
    main()
