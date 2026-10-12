import asyncio
import base64
import io
import json
import struct
import tempfile
import unittest
import zipfile
from argparse import Namespace
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import scope_cli
import scope_sr
import usb_server as bridge


def snapshot(values=(0.0, -1.25, 2.5)):
    return {'samples': len(values), 'sampleRate': 1_000_000,
            'capturedAt': '2026-10-10T00:00:00.000Z',
            'settings': {'sampleRate': 1_000_000, 'ch1Vertical': {'probe': 10, 'vDiv': 0.5}},
            'channels': [{'name': name, 'data': base64.b64encode(struct.pack(f'<{len(values)}f', *values)).decode()}
                         for name in ('CH1', 'CH2')]}


class ScopeSrTests(unittest.TestCase):
    def test_zero_provenance_is_preserved_without_correcting_analog_samples(self):
        capture = snapshot()
        capture['zeroCalibration'] = {'ch1': {'offsetVolts': 0.245, 'sampleRate': 1000000,
                                               'hardwareRangeVpp': 1, 'probe': 10,
                                               'capturedAt': capture['capturedAt'], 'samples': 100}, 'ch2': None}
        capture['zeroCorrectionAppliedToSamples'] = False
        payload, summary = scope_sr.build_sr(capture)
        self.assertEqual(summary['zeroCalibration'], capture['zeroCalibration'])
        self.assertIs(summary['zeroCorrectionAppliedToSamples'], False)
        with zipfile.ZipFile(io.BytesIO(payload)) as session:
            self.assertEqual(struct.unpack('<3f', session.read('analog-1-1-1')), (0.0, -1.25, 2.5))
            self.assertEqual(json.loads(session.read('scope-settings.json'))['zeroCalibration'], capture['zeroCalibration'])

    def test_rejects_corrected_samples_or_invalid_zero_provenance(self):
        with self.assertRaisesRegex(ValueError, 'uncorrected'):
            scope_sr.build_sr({**snapshot(), 'zeroCorrectionAppliedToSamples': True})
        profile = {'offsetVolts': 0.245, 'sampleRate': 1000000, 'hardwareRangeVpp': 1,
                   'probe': 10, 'capturedAt': snapshot()['capturedAt'], 'samples': 100}
        for change in ({'offsetVolts': float('nan')}, {'sampleRate': 12000000},
                       {'probe': 2}, {'hardwareRangeVpp': 3}, {'samples': 99}):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'provenance'):
                scope_sr.build_sr({**snapshot(), 'zeroCalibration': {'ch1': {**profile, **change}, 'ch2': None}})
        with self.assertRaisesRegex(ValueError, 'channels'):
            scope_sr.build_sr({**snapshot(), 'zeroCalibration': {'ch1': profile}})

    def test_archive_preserves_values_rate_channels_and_provenance(self):
        capture = snapshot()
        payload, summary = scope_sr.build_sr(capture)
        with zipfile.ZipFile(io.BytesIO(payload)) as session:
            self.assertEqual(session.read('version'), b'2')
            self.assertIn('samplerate=1000000 Hz', session.read('metadata').decode())
            self.assertIn('analog2=CH2', session.read('metadata').decode())
            self.assertEqual(struct.unpack('<3f', session.read('analog-1-1-1')), (0.0, -1.25, 2.5))
            self.assertEqual(json.loads(session.read('scope-settings.json')), summary)
        self.assertEqual(summary['settings'], capture['settings'])

    def test_external_snapshot_validation_rejects_invalid_payloads(self):
        for change in ({'samples': 0}, {'samples': 200001}, {'sampleRate': 0}, {'samples': 2},
                       {'channels': []}, {'channels':[1,2]}, {'settings': {'sampleRate': 2}}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                scope_sr.build_sr({**snapshot(), **change})
        with self.assertRaisesRegex(ValueError, 'non-finite'):
            scope_sr.build_sr(snapshot((float('nan'),)))
        with self.assertRaisesRegex(ValueError, 'Invalid Scope snapshot'):
            scope_sr.build_sr(None)

    def test_web_export_saves_real_file_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(scope_sr, 'CAPTURE_DIR', Path(directory)), \
                patch.object(scope_sr.uuid, 'uuid4', return_value=Mock(hex='12345678')), \
                patch.object(scope_sr, 'datetime') as clock:
            clock.now.return_value.strftime.return_value = '20261010-000000'
            result = asyncio.run(bridge.handle_scope_export_sr(None, {'snapshot': snapshot()}))
            path = Path(result['path'])
            before = path.read_bytes()
            self.assertEqual(result['bytes'], len(before))
            with self.assertRaises(FileExistsError):
                asyncio.run(bridge.handle_scope_export_sr(None, {'snapshot': snapshot()}))
            self.assertEqual(path.read_bytes(), before)

    def test_sr_control_routes_snapshot_through_writer_and_cli_keeps_metadata(self):
        async def check():
            bridge.state = bridge.ServerState()
            owner = Mock()
            async def reply(text):
                command = json.loads(text)
                await bridge.handle_scope_result(owner, {'command_id': command['command_id'], 'result': snapshot()})
            owner.send = AsyncMock(side_effect=reply)
            bridge.state.scope_owner = owner
            response = await bridge.handle_scope_control(None, {'action': 'sr'})
            payload = base64.b64decode(response['result']['base64'])
            with zipfile.ZipFile(io.BytesIO(payload)) as session:
                self.assertEqual(len(session.read('analog-1-2-1')), 12)
            response['req_id'] = 'cli'
            response['type'] = 'scope_result'
            ws = Mock(send=AsyncMock(), recv=AsyncMock(return_value=json.dumps(response)))
            connection = Mock()
            connection.__aenter__ = AsyncMock(return_value=ws)
            connection.__aexit__ = AsyncMock(return_value=False)
            with tempfile.TemporaryDirectory() as directory, patch.object(scope_cli, 'connect', return_value=connection), \
                    patch('builtins.print') as output:
                path = Path(directory) / 'trace.sr'
                args = Namespace(action='sr', params='{}', output=str(path))
                await scope_cli.run(args)
                self.assertEqual(path.read_bytes(), payload)
                result = json.loads(output.call_args.args[0])
                self.assertEqual((result['samples'], result['sampleRate'], result['channels']), (3, 1_000_000, ['CH1', 'CH2']))
                with self.assertRaises(FileExistsError):
                    await scope_cli.run(args)
                self.assertEqual(path.read_bytes(), payload)
        asyncio.run(check())


if __name__ == '__main__':
    unittest.main()
