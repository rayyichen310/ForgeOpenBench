"""Control the open Scope view through the same loopback USB bridge."""
import argparse
import asyncio
import base64
import json
from pathlib import Path

from websockets.asyncio.client import connect


def params(args):
    value = json.loads(args.params)
    if args.action == 'load-sr':
        # The Scope page parses the SR itself, exactly as when the file is opened in the browser.
        value['data'] = base64.b64encode(Path(args.input).read_bytes()).decode('ascii')
    return value


async def request(ws, action, value=None):
    # Requests are strictly sequential, so one req_id suffices to pick our reply out of broadcasts.
    await ws.send(json.dumps({'type': 'scope_control', 'req_id': 'cli',
                              'action': action, 'params': value or {}}))
    while True:
        response = await asyncio.wait_for(ws.recv(), 20)
        if isinstance(response, bytes):
            continue
        message = json.loads(response)
        if message.get('req_id') != 'cli':
            continue
        if message['type'] == 'usb_error':
            raise RuntimeError(message['message'])
        return message['result']


def segment_ready(segment, rate, min_samples, allow_loss):
    return (segment is not None and segment['sampleRate'] == rate and segment['samples'] >= min_samples
            and (allow_loss or segment['usbDataLoss'] is False))


async def capture(ws, args):
    """Stop, apply settings, run on freshly configured hardware, then save the first suitable segment."""
    patch = json.loads(args.params)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + args.timeout
    await request(ws, 'stop')
    if patch:
        await request(ws, 'set', patch)
    rate = (await request(ws, 'status'))['sampleRate']
    segment = None
    while loop.time() < deadline:
        # Run from Stop reconfigures the hardware and discards the previous segment.
        await request(ws, 'run')
        while loop.time() < deadline:
            await asyncio.sleep(0.2)
            if segment_ready((await request(ws, 'status'))['capture'], rate, args.min_samples, args.allow_loss):
                break
        await request(ws, 'stop')
        # Chunks that arrived before Stop may have restarted the segment, so check what is retained.
        segment = (await request(ws, 'status'))['capture']
        if segment_ready(segment, rate, args.min_samples, args.allow_loss):
            return await request(ws, 'sr')
    wanted = f'{args.min_samples} contiguous samples at {rate} Sa/s'
    if not args.allow_loss:
        wanted += ' without USB data loss'
    raise RuntimeError(f'No segment with {wanted} within {args.timeout} s; last retained segment: {segment}. '
                       'Two channels at 24 MSa/s or more reach the USB 2.0 bandwidth limit; lower the rate or pass --allow-loss.')


async def run(args):
    async with connect('ws://127.0.0.1:8766', max_size=8_000_000) as ws:
        if args.action == 'capture':
            result = await capture(ws, args)
        else:
            result = await request(ws, args.action, params(args))
        if args.output:
            path = Path(args.output)
            payload = base64.b64decode(result['base64']) if 'base64' in result else result['csv'].encode('utf-8')
            with path.open('xb') as output:
                output.write(payload)
            result = {key: value for key, value in result.items() if key not in ('base64', 'csv')}
            result.update(path=str(path), bytes=len(payload))
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'set', 'run', 'stop', 'single', 'autoset', 'force', 'clear', 'reference', 'csv', 'png', 'sr', 'zero', 'zero-reset', 'load-sr', 'view', 'measurements', 'capture'])
    parser.add_argument('--params', default='{}', help='Scope state patch (capture applies it before running); zero needs {"channel":"ch1","groundConfirmed":true}; zero-reset needs {"channel":"ch1"}; load-sr accepts window, zero and display; view and png accept x and y ranges; png also width and height')
    parser.add_argument('--input', help='Scope SR file to show as a held capture (load-sr)')
    parser.add_argument('--output', help='New output file for csv/png/sr/capture; existing files are never overwritten')
    parser.add_argument('--min-samples', type=int, default=10_000, help='capture: contiguous samples per channel the saved segment must hold (default 10000)')
    parser.add_argument('--allow-loss', action='store_true', help='capture: accept a segment in which USB dropped samples')
    parser.add_argument('--timeout', type=float, default=30, help='capture: seconds to wait for a suitable segment (default 30)')
    args = parser.parse_args()
    if args.action in ('sr', 'capture') and not args.output:
        parser.error(f'{args.action} requires --output with a new .sr file path')
    if args.output and Path(args.output).exists():
        parser.error(f'{args.output} already exists; outputs are never overwritten')
    if args.action == 'load-sr' and not args.input:
        parser.error('load-sr requires --input with an existing .sr file')
    asyncio.run(run(args))
