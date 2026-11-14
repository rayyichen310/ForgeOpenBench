import asyncio
import struct
import unittest
from unittest.mock import Mock, AsyncMock, patch

import usb_server as bridge


class WindowsScopeTests(unittest.TestCase):
    def setUp(self):
        bridge.state = bridge.ServerState()

    def test_sigrok_scope_is_detected_for_ram_firmware_switch(self):
        device = next((d for d in bridge.DEVICES if (d['vid'], d['pid']) == (0x1D50, 0x608E)), None)
        self.assertIsNotNone(device)
        self.assertEqual(device['mode'], 'dso')
        self.assertTrue(device['needs_fw'])

    def test_invalid_rate_does_not_mutate_config(self):
        before = bridge.state.config.sample_rate_hz
        result = asyncio.run(bridge.handle_usb_configure(None, {'mode': 'dso', 'sample_rate_hz': 12345}))
        self.assertEqual(result['type'], 'usb_error')
        self.assertEqual(bridge.state.config.sample_rate_hz, before)

    def test_windows_capture_preserves_dual_channel_frame_and_stops_hardware(self):
        dev = Mock()
        bridge.state.device = dev
        bridge.state.capturing = True
        bridge.state.config.sample_rate_hz = 1_000_000
        def read(*args, **kwargs):
            bridge.state.stop_event.set()
            return bytes([128, 129, 160, 130])
        dev.read.side_effect = read
        with patch.object(bridge, 'broadcast_binary_sync') as send:
            bridge._capture_loop_windows()
        frame = send.call_args.args[0]
        size, rate, count, timestamp, reserved = struct.unpack('<IIIQI', frame[:24])
        self.assertEqual((size, rate, count, reserved & 255), (28, 1_000_000, 4, 8))
        self.assertEqual(reserved >> 8, 1)
        self.assertEqual(frame[24:], bytes([128, 129, 160, 130]))
        dev.ctrl_transfer.assert_called_with(0x40, bridge.HANTEK_START, 0, 0, b'\x00', bridge.USB_TIMEOUT)
        self.assertFalse(bridge.state.capturing)

    def test_read_loss_is_inferred_from_bytes_against_elapsed_time(self):
        # 16 MSa/s: 262144 bytes take 8.19 ms; a 50 us gap fits in the FIFO.
        self.assertEqual(bridge._dso_read_loss(16_000_000, 262_144, 0.00819, 0.00005)[:2], (False, False))
        # 48 MSa/s needs 96 MB/s; delivering at ~40 MB/s means most samples were dropped.
        gap_lost, read_lost, lost = bridge._dso_read_loss(48_000_000, 262_144, 0.0066, None)
        self.assertEqual((gap_lost, read_lost), (False, True))
        self.assertAlmostEqual(lost, 96_000_000 * 0.0066 - 262_144, delta=1)
        # A 1 ms gap at 16 MSa/s holds 32 kB, far more than the endpoint FIFO.
        self.assertEqual(bridge._dso_read_loss(16_000_000, 262_144, 0.00819, 0.001)[:2], (True, False))

    def test_windows_capture_flags_lossy_reads_and_breaks_sequence_after_gaps(self):
        dev = Mock()
        bridge.state.device = dev
        bridge.state.capturing = True
        bridge.state.config.sample_rate_hz = 1_000_000
        reads = iter([bytes(2000)] * 3)
        def read(*args, **kwargs):
            data = next(reads)
            if bridge.state.stop_event.is_set() is False and dev.read.call_count == 3:
                bridge.state.stop_event.set()
            return data
        dev.read.side_effect = read
        # Log timer start, then (t0, t1) per read: a clean 1 ms read, a 3 ms read of 1 ms of
        # data, and a clean read after a 2 ms gap.
        clock = iter([0.0, 0.0, 0.001, 0.001, 0.004, 0.006, 0.007])
        with patch.object(bridge, 'broadcast_binary_sync') as send,                 patch.object(bridge.time, 'perf_counter', side_effect=lambda: next(clock)):
            bridge._capture_loop_windows()
        reserved = [struct.unpack('<I', call.args[0][20:24])[0] for call in send.call_args_list]
        self.assertEqual([r >> 8 for r in reserved], [1, 2, 4])
        self.assertEqual([bool(r & bridge.DSO_FLAG_LOSS) for r in reserved], [False, True, False])
        self.assertEqual([r & 0x7F for r in reserved], [8, 8, 8])
        self.assertEqual((bridge.state.dso_loss['reads'], bridge.state.dso_loss['read_lost'],
                          bridge.state.dso_loss['gap_lost']), (3, 1, 1))

    def test_control_requires_live_view_and_routes_its_actual_reply(self):
        async def check():
            missing = await bridge.handle_scope_control(None, {'action': 'status'})
            self.assertEqual(missing['type'], 'usb_error')
            owner = Mock()
            async def reply(text):
                import json
                request = json.loads(text)
                await bridge.handle_scope_result(owner, {'command_id': request['command_id'], 'result': {'connected': True}})
            owner.send = AsyncMock(side_effect=reply)
            bridge.state.scope_owner = owner
            result = await bridge.handle_scope_control(None, {'action': 'status'})
            self.assertTrue(result['result']['connected'])
            self.assertFalse(bridge._scope_pending)
        asyncio.run(check())


if __name__ == '__main__':
    unittest.main()
