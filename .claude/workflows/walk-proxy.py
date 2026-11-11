"""walk.sh's hop from the browser to the walk's yantrad (Y-687).

    walk-proxy.py <port> <unix socket>              the owner on the daemon's socket, as `yantra` is
    walk-proxy.py <port> <host:port> <bind address> another device of the owner's, with no cookie

The browser is on http://127.0.0.1, which is no origin the daemon serves, so
its Origin header is dropped. Each plain request gets `Connection: close`, so
every request opens a connection of its own and none rides on another's.
"""

import asyncio
import sys

listen, upstream = int(sys.argv[1]), sys.argv[2]
bind = sys.argv[3] if len(sys.argv) > 3 else None


async def connect():
    if upstream.startswith("/"):
        return await asyncio.open_unix_connection(upstream)
    host, port = upstream.rsplit(":", 1)
    return await asyncio.open_connection(host, int(port), local_addr=(bind, 0))


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except ConnectionError:
        pass
    finally:
        writer.close()


async def serve(client_reader, client_writer):
    try:
        head = await client_reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
        client_writer.close()
        return
    first, *fields = head[:-4].split(b"\r\n")
    named = lambda name: [f for f in fields if f.lower().startswith(name)]
    kept = [f for f in fields if not f.lower().startswith((b"origin:", b"connection:"))]
    kept += named(b"connection:") if named(b"upgrade:") else [b"Connection: close"]
    try:
        upstream_reader, upstream_writer = await connect()
    except OSError:
        client_writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        client_writer.close()
        return
    upstream_writer.write(b"\r\n".join([first, *kept]) + b"\r\n\r\n")
    await asyncio.gather(pipe(client_reader, upstream_writer), pipe(upstream_reader, client_writer))


async def main():
    server = await asyncio.start_server(serve, "0.0.0.0", listen, reuse_address=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())
