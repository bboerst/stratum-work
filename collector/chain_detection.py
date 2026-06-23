from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, Optional

import requests


def reverse_prev_hash(prev_hash: str) -> str:
    return bytes.fromhex(prev_hash)[::-1].hex()


@dataclass
class TipState:
    current_height: Optional[int]
    last_update_monotonic: Optional[float]
    stale_after_seconds: int

    def is_usable(self, now: float) -> bool:
        if self.current_height is None or self.last_update_monotonic is None:
            return False
        return (now - self.last_update_monotonic) <= self.stale_after_seconds


class BCHConfirmationCache:
    def __init__(self) -> None:
        self._prev_hash: Optional[str] = None
        self._is_bch: Optional[bool] = None

    def lookup(self, prev_hash: str) -> Optional[bool]:
        if prev_hash != self._prev_hash:
            return None
        return self._is_bch

    def store(self, prev_hash: str, is_bch: bool) -> None:
        self._prev_hash = prev_hash
        self._is_bch = is_bch


class BCHConfirmer:
    def __init__(self, api_base_url: str, timeout_seconds: float, cache: BCHConfirmationCache) -> None:
        self.api_base_url = api_base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.cache = cache

    def confirm_bch(self, prev_hash: str) -> bool:
        cached = self.cache.lookup(prev_hash)
        if cached is not None:
            return cached

        try:
            response = requests.get(
                f"{self.api_base_url}/{reverse_prev_hash(prev_hash)}",
                timeout=self.timeout_seconds,
            )
        except requests.RequestException:
            return False

        is_bch = self._response_indicates_bch(response)
        if is_bch:
            self.cache.store(prev_hash, True)
        return is_bch

    @staticmethod
    def _response_indicates_bch(response: requests.Response) -> bool:
        if not response.ok:
            return False

        try:
            payload = response.json()
        except ValueError:
            return False

        if not isinstance(payload, dict):
            return False

        return bool(payload.get("data"))


class ChainClassifier:
    def __init__(
        self,
        tip_state: TipState,
        divergence_threshold: int,
        confirmer: BCHConfirmer,
        monotonic_now: Callable[[], float] = time.monotonic,
    ) -> None:
        self.tip_state = tip_state
        self.divergence_threshold = divergence_threshold
        self.confirmer = confirmer
        self.monotonic_now = monotonic_now

    def classify(self, height: int, prev_hash: str) -> Optional[str]:
        now = self.monotonic_now()
        if not self.tip_state.is_usable(now):
            return None
        if abs(height - self.tip_state.current_height) <= self.divergence_threshold:
            return None
        if self.confirmer.confirm_bch(prev_hash):
            return "bch"
        return "unknown"
