"""Write a bounded analog Scope snapshot as a sigrok v2 session."""
import base64
import io
import json
import math
import struct
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path


CAPTURE_DIR = Path(__file__).resolve().parents[3] / 'captures'
MAX_SAMPLES = 200_000


def build_sr(snapshot):
    if not isinstance(snapshot, dict):
        raise ValueError('Invalid Scope snapshot')
    count = snapshot.get('samples')
    rate = snapshot.get('sampleRate')
    if type(count) is not int or not 0 < count <= MAX_SAMPLES:
        raise ValueError('Scope snapshot must contain 1 to 200000 samples per channel')
    if type(rate) is not int or not 0 < rate <= 48_000_000:
        raise ValueError('Invalid snapshot sample rate')
    settings = snapshot.get('settings')
    if not isinstance(settings, dict) or settings.get('sampleRate') != rate:
        raise ValueError('Snapshot settings must match the sample rate')
    channels = snapshot.get('channels')
    if (not isinstance(channels, list) or any(not isinstance(ch, dict) for ch in channels)
            or [ch.get('name') for ch in channels] != ['CH1', 'CH2']):
        raise ValueError('Snapshot must contain CH1 and CH2 in order')
    raw_channels = []
    for channel in channels:
        if not isinstance(channel.get('data'), str):
            raise ValueError('Channel samples must be base64-encoded float32 data')
        raw = base64.b64decode(channel['data'], validate=True)
        if len(raw) != count * 4:
            raise ValueError('Channel length does not match snapshot sample count')
        if any(not math.isfinite(value[0]) for value in struct.iter_unpack('<f', raw)):
            raise ValueError('Channel contains non-finite voltage samples')
        raw_channels.append(raw)
    summary = {key: snapshot[key] for key in ('samples', 'sampleRate', 'capturedAt', 'settings')}
    summary['channels'] = ['CH1', 'CH2']
    if 'hardwareRangesVpp' in snapshot:
        summary['hardwareRangesVpp'] = snapshot['hardwareRangesVpp']
    summary['encoding'] = 'float32-le volts; before software processing'
    if snapshot.get('zeroCorrectionAppliedToSamples', False) is not False:
        raise ValueError('SR samples must remain uncorrected by zero calibration')
    summary['zeroCorrectionAppliedToSamples'] = False
    if 'zeroCalibration' in snapshot:
        zero = snapshot['zeroCalibration']
        if not isinstance(zero, dict) or set(zero) != {'ch1', 'ch2'}:
            raise ValueError('Invalid zero calibration channels')
        for profile in zero.values():
            if profile is not None and (not isinstance(profile, dict) or
                    type(profile.get('offsetVolts')) not in (int, float) or not math.isfinite(profile['offsetVolts']) or
                    profile.get('sampleRate') != rate or profile.get('hardwareRangeVpp') not in (1, 2, 5, 10) or
                    profile.get('probe') not in (1, 10, 100) or type(profile.get('samples')) is not int or
                    not 100 <= profile['samples'] <= MAX_SAMPLES or not isinstance(profile.get('capturedAt'), str)):
                raise ValueError('Invalid zero calibration provenance')
        summary['zeroCalibration'] = zero
    metadata = (f'[global]\nsigrok version=ForgeOpenBench\n\n[device 1]\n'
                f'samplerate={rate} Hz\ntotal analog=2\nanalog1=CH1\nanalog2=CH2\n')
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as session:
        session.writestr('version', '2')
        session.writestr('metadata', metadata)
        for index, raw in enumerate(raw_channels, 1):
            session.writestr(f'analog-1-{index}-1', raw)
        # Sigrok ignores extra entries; preserve probe/range provenance for agents.
        session.writestr('scope-settings.json', json.dumps(summary, allow_nan=False))
    return output.getvalue(), summary


def save_sr(snapshot):
    payload, summary = build_sr(snapshot)
    CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    path = CAPTURE_DIR / f'scope-{stamp}-{uuid.uuid4().hex[:8]}.sr'
    with path.open('xb') as output:
        output.write(payload)
    return {'path': str(path), 'bytes': len(payload), **summary}
