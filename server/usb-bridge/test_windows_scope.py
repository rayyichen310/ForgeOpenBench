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
