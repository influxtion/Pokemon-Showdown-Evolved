"""Foul Play inference worker. One process per practice session, driven over stdio.

The battle itself runs elsewhere (on the player's computer). The API server feeds this worker the
bot's view of the battle, frame by frame, and relays back the choices Foul Play makes. Foul Play's
own parser, inference, sampling and search run unchanged; only its connection is replaced.

stdin, one JSON object per line:
  {"type": "frame", "data": ">battle-gen9randombattle-1\\n|init|battle\\n..."}
  {"type": "stop"}                  (closing stdin also stops the worker)
stdout, one JSON object per line:
  {"type": "ready", "protocol": 1, "bot": "foulplay", "format": ..., "threads": N, "searchMs": 100}
  {"type": "battle", "room": R}
  {"type": "thinking", "room": R, "turn": T}
  {"type": "choice", "room": R, "turn": T, "choice": "/choose move tackle", "rqid": "3", "elapsedMs": 412}
  {"type": "end", "room": R, "result": "win" | "loss" | "tie"}     (from the bot's side)
  {"type": "error", "code": "..."}
stderr carries upstream diagnostics and is never parsed.

The worker never opens a network connection: an audit hook rejects any socket use that is not
IPv4 loopback (Windows asyncio needs a loopback socket pair internally).
"""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from importlib.metadata import version
import json
import logging
import os
from pathlib import Path
import re
import sys
import threading
import time

PROTOCOL = 1
FORMAT = "gen9randombattle"
BOT = "FoulPlay"
SEARCH_MS = 100
ENGINE_VERSION = "0.0.48"
MAX_LINE = 1 << 20
ROOM = re.compile(r"battle-gen9randombattle-\d{1,16}(?:-[a-z0-9]{1,32}pw)?")
CHOICE = re.compile(r"/choose move [a-z0-9]{1,40}(?: terastallize)?|/switch [1-6]")
LOOPBACK = "127.0.0.1"


def loopback_only(event, args):
    if event in {"socket.bind", "socket.connect", "socket.sendto", "socket.sendmsg", "socket.getnameinfo"}:
        address = args[0] if event == "socket.getnameinfo" else args[1]
        if isinstance(address, tuple) and len(address) == 2 and address[0] == LOOPBACK:
            return
    elif event in {"socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyname_ex", "socket.gethostbyaddr"}:
        if args[0] == LOOPBACK:
            return
    else:
        return
    raise PermissionError("The Foul Play worker has no network access")


def arguments(argv=None):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=1, choices=range(1, 17), metavar="1-16")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    if not args.source.is_absolute() or not (args.source / "fp" / "run_battle.py").is_file():
        parser.error("--source must be the absolute path of a Foul Play checkout")
    return args


def load(args):
    sys.path.insert(0, str(args.source))
    from fp.config import FoulPlayConfig, SaveReplay
    from fp.data.mods.apply_mods import apply_mods
    import fp.search.main as search

    if version("poke-engine") != ENGINE_VERSION:
        raise RuntimeError("Unsupported poke-engine version")
    if not (args.source / "fp" / "data" / "pkmn_sets_cache" / f"{FORMAT}.json").is_file():
        raise RuntimeError("Random battle sets are missing")
    # Keep every search inside this process so stopping it can never orphan workers.
    search.ProcessPoolExecutor = ThreadPoolExecutor
    config = FoulPlayConfig
    config.username = config.user_id = BOT
    config.pokemon_format = FORMAT
    config.search_time_ms = config.team_preview_search_time_ms = SEARCH_MS
    config.parallelism = config.team_preview_search_parallelism = 1
    config.search_threads = args.threads
    config.smogon_stats = None
    config.log_to_file = False
    config.save_replay = SaveReplay.never
    apply_mods(config.format_spec)


class Link:
    """Stands in for Foul Play's websocket client. Frames arrive from stdin, choices leave on stdout."""

    def __init__(self, frames, emit):
        self.frames = frames
        self.emit = emit
        self.room = None
        self.turn = 0
        self.thinking_since = None
        self.pending = []

    async def next_frame(self):
        frame = await self.frames.get()
        if frame is None:
            raise EOFError
        return frame

    async def wait_for_battle(self):
        while True:
            frame = await self.next_frame()
            lines = frame.split("\n")
            if lines[0].startswith(">") and ROOM.fullmatch(lines[0][1:]) and "|init|battle" in lines:
                self.room, self.turn, self.pending = lines[0][1:], 0, [frame]
                return self.room

    async def receive_message(self):
        while True:
            frame = self.pending.pop(0) if self.pending else await self.next_frame()
            lines = frame.split("\n")
            if lines[0] == f">{self.room}":
                break
        for line in lines:
            if line.startswith("|turn|"):
                try:
                    self.turn = max(0, min(10000, int(line.split("|")[2])))
                except ValueError:
                    pass
            elif line.startswith("|error|[Invalid choice]") or line.startswith("|error|[Unavailable choice]"):
                # Never fall back to random or default play: a rejected choice ends the session.
                raise RuntimeError("Foul Play choice rejected")
            elif line.startswith("|request|") and line[9:]:
                request = json.loads(line[9:])
                if request and not request.get("wait"):
                    self.thinking_since = time.monotonic()
                    self.emit("thinking", room=self.room, turn=self.turn or 1)
        return frame

    async def send_message(self, room, messages):
        if room != self.room or not messages or not CHOICE.fullmatch(messages[0]):
            return  # hf, gg, /timer on and anything else are not needed off the public server.
        rqid = messages[1] if len(messages) > 1 and re.fullmatch(r"\d{1,9}", messages[1]) else None
        elapsed = round((time.monotonic() - (self.thinking_since or time.monotonic())) * 1000)
        self.thinking_since = None
        self.emit("choice", room=room, turn=self.turn or 1, choice=messages[0], rqid=rqid, elapsedMs=max(0, elapsed))

    async def leave_battle(self, battle_tag):
        return

    async def save_replay(self, battle_tag):
        return


def read_stdin(loop, frames):
    stdin = sys.stdin.buffer
    while True:
        try:
            line = stdin.readline(MAX_LINE + 2)
        except (OSError, ValueError):
            break
        if not line or len(line) > MAX_LINE:
            break
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if not isinstance(message, dict) or message.get("type") == "stop":
            break
        if message.get("type") == "frame" and isinstance(message.get("data"), str):
            loop.call_soon_threadsafe(frames.put_nowait, message["data"])
    loop.call_soon_threadsafe(frames.put_nowait, None)


async def serve(args, emit):
    load(args)
    from fp.run_battle import pokemon_battle

    frames = asyncio.Queue()
    threading.Thread(target=read_stdin, args=(asyncio.get_running_loop(), frames), daemon=True).start()
    emit("ready", protocol=PROTOCOL, bot="foulplay", format=FORMAT, threads=args.threads, searchMs=SEARCH_MS)
    link = Link(frames, emit)
    while True:
        try:
            room = await link.wait_for_battle()
        except EOFError:
            return
        emit("battle", room=room)
        try:
            winner = await pokemon_battle(link, FORMAT, None)
        except EOFError:
            return
        emit("end", room=room, result="win" if winner == BOT else "tie" if winner is None else "loss")
        link.room = None


def check(args):
    load(args)
    import poke_engine
    from fp.run_battle import pokemon_battle  # noqa: F401 - proves the battle loop imports.

    if poke_engine.monte_carlo_tree_search(poke_engine.State(), 20, threads=1).total_visits <= 0:
        raise RuntimeError("Engine search returned no visits")


def main():
    args = arguments()
    sys.addaudithook(loopback_only)
    logging.disable(logging.CRITICAL)
    output = sys.stdout
    lock = threading.Lock()

    def emit(kind, **fields):
        with lock:
            print(json.dumps({"type": kind, **fields}), file=output, flush=True)

    with redirect_stdout(sys.stderr):
        try:
            if args.check:
                check(args)
                emit("checked", protocol=PROTOCOL, engine=ENGINE_VERSION)
                return 0
            asyncio.run(serve(args, emit))
        except Exception:
            import traceback
            traceback.print_exc()
            emit("error", code="engine-failed")
            return 1
    # Search threads may still be finishing a decision; nothing they produce is needed now.
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main())
