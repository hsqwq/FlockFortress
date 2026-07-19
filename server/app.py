#!/usr/bin/env python3
"""Flock Fortress: dependency-free HTTP/WebSocket game server."""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import logging
import mimetypes
import os
import secrets
import signal
import struct
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional
from urllib.parse import unquote, urlsplit

LOG = logging.getLogger("flock-fortress")
STARTED_AT = time.monotonic()
ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"

MAX_CONNECTIONS = 40
MAX_ROOMS = 10
MAX_MESSAGE = 16 * 1024
MAX_QUEUE_BYTES = 128 * 1024
MAX_MESSAGES_PER_10S = 220
IDLE_TIMEOUT = 70
ROOM_TTL = 180
WORLD = {"width": 1200, "height": 675, "ground": 590, "buildMinX": 700, "buildMaxX": 1165}

BIRDS = {
    "red": {"name": "红羽", "cost": 70, "ability": "冲击", "power": 1.0},
    "yellow": {"name": "疾风", "cost": 105, "ability": "加速", "power": 0.84},
    "blue": {"name": "霜蓝", "cost": 120, "ability": "分裂", "power": 0.72},
    "bomb": {"name": "黑曜", "cost": 155, "ability": "爆破", "power": 1.25},
}

ITEMS = {
    "wood_beam": {"name": "木横梁", "cost": 45, "w": 110, "h": 20, "hp": 80, "material": "wood"},
    "wood_post": {"name": "木立柱", "cost": 45, "w": 22, "h": 100, "hp": 80, "material": "wood"},
    "stone_beam": {"name": "石横梁", "cost": 75, "w": 105, "h": 24, "hp": 155, "material": "stone"},
    "stone_post": {"name": "石立柱", "cost": 75, "w": 26, "h": 95, "hp": 155, "material": "stone"},
    "glass_beam": {"name": "玻璃梁", "cost": 30, "w": 105, "h": 16, "hp": 42, "material": "glass"},
    "pig": {"name": "小猪", "cost": 90, "w": 42, "h": 42, "hp": 100, "material": "pig"},
}


class ProtocolError(Exception):
    pass


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def snap(value: Any, low: float, high: float) -> float:
    """Snap to the 5px build grid without letting odd-sized items cross a boundary."""
    return clamp(round(float(value) / 5) * 5, low, high)


def clean_name(value: Any) -> str:
    text = "".join(ch for ch in str(value or "") if ch.isprintable()).strip()
    return text[:16] or "匿名玩家"


def public_item(item: dict[str, Any]) -> dict[str, Any]:
    return {key: item[key] for key in ("id", "kind", "x", "y", "w", "h", "hp", "maxHp", "material")} | {"angle": item.get("angle", 0)}


def overlap(a: dict[str, Any], b: dict[str, Any], margin: float = 2) -> bool:
    return (abs(a["x"] - b["x"]) < (a["w"] + b["w"]) / 2 - margin and
            abs(a["y"] - b["y"]) < (a["h"] + b["h"]) / 2 - margin)


def validate_construction(items: list[dict[str, Any]], require_complete: bool = False) -> Optional[str]:
    pigs = sum(1 for item in items if item["kind"] == "pig")
    if pigs > 3:
        return "每回合最多安置 3 只猪"
    if require_complete and not 1 <= pigs <= 3:
        return "需要安置 1–3 只猪"
    for index, item in enumerate(items):
        if item["x"] - item["w"] / 2 < WORLD["buildMinX"] or item["x"] + item["w"] / 2 > WORLD["buildMaxX"]:
            return "物品超出防守建造区"
        if item["y"] - item["h"] / 2 < 80 or item["y"] + item["h"] / 2 > WORLD["ground"]:
            return "物品超出场地边界"
        for other in items[index + 1:]:
            if overlap(item, other):
                return "物品不能互相重叠"
    if require_complete:
        supported: set[str] = set()
        for item in items:
            if WORLD["ground"] - (item["y"] + item["h"] / 2) <= 7:
                supported.add(item["id"])
        changed = True
        while changed:
            changed = False
            for item in items:
                if item["id"] in supported:
                    continue
                bottom = item["y"] + item["h"] / 2
                for base in items:
                    if base["id"] not in supported or base["id"] == item["id"]:
                        continue
                    top = base["y"] - base["h"] / 2
                    horizontal = min(item["x"] + item["w"] / 2, base["x"] + base["w"] / 2) - max(item["x"] - item["w"] / 2, base["x"] - base["w"] / 2)
                    if -3 <= top - bottom <= 10 and horizontal >= min(16, item["w"] * .35):
                        supported.add(item["id"])
                        changed = True
                        break
        if len(supported) != len(items):
            return "存在悬空或未与地面相连的物品"
    return None


@dataclass(eq=False)
class Client:
    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter
    peer: str
    room: Optional["Room"] = None
    role: Optional[str] = None
    token: Optional[str] = None
    last_seen: float = field(default_factory=time.monotonic)
    events: deque[float] = field(default_factory=deque)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    closed: bool = False

    async def send(self, payload: dict[str, Any]) -> None:
        if self.closed:
            return
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        if len(raw) > MAX_QUEUE_BYTES:
            raise ProtocolError("outgoing message too large")
        if len(raw) < 126:
            head = bytes((0x81, len(raw)))
        elif len(raw) < 65536:
            head = bytes((0x81, 126)) + struct.pack("!H", len(raw))
        else:
            head = bytes((0x81, 127)) + struct.pack("!Q", len(raw))
        async with self.send_lock:
            self.writer.write(head + raw)
            try:
                await asyncio.wait_for(self.writer.drain(), 3)
            except (asyncio.TimeoutError, ConnectionError):
                self.closed = True
                self.writer.close()

    async def error(self, message: str, code: str = "invalid") -> None:
        await self.send({"type": "error", "code": code, "message": message})


class Room:
    def __init__(self, code: str, owner: Client, name: str):
        self.code = code
        self.created = time.monotonic()
        self.touched = time.monotonic()
        self.players: dict[str, Optional[Client]] = {"bird": owner, "pig": None}
        self.names = {"bird": name, "pig": "等待加入"}
        self.tokens = {"bird": secrets.token_urlsafe(18), "pig": ""}
        self.phase = "waiting"
        self.round = 1
        self.scores = {"bird": 0, "pig": 0}
        self.credits = {"bird": 500, "pig": 700}
        self.loss_streak = {"bird": 0, "pig": 0}
        self.ready: set[str] = set()
        self.next_ready: set[str] = set()
        self.bird_queue: list[str] = []
        self.items: list[dict[str, Any]] = []
        self.active_bird: Optional[str] = None
        self.shot_started = 0.0
        self.winner: Optional[str] = None
        self.event_id = 0

    def state(self) -> dict[str, Any]:
        return {
            "type": "state", "room": self.code, "phase": self.phase, "round": self.round,
            "scores": self.scores, "credits": self.credits, "names": self.names,
            "connected": {role: bool(client and not client.closed) for role, client in self.players.items()},
            "ready": sorted(self.ready), "birdQueue": self.bird_queue,
            "items": [public_item(item) for item in self.items], "activeBird": self.active_bird,
            "winner": self.winner, "eventId": self.event_id,
        }

    async def broadcast(self, payload: Optional[dict[str, Any]] = None) -> None:
        self.touched = time.monotonic()
        self.event_id += 1
        message = payload or self.state()
        if payload is None:
            message["eventId"] = self.event_id
        await asyncio.gather(*(client.send(message) for client in self.players.values() if client and not client.closed), return_exceptions=True)

    async def notify_state(self) -> None:
        await self.broadcast()

    def prepare_round(self) -> None:
        self.phase = "fortify"
        self.ready.clear()
        self.next_ready.clear()
        self.bird_queue.clear()
        self.items.clear()
        self.active_bird = None
        self.winner = None

    async def finish_round(self, winner: str, reason: str) -> None:
        if self.phase != "battle":
            return
        self.phase = "round_end"
        self.winner = winner
        self.scores[winner] += 1
        loser = "pig" if winner == "bird" else "bird"
        self.loss_streak[loser] = min(3, self.loss_streak[loser] + 1)
        self.loss_streak[winner] = 0
        self.credits[winner] = min(1200, self.credits[winner] + 150)
        self.credits[loser] = min(1200, self.credits[loser] + 240 + 60 * self.loss_streak[loser])
        if self.scores[winner] >= 3:
            self.phase = "match_end"
        await self.broadcast({"type": "round_result", "winner": winner, "reason": reason, "state": self.state()})


ROOMS: dict[str, Room] = {}
CLIENTS: set[Client] = set()


async def detach_client(client: Client) -> None:
    """Detach a socket and immediately discard a room once nobody remains online."""
    room, role = client.room, client.role
    if not room or not role or room.players.get(role) is not client:
        return
    room.players[role] = None
    connected = any(peer and not peer.closed for peer in room.players.values())
    if not connected:
        if ROOMS.pop(room.code, None) is not None:
            LOG.info("removed empty room %s", room.code)
        return
    await room.broadcast({"type": "disconnected", "role": role, "grace": ROOM_TTL})


def room_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    for _ in range(50):
        code = "".join(secrets.choice(alphabet) for _ in range(6))
        if code not in ROOMS:
            return code
    raise ProtocolError("暂时无法创建更多房间")


async def handle_message(client: Client, data: dict[str, Any]) -> None:
    kind = data.get("type")
    client.last_seen = time.monotonic()
    now = client.last_seen
    client.events.append(now)
    while client.events and now - client.events[0] > 10:
        client.events.popleft()
    if len(client.events) > MAX_MESSAGES_PER_10S:
        raise ProtocolError("消息发送过于频繁")

    if kind == "ping":
        await client.send({"type": "pong", "at": int(time.time())})
        return
    if kind == "create_room":
        if client.room:
            return await client.error("你已在房间中")
        if len(ROOMS) >= MAX_ROOMS:
            return await client.error("房间已满，请稍后重试", "capacity")
        code = room_code()
        room = Room(code, client, clean_name(data.get("name")))
        ROOMS[code] = room
        client.room, client.role, client.token = room, "bird", room.tokens["bird"]
        await client.send({"type": "joined", "room": code, "role": "bird", "token": client.token})
        await room.notify_state()
        return
    if kind in ("join_room", "resume"):
        if client.room:
            return await client.error("你已在房间中")
        code = str(data.get("room", "")).strip().upper()
        room = ROOMS.get(code)
        if not room:
            return await client.error("找不到该房间", "not_found")
        if kind == "resume":
            token = str(data.get("token", ""))
            role = next((key for key, value in room.tokens.items() if secrets.compare_digest(value, token)), None)
            if not role:
                return await client.error("重连凭据已失效", "resume_failed")
            old = room.players[role]
            if old:
                old.closed = True
                old.writer.close()
            room.players[role] = client
        else:
            if room.players["pig"] is not None or room.phase != "waiting":
                return await client.error("房间已满或对局已开始", "room_full")
            role = "pig"
            room.tokens[role] = secrets.token_urlsafe(18)
            room.players[role] = client
            room.names[role] = clean_name(data.get("name"))
            room.prepare_round()
        client.room, client.role, client.token = room, role, room.tokens[role]
        await client.send({"type": "joined", "room": code, "role": role, "token": client.token})
        await room.notify_state()
        return

    room, role = client.room, client.role
    if not room or not role:
        return await client.error("请先创建或加入房间")
    if kind == "leave_room":
        await detach_client(client)
        client.room = None
        client.role = None
        client.token = None
        await client.send({"type": "left"})
        return
    if kind == "buy_bird":
        if role != "bird" or room.phase != "fortify" or role in room.ready:
            return await client.error("当前不能购买小鸟")
        bird = str(data.get("bird", ""))
        spec = BIRDS.get(bird)
        if not spec:
            return await client.error("未知的小鸟")
        if len(room.bird_queue) >= 6:
            return await client.error("每回合最多携带 6 只小鸟")
        if room.credits[role] < spec["cost"]:
            return await client.error("钱币不足")
        room.credits[role] -= spec["cost"]
        room.bird_queue.append(bird)
        await room.notify_state()
        return
    if kind == "sell_bird":
        if role != "bird" or room.phase != "fortify" or role in room.ready:
            return await client.error("当前不能调整小鸟")
        index = int(data.get("index", -1))
        if not 0 <= index < len(room.bird_queue):
            return await client.error("无效的小鸟")
        bird = room.bird_queue.pop(index)
        room.credits[role] = min(1200, room.credits[role] + BIRDS[bird]["cost"])
        await room.notify_state()
        return
    if kind == "build":
        if role != "pig" or room.phase != "fortify" or role in room.ready:
            return await client.error("当前不能建造")
        action = data.get("action")
        if action == "add":
            item_kind = str(data.get("kind", ""))
            spec = ITEMS.get(item_kind)
            if not spec:
                return await client.error("未知的防御物品")
            if len(room.items) >= 28:
                return await client.error("每回合最多放置 28 件物品")
            if item_kind == "pig" and sum(item["kind"] == "pig" for item in room.items) >= 3:
                return await client.error("最多安置 3 只猪")
            if room.credits[role] < spec["cost"]:
                return await client.error("钱币不足")
            item = {"id": secrets.token_hex(4), "kind": item_kind,
                    "x": snap(data.get("x", 900), WORLD["buildMinX"] + spec["w"] / 2, WORLD["buildMaxX"] - spec["w"] / 2),
                    "y": snap(data.get("y", 500), 80 + spec["h"] / 2, WORLD["ground"] - spec["h"] / 2),
                    "w": spec["w"], "h": spec["h"], "hp": spec["hp"], "maxHp": spec["hp"], "material": spec["material"], "angle": 0}
            problem = validate_construction(room.items + [item])
            if problem:
                return await client.error(problem)
            room.credits[role] -= spec["cost"]
            room.items.append(item)
        elif action == "move":
            item = next((it for it in room.items if it["id"] == data.get("id")), None)
            if not item:
                return await client.error("物品不存在")
            old = (item["x"], item["y"])
            item["x"] = snap(data.get("x", item["x"]), WORLD["buildMinX"] + item["w"] / 2, WORLD["buildMaxX"] - item["w"] / 2)
            item["y"] = snap(data.get("y", item["y"]), 80 + item["h"] / 2, WORLD["ground"] - item["h"] / 2)
            problem = validate_construction(room.items)
            if problem:
                item["x"], item["y"] = old
                return await client.error(problem)
        elif action == "remove":
            item = next((it for it in room.items if it["id"] == data.get("id")), None)
            if not item:
                return await client.error("物品不存在")
            room.items.remove(item)
            room.credits[role] = min(1200, room.credits[role] + ITEMS[item["kind"]]["cost"])
        else:
            return await client.error("无效的建造操作")
        await room.notify_state()
        return
    if kind == "ready":
        if room.phase != "fortify":
            return await client.error("当前不能准备")
        if role == "bird" and not room.bird_queue:
            return await client.error("至少购买 1 只小鸟")
        if role == "pig":
            problem = validate_construction(room.items, True)
            if problem:
                return await client.error(problem)
        room.ready.add(role)
        if len(room.ready) == 2:
            room.phase = "battle"
        await room.notify_state()
        return
    if kind == "unready":
        if room.phase == "fortify":
            room.ready.discard(role)
            await room.notify_state()
        return
    if kind == "fire":
        if role != "bird" or room.phase != "battle" or room.active_bird or not room.bird_queue:
            return await client.error("当前不能发射")
        vx, vy = float(data.get("vx", 0)), float(data.get("vy", 0))
        if not 180 <= vx <= 1050 or not -850 <= vy <= 500 or (vx * vx + vy * vy) ** .5 > 1120:
            return await client.error("发射力度不合法")
        room.active_bird = room.bird_queue.pop(0)
        room.shot_started = time.monotonic()
        await room.broadcast({"type": "fired", "bird": room.active_bird, "vx": round(vx, 2), "vy": round(vy, 2), "queue": room.bird_queue})
        return
    if kind == "sim":
        if role != "bird" or room.phase != "battle" or not room.active_bird:
            return
        entities = data.get("entities", [])
        if not isinstance(entities, list) or len(entities) > 36:
            return await client.error("同步状态过大")
        safe = []
        valid_ids = {item["id"] for item in room.items}
        for entity in entities:
            if entity.get("id") not in valid_ids:
                continue
            safe.append({"id": entity["id"], "x": round(clamp(float(entity.get("x", 0)), -100, 1300), 1),
                         "y": round(clamp(float(entity.get("y", 0)), -100, 800), 1),
                         "vx": round(clamp(float(entity.get("vx", 0)), -1500, 1500), 1),
                         "vy": round(clamp(float(entity.get("vy", 0)), -1500, 1500), 1),
                         "angle": round(clamp(float(entity.get("angle", 0)), -3.2, 3.2), 3),
                         "hp": round(clamp(float(entity.get("hp", 0)), 0, 200), 1)})
        raw_bird = data.get("bird")
        safe_bird = None
        if isinstance(raw_bird, dict):
            safe_bird = {"x": round(clamp(float(raw_bird.get("x", 0)), -100, 1300), 1),
                         "y": round(clamp(float(raw_bird.get("y", 0)), -100, 800), 1),
                         "angle": round(clamp(float(raw_bird.get("angle", 0)), -3.2, 3.2), 3)}
        await room.broadcast({"type": "sim", "entities": safe, "bird": safe_bird})
        return
    if kind == "shot_end":
        if role != "bird" or room.phase != "battle" or not room.active_bird or time.monotonic() - room.shot_started < .6:
            return await client.error("当前不能结束发射")
        updates = data.get("entities", [])
        previous_pigs = sum(item["kind"] == "pig" and item["hp"] > 0 for item in room.items)
        destroyed_blocks = 0
        for update in updates if isinstance(updates, list) else []:
            item = next((it for it in room.items if it["id"] == update.get("id")), None)
            if not item:
                continue
            new_hp = clamp(float(update.get("hp", item["hp"])), 0, item["hp"])
            if item["hp"] > 0 and new_hp <= 0 and item["kind"] != "pig":
                destroyed_blocks += 1
            item["hp"] = round(new_hp, 1)
            item["x"] = round(clamp(float(update.get("x", item["x"])), -100, 1300), 1)
            item["y"] = round(clamp(float(update.get("y", item["y"])), -100, 800), 1)
            item["angle"] = round(clamp(float(update.get("angle", item.get("angle", 0))), -3.2, 3.2), 3)
        current_pigs = sum(item["kind"] == "pig" and item["hp"] > 0 for item in room.items)
        killed = previous_pigs - current_pigs
        room.credits["bird"] = min(1200, room.credits["bird"] + destroyed_blocks * 8 + killed * 55)
        room.active_bird = None
        if current_pigs == 0:
            await room.finish_round("bird", "全部小猪被消灭")
        elif not room.bird_queue:
            await room.finish_round("pig", "小鸟已全部用尽")
        else:
            await room.notify_state()
        return
    if kind == "next_round":
        if room.phase not in ("round_end", "match_end"):
            return await client.error("当前不能进入下一回合")
        room.next_ready.add(role)
        if room.phase == "round_end" and len(room.next_ready) == 2:
            room.round += 1
            room.prepare_round()
            await room.notify_state()
        elif room.phase == "match_end" and len(room.next_ready) == 2:
            room.round = 1
            room.scores = {"bird": 0, "pig": 0}
            room.credits = {"bird": 500, "pig": 700}
            room.loss_streak = {"bird": 0, "pig": 0}
            room.prepare_round()
            await room.notify_state()
        else:
            await room.broadcast({"type": "next_wait", "roles": sorted(room.next_ready)})
        return
    if kind == "emote":
        emote = str(data.get("emote", ""))[:8]
        if emote in ("👍", "😄", "😱", "💥", "🐦", "🐷"):
            await room.broadcast({"type": "emote", "role": role, "emote": emote})
        return
    await client.error("未知消息类型")


async def read_frame(client: Client) -> Optional[str]:
    head = await asyncio.wait_for(client.reader.readexactly(2), IDLE_TIMEOUT)
    first, second = head
    opcode, masked, length = first & 0x0F, bool(second & 0x80), second & 0x7F
    if not masked:
        raise ProtocolError("client frames must be masked")
    if length == 126:
        length = struct.unpack("!H", await client.reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", await client.reader.readexactly(8))[0]
    if length > MAX_MESSAGE:
        raise ProtocolError("message too large")
    mask = await client.reader.readexactly(4)
    raw = await client.reader.readexactly(length)
    payload = bytes(value ^ mask[index % 4] for index, value in enumerate(raw))
    if opcode == 0x8:
        return None
    if opcode == 0x9:
        client.writer.write(b"\x8a" + bytes((len(payload),)) + payload)
        await client.writer.drain()
        return ""
    if opcode != 0x1 or not (first & 0x80):
        raise ProtocolError("unsupported frame")
    return payload.decode("utf-8")


async def websocket_loop(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, headers: dict[str, str]) -> None:
    if len(CLIENTS) >= MAX_CONNECTIONS:
        writer.write(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n")
        await writer.drain()
        return
    key = headers.get("sec-websocket-key", "")
    if not key:
        raise ProtocolError("missing websocket key")
    accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
    writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").encode())
    await writer.drain()
    peer = writer.get_extra_info("peername")
    client = Client(reader, writer, str(peer[0] if peer else "unknown"))
    CLIENTS.add(client)
    await client.send({"type": "hello", "config": {"world": WORLD, "birds": BIRDS, "items": ITEMS, "limits": {"rooms": MAX_ROOMS, "message": MAX_MESSAGE}}})
    try:
        while not client.closed:
            raw = await read_frame(client)
            if raw is None:
                break
            if not raw:
                continue
            try:
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise ValueError
                await handle_message(client, data)
            except (ValueError, TypeError, KeyError):
                await client.error("消息格式无效")
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, ProtocolError) as exc:
        LOG.info("client %s disconnected: %s", client.peer, exc)
    finally:
        client.closed = True
        CLIENTS.discard(client)
        await detach_client(client)
        writer.close()
        try:
            await writer.wait_closed()
        except ConnectionError:
            pass


SECURITY_HEADERS = (
    "X-Content-Type-Options: nosniff\r\n"
    "X-Frame-Options: DENY\r\n"
    "Referrer-Policy: no-referrer\r\n"
    "Permissions-Policy: camera=(), microphone=(), geolocation=()\r\n"
    "Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:\r\n"
)


async def serve_http(writer: asyncio.StreamWriter, target: str) -> None:
    path = unquote(urlsplit(target).path)
    if path == "/healthz":
        body = json.dumps({"status": "ok", "uptime": int(time.monotonic() - STARTED_AT), "rooms": len(ROOMS), "connections": len(CLIENTS)}).encode()
        header = f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nCache-Control: no-store\r\n{SECURITY_HEADERS}Connection: close\r\n\r\n"
        writer.write(header.encode() + body)
        await writer.drain()
        return
    if path == "/":
        path = "/index.html"
    candidate = (PUBLIC / path.lstrip("/")).resolve()
    try:
        candidate.relative_to(PUBLIC.resolve())
    except ValueError:
        candidate = PUBLIC / "__missing__"
    if not candidate.is_file():
        body = b"Not found"
        writer.write(f"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {len(body)}\r\n{SECURITY_HEADERS}Connection: close\r\n\r\n".encode() + body)
        await writer.drain()
        return
    body = candidate.read_bytes()
    content_type = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
    cache = "public, max-age=86400" if "/assets/" in str(candidate) else "no-cache"
    writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {len(body)}\r\nCache-Control: {cache}\r\n{SECURITY_HEADERS}Connection: close\r\n\r\n".encode() + body)
    await writer.drain()


async def handle_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
        if len(raw) > 8192:
            raise ProtocolError("headers too large")
        lines = raw.decode("latin-1").split("\r\n")
        method, target, _ = lines[0].split(" ", 2)
        headers = {line.split(":", 1)[0].strip().lower(): line.split(":", 1)[1].strip() for line in lines[1:] if ":" in line}
        if method != "GET":
            writer.write(b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n")
            await writer.drain()
        elif urlsplit(target).path == "/ws" and headers.get("upgrade", "").lower() == "websocket":
            await websocket_loop(reader, writer, headers)
            return
        else:
            await serve_http(writer, target)
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, UnicodeError, ValueError, ProtocolError):
        try:
            writer.write(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            await writer.drain()
        except ConnectionError:
            pass
    finally:
        if not writer.is_closing():
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionError:
                pass


async def cleanup_loop() -> None:
    while True:
        await asyncio.sleep(30)
        now = time.monotonic()
        expired = []
        for code, room in list(ROOMS.items()):
            if room.phase == "battle" and room.active_bird and now - room.shot_started > 25:
                room.active_bird = None
                if not room.bird_queue:
                    await room.finish_round("pig", "发射超时且小鸟已用尽")
                else:
                    await room.notify_state()
            connected = any(client and not client.closed for client in room.players.values())
            if not connected and now - room.touched > ROOM_TTL:
                expired.append(code)
        for code in expired:
            ROOMS.pop(code, None)
        if expired:
            LOG.info("expired %d rooms", len(expired))


async def main_async(host: str, port: int) -> None:
    server = await asyncio.start_server(handle_connection, host, port, limit=MAX_MESSAGE + 8192, backlog=128)
    loop = asyncio.get_running_loop()
    stop = loop.create_future()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: not stop.done() and stop.set_result(None))
    cleanup = asyncio.create_task(cleanup_loop())
    LOG.info("listening on %s:%d", host, port)
    async with server:
        await stop
    cleanup.cancel()
    await asyncio.gather(cleanup, return_exceptions=True)
    for client in tuple(CLIENTS):
        client.writer.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("FLOCK_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("FLOCK_PORT", "18080")))
    args = parser.parse_args()
    logging.basicConfig(level=os.environ.get("FLOCK_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main_async(args.host, args.port))


if __name__ == "__main__":
    main()
