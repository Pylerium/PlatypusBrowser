"""Build a NoCloud seed ISO using a task-local pycdlib installation."""
import pathlib
import sys
import pycdlib

directory = pathlib.Path(sys.argv[1]).resolve()
iso = pycdlib.PyCdlib()
iso.new(interchange_level=3, joliet=3, rock_ridge="1.09", vol_ident="CIDATA")
for index, name in enumerate(("user-data", "meta-data", "network-config")):
    source = directory / name
    if source.exists():
        iso.add_file(str(source), iso_path=f"/FILE{index}.;1", rr_name=name, joliet_path="/" + name)
iso.write(str(directory / "seed.iso"))
iso.close()
