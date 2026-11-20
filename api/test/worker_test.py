"""Worker input backpressure tests, using only Python's standard library."""
import asyncio
import importlib.util
import io
import json
from pathlib import Path
import threading
import unittest

spec = importlib.util.spec_from_file_location("worker", Path(__file__).parents[1] / "worker" / "foulplay_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerInputTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_engine_bounds_reader_and_preserves_frame_order(self):
        class Input:
            reads = 0

            def readline(self, limit):
                self.reads += 1
                if self.reads > 100:
                    return b""
                return (json.dumps({"type": "frame", "data": str(self.reads)}) + "\n").encode()

        stream = Input()
        frames = asyncio.Queue(maxsize=worker.MAX_QUEUED_FRAMES)
        reader = threading.Thread(target=worker.read_stdin, args=(asyncio.get_running_loop(), frames, stream), daemon=True)
        reader.start()
        for _ in range(100):
            if frames.full():
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.05)
        self.assertTrue(frames.full())
        self.assertLessEqual(stream.reads, worker.MAX_QUEUED_FRAMES + 1)
        received = []
        while True:
            frame = await asyncio.wait_for(frames.get(), 2)
            if frame is None:
                break
            received.append(frame)
        await asyncio.to_thread(reader.join, 2)
        self.assertFalse(reader.is_alive())
        self.assertEqual(received, [str(i) for i in range(1, 101)])

    async def test_invalid_lines_and_stop_do_not_enter_the_queue(self):
        frames = asyncio.Queue(maxsize=2)
        data = b'not json\n{"type":"frame","data":123}\n{"type":"stop"}\n{"type":"frame","data":"late"}\n'
        reader = threading.Thread(target=worker.read_stdin,
                                  args=(asyncio.get_running_loop(), frames, io.BytesIO(data)), daemon=True)
        reader.start()
        self.assertIsNone(await asyncio.wait_for(frames.get(), 2))
        await asyncio.to_thread(reader.join, 2)
        self.assertFalse(reader.is_alive())
        self.assertTrue(frames.empty())

    async def test_oversized_line_stops_input(self):
        frames = asyncio.Queue(maxsize=2)
        reader = threading.Thread(target=worker.read_stdin,
                                  args=(asyncio.get_running_loop(), frames, io.BytesIO(b'x' * (worker.MAX_LINE + 1))), daemon=True)
        reader.start()
        self.assertIsNone(await asyncio.wait_for(frames.get(), 2))
        await asyncio.to_thread(reader.join, 2)
        self.assertFalse(reader.is_alive())


if __name__ == '__main__':
    unittest.main()
