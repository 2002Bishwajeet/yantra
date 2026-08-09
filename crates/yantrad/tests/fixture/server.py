"""HTTPS for release.sh's stand-in release host (Y-158).

`openssl s_server -WWW` answers 200 with an error message for a path it cannot
open, which would let install.sh build a wrong URL and still look green.
"""

import functools
import http.server
import ssl
import sys

root, cert, key = sys.argv[1:4]
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
server = http.server.ThreadingHTTPServer(("127.0.0.1", 443), handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(cert, key)
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
