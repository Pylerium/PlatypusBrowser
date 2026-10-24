import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("adapter", pathlib.Path(__file__).parents[1] / "apply-workspace.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

class ManifestTests(unittest.TestCase):
    def data(self):
        return {"format": "platypus-workspace", "version": 1, "workspaceId": "qa-workspace",
            "profileId": "6c5cf5e8-cb0a-49c4-bc7c-54e033810be4",
            "hardware": {"systemUuid": "770b922a-6980-402f-b233-8fd60abb0163", "machineGuid": "5ed1abe5-5562-44ea-9a40-c15ba4bec19f"},
            "browser": {"startUrl": "https://example.com", "runtime": None}}
    def test_valid(self):
        value = self.data()
        self.assertEqual(adapter.validate(value), value)
    def test_rejects_unsafe_urls_and_ids(self):
        for url in ("javascript:alert(1)", "file:///etc/passwd", "https://", "--no-sandbox"):
            value = self.data(); value["browser"]["startUrl"] = url
            with self.assertRaises(ValueError): adapter.validate(value)
        value = self.data(); value["workspaceId"] = "../escape"
        with self.assertRaises(ValueError): adapter.validate(value)
    def test_runtime(self):
        value = self.data()
        value["browser"]["runtime"] = {"hardwareConcurrency": 4, "deviceMemory": 4, "platform": "Win32", "canvasSeed": 0}
        adapter.validate(value)
        for field, invalid in (("hardwareConcurrency", 0), ("hardwareConcurrency", True), ("platform", "bad\nvalue"), ("canvasSeed", -1)):
            copy = self.data(); copy["browser"]["runtime"] = dict(value["browser"]["runtime"]); copy["browser"]["runtime"][field] = invalid
            with self.assertRaises(ValueError): adapter.validate(copy)

if __name__ == "__main__": unittest.main()
