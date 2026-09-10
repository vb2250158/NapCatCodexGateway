"""Run with a local Python environment containing PyAV; no models are required."""
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import wave
import zlib

import av


class MediaInspectionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def inspect(self, file, kind):
        return subprocess.run(
            [sys.executable, str(Path(__file__).with_name("inspect-media.py")), str(file), kind],
            capture_output=True, text=True, timeout=10,
        )

    def test_png_and_wav_decode_with_explicit_formats(self):
        def chunk(name, payload):
            return struct.pack(">I", len(payload)) + name + payload + struct.pack(">I", zlib.crc32(name + payload))
        image = self.root / "image.png"
        image.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
                         + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00")) + chunk(b"IEND", b""))
        result = self.inspect(image, "image")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"width": 1, "height": 1})
        audio = self.root / "audio.wav"
        with wave.open(str(audio), "wb") as output:
            output.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            output.writeframes(bytes(16000))
        result = self.inspect(audio, "audio")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["duration"], 1)
        self.assertNotEqual(self.inspect(audio, "video").returncode, 0)

    def test_h264_video_retains_frame_and_duration_checks(self):
        video = self.root / "video.mp4"
        with av.open(str(video), "w") as output:
            stream = output.add_stream("libx264", rate=24)
            stream.width = stream.height = 64
            stream.pix_fmt = "yuv420p"
            for _ in range(48):
                frame = av.VideoFrame(64, 64, "yuv420p")
                for plane in frame.planes:
                    plane.update(bytes(plane.buffer_size))
                for packet in stream.encode(frame):
                    output.mux(packet)
            for packet in stream.encode():
                output.mux(packet)
        result = self.inspect(video, "video")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["duration"], 2)

    def test_playlist_bytes_are_rejected_without_network_access(self):
        import http.server
        import threading
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_error(404)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            file = self.root / "disguised.mp4"
            file.write_text(f"#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://127.0.0.1:{server.server_port}/media.ts\n#EXT-X-ENDLIST\n")
            for kind in ("image", "video", "audio"):
                self.assertNotEqual(self.inspect(file, kind).returncode, 0)
            self.assertEqual(requests, [])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
