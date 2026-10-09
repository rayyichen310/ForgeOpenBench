# Windows Hantek scope

This checkout adds a native Windows WinUSB capture path for the Hantek 6022BL.
The USB bridge uses PyUSB and the project-local `libusb-package` DLL. The existing
Linux Rust capture path is unchanged. The main backend can start on Windows;
its POSIX terminal remains unavailable.

## Start and stop

Use the existing project `.venv`, frontend dependencies, and built `frontend/dist`.
The launcher does not install dependencies or modify system settings.

```powershell
./scripts/windows-services.ps1 start
./scripts/windows-services.ps1 status
./scripts/windows-services.ps1 stop
```

Open http://127.0.0.1:5173/ and select WaveForge → Scope. The launcher binds
all services to loopback, records process ownership in ignored `logs/`, and
refuses to take over occupied ports. Pass `-NodePath` if Node is not on PATH or
in the local Codex runtime. Stop sends the hardware stop command before exiting.

Install USB bridge requirements in the project venv when preparing a new machine:
`python -m pip install -r server/usb-bridge/requirements.txt`.
The device must use a WinUSB driver, including its firmware-renumerated identity.
Only one application may own the USB device. Do not run sigrok or the vendor app
while the bridge is connected.

## CLI controlling the visible Scope view

```powershell
$python = '.\.venv\Scripts\python.exe'
& $python server/usb-bridge/scope_cli.py status
& $python server/usb-bridge/scope_cli.py set --params '{"sampleRate":1000000,"ch1Vertical":{"probe":10,"vDiv":0.5},"horizontal":{"sDiv":0.0002},"trigger":{"level":1.2}}'
& $python server/usb-bridge/scope_cli.py run
& $python server/usb-bridge/scope_cli.py single
& $python server/usb-bridge/scope_cli.py csv --output new-trace.csv
& $python server/usb-bridge/scope_cli.py png --output new-trace.png
& $python server/usb-bridge/scope_cli.py stop
```

Other actions: `autoset`, `force`, `clear`, `reference`. The view must be open.
`set` acknowledges a validated React state patch; hardware reconfiguration is
asynchronous. Inspect status and the bridge log after changing hardware ranges
or sample rate. Output files are created exclusively and never overwritten.
CSV/PNG commands return acquisition settings alongside their file metadata.
The underlying WebSocket API uses `scope_control`, `action`, `params`, and `req_id`;
the bridge returns `scope_result` or `usb_error`. Errors are not simulated success.

## Acquisition and interpretation

- Set the software probe factor to match the physical switch. Hardware ranges are
  selected independently per channel before applying the probe factor.
- Trigger, AC coupling, invert, rejection filters, averaging, and bandwidth limit
  are software operations. The 20 MHz low-pass does not provide an analog
  anti-alias filter. External/AC-line triggers are unavailable on this hardware.
- Windows live display uses acknowledged frames. Packets may be discarded when
  the view is busy; sequence gaps reset the sample buffer. It is a segmented live
  preview, not a continuous lossless recording. Use sigrok `.sr` for recording.
- The live view retains at most 200,000 points and displays at most 200 ms in
  the main plot. Long timebase settings are constrained by those existing limits.
  CSV exports the plotted trace (including display decimation), not every USB byte.
- Voltages use nominal upstream ADC scaling; no EEPROM calibration is written.
  CAL capture demonstrates operation, not instrument accuracy or probe compensation.

## Validation

```powershell
./.venv/Scripts/python.exe -m unittest discover -s server/usb-bridge -p test_windows_scope.py -v
cd frontend
npm test -- --maxWorkers=1 --minWorkers=1
npm run build
```

Regression tests cover stop RPC completion, trigger phase alignment, peak-detect
timestamps, trigger-aligned averaging, single capture state, CSV columns, signal
processing, scope patches, WinUSB frame layout, and control routing. Mock tests
do not substitute for real hardware tests. Other Forge plugins are outside this
Windows scope repair and require their own device/platform validation.
