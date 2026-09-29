"""LLRP access to an Impinj reader (sllurp) with the Impinj extensions needed for localisation.

Based on crossmgr-antenna/server/llrp_client.py. Each read additionally carries the RF phase angle,
Doppler shift, channel index and high-resolution RSSI.

CrossMgrImpinj must be stopped while this is connected: the reader accepts only one LLRP client.

Impinj report fields as decoded by sllurp 3.x (tag report dict keys):
  ImpinjPeakRSSI            int16, 1/100 dBm
  ImpinjRFPhaseAngle        uint16, 0..4095 -> 0..2pi
  ImpinjRFDopplerFrequency  int16, 1/16 Hz
"""
from __future__ import annotations

import logging
import math
import random
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

log = logging.getLogger(__name__)

ReadCallback = Callable[[list[dict]], None]

# Impinj InventorySearchMode values
SEARCH_MODES = {"reader": 0, "single": 1, "dual": 2, "single-ab": 3}


@dataclass
class AntennaConfig:
    port: int
    tx_dbm: float
    enabled: bool = True


@dataclass
class ReaderConfig:
    antennas: list[AntennaConfig] = field(default_factory=list)
    rx_sens_dbm: float = -80.0
    search_mode: str = "dual"  # static reference tags must keep reporting: dual target, session 0
    session: int = 0
    mode_index: int = 1000  # AutoSet dense reader; keep it fixed for a whole measurement
    channels: list[int] = field(default_factory=lambda: [1])  # one entry = fixed channel; several = hop over them

    def to_dict(self) -> dict:
        return {
            "antennas": [{"port": a.port, "txDbm": a.tx_dbm, "enabled": a.enabled} for a in self.antennas],
            "rxSensDbm": self.rx_sens_dbm,
            "searchMode": self.search_mode,
            "session": self.session,
            "modeIndex": self.mode_index,
            "channels": self.channels,
        }

    @staticmethod
    def from_msg(msg: dict) -> "ReaderConfig":
        return ReaderConfig(
            antennas=[AntennaConfig(int(a["port"]), float(a["txDbm"]), bool(a.get("enabled", True)))
                      for a in msg.get("antennas", [])],
            rx_sens_dbm=float(msg.get("rxSensDbm", -80)),
            search_mode=str(msg.get("searchMode", "dual")),
            session=int(msg.get("session", 0)),
            mode_index=int(msg.get("modeIndex", 1000)),
            channels=[int(c) for c in msg.get("channels", [1])] or [1],
        )


def _scalar(v):
    """sllurp returns repeated custom parameters as lists; take the first value."""
    if isinstance(v, (list, tuple)):
        return v[0] if v else None
    return v


def parse_tag(t: dict, rx_sens_dbm: float = -200.0) -> Optional[dict]:
    """Converts one sllurp tag report dict into a read: {epc, port, rssi, phase, doppler, channel, ts, n}."""
    epc = t.get("EPC-96") or t.get("EPC") or t.get("EPCData") or b""
    if isinstance(epc, dict):
        epc = epc.get("EPC") or b""
    if isinstance(epc, (bytes, bytearray)):
        epc = epc.decode("ascii", "replace") if epc and all(32 <= c < 127 for c in epc) else epc.hex()
    hi = _scalar(t.get("ImpinjPeakRSSI"))
    rssi = hi / 100.0 if hi is not None else _scalar(t.get("PeakRSSI"))
    if rssi is None or rssi < rx_sens_dbm:
        return None
    ph = _scalar(t.get("ImpinjRFPhaseAngle"))
    dop = _scalar(t.get("ImpinjRFDopplerFrequency"))
    ts = _scalar(t.get("FirstSeenTimestampUTC")) or _scalar(t.get("LastSeenTimestampUTC")) or int(time.time() * 1e6)
    return {
        "epc": str(epc),
        "port": int(_scalar(t.get("AntennaID")) or 0),
        "rssi": round(float(rssi), 2),
        "phase": round(ph * 2 * math.pi / 4096, 5) if ph is not None else None,
        "doppler": round(dop / 16.0, 3) if dop is not None else None,
        "channel": _scalar(t.get("ChannelIndex")),
        "ts": int(ts),
        "n": int(_scalar(t.get("TagSeenCount")) or 1),
    }


def build_sllurp_config(cfg: ReaderConfig) -> dict:
    enabled = [a for a in cfg.antennas if a.enabled] or [AntennaConfig(1, 30.0)]
    return {
        "antennas": [a.port for a in enabled],
        "tx_power_dbm": {a.port: float(a.tx_dbm) for a in enabled},
        "report_every_n_tags": 1,
        "start_inventory": True,
        "session": cfg.session,
        "mode_identifier": cfg.mode_index,
        "impinj_search_mode": SEARCH_MODES.get(cfg.search_mode, 2),
        # sllurp 3.x reads "Channelist" in llrp.py but "ChannelList" when building the ROSpec: pass both.
        # One channel -> RFTransmitter.ChannelIndex (fixed); several -> ImpinjFixedFrequencyList.
        "frequencies": {"HopTableId": 1, "Channelist": cfg.channels, "ChannelList": cfg.channels, "Automatic": False},
        "tag_content_selector": {
            "EnableROSpecID": False,
            "EnableSpecIndex": False,
            "EnableInventoryParameterSpecID": False,
            "EnableAntennaID": True,
            "EnableChannelIndex": True,
            "EnablePeakRSSI": True,
            "EnableFirstSeenTimestamp": True,
            "EnableLastSeenTimestamp": True,
            "EnableTagSeenCount": True,
            "EnableAccessSpecID": False,
        },
        "impinj_tag_content_selector": {
            "EnableRFPhaseAngle": True,
            "EnablePeakRSSI": True,
            "EnableRFDopplerFrequency": True,
        },
    }


class LlrpReader:
    def __init__(self, on_reads: ReadCallback, on_status: Callable[[dict], None]):
        self.on_reads = on_reads
        self.on_status = on_status
        self.host: Optional[str] = None
        self.config = ReaderConfig()
        self._client = None
        self._port = 5084
        self._running = False
        self._power_table: list[float] = []

    def status(self, message: str = "") -> dict:
        return {
            "type": "status",
            "mode": "llrp",
            "connected": self._client is not None,
            "running": self._running,
            "host": self.host,
            "powerTable": self._power_table,
            "config": self.config.to_dict(),
            "message": message,
        }

    def connect(self, host: str, port: int = 5084) -> None:
        self.host = host
        self._port = port
        # The LLRP session is created on start(), because sllurp starts inventory on connect.
        self._client = object()
        self.on_status(self.status("Ready. Push reader config and press Start."))

    def configure(self, cfg: ReaderConfig) -> None:
        self.config = cfg
        restart = self._running
        if restart:
            self.stop()
            self.start()
        self.on_status(self.status("Reader config stored" + (" and applied" if restart else "")))

    def start(self) -> None:
        if not self.host:
            raise RuntimeError("not connected")
        try:
            from sllurp.llrp import LLRPReaderClient, LLRPReaderConfig  # type: ignore
        except ImportError as e:  # pragma: no cover
            raise RuntimeError("sllurp is not installed (pip install sllurp)") from e
        client = LLRPReaderClient(self.host, self._port, LLRPReaderConfig(build_sllurp_config(self.config)))
        client.add_tag_report_callback(self._on_tag_report)
        client.connect()
        self._client = client
        self._running = True
        self._power_table = [p for p in (getattr(client.llrp, "tx_power_table", None) or []) if p]
        self.on_status(self.status("Inventory running"))

    def stop(self) -> None:
        client = self._client
        self._running = False
        if client is not None and hasattr(client, "disconnect"):
            try:
                client.disconnect()
                if hasattr(client, "join"):
                    client.join(5)
            except Exception:  # pragma: no cover
                log.exception("disconnect failed")
            self._client = object()
        self.on_status(self.status("Stopped"))

    def disconnect(self) -> None:
        if self._running:
            self.stop()
        self._client = None
        self.host = None
        self.on_status(self.status("Disconnected"))

    def _on_tag_report(self, _reader, tags: list[dict]) -> None:
        out = [r for r in (parse_tag(t, self.config.rx_sens_dbm) for t in tags) if r]
        if out:
            self.on_reads(out)


# -- mock ---------------------------------------------------------------------------------------

MOCK_ANTENNAS = {1: (0.3, 0.8, -4.5), 2: (0.3, 1.9, -4.5), 3: (0.3, 3.3, 0.0)}
MOCK_TAGS = [(x, y, z) for x in (-2.0, 0.0, 2.0) for z in (-3.0, 0.0, 3.0) for y in (0.4, 1.2)]
ETSI_MHZ = {1: 865.7, 2: 866.3, 3: 866.9, 4: 867.5}


class MockReader:
    """Static reference tags seen by 3 antennas: log-distance RSSI plus round-trip phase, for UI work
    without hardware. The web app has a model-driven simulator for realistic numbers."""

    def __init__(self, on_reads: ReadCallback, on_status: Callable[[dict], None]):
        self.on_reads = on_reads
        self.on_status = on_status
        self.config = ReaderConfig(antennas=[AntennaConfig(p, 30) for p in MOCK_ANTENNAS])
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._offsets = {p: random.uniform(0, 2 * math.pi) for p in MOCK_ANTENNAS}

    def status(self, message: str = "") -> dict:
        return {"type": "status", "mode": "mock", "connected": True, "running": self._running,
                "host": "mock", "powerTable": [], "config": self.config.to_dict(), "message": message}

    def connect(self, host: str, port: int = 5084) -> None:
        self.on_status(self.status(f"Mock reader ready ({len(MOCK_TAGS)} static tags REF0001.., same grid as the default survey)"))

    def configure(self, cfg: ReaderConfig) -> None:
        self.config = cfg
        self.on_status(self.status("Mock config stored"))

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        self.on_status(self.status("Mock inventory running"))

    def stop(self) -> None:
        self._running = False
        self.on_status(self.status("Stopped"))

    def disconnect(self) -> None:
        self.stop()

    def _loop(self) -> None:
        ports = [a for a in self.config.antennas if a.enabled and a.port in MOCK_ANTENNAS] or [AntennaConfig(1, 30)]
        chans = self.config.channels or [1]
        k = 0
        while self._running:
            a = ports[k % len(ports)]
            ch = chans[(k // (len(ports) * 20)) % len(chans)]
            lam = 299.792458 / ETSI_MHZ.get(ch, 866.5)
            ax, ay, az = MOCK_ANTENNAS[a.port]
            batch = []
            for i, (x, y, z) in enumerate(MOCK_TAGS):
                d = math.dist((ax, ay, az), (x, y, z))
                rssi = a.tx_dbm - 62 - 40 * math.log10(max(d, 0.3)) + random.gauss(0, 1.5)
                if rssi < self.config.rx_sens_dbm or random.random() < 0.3:
                    continue
                phase = (4 * math.pi * d / lam + self._offsets[a.port] + random.gauss(0, 0.1)) % (2 * math.pi)
                batch.append({"epc": f"REF{i + 1:04d}", "port": a.port, "rssi": round(rssi, 2), "phase": round(phase, 5),
                              "doppler": round(random.gauss(0, 0.5), 3), "channel": ch,
                              "ts": int(time.time() * 1e6), "n": 1})
            if batch:
                self.on_reads(batch)
            k += 1
            time.sleep(0.025)
