# Browser base image

The repository includes a Debian 13 image builder and a guest startup adapter. From the PlatypusBrowser directory, with Python 3 and QEMU installed, run:

```powershell
npm run guest:setup
```

This creates an isolated Python environment for ISO generation, downloads the official Debian generic image over HTTPS, verifies its published SHA-512 checksum, and provisions Chromium plus a minimal Openbox/LightDM desktop inside QEMU. The builder uses the host hardware accelerator and signed Debian package repositories. It does not install a desktop or change hardware/registry settings on the Windows host.

The resulting standalone image is `vm-images/debian-13-browser-v1.qcow2`, with a 16 GiB virtual capacity. Only allocated/compressed content occupies host disk space. Source checksum and final SHA-256 metadata are recorded beside the image. Image binaries, caches, and build tools are excluded from Git.

After verification, setup creates Electron's `userData/qemu.json` (on Windows, `%APPDATA%/platypus-browser/qemu.json`). `PLATYPUS_QEMU_CONFIG` can override the location. The generated configuration uses the installed Windows QEMU paths, WHPX, two CPUs, 2 GiB RAM, GTK display, and outbound user-mode NAT so browser pages can load. Existing configuration for a different image is preserved. Set `QEMU_TEST_BINARY` and `QEMU_TEST_IMG` for installations elsewhere.

## Guest behavior

Each workspace starts from its own persistent overlay. Before Linux starts its system services, an initramfs hook applies the Adios machine GUID as the Linux machine ID. A root startup service validates the fw_cfg manifest and firmware UUID, sets the disk GPT GUID to the Adios disk ID, and prepares a read-only runtime extension when navigator/canvas simulation is enabled. Filesystem and partition UUIDs used by the bootloader are retained; the virtual device serial and exported descriptors carry the Adios volume serial.

LightDM automatically starts the unprivileged `workspace` desktop account. Chromium opens the profile's starting URL, retains its normal sandbox, and saves browser data inside that workspace's private disk overlay. The QA extension reuses the same runtime implementation as the Electron local browser and runs at document start in the main world. With simulation disabled, Chromium launches without the extension. There is no default remote-login password, and SSH is disabled in the base.

## Verification and maintenance

`npm run guest:verify` boots a throwaway workspace overlay and checks the machine ID, firmware association, unprivileged Chromium process, requested start URL, outbound HTTPS, and navigator values reported by an actual browser page. It saves `vm-images/build/verification/desktop.png` and a JSON result. Verification uses a temporary loopback guest-agent endpoint. Production uses its own single-connection guest-agent transport for the fixed telemetry deployment action, with no arbitrary guest-command IPC. The test shuts down and purges its workspace afterward.

The production controller deploys the latest schema-driven runtime into the guest
overlay at launch, so the published base image need not be replaced to update the
QA layer. Applying saved telemetry restarts only the managed Chromium browser;
other extensions are disabled in that browser to avoid competing overrides.
See [telemetry coverage and network boundaries](TELEMETRY.md).

Use `npm run guest:verify -- --display` to run these checks with the visible GTK desktop instead of a headless display. Both modes use the dedicated QMP socket transport used by the production controller.

`npm run guest:build` builds the base from downloaded assets; `npm run test:guest` checks manifest validation. `npm run guest:setup` performs the full sequence. Build logs are under `vm-images/build`. The upstream download is cached with its verified checksum, allowing consistent retries.

Do not replace a base image once real overlays depend on it. To publish an updated OS/browser base, create a new versioned image and configure it for new workspaces, or explicitly purge affected old workspaces. The image builder refuses to overwrite an existing published base.
