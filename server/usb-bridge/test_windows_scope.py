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

    def _run_windows_capture(self, rate, transfers, on_next=lambda index: None):
        """Run the capture loop over fake queued transfers given as (time, data)."""
        dev = Mock()
        bridge.state.device = dev
        bridge.state.capturing = True
        bridge.state.config.sample_rate_hz = rate
        items = iter(enumerate(transfers))

        class FakeQueue:
            raw_io = True
            def __init__(self, *args):
                self.closed = False
            def next(self):
                index, item = next(items, (None, None))
                if item is None:
                    bridge.state.stop_event.set()
                    return None
                on_next(index)
                clock.append(item[0])
                return item[1]
            def close(self):
                self.closed = True

        clock = [0.0]
        with patch.object(bridge, '_BulkInQueue', FakeQueue), \
                patch.object(bridge, 'broadcast_binary_sync') as send, \
                patch.object(bridge.time, 'perf_counter', side_effect=lambda: clock[-1]):
            bridge._capture_loop_windows()
        dev.ctrl_transfer.assert_called_with(0x40, bridge.HANTEK_START, 0, 0, b'\x00', bridge.USB_TIMEOUT)
        self.assertFalse(bridge.state.capturing)
        return [call.args[0] for call in send.call_args_list]

    def test_connect_replaces_stock_firmware_with_horo_in_ram(self):
        stock = Mock(idVendor=0x04B5, idProduct=0x602A, bcdDevice=0x0000)
        horo = Mock(idVendor=0x04B5, idProduct=0x602A, bcdDevice=0x0210)
        with patch.object(bridge, '_find_usb', return_value=stock),                 patch.object(bridge, '_upload_firmware') as upload,                 patch.object(bridge, '_wait_horo_firmware', return_value=horo),                 patch.object(bridge.usb.util, 'claim_interface'),                 patch.object(bridge.usb.util, 'dispose_resources'):
            result = asyncio.run(bridge.handle_usb_connect(None, {'vid': 0x04B5, 'pid': 0x602A}))
        self.assertEqual(result['type'], 'usb_connected')
        self.assertEqual(upload.call_args.args[1].name, 'hantek-6022bl-scope.fw')
        self.assertIs(bridge.state.device, horo)
        with patch.object(bridge, '_find_usb', return_value=horo), patch.object(bridge, '_upload_firmware') as upload,                 patch.object(bridge.usb.util, 'claim_interface'):
            asyncio.run(bridge.handle_usb_connect(None, {'vid': 0x04B5, 'pid': 0x602A}))
        upload.assert_not_called()

    def test_sample_rate_codes_follow_the_running_firmware(self):
        def rate_code(bcd, hz):
            dev = Mock(bcdDevice=bcd)
            bridge.state.config.sample_rate_hz = hz
            with patch.object(bridge.time, 'sleep'):
                self.assertTrue(bridge._hantek_setup(dev, bridge.state.config))
            requests = [c.args[1] for c in dev.ctrl_transfer.call_args_list]
            # Ho-Ro remembers a single-channel setting from another program; stock has no 0xE4.
            self.assertEqual(bridge.HANTEK_SET_NUMCHANNELS in requests, bcd >= 0x0200)
            return next(c.args[4][0] for c in dev.ctrl_transfer.call_args_list
                        if c.args[1] == bridge.HANTEK_SET_SAMPLERATE)
        self.assertEqual((rate_code(0x0000, 500_000), rate_code(0x0210, 500_000)), (50, 150))
        self.assertEqual((rate_code(0x0000, 100_000), rate_code(0x0210, 10_000_000)), (10, 10))
        bridge.state.device = Mock(bcdDevice=0x0000)
        result = asyncio.run(bridge.handle_usb_configure(None, {'mode': 'dso', 'sample_rate_hz': 15_000_000}))
        self.assertEqual(result['type'], 'usb_error')
        self.assertIn('stock firmware', result['message'])
        result = asyncio.run(bridge.handle_usb_configure(None, {'mode': 'dso', 'sample_rate_hz': 16_000_000}))
        self.assertEqual(result['type'], 'usb_configured')

    def test_windows_capture_drops_stale_first_transfer_and_keeps_channel_pairs(self):
        # 1 MSa/s = 2 MB/s, so 40,000 bytes arrive every 20 ms.
        stale = bytes([1, 2]) * 20_000
        data = bytes([128, 129, 160, 130]) * 10_000
        frames = self._run_windows_capture(1_000_000, [(0.0, stale)] + [(0.02 * k, data) for k in range(1, 5)])
        self.assertEqual(len(frames), 2)
        size, rate, count, timestamp, reserved = struct.unpack('<IIIQI', frames[0][:24])
        self.assertEqual((size, rate, count, reserved & 0xFF), (24 + 40_000, 1_000_000, 40_000, 8))
        self.assertEqual([struct.unpack('<I', f[20:24])[0] >> 8 for f in frames], [1, 2])
        self.assertEqual(frames[0][24:], data)

    def test_windows_capture_holds_contiguous_data_while_the_page_is_busy(self):
        # The page acknowledges the first frame late: data beyond the backlog cap is dropped
        # and the next frame skips a sequence number so the page starts a new segment.
        bridge.state.clients = {Mock()}
        bridge.state.frame_ack.set()
        ack_at = lambda index: bridge.state.frame_ack.set() if index == 10 else None
        with patch.object(bridge, 'DSO_BACKLOG_BYTES', 100_000):
            frames = self._run_windows_capture(
                1_000_000, [(0.02 * k, bytes([k]) * 40_000) for k in range(16)], ack_at)
        self.assertEqual([struct.unpack('<I', f[20:24])[0] >> 8 for f in frames], [1, 3])
        self.assertEqual(frames[0][24:], bytes([1]) * 40_000)
        self.assertEqual(frames[1][24:], bytes([6]) * 40_000 + bytes([7]) * 40_000)
        self.assertEqual(bridge.state.dso_loss['dropped_for_page'], 4)

    def test_windows_capture_flags_transfers_around_a_device_side_loss(self):
        # A transfer arrives 10 ms late with no more data: 20,000 bytes were dropped.
        times = [0.0, 0.02, 0.04, 0.07, 0.09, 0.11, 0.13]
        frames = self._run_windows_capture(1_000_000, [(t, bytes(40_000)) for t in times])
        reserved = [struct.unpack('<I', f[20:24])[0] for f in frames]
        # The two clean transfers before the loss go out as one contiguous frame.
        self.assertEqual([len(f) - 24 for f in frames], [80_000, 40_000, 40_000])
        self.assertEqual([bool(r & bridge.DSO_FLAG_LOSS) for r in reserved], [False, True, True])
        self.assertEqual(bridge.state.dso_loss['lossy'], 2)

    def test_single_channel_capture_pads_ch2_and_counts_one_byte_per_sample(self):
        # One channel at 1 MSa/s is 1 MB/s: 20,000 bytes every 20 ms are complete, not half lost.
        bridge.state.config.dso_channels = 1
        data = bytes(range(100)) * 200
        frames = self._run_windows_capture(1_000_000, [(0.02 * k, data) for k in range(6)])
        self.assertTrue(frames)
        self.assertFalse(any(struct.unpack('<I', f[20:24])[0] & bridge.DSO_FLAG_LOSS for f in frames))
        payload = b''.join(f[24:] for f in frames)
        self.assertEqual(payload[0::2], data * (len(payload) // 40_000))
        self.assertEqual(set(payload[1::2]), {128})
        self.assertEqual(bridge.state.dso_loss['lossy'], 0)

    def test_single_channel_mode_needs_horo_and_sets_the_channel_count(self):
        bridge.state.device = Mock(bcdDevice=0x0000)
        result = asyncio.run(bridge.handle_usb_configure(None, {'mode': 'dso', 'dso_channels': 1}))
        self.assertEqual(result['type'], 'usb_error')
        self.assertEqual(bridge.state.config.dso_channels, 2)
        dev = Mock(bcdDevice=0x0210)
        bridge.state.device = dev
        result = asyncio.run(bridge.handle_usb_configure(None, {'mode': 'dso', 'dso_channels': 1}))
        self.assertEqual(result['type'], 'usb_configured')
        with patch.object(bridge.time, 'sleep'):
            self.assertTrue(bridge._hantek_setup(dev, bridge.state.config))
        sent = [c.args[4] for c in dev.ctrl_transfer.call_args_list if c.args[1] == bridge.HANTEK_SET_NUMCHANNELS]
        self.assertEqual(sent, [bytes([1])])

    def test_loss_tracker_ignores_a_late_callback(self):
        # 16 MSa/s: 262,144 bytes every 8.192 ms; one completion is noticed 3 ms late.
        tracker = bridge.DsoLossTracker(16_000_000)
        out = []
        for k in range(12):
            out += tracker.add(0.008192 * k + (0.003 if k == 5 else 0.0), bytes(262_144))
        self.assertTrue(out)
        self.assertFalse(any(lossy for _, lossy in out))

    def test_loss_tracker_flags_every_transfer_past_the_usb_bandwidth(self):
        # Two channels at 24 MSa/s need 48 MB/s; USB delivers ~45 MB/s.
        tracker = bridge.DsoLossTracker(24_000_000)
        out = []
        for k in range(20):
            out += tracker.add(k * 262_144 / 45e6, bytes(262_144))
        self.assertTrue(out)
        self.assertTrue(all(lossy for _, lossy in out))

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
