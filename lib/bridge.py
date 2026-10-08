#!/usr/bin/env python3
"""
Lightweight TLS Impersonation Bridge for GLM_proxy.
Uses curl_cffi to bypass Alibaba Cloud WAF TLS bot detection by impersonating
Chromium's TLS Client Hello (JA3/JA4 fingerprint), matching AutoClaw's Electron client.
"""

import argparse
import http.server
import json
import os
import sys
import threading
from curl_cffi import requests

class ThreadedHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

class BridgeHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "15")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        try:
            content_len = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(content_len)
            payload = json.loads(raw_body.decode("utf-8"))

            url = payload["url"]
            headers = payload.get("headers", {})
            data = payload.get("data")
            stream = payload.get("stream", False)
            timeout = payload.get("timeout", 120)
            impersonate = payload.get("impersonate", "chrome124")

            # Remove pre-existing Content-Length, Host, Transfer-Encoding so curl_cffi computes exact wire values
            clean_headers = {k: v for k, v in headers.items() if k.lower() not in ("content-length", "host", "transfer-encoding")}

            resp = requests.post(
                url,
                headers=clean_headers,
                json=data,
                impersonate=impersonate,
                stream=stream,
                timeout=timeout
            )

            self.send_response(resp.status_code)
            for k, v in resp.headers.items():
                k_lower = k.lower()
                if k_lower in ("content-type", "vary"):
                    self.send_header(k, v)

            if resp.status_code >= 400:
                body = resp.content
                sys.stderr.write(f"[BRIDGE] Upstream error {resp.status_code}: {resp.text[:500]}\n")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                self.wfile.flush()
            elif stream:
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                for chunk in resp.iter_content(chunk_size=None):
                    if chunk:
                        chunk_len = f"{len(chunk):X}\r\n".encode("ascii")
                        self.wfile.write(chunk_len + chunk + b"\r\n")
                        self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            else:
                body = resp.content
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                self.wfile.flush()

        except Exception as e:
            err_json = json.dumps({"error": str(e)}).encode("utf-8")
            try:
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(err_json)))
                self.end_headers()
                self.wfile.write(err_json)
            except Exception:
                pass

    def log_message(self, format, *args):
        if os.environ.get("GLMP_BRIDGE_DEBUG") == "1":
            sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))


def watch_parent():
    """Auto-terminate when parent process dies or stdin closes."""
    try:
        sys.stdin.read()
    except Exception:
        pass
    os._exit(0)


def main():
    parser = argparse.ArgumentParser(description="GLM Proxy TLS Bridge")
    parser.add_argument("--port", type=int, default=int(os.environ.get("GLMP_BRIDGE_PORT", "0")))
    parser.add_argument("--host", type=str, default="127.0.0.1")
    args = parser.parse_args()

    server = ThreadedHTTPServer((args.host, args.port), BridgeHandler)
    assigned_port = server.server_address[1]

    # Spawn thread to watch stdin for parent exit
    stdin_watcher = threading.Thread(target=watch_parent, daemon=True)
    stdin_watcher.start()

    sys.stdout.write(f"BRIDGE_READY_PORT={assigned_port}\n")
    sys.stdout.flush()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
