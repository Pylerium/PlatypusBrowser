#!/usr/bin/python3
"""Multiplex local SOCKS connections over QEMU's single restricted guest forward.

No credentials are present in this adapter. The host authenticates upstream.
"""
import socket
import struct
import threading


def serve():
    transport = socket.create_connection(("10.0.2.100", 1080), timeout=20)
    transport.settimeout(None)
    streams = {}
    lock = threading.RLock()
    sending = threading.Lock()
    sequence = 0

    def send(stream_id, data=b""):
        with sending:
            transport.sendall(struct.pack("!II", stream_id, len(data)) + data)

    def receive(size):
        data = bytearray()
        while len(data) < size:
            chunk = transport.recv(size - len(data))
            if not chunk:
                raise ConnectionError("Workspace proxy gateway closed")
            data.extend(chunk)
        return bytes(data)

    def pump(stream_id, client):
        try:
            while True:
                data = client.recv(65536)
                if not data:
                    break
                send(stream_id, data)
        except OSError:
            pass
        finally:
            with lock:
                streams.pop(stream_id, None)
            client.close()
            try:
                send(stream_id)
            except OSError:
                pass

    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 1080))
    listener.listen(128)

    def accept():
        nonlocal sequence
        while True:
            client, _ = listener.accept()
            with lock:
                if len(streams) >= 1024:
                    client.close()
                    continue
                sequence += 1
                streams[sequence] = client
            threading.Thread(target=pump, args=(sequence, client), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    try:
        while True:
            stream_id, length = struct.unpack("!II", receive(8))
            if not stream_id or length > 65536:
                raise ValueError("Invalid proxy frame")
            data = receive(length)
            with lock:
                client = streams.get(stream_id)
            if client:
                if data:
                    client.sendall(data)
                else:
                    # Wake the sending thread so it can release the descriptor.
                    try:
                        client.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
    finally:
        listener.close()
        transport.close()


if __name__ == "__main__":
    serve()
