import math

import pytest

from llrp_client import AntennaConfig, ReaderConfig, build_sllurp_config, parse_tag


def test_parse_impinj_fields():
    r = parse_tag({
        "EPC-96": b"E28011700000020A", "AntennaID": 2, "PeakRSSI": -55, "ChannelIndex": 3,
        "ImpinjPeakRSSI": -5512, "ImpinjRFPhaseAngle": 1024, "ImpinjRFDopplerFrequency": -32,
        "FirstSeenTimestampUTC": 1_700_000_000_000_000, "TagSeenCount": 1,
    })
    assert r["epc"] == "E28011700000020A"
    assert r["port"] == 2 and r["channel"] == 3
    assert r["rssi"] == -55.12  # high-res RSSI wins over the 1 dB PeakRSSI
    assert r["phase"] == pytest.approx(math.pi / 2, abs=1e-4)
    assert r["doppler"] == -2.0


def test_parse_standard_only_and_filter():
    r = parse_tag({"EPC": b"\x01\x02", "AntennaID": [1], "PeakRSSI": -60, "LastSeenTimestampUTC": 5})
    assert r["epc"] == "0102" and r["phase"] is None and r["ts"] == 5 and r["port"] == 1
    assert parse_tag({"EPC": b"AB", "PeakRSSI": -90}, rx_sens_dbm=-80) is None


def test_sllurp_accepts_config():
    llrp = pytest.importorskip("sllurp.llrp")
    cfg = ReaderConfig(antennas=[AntennaConfig(1, 30), AntennaConfig(2, 30), AntennaConfig(3, 27)], channels=[1, 2, 3, 4])
    c = llrp.LLRPReaderConfig(build_sllurp_config(cfg))
    assert c.impinj_tag_content_selector["EnableRFPhaseAngle"]
    assert c.impinj_search_mode == 2 and c.session == 0
    assert c.tx_power_dbm == {1: 30.0, 2: 30.0, 3: 27.0}
    assert c.frequencies["ChannelList"] == [1, 2, 3, 4]


def test_rospec_encodes_impinj_extensions():
    proto = pytest.importorskip("sllurp.llrp_proto")
    llrp = pytest.importorskip("sllurp.llrp")
    c = llrp.LLRPReaderConfig(build_sllurp_config(ReaderConfig(antennas=[AntennaConfig(p, 30) for p in (1, 2, 3)],
                                                               channels=[1, 2, 3, 4])))
    rospec = proto.LLRPROSpec(
        {"ModeIdentifier": 1000, "MaxTari": 0}, 1, antennas=c.antennas, tx_power={1: 81, 2: 81, 3: 81},
        report_every_n_tags=1, tag_content_selector=c.tag_content_selector, session=c.session,
        frequencies=c.frequencies, impinj_search_mode=c.impinj_search_mode,
        impinj_tag_content_selector=c.impinj_tag_content_selector)
    msg = llrp.LLRPMessage(msgdict={"ADD_ROSPEC": {"Ver": 1, "Type": 20, "ID": 1, "ROSpecID": 1, "ROSpec": rospec}})
    assert len(msg.msgbytes) > 100
    inv = rospec["AISpec"][0]["InventoryParameterSpec"][0]["AntennaConfiguration"][0]["C1G2InventoryCommand"][0]
    assert inv["ImpinjFixedFrequencyList"]["ChannelList"] == [1, 2, 3, 4]
    assert inv["ImpinjInventorySearchMode"]["InventorySearchMode"] == 2


def test_mock_walk_playback():
    from llrp_client import MockReader, MockWalk

    statuses = []
    m = MockReader(lambda r: None, statuses.append, seed=3)
    m.set_antennas({1: (0.0, 1.0, -4.0)})
    walk = MockWalk(epc="WALK0001", start=(-4.0, 0.4, 0.0), end=(4.0, 0.4, 0.0), speed=0.4, stand_s=3.0, jitter=0.0)
    m.walk, m._walk_t0_us = walk, 0  # drive the clock by hand instead of start_walk()'s thread
    reads = []
    for _ in range(20000):
        reads += m.tick(0)
        if walk.done:
            break
    assert walk.done and any("done" in s["message"] for s in statuses)
    assert {r["epc"] for r in reads} == {"WALK0001"}  # only the walked tag is in the field
    assert all("walk" in r for r in reads)
    assert abs(walk.t - (3 + 8 / 0.4 + 3)) < 0.1
    # timestamps follow the simulated clock, monotonic
    ts = [r["ts"] for r in reads]
    assert ts == sorted(ts) and abs(ts[-1] / 1e6 - walk.t) < 0.1
    # port 1: unwrapped 2θ tracks the true range change (sign -1)
    p1 = [r for r in reads if r["port"] == 1]
    assert len(p1) > 200
    lam = 299.792458 / 865.7
    acc, prev, errs = 0.0, None, []
    d0 = None
    for r in p1:
        ph = 2 * r["phase"]
        if prev is not None:
            acc += (ph - prev + math.pi) % (2 * math.pi) - math.pi
        prev = ph
        t = r["ts"] / 1e6
        x = -4 + min(8.0, max(0.0, (t - 3) * 0.4))
        d = math.dist((0.0, 1.0, -4.0), (x, 0.4, 0.0))
        d0 = d if d0 is None else d0
        rho = acc * lam / (8 * math.pi)
        errs.append(rho + (d - d0))
    mean = sum(errs) / len(errs)
    assert max(abs(e - mean) for e in errs) < 0.03
