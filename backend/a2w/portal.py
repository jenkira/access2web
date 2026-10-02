"""Portal adapter: the boundary between Access2Web and the systems portal.

The portal product is not chosen yet (open item O1), so the adapter is an interface.
"""
import os
from dataclasses import dataclass
from typing import Protocol

from .authz import Identity


@dataclass(frozen=True)
class Tile:
    slug: str
    name: str
    description: str
    icon: str
    owner: str
    launch: str


class PortalAdapter(Protocol):
    def identity(self, headers: dict[str, str]) -> Identity | None: ...
    def register(self, tile: Tile) -> None: ...
    def unregister(self, slug: str) -> None: ...


class DevHeaderPortal:
    """Reads identity from request headers. For development and tests only.

    Never enable this behind an ingress that lets clients set these headers.
    It turns on only when A2W_DEV_AUTH=1.
    """

    def __init__(self) -> None:
        self.tiles: dict[str, Tile] = {}

    def identity(self, headers: dict[str, str]) -> Identity | None:
        if os.environ.get("A2W_DEV_AUTH") != "1":
            return None
        user = headers.get("x-a2w-user", "").strip()
        if not user:
            return None
        split = lambda v: tuple(s.strip() for s in v.split(",") if s.strip())  # noqa: E731
        return Identity(user, split(headers.get("x-a2w-groups", "")), split(headers.get("x-a2w-roles", "")))

    def register(self, tile: Tile) -> None:
        self.tiles[tile.slug] = tile

    def unregister(self, slug: str) -> None:
        self.tiles.pop(slug, None)
