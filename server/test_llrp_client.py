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
