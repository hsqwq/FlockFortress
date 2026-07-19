import asyncio
import importlib.util
import pathlib
import sys
import unittest
from types import SimpleNamespace

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("flock_app", ROOT / "server" / "app.py")
app = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = app
SPEC.loader.exec_module(app)


def make_item(kind, item_id, x, y):
    spec = app.ITEMS[kind]
    return {"id": item_id, "kind": kind, "x": x, "y": y, "w": spec["w"], "h": spec["h"],
            "hp": spec["hp"], "maxHp": spec["hp"], "material": spec["material"]}


class ConstructionTests(unittest.TestCase):
    def test_public_item_always_has_rotation(self):
        self.assertEqual(app.public_item(make_item("pig", "pig", 870, 569))["angle"], 0)

    def test_snap_clamps_odd_sized_pig_to_ground(self):
        self.assertEqual(app.snap(569, 101, 569), 569)

    def test_supported_fort_is_legal(self):
        items = [
            make_item("wood_post", "left", 820, 540),
            make_item("wood_post", "right", 920, 540),
            make_item("wood_beam", "roof", 870, 480),
            make_item("pig", "pig", 870, 569),
        ]
        self.assertIsNone(app.validate_construction(items, True))

    def test_floating_item_is_rejected_on_ready(self):
        items = [make_item("wood_beam", "beam", 850, 300), make_item("pig", "pig", 850, 559)]
        self.assertIn("悬空", app.validate_construction(items, True))

    def test_overlap_is_always_rejected(self):
        items = [make_item("wood_beam", "one", 850, 560), make_item("wood_beam", "two", 850, 560)]
        self.assertIn("重叠", app.validate_construction(items))

    def test_pig_count_and_bounds(self):
        four = [make_item("pig", str(index), 750 + index * 60, 569) for index in range(4)]
        self.assertIn("最多", app.validate_construction(four))
        self.assertIn("建造区", app.validate_construction([make_item("pig", "p", 690, 569)]))


class EconomyTests(unittest.IsolatedAsyncioTestCase):
    async def test_loss_bonus_grows_and_caps(self):
        room = app.Room("ABC123", object(), "bird")
        room.players = {"bird": None, "pig": None}
        room.phase = "battle"
        before = room.credits["pig"]
        await room.finish_round("bird", "test")
        self.assertEqual(room.scores["bird"], 1)
        self.assertEqual(room.credits["pig"], min(1200, before + 300))
        self.assertEqual(room.phase, "round_end")

    async def test_first_to_three_ends_match(self):
        room = app.Room("ABC123", object(), "bird")
        room.players = {"bird": None, "pig": None}
        room.scores["bird"] = 2
        room.phase = "battle"
        await room.finish_round("bird", "test")
        self.assertEqual(room.phase, "match_end")


class RoomLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_last_departure_removes_room_immediately(self):
        room = app.Room("EMPTY1", object(), "bird")
        client = SimpleNamespace(room=room, role="bird", closed=True)
        room.players = {"bird": client, "pig": None}
        app.ROOMS[room.code] = room
        await app.detach_client(client)
        self.assertNotIn(room.code, app.ROOMS)


if __name__ == "__main__":
    unittest.main()
