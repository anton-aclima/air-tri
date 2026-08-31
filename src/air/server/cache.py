"""Tiny in-process LRU with global write invalidation.

Every write bumps `version`; cache keys embed it, so a write invalidates
everything without having to reason about dependencies. Values are the already
serialized JSON bytes for the flagship endpoints, so a warm hit is a memcpy.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any

_lock = threading.RLock()
_store: "OrderedDict[tuple, Any]" = OrderedDict()
_version = 0
MAX_ENTRIES = 192

stats = {"hits": 0, "misses": 0, "invalidations": 0}


def version() -> int:
    return _version


def invalidate() -> None:
    global _version
    with _lock:
        _version += 1
        _store.clear()
        stats["invalidations"] += 1


def get(key: tuple) -> Any | None:
    k = (_version, *key)
    with _lock:
        if k in _store:
            _store.move_to_end(k)
            stats["hits"] += 1
            return _store[k]
    stats["misses"] += 1
    return None


def put(key: tuple, value: Any) -> Any:
    k = (_version, *key)
    with _lock:
        _store[k] = value
        _store.move_to_end(k)
        while len(_store) > MAX_ENTRIES:
            _store.popitem(last=False)
    return value
