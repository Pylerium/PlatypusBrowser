import json
import pathlib
import struct
import subprocess
import sys
import unittest

SCRIPT = pathlib.Path(__file__).parents[1] / "qa-ready.py"
ORIGIN = "chrome-extension://pmfendbmmlpmplggbadknjflhppgbhdi/"


class ReadyHostTests(unittest.TestCase):
    def invoke(self, origin, message):
        return subprocess.run([sys.executable, str(SCRIPT), origin], input=message, capture_output=True, timeout=5)

    def test_rejects_untrusted_origin_before_any_file_write(self):
        message = json.dumps({"nonce": "a" * 32}).encode()
        result = self.invoke("https://example.com", struct.pack("=I", len(message)) + message)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")

    def test_rejects_oversized_and_invalid_nonce_messages(self):
        for length in (0, 4097):
            result = self.invoke(ORIGIN, struct.pack("=I", length))
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b"")
        for nonce in ("../escape", 123, "a" * 33):
            message = json.dumps({"nonce": nonce}).encode()
            result = self.invoke(ORIGIN, struct.pack("=I", len(message)) + message)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b"")
