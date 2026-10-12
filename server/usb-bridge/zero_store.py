"""Persist GND zero profiles per device, channel, hardware range, probe and sample rate.

The file lives outside the repository so every browser profile sees the same
calibration. A corrupt file raises instead of being replaced, so a lost
calibration is never mistaken for an uncalibrated scope.
"""
import json
import math
import os
from pathlib import Path

STORE = Path(__file__).resolve().parents[3] / 'calibration' / 'zero-profiles.json'
CONDITION = ('channel', 'hardwareRangeVpp', 'probe', 'sampleRate')
MAX_SAMPLES = 200_000


def _device(device):
    if not isinstance(device, str) or not device.strip():
        raise ValueError('Zero profiles need a device name')
    return device


def _condition(channel, condition):
    if channel not in ('ch1', 'ch2'):
        raise ValueError('Zero profile channel must be ch1 or ch2')
    if not isinstance(condition, dict):
        raise ValueError('Invalid zero profile condition')
    if condition.get('hardwareRangeVpp') not in (1, 2, 5, 10) or condition.get('probe') not in (1, 10, 100):
        raise ValueError('Invalid zero profile range or probe')
    rate = condition.get('sampleRate')
    if type(rate) is not int or not 0 < rate <= 48_000_000:
        raise ValueError('Invalid zero profile sample rate')
    return {'channel': channel, 'hardwareRangeVpp': condition['hardwareRangeVpp'],
            'probe': condition['probe'], 'sampleRate': rate}


def _profile(channel, profile):
    entry = _condition(channel, profile)
    offset = profile.get('offsetVolts')
    if type(offset) not in (int, float) or not math.isfinite(offset):
        raise ValueError('Invalid zero offset')
    samples = profile.get('samples')
    if type(samples) is not int or not 100 <= samples <= MAX_SAMPLES:
        raise ValueError('Invalid zero profile sample count')
    if not isinstance(profile.get('capturedAt'), str) or not profile['capturedAt']:
        raise ValueError('Zero profile needs capturedAt')
    return {**entry, 'offsetVolts': float(offset), 'capturedAt': profile['capturedAt'], 'samples': samples}


def _read(path):
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('profiles'), list):
        raise ValueError(f'Unrecognised zero profile file: {path}')
    return data['profiles']


def _write(path, profiles):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps({'version': 1, 'profiles': profiles}, indent=2), encoding='utf-8')
    os.replace(temp, path)


def _same(entry, device, condition):
    return entry['device'] == device and all(entry[key] == condition[key] for key in CONDITION)


def load(device, path=STORE):
    device = _device(device)
    return [entry for entry in _read(path) if entry['device'] == device]


def save(device, channel, profile, path=STORE):
    """Store the profile, replacing any earlier one for the same condition."""
    device = _device(device)
    entry = {'device': device, **_profile(channel, profile)}
    profiles = [old for old in _read(path) if not _same(old, device, entry)] + [entry]
    _write(path, profiles)
    return load(device, path)


def delete(device, channel, condition, path=STORE):
    device = _device(device)
    target = _condition(channel, condition)
    profiles = _read(path)
    kept = [entry for entry in profiles if not _same(entry, device, target)]
    if len(kept) != len(profiles):
        _write(path, kept)
    return load(device, path)
