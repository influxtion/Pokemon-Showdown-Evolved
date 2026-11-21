"""Hosted Metamon Kakuna inference. JSON lines on stdio; no network access."""
import argparse
from contextlib import redirect_stdout
import json
import logging
import os
from pathlib import Path
import re
import sys
import time

MAX_LINE = 1 << 20


def no_network(event, args):
    # Windows asyncio uses a loopback socket pair internally. No remote sockets or DNS.
    if event in {"socket.bind", "socket.connect", "socket.sendto", "socket.sendmsg", "socket.getnameinfo"}:
        address = args[0] if event == "socket.getnameinfo" else args[1]
        if isinstance(address, tuple) and len(address) == 2 and address[0] == "127.0.0.1":
            return
        raise PermissionError("Metamon inference has no network access")
    if event in {"socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyname_ex", "socket.gethostbyaddr"} and args[0] != "127.0.0.1":
        raise PermissionError("Metamon inference has no network access")


def load(runtime, threads):
    os.environ.update(METAMON_CACHE_DIR=str(runtime / "cache"), WANDB_MODE="disabled",
                      HF_HUB_OFFLINE="1", HF_DATASETS_OFFLINE="1", ACCELERATE_USE_CPU="true",
                      TORCHDYNAMO_DISABLE="1", TOKENIZERS_PARALLELISM="false")
    sys.path.insert(0, str(runtime / "metamon"))
    import torch
    import numpy as np
    import gymnasium as gym
    import amago
    from functools import partial
    from amago.nets.transformer import SelfAttention
    from amago.nets.traj_encoders import TformerTrajEncoder
    from metamon.rl.pretrained import get_pretrained_model
    from metamon.rl.metamon_to_amago import MetamonPerceiverTstepEncoder

    torch.set_num_threads(min(threads, os.cpu_count() or 1))
    torch.set_num_interop_threads(1)

    class CPUAttention(SelfAttention):
        """Same causal 96-turn window as Kakuna's FlashAttention, using CPU SDPA."""
        def forward(self, qkv, key_cache=None, val_cache=None, cache_seqlens=None):
            q, k, v = qkv.unbind(dim=2)
            if key_cache is not None and cache_seqlens is not None:
                rows = torch.arange(q.shape[0])
                key_cache[rows, cache_seqlens] = k[:, 0].to(key_cache.dtype)
                val_cache[rows, cache_seqlens] = v[:, 0].to(val_cache.dtype)
                end = int(cache_seqlens.max()) + 1
                k = key_cache[:, :end].to(q.dtype)
                v = val_cache[:, :end].to(q.dtype)
                positions = torch.arange(end)[None, :]
                mask = (positions <= cache_seqlens[:, None]) & (positions >= cache_seqlens[:, None] - 96)
                mask = mask[:, None, None, :]
            else:
                length = q.shape[1]
                positions = torch.arange(length)
                delta = positions[:, None] - positions[None, :]
                mask = (delta >= 0) & (delta <= 96)
            return torch.nn.functional.scaled_dot_product_attention(
                q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2), attn_mask=mask,
                dropout_p=0.0).transpose(1, 2)

    model = get_pretrained_model("Kakuna")
    overrides = model.base_config | {"traj_encoders.TformerTrajEncoder.attention_type": CPUAttention}
    amago.cli_utils.use_config(overrides, [model.model_gin_config_path, model.train_gin_config_path], finalize=False)
    actions = model.action_space.gym_space
    obs_space = model.observation_space.gym_space
    obs_space["illegal_actions"] = gym.spaces.Box(low=0, high=1, shape=(actions.n,), dtype=bool)
    policy = amago.agent.MultiTaskAgent(obs_space=obs_space,
        rl2_space=gym.spaces.Box(low=-np.inf, high=np.inf, shape=(actions.n + 1,), dtype=np.float32),
        action_space=actions, tstep_encoder_type=MetamonPerceiverTstepEncoder,
        traj_encoder_type=partial(TformerTrajEncoder, attention_type=CPUAttention), max_seq_len=128)
    weights = torch.load(runtime / "model.pt", map_location="cpu", weights_only=True)
    policy.load_state_dict(weights, strict=True)
    del weights
    policy.on_checkpoint_loaded(is_resume=False)
    policy.eval()
    return model, policy


def serve(runtime, emit, check=False, threads=1):
    model, policy = load(runtime, threads)
    import torch
    import numpy as np
    from metamon.env.metamon_battle import MetamonBackendBattle
    from metamon.interface import UniversalState, UniversalAction
    if check:
        emit("checked")
        return
    emit("ready", protocol=1, bot="metamon", level="trained", format="gen9ou", threads=threads, searchMs=0)
    battle = None
    room = None
    seen = set()
    previous = None
    previous_action = None
    step = 0
    hidden = None
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not line:
            return
        if len(line) > MAX_LINE:
            raise ValueError("Frame too large")
        message = json.loads(line)
        if message.get("type") == "stop":
            return
        frame = message.get("data")
        if message.get("type") != "frame" or not isinstance(frame, str):
            raise ValueError("Invalid frame")
        lines = frame.split("\n")
        incoming = lines[0][1:]
        if not re.fullmatch(r"battle-gen9ou-\d{1,16}(?:-[a-z0-9]{1,32}pw)?", incoming):
            raise ValueError("Unsupported battle")
        if "|init|battle" in lines:
            room = incoming
            battle = MetamonBackendBattle(room, "Metamon", logging.getLogger("metamon"), False, 9)
            seen, previous, previous_action, step = set(), None, None, 0
            hidden = policy.init_hidden_state(1, torch.device("cpu"))
            model.observation_space.reset()
            emit("battle", room=room)
        if incoming != room or battle is None:
            raise ValueError("Unexpected room")
        request = None
        for entry in lines[1:]:
            if entry.startswith("|request|") and entry[9:]:
                request = json.loads(entry[9:])
            elif entry.startswith("|error|"):
                raise ValueError("Metamon choice rejected")
            elif entry.startswith("|"):
                battle.parse_message(entry.split("|"))
        if not request or request.get("wait") or request.get("rqid") in seen:
            continue
        emit("thinking", room=room, turn=battle.turn)
        seen.add(request["rqid"])
        started = time.monotonic()
        battle.parse_request(request)
        if request.get("teamPreview"):
            # Kakuna's published default uses a random team-preview order.
            order = np.random.permutation(len(request["side"]["pokemon"])) + 1
            choice = "/team " + "".join(map(str, order))
        else:
            state = UniversalState.from_Battle(battle)
            obs = model.observation_space(state)
            legal = UniversalAction.definitely_valid_actions(state, battle)
            legal_indices = {model.action_space.action_to_agent_output(state, action) for action in legal}
            if not legal_indices:
                raise ValueError("No legal actions")
            obs["illegal_actions"] = np.array([i not in legal_indices for i in range(model.action_space.gym_space.n)])
            rl2 = np.zeros((1, 1, model.action_space.gym_space.n + 1), dtype=np.float32)
            if previous_action is not None:
                rl2[0, 0, previous_action + 1] = 1
                rl2[0, 0, 0] = model.reward_function(previous, state)
            tensors = {key: torch.as_tensor(value)[None, None] for key, value in obs.items()}
            with torch.inference_mode():
                action, hidden = policy.get_actions(tensors, torch.from_numpy(rl2),
                    torch.tensor([[[step]]]), hidden_state=hidden, sample=True)
            index = int(action.item())
            if index not in legal_indices:
                raise ValueError("Model returned an illegal action")
            order = model.action_space.agent_output_to_action(state, index).to_BattleOrder(battle)
            choice = order.message
            # poke-env switches by name; our bridge accepts an unambiguous team slot.
            if choice.startswith("/choose switch "):
                ident = choice[len("/choose switch "):]
                slots = [i + 1 for i, p in enumerate(request["side"]["pokemon"]) if re.sub(r"[^a-z0-9]", "", p["ident"].split(": ", 1)[1].lower()) == re.sub(r"[^a-z0-9]", "", ident.lower())]
                if len(slots) != 1:
                    raise ValueError("Ambiguous switch")
                choice = f"/switch {slots[0]}"
            previous, previous_action = state, index
            step += 1
        emit("choice", room=room, choice=choice, rqid=str(request["rqid"]), elapsedMs=round((time.monotonic() - started) * 1000))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--threads", type=int, default=1, choices=range(1, 5))
    args = parser.parse_args()
    output = sys.stdout
    def emit(kind, **fields):
        print(json.dumps({"type": kind, **fields}), file=output, flush=True)
    sys.addaudithook(no_network)
    with redirect_stdout(sys.stderr):
        serve(args.runtime.resolve(), emit, args.check, args.threads)


if __name__ == "__main__":
    main()
