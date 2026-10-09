"""Control the open Scope view through the same loopback USB bridge."""
import argparse
import asyncio
import base64
import json
from pathlib import Path

from websockets.asyncio.client import connect


async def run(args):
    async with connect('ws://127.0.0.1:8766', max_size=8_000_000) as ws:
        await ws.send(json.dumps({'type': 'scope_control', 'req_id': 'cli',
                                  'action': args.action, 'params': json.loads(args.params)}))
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
                result = {'path': str(path), 'bytes': len(payload), 'settings': result['settings']}
            print(json.dumps(result, ensure_ascii=False))
            return


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'set', 'run', 'stop', 'single', 'autoset', 'force', 'clear', 'reference', 'csv', 'png'])
    parser.add_argument('--params', default='{}', help='Scope state patch as JSON')
    parser.add_argument('--output', help='New output file for csv/png; existing files are never overwritten')
    asyncio.run(run(parser.parse_args()))
