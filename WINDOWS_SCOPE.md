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

Run `./.venv/Scripts/python.exe server/usb-bridge/scope_cli.py --help` for the
actions supported by this checkout. JSON patch examples are below; accepted
values are validated in `frontend/src/plugins/waveforge/scopeSettings.ts`.
The CLI sends commands to the open Scope over the loopback bridge rather than
opening the USB device independently. Check `status` after configuration changes.

```powershell
$python = '.\.venv\Scripts\python.exe'
& $python server/usb-bridge/scope_cli.py status
& $python server/usb-bridge/scope_cli.py run
& $python server/usb-bridge/scope_cli.py single
& $python server/usb-bridge/scope_cli.py sr --output new-trace.sr
& $python server/usb-bridge/scope_cli.py csv --output new-trace.csv
& $python server/usb-bridge/scope_cli.py png --output new-trace.png
& $python server/usb-bridge/scope_cli.py stop
```

Other actions: `autoset`, `force`, `clear`, `reference`, `zero`, `zero-reset`. The view must be open.
AutoSet selects Auto trigger and resumes acquisition to inspect fresh samples
when stopped or single-held. Preset names are entered directly in the toolbar;
the embedded browser does not need to support native JavaScript prompt dialogs.
Preset Export opens editable JSON; Import JSON accepts pasted settings and validates
the complete state before loading it. File download/import remain optional browser
paths. Use the CLI for reliable SR/CSV/PNG files in the local capture directory.
`set` acknowledges a validated React state patch; hardware reconfiguration is
asynchronous. Inspect status and the bridge log after changing hardware ranges
or sample rate. Output files are created exclusively and never overwritten.
CSV/PNG commands return acquisition settings alongside their file metadata.
The underlying WebSocket API uses `scope_control`, `action`, `params`, and `req_id`;
the bridge returns `scope_result` or `usb_error`. Errors are not simulated success.

### CAL check settings

Only with the CH1 tip on CAL, ground clip on GND, and physical probe at 10X:

```powershell
& $python server/usb-bridge/scope_cli.py set --params '{"sampleRate":1000000,"ch1Vertical":{"probe":10,"vDiv":0.5},"horizontal":{"sDiv":0.0002},"trigger":{"level":1.2,"mode":"auto"}}'
```

Expect approximately 1 kHz with this test connection. Choose settings appropriate
to the actual signal for other measurements.

## Per-channel GND zero calibration

Connect the selected probe tip and ground clip to the same physical GND, using
the probe factor, hardware range and sample rate intended for the measurement.
Use DC coupling, Run to acquire fresh GND samples, then Stop. Software GND
coupling only draws a zero line and cannot supply calibration data.

In the right-hand **Zero calibration** panel, check **GND connection confirmed**
and click **Zero CH1** or **Zero CH2**. The equivalent CLI commands are:

```powershell
& $python server/usb-bridge/scope_cli.py zero --params '{"channel":"ch1","groundConfirmed":true}'
& $python server/usb-bridge/scope_cli.py status
& $python server/usb-bridge/scope_cli.py zero-reset --params '{"channel":"ch1"}'
```

Use `ch2` for the other channel. The mean of the retained raw GND samples becomes
that channel's offset in volts at the probe tip. Zero and Reset immediately
reprocess the stopped trace and measurements without acquiring more samples;
repeating Zero does not subtract the previous correction twice. Commands reject
running acquisition, missing/short captures, non-DC captures, changed capture
conditions and missing ground confirmation. Ground confirmation is a statement
about the actual wiring; the software cannot verify it electrically.

`status.zeroCalibration` lists each baseline and its capture provenance;
`status.zeroActive` indicates whether current conditions match. A baseline applies
only to its channel, hardware range, probe factor and sample rate. Changing any
of these suspends it; returning to matching conditions reactivates it. Position
changes, or V/div changes that leave the hardware range unchanged, retain it.
Closing/reloading Scope or reconnecting clears calibration; it is not saved in
presets. After reconnecting, a fresh capture is required even if an old trace remains.

DC samples are corrected before inversion, bandwidth filtering, measurements,
trigger comparison and Math. CSV and PNG export the displayed result. AC coupling
still removes the mean once. Reset restores nominal DC values. This software
offset correction does not calibrate gain, compensate a probe, improve bandwidth
or write instrument EEPROM. Hardware calibration has not been performed merely
because the offline tests pass.

## Single-segment SR export

Use `sr --output <new-file.sr>` while running or after Stop/Single-held. It saves
the latest retained, contiguous CH1/CH2 samples, including a hidden channel, before
display decimation and software zero correction, AC/GND coupling, inversion, filters, averaging,
Math, or FFT. The exported interval can be longer than the trigger-cropped plot.
Clear or a new Run discards the previous snapshot; a new Run needs fresh samples.
Rate/range/probe changes and dropped frames separate segments. Changing settings
after stopping does not reinterpret the retained capture.

The native sigrok v2 archive stores float32 voltage samples. An extra
`scope-settings.json` entry stores sample count, sample rate, probe factors,
nominal hardware ranges, captured display settings, and `zeroCalibration` profiles
matching the retained capture and current conditions (or null per channel).
`zeroCorrectionAppliedToSamples` is always false: analog entries remain nominal,
uncorrected voltages. To reconstruct corrected DC values, subtract that channel's
recorded `offsetVolts` once. Sigrok ignores the extra JSON entry and reads the
uncorrected samples. `capturedAt` is the
browser receipt time of the latest packet in UTC, not the first sample's hardware
timestamp. SR command results return this provenance alongside the output path.
Stopped `status.samples` describes the cleared live buffer, not the SR snapshot.

The toolbar **SR** button uses the same snapshot and writer. The bridge creates a
unique file under `../captures/` and shows its full path below the toolbar; no
browser download permission is needed. Both paths reject empty captures and
never overwrite files. No sigrok process or additional USB owner is used to save.

Read an existing file without releasing USB:

```powershell
& D:/Hantek/sigrok/sigrok-cli.exe -i new-trace.sr --show
```

Direct hardware capture with sigrok remains a separate operation requiring the
bridge to release USB. Saving a snapshot does not provide continuous recording.

## SR replay

**Open SR** (or `load-sr --input <file.sr>`) shows a Scope SR as a held, stopped
capture with its stored settings; acquisition stops first and USB is not used.
Only files with `scope-settings.json` (written by this Scope) are accepted.
The CLI may add `window` (`startS`/`endS` seconds from the first sample, and
`timeZeroS` shown as 0 on the time axis), `zero` (per-channel `offsetVolts`
bound to the file's range, probe and rate) and a `display` settings patch:

```powershell
& $python server/usb-bridge/scope_cli.py load-sr --input new-trace.sr --params '{"window":{"startS":0.004,"endS":0.0049,"timeZeroS":0.0042},"zero":{"ch1":0.2575}}'
& $python server/usb-bridge/scope_cli.py view --params '{"x":[-0.0002,0.0006],"y":[-0.5,4.5]}'
```

`view` sets the plot range as wheel zoom/pan would; `png` accepts the same `x`/`y`
plus `width`/`height` and returns the plot area (`bbox`) and scales. Readouts are
computed from the loaded window, so frequency values of a short window are not
signal measurements.

## Acquisition and interpretation

- Set the software probe factor to match the physical switch. Hardware ranges are
  selected independently per channel before applying the probe factor.
- Trigger, AC coupling, invert, rejection filters, averaging, and bandwidth limit
  are software operations. The 20 MHz low-pass does not provide an analog
  anti-alias filter. External/AC-line triggers are unavailable on this hardware.
- Windows live display uses acknowledged frames. Packets may be discarded when
  the view is busy; sequence gaps reset the sample buffer. It is a segmented live
  preview, not a continuous lossless recording. SR export saves a retained segment
  without filling gaps between discarded packets.
- The live view retains at most 200,000 points and displays at most 200 ms in
  the main plot. Long timebase settings are constrained by those existing limits.
  CSV exports the plotted trace (including display decimation), not every USB byte.
- Raw voltages use nominal upstream ADC scaling; optional session GND zero
  correction applies to the display. No gain or EEPROM calibration is written.
  CAL capture demonstrates operation, not instrument accuracy or probe compensation.

## Validation

```powershell
./.venv/Scripts/python.exe -m unittest discover -s server/usb-bridge -p 'test_*scope*.py' -v
cd frontend
npm test -- --maxWorkers=1 --minWorkers=1
npm run build
```

Regression tests cover stop RPC completion, trigger phase alignment, peak-detect
timestamps, trigger-aligned averaging, single capture state, CSV columns, signal
processing, scope patches, zero/reset and matching conditions, corrected Single
trigger thresholds, unchanged SR samples and calibration provenance,
XY paths with reversing X, AutoSet after stopping,
preset saving, WinUSB frame layout, and control routing. Mock tests
do not substitute for real hardware tests. Other Forge plugins are outside this
Windows scope repair and require their own device/platform validation.
