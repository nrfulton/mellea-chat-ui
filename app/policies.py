"""Client for the policy control plane of an `m mitm --admin` proxy.

The proxy screens the replies it relays against `granite.trust.policy-tools` policies and
holds them in a registry it re-reads for every reply, so a change is live immediately. This
module is the seam between that registry and this app: the UI never talks to the proxy
directly, which keeps the admin token server-side and avoids any cross-origin setup.

The wire contract is small on purpose -- six calls over `_MITM_POLICIES` -- and mirrors
`cli/mitm/admin.py` in mellea. A policy is carried as a plain mapping in the upstream
schema; nothing here interprets it, so a policy this app cannot render is still a policy it
can round-trip.

Every failure arrives as `PolicyServiceError` carrying an HTTP status, whether it came from
the proxy refusing a document or from the proxy not being there at all, so callers have one
thing to catch and one status to relay.
"""

from __future__ import annotations

from typing import Any

import httpx

from .config import Settings

# Path the proxy mounts its control plane on. Kept as a constant rather than imported from
# `cli.mitm.admin`: this is an HTTP client, and the path is the contract.
_MITM_POLICIES = "/_mitm/policies"


class PolicyServiceError(RuntimeError):
    """A policy operation did not succeed.

    Carries the status to answer the browser with, so a proxy that is unreachable, one
    that rejected a malformed policy, and one that has no such policy stay distinguishable
    all the way to the UI.
    """

    def __init__(self, message: str, status: int = 502) -> None:
        """Record the message and the status it should be reported as."""
        super().__init__(message)
        self.status = status


def _detail(response: httpx.Response) -> str:
    """Pull the human-readable reason out of an error response.

    The proxy reports failures as FastAPI does, in a `detail` field. Anything else --
    an HTML error page from something in between, say -- falls back to the status line, so
    a surprise still reaches the user as words rather than as a blank message.
    """
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        detail = body.get("detail")
        if isinstance(detail, str) and detail.strip():
            return detail
        if detail is not None:
            return str(detail)
    return f"{response.status_code} {response.reason_phrase}".strip()


class PolicyClient:
    """Reads and writes the policies one proxy is enforcing.

    A client is created per request rather than held open. These calls happen when a person
    clicks something, not on every token, so the cost is irrelevant next to not having a
    connection pool whose lifetime has to be managed against the app's.
    """

    def __init__(self, settings: Settings) -> None:
        """Read the proxy location and credentials from settings."""
        self._base = settings.mitm_base_url.rstrip("/")
        self._token = settings.mitm_token
        self._timeout = settings.mitm_timeout

    @property
    def configured(self) -> bool:
        """Whether a proxy has been pointed at, i.e. whether the feature is on."""
        return bool(self._base)

    async def _request(
        self, method: str, path: str = "", payload: dict[str, Any] | None = None
    ) -> Any:
        """Make one control-plane call.

        Args:
            method: HTTP method.
            path: Path appended to `_MITM_POLICIES`, e.g. `/alcohol_prohibited`.
            payload: JSON body, or `None` to send none.

        Returns:
            The decoded JSON body, or `None` for a `204`.

        Raises:
            PolicyServiceError: If no proxy is configured, it cannot be reached, it
                answered with an error, or it answered with something that is not JSON.
        """
        if not self.configured:
            raise PolicyServiceError(
                "No policy proxy is configured. Set MITM_BASE_URL to the address of an "
                "`m mitm --admin` proxy.",
                503,
            )

        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        url = f"{self._base}{_MITM_POLICIES}{path}"
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.request(
                    method, url, json=payload, headers=headers
                )
        except httpx.HTTPError as exc:
            raise PolicyServiceError(
                f"Could not reach the policy proxy at {self._base}: {exc}", 503
            ) from exc

        if response.status_code >= 400:
            raise PolicyServiceError(_detail(response), response.status_code)
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise PolicyServiceError(
                "The policy proxy answered with something that is not JSON. Is "
                f"{self._base} really an `m mitm --admin` proxy?", 502
            ) from exc

    async def list(self) -> list[dict[str, Any]]:
        """Return every registered policy, enforced or parked.

        Returns:
            One `{"policy": ..., "enabled": ...}` entry per policy, in the order the proxy
            screens them.
        """
        body = await self._request("GET", "")
        policies = (body or {}).get("policies")
        return policies if isinstance(policies, list) else []

    async def get(self, key: str) -> dict[str, Any]:
        """Read one policy, addressed by risk group name or id."""
        return await self._request("GET", f"/{key}")

    async def create(
        self, policy: dict[str, Any], *, enabled: bool | None = None
    ) -> dict[str, Any]:
        """Register a new policy, failing if its risk group is already taken."""
        return await self._request(
            "POST", "", {"policy": policy, "enabled": enabled}
        )

    async def replace(
        self, key: str, policy: dict[str, Any], *, enabled: bool | None = None
    ) -> dict[str, Any]:
        """Overwrite an existing policy, optionally renaming its risk group.

        Passing `enabled=None` leaves the policy as enforced or parked as it already was,
        so saving an edit to a parked guard does not arm it.
        """
        return await self._request(
            "PUT", f"/{key}", {"policy": policy, "enabled": enabled}
        )

    async def set_enabled(self, key: str, enabled: bool) -> dict[str, Any]:
        """Start or stop enforcing a policy without deleting it."""
        return await self._request("PATCH", f"/{key}", {"enabled": enabled})

    async def delete(self, key: str) -> None:
        """Remove a policy from the proxy entirely."""
        await self._request("DELETE", f"/{key}")

    async def count(self) -> int:
        """Count the registered policies, for the health probe.

        Returns:
            The number of policies, or `-1` if the proxy could not be asked -- the caller
            reports availability separately, and an exception here would fail a health
            check that is mostly about inference.
        """
        try:
            return len(await self.list())
        except PolicyServiceError:
            return -1
