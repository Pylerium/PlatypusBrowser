#!/usr/bin/python3
"""Launch Chromium as the desktop user, retaining Chromium's normal sandbox."""
import json
import os
import pathlib
import time

state = pathlib.Path("/run/platypus/workspace.json")
while not state.exists():
    time.sleep(2)
value = json.loads(state.read_text())
hardware = value["hardware"]
os.environ.update({
    "ADIOS_WORKSPACE_ID": value["workspaceId"], "ADIOS_PROFILE_ID": value["profileId"],
    "ADIOS_SYSTEM_UUID": hardware["systemUuid"], "ADIOS_MACHINE_GUID": hardware["machineGuid"],
    "ADIOS_BOARD_SERIAL": hardware["smbios"]["serialNumber"],
    "ADIOS_STORAGE_JSON": json.dumps(hardware["storage"]), "ADIOS_NETWORK_JSON": json.dumps(hardware["network"]),
})
arguments = ["/usr/bin/chromium", "--no-first-run", "--no-default-browser-check", "--start-maximized",
    "--user-data-dir=/home/workspace/.config/chromium"]
if value["browser"].get("runtime") is not None:
    arguments.append("--load-extension=/opt/platypus/runtime-extension")
arguments.append(value["browser"]["startUrl"])
os.execv(arguments[0], arguments)
