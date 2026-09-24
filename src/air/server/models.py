"""Pydantic request bodies. Responses are dicts shaped by `shapes.py` so they
track web/src/core/types.ts literally — a response model layer would only add a
second place to drift."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Role = Literal["community", "regulator", "industry", "admin"]
Severity = Literal["info", "watch", "warning", "critical"]


class ConcernIn(BaseModel):
    kind: Literal["smell", "noise", "smoke", "dust", "health", "light", "traffic", "vibration", "other"]
    severity: int = Field(3, ge=1, le=5)
    title: str
    body: str | None = None
    lon: float
    lat: float
    occurred_at: str | None = None
    is_anonymous: bool = False
    author_id: str | None = None
    address_hint: str | None = None
    district: str | None = None
    photo_emoji: str | None = None
    suspected_site_id: str | None = None
    campaign_id: str | None = None


class CorroborateIn(BaseModel):
    user_id: str | None = None
    campaign_id: str | None = None


class ConcernResponseIn(BaseModel):
    role: Role
    kind: Literal["acknowledge", "mitigation", "finding", "advisory", "comment"]
    body: str
    author_id: str | None = None
    org_id: str | None = None


class ConcernPatch(BaseModel):
    status: Literal["new", "corroborated", "under_review", "mitigation_proposed", "resolved", "closed"]
    role: Role | None = None
    actor_id: str | None = None


class PostIn(BaseModel):
    site_id: str
    kind: Literal["update", "mitigation", "event", "response", "intro"] = "update"
    title: str
    body: str
    concern_id: str | None = None
    media_emoji: str | None = None
    pinned: bool = False
    author_id: str | None = None
    campaign_id: str | None = None


class MitigationIn(BaseModel):
    site_id: str
    title: str
    body: str | None = None
    concern_id: str | None = None
    cluster_id: str | None = None
    alert_id: str | None = None
    measure: str | None = None
    expected_reduction_pct: float | None = None
    status: Literal["proposed", "in_progress", "completed", "withdrawn"] = "proposed"
    author_id: str | None = None
    campaign_id: str | None = None


class AdvisoryIn(BaseModel):
    kind: Literal["advisory", "warning", "notice", "all_clear", "update"] = "advisory"
    severity: Severity = "info"
    title: str
    body: str
    measure: str | None = None
    alert_id: str | None = None
    audience: list[Role] = Field(default_factory=lambda: ["community"])
    org_id: str | None = None
    author_id: str | None = None
    expires_at: str | None = None
    pinned: bool = False
    campaign_id: str | None = None


class AckIn(BaseModel):
    note: str | None = None
    user_id: str | None = None


class ActionLevelIn(BaseModel):
    """Full row for PUT; `id` is taken from the path."""
    measure: str
    label: str
    kind: Literal["spike", "integrated"] = "spike"
    threshold: float
    unit: str | None = None
    averaging_hours: float = 1.0
    severity: Severity = "watch"
    enabled: bool = True
    source: str | None = None
    notify_community: bool = True
    notify_industry: bool = True
    campaign_id: str | None = None
    id: str | None = None


class AdvisorIn(BaseModel):
    alert_id: str | None = None
    question: str | None = None
    site_id: str | None = None
    campaign_id: str | None = None
    # The moment shown (naive campaign time, like every `at`). Whether the
    # alert is still ongoing, the readings and the reports the advice may cite,
    # and "the wind now" are judged at it. Absent is the end of the data.
    at: str | None = None


class DrivePlanIn(BaseModel):
    fleet_size: int = Field(5, ge=1, le=40)
    target_passes: int = Field(25, ge=1, le=200)
    shift_hours: float = Field(6.0, gt=0, le=24)
    seed: int = 42
    name: str | None = None


class ReseedIn(BaseModel):
    seed: int | None = None


class SimulateIn(BaseModel):
    scenario: Literal[
        "generator_test", "concern_wave", "wind_shift", "methane_leak", "all_clear",
        "model_divergence",
    ]
    campaign_id: str | None = None
    site_id: str | None = None
