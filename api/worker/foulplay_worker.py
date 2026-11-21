"""Foul Play inference worker. One process per practice session, driven over stdio.

The battle itself runs elsewhere (on the player's computer). The API server feeds this worker the
bot's view of the battle, frame by frame, and relays back the choices Foul Play makes. Foul Play's
own parser, inference, sampling and search run unchanged; only its connection is replaced, and
the weaker levels adjust how long it searches and how it picks among the moves it found.

Arguments: --source <Foul Play checkout> [--threads 1-16] [--level hard|medium|casual]
           [--format gen9randombattle|gen9ou|gen9anythinggoes] [--check]

stdin, one JSON object per line:
  {"type": "team", "data": "<Showdown export>"}   first line, team formats only: the bot's own team
  {"type": "frame", "data": ">battle-gen9randombattle-1\\n|init|battle\\n..."}
  {"type": "stop"}                  (closing stdin also stops the worker)
stdout, one JSON object per line:
  {"type": "ready", "protocol": 1, "bot": "foulplay", "level": ..., "format": ..., "threads": N, "searchMs": 100}
  {"type": "battle", "room": R}
  {"type": "thinking", "room": R, "turn": T}
  {"type": "choice", "room": R, "turn": T, "choice": "/choose move tackle", "rqid": "3", "elapsedMs": 412}
  {"type": "end", "room": R, "result": "win" | "loss" | "tie"}     (from the bot's side)
  {"type": "error", "code": "..."}
stderr carries upstream diagnostics and is never parsed. The team is never written anywhere.

The worker never opens a network connection: an audit hook rejects any socket use that is not
IPv4 loopback (Windows asyncio needs a loopback socket pair internally). Everything Foul Play
would download (set data, usage stats) is installed beforehand by install.js.
"""
import argparse
import asyncio
from concurrent.futures import CancelledError, ThreadPoolExecutor
from contextlib import redirect_stdout
from importlib.metadata import version
import json
import logging
import os
from pathlib import Path
import random
import re
import sys
import threading
import time

PROTOCOL = 1
FORMATS = ("gen9randombattle", "gen9ou", "gen9anythinggoes")
BOT = "FoulPlay"
ENGINE_VERSION = "0.0.48"
MAX_LINE = 1 << 20
MAX_QUEUED_FRAMES = 16
MAX_TEAM = 8192
CHOICE = re.compile(r"/choose move [a-z0-9]{1,40}(?: terastallize)?|/switch [1-6]|/team [1-6]{1,6}")
GUEST = re.compile(r"[A-Za-z][A-Za-z0-9]{2,17}")
LOOPBACK = "127.0.0.1"

# How each level searches and picks. Hard is Foul Play exactly as upstream ships it.
#   searchMs  time per sampled world
#   worlds    sampled worlds per decision; None keeps Foul Play's own count
#   keep      moves within this share of the best are candidates (upstream: 0.75)
#   slip      chance of playing the second- or third-best candidate instead
#   floor     a slip only picks a move with at least this share of the best move's
LEVELS = {
    "hard": {"searchMs": 100, "worlds": None, "keep": 0.75, "slip": 0.0, "floor": 1.0},
    "medium": {"searchMs": 40, "worlds": None, "keep": 0.5, "slip": 0.0, "floor": 1.0},
    "casual": {"searchMs": 15, "worlds": 1, "keep": 0.75, "slip": 0.35, "floor": 0.2},
}
# Files Foul Play reads for OU instead of downloading them (see install.js).
OU_DATA = (
    ("smogon_stats_cache", "gen9ou-0.json"),
    ("pkmn_sets_cache", "gen9ou", "showdown_sets.json"),
    ("pkmn_sets_cache", "gen9ou", "pokemon_full_sets.json"),
    ("pkmn_sets_cache", "gen9ou", "replay_moves.json"),
)


def room_pattern(battle_format):
    return re.compile(rf"battle-{battle_format}-\d{{1,16}}(?:-[a-z0-9]{{1,32}}pw)?")


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
    parser.add_argument("--level", default="hard", choices=tuple(LEVELS))
    parser.add_argument("--format", default=FORMATS[0], choices=FORMATS)
    # The account the bot plays as. The API always uses the default; tests pit two workers
    # against each other under different names.
    parser.add_argument("--account", default=BOT)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    if not args.source.is_absolute() or not (args.source / "fp" / "run_battle.py").is_file():
        parser.error("--source must be the absolute path of a Foul Play checkout")
    if not GUEST.fullmatch(args.account):
        parser.error("--account must be a plain guest name")
    return args


def data_files(source, battle_format="gen9ou"):
    if battle_format == "gen9anythinggoes":
        return [source / "fp/data/smogon_stats_cache/gen9anythinggoes-0.json"]
    return [source.joinpath("fp", "data", *parts) for parts in OU_DATA]


def apply_level(level):
    """Weaker levels search less and pick less strictly. Hard leaves Foul Play untouched."""
    settings = LEVELS[level]
    if level == "hard":
        return
    import fp.search.main as search
    from fp.modes.random_battle import RandomBattleMode
    from fp.modes.standard_battle import StandardBattleMode

    for mode in (RandomBattleMode, StandardBattleMode):
        upstream = mode.search_params

        def search_params(self, battle, upstream=upstream):
            worlds, ms = upstream(self, battle)
            return (settings["worlds"] or worlds), ms

        mode.search_params = search_params

    def select(mcts_results):
        policy = {}
        for result, chance, _index in mcts_results:
            for option in result.side_one:
                share = chance * option.visits / result.total_visits
                policy[option.move_choice] = policy.get(option.move_choice, 0) + share
        ranked = sorted(policy.items(), key=lambda item: item[1], reverse=True)
        best = ranked[0][1]
        if settings["slip"] and random.random() < settings["slip"]:
            # A believable mistake: a move the search also liked, never one it nearly ignored.
            near = [item for item in ranked[1:3] if item[1] >= best * settings["floor"]]
            if near:
                return random.choices(near, weights=[item[1] for item in near])[0][0]
        candidates = [item for item in ranked if item[1] >= best * settings["keep"]]
        return random.choices(candidates, weights=[item[1] for item in candidates])[0][0]

    search.select_move_from_mcts_results = select


def load(args):
    sys.path.insert(0, str(args.source))
    from fp.config import FoulPlayConfig, SaveReplay
    from fp.data.mods.apply_mods import apply_mods
    import fp.search.main as search

    if version("poke-engine") != ENGINE_VERSION:
        raise RuntimeError("Unsupported poke-engine version")
    if not (args.source / "fp" / "data" / "pkmn_sets_cache" / "gen9randombattle.json").is_file():
        raise RuntimeError("Random battle sets are missing")
    if args.format != FORMATS[0] and not all(path.is_file() for path in data_files(args.source, args.format)):
        raise RuntimeError("Team format set data is missing")
    # Keep every search inside this process so stopping it can never orphan workers.
    search.ProcessPoolExecutor = ThreadPoolExecutor
    config = FoulPlayConfig
    config.username = config.user_id = args.account
    config.pokemon_format = args.format
    config.search_time_ms = config.team_preview_search_time_ms = LEVELS[args.level]["searchMs"]
    config.parallelism = config.team_preview_search_parallelism = 1
    config.search_threads = args.threads
    config.smogon_stats = None
    config.log_to_file = False
    config.save_replay = SaveReplay.never
    apply_mods(config.format_spec)
    apply_level(args.level)
    # Requests preserve team slot order at initialization. Match our own nature/EVs
    # by slot, since Anything Goes allows multiple sets of the same species.
    from fp.battle.state import Battler
    initialize = Battler.initialize_first_turn_user_from_json

    def initialize_slots(self, request):
        team = self.team_dict
        self.team_dict = None
        try:
            initialize(self, request)
        finally:
            self.team_dict = team
        if team is not None:
            for pokemon in [self.active] + self.reserve:
                if pokemon is None:
                    continue
                member = team[pokemon.index - 1]
                pokemon.nature = member["nature"] or "serious"
                pokemon.evs = tuple(int(member["evs"][stat] or 0) for stat in ("hp", "atk", "def", "spa", "spd", "spe"))

    Battler.initialize_first_turn_user_from_json = initialize_slots
    if args.format == "gen9anythinggoes":
        # AG has usage stats but no pinned full-set corpus. Use upstream's Smogon
        # trait/move sampler, without fetching missing full-set endpoints in battle.
        from fp.data.sets import TeamDatasets
        TeamDatasets._get_sets_dict = lambda self: {}
        TeamDatasets._get_moves_dict = lambda self: {}
        # Upstream uses species equality for reserve membership, which drops a
        # duplicate when it switches out. Preserve individual battle objects.
        from fp.battle.state import Pokemon
        import fp.battle.protocol as protocol
        Pokemon.__eq__ = lambda self, other: self is other
        upstream_switch = protocol.switch_or_drag

        def switch_with_identity(battle, message, switch_or_drag="switch"):
            side = battle.opponent if protocol.is_opponent(battle, message) else battle.user
            nickname = Pokemon.extract_nickname_from_pokemonshowdown_string(message[2])
            matching = [p for p in side.reserve if p.nickname == nickname]
            if len(matching) == 1:
                chosen = matching[0]
                side.reserve = [chosen] + [p for p in side.reserve if p is not chosen]
            return upstream_switch(battle, message, switch_or_drag)

        protocol.switch_or_drag = switch_with_identity
        update = Battler.update_from_request_json

        def update_slots(self, request):
            # Upstream's update asks for inactive Pokemon by species. Resolve
            # those calls in request order using the nickname already tracked.
            pending = iter(p for p in request["side"]["pokemon"] if not p["active"])
            original = self.find_pokemon_in_reserves

            def find(name):
                entry = next(pending)
                nickname = Pokemon.extract_nickname_from_pokemonshowdown_string(entry["ident"])
                matching = [p for p in self.reserve if p.nickname == nickname]
                return matching[0] if len(matching) == 1 else original(name)

            self.find_pokemon_in_reserves = find
            try:
                return update(self, request)
            finally:
                del self.find_pokemon_in_reserves

        Battler.update_from_request_json = update_slots
        import fp.modes.base as base
        format_decision = base.format_decision

        def format_ag_decision(battle, decision):
            if decision.startswith("switch "):
                species = decision[7:]
                candidates = [p for p in battle.user.reserve if p.name == species and p.hp > 0 and not p.fainted]
                if candidates:
                    return [f"/switch {candidates[0].index}", str(battle.rqid)]
            return format_decision(battle, decision)

        base.format_decision = format_ag_decision



def read_team(source, text):
    """The bot's own team, from a Showdown export, as Foul Play's team dictionary."""
    sys.path.insert(0, str(source))
    from fp.data import pokedex
    from fp.teams.team_converter import export_to_dict

    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEAM:
        raise ValueError("No team")
    team = export_to_dict(text.replace("\r\n", "\n"))
    if not 1 <= len(team) <= 6:
        raise ValueError("A team has one to six Pokemon")
    for member in team:
        # Showdown exports the base form, while the request names its crowned form.
        if (member["species"], member["item"]) in {("zacian", "rustedsword"), ("zamazenta", "rustedshield")}:
            member["species"] += "crowned"
        if member["species"] not in pokedex or not 1 <= len(member["moves"]) <= 4:
            raise ValueError("Unreadable team")
    return team


class Link:
    """Stands in for Foul Play's websocket client. Frames arrive from stdin, choices leave on stdout."""

    def __init__(self, frames, emit, room):
        self.frames = frames
        self.emit = emit
        self.pattern = room
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
            if lines[0].startswith(">") and self.pattern.fullmatch(lines[0][1:]) and "|init|battle" in lines:
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
        if room != self.room or not messages:
            return
        # Team preview sends "/team 213456|<rqid>" as one message; every other choice sends the
        # rqid separately.
        choice, _, embedded = messages[0].partition("|")
        if not CHOICE.fullmatch(choice):
            return  # hf, gg, /timer on and anything else are not needed off the public server.
        rqid = embedded or (messages[1] if len(messages) > 1 else "")
        rqid = rqid if re.fullmatch(r"\d{1,9}", rqid) else None
        elapsed = round((time.monotonic() - (self.thinking_since or time.monotonic())) * 1000)
        self.thinking_since = None
        self.emit("choice", room=room, turn=self.turn or 1, choice=choice, rqid=rqid, elapsedMs=max(0, elapsed))

    async def leave_battle(self, battle_tag):
        return

    async def save_replay(self, battle_tag):
        return


def read_stdin(loop, frames, stdin):
    def put(value):
        pending = frames.put(value)
        try:
            # Block this reader when the engine falls behind, so the API's pipe limit applies.
            asyncio.run_coroutine_threadsafe(pending, loop).result()
            return True
        except RuntimeError:
            pending.close()
            return False
        except CancelledError:
            return False

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
            if not put(message["data"]):
                return
    put(None)


def first_team(stdin):
    line = stdin.readline(MAX_LINE + 2)
    try:
        message = json.loads(line)
    except ValueError:
        message = None
    if not isinstance(message, dict) or message.get("type") != "team":
        raise ValueError("Expected the bot's team first")
    return message.get("data")


async def serve(args, emit, team):
    load(args)
    from fp.run_battle import pokemon_battle

    frames = asyncio.Queue(maxsize=MAX_QUEUED_FRAMES)
    stdin = sys.stdin.buffer
    threading.Thread(target=read_stdin, args=(asyncio.get_running_loop(), frames, stdin), daemon=True).start()
    emit("ready", protocol=PROTOCOL, bot="foulplay", level=args.level, format=args.format, threads=args.threads,
         searchMs=LEVELS[args.level]["searchMs"])
    link = Link(frames, emit, room_pattern(args.format))
    while True:
        try:
            room = await link.wait_for_battle()
        except EOFError:
            return
        emit("battle", room=room)
        try:
            # Foul Play keeps notes on its own team dictionary; every battle gets a fresh copy.
            winner = await pokemon_battle(link, args.format, json.loads(json.dumps(team)) if team else None)
        except EOFError:
            return
        emit("end", room=room, result="win" if winner == args.account else "tie" if winner is None else "loss")
        link.room = None


def check(args):
    load(args)
    import poke_engine
    from fp.run_battle import pokemon_battle  # noqa: F401 - proves the battle loop imports.

    if poke_engine.monte_carlo_tree_search(poke_engine.State(), 20, threads=1).total_visits <= 0:
        raise RuntimeError("Engine search returned no visits")
    if args.format != FORMATS[0]:
        # Proves the installed OU data loads without a download.
        from fp.data.sets import SmogonSets, TeamDatasets
        from fp.format_spec import FormatSpec

        spec = FormatSpec.from_format_string(args.format)
        smogon, sets = SmogonSets(), TeamDatasets()
        smogon.initialize(spec, {"greattusk", "kingambit"})
        sets.initialize(spec, {"greattusk", "kingambit"})
        if not smogon.all_pkmn_counts or (args.format == "gen9ou" and not sets.pkmn_sets.get("greattusk")):
            raise RuntimeError("OU set data did not load")


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
                emit("checked", protocol=PROTOCOL, engine=ENGINE_VERSION, format=args.format)
                return 0
            team = None
            if args.format != "gen9randombattle":
                try:
                    team = read_team(args.source, first_team(sys.stdin.buffer))
                except Exception:
                    emit("error", code="invalid-team")
                    return 1
            asyncio.run(serve(args, emit, team))
        except Exception:
            import traceback
            traceback.print_exc()
            emit("error", code="engine-failed")
            return 1
    # Search threads may still be finishing a decision; nothing they produce is needed now.
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main())
