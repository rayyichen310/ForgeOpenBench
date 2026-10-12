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


async def run(args):
    async with connect('ws://127.0.0.1:8766', max_size=8_000_000) as ws:
        await ws.send(json.dumps({'type': 'scope_control', 'req_id': 'cli',
                                  'action': args.action, 'params': params(args)}))
        while True:
            response = await asyncio.wait_for(ws.recv(), 20)
            if isinstance(response, bytes):
                continue
            message = json.loads(response)
            if message.get('req_id') != 'cli':
                continue
            if message['type'] == 'usb_error':
                raise RuntimeError(message['message'])
            result = message['result']
            if args.output:
                path = Path(args.output)
                payload = base64.b64decode(result['base64']) if 'base64' in result else result['csv'].encode('utf-8')
                with path.open('xb') as output:
                    output.write(payload)
                result = {key: value for key, value in result.items() if key not in ('base64', 'csv')}
                result.update(path=str(path), bytes=len(payload))
            print(json.dumps(result, ensure_ascii=False))
            return


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'set', 'run', 'stop', 'single', 'autoset', 'force', 'clear', 'reference', 'csv', 'png', 'sr', 'zero', 'zero-reset', 'load-sr', 'view'])
    parser.add_argument('--params', default='{}', help='Scope state patch; zero needs {"channel":"ch1","groundConfirmed":true}; zero-reset needs {"channel":"ch1"}; load-sr accepts window, zero and display; view and png accept x and y ranges; png also width and height')
    parser.add_argument('--input', help='Scope SR file to show as a held capture (load-sr)')
    parser.add_argument('--output', help='New output file for csv/png/sr; existing files are never overwritten')
    args = parser.parse_args()
    if args.action == 'sr' and not args.output:
        parser.error('sr requires --output with a new .sr file path')
    if args.action == 'load-sr' and not args.input:
        parser.error('load-sr requires --input with an existing .sr file')
    asyncio.run(run(args))
