"""Deterministic value noise / fBm on numpy grids.

This is the "Minecraft terrain" half of the concentration model: cheap, smooth,
seedable, reproducible.  No global RNG state is touched -- every call is a pure
function of (coordinates, frequency, seed), so fields can be evaluated for an
arbitrary hour without generating the hours before it.
"""

from __future__ import annotations

import numpy as np

_U64 = np.uint64
_M1 = _U64(0x9E3779B97F4A7C15)
_M2 = _U64(0xBF58476D1CE4E5B9)
_M3 = _U64(0x94D049BB133111EB)


def _hash3(ix: np.ndarray, iy: np.ndarray, iz: np.ndarray, seed: int) -> np.ndarray:
    """splitmix64-flavoured hash of an integer lattice point -> float in [0,1)."""
    h = (
        ix.astype(np.int64).astype(_U64) * _U64(0xA0761D6478BD642F)
        ^ iy.astype(np.int64).astype(_U64) * _U64(0xE7037ED1A0B428DB)
        ^ iz.astype(np.int64).astype(_U64) * _U64(0x8EBC6AF09C88C6E3)
        ^ _U64(np.uint64(seed & 0xFFFFFFFFFFFFFFFF))
    )
    h = (h ^ (h >> _U64(30))) * _M2
    h = (h ^ (h >> _U64(27))) * _M3
    h = h ^ (h >> _U64(31))
    return (h >> _U64(11)).astype(np.float64) / float(1 << 53)


def _smooth(t: np.ndarray) -> np.ndarray:
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)


def value_noise_3d(x: np.ndarray, y: np.ndarray, z: np.ndarray, seed: int) -> np.ndarray:
    """Trilinearly interpolated value noise in [0,1).  x/y/z in lattice units."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    z = np.asarray(z, dtype=np.float64)
    x0 = np.floor(x)
    y0 = np.floor(y)
    z0 = np.floor(z)
    fx = _smooth(x - x0)
    fy = _smooth(y - y0)
    fz = _smooth(z - z0)
    ix = x0.astype(np.int64)
    iy = y0.astype(np.int64)
    iz = z0.astype(np.int64)
    one = np.int64(1)

    def h(dx, dy, dz):
        return _hash3(ix + np.int64(dx), iy + np.int64(dy), iz + np.int64(dz), seed)

    c000, c100 = h(0, 0, 0), h(1, 0, 0)
    c010, c110 = h(0, 1, 0), h(1, 1, 0)
    c001, c101 = h(0, 0, 1), h(1, 0, 1)
    c011, c111 = h(0, 1, 1), h(1, 1, 1)
    del one
    x00 = c000 + (c100 - c000) * fx
    x10 = c010 + (c110 - c010) * fx
    x01 = c001 + (c101 - c001) * fx
    x11 = c011 + (c111 - c011) * fx
    y0_ = x00 + (x10 - x00) * fy
    y1_ = x01 + (x11 - x01) * fy
    return y0_ + (y1_ - y0_) * fz


def fbm3(
    x: np.ndarray,
    y: np.ndarray,
    z: np.ndarray,
    seed: int,
    *,
    octaves: int = 4,
    lacunarity: float = 2.0,
    gain: float = 0.5,
) -> np.ndarray:
    """Fractal Brownian motion, normalised to roughly [0,1]."""
    total = np.zeros(np.broadcast(x, y, z).shape, dtype=np.float64)
    amp = 1.0
    norm = 0.0
    f = 1.0
    for o in range(octaves):
        total = total + amp * value_noise_3d(x * f, y * f, z * f, seed + 7919 * o)
        norm += amp
        amp *= gain
        f *= lacunarity
    return total / norm


def ridged3(x, y, z, seed, *, octaves: int = 3) -> np.ndarray:
    """Ridged multifractal in [0,1] -- used for filament-like haze structure."""
    total = np.zeros(np.broadcast(x, y, z).shape, dtype=np.float64)
    amp = 1.0
    norm = 0.0
    f = 1.0
    for o in range(octaves):
        n = value_noise_3d(x * f, y * f, z * f, seed + 4241 * o)
        total = total + amp * (1.0 - np.abs(2.0 * n - 1.0))
        norm += amp
        amp *= 0.5
        f *= 2.0
    return total / norm


def scalar_fbm(t: float, seed: int, *, octaves: int = 4) -> float:
    """1-D fBm on a scalar (used for day-scale weather drift)."""
    return float(fbm3(np.array([t]), np.array([0.0]), np.array([0.0]), seed, octaves=octaves)[0])


def scalar_series(ts: np.ndarray, seed: int, *, octaves: int = 4) -> np.ndarray:
    z = np.zeros_like(np.asarray(ts, dtype=np.float64))
    return fbm3(np.asarray(ts, dtype=np.float64), z, z, seed, octaves=octaves)


# ---------------------------------------------------------------- blur


def box_blur(a: np.ndarray, r: int, passes: int = 2) -> np.ndarray:
    """Separable box blur repeated `passes` times ~= Gaussian with sigma ~ r*sqrt(passes/3)."""
    if r <= 0:
        return a
    out = a.astype(np.float64, copy=True)
    k = 2 * r + 1
    for _ in range(passes):
        for axis in (0, 1):
            pad = [(0, 0), (0, 0)]
            pad[axis] = (r, r)
            p = np.pad(out, pad, mode="edge")
            c = np.cumsum(p, axis=axis)
            zero_shape = list(c.shape)
            zero_shape[axis] = 1
            c = np.concatenate([np.zeros(zero_shape), c], axis=axis)
            hi = [slice(None), slice(None)]
            lo = [slice(None), slice(None)]
            n = out.shape[axis]
            hi[axis] = slice(k, k + n)
            lo[axis] = slice(0, n)
            out = (c[tuple(hi)] - c[tuple(lo)]) / k
    return out


def bilinear_sample(grid: np.ndarray, gx: np.ndarray, gy: np.ndarray) -> np.ndarray:
    """Sample a 2-D grid (indexed [row=y, col=x]) at fractional cell coordinates."""
    h, w = grid.shape
    gx = np.clip(np.asarray(gx, dtype=np.float64), 0, w - 1.000001)
    gy = np.clip(np.asarray(gy, dtype=np.float64), 0, h - 1.000001)
    x0 = np.floor(gx).astype(np.int64)
    y0 = np.floor(gy).astype(np.int64)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    tx = gx - x0
    ty = gy - y0
    a = grid[y0, x0]
    b = grid[y0, x1]
    c = grid[y1, x0]
    d = grid[y1, x1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
