import json
import tempfile
import unittest
from pathlib import Path

import zero_store

PROFILE = {'offsetVolts': 0.2446, 'hardwareRangeVpp': 1, 'probe': 10, 'sampleRate': 1_000_000,
           'capturedAt': '2026-10-10T04:00:00Z', 'samples': 4002}
DEVICE = 'Hantek 6022BL (Scope)'


class ZeroStoreTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name) / 'calibration' / 'zero-profiles.json'

    def tearDown(self):
        self.folder.cleanup()

    def test_missing_file_is_an_empty_store(self):
        self.assertEqual(zero_store.load(DEVICE, self.path), [])

    def test_save_replaces_only_the_same_condition(self):
        zero_store.save(DEVICE, 'ch1', PROFILE, self.path)
        zero_store.save(DEVICE, 'ch2', {**PROFILE, 'offsetVolts': 0.21}, self.path)
        zero_store.save(DEVICE, 'ch1', {**PROFILE, 'sampleRate': 12_000_000, 'offsetVolts': 0.2575}, self.path)
        profiles = zero_store.save(DEVICE, 'ch1', {**PROFILE, 'offsetVolts': 0.25}, self.path)
        offsets = {(p['channel'], p['sampleRate']): p['offsetVolts'] for p in profiles}
        self.assertEqual(offsets, {('ch1', 1_000_000): 0.25, ('ch2', 1_000_000): 0.21, ('ch1', 12_000_000): 0.2575})
        self.assertEqual(zero_store.load(DEVICE, self.path), profiles)

    def test_profiles_are_kept_per_device(self):
        zero_store.save(DEVICE, 'ch1', PROFILE, self.path)
        zero_store.save('Hantek 6022BE', 'ch1', {**PROFILE, 'offsetVolts': 0.1}, self.path)
        self.assertEqual([p['offsetVolts'] for p in zero_store.load(DEVICE, self.path)], [0.2446])

    def test_delete_removes_only_the_matching_condition(self):
        zero_store.save(DEVICE, 'ch1', PROFILE, self.path)
        zero_store.save(DEVICE, 'ch1', {**PROFILE, 'probe': 1}, self.path)
        left = zero_store.delete(DEVICE, 'ch1', {'hardwareRangeVpp': 1, 'probe': 10, 'sampleRate': 1_000_000}, self.path)
        self.assertEqual([p['probe'] for p in left], [1])
        self.assertEqual(zero_store.delete(DEVICE, 'ch2', {'hardwareRangeVpp': 1, 'probe': 10, 'sampleRate': 1_000_000}, self.path), left)

    def test_rejects_invalid_profiles_without_writing(self):
        for channel, change in [('ch3', {}), ('ch1', {'offsetVolts': float('nan')}), ('ch1', {'hardwareRangeVpp': 3}),
                                ('ch1', {'probe': 2}), ('ch1', {'sampleRate': 1.5}), ('ch1', {'samples': 10}),
                                ('ch1', {'capturedAt': ''})]:
            with self.subTest(channel=channel, change=change), self.assertRaises(ValueError):
                zero_store.save(DEVICE, channel, {**PROFILE, **change}, self.path)
        with self.assertRaises(ValueError):
            zero_store.save('', 'ch1', PROFILE, self.path)
        self.assertFalse(self.path.exists())

    def test_corrupt_file_raises_instead_of_resetting(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({'profiles': 'nope'}), encoding='utf-8')
        with self.assertRaises(ValueError):
            zero_store.save(DEVICE, 'ch1', PROFILE, self.path)
        self.assertEqual(json.loads(self.path.read_text(encoding='utf-8')), {'profiles': 'nope'})


if __name__ == '__main__':
    unittest.main()
